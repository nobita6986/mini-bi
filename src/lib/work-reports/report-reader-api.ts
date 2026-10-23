import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import type { WorkReportActorRef } from "./assignment-repository.ts";
import type {
  ReportReaderRepository,
  WorkReportReadableState,
  WorkReportReaderFilterInput,
  WorkReportReaderRpcOutcome,
} from "./report-reader-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYSET_CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))\|([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const ALLOWED_QUERY_KEYS = new Set([
  "template_id",
  "version_id",
  "from",
  "to",
  "team_id",
  "assignee_id",
  "state",
  "cursor",
  "limit",
]);

const READABLE_STATES = new Set<WorkReportReadableState>([
  "COMPLETED",
  "PENDING_REVIEW",
  "APPROVED",
  "REJECTED",
]);

export type ReportReaderApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: ReportReaderRepository;
};

function respond(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function fail(code: string, status: number): Response {
  return respond({ ok: false, code }, status);
}

function validateAllowedParams(searchParams: URLSearchParams, allowed: Set<string>): boolean {
  const seen = new Set<string>();
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function parseOptionalUuid(value: string | null): string | null | undefined {
  if (value === null || value === "") return null;
  return UUID.test(value) ? value : undefined;
}

function parseOptionalDate(value: string | null): string | null | undefined {
  if (value === null || value === "") return null;
  return isRealCalendarDate(value) ? value : undefined;
}

function parseOptionalState(value: string | null): WorkReportReadableState | null | undefined {
  if (value === null || value === "") return null;
  return READABLE_STATES.has(value as WorkReportReadableState)
    ? (value as WorkReportReadableState)
    : undefined;
}

function parseOptionalCursor(value: string | null): string | null | undefined {
  if (value === null || value === "") return null;
  if (value.length > 128) return undefined;
  const match = KEYSET_CURSOR.exec(value);
  if (!match) return undefined;
  if (Number.isNaN(Date.parse(match[1]))) return undefined;
  return value;
}

function parseLimit(value: string | null): number | undefined {
  if (value === null || value === "") return 50;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined;
}

function parseQueryFilters(
  searchParams: URLSearchParams,
): Omit<WorkReportReaderFilterInput, keyof WorkReportActorRef> | null {
  const templateId = parseOptionalUuid(searchParams.get("template_id"));
  const versionId = parseOptionalUuid(searchParams.get("version_id"));
  const from = parseOptionalDate(searchParams.get("from"));
  const to = parseOptionalDate(searchParams.get("to"));
  const teamId = parseOptionalUuid(searchParams.get("team_id"));
  const assigneeId = parseOptionalUuid(searchParams.get("assignee_id"));
  const state = parseOptionalState(searchParams.get("state"));
  const cursor = parseOptionalCursor(searchParams.get("cursor"));
  const limit = parseLimit(searchParams.get("limit"));

  if (
    templateId === undefined ||
    versionId === undefined ||
    from === undefined ||
    to === undefined ||
    teamId === undefined ||
    assigneeId === undefined ||
    state === undefined ||
    cursor === undefined ||
    limit === undefined ||
    (from !== null && to !== null && from > to)
  ) {
    return null;
  }

  return {
    template_id: templateId,
    version_id: versionId,
    from,
    to,
    team_id: teamId,
    assignee_id: assigneeId,
    state,
    cursor,
    limit,
  };
}

async function trustedActor(deps: ReportReaderApiDependencies): Promise<WorkReportActorRef | Response> {
  try {
    const session = await deps.resolveSession();
    if (!session.actor.ok) {
      const unauthenticated = session.actor.reason === "UNAUTHENTICATED";
      return fail(
        unauthenticated ? "UNAUTHENTICATED" : "ACTOR_NOT_AVAILABLE",
        unauthenticated ? 401 : 403,
      );
    }
    const actor = session.actor.actor;
    if (!actor || !UUID.test(actor.auth_subject) || !UUID.test(actor.app_user_id)) {
      return fail("ACTOR_NOT_AVAILABLE", 403);
    }
    return { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id };
  } catch {
    console.error("[work-reports] reader session unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}

function mapErrorOutcome(
  result: Exclude<WorkReportReaderRpcOutcome<unknown>, { ok: true }>,
): Response {
  const mapping = {
    "actor-denied": ["ACTOR_NOT_AVAILABLE", 403],
    "scope-denied": ["WORK_REPORT_SCOPE_DENIED", 403],
    denied: ["WORK_REPORT_ACCESS_DENIED", 403],
    invalid: ["WORK_REPORT_QUERY_INVALID", 400],
    "not-found": ["WORK_REPORT_NOT_FOUND", 404],
    unavailable: ["WORK_REPORT_UNAVAILABLE", 503],
  } as const;
  const [code, status] = mapping[result.kind];
  return fail(code, status);
}

/**
 * GET `/api/work-reports/submissions` handler.
 *
 * Reporting-period filter semantics (`from` / `to`):
 *   Inclusive bounds on `period_start_date` (`YYYY-MM-DD`).
 */
export async function listReadableWorkReportSubmissions(
  request: Request,
  enabled: string | undefined,
  deps: ReportReaderApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);

  const { searchParams } = new URL(request.url);
  if (!validateAllowedParams(searchParams, ALLOWED_QUERY_KEYS)) {
    return fail("WORK_REPORT_QUERY_INVALID", 400);
  }

  const filters = parseQueryFilters(searchParams);
  if (!filters) {
    return fail("WORK_REPORT_QUERY_INVALID", 400);
  }

  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;

  try {
    const result = await deps.repository.listReadable({ ...actor, ...filters });
    if (!result.ok) return mapErrorOutcome(result);
    return respond(
      {
        ok: true,
        effective_scope: result.data.effective_scope,
        filter_options: result.data.filter_options,
        items: result.data.items,
        next_cursor: result.data.next_cursor,
        has_more: result.data.has_more,
        data: result.data,
      },
      200,
    );
  } catch {
    console.error("[work-reports] readable submissions list unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}
