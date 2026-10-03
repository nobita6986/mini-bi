import "server-only";

import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { validateEmployeeCode } from "../contracts/direct-entry-v1.ts";
import {
  projectPaymentUpdateResult,
  type PaymentInput,
} from "./payment-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

type OperationResult<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind: "conflict" | "denied" | "invalid" | "not-found" | "too-large" | "unavailable";
    };

export type DraftCatalog = {
  effective_date: string;
  projects: Array<{ project_id: string; display_name: string }>;
  recruiters: Array<{
    recruiter_id: string;
    display_name: string;
    provider_type: "hrp" | "vendor";
    team_id: string;
    team_display_name: string;
  }>;
  banks: Array<{ bank_id: string; display_name: string }>;
};

export type OwnDraft = {
  submission_id: string;
  submission_version: number;
  entry_id: string;
  entry_version: number;
  employee_code: string;
  first_work_date: string;
  worker_display_name: string;
  project_id: string;
  project_display_name: string;
  recruiter_id: string;
  recruiter_display_name: string;
  provider_type: "hrp" | "vendor";
  team_id: string;
  team_display_name: string;
  labor_type: "TEMPORARY" | "PERMANENT";
  employment_status: "UNCONFIRMED" | "ON" | "OFF" | null;
  created_at: string;
  updated_at: string;
};

