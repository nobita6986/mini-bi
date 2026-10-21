import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import type { WorkReportActorRef } from "./assignment-repository.ts";
import type {
  AnalyticsRepository,
  WorkReportAnalyticsBreakdownInput,
  WorkReportAnalyticsContributionsInput,
  WorkReportAnalyticsFilterInput,
  WorkReportAnalyticsGroupBy,
  WorkReportAnalyticsRpcOutcome,
} from "./analytics-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[a-z][a-z0-9_]{1,63}$/;
const PERIOD_KEY = /^[A-Za-z0-9-]{7,32}$/;
const KEYSET_CURSOR =
  /^(null|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))\|(\d{4}-\d{2}-\d{2})\|([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const OVERVIEW_KEYS = new Set([
  "template_id",
  "version_id",
  "from",
  "to",
  "team_id",
  "assignee_id",
  "finality",
]);

const BREAKDOWN_KEYS = new Set([
  ...OVERVIEW_KEYS,
  "group_by",
  "page",
  "page_size",
]);

const CONTRIBUTIONS_KEYS = new Set([
  "template_id",
  "version_id",
  "from",
  "to",
  "team_id",
  "assignee_id",
  "finality",
  "metric_key",
  "compatible_group",
  "target_team_id",
  "target_assignee_id",
  "target_period_key",
  "cursor",
  "limit",
]);

export type AnalyticsApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: AnalyticsRepository;
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

async function trustedActor(deps: AnalyticsApiDependencies): Promise<WorkReportActorRef | Response> {
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
    console.error("[work-reports] analytics session unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 500);
  }
}

function mapOutcome<T>(result: WorkReportAnalyticsRpcOutcome<T>): Response {
  if (!result.ok) {
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
  return respond({ ok: true, data: result.data }, 200);
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

function parseOptionalCursor(value: string | null): string | null | undefined {
  if (value === null || value === "") return null;
  const match = KEYSET_CURSOR.exec(value);
  if (!match) return undefined;
  const [, tsPart, periodStartDate] = match;
  if (!isRealCalendarDate(periodStartDate)) return undefined;
  if (tsPart !== "null" && Number.isNaN(Date.parse(tsPart))) return undefined;
  return value;
}

function parsePositiveInt(value: string | null, defaultValue: number, min: number, max: number): number | undefined {
  if (value === null || value === "") return defaultValue;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function parseBaseFilters(
  searchParams: URLSearchParams,
): Omit<WorkReportAnalyticsFilterInput, keyof WorkReportActorRef> | null {
  const templateId = searchParams.get("template_id");
  if (!templateId || !UUID.test(templateId)) return null;

  const versionId = parseOptionalUuid(searchParams.get("version_id"));
  const teamId = parseOptionalUuid(searchParams.get("team_id"));
  const assigneeId = parseOptionalUuid(searchParams.get("assignee_id"));
  const from = parseOptionalDate(searchParams.get("from"));
  const to = parseOptionalDate(searchParams.get("to"));
  const finalityRaw = searchParams.get("finality") ?? "final";

  if (
    versionId === undefined ||
    teamId === undefined ||
    assigneeId === undefined ||
    from === undefined ||
    to === undefined ||
    (finalityRaw !== "final" && finalityRaw !== "provisional_included") ||
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
    finality: finalityRaw,
  };
}

export async function getWorkReportAnalyticsOverview(
  request: Request,
  enabled: string | undefined,
  deps: AnalyticsApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const { searchParams } = new URL(request.url);
  if (!validateAllowedParams(searchParams, OVERVIEW_KEYS)) {
    return fail("WORK_REPORT_QUERY_INVALID", 400);
  }
  const filters = parseBaseFilters(searchParams);
  if (!filters) return fail("WORK_REPORT_QUERY_INVALID", 400);

  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;

  try {
    return mapOutcome(await deps.repository.overview({ ...actor, ...filters }));
  } catch {
    console.error("[work-reports] analytics overview unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}

export async function getWorkReportAnalyticsBreakdown(
  request: Request,
  enabled: string | undefined,
  deps: AnalyticsApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const { searchParams } = new URL(request.url);
  if (!validateAllowedParams(searchParams, BREAKDOWN_KEYS)) {
    return fail("WORK_REPORT_QUERY_INVALID", 400);
  }
  const filters = parseBaseFilters(searchParams);
  const groupByRaw = searchParams.get("group_by") ?? "team";
  const page = parsePositiveInt(searchParams.get("page"), 1, 1, 1000);
  const pageSize = parsePositiveInt(searchParams.get("page_size"), 50, 1, 100);

  if (
    !filters ||
    !["team", "assignee", "period"].includes(groupByRaw) ||
    page === undefined ||
    pageSize === undefined
  ) {
    return fail("WORK_REPORT_QUERY_INVALID", 400);
  }

  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;

  const input: WorkReportAnalyticsBreakdownInput = {
    ...actor,
    ...filters,
    group_by: groupByRaw as WorkReportAnalyticsGroupBy,
    page,
    page_size: pageSize,
  };

  try {
    return mapOutcome(await deps.repository.breakdown(input));
  } catch {
    console.error("[work-reports] analytics breakdown unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}

export async function getWorkReportAnalyticsContributions(
  request: Request,
  enabled: string | undefined,
  deps: AnalyticsApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const { searchParams } = new URL(request.url);
  if (!validateAllowedParams(searchParams, CONTRIBUTIONS_KEYS)) {
    return fail("WORK_REPORT_QUERY_INVALID", 400);
  }
  const filters = parseBaseFilters(searchParams);
  const metricKeyRaw = searchParams.get("metric_key");
  const compatibleGroupRaw = searchParams.get("compatible_group");
  const targetTeamId = parseOptionalUuid(searchParams.get("target_team_id"));
  const targetAssigneeId = parseOptionalUuid(searchParams.get("target_assignee_id"));
  const targetPeriodKeyRaw = searchParams.get("target_period_key");
  const cursor = parseOptionalCursor(searchParams.get("cursor"));
  const limit = parsePositiveInt(searchParams.get("limit"), 100, 1, 200);

  const metricKey = metricKeyRaw === null || metricKeyRaw === "" ? null : IDENTIFIER.test(metricKeyRaw) ? metricKeyRaw : undefined;
  const compatibleGroup =
    compatibleGroupRaw === null || compatibleGroupRaw === "" ? null : IDENTIFIER.test(compatibleGroupRaw) ? compatibleGroupRaw : undefined;
  const targetPeriodKey =
    targetPeriodKeyRaw === null || targetPeriodKeyRaw === "" ? null : PERIOD_KEY.test(targetPeriodKeyRaw) ? targetPeriodKeyRaw : undefined;

  if (
    !filters ||
    metricKey === undefined ||
    compatibleGroup === undefined ||
    targetTeamId === undefined ||
    targetAssigneeId === undefined ||
    targetPeriodKey === undefined ||
    cursor === undefined ||
    limit === undefined
  ) {
    return fail("WORK_REPORT_QUERY_INVALID", 400);
  }

  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;

  const input: WorkReportAnalyticsContributionsInput = {
    ...actor,
    ...filters,
    metric_key: metricKey,
    compatible_group: compatibleGroup,
    target_team_id: targetTeamId,
    target_assignee_id: targetAssigneeId,
    target_period_key: targetPeriodKey,
    cursor,
    limit,
  };

  try {
    return mapOutcome(await deps.repository.contributions(input));
  } catch {
    console.error("[work-reports] analytics contributions unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}
