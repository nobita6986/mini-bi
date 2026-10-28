import "server-only";

import { validateWorkReportMetricContract } from "./metric-contract.ts";
import { validateWorkReportSchema } from "./schema-validator.ts";
import type { WorkReportMetricContract, WorkReportTemplateSchema } from "./contracts.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type TemplateActor = { auth_subject: string; app_user_id: string };
export type TemplateListItem = {
  template_id: string; template_code: string; display_name: string; description: string | null;
  default_frequency: string; status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  current_published_version_id: string | null; draft_version_id: string | null;
  version: number; updated_at: string;
};
export type TemplateVersion = {
  version_id: string; version_no: number; status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  requires_review: boolean; schema_json: WorkReportTemplateSchema;
  metric_contract_json: WorkReportMetricContract; schema_checksum: string;
  published_at: string | null;
};
export type TemplateDetail = Omit<TemplateListItem, "draft_version_id" | "updated_at"> & {
  versions: TemplateVersion[];
};
export type TemplateMutation = {
  template_id: string; draft_version_id?: string; published_version_id?: string;
  status?: string; version: number;
};
export type TemplateResult<T> = { ok: true; data: T } | {
  ok: false; kind: "conflict" | "denied" | "invalid" | "not-found" | "unavailable";
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === "string"; }
function nullableText(value: unknown): value is string | null { return value === null || text(value); }
function positiveInt(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function listItem(value: unknown): TemplateListItem | null {
  if (!record(value) || !uuid(value.template_id) || !text(value.template_code) ||
      !text(value.display_name) || !nullableText(value.description) || !text(value.default_frequency) ||
      !["DRAFT", "ACTIVE", "ARCHIVED"].includes(String(value.status)) ||
      !(value.current_published_version_id === null || uuid(value.current_published_version_id)) ||
      !(value.draft_version_id === null || uuid(value.draft_version_id)) ||
      !positiveInt(value.version) || !text(value.updated_at)) return null;
  return value as TemplateListItem;
}

function templateVersion(value: unknown): TemplateVersion | null {
  if (!record(value) || !uuid(value.version_id) || !positiveInt(value.version_no) ||
      !["DRAFT", "PUBLISHED", "ARCHIVED"].includes(String(value.status)) ||
      typeof value.requires_review !== "boolean" || !text(value.schema_checksum) ||
      !nullableText(value.published_at)) return null;
  const schema = validateWorkReportSchema(value.schema_json);
  if (!schema.ok) return null;
  const metrics = validateWorkReportMetricContract(schema.value, value.metric_contract_json);
  if (!metrics.ok) return null;
  return { ...value, schema_json: schema.value, metric_contract_json: metrics.value } as TemplateVersion;
}

function detail(value: unknown): TemplateDetail | null {
  if (!record(value) || !uuid(value.template_id) || !text(value.template_code) ||
      !text(value.display_name) || !nullableText(value.description) || !text(value.default_frequency) ||
      !["DRAFT", "ACTIVE", "ARCHIVED"].includes(String(value.status)) ||
      !(value.current_published_version_id === null || uuid(value.current_published_version_id)) ||
      !positiveInt(value.version) || !Array.isArray(value.versions)) return null;
  const versions = value.versions.map(templateVersion);
  if (versions.some((version) => version === null)) return null;
  return { ...value, versions: versions as TemplateVersion[] } as TemplateDetail;
}

function mutation(value: unknown): TemplateMutation | null {
  if (!record(value) || !uuid(value.template_id) || !positiveInt(value.version) ||
      (value.draft_version_id !== undefined && !uuid(value.draft_version_id)) ||
      (value.published_version_id !== undefined && !uuid(value.published_version_id)) ||
      (value.status !== undefined && !text(value.status))) return null;
  return value as TemplateMutation;
}

function classify(error: { code?: string; message?: string }): TemplateResult<never> {
  if (error.code === "PT409" || error.code === "40001" || error.code === "23505") return { ok: false, kind: "conflict" };
  if (error.code === "42501") return { ok: false, kind: "denied" };
  if (error.code === "P0002") return { ok: false, kind: "not-found" };
  if (error.code === "22023" || error.code === "23514") return { ok: false, kind: "invalid" };
  console.error("[work-reports] template RPC failed");
  return { ok: false, kind: "unavailable" };
}

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient());
  return async (name, args) => (await client).rpc(name, args);
}

