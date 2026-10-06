import "server-only";

import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import {
  projectPaymentUpdateResult,
  type PaymentInput,
} from "./payment-contract.ts";
import type { DocumentType } from "../contracts/direct-entry-v1.ts";
import {
  projectOwnDrafts,
} from "./draft-list-contract.ts";
import type { OwnDraft } from "./draft-list-contract.ts";

export {
  DRAFT_LIST_PROJECTION_VERSION,
  projectOwnDrafts,
} from "./draft-list-contract.ts";
export type {
  DraftPaymentAccountField,
  DraftProfileField,
  DraftProfileProjection,
  OwnDraft,
} from "./draft-list-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

type ActorRef = { auth_subject: string; app_user_id: string };

export type OperationResult<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind: "conflict" | "denied" | "invalid" | "not-found" | "too-large" | "unavailable";
    };

export type DocumentLifecycle = {
  upload_status: "QUEUED" | "UPLOADING" | "QUARANTINED" | "SCANNING" | "READY" | "FAILED" | "SUPERSEDED";
  scan_status: "PENDING" | "CLEAN" | "REJECTED" | "NOT_REQUIRED";
  validation_status: "PENDING" | "VALIDATED" | "REJECTED";
};

export type DocumentReservation = DocumentLifecycle & {
  document_id: string;
  version: number;
  entry_version: number;
  reused: boolean;
  storage_key: string;
};

export type DocumentContext = DocumentLifecycle & {
  document_id: string;
  document_type: DocumentType;
  version: number;
  entry_version: number;
  size_bytes: number;
  mime_type: "application/pdf" | "image/jpeg" | "image/png";
  storage_key: string;
};

export type DocumentFinalization = DocumentLifecycle & {
  document_id: string;
  version: number;
  entry_version: number;
  reused: boolean;
};

export type DraftCatalogRecruiterHrp = {
  recruiter_id: string;
  display_name: string;
  /** P3-W07A: business identifier (e.g. vinht.td); always present for HRP. */
  personnel_code: string;
  provider_type: "hrp";
  /** P3-W07A: vendor id is explicitly null for HRP rows. */
  vendor_id: null;
  /** P3-W07A: team UUID for HRP; Vendor has no business team in this release. */
  team_id: string;
  team_display_name: string;
  /** P3-W07A: pre-rendered UI label = `display · personnel_code · team_display_name`. */
  label: string;
};

export type DraftCatalogRecruiterVendor = {
  recruiter_id: string;
  display_name: string;
  /** Vendor rows have no personnel_code. */
  personnel_code: null;
  provider_type: "vendor";
  /** Vendor id; null only for legacy P1.6 bootstrap rows (no vendor link yet). */
  vendor_id: string | null;
  /** Vendor has no business team / leader in this release. */
  team_id: null;
  team_display_name: null;
  /** P3-W07A: pre-rendered UI label = vendor display name (or recruiter name for legacy). */
  label: string;
};

export type DraftCatalogRecruiter =
  | DraftCatalogRecruiterHrp
  | DraftCatalogRecruiterVendor;

