import {
  validateClientBusinessPayload,
} from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import {
  validateEmployeeCode,
  validateWorkerDetails,
  type WorkerDetails,
} from "../contracts/direct-entry-v1.ts";
import {
  DRAFT_LIST_PROJECTION_VERSION,
  type DirectEntryRepository,
  type DraftCatalog,
} from "./write-repository.ts";
import { readBoundedJson } from "./write-api.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATCH_KEYS = new Set([
  "project_id", "first_work_date", "employee_code", "worker_details", "recruiter_id", "labor_type",
]);

type Dependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: DirectEntryRepository;
};

type DraftPatch = {
  project_id: string;
  first_work_date: string;
  employee_code: string;
  worker_details: Pick<WorkerDetails, "display_name">;
  recruiter_id: string;
  labor_type: "TEMPORARY" | "PERMANENT";
};

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkerNamePatch(value: unknown): value is Pick<WorkerDetails, "display_name"> {
  if (!isRecord(value) || Object.keys(value).length !== 1 ||
      typeof value.display_name !== "string") return false;
  return validateWorkerDetails({
    display_name: value.display_name,
    date_of_birth: { state: "omitted" },
    national_id: { state: "omitted" },
    address: { state: "omitted" },
    phone: { state: "omitted" },
  }).length === 0;
}

function projectPatch(value: unknown): {
  expected_version: number;
  patch: DraftPatch;
} | null {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "expected_version") || !Object.hasOwn(value, "patch") ||
      typeof value.expected_version !== "number" ||
      !Number.isSafeInteger(value.expected_version) || value.expected_version < 1 ||
      !isRecord(value.patch) || Object.keys(value.patch).length !== PATCH_KEYS.size ||
      Object.keys(value.patch).some((key) => !PATCH_KEYS.has(key))) return null;
  const patch = value.patch;
  if (typeof patch.project_id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(patch.project_id) ||
      typeof patch.first_work_date !== "string" || !isRealCalendarDate(patch.first_work_date) ||
      typeof patch.employee_code !== "string" ||
      validateEmployeeCode(patch.employee_code, patch.first_work_date).length > 0 ||
      typeof patch.recruiter_id !== "string" || !UUID.test(patch.recruiter_id) ||
      (patch.labor_type !== "TEMPORARY" && patch.labor_type !== "PERMANENT") ||
      !isWorkerNamePatch(patch.worker_details)) return null;
  const projectedPatch: DraftPatch = {
    project_id: patch.project_id,
    first_work_date: patch.first_work_date,
    employee_code: patch.employee_code,
    worker_details: patch.worker_details,
    recruiter_id: patch.recruiter_id,
    labor_type: patch.labor_type,
  };
  return { expected_version: value.expected_version, patch: projectedPatch };
}

export async function getInputCatalog(
  effectiveDate: string | null,
  flag: string | undefined,
  dependencies: Dependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (effectiveDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) ||
      !isRealCalendarDate(effectiveDate)) return fail("EFFECTIVE_DATE_INVALID", 400);
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const result = await dependencies.repository.loadInputCatalog({
      auth_subject: session.actor.actor.auth_subject,
      app_user_id: session.actor.actor.app_user_id,
      effective_date: effectiveDate,
    });
    if (!result.ok) {
      if (result.kind === "denied") return fail("ACTOR_NOT_AVAILABLE", 403);
      console.error("[direct-entry] input catalog unavailable");
      return fail("CATALOG_UNAVAILABLE", 500);
    }
    const catalog: DraftCatalog = result.data;
    return respond({ ok: true, catalog }, 200);
  } catch {
    console.error("[direct-entry] input catalog request failed");
    return fail("CATALOG_UNAVAILABLE", 500);
  }
}

export async function getOwnDrafts(
  flag: string | undefined,
  dependencies: Dependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const result = await dependencies.repository.listOwnDrafts({
      auth_subject: session.actor.actor.auth_subject,
      app_user_id: session.actor.actor.app_user_id,
    });
    if (!result.ok) {
      if (result.kind === "denied") return fail("ACTOR_NOT_AVAILABLE", 403);
      if (result.kind === "too-large") return fail("DRAFT_LIMIT_EXCEEDED", 413);
      console.error("[direct-entry] own drafts unavailable");
      return fail("DRAFTS_UNAVAILABLE", 500);
    }
    return respond({
      ok: true,
      projection_version: DRAFT_LIST_PROJECTION_VERSION,
      drafts: result.data,
    }, 200);
  } catch {
    console.error("[direct-entry] own drafts request failed");
    return fail("DRAFTS_UNAVAILABLE", 500);
  }
}

export async function patchDraftEntry(
  request: Request,
  entryId: string,
  flag: string | undefined,
  dependencies: Dependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(entryId)) return fail("ENTRY_ID_INVALID", 400);
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null || idempotencyKey.trim() === "" || idempotencyKey.length > 128) {
    return fail("IDEMPOTENCY_KEY_INVALID", 400);
  }
  const body = await readBoundedJson(request);
  if (body === null) return fail("BODY_INVALID", 400);
  let parsed: ReturnType<typeof projectPatch>;
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
    parsed = projectPatch(body);
  } catch {
    return fail("DRAFT_PATCH_INVALID", 400);
  }
  if (!parsed) return fail("DRAFT_PATCH_INVALID", 400);

  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const trustedActor = {
      auth_subject: session.actor.actor.auth_subject,
      app_user_id: session.actor.actor.app_user_id,
    };
    const catalogResult = await dependencies.repository.loadInputCatalog({
      ...trustedActor,
      effective_date: parsed.patch.first_work_date,
    });
    if (!catalogResult.ok) {
      if (catalogResult.kind === "denied") return fail("ACTOR_NOT_AVAILABLE", 403);
      console.error("[direct-entry] draft catalog validation unavailable");
      return fail("CATALOG_UNAVAILABLE", 500);
    }
    const catalog = catalogResult.data;
    if (!catalog.projects.some(({ project_id }) => project_id === parsed.patch.project_id) ||
        !catalog.recruiters.some(({ recruiter_id }) => recruiter_id === parsed.patch.recruiter_id)) {
      return fail("DRAFT_MASTER_INVALID", 400);
    }
    const result = await dependencies.repository.updateDraftRow({
      ...trustedActor,
      entry_id: entryId,
      expected_version: parsed.expected_version,
      patch: parsed.patch,
      idempotency_key: idempotencyKey,
    });
    if (!result.ok) {
      if (result.kind === "conflict") return fail("DRAFT_CONFLICT", 409);
      if (result.kind === "denied") return fail("ACTOR_DENIED", 403);
      if (result.kind === "not-found") return fail("ENTRY_NOT_FOUND", 404);
      if (result.kind === "invalid") return fail("DRAFT_PATCH_INVALID", 400);
      console.error("[direct-entry] draft update unavailable");
      return fail("DRAFT_UPDATE_UNAVAILABLE", 500);
    }
    return respond({
      ok: true,
      entry_id: result.data.entry_id,
      entry_version: result.data.version,
      submission_version: result.data.submission_version,
    }, 200);
  } catch {
    console.error("[direct-entry] draft update request failed");
    return fail("DRAFT_UPDATE_UNAVAILABLE", 500);
  }
}
