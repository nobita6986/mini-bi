import "server-only";

import { Buffer } from "node:buffer";
import sharp from "sharp";
import type { DirectEntrySessionResult } from "../auth/direct-entry-session-core.ts";
import { isSameOriginAuthRequest } from "../auth/same-origin-auth-request.ts";
import { inspectDocumentContent, sha256Hex } from "../direct-entry/document-r2-contract.ts";
import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MULTIPART_OVERHEAD_BYTES,
} from "../direct-entry/document-upload-contract.ts";
import { failJson, isUuid, noStoreJson } from "../http/direct-entry-api-guard.ts";
import { isAttendanceEnabled, loadAttendanceSigningSecret } from "./attendance-config.ts";
import {
  ATTENDANCE_CLIENT_TIME_SKEW_TOLERANCE_MS,
  ATTENDANCE_FUTURE_TIMESTAMP_TOLERANCE_MS,
  ATTENDANCE_PHOTO_MIME_TYPE,
  attendanceHttpStatusForError,
  computeAttendanceRequestFingerprint,
  parseAttendanceCheckInMetadata,
  type AttendanceErrorCode,
} from "./attendance-contract.ts";
import type { AttendanceRepository } from "./attendance-repository.ts";
import type { AttendanceObjectStorage } from "./r2-attendance-storage.ts";
import { issueAttendanceTimeToken, verifyAttendanceTimeToken } from "./time-token.ts";

const MAX_MULTIPART_BYTES = DOCUMENT_MAX_BYTES + DOCUMENT_MULTIPART_OVERHEAD_BYTES;
const MAX_DECODED_JPEG_PIXELS = 40_000_000;

const DISALLOWED_CLIENT_AUTHORITY_HEADERS = [
  "x-app-user-id",
  "x-actor-id",
  "x-auth-subject",
  "x-user-id",
  "x-client-time",
  "x-captured-at",
] as const;

export type AttendanceTimeApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  now?: () => number;
};

export type AttendanceCheckInApiDependencies = {
  resolveSession(): Promise<DirectEntrySessionResult>;
  repository: AttendanceRepository;
  storage: AttendanceObjectStorage;
  now?: () => number;
};

function attendanceError(code: AttendanceErrorCode): Response {
  return failJson(code, attendanceHttpStatusForError(code));
}

function hasDisallowedAuthorityQueryOrHeaders(request: Request): boolean {
  try {
    const parsedUrl = new URL(request.url);
    if (parsedUrl.search.length > 0) {
      return true;
    }
  } catch {
    return true;
  }

  for (const headerName of DISALLOWED_CLIENT_AUTHORITY_HEADERS) {
    if (request.headers.get(headerName) !== null) {
      return true;
    }
  }
  return false;
}

async function resolveAttendanceActor(
  resolveSession: () => Promise<DirectEntrySessionResult>,
): Promise<
  | { ok: true; actor: { auth_subject: string; app_user_id: string } }
  | { ok: false; response: Response }
> {
  let session: DirectEntrySessionResult;
  try {
    session = await resolveSession();
  } catch {
    console.error("[attendance] session resolution failed");
    return { ok: false, response: attendanceError("ATTENDANCE_UNAVAILABLE") };
  }

  if (!session.actor.ok) {
    return {
      ok: false,
      response:
        session.actor.reason === "UNAUTHENTICATED"
          ? attendanceError("UNAUTHENTICATED")
          : attendanceError("ACTOR_NOT_AVAILABLE"),
    };
  }

  const actor = session.actor.actor;
  if (!actor || !isUuid(actor.auth_subject) || !isUuid(actor.app_user_id)) {
    return { ok: false, response: attendanceError("ACTOR_NOT_AVAILABLE") };
  }

  return {
    ok: true,
    actor: {
      auth_subject: actor.auth_subject.toLowerCase(),
      app_user_id: actor.app_user_id.toLowerCase(),
    },
  };
}

async function readBoundedMultipartBody(
  request: Request,
  limitBytes: number,
): Promise<
  | { ok: true; bytes: Uint8Array }
  | { ok: false; kind: "invalid" | "too-large" }
> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const trimmedLength = declaredLength.trim();
    if (!/^\d+$/.test(trimmedLength)) {
      return { ok: false, kind: "invalid" };
    }
    const parsedLength = Number(trimmedLength);
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
  return { ok: true, bytes: combined };
}

async function verifyRealJpegWithoutReencoding(bytes: Uint8Array): Promise<boolean> {
  const contentInspection = inspectDocumentContent({
    document_type: "WORKER_PORTRAIT",
    mime_type: ATTENDANCE_PHOTO_MIME_TYPE,
    bytes,
  });
  if (!contentInspection.ok) {
    return false;
  }

  try {
    const decoder = sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_DECODED_JPEG_PIXELS,
    });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== "jpeg" ||
      (metadata.pages ?? 1) !== 1 ||
      typeof metadata.width !== "number" ||
      metadata.width < 1 ||
      typeof metadata.height !== "number" ||
      metadata.height < 1
    ) {
      return false;
    }

    const decodedPixels = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_DECODED_JPEG_PIXELS,
    })
      .raw()
      .toBuffer();

    return decodedPixels.byteLength >= 1;
  } catch {
    return false;
  }
}

export async function getAttendanceTime(
  request: Request,
  env: Record<string, string | undefined>,
  dependencies: AttendanceTimeApiDependencies,
): Promise<Response> {
  if (!isAttendanceEnabled(env)) {
    return attendanceError("NOT_FOUND");
  }

  const secretResult = loadAttendanceSigningSecret(env);
  if (!secretResult.ok) {
    return attendanceError("ATTENDANCE_CONFIG_REQUIRED");
  }

  if (hasDisallowedAuthorityQueryOrHeaders(request)) {
    return attendanceError("ATTENDANCE_REQUEST_INVALID");
  }

  const actorResult = await resolveAttendanceActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  try {
    const nowMs = Math.trunc(dependencies.now ? dependencies.now() : Date.now());
    const issued = issueAttendanceTimeToken({
      secret: secretResult.secret,
      app_user_id: actorResult.actor.app_user_id,
      now_ms: nowMs,
    });

    return noStoreJson(
      {
        ok: true,
        server_time: issued.server_time,
        expires_at: issued.expires_at,
        time_token: issued.time_token,
      },
      200,
    );
  } catch {
    console.error("[attendance] failed to issue time anchor token");
    return attendanceError("ATTENDANCE_UNAVAILABLE");
  }
}

