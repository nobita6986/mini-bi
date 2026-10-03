/**
 * P1.6-W04-S04C-S02A - API boundary cho change request (create/withdraw/decision).
 *
 * Pipeline thong nhat cho ca ba route:
 *   1. DIRECT_ENTRY_API_ENABLED gate
 *   2. same-origin/CSRF
 *   3. UUID cua path (khi co)
 *   4. content-type + JSON bounded
 *   5. quet authority de quy + strict request projection
 *   6. resolve session server-side
 *   7. actor mapping fail-closed
 *   8. repository/RPC
 *   9. response sanitized
 *
 * Khong tra raw DB message, stack, auth claim hay chi tiet SQL. Capability/scope/self-review/OCC/
 * idempotency do RPC enforce; module nay KHONG danh gia quyen va KHONG doc truoc DB.
 */
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { readBoundedJson } from "./write-api.ts";
import {
  projectChangeRequestCreate,
  projectChangeRequestDecision,
  projectChangeRequestWithdraw,
} from "./change-request-contract.ts";
import type { ChangeRequestOutcome, ChangeRequestRepository } from "./change-request-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ChangeRequestDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: ChangeRequestRepository;
};

type TrustedActor = { auth_subject: string; app_user_id: string };

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

async function readMutationBody(
  request: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return { ok: false, response: fail("CONTENT_TYPE_INVALID", 400) };
  }
  const body = await readBoundedJson(request);
  if (body === null) return { ok: false, response: fail("BODY_INVALID", 400) };
  return { ok: true, body };
}

function authorityFailure(body: unknown): Response | null {
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
  } catch {
    return fail("CHANGE_REQUEST_INVALID", 400);
  }
  return null;
}

function idempotencyKeyFailure(request: Request, key: string): Response | null {
  const header = request.headers.get("idempotency-key");
  if (header !== null && header !== key) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  return null;
}

async function resolveTrustedActor(
  request: Request,
  dependencies: ChangeRequestDependencies,
): Promise<{ ok: true; actor: TrustedActor } | { ok: false; response: Response }> {
  try {
    const session = await dependencies.resolveSession();
    if (!session.actor.ok) {
      return {
        ok: false,
        response: session.actor.reason === "UNAUTHENTICATED"
          ? fail("UNAUTHENTICATED", 401)
          : fail("ACTOR_NOT_AVAILABLE", 403),
      };
    }
    const actor = session.actor.actor;
    if (!actor || typeof actor.auth_subject !== "string" || !UUID.test(actor.auth_subject) ||
        typeof actor.app_user_id !== "string" || !UUID.test(actor.app_user_id)) {
      return { ok: false, response: fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    return { ok: true, actor: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id } };
  } catch {
    console.error("[direct-entry] change request session unavailable");
    return { ok: false, response: fail("CHANGE_REQUEST_UNAVAILABLE", 500) };
  }
}

type OutcomeKind = "conflict" | "denied" | "invalid" | "not-found" | "unavailable";

/** Goi repository va luon sanitize loi bat ngo (throw) thanh 500, khong de ro ri ra framework. */
async function callRepository<T>(
  run: () => Promise<ChangeRequestOutcome<T>>,
  logMessage: string,
): Promise<{ ok: true; result: ChangeRequestOutcome<T> } | { ok: false; response: Response }> {
  try {
    return { ok: true, result: await run() };
  } catch {
    console.error(logMessage);
    return { ok: false, response: fail("CHANGE_REQUEST_UNAVAILABLE", 500) };
  }
}

function mapOutcome(kind: OutcomeKind, notFoundCode: string): Response {
  if (kind === "denied") return fail("CHANGE_REQUEST_DENIED", 403);
  if (kind === "not-found") return fail(notFoundCode, 404);
  if (kind === "conflict") return fail("CHANGE_REQUEST_CONFLICT", 409);
  if (kind === "invalid") return fail("CHANGE_REQUEST_INVALID", 400);
  console.error("[direct-entry] change request unavailable");
  return fail("CHANGE_REQUEST_UNAVAILABLE", 500);
}

export async function createChangeRequest(
  request: Request,
  flag: string | undefined,
  dependencies: ChangeRequestDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);

  const body = await readMutationBody(request);
  if (!body.ok) return body.response;
  const authority = authorityFailure(body.body);
  if (authority) return authority;

  let parsed: ReturnType<typeof projectChangeRequestCreate>;
  try {
    parsed = projectChangeRequestCreate(body.body);
  } catch {
    return fail("CHANGE_REQUEST_INVALID", 400);
  }
  if (!parsed.ok) return fail(parsed.code, 400);

  const mismatch = idempotencyKeyFailure(request, parsed.value.idempotency_key);
  if (mismatch) return mismatch;

  const session = await resolveTrustedActor(request, dependencies);
  if (!session.ok) return session.response;

  const called = await callRepository(
    () => dependencies.repository.createChangeRequest({
      ...session.actor,
      items: parsed.value.items,
      reason: parsed.value.reason,
      idempotency_key: parsed.value.idempotency_key,
    }),
    "[direct-entry] change request create failed",
  );
  if (!called.ok) return called.response;
  const result = called.result;
  if (!result.ok) return mapOutcome(result.kind, "ENTRY_NOT_FOUND");
  return respond({
    ok: true,
    request_id: result.data.request_id,
    state: result.data.state,
    items: result.data.items,
  }, 200);
}

