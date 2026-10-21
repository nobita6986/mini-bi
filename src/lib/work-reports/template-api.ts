import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { readBoundedJson } from "../direct-entry/write-api.ts";
import {
  type TemplateActor,
  type WorkReportTemplateRepository,
} from "./template-repository.ts";
import { WORK_REPORT_FREQUENCIES, type WorkReportTemplateSchema } from "./contracts.ts";
import { buildWorkReportMetricContract, validateWorkReportMetricContract } from "./metric-contract.ts";
import { validateWorkReportSchema } from "./schema-validator.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const METRIC_TYPES = new Set(["integer", "decimal", "boolean", "single_select", "multi_select"]);
const MAX_DESCRIPTION = 2000;

export type TemplateApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: WorkReportTemplateRepository;
};

function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
function fail(code: string, status: number): Response { return respond({ ok: false, code }, status); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function id(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }

function actorFromSession(session: DirectEntrySessionResult):
  | { ok: true; actor: TemplateActor }
  | { ok: false; response: Response } {
  if (!session.actor.ok) return {
    ok: false,
    response: fail(session.actor.reason === "UNAUTHENTICATED" ? "UNAUTHENTICATED" : "ACTOR_NOT_AVAILABLE",
      session.actor.reason === "UNAUTHENTICATED" ? 401 : 403),
  };
  const actor = session.actor.actor;
  if (!id(actor?.auth_subject) || !id(actor?.app_user_id)) {
    return { ok: false, response: fail("ACTOR_NOT_AVAILABLE", 403) };
  }
  return { ok: true, actor: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id } };
}

function mapError(kind: string): Response {
  if (kind === "denied") return fail("WORK_REPORT_ACCESS_DENIED", 403);
  if (kind === "not-found") return fail("WORK_REPORT_TEMPLATE_NOT_FOUND", 404);
  if (kind === "invalid") return fail("WORK_REPORT_TEMPLATE_INVALID", 400);
  if (kind === "conflict") return fail("WORK_REPORT_VERSION_CONFLICT", 409);
  console.error("[work-reports] template request unavailable");
  return fail("WORK_REPORT_UNAVAILABLE", 500);
}

function preflight(flag: string | undefined): Response | null {
  return flag === "true" ? null : fail("NOT_FOUND", 404);
}
function mutationPreflight(request: Request, flag: string | undefined): Response | null {
  const gated = preflight(flag);
  if (gated) return gated;
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"), host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  return origin.ok ? null : fail("CSRF_REJECTED", 403);
}

async function parseBody(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return { ok: false, response: fail("CONTENT_TYPE_INVALID", 400) };
  }
  const body = await readBoundedJson(request);
  if (!record(body)) return { ok: false, response: fail("BODY_INVALID", 400) };
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return { ok: false, response: fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400) };
    }
  } catch {
    return { ok: false, response: fail("WORK_REPORT_TEMPLATE_INVALID", 400) };
  }
  return { ok: true, value: body };
}

function schemaFrom(value: unknown): { schema: WorkReportTemplateSchema; metrics: ReturnType<typeof buildWorkReportMetricContract> } | null {
  const schema = validateWorkReportSchema(value);
  if (!schema.ok) return null;
  if (schema.value.sections.some((section) => section.fields.some((field) =>
    field.is_metric && !METRIC_TYPES.has(field.field_type)))) return null;
  const metrics = buildWorkReportMetricContract(schema.value);
  return validateWorkReportMetricContract(schema.value, metrics).ok ? { schema: schema.value, metrics } : null;
}

function description(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && value.length <= MAX_DESCRIPTION ? value : undefined;
}

async function trustedActor(dependencies: TemplateApiDependencies) {
  try { return actorFromSession(await dependencies.resolveSession()); }
  catch {
    console.error("[work-reports] session unavailable");
    return { ok: false as const, response: fail("WORK_REPORT_UNAVAILABLE", 500) };
  }
}

async function mutation<T>(run: (actor: TemplateActor) => Promise<{ ok: true; data: T } | { ok: false; kind: string }>,
  dependencies: TemplateApiDependencies): Promise<Response> {
  const actor = await trustedActor(dependencies);
  if (!actor.ok) return actor.response;
  try {
    const result = await run(actor.actor);
    return result.ok ? respond({ ok: true, mutation: result.data }) : mapError(result.kind);
  } catch {
    console.error("[work-reports] template mutation failed");
    return fail("WORK_REPORT_UNAVAILABLE", 500);
  }
}

function commonTemplate(value: Record<string, unknown>) {
  const desc = description(value.description);
  const schema = schemaFrom(value.schema_json);
  if (desc === undefined || typeof value.display_name !== "string" || value.display_name.trim() === "" ||
      value.display_name.length > 256 || typeof value.default_frequency !== "string" ||
      !(WORK_REPORT_FREQUENCIES as readonly string[]).includes(value.default_frequency) || !schema) return null;
  return { display_name: value.display_name.trim(), description: desc, default_frequency: value.default_frequency,
    schema_json: schema.schema, metric_contract_json: schema.metrics };
}

export async function listTemplates(flag: string | undefined, dependencies: TemplateApiDependencies): Promise<Response> {
  const gated = preflight(flag); if (gated) return gated;
  const actor = await trustedActor(dependencies); if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.list(actor.actor);
    return result.ok ? respond({ ok: true, items: result.data }) : mapError(result.kind);
  } catch { return fail("WORK_REPORT_UNAVAILABLE", 500); }
}

