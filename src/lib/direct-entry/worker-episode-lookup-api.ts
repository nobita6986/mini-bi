/**
 * P2.5-HF-R1 - API boundary tra cuu episode (GET).
 *
 * Pipeline:
 *   1. DIRECT_ENTRY_API_ENABLED gate (route)
 *   2. parse/validate query (project + ten HOAC CCCD, page_size/offset bound)
 *   3. Supabase SSR session (getDirectEntryActor)
 *   4. actor mapping server-side - browser khong bao gio gui identity
 *   5. repository goi direct_entry_lookup_worker_episodes
 *   6. strict result projection (worker-episode-lookup-contract)
 *   7. sanitized response (private, no-store)
 *
 * GET khong mutation nen khong co CSRF/origin check. Khong danh gia assignment/capability
 * o application; authority thuoc RPC. Khong log identity, CCCD hay raw error.
 */
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { projectWorkerEpisodeLookupQuery } from "./worker-episode-lookup-contract.ts";
import type { WorkerEpisodeLookupRepository } from "./worker-episode-lookup-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkerEpisodeLookupDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: WorkerEpisodeLookupRepository;
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
  dependencies: WorkerEpisodeLookupDependencies,
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
    console.error("[direct-entry] worker episode lookup session unavailable");
    return { ok: false, response: fail("WORKER_EPISODE_LOOKUP_UNAVAILABLE", 500) };
  }
}

export async function lookupWorkerEpisodes(
  request: Request,
  flag: string | undefined,
  dependencies: WorkerEpisodeLookupDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  let parsed: ReturnType<typeof projectWorkerEpisodeLookupQuery>;
  try {
    parsed = projectWorkerEpisodeLookupQuery(new URL(request.url).searchParams);
  } catch {
    return fail("WORKER_EPISODE_QUERY_INVALID", 400);
  }
  if (!parsed.ok) return fail(parsed.code, 400);

  const session = await resolveTrustedActor(dependencies);
  if (!session.ok) return session.response;

  let result: Awaited<ReturnType<WorkerEpisodeLookupRepository["lookup"]>>;
  try {
    result = await dependencies.repository.lookup({ ...session.actor, ...parsed.value });
  } catch {
    console.error("[direct-entry] worker episode lookup failed");
    return fail("WORKER_EPISODE_LOOKUP_UNAVAILABLE", 500);
  }
  if (!result.ok) {
    if (result.kind === "invalid") return fail("WORKER_EPISODE_QUERY_INVALID", 400);
    if (result.kind === "denied") return fail("WORKER_EPISODE_LOOKUP_DENIED", 403);
    if (result.kind === "not-found") return fail("WORKER_EPISODE_LOOKUP_DENIED", 403);
    console.error("[direct-entry] worker episode lookup unavailable");
    return fail("WORKER_EPISODE_LOOKUP_UNAVAILABLE", 500);
  }
  return respond({
    ok: true,
    match: result.data.match,
    project_id: result.data.project_id,
    page_size: result.data.page_size,
    offset: result.data.offset,
    has_more: result.data.has_more,
    workers: result.data.workers,
    authorization_date: result.data.authorization_date,
  }, 200);
}