export type DirectEntryRepository = {
  createBatch(input: ActorRef & {
    rows: readonly Record<string, unknown>[];
    idempotency_key: string;
  }): Promise<OperationResult>;
  readEntry(input: ActorRef & { entry_id: string }): Promise<OperationResult>;
  loadInputCatalog(input: ActorRef & { effective_date: string }): Promise<OperationResult<DraftCatalog>>;
  listOwnDrafts(input: ActorRef): Promise<OperationResult<OwnDraft[]>>;
  updateDraftRow(input: ActorRef & {
    entry_id: string;
    expected_version: number;
    patch: Record<string, unknown>;
    idempotency_key: string;
  }): Promise<OperationResult<{ entry_id: string; version: number; submission_version: number }>>;
  updatePayment(input: ActorRef & {
    entry_id: string;
    expected_entry_version: number;
    expected_payment_version: number;
    payment: PaymentInput;
    reason: string;
    idempotency_key: string;
  }): Promise<OperationResult<{
    entry_id: string;
    entry_version: number;
    payment_version: number;
  }>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function isPositiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function projectDraftCatalog(value: unknown, expectedDate?: string): DraftCatalog | null {
  if (!isRecord(value) ||
      !hasExactKeys(value, ["effective_date", "projects", "recruiters", "banks"]) ||
      typeof value.effective_date !== "string" || !Array.isArray(value.projects) ||
      !Array.isArray(value.recruiters) || !Array.isArray(value.banks)) return null;
  const projects: DraftCatalog["projects"] = [];
  for (const project of value.projects) {
    if (!isRecord(project) || !hasExactKeys(project, ["project_id", "display_name"]) ||
        typeof project.project_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(project.project_id) ||
        typeof project.display_name !== "string") return null;
    projects.push({ project_id: project.project_id, display_name: project.display_name });
  }
  const recruiters: DraftCatalog["recruiters"] = [];
  for (const recruiter of value.recruiters) {
    if (!isRecord(recruiter) || !hasExactKeys(recruiter, [
      "recruiter_id", "display_name", "provider_type", "team_id", "team_display_name",
    ]) || typeof recruiter.recruiter_id !== "string" || !UUID.test(recruiter.recruiter_id) ||
        typeof recruiter.display_name !== "string" ||
        (recruiter.provider_type !== "hrp" && recruiter.provider_type !== "vendor") ||
        typeof recruiter.team_id !== "string" || !UUID.test(recruiter.team_id) ||
        typeof recruiter.team_display_name !== "string") return null;
    recruiters.push({
      recruiter_id: recruiter.recruiter_id,
      display_name: recruiter.display_name,
      provider_type: recruiter.provider_type,
      team_id: recruiter.team_id,
      team_display_name: recruiter.team_display_name,
    });
  }
  const banks: DraftCatalog["banks"] = [];
  for (const bank of value.banks) {
    if (!isRecord(bank) || !hasExactKeys(bank, ["bank_id", "display_name"]) ||
        typeof bank.bank_id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(bank.bank_id) ||
        typeof bank.display_name !== "string" ||
        bank.display_name.trim().length === 0 || bank.display_name.length > 256) return null;
    banks.push({ bank_id: bank.bank_id, display_name: bank.display_name });
  }
  if (!isRealCalendarDate(value.effective_date) ||
      (expectedDate !== undefined && value.effective_date !== expectedDate) ||
      new Set(projects.map(({ project_id }) => project_id)).size !== projects.length ||
      new Set(recruiters.map(({ recruiter_id }) => recruiter_id)).size !== recruiters.length ||
      new Set(banks.map(({ bank_id }) => bank_id)).size !== banks.length) return null;
  return {
    effective_date: value.effective_date,
    projects,
    recruiters,
    banks,
  };
}

export function projectOwnDrafts(value: unknown): OwnDraft[] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["drafts"]) || !Array.isArray(value.drafts) ||
      value.drafts.length > 500) return null;
  const drafts: OwnDraft[] = [];
  const entryIds = new Set<string>();
  for (const draft of value.drafts) {
    if (!isRecord(draft) || !hasExactKeys(draft, [
      "submission_id", "submission_version", "entry_id", "entry_version", "employee_code",
      "first_work_date", "worker_display_name", "project_id", "project_display_name",
      "recruiter_id", "recruiter_display_name", "provider_type", "team_id", "team_display_name",
      "labor_type", "employment_status", "created_at", "updated_at",
    ]) || typeof draft.submission_id !== "string" || !UUID.test(draft.submission_id) ||
        !isPositiveVersion(draft.submission_version) ||
        typeof draft.entry_id !== "string" || !UUID.test(draft.entry_id) ||
        !isPositiveVersion(draft.entry_version) ||
        typeof draft.employee_code !== "string" || typeof draft.first_work_date !== "string" ||
        typeof draft.worker_display_name !== "string" ||
        typeof draft.project_id !== "string" || typeof draft.project_display_name !== "string" ||
        typeof draft.recruiter_id !== "string" || !UUID.test(draft.recruiter_id) ||
        typeof draft.recruiter_display_name !== "string" ||
        (draft.provider_type !== "hrp" && draft.provider_type !== "vendor") ||
        typeof draft.team_id !== "string" || !UUID.test(draft.team_id) ||
        typeof draft.team_display_name !== "string" ||
        (draft.labor_type !== "TEMPORARY" && draft.labor_type !== "PERMANENT") ||
        (draft.employment_status !== null && draft.employment_status !== "UNCONFIRMED" &&
          draft.employment_status !== "ON" && draft.employment_status !== "OFF") ||
        !isRealCalendarDate(draft.first_work_date) ||
        validateEmployeeCode(draft.employee_code, draft.first_work_date).length > 0 ||
        typeof draft.created_at !== "string" || !Number.isFinite(Date.parse(draft.created_at)) ||
        typeof draft.updated_at !== "string" || !Number.isFinite(Date.parse(draft.updated_at))) return null;
    if (entryIds.has(draft.entry_id)) return null;
    entryIds.add(draft.entry_id);
    drafts.push({
      submission_id: draft.submission_id,
      submission_version: draft.submission_version,
      entry_id: draft.entry_id,
      entry_version: draft.entry_version,
      employee_code: draft.employee_code,
      first_work_date: draft.first_work_date,
      worker_display_name: draft.worker_display_name,
      project_id: draft.project_id,
      project_display_name: draft.project_display_name,
      recruiter_id: draft.recruiter_id,
      recruiter_display_name: draft.recruiter_display_name,
      provider_type: draft.provider_type,
      team_id: draft.team_id,
      team_display_name: draft.team_display_name,
      labor_type: draft.labor_type,
      employment_status: draft.employment_status,
      created_at: draft.created_at,
      updated_at: draft.updated_at,
    });
  }
  return drafts;
}

