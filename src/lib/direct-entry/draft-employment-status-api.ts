import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import type { DirectEntryRepository } from "./write-repository.ts";
import { readBoundedJson } from "./write-api.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_KEYS = [
  "expected_entry_version", "status", "effective_date", "leave_date",
  "leave_reason_text", "reason",
];

type Dependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: Pick<DirectEntryRepository, "applyDraftEmploymentStatus">;
};

type StatusRequest = {
  expected_entry_version: number;
  status: "UNCONFIRMED" | "ON" | "OFF";
  effective_date: string;
  leave_date: string | null;
  leave_reason_text: string | null;
  reason: string;
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

function projectRequest(value: unknown): StatusRequest | null {
  if (!isRecord(value) ||
      Object.keys(value).sort().join(",") !== [...REQUEST_KEYS].sort().join(",") ||
      typeof value.expected_entry_version !== "number" ||
      !Number.isSafeInteger(value.expected_entry_version) || value.expected_entry_version < 1 ||
      (value.status !== "UNCONFIRMED" && value.status !== "ON" && value.status !== "OFF") ||
      typeof value.effective_date !== "string" || !isRealCalendarDate(value.effective_date) ||
      (value.leave_date !== null &&
        (typeof value.leave_date !== "string" || !isRealCalendarDate(value.leave_date))) ||
      (value.leave_reason_text !== null && typeof value.leave_reason_text !== "string") ||
      typeof value.reason !== "string" || value.reason.trim() === "" || value.reason.length > 4000) {
    return null;
  }
  if (value.status === "OFF") {
    if (value.leave_date !== value.effective_date ||
        typeof value.leave_reason_text !== "string" ||
        value.leave_reason_text.trim() === "" || value.leave_reason_text.trim().length > 4000) {
      return null;
    }
  } else if (value.leave_date !== null || value.leave_reason_text !== null) {
    return null;
  }
  return {
    expected_entry_version: value.expected_entry_version,
    status: value.status,
    effective_date: value.effective_date,
    leave_date: value.leave_date,
    leave_reason_text: value.leave_reason_text,
    reason: value.reason,
  };
}

export async function applyDraftEmploymentStatus(
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

  let parsed: StatusRequest | null;
  try {
    if (!validateClientBusinessPayload(body).ok) return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    parsed = projectRequest(body);
  } catch {
    return fail("STATUS_UPDATE_INVALID", 400);
  }
  if (!parsed) return fail("STATUS_UPDATE_INVALID", 400);

  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401)
        : fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const actor = session.actor.actor;
    if (!UUID.test(actor.auth_subject) || !UUID.test(actor.app_user_id)) {
      return fail("ACTOR_NOT_AVAILABLE", 403);
    }
    const result = await dependencies.repository.applyDraftEmploymentStatus({
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      entry_id: entryId,
      expected_entry_version: parsed.expected_entry_version,
      status: parsed.status,
      effective_date: parsed.effective_date,
      leave_reason_text: parsed.leave_reason_text,
      reason: parsed.reason,
      idempotency_key: idempotencyKey,
    });
    if (!result.ok) {
      if (result.kind === "conflict") return fail("STATUS_CONFLICT", 409);
      if (result.kind === "denied") return fail("ACTOR_DENIED", 403);
      if (result.kind === "not-found") return fail("ENTRY_NOT_FOUND", 404);
      if (result.kind === "invalid") return fail("STATUS_UPDATE_INVALID", 400);
      console.error("[direct-entry] draft employment status unavailable");
      return fail("STATUS_UPDATE_UNAVAILABLE", 500);
    }
    return respond({ ok: true, ...result.data }, 200);
  } catch {
    console.error("[direct-entry] draft employment status request failed");
    return fail("STATUS_UPDATE_UNAVAILABLE", 500);
  }
}
