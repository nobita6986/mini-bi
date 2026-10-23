import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { buildOffboardingExcel } from "./offboarding-export";
import type { OffboardingReportRepository } from "./offboarding-report-repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OffboardingReportApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: OffboardingReportRepository;
};

type TrustedActor = { auth_subject: string; app_user_id: string };

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

async function trustedActor(deps: OffboardingReportApiDependencies): Promise<TrustedActor | Response> {
  try {
    const session = await deps.resolveSession();
    if (!session.actor.ok) {
      const unauthenticated = session.actor.reason === "UNAUTHENTICATED";
      return fail(unauthenticated ? "UNAUTHENTICATED" : "ACTOR_NOT_AVAILABLE", unauthenticated ? 401 : 403);
    }
    const actor = session.actor.actor;
    if (!actor || !UUID.test(actor.auth_subject) || !UUID.test(actor.app_user_id)) {
      return fail("ACTOR_NOT_AVAILABLE", 403);
    }
    return { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id };
  } catch {
    return fail("WORKFORCE_OFFBOARDING_UNAVAILABLE", 503);
  }
}

function errorResponse(kind: "denied" | "invalid" | "unavailable"): Response {
  if (kind === "denied") return fail("WORKFORCE_OFFBOARDING_DENIED", 403);
  if (kind === "invalid") return fail("WORKFORCE_OFFBOARDING_INVALID", 400);
  return fail("WORKFORCE_OFFBOARDING_UNAVAILABLE", 503);
}

function readPagination(request: Request): { page: number; page_size: number } | Response {
  const { searchParams } = new URL(request.url);
  for (const key of searchParams.keys()) {
    if (key !== "page" && key !== "page_size") return fail("WORKFORCE_OFFBOARDING_INVALID", 400);
    if (searchParams.getAll(key).length > 1) return fail("WORKFORCE_OFFBOARDING_INVALID", 400);
  }
  const rawPage = searchParams.get("page") ?? "1";
  const rawPageSize = searchParams.get("page_size") ?? "25";
  if (!/^\d{1,6}$/.test(rawPage) || !/^\d{1,6}$/.test(rawPageSize)) return fail("WORKFORCE_OFFBOARDING_INVALID", 400);
  const page = Number(rawPage);
  const page_size = Number(rawPageSize);
  if (page < 1 || page > 1000 || page_size < 1 || page_size > 100) return fail("WORKFORCE_OFFBOARDING_INVALID", 400);
  return { page, page_size };
}

export async function listOffboardingReport(
  request: Request,
  enabled: string | undefined,
  deps: OffboardingReportApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const pagination = readPagination(request);
  if (pagination instanceof Response) return pagination;
  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;
  try {
    const result = await deps.repository.list({ ...actor, ...pagination });
    if (!result.ok) return errorResponse(result.kind);
    return respond({ ok: true, data: result.data }, 200);
  } catch {
    return fail("WORKFORCE_OFFBOARDING_UNAVAILABLE", 503);
  }
}

export async function exportOffboardingReport(
  request: Request,
  enabled: string | undefined,
  deps: OffboardingReportApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  if (new URL(request.url).searchParams.size > 0) return fail("WORKFORCE_OFFBOARDING_INVALID", 400);
  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;
  try {
    const result = await deps.repository.export(actor);
    if (!result.ok) return errorResponse(result.kind);
    return buildOffboardingExcel(result.data);
  } catch {
    return fail("WORKFORCE_OFFBOARDING_UNAVAILABLE", 503);
  }
}
