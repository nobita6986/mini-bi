/**
 * PRE-W2-HF Project↔Team authority (T1A) - API boundary for mapping admin.
 * Pipeline: DIRECT_ENTRY_API_ENABLED -> same-origin/CSRF (mutation) -> content-type
 * -> exact allowlist -> server session actor -> repository/RPC -> sanitized response.
 */
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { readBoundedJson } from "../direct-entry/write-api.ts";
import type { ProjectTeamScopeRepository, ProjectTeamScopeErrorKind } from "./project-team-scope-repository.ts";
import {
  parseGrant,
  parseRevoke,
} from "./project-team-scope-contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export type ProjectTeamScopeDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: ProjectTeamScopeRepository;
};

type TrustedActor = { auth_subject: string; app_user_id: string };

function respond(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}
type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readPreflight(flag: string | undefined): Response | null {
  return flag === "true" ? null : fail("NOT_FOUND", 404);
}
function mutationPreflight(request: Request, flag: string | undefined): Response | null {
  const blocked = readPreflight(flag);
  if (blocked) return blocked;
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("PROJECT_TEAM_SCOPE_INVALID", 400);
  }
  return null;
}

function errorResponse(kind: ProjectTeamScopeErrorKind): Response {
  if (kind === "denied") return fail("PROJECT_TEAM_SCOPE_DENIED", 403);
  if (kind === "not-found") return fail("PROJECT_TEAM_SCOPE_NOT_FOUND", 404);
  if (kind === "conflict") return fail("PROJECT_TEAM_SCOPE_CONFLICT", 409);
  if (kind === "invalid") return fail("PROJECT_TEAM_SCOPE_INVALID", 400);
  return fail("PROJECT_TEAM_SCOPE_UNAVAILABLE", 500);
}

async function resolveActor(deps: ProjectTeamScopeDependencies): Promise<Parsed<TrustedActor>> {
  try {
    const session = await deps.resolveSession();
    if (!session.actor.ok) {
      return { ok: false, response: session.actor.reason === "UNAUTHENTICATED"
        ? fail("UNAUTHENTICATED", 401) : fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    const actor = session.actor.actor;
    if (!actor || typeof actor.auth_subject !== "string" || !UUID.test(actor.auth_subject) ||
        typeof actor.app_user_id !== "string" || !UUID.test(actor.app_user_id)) {
      return { ok: false, response: fail("ACTOR_NOT_AVAILABLE", 403) };
    }
    return { ok: true, value: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id } };
  } catch {
    return { ok: false, response: fail("PROJECT_TEAM_SCOPE_UNAVAILABLE", 500) };
  }
}

async function readMutationBody(request: Request, allowTeamId = false): Promise<Parsed<unknown>> {
  const body = await readBoundedJson(request);
  if (body === null) return { ok: false, response: fail("PROJECT_TEAM_SCOPE_INVALID", 400) };
  // `team_id` is a business key here, although the shared generic guard bans it
  // because other APIs treat it as client-supplied authority. Exact request
  // projectors below still validate its UUID and reject every extra field.
  const authorityCheck = allowTeamId && isRecord(body)
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "team_id"))
    : body;
  if (!validateClientBusinessPayload(authorityCheck).ok) return { ok: false, response: fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400) };
  return { ok: true, value: body };
}

export type ListScopesQuery = {
  project_id: string | null;
  team_id: string | null;
  include_history: boolean;
  page: number;
  page_size: number;
};

export function parseListScopesQuery(url: URL): Parsed<ListScopesQuery> {
  for (const key of url.searchParams.keys()) {
    if (!["project_id", "team_id", "include_history", "page", "page_size"].includes(key)) {
      return { ok: false, response: fail("PROJECT_TEAM_SCOPE_INVALID", 400) };
    }
  }
  for (const key of ["project_id", "team_id", "include_history", "page", "page_size"]) {
    if (url.searchParams.getAll(key).length > 1) return { ok: false, response: fail("PROJECT_TEAM_SCOPE_INVALID", 400) };
  }
  const rawProject = url.searchParams.get("project_id");
  if (rawProject !== null && !PROJECT_ID.test(rawProject)) return { ok: false, response: fail("PROJECT_TEAM_SCOPE_INVALID", 400) };
  const rawTeam = url.searchParams.get("team_id");
  if (rawTeam !== null && !UUID.test(rawTeam)) return { ok: false, response: fail("PROJECT_TEAM_SCOPE_INVALID", 400) };
  const rawHistory = url.searchParams.get("include_history");
  if (rawHistory !== null && rawHistory !== "true" && rawHistory !== "false") return { ok: false, response: fail("PROJECT_TEAM_SCOPE_INVALID", 400) };
  const rawPage = url.searchParams.get("page") ?? "1";
  const rawPageSize = url.searchParams.get("page_size") ?? "25";
  if (!/^\d{1,6}$/.test(rawPage) || !/^\d{1,6}$/.test(rawPageSize)) return { ok: false, response: fail("PROJECT_TEAM_SCOPE_INVALID", 400) };
  const page = Number(rawPage);
  const page_size = Number(rawPageSize);
  if (page < 1 || page > 1000 || page_size < 1 || page_size > 100) return { ok: false, response: fail("PROJECT_TEAM_SCOPE_INVALID", 400) };
  return { ok: true, value: {
    project_id: rawProject, team_id: rawTeam, include_history: rawHistory === "true",
    page, page_size,
  } };
}

export async function listProjectTeamScopes(
  request: Request, flag: string | undefined, deps: ProjectTeamScopeDependencies,
): Promise<Response> {
  const preflight = readPreflight(flag);
  if (preflight) return preflight;
  const query = parseListScopesQuery(new URL(request.url));
  if (!query.ok) return query.response;
  const actor = await resolveActor(deps);
  if (!actor.ok) return actor.response;
  const result = await deps.repository.listScopes({ ...actor.value, ...query.value });
  if (!result.ok) return errorResponse(result.kind);
  return respond({ ok: true, list: result.data }, 200);
}

export async function grantProjectTeamScope(
  request: Request, flag: string | undefined, deps: ProjectTeamScopeDependencies,
): Promise<Response> {
  const preflight = mutationPreflight(request, flag);
  if (preflight) return preflight;
  const body = await readMutationBody(request, true);
  if (!body.ok) return body.response;
  const parsed = parseGrant(body.value);
  if (!parsed.ok) return fail(parsed.code, 400);
  const actor = await resolveActor(deps);
  if (!actor.ok) return actor.response;
  const result = await deps.repository.grantScope({ ...actor.value, ...parsed.value });
  if (!result.ok) return errorResponse(result.kind);
  return respond({ ok: true, batch: result.data }, 200);
}

export async function revokeProjectTeamScope(
  request: Request, flag: string | undefined, deps: ProjectTeamScopeDependencies,
): Promise<Response> {
  const preflight = mutationPreflight(request, flag);
  if (preflight) return preflight;
  const body = await readMutationBody(request);
  if (!body.ok) return body.response;
  const parsed = parseRevoke(body.value);
  if (!parsed.ok) return fail(parsed.code, 400);
  const actor = await resolveActor(deps);
  if (!actor.ok) return actor.response;
  const result = await deps.repository.revokeScope({ ...actor.value, ...parsed.value });
  if (!result.ok) return errorResponse(result.kind);
  return respond({ ok: true, scope: result.data }, 200);
}