export type DraftCatalog = {
  effective_date: string;
  projects: Array<{ project_id: string; display_name: string }>;
  recruiters: DraftCatalogRecruiter[];
  banks: Array<{ bank_id: string; display_name: string }>;
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
  reserveDocumentUpload(input: ActorRef & {
    entry_id: string;
    expected_entry_version: number;
    document_type: DocumentType;
    idempotency_key: string;
    size_bytes: number;
    mime_type: string;
    reason: string | null;
  }): Promise<OperationResult<DocumentReservation>>;
  getDocumentContext(input: ActorRef & {
    entry_id: string;
    document_id: string;
    purpose: "finalize" | "download";
  }): Promise<OperationResult<DocumentContext>>;
  finalizeDocument(input: ActorRef & {
    entry_id: string;
    document_id: string;
    expected_entry_version: number;
    idempotency_key: string;
    outcome: "validated" | "rejected";
    checksum_sha256: string | null;
    size_bytes: number | null;
    mime_type: string | null;
  }): Promise<OperationResult<DocumentFinalization>>;
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

const UPLOAD_STATUSES: readonly DocumentLifecycle["upload_status"][] = [
  "QUEUED", "UPLOADING", "QUARANTINED", "SCANNING", "READY", "FAILED", "SUPERSEDED",
];
const SCAN_STATUSES: readonly DocumentLifecycle["scan_status"][] = [
  "PENDING", "CLEAN", "REJECTED", "NOT_REQUIRED",
];
const VALIDATION_STATUSES: readonly DocumentLifecycle["validation_status"][] = [
  "PENDING", "VALIDATED", "REJECTED",
];
const DOCUMENT_TYPES: readonly DocumentType[] = ["CCCD_FRONT", "CCCD_BACK", "EMPLOYMENT_CONTRACT"];
const DOCUMENT_MIMES: readonly DocumentContext["mime_type"][] = [
  "application/pdf", "image/jpeg", "image/png",
];
const STORAGE_KEY_PATTERN = new RegExp(
  "^p1\\.6/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/" +
    "(?:CCCD_FRONT|CCCD_BACK|EMPLOYMENT_CONTRACT)/[1-9]\\d*/" +
    "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  "i",
);

function projectLifecycle(value: Record<string, unknown>): DocumentLifecycle | null {
  const upload = UPLOAD_STATUSES.find((status) => status === value.upload_status);
  const scan = SCAN_STATUSES.find((status) => status === value.scan_status);
  const validation = VALIDATION_STATUSES.find((status) => status === value.validation_status);
  return upload && scan && validation
    ? { upload_status: upload, scan_status: scan, validation_status: validation }
    : null;
}

function projectDocumentReservation(value: unknown): DocumentReservation | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "document_id", "version", "entry_version", "upload_status", "scan_status",
    "validation_status", "reused", "storage_key",
  ]) || typeof value.document_id !== "string" || !UUID.test(value.document_id) ||
      !isPositiveVersion(value.version) || !isPositiveVersion(value.entry_version) ||
      typeof value.reused !== "boolean" || typeof value.storage_key !== "string" ||
      !STORAGE_KEY_PATTERN.test(value.storage_key)) return null;
  const lifecycle = projectLifecycle(value);
  return lifecycle
    ? {
      ...lifecycle,
      document_id: value.document_id,
      version: value.version,
      entry_version: value.entry_version,
      reused: value.reused,
      storage_key: value.storage_key,
    }
    : null;
}

function projectDocumentContext(value: unknown, documentId: string): DocumentContext | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "document_id", "document_type", "version", "storage_key", "size_bytes", "mime_type",
    "upload_status", "scan_status", "validation_status", "entry_version",
  ]) || value.document_id !== documentId ||
      !isPositiveVersion(value.version) || !isPositiveVersion(value.entry_version) ||
      !isPositiveVersion(value.size_bytes) || typeof value.storage_key !== "string" ||
      !STORAGE_KEY_PATTERN.test(value.storage_key)) return null;
  const type = DOCUMENT_TYPES.find((candidate) => candidate === value.document_type);
  const mime = DOCUMENT_MIMES.find((candidate) => candidate === value.mime_type);
  const lifecycle = projectLifecycle(value);
  return type && mime && lifecycle
    ? {
      ...lifecycle,
      document_id: documentId,
      document_type: type,
      version: value.version,
      entry_version: value.entry_version,
      size_bytes: value.size_bytes,
      mime_type: mime,
      storage_key: value.storage_key,
    }
    : null;
}