export async function postAttendanceCheckIn(
  request: Request,
  env: Record<string, string | undefined>,
  dependencies: AttendanceCheckInApiDependencies,
): Promise<Response> {
  if (!isAttendanceEnabled(env)) {
    return attendanceError("NOT_FOUND");
  }

  const secretResult = loadAttendanceSigningSecret(env);
  if (!secretResult.ok) {
    return attendanceError("ATTENDANCE_CONFIG_REQUIRED");
  }

  if (!isSameOriginAuthRequest(request)) {
    return attendanceError("CSRF_REJECTED");
  }

  if (hasDisallowedAuthorityQueryOrHeaders(request)) {
    return attendanceError("ATTENDANCE_REQUEST_INVALID");
  }

  const contentType = request.headers.get("content-type");
  if (
    !contentType ||
    !contentType.toLowerCase().startsWith("multipart/form-data;") ||
    !contentType.toLowerCase().includes("boundary=")
  ) {
    return attendanceError("CONTENT_TYPE_INVALID");
  }

  const rawIdempotencyHeader = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!isUuid(rawIdempotencyHeader)) {
    return attendanceError("IDEMPOTENCY_KEY_INVALID");
  }

  const actorResult = await resolveAttendanceActor(dependencies.resolveSession);
  if (!actorResult.ok) {
    return actorResult.response;
  }

  if (!dependencies.storage.available()) {
    return attendanceError("ATTENDANCE_UNAVAILABLE");
  }

  const boundedBody = await readBoundedMultipartBody(request, MAX_MULTIPART_BYTES);
  if (!boundedBody.ok) {
    return boundedBody.kind === "too-large"
      ? attendanceError("BODY_TOO_LARGE")
      : attendanceError("ATTENDANCE_REQUEST_INVALID");
  }

  let form: FormData;
  try {
    const multipartRequest = new Request(request.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: Buffer.from(boundedBody.bytes),
    });
    form = await multipartRequest.formData();
  } catch {
    return attendanceError("ATTENDANCE_REQUEST_INVALID");
  }

  const entries = [...form.entries()];
  if (entries.length !== 2) {
    return attendanceError("ATTENDANCE_REQUEST_INVALID");
  }

  let rawMetadataValue: string | null = null;
  let photoFile: File | null = null;

  for (const [partName, partValue] of entries) {
    if (partName === "metadata" && rawMetadataValue === null && typeof partValue === "string") {
      rawMetadataValue = partValue;
    } else if (partName === "photo" && photoFile === null && partValue instanceof File) {
      photoFile = partValue;
    } else {
      return attendanceError("ATTENDANCE_REQUEST_INVALID");
    }
  }

  if (rawMetadataValue === null || photoFile === null) {
    return attendanceError("ATTENDANCE_REQUEST_INVALID");
  }

  const parsedMetadata = parseAttendanceCheckInMetadata({
    raw_metadata_json: rawMetadataValue,
    header_idempotency_key: rawIdempotencyHeader,
  });
  if (!parsedMetadata.ok) {
    return attendanceError(parsedMetadata.code);
  }

  const meta = parsedMetadata.data;
  const nowMs = Math.trunc(dependencies.now ? dependencies.now() : Date.now());

  let timeAnchorIssuedAtIso: string | null = null;
  let elapsedSinceAnchorMs: number | null = null;
  let timeTokenDigest: string | null = null;

  if (meta.time_source === "SERVER_ANCHORED") {
    const verifiedToken = verifyAttendanceTimeToken({
      secret: secretResult.secret,
      token: meta.time_token,
      expected_app_user_id: actorResult.actor.app_user_id,
      now_ms: nowMs,
    });
    if (!verifiedToken.ok) {
      return attendanceError(verifiedToken.code);
    }

    const serverComputedCapturedAtMs = verifiedToken.issued_at_ms + meta.elapsed_since_anchor_ms;
    if (
      Math.abs(meta.device_claimed_at_ms - serverComputedCapturedAtMs) >
      ATTENDANCE_CLIENT_TIME_SKEW_TOLERANCE_MS
    ) {
      return attendanceError("ATTENDANCE_TIME_MISMATCH");
    }

    if (
      serverComputedCapturedAtMs > nowMs + ATTENDANCE_FUTURE_TIMESTAMP_TOLERANCE_MS ||
      meta.device_claimed_at_ms > nowMs + ATTENDANCE_FUTURE_TIMESTAMP_TOLERANCE_MS
    ) {
      return attendanceError("CAPTURED_AT_FUTURE");
    }

    timeAnchorIssuedAtIso = verifiedToken.issued_at_iso;
    elapsedSinceAnchorMs = meta.elapsed_since_anchor_ms;
    timeTokenDigest = verifiedToken.token_digest;
  } else {
    if (meta.device_claimed_at_ms > nowMs + ATTENDANCE_FUTURE_TIMESTAMP_TOLERANCE_MS) {
      return attendanceError("CAPTURED_AT_FUTURE");
    }
  }

  if (photoFile.size > DOCUMENT_MAX_BYTES) {
    return attendanceError("BODY_TOO_LARGE");
  }
  if (photoFile.size < 1) {
    return attendanceError("PHOTO_INVALID");
  }

  const normalizedPartMime = photoFile.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalizedPartMime !== ATTENDANCE_PHOTO_MIME_TYPE) {
    return attendanceError("PHOTO_INVALID");
  }

  let photoBytes: Uint8Array;
  try {
    photoBytes = new Uint8Array(await photoFile.arrayBuffer());
  } catch {
    return attendanceError("PHOTO_INVALID");
  }

  if (photoBytes.byteLength > DOCUMENT_MAX_BYTES) {
    return attendanceError("BODY_TOO_LARGE");
  }
  if (photoBytes.byteLength < 1) {
    return attendanceError("PHOTO_INVALID");
  }

  const isRealJpeg = await verifyRealJpegWithoutReencoding(photoBytes);
  if (!isRealJpeg) {
    return attendanceError("PHOTO_INVALID");
  }

  const computedPhotoSha256 = sha256Hex(photoBytes);
  if (computedPhotoSha256 !== meta.photo_sha256) {
    return attendanceError("PHOTO_HASH_MISMATCH");
  }

  const requestFingerprint = computeAttendanceRequestFingerprint({
    app_user_id: actorResult.actor.app_user_id,
    latitude: meta.latitude,
    longitude: meta.longitude,
    accuracy_meters: meta.accuracy_meters,
    address_hint: meta.address_hint,
    note: meta.note,
    device_claimed_at_ms: meta.device_claimed_at_ms,
    time_source: meta.time_source,
    time_token_digest: timeTokenDigest,
    elapsed_since_anchor_ms: elapsedSinceAnchorMs,
    photo_sha256: computedPhotoSha256,
    photo_size_bytes: photoBytes.byteLength,
    photo_mime_type: ATTENDANCE_PHOTO_MIME_TYPE,
  });

  let ensuredPhoto: Awaited<ReturnType<AttendanceObjectStorage["ensureCheckInPhoto"]>>;
  try {
    ensuredPhoto = await dependencies.storage.ensureCheckInPhoto({
      app_user_id: actorResult.actor.app_user_id,
      idempotency_key: meta.idempotency_key,
      photo_sha256: computedPhotoSha256,
      bytes: photoBytes,
    });
  } catch {
    console.error("[attendance] R2 photo write failed");
    return attendanceError("ATTENDANCE_UNAVAILABLE");
  }

  if (!ensuredPhoto.ok) {
    return attendanceError("IDEMPOTENCY_CONFLICT");
  }

  let recorded: Awaited<ReturnType<AttendanceRepository["recordCheckIn"]>>;
  try {
    recorded = await dependencies.repository.recordCheckIn({
      auth_subject: actorResult.actor.auth_subject,
      app_user_id: actorResult.actor.app_user_id,
      idempotency_key: meta.idempotency_key,
      request_fingerprint: requestFingerprint,
      latitude: meta.latitude,
      longitude: meta.longitude,
      accuracy_meters: meta.accuracy_meters,
      address_hint: meta.address_hint,
      note: meta.note,
      device_claimed_at: meta.device_claimed_at_iso,
      time_source: meta.time_source,
      time_anchor_issued_at: timeAnchorIssuedAtIso,
      elapsed_since_anchor_ms: elapsedSinceAnchorMs,
      time_token_digest: timeTokenDigest,
      photo_storage_key: ensuredPhoto.storage_key,
      photo_sha256: computedPhotoSha256,
      photo_size_bytes: photoBytes.byteLength,
      photo_mime_type: ATTENDANCE_PHOTO_MIME_TYPE,
    });
  } catch {
    if (ensuredPhoto.created_now) {
      try {
        await dependencies.storage.deleteNewlyCreatedCheckInPhoto(ensuredPhoto.storage_key);
      } catch {
        console.error("[attendance] failed to clean up newly uploaded photo after RPC exception");
      }
    }
    return attendanceError("ATTENDANCE_UNAVAILABLE");
  }

  if (!recorded.ok) {
    // Delete R2 object ONLY when this request newly created it AND the failure is NOT an
    // IDEMPOTENCY_CONFLICT (which implies a committed DB record already owns the deterministic key).
    if (ensuredPhoto.created_now && recorded.code !== "IDEMPOTENCY_CONFLICT") {
      try {
        await dependencies.storage.deleteNewlyCreatedCheckInPhoto(ensuredPhoto.storage_key);
      } catch {
        console.error("[attendance] failed to clean up newly uploaded photo after DB failure");
      }
    }
    return attendanceError(recorded.code);
  }

  return noStoreJson(
    {
      ok: true,
      checkin: recorded.checkin,
    },
    recorded.checkin.replayed ? 200 : 201,
  );
}
