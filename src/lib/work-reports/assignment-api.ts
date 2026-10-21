import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import { readBoundedJson } from "../direct-entry/write-api.ts";
import type { AssignmentCreateInput, AssignmentRepository, WorkReportActorRef, WorkReportRpcOutcome } from "./assignment-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const KEY = /^[\w-]{1,128}$/;

export type AssignmentApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: AssignmentRepository;
};

function response(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function fail(code: string, status: number): Response { return response({ ok: false, code }, status); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function actorFromSession(deps: AssignmentApiDependencies): Promise<WorkReportActorRef | Response> {
  try {
    const session = await deps.resolveSession();
    if (!session.actor.ok) return fail(session.actor.reason === "UNAUTHENTICATED" ? "UNAUTHENTICATED" : "ACTOR_NOT_AVAILABLE",
      session.actor.reason === "UNAUTHENTICATED" ? 401 : 403);
    const actor = session.actor.actor;
    if (!actor || !UUID.test(actor.auth_subject) || !UUID.test(actor.app_user_id)) return fail("ACTOR_NOT_AVAILABLE", 403);
    return { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id };
  } catch {
    console.error("[work-reports] assignment session unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 500);
  }
}

function mutationGuard(request: Request): Response | null {
  const origin = checkSameOriginRequest({
    origin: request.headers.get("origin"), host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!origin.ok) return fail("CSRF_REJECTED", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }
  return null;
}

function idempotencyHeaderMatches(request: Request, key: string): boolean {
  const header = request.headers.get("idempotency-key");
  return header === null || header === key;
}

function projectCreate(value: unknown): Omit<AssignmentCreateInput, keyof WorkReportActorRef> | null {
  if (!isRecord(value) || !validateClientBusinessPayload(value).ok) return null;
  const keys = ["template_id", "target_kind", "target_user_id", "target_team_id", "target_user_ids", "frequency",
    "is_mandatory", "due_day_offset", "due_time_local", "exclude_sundays", "effective_from", "effective_to", "idempotency_key"];
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) return null;
  if (typeof value.template_id !== "string" || !UUID.test(value.template_id) ||
      !["USER", "TEAM", "USER_SET"].includes(String(value.target_kind)) ||
      !["DAILY", "WEEKLY", "MONTHLY", "ONCE"].includes(String(value.frequency)) ||
      typeof value.is_mandatory !== "boolean" || !Number.isInteger(value.due_day_offset) ||
      Number(value.due_day_offset) < 0 || Number(value.due_day_offset) > 31 ||
      typeof value.due_time_local !== "string" || !TIME.test(value.due_time_local) ||
      typeof value.exclude_sundays !== "boolean" || !isRealCalendarDate(value.effective_from) ||
      !(value.effective_to === null || isRealCalendarDate(value.effective_to)) ||
      (value.effective_to !== null && String(value.effective_to) < String(value.effective_from)) ||
      typeof value.idempotency_key !== "string" || !KEY.test(value.idempotency_key) ||
      !Array.isArray(value.target_user_ids) || value.target_user_ids.some((id) => typeof id !== "string" || !UUID.test(id))) return null;
  const kind = value.target_kind;
  const targetUser = value.target_user_id;
  const targetTeam = value.target_team_id;
  if (kind === "USER" && (typeof targetUser !== "string" || !UUID.test(targetUser) || targetTeam !== null || value.target_user_ids.length !== 0)) return null;
  if (kind === "TEAM" && (typeof targetTeam !== "string" || !UUID.test(targetTeam) || targetUser !== null || value.target_user_ids.length !== 0)) return null;
  if (kind === "USER_SET" && (targetUser !== null || targetTeam !== null || value.target_user_ids.length < 1 ||
      new Set(value.target_user_ids).size !== value.target_user_ids.length)) return null;
  return value as unknown as Omit<AssignmentCreateInput, keyof WorkReportActorRef>;
}

function mapOutcome<T>(result: WorkReportRpcOutcome<T>): Response {
  if (!result.ok) {
    const codes = { conflict: ["WORK_REPORT_VERSION_CONFLICT", 409], denied: ["WORK_REPORT_ACCESS_DENIED", 403],
      invalid: ["WORK_REPORT_REQUEST_INVALID", 400], "not-found": ["WORK_REPORT_NOT_FOUND", 404],
      unavailable: ["WORK_REPORT_UNAVAILABLE", 503] } as const;
    const [code, status] = codes[result.kind];
    return fail(code, status);
  }
  return response({ ok: true, ...(Array.isArray(result.data) ? { items: result.data } : result.data) }, 200);
}

export async function createWorkReportAssignment(request: Request, enabled: string | undefined,
  deps: AssignmentApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const guard = mutationGuard(request);
  if (guard) return guard;
  const body = await readBoundedJson(request);
  const parsed = projectCreate(body);
  if (!parsed) return fail("WORK_REPORT_ASSIGNMENT_INVALID", 400);
  if (!idempotencyHeaderMatches(request, parsed.idempotency_key)) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try { return mapOutcome(await deps.repository.create({ ...actor, ...parsed })); }
  catch { console.error("[work-reports] assignment create unavailable"); return fail("WORK_REPORT_UNAVAILABLE", 503); }
}

export async function listWorkReportAssignmentOptions(request: Request, enabled: string | undefined,
  deps: AssignmentApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const url = new URL(request.url);
  const teamId = url.searchParams.get("team_id");
  if ([...url.searchParams.keys()].some((key) => key !== "team_id") || url.searchParams.size > 1 ||
      (teamId !== null && !UUID.test(teamId))) return fail("WORK_REPORT_REQUEST_INVALID", 400);
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try {
    return mapOutcome(await deps.repository.listOptions({ ...actor, team_id: teamId }));
  } catch {
    console.error("[work-reports] assignment options unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}

export async function listWorkReportAssignments(request: Request, enabled: string | undefined,
  deps: AssignmentApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const url = new URL(request.url);
  const teamId = url.searchParams.get("team_id");
  if ([...url.searchParams.keys()].some((key) => key !== "team_id") || url.searchParams.size > 1 ||
      (teamId !== null && !UUID.test(teamId))) return fail("WORK_REPORT_REQUEST_INVALID", 400);
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try {
    return mapOutcome(await deps.repository.listAssignments({ ...actor, team_id: teamId }));
  } catch {
    console.error("[work-reports] assignment list unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}

export async function setWorkReportAssignmentState(request: Request, assignmentId: string, enabled: string | undefined,
  deps: AssignmentApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(assignmentId)) return fail("WORK_REPORT_ASSIGNMENT_INVALID", 400);
  const guard = mutationGuard(request);
  if (guard) return guard;
  const body = await readBoundedJson(request);
  if (!isRecord(body) || !validateClientBusinessPayload(body).ok ||
      Object.keys(body).some((key) => !["expected_version", "state", "idempotency_key"].includes(key)) ||
      !Number.isInteger(body.expected_version) || Number(body.expected_version) < 1 ||
      !["ACTIVE", "PAUSED", "REVOKED"].includes(String(body.state)) ||
      typeof body.idempotency_key !== "string" || !KEY.test(body.idempotency_key)) {
    return fail("WORK_REPORT_ASSIGNMENT_INVALID", 400);
  }
  if (!idempotencyHeaderMatches(request, body.idempotency_key)) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try {
    return mapOutcome(await deps.repository.setState({ ...actor, assignment_id: assignmentId,
      expected_version: Number(body.expected_version), state: body.state as "ACTIVE" | "PAUSED" | "REVOKED",
      idempotency_key: body.idempotency_key }));
  } catch { console.error("[work-reports] assignment update unavailable"); return fail("WORK_REPORT_UNAVAILABLE", 503); }
}

export async function changeWorkReportObligation(request: Request, obligationId: string, enabled: string | undefined,
  deps: AssignmentApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(obligationId)) return fail("WORK_REPORT_OBLIGATION_INVALID", 400);
  const guard = mutationGuard(request);
  if (guard) return guard;
  const body = await readBoundedJson(request);
  if (!isRecord(body) || !validateClientBusinessPayload(body).ok ||
      Object.keys(body).some((key) => !["expected_version", "action", "reason", "reopened_until", "idempotency_key"].includes(key)) ||
      !Number.isInteger(body.expected_version) || Number(body.expected_version) < 1 ||
      !["EXEMPT", "REOPEN"].includes(String(body.action)) || typeof body.reason !== "string" ||
      body.reason.trim().length < 1 || body.reason.length > 4000 ||
      !(body.reopened_until === null || (typeof body.reopened_until === "string" && !Number.isNaN(Date.parse(body.reopened_until)))) ||
      (body.action === "EXEMPT" && body.reopened_until !== null) ||
      (body.action === "REOPEN" && body.reopened_until === null) ||
      typeof body.idempotency_key !== "string" || !KEY.test(body.idempotency_key)) {
    return fail("WORK_REPORT_OBLIGATION_INVALID", 400);
  }
  if (!idempotencyHeaderMatches(request, body.idempotency_key)) return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try {
    return mapOutcome(await deps.repository.changeObligation({ ...actor, obligation_id: obligationId,
      expected_version: Number(body.expected_version), action: body.action as "EXEMPT" | "REOPEN",
      reason: body.reason.trim(), reopened_until: body.reopened_until as string | null,
      idempotency_key: body.idempotency_key }));
  } catch { console.error("[work-reports] obligation update unavailable"); return fail("WORK_REPORT_UNAVAILABLE", 503); }
}

export async function materializeWorkReportObligations(request: Request, enabled: string | undefined,
  deps: AssignmentApiDependencies): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const guard = mutationGuard(request);
  if (guard) return guard;
  const body = await readBoundedJson(request);
  if (!isRecord(body) || Object.keys(body).length !== 1 || !isRealCalendarDate(body.business_date)) {
    return fail("WORK_REPORT_REQUEST_INVALID", 400);
  }
  const actor = await actorFromSession(deps);
  if (actor instanceof Response) return actor;
  try { return mapOutcome(await deps.repository.materialize({ ...actor, business_date: body.business_date as string })); }
  catch { console.error("[work-reports] obligation materialization unavailable"); return fail("WORK_REPORT_UNAVAILABLE", 503); }
}
