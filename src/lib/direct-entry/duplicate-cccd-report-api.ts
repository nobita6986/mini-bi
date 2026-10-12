/**
 * P3.1-HF-R3 - API boundary bao cao CCCD trung (GET, read-only, phan trang).
 *
 * Pipeline:
 *   1. DIRECT_ENTRY_API_ENABLED gate (route)
 *   2. parse/validate query (page 1..1000, page_size 1..100, mac dinh 25)
 *   3. session server-side (getDirectEntryActor)
 *   4. actor mapping fail-closed
 *   5. repository goi RPC doc duy nhat
 *   6. strict projection (da lam o repository - bo authority/project_id)
 *   7. sanitized response (private, no-store)
 *
 * GET khong mutation nen khong co CSRF/origin check (theo pattern read hien co cua Direct
 * Entry). Server tu resolve session actor; client khong gui auth_subject/app_user_id hay
 * authority. Khong danh gia capability/scope o application; audience thuoc RPC. Mot denial
 * KHONG bao gio tro thanh mot trang rong "khong co trung". Khong log identity hay raw error.
 */
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { projectDuplicateCccdReportQuery } from "./duplicate-cccd-report-contract.ts";
import type { DuplicateCccdReportRepository } from "./duplicate-cccd-report-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DuplicateCccdReportDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: DuplicateCccdReportRepository;
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
  dependencies: DuplicateCccdReportDependencies,
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
    console.error("[direct-entry] duplicate CCCD report session unavailable");
    return { ok: false, response: fail("DUPLICATE_CCCD_REPORT_UNAVAILABLE", 500) };
  }
}

export async function duplicateCccdReport(
  request: Request,
  flag: string | undefined,
  dependencies: DuplicateCccdReportDependencies,
): Promise<Response> {
  if (flag !== "true") return fail("NOT_FOUND", 404);

  const parsed = projectDuplicateCccdReportQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return fail(parsed.code, 400);

  const session = await resolveTrustedActor(dependencies);
  if (!session.ok) return session.response;

  let result: Awaited<ReturnType<DuplicateCccdReportRepository["report"]>>;
  try {
    result = await dependencies.repository.report({ ...session.actor, ...parsed.value });
  } catch {
    console.error("[direct-entry] duplicate CCCD report request failed");
    return fail("DUPLICATE_CCCD_REPORT_UNAVAILABLE", 500);
  }
  if (!result.ok) {
    if (result.kind === "denied") return fail("DUPLICATE_CCCD_REPORT_DENIED", 403);
    if (result.kind === "invalid") return fail("DUPLICATE_CCCD_REPORT_QUERY_INVALID", 400);
    console.error("[direct-entry] duplicate CCCD report unavailable");
    return fail("DUPLICATE_CCCD_REPORT_UNAVAILABLE", 500);
  }

  return respond({
    ok: true,
    page: result.data.page,
    page_size: result.data.page_size,
    total_groups: result.data.total_groups,
    total_entries: result.data.total_entries,
    has_more: result.data.has_more,
    authorization_date: result.data.authorization_date,
    groups: result.data.groups,
  }, 200);
}
