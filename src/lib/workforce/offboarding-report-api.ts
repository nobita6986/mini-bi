import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isSameOriginAuthRequest } from "../auth/same-origin-auth-request.ts";
import { buildOffboardingExcel } from "./offboarding-export.ts";
import { parseOffboardingHideRequest } from "./offboarding-report-contract.ts";
import type {
  OffboardingHideFailureKind,
  OffboardingReportRepository,
} from "./offboarding-report-repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_HIDE_JSON_BODY_BYTES = 8_192;

const DISALLOWED_AUTHORITY_HEADERS = [
  "x-app-user-id",
  "x-actor-id",
  "x-auth-subject",
  "x-user-id",
  "x-capabilities",
  "x-scope",
] as const;

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

function hasDisallowedAuthorityHeaders(request: Request): boolean {
  return DISALLOWED_AUTHORITY_HEADERS.some((header) => request.headers.get(header) !== null);
}

async function readBoundedJsonBody(
  request: Request,
  limitBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; code: "BODY_TOO_LARGE" | "BODY_INVALID" }> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const trimmed = declaredLength.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, code: "BODY_INVALID" };
    }
    const parsedLength = Number(trimmed);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return { ok: false, code: "BODY_INVALID" };
    }
    if (parsedLength > limitBytes) {
      return { ok: false, code: "BODY_TOO_LARGE" };
    }
  }

  if (!request.body) {
    return { ok: false, code: "BODY_INVALID" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limitBytes) {
        await reader.cancel();
        return { ok: false, code: "BODY_TOO_LARGE" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: "BODY_INVALID" };
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    return { ok: false, code: "BODY_INVALID" };
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const rawText = new TextDecoder("utf-8", { fatal: true }).decode(combined);
    return { ok: true, value: JSON.parse(rawText) as unknown };
  } catch {
    return { ok: false, code: "BODY_INVALID" };
  }
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
    return {
      auth_subject: actor.auth_subject.toLowerCase(),
      app_user_id: actor.app_user_id.toLowerCase(),
    };
  } catch {
    return fail("WORKFORCE_OFFBOARDING_UNAVAILABLE", 503);
  }
}

function errorResponse(kind: "denied" | "invalid" | "unavailable"): Response {
  if (kind === "denied") return fail("WORKFORCE_OFFBOARDING_DENIED", 403);
  if (kind === "invalid") return fail("WORKFORCE_OFFBOARDING_INVALID", 400);
  return fail("WORKFORCE_OFFBOARDING_UNAVAILABLE", 503);
}

function hideErrorResponse(kind: OffboardingHideFailureKind): Response {
  if (kind === "denied") return fail("WORKFORCE_OFFBOARDING_HIDE_DENIED", 403);
  if (kind === "invalid") return fail("WORKFORCE_OFFBOARDING_HIDE_INVALID", 400);
  if (kind === "stale") return fail("WORKFORCE_OFFBOARDING_SNAPSHOT_STALE", 409);
  if (kind === "idempotency_conflict") return fail("IDEMPOTENCY_CONFLICT", 409);
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
  if (hasDisallowedAuthorityHeaders(request)) return fail("WORKFORCE_OFFBOARDING_INVALID", 400);
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
  if (hasDisallowedAuthorityHeaders(request)) return fail("WORKFORCE_OFFBOARDING_INVALID", 400);
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

export async function hideOffboardingWorker(
  request: Request,
  enabled: string | undefined,
  deps: OffboardingReportApiDependencies,
): Promise<Response> {
  if (enabled !== "true") return fail("NOT_FOUND", 404);
  if (!isSameOriginAuthRequest(request)) return fail("CSRF_REJECTED", 403);
  if (hasDisallowedAuthorityHeaders(request)) {
    return fail("WORKFORCE_OFFBOARDING_HIDE_INVALID", 400);
  }

  try {
    if (new URL(request.url).search.length > 0) {
      return fail("WORKFORCE_OFFBOARDING_HIDE_INVALID", 400);
    }
  } catch {
    return fail("WORKFORCE_OFFBOARDING_HIDE_INVALID", 400);
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return fail("CONTENT_TYPE_INVALID", 400);
  }

  const actor = await trustedActor(deps);
  if (actor instanceof Response) return actor;

  const boundedBody = await readBoundedJsonBody(request, MAX_HIDE_JSON_BODY_BYTES);
  if (!boundedBody.ok) {
    return fail(boundedBody.code, 400);
  }

  const parsed = parseOffboardingHideRequest(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsed) {
    return fail("WORKFORCE_OFFBOARDING_HIDE_INVALID", 400);
  }

  try {
    const result = await deps.repository.hideSnapshot({ ...actor, ...parsed });
    if (!result.ok) return hideErrorResponse(result.kind);
    return respond({ ok: true, data: result.data }, result.data.replayed ? 200 : 201);
  } catch {
    return fail("WORKFORCE_OFFBOARDING_UNAVAILABLE", 503);
  }
}