export type WorkReportTemplateRepository = {
  list(actor: TemplateActor): Promise<TemplateResult<TemplateListItem[]>>;
  get(actor: TemplateActor & { template_id: string }): Promise<TemplateResult<TemplateDetail>>;
  create(actor: TemplateActor & {
    template_code: string; display_name: string; description: string | null; default_frequency: string;
    schema_json: WorkReportTemplateSchema; metric_contract_json: WorkReportMetricContract; idempotency_key: string;
  }): Promise<TemplateResult<TemplateMutation>>;
  update(actor: TemplateActor & {
    template_id: string; draft_version_id: string; expected_version: number; display_name: string;
    description: string | null; default_frequency: string; schema_json: WorkReportTemplateSchema;
    metric_contract_json: WorkReportMetricContract; idempotency_key: string;
  }): Promise<TemplateResult<TemplateMutation>>;
  clone(actor: TemplateActor & { template_id: string; expected_version: number; idempotency_key: string }): Promise<TemplateResult<TemplateMutation>>;
  publish(actor: TemplateActor & {
    template_id: string; draft_version_id: string; expected_version: number; idempotency_key: string;
  }): Promise<TemplateResult<TemplateMutation>>;
  archive(actor: TemplateActor & { template_id: string; expected_version: number; idempotency_key: string }): Promise<TemplateResult<TemplateMutation>>;
};

export function createWorkReportTemplateRepository(rpc?: Rpc): WorkReportTemplateRepository {
  let resolvedRpc = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  async function call<T>(name: string, args: Record<string, unknown>, project: (data: unknown) => T | null): Promise<TemplateResult<T>> {
    try {
      const { data, error } = await callRpc(name, args);
      if (error) return classify(error);
      const projected = project(data);
      return projected === null ? { ok: false, kind: "unavailable" } : { ok: true, data: projected };
    } catch {
      console.error("[work-reports] template RPC unavailable");
      return { ok: false, kind: "unavailable" };
    }
  }
  const actorArgs = (actor: TemplateActor) => ({ p_auth_subject: actor.auth_subject, p_app_user_id: actor.app_user_id });
  return {
    list: (actor) => call("work_report_list_templates", actorArgs(actor), (data) => {
      if (!record(data) || !Array.isArray(data.items)) return null;
      const items = data.items.map(listItem);
      return items.some((item) => item === null) ? null : items as TemplateListItem[];
    }),
    get: (actor) => call("work_report_get_template", { ...actorArgs(actor), p_template_id: actor.template_id }, detail),
    create: (actor) => call("work_report_create_template", {
      ...actorArgs(actor), p_template_code: actor.template_code, p_display_name: actor.display_name,
      p_description: actor.description, p_default_frequency: actor.default_frequency,
      p_schema_json: actor.schema_json, p_metric_contract_json: actor.metric_contract_json,
      p_idempotency_key: actor.idempotency_key,
    }, mutation),
    update: (actor) => call("work_report_update_template_draft", {
      ...actorArgs(actor), p_template_id: actor.template_id, p_draft_version_id: actor.draft_version_id,
      p_expected_version: actor.expected_version, p_display_name: actor.display_name,
      p_description: actor.description, p_default_frequency: actor.default_frequency,
      p_schema_json: actor.schema_json, p_metric_contract_json: actor.metric_contract_json,
      p_idempotency_key: actor.idempotency_key,
    }, mutation),
    clone: (actor) => call("work_report_clone_template_draft", {
      ...actorArgs(actor), p_template_id: actor.template_id, p_expected_version: actor.expected_version,
      p_idempotency_key: actor.idempotency_key,
    }, mutation),
    publish: (actor) => call("work_report_publish_template", {
      ...actorArgs(actor), p_template_id: actor.template_id, p_draft_version_id: actor.draft_version_id,
      p_expected_version: actor.expected_version, p_idempotency_key: actor.idempotency_key,
    }, mutation),
    archive: (actor) => call("work_report_archive_template", {
      ...actorArgs(actor), p_template_id: actor.template_id, p_expected_version: actor.expected_version,
      p_idempotency_key: actor.idempotency_key,
    }, mutation),
  };
}