export function projectDraftUpdate(value: unknown, entryId: string): {
  entry_id: string;
  version: number;
  submission_version: number;
} | null {
  if (!isRecord(value) || !hasExactKeys(value, ["entry_id", "version", "submission_version"]) ||
      value.entry_id !== entryId || !isPositiveVersion(value.version) ||
      !isPositiveVersion(value.submission_version)) return null;
  return {
    entry_id: value.entry_id,
    version: value.version,
    submission_version: value.submission_version,
  };
}

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

function classify(
  error: { code?: string; message?: string },
  operation: "create" | "read" | "catalog" | "list" | "update" | "payment",
) {
  if (operation === "create") {
    if (error.code === "23505") return "conflict";
    if (error.code === "42501") return "denied";
    if (error.code === "22023") {
      return error.message === "idempotency key reused with different input"
        ? "conflict"
        : "invalid";
    }
  } else if (operation === "read" || operation === "list" || operation === "catalog") {
    if (error.code === "P0002") return "not-found";
    if (error.code === "42501") return "denied";
    if (operation === "list" && error.code === "54000") return "too-large";
  } else {
    if (error.code === "40001" || error.code === "23505") return "conflict";
    if (error.code === "42501") return "denied";
    if (error.code === "P0002") return "not-found";
    if (operation === "payment" && error.code === "23514") return "invalid";
    if (error.code === "22023") {
      return error.message === "idempotency key reused with different input"
        ? "conflict"
        : "invalid";
    }
  }
  return "unavailable";
}

export function createDirectEntryWriteRepository(rpc?: Rpc): DirectEntryRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  return {
    async createBatch(input) {
      try {
        const { data, error } = await callRpc("direct_entry_create_batch", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_rows: input.rows,
          p_idempotency_key: input.idempotency_key,
        });
        return error ? { ok: false, kind: classify(error, "create") } : { ok: true, data };
      } catch {
        console.error("[direct-entry] create batch RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async readEntry(input) {
      try {
        const { data, error } = await callRpc("direct_entry_read_projection", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
        });
        return error ? { ok: false, kind: classify(error, "read") } : { ok: true, data };
      } catch {
        console.error("[direct-entry] read projection RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async loadInputCatalog(input) {
      try {
        const { data, error } = await callRpc("direct_entry_input_catalog", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_effective_date: input.effective_date,
        });
        if (error) return { ok: false, kind: classify(error, "catalog") };
        const projection = projectDraftCatalog(data, input.effective_date);
        return projection
          ? { ok: true, data: projection }
          : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] input catalog RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async listOwnDrafts(input) {
      try {
        const { data, error } = await callRpc("direct_entry_list_own_drafts", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
        });
        if (error) return { ok: false, kind: classify(error, "list") };
        const projection = projectOwnDrafts(data);
        return projection
          ? { ok: true, data: projection }
          : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] own drafts RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async updateDraftRow(input) {
      try {
        const { data, error } = await callRpc("direct_entry_update_draft_row", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
          p_expected_version: input.expected_version,
          p_patch: input.patch,
          p_idempotency_key: input.idempotency_key,
        });
        if (error) return { ok: false, kind: classify(error, "update") };
        const projection = projectDraftUpdate(data, input.entry_id);
        return projection
          ? { ok: true, data: projection }
          : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] update draft RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async updatePayment(input) {
      try {
        const { data, error } = await callRpc("direct_entry_update_payment", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
          p_expected_entry_version: input.expected_entry_version,
          p_expected_payment_version: input.expected_payment_version,
          p_payment: input.payment,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        });
        if (error) return { ok: false, kind: classify(error, "payment") };
        const projection = projectPaymentUpdateResult(data, input.entry_id);
        return projection
          ? { ok: true, data: projection }
          : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] payment update RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
