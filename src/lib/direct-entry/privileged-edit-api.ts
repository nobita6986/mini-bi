/**
 * P2.5-HF-R3 - API boundary sua truc tiep ho so (POST).
 *
 * Pipeline: gate -> entryId -> CSRF/origin -> content-type -> idempotency key -> body ->
 * strict patch validation -> server session actor -> repository -> sanitized response.
 *
 * Chi Admin (entry_admin) va bundle BoD/Ke toan (entry_privileged_edit) di qua duoc: capability
 * + scope do RPC quyet dinh. Khong bao gio nhan identity tu client va khong forward raw DB message.
 */
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import { isCanonicalNationalId } from "../contracts/national-id.ts";
import { readBoundedJson } from "./write-api.ts";
import type { PrivilegedEditRepository } from "./privileged-edit-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const LABOR_TYPES = ["TEMPORARY", "PERMANENT"] as const;
const BODY_KEYS = ["expected_entry_version", "patch", "reason"] as const;
export const PRIVILEGED_EDIT_PATCH_KEYS = [
  "employee_code", "first_work_date", "labor_type", "project_id", "recruiter_id", "worker_details",
] as const;

export type PrivilegedEditDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: PrivilegedEditRepository;
};

export type PrivilegedEditRequest = {
  expected_entry_version: number;
  patch: Record<string, unknown>;
  reason: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function respond(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

/**
 * Strict patch projection. Unknown or authority keys, a malformed CMT/CCCD and a missing reason
 * are refused before any database work; the DB re-validates everything it receives.
 */
export function projectPrivilegedEditRequest(body: unknown): PrivilegedEditRequest | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== BODY_KEYS.length || !BODY_KEYS.every((key) => keys.includes(key))) return null;
  const version = body.expected_entry_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  const reason = body.reason;
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 1000) return null;
  if (!isRecord(body.patch)) return null;
  const patch = body.patch;
  const patchKeys = Object.keys(patch);
  if (patchKeys.length === 0 ||
      !patchKeys.every((key) => (PRIVILEGED_EDIT_PATCH_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  if (typeof patch.project_id === "string" && !PROJECT_ID.test(patch.project_id)) return null;
  if (typeof patch.first_work_date === "string" && !ISO_DATE.test(patch.first_work_date)) return null;
  if (typeof patch.employee_code === "string" &&
      (patch.employee_code.trim().length === 0 || patch.employee_code.length > 64)) return null;
  if (typeof patch.recruiter_id === "string" && !UUID.test(patch.recruiter_id)) return null;
  if (typeof patch.labor_type === "string" &&
      !(LABOR_TYPES as readonly string[]).includes(patch.labor_type)) return null;
  if (patch.worker_details !== undefined) {
    if (!isRecord(patch.worker_details)) return null;
    const nationalId = patch.worker_details.national_id;
    if (isRecord(nationalId) && nationalId.state === "provided" &&
        !isCanonicalNationalId(nationalId.value)) {
      return null;
    }
  }
  return { expected_entry_version: version, patch, reason: reason.trim() };
}

export async function privilegedEditEntry(
  request: Request,
  entryId: string,
  flag: string | undefined,
  dependencies: PrivilegedEditDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(entryId)) return fail("ENTRY_ID_INVALID", 400);

  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json") return fail("CONTENT_TYPE_INVALID", 400);
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey === null || idempotencyKey.trim() === "" ||
      idempotencyKey.length > 128) return fail("IDEMPOTENCY_KEY_INVALID", 400);

  const body = await readBoundedJson(request);
  if (body === null) return fail("BODY_INVALID", 400);
  if (!validateClientBusinessPayload(body).ok) {
    return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
  }
  const parsed = projectPrivilegedEditRequest(body);
  if (!parsed) return fail("PRIVILEGED_EDIT_INVALID", 400);

  let session: DirectEntrySessionResult;
  try {
    session = await dependencies.resolveSession();
  } catch {
    console.error("[direct-entry] privileged edit session unavailable");
    return fail("PRIVILEGED_EDIT_UNAVAILABLE", 500);
  }
  if (!session.actor.ok) {
    return session.actor.reason === "UNAUTHENTICATED"
      ? fail("UNAUTHENTICATED", 401)
      : fail("ACTOR_NOT_AVAILABLE", 403);
  }
  const actor = session.actor.actor;
  if (!actor || typeof actor.auth_subject !== "string" || !UUID.test(actor.auth_subject) ||
      typeof actor.app_user_id !== "string" || !UUID.test(actor.app_user_id)) {
    return fail("ACTOR_NOT_AVAILABLE", 403);
  }

  let result: Awaited<ReturnType<PrivilegedEditRepository["edit"]>>;
  try {
    result = await dependencies.repository.edit({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      entry_id: entryId,
      expected_version: parsed.expected_entry_version,
      patch: parsed.patch,
      reason: parsed.reason,
      idempotency_key: idempotencyKey,
    });
  } catch {
    console.error("[direct-entry] privileged edit failed");
    return fail("PRIVILEGED_EDIT_UNAVAILABLE", 500);
  }
  if (!result.ok) {
    if (result.kind === "conflict") return fail(result.code, 409);
    if (result.kind === "denied") return fail(result.code, 403);
    if (result.kind === "invalid") return fail(result.code, 400);
    if (result.kind === "not-found") return fail(result.code, 404);
    console.error("[direct-entry] privileged edit unavailable");
    return fail(result.code, 500);
  }
  return respond({ ok: true, entry_id: result.data.entry_id, version: result.data.version }, 200);
}