export async function getTemplate(templateId: string, flag: string | undefined,
  dependencies: TemplateApiDependencies): Promise<Response> {
  const gated = preflight(flag); if (gated) return gated;
  if (!id(templateId)) return fail("WORK_REPORT_TEMPLATE_INVALID", 400);
  const actor = await trustedActor(dependencies); if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.get({ ...actor.actor, template_id: templateId });
    return result.ok ? respond({ ok: true, template: result.data }) : mapError(result.kind);
  } catch { return fail("WORK_REPORT_UNAVAILABLE", 500); }
}

export async function previewTemplate(templateId: string, versionId: string, flag: string | undefined,
  dependencies: TemplateApiDependencies): Promise<Response> {
  const gated = preflight(flag); if (gated) return gated;
  if (!id(templateId) || !id(versionId)) return fail("WORK_REPORT_TEMPLATE_INVALID", 400);
  const actor = await trustedActor(dependencies); if (!actor.ok) return actor.response;
  try {
    const result = await dependencies.repository.get({ ...actor.actor, template_id: templateId });
    if (!result.ok) return mapError(result.kind);
    const version = result.data.versions.find((candidate) => candidate.version_id === versionId);
    return version ? respond({ ok: true, version }) : fail("WORK_REPORT_TEMPLATE_VERSION_NOT_FOUND", 404);
  } catch { return fail("WORK_REPORT_UNAVAILABLE", 500); }
}

export async function createTemplate(request: Request, flag: string | undefined,
  dependencies: TemplateApiDependencies): Promise<Response> {
  const blocked = mutationPreflight(request, flag); if (blocked) return blocked;
  const parsed = await parseBody(request); if (!parsed.ok) return parsed.response;
  const value = parsed.value;
  const keys = ["template_code", "display_name", "description", "default_frequency", "schema_json", "idempotency_key"];
  if (!exact(value, keys) || typeof value.template_code !== "string" || !CODE.test(value.template_code) || !id(value.idempotency_key)) {
    return fail("WORK_REPORT_TEMPLATE_INVALID", 400);
  }
  const fields = commonTemplate(value);
  if (!fields) return fail("WORK_REPORT_TEMPLATE_INVALID", 400);
  const headerKey = request.headers.get("idempotency-key");
  if (headerKey !== null && headerKey !== value.idempotency_key) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  return mutation((actor) => dependencies.repository.create({ ...actor, template_code: value.template_code as string,
    ...fields, idempotency_key: value.idempotency_key as string }), dependencies);
}

export async function updateTemplate(request: Request, templateId: string, flag: string | undefined,
  dependencies: TemplateApiDependencies): Promise<Response> {
  const blocked = mutationPreflight(request, flag); if (blocked) return blocked;
  if (!id(templateId)) return fail("WORK_REPORT_TEMPLATE_INVALID", 400);
  const parsed = await parseBody(request); if (!parsed.ok) return parsed.response;
  const value = parsed.value;
  if (!exact(value, ["draft_version_id", "expected_version", "display_name", "description", "default_frequency", "schema_json", "idempotency_key"]) ||
      !id(value.draft_version_id) || !Number.isSafeInteger(value.expected_version) || Number(value.expected_version) < 1 || !id(value.idempotency_key)) {
    return fail("WORK_REPORT_TEMPLATE_INVALID", 400);
  }
  const fields = commonTemplate(value);
  if (!fields) return fail("WORK_REPORT_TEMPLATE_INVALID", 400);
  const headerKey = request.headers.get("idempotency-key");
  if (headerKey !== null && headerKey !== value.idempotency_key) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  return mutation((actor) => dependencies.repository.update({ ...actor, template_id: templateId,
    draft_version_id: value.draft_version_id as string, expected_version: Number(value.expected_version), ...fields,
    idempotency_key: value.idempotency_key as string }), dependencies);
}

type VersionAction = "clone" | "publish" | "archive";
export async function templateAction(request: Request, templateId: string, action: VersionAction,
  flag: string | undefined, dependencies: TemplateApiDependencies): Promise<Response> {
  const blocked = mutationPreflight(request, flag); if (blocked) return blocked;
  if (!id(templateId)) return fail("WORK_REPORT_TEMPLATE_INVALID", 400);
  const parsed = await parseBody(request); if (!parsed.ok) return parsed.response;
  const value = parsed.value;
  const expectedKeys = action === "publish"
    ? ["draft_version_id", "expected_version", "idempotency_key"] : ["expected_version", "idempotency_key"];
  if (!exact(value, expectedKeys) || !Number.isSafeInteger(value.expected_version) || Number(value.expected_version) < 1 ||
      !id(value.idempotency_key) || (action === "publish" && !id(value.draft_version_id))) {
    return fail("WORK_REPORT_TEMPLATE_INVALID", 400);
  }
  const headerKey = request.headers.get("idempotency-key");
  if (headerKey !== null && headerKey !== value.idempotency_key) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  return mutation((actor) => {
    const common = { ...actor, template_id: templateId, expected_version: Number(value.expected_version),
      idempotency_key: value.idempotency_key as string };
    if (action === "clone") return dependencies.repository.clone(common);
    if (action === "archive") return dependencies.repository.archive(common);
    return dependencies.repository.publish({ ...common, draft_version_id: value.draft_version_id as string });
  }, dependencies);
}