export async function withdrawChangeRequest(
  request: Request,
  requestId: string,
  flag: string | undefined,
  dependencies: ChangeRequestDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);

  if (typeof requestId !== "string" || !UUID.test(requestId)) {
    return fail("REQUEST_ID_INVALID", 400);
  }

  const body = await readMutationBody(request);
  if (!body.ok) return body.response;
  const authority = authorityFailure(body.body);
  if (authority) return authority;

  let parsed: ReturnType<typeof projectChangeRequestWithdraw>;
  try {
    parsed = projectChangeRequestWithdraw(body.body);
  } catch {
    return fail("CHANGE_REQUEST_INVALID", 400);
  }
  if (!parsed.ok) return fail(parsed.code, 400);

  const mismatch = idempotencyKeyFailure(request, parsed.value.idempotency_key);
  if (mismatch) return mismatch;

  const session = await resolveTrustedActor(request, dependencies);
  if (!session.ok) return session.response;

  const called = await callRepository(
    () => dependencies.repository.withdrawChangeRequest({
      ...session.actor,
      request_id: requestId,
      expected_version: parsed.value.expected_version,
      idempotency_key: parsed.value.idempotency_key,
    }),
    "[direct-entry] change request withdraw failed",
  );
  if (!called.ok) return called.response;
  const result = called.result;
  if (!result.ok) return mapOutcome(result.kind, "CHANGE_REQUEST_NOT_FOUND");
  return respond({
    ok: true,
    request_id: result.data.request_id,
    state: result.data.state,
    version: result.data.version,
  }, 200);
}

export async function decideChangeRequest(
  request: Request,
  requestId: string,
  flag: string | undefined,
  dependencies: ChangeRequestDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);

  if (typeof requestId !== "string" || !UUID.test(requestId)) {
    return fail("REQUEST_ID_INVALID", 400);
  }

  const body = await readMutationBody(request);
  if (!body.ok) return body.response;
  const authority = authorityFailure(body.body);
  if (authority) return authority;

  let parsed: ReturnType<typeof projectChangeRequestDecision>;
  try {
    parsed = projectChangeRequestDecision(body.body);
  } catch {
    return fail("CHANGE_REQUEST_INVALID", 400);
  }
  if (!parsed.ok) return fail(parsed.code, 400);

  const mismatch = idempotencyKeyFailure(request, parsed.value.idempotency_key);
  if (mismatch) return mismatch;

  const session = await resolveTrustedActor(request, dependencies);
  if (!session.ok) return session.response;

  const decisionInput = {
    ...session.actor,
    request_id: requestId,
    expected_version: parsed.value.expected_version,
    reason: parsed.value.reason,
    idempotency_key: parsed.value.idempotency_key,
  };
  // Dispatch CHI sau khi da project strict: quyet dinh la approve hoac reject, khong co
  // generic RPC/action dispatch tu chuoi do client gui.
  const called = await callRepository(
    () => parsed.value.decision === "approve"
      ? dependencies.repository.approveChangeRequest(decisionInput)
      : dependencies.repository.rejectChangeRequest(decisionInput),
    "[direct-entry] change request decision failed",
  );
  if (!called.ok) return called.response;
  const result = called.result;
  if (!result.ok) return mapOutcome(result.kind, "CHANGE_REQUEST_NOT_FOUND");
  return respond({
    ok: true,
    request_id: result.data.request_id,
    state: result.data.state,
    version: result.data.version,
  }, 200);
}
