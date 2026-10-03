/**
 * P1.6-W04-S04C-S02C - API boundary doc/list own submission (GET).
 *
 * Pipeline:
 *   1. DIRECT_ENTRY_API_ENABLED gate
 *   2. parse path/query
 *   3. validate UUID, page_size, cursor, state
 *   4. Supabase SSR session bang auth.getUser() (qua getDirectEntryActor)
 *   5. actor mapping server-side
 *   6. repository goi dung mot trong hai RPC read
 *   7. strict result projection
 *   8. sanitized response (private, no-store)
 *
 * GET khong mutation nen khong co CSRF/origin check (theo pattern read hien co).
 * Khong danh gia capability/scope o application; khong doc bang truc tiep; khong log identity/cursor/raw error.
 */
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { projectSubmissionListQuery } from "./submission-read-contract.ts";
import type { SubmissionReadRepository } from "./submission-read-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SubmissionReadDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: SubmissionReadRepository;
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
  dependencies: SubmissionReadDependencies,
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
    console.error("[direct-entry] submission read session unavailable");
    return { ok: false, response: fail("SUBMISSION_UNAVAILABLE", 500) };
  }
}

export async function listOwnSubmissions(
  request: Request,
  flag: string | undefined,
  dependencies: SubmissionReadDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  let parsed: ReturnType<typeof projectSubmissionListQuery>;
  try {
    parsed = projectSubmissionListQuery(new URL(request.url).searchParams);
  } catch {
    return fail("SUBMISSION_QUERY_INVALID", 400);
  }
  if (!parsed.ok) return fail(parsed.code, 400);

  const session = await resolveTrustedActor(dependencies);
  if (!session.ok) return session.response;

  let result: Awaited<ReturnType<SubmissionReadRepository["listOwnSubmissions"]>>;
  try {
    result = await dependencies.repository.listOwnSubmissions({
      ...session.actor,
      page_size: parsed.value.page_size,
      cursor: parsed.value.cursor,
      state: parsed.value.state,
    });
  } catch {
    console.error("[direct-entry] own submission list failed");
    return fail("SUBMISSION_UNAVAILABLE", 500);
  }
  if (!result.ok) {
    if (result.kind === "invalid") return fail("SUBMISSION_QUERY_INVALID", 400);
    if (result.kind === "denied") return fail("SUBMISSION_READ_DENIED", 403);
    if (result.kind === "not-found") return fail("SUBMISSION_NOT_FOUND", 404);
    console.error("[direct-entry] own submission list unavailable");
    return fail("SUBMISSION_UNAVAILABLE", 500);
  }
  return respond({
    ok: true,
    items: result.data.items,
    page_size: result.data.page_size,
    has_more: result.data.has_more,
    next_cursor: result.data.next_cursor,
  }, 200);
}

export async function readOwnSubmission(
  request: Request,
  submissionId: string,
  flag: string | undefined,
  dependencies: SubmissionReadDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  if (typeof submissionId !== "string" || !UUID.test(submissionId)) {
    return fail("SUBMISSION_ID_INVALID", 400);
  }
  if (new URL(request.url).searchParams.keys().next().done !== true) {
    return fail("SUBMISSION_QUERY_INVALID", 400);
  }

  const session = await resolveTrustedActor(dependencies);
  if (!session.ok) return session.response;

  let result: Awaited<ReturnType<SubmissionReadRepository["readOwnSubmission"]>>;
  try {
    result = await dependencies.repository.readOwnSubmission({
      ...session.actor,
      submission_id: submissionId,
    });
  } catch {
    console.error("[direct-entry] own submission read failed");
    return fail("SUBMISSION_UNAVAILABLE", 500);
  }
  if (!result.ok) {
    if (result.kind === "denied") return fail("SUBMISSION_READ_DENIED", 403);
    if (result.kind === "invalid") return fail("SUBMISSION_ID_INVALID", 400);
    if (result.kind === "not-found") return fail("SUBMISSION_NOT_FOUND", 404);
    console.error("[direct-entry] own submission read unavailable");
    return fail("SUBMISSION_UNAVAILABLE", 500);
  }
  return respond({ ok: true, ...result.data }, 200);
}