function projectDocumentFinalization(value: unknown, documentId: string): DocumentFinalization | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "document_id", "version", "entry_version", "upload_status", "scan_status",
    "validation_status", "reused",
  ]) || value.document_id !== documentId || !isPositiveVersion(value.version) ||
      !isPositiveVersion(value.entry_version) || typeof value.reused !== "boolean") return null;
  const lifecycle = projectLifecycle(value);
  return lifecycle
    ? {
      ...lifecycle,
      document_id: documentId,
      version: value.version,
      entry_version: value.entry_version,
      reused: value.reused,
    }
    : null;
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
  // P3-W07A-R2: discriminated HRP / Vendor contract. Both shapes carry
  // exactly eight keys; HRP requires a UUID team and a non-null vendor_id
  // (always null), Vendor requires null team and null personnel_code. The
  // runtime must fail closed on any other combination — the contract is
  // the production seam that closed the CATALOG_UNAVAILABLE blocker.
  const recruiters: DraftCatalog["recruiters"] = [];
  for (const recruiter of value.recruiters) {
    if (!isRecord(recruiter) || !hasExactKeys(recruiter, [
      "recruiter_id", "display_name", "personnel_code", "provider_type", "vendor_id",
      "team_id", "team_display_name", "label",
    ]) || typeof recruiter.recruiter_id !== "string" || !UUID.test(recruiter.recruiter_id) ||
        typeof recruiter.display_name !== "string" || recruiter.display_name.trim().length === 0 ||
        (recruiter.provider_type !== "hrp" && recruiter.provider_type !== "vendor") ||
        typeof recruiter.label !== "string" || recruiter.label.trim().length === 0) {
      return null;
    }
    if (recruiter.provider_type === "hrp") {
      if (typeof recruiter.personnel_code !== "string" || recruiter.personnel_code.trim().length === 0 ||
          recruiter.vendor_id !== null ||
          typeof recruiter.team_id !== "string" || !UUID.test(recruiter.team_id) ||
          typeof recruiter.team_display_name !== "string" ||
          recruiter.team_display_name.trim().length === 0) {
        return null;
      }
      recruiters.push({
        recruiter_id: recruiter.recruiter_id,
        display_name: recruiter.display_name,
        personnel_code: recruiter.personnel_code,
        provider_type: "hrp",
        vendor_id: null,
        team_id: recruiter.team_id,
        team_display_name: recruiter.team_display_name,
        label: recruiter.label,
      });
    } else {
      // provider_type === "vendor"
      if (recruiter.personnel_code !== null ||
          recruiter.team_id !== null ||
          recruiter.team_display_name !== null ||
          (recruiter.vendor_id !== null && (
            typeof recruiter.vendor_id !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(recruiter.vendor_id)
          ))) {
        return null;
      }
      recruiters.push({
        recruiter_id: recruiter.recruiter_id,
        display_name: recruiter.display_name,
        personnel_code: null,
        provider_type: "vendor",
        vendor_id: recruiter.vendor_id,
        team_id: null,
        team_display_name: null,
        label: recruiter.label,
      });
    }
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
  operation: "create" | "read" | "catalog" | "list" | "update" | "payment" | "document",
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
    if ((operation === "payment" || operation === "document") && error.code === "23514") return "invalid";
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
    async reserveDocumentUpload(input) {
      try {
        const { data, error } = await callRpc("direct_entry_reserve_document_direct_upload", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
          p_expected_entry_version: input.expected_entry_version,
          p_document_type: input.document_type,
          p_idempotency_key: input.idempotency_key,
          p_size_bytes: input.size_bytes,
          p_mime_type: input.mime_type,
          p_reason: input.reason,
        });
        if (error) return { ok: false, kind: classify(error, "document") };
        const projection = projectDocumentReservation(data);
        return projection
          ? { ok: true, data: projection }
          : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] document reservation RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async getDocumentContext(input) {
      try {
        const { data, error } = await callRpc("direct_entry_document_direct_context", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
          p_document_id: input.document_id,
          p_purpose: input.purpose,
        });
        if (error) return { ok: false, kind: classify(error, "document") };
        const projection = projectDocumentContext(data, input.document_id);
        return projection
          ? { ok: true, data: projection }
          : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] document context RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async finalizeDocument(input) {
      try {
        const { data, error } = await callRpc("direct_entry_finalize_document_direct_upload", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_entry_id: input.entry_id,
          p_document_id: input.document_id,
          p_expected_entry_version: input.expected_entry_version,
          p_idempotency_key: input.idempotency_key,
          p_outcome: input.outcome,
          p_checksum_sha256: input.checksum_sha256,
          p_size_bytes: input.size_bytes,
          p_mime_type: input.mime_type,
        });
        if (error) return { ok: false, kind: classify(error, "document") };
        const projection = projectDocumentFinalization(data, input.document_id);
        return projection
          ? { ok: true, data: projection }
          : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[direct-entry] document finalize RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
