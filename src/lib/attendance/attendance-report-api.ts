import "server-only";

import { createHash } from "node:crypto";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isSameOriginAuthRequest } from "../auth/same-origin-auth-request.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import {
  adminAuthorityNavPredicate,
  attendanceReportNavPredicate,
  type NavActorProjection,
} from "../navigation/registry-capability.ts";
import {
  attendanceReportHttpStatusForError,
  parseAttendanceReportQuery,
  parseSetHqLocationBody,
  type AttendanceReportErrorCode,
} from "./attendance-report-contract.ts";
import type { AttendanceAdminReportRepository } from "./attendance-report-repository.ts";

const MAX_HQ_JSON_BODY_BYTES = 8_192;

const DISALLOWED_AUTHORITY_HEADERS = [
  "x-app-user-id",
  "x-actor-id",
  "x-auth-subject",
  "x-user-id",
  "x-capabilities",
  "x-scope",
] as const;

export type AttendanceAdminReportApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: AttendanceAdminReportRepository;
};

function reportError(code: AttendanceReportErrorCode): Response {
  return failJson(code, attendanceReportHttpStatusForError(code));
}

function hasDisallowedAuthorityHeaders(request: Request): boolean {
  for (const headerName of DISALLOWED_AUTHORITY_HEADERS) {
    if (request.headers.get(headerName) !== null) {
      return true;
    }
  }
  return false;
}

async function resolveVerifiedActor(
  resolveSession: () => Promise<DirectEntrySessionResult>,
): Promise<
  | {
      ok: true;
      auth_subject: string;
      app_user_id: string;
      nav_actor: NavActorProjection;
    }
  | { ok: false; response: Response }
> {
  let session: DirectEntrySessionResult;
  try {
    session = await resolveSession();
  } catch {
    console.error("[attendance-admin] session resolution failed");
    return { ok: false, response: reportError("ATTENDANCE_REPORT_UNAVAILABLE") };
  }

  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? reportError("UNAUTHENTICATED")
          : reportError("ACTOR_NOT_AVAILABLE"),
    };
  }

  const actor = session.actor.actor;
  if (!actor || !isUuid(actor.auth_subject) || !isUuid(actor.app_user_id)) {
    return { ok: false, response: reportError("ACTOR_NOT_AVAILABLE") };
  }

  return {
    ok: true,
    auth_subject: actor.auth_subject.toLowerCase(),
    app_user_id: actor.app_user_id.toLowerCase(),
    nav_actor: {
      capabilities: actor.capabilities,
      scopes: actor.scopes.map((scope) => ({ kind: scope.kind })),
    },
  };
}

async function readBoundedJsonBody(
  request: Request,
  limitBytes: number,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; kind: "invalid" | "too-large" }
> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const trimmed = declaredLength.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, kind: "invalid" };
    }
    const parsedLength = Number(trimmed);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return { ok: false, kind: "invalid" };
    }
    if (parsedLength > limitBytes) {
      return { ok: false, kind: "too-large" };
    }
  }

  if (!request.body) {
    return { ok: false, kind: "invalid" };
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
        return { ok: false, kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, kind: "invalid" };
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    return { ok: false, kind: "invalid" };
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
    return { ok: false, kind: "invalid" };
  }
}

export function computeHqLocationRequestFingerprint(input: {
  app_user_id: string;
  expected_version: number;
  latitude: number;
  longitude: number;
}): string {
  const canonicalPayload = JSON.stringify({
    v: 1,
    app_user_id: input.app_user_id.toLowerCase(),
    expected_version: input.expected_version,
    latitude: Object.is(input.latitude, -0) ? 0 : input.latitude,
    longitude: Object.is(input.longitude, -0) ? 0 : input.longitude,
  });
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

export async function getAttendanceAdminReport(
  request: Request,
  dependencies: AttendanceAdminReportApiDependencies,
): Promise<Response> {
  if (hasDisallowedAuthorityHeaders(request)) {
    return reportError("ATTENDANCE_REPORT_QUERY_INVALID");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return reportError("ATTENDANCE_REPORT_QUERY_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!attendanceReportNavPredicate(actorResult.nav_actor)) {
    return reportError("ATTENDANCE_REPORT_ACCESS_DENIED");
  }

  const parsedQuery = parseAttendanceReportQuery(parsedUrl);
  if (!parsedQuery.ok) {
    return reportError(parsedQuery.code);
  }

  const result = await dependencies.repository.getAdminReport({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    from_date: parsedQuery.value.from_date,
    to_date: parsedQuery.value.to_date,
    page: parsedQuery.value.page,
    page_size: parsedQuery.value.page_size,
    search: parsedQuery.value.search,
  });

  if (!result.ok) {
    return reportError(result.code);
  }

  return noStoreJson(
    {
      ok: true,
      report: result.report,
    },
    200,
  );
}

export async function putAttendanceHqLocation(
  request: Request,
  dependencies: AttendanceAdminReportApiDependencies,
): Promise<Response> {
  if (!isSameOriginAuthRequest(request)) {
    return reportError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityHeaders(request)) {
    return reportError("ATTENDANCE_HQ_COORDINATES_INVALID");
  }

  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0) {
      return reportError("ATTENDANCE_HQ_COORDINATES_INVALID");
    }
  } catch {
    return reportError("ATTENDANCE_HQ_COORDINATES_INVALID");
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return reportError("CONTENT_TYPE_INVALID");
  }

  const actorResult = await resolveVerifiedActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!adminAuthorityNavPredicate(actorResult.nav_actor)) {
    return reportError("ATTENDANCE_HQ_MANAGE_DENIED");
  }

  const boundedBody = await readBoundedJsonBody(request, MAX_HQ_JSON_BODY_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? reportError("BODY_TOO_LARGE")
      : reportError("ATTENDANCE_HQ_COORDINATES_INVALID");
  }

  const parsedBody = parseSetHqLocationBody(
    boundedBody.value,
    request.headers.get("idempotency-key"),
  );
  if (!parsedBody.ok) {
    return reportError(parsedBody.code);
  }

  const requestFingerprint = computeHqLocationRequestFingerprint({
    app_user_id: actorResult.app_user_id,
    expected_version: parsedBody.value.expected_version,
    latitude: parsedBody.value.latitude,
    longitude: parsedBody.value.longitude,
  });

  const saved = await dependencies.repository.setHqLocation({
    auth_subject: actorResult.auth_subject,
    app_user_id: actorResult.app_user_id,
    latitude: parsedBody.value.latitude,
    longitude: parsedBody.value.longitude,
    expected_version: parsedBody.value.expected_version,
    idempotency_key: parsedBody.value.idempotency_key,
    request_fingerprint: requestFingerprint,
  });

  if (!saved.ok) {
    return reportError(saved.code);
  }

  return noStoreJson(
    {
      ok: true,
      replayed: saved.result.replayed,
      hq: saved.result.hq,
    },
    saved.result.replayed ? 200 : 201,
  );
}
