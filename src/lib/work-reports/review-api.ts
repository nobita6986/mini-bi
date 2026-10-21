import { checkSameOriginRequest } from "../ai/gateway/http-guards.mjs";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { validateClientBusinessPayload } from "../auth/direct-entry-v2.ts";
import { readBoundedJson } from "../direct-entry/write-api.ts";
import type { WorkReportActorRef } from "./assignment-repository.ts";
import type {
  WorkReportReviewRepository,
  WorkReportReviewRpcOutcome,
} from "./review-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_LIST_KEYS = new Set(["template_id", "cursor", "page_size"]);
const ALLOWED_DECISION_KEYS = new Set(["decision", "reason", "expected_version", "idempotency_key"]);

export type ReviewApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: WorkReportReviewRepository;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function trustedActor(deps: ReviewApiDependencies): Promise<WorkReportActorRef | Response> {
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
    console.error("[work-reports] review session unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 500);
  }
}

function mapErrorOutcome(result: Exclude<WorkReportReviewRpcOutcome<unknown>, { ok: true }>): Response {
  const mapping = {
    "actor-denied": ["ACTOR_NOT_AVAILABLE", 403],
    "self-review-denied": ["WORK_REPORT_SELF_REVIEW_FORBIDDEN", 403],
    "scope-denied": ["WORK_REPORT_SCOPE_DENIED", 403],
    denied: ["WORK_REPORT_ACCESS_DENIED", 403],
    "reason-required": ["WORK_REPORT_REVIEW_REASON_REQUIRED", 400],
    invalid: ["WORK_REPORT_REVIEW_INVALID", 400],
    "not-found": ["WORK_REPORT_NOT_FOUND", 404],
    conflict: ["WORK_REPORT_VERSION_CONFLICT", 409],
    unavailable: ["WORK_REPORT_UNAVAILABLE", 503],
  } as const;
  const [code, status] = mapping[result.kind];
  return fail(code, status);
}

function validateAllowedParams(searchParams: URLSearchParams, allowed: Set<string>): boolean {
  const seen = new Set<string>();
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export async function listPendingWorkReportReviews(
  request: Request,
  enabled: string | undefined,
  deps: ReviewApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const { searchParams } = new URL(request.url);
  if (!validateAllowedParams(searchParams, ALLOWED_LIST_KEYS)) {
    return fail("WORK_REPORT_QUERY_INVALID", 400);
  }

  const templateIdRaw = searchParams.get("template_id");
  const templateId =
    templateIdRaw === null || templateIdRaw === ""
      ? null
      : UUID.test(templateIdRaw)
        ? templateIdRaw
        : undefined;
  const cursorRaw = searchParams.get("cursor");
  const cursor =
    cursorRaw === null || cursorRaw === ""
      ? null
      : cursorRaw.length <= 256
        ? cursorRaw
        : undefined;
  const pageSizeRaw = searchParams.get("page_size");
  let pageSize: number | undefined = 50;
  if (pageSizeRaw !== null && pageSizeRaw !== "") {
    if (!/^\d+$/.test(pageSizeRaw)) {
      pageSize = undefined;
    } else {
      const parsed = Number(pageSizeRaw);
      pageSize = Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined;
    }
  }

  if (templateId === undefined || cursor === undefined || pageSize === undefined) {
    return fail("WORK_REPORT_QUERY_INVALID", 400);
  }

  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;

  try {
    const result = await deps.repository.listPending({
      ...actor,
      template_id: templateId,
      cursor,
      page_size: pageSize,
    });
    if (!result.ok) return mapErrorOutcome(result);
    return respond(
      {
        ok: true,
        items: result.data.items,
        next_cursor: result.data.next_cursor,
        has_more: result.data.has_more,
        data: result.data,
      },
      200,
    );
  } catch {
    console.error("[work-reports] review inbox unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}

export async function getWorkReportReviewSubmission(
  _request: Request,
  obligationId: string,
  enabled: string | undefined,
  deps: ReviewApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  if (!UUID.test(obligationId)) return fail("WORK_REPORT_QUERY_INVALID", 400);

  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;

  try {
    const result = await deps.repository.getSubmission({
      ...actor,
      obligation_id: obligationId,
    });
    if (!result.ok) return mapErrorOutcome(result);
    return respond({ ok: true, detail: result.data, data: result.data }, 200);
  } catch {
    console.error("[work-reports] review submission detail unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}

export async function decideWorkReportReview(
  request: Request,
  obligationId: string,
  enabled: string | undefined,
  deps: ReviewApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  const csrf = checkSameOriginRequest({
    origin: request.headers.get("origin"),
    host: request.headers.get("host"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
  if (!csrf.ok) return fail("CSRF_REJECTED", 403);
  if (!UUID.test(obligationId)) return fail("WORK_REPORT_REVIEW_INVALID", 400);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }

  const body = await readBoundedJson(request);
  if (!isRecord(body)) return fail("BODY_INVALID", 400);
  try {
    if (!validateClientBusinessPayload(body).ok) {
      return fail("CLIENT_AUTHORITY_FIELD_FORBIDDEN", 400);
    }
  } catch {
    return fail("WORK_REPORT_REVIEW_INVALID", 400);
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_DECISION_KEYS.has(key)) {
      return fail("WORK_REPORT_REVIEW_INVALID", 400);
    }
  }

  const rawDecision = body.decision;
  const decision =
    rawDecision === "APPROVE" || rawDecision === "APPROVED"
      ? "APPROVED"
      : rawDecision === "REJECT" || rawDecision === "REJECTED"
        ? "REJECTED"
        : null;
  if (!decision) {
    return fail("WORK_REPORT_REVIEW_INVALID", 400);
  }

  const rawReason = body.reason;
  if (rawReason !== undefined && rawReason !== null && typeof rawReason !== "string") {
    return fail("WORK_REPORT_REVIEW_INVALID", 400);
  }
  const normalizedReason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (normalizedReason.length > 2000) {
    return fail("WORK_REPORT_REVIEW_INVALID", 400);
  }
  if (decision === "REJECTED" && normalizedReason.length === 0) {
    return fail("WORK_REPORT_REVIEW_REASON_REQUIRED", 400);
  }

  const expectedVersion = body.expected_version;
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) {
    return fail("WORK_REPORT_REVIEW_INVALID", 400);
  }

  const idempotencyKey = body.idempotency_key;
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 1 || idempotencyKey.length > 128) {
    return fail("WORK_REPORT_REVIEW_INVALID", 400);
  }
  const headerKey = request.headers.get("idempotency-key");
  if (headerKey !== null && headerKey !== idempotencyKey) {
    return fail("IDEMPOTENCY_KEY_MISMATCH", 400);
  }

  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;

  try {
    const result = await deps.repository.decide({
      ...actor,
      obligation_id: obligationId,
      decision,
      reason: normalizedReason.length > 0 ? normalizedReason : null,
      expected_version: Number(expectedVersion),
      idempotency_key: idempotencyKey,
    });
    if (!result.ok) return mapErrorOutcome(result);
    return respond({ ok: true, data: result.data, ...result.data }, 200);
  } catch {
    console.error("[work-reports] review decision unavailable");
    return fail("WORK_REPORT_UNAVAILABLE", 503);
  }
}
