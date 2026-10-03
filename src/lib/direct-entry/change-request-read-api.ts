/**
 * P1.6-W04-S04C-S02B - API boundary doc/list change request (GET).
 *
 * Pipeline:
 *   1. DIRECT_ENTRY_API_ENABLED gate
 *   2. parse path/query
 *   3. UUID + cursor + page_size + state validation (strict, khong tham so la)
 *   4. resolve session server-side (auth.getUser qua getDirectEntryActor)
 *   5. actor mapping fail-closed
 *   6. repository chi goi hai RPC doc
 *   7. strict response projection
 *   8. sanitized response (private, no-store)
 *
 * GET khong mutation nen khong co CSRF/origin check (theo pattern read hien co cua Direct Entry).
 * Khong danh gia capability/scope o application; khong doc truoc DB.
 */
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { projectChangeRequestListQuery } from "./change-request-read-contract.ts";
import type { ChangeRequestReadRepository } from "./change-request-read-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ChangeRequestReadDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: ChangeRequestReadRepository;
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

async function resolveTrustedActor(
  dependencies: ChangeRequestReadDependencies,
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
    console.error("[direct-entry] change request read session unavailable");
    return { ok: false, response: fail("CHANGE_REQUEST_UNAVAILABLE", 500) };
  }
}

export async function listChangeRequests(
  request: Request,
  flag: string | undefined,
  dependencies: ChangeRequestReadDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  let parsed: ReturnType<typeof projectChangeRequestListQuery>;
  try {
    parsed = projectChangeRequestListQuery(new URL(request.url).searchParams);
  } catch {
    return fail("CHANGE_REQUEST_QUERY_INVALID", 400);
  }
  if (!parsed.ok) return fail(parsed.code, 400);

  const session = await resolveTrustedActor(dependencies);
  if (!session.ok) return session.response;

  let result: Awaited<ReturnType<ChangeRequestReadRepository["listChangeRequests"]>>;
  try {
    result = await dependencies.repository.listChangeRequests({
      ...session.actor,
      page_size: parsed.value.page_size,
      cursor: parsed.value.cursor,
      state: parsed.value.state,
    });
  } catch {
    console.error("[direct-entry] change request list failed");
    return fail("CHANGE_REQUEST_UNAVAILABLE", 500);
  }
  if (!result.ok) {
    if (result.kind === "invalid") return fail("CHANGE_REQUEST_QUERY_INVALID", 400);
    if (result.kind === "denied") return fail("CHANGE_REQUEST_DENIED", 403);
    if (result.kind === "not-found") return fail("CHANGE_REQUEST_NOT_FOUND", 404);
    console.error("[direct-entry] change request list unavailable");
    return fail("CHANGE_REQUEST_UNAVAILABLE", 500);
  }
  return respond({
    ok: true,
    requests: result.data.requests,
    page_size: result.data.page_size,
    has_more: result.data.has_more,
    next_cursor: result.data.next_cursor,
  }, 200);
}

export async function readChangeRequest(
  request: Request,
  requestId: string,
  flag: string | undefined,
  dependencies: ChangeRequestReadDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  if (typeof requestId !== "string" || !UUID.test(requestId)) {
    return fail("CHANGE_REQUEST_ID_INVALID", 400);
  }
  if (new URL(request.url).searchParams.keys().next().done !== true) {
    return fail("CHANGE_REQUEST_QUERY_INVALID", 400);
  }

  const session = await resolveTrustedActor(dependencies);
  if (!session.ok) return session.response;

  let result: Awaited<ReturnType<ChangeRequestReadRepository["readChangeRequest"]>>;
  try {
    result = await dependencies.repository.readChangeRequest({
      ...session.actor,
      request_id: requestId,
    });
  } catch {
    console.error("[direct-entry] change request read failed");
    return fail("CHANGE_REQUEST_UNAVAILABLE", 500);
  }
  if (!result.ok) {
    if (result.kind === "denied") return fail("CHANGE_REQUEST_DENIED", 403);
    if (result.kind === "invalid") return fail("CHANGE_REQUEST_ID_INVALID", 400);
    if (result.kind === "not-found") return fail("CHANGE_REQUEST_NOT_FOUND", 404);
    console.error("[direct-entry] change request read unavailable");
    return fail("CHANGE_REQUEST_UNAVAILABLE", 500);
  }
  return respond({
    ok: true,
    request_id: result.data.request_id,
    state: result.data.state,
    version: result.data.version,
    created_at: result.data.created_at,
    items: result.data.items,
    can_withdraw: result.data.can_withdraw,
    can_decide: result.data.can_decide,
  }, 200);
}
