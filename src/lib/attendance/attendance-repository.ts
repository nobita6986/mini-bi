import "server-only";

import {
  projectCheckInRecord,
  type AttendanceCheckInProjection,
  type AttendanceErrorCode,
  type AttendanceTimeSource,
} from "./attendance-contract.ts";

export type AttendanceRpcCaller = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type LookupAttendanceCheckInInput = {
  auth_subject: string;
  app_user_id: string;
  idempotency_key: string;
  request_fingerprint: string;
};

export type LookupAttendanceCheckInResult =
  | { ok: true; found: false }
  | { ok: true; found: true; checkin: AttendanceCheckInProjection }
  | { ok: false; code: AttendanceErrorCode };

export type RecordAttendanceCheckInInput = {
  auth_subject: string;
  app_user_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  latitude: number;
  longitude: number;
  accuracy_meters: number;
  address_hint: string;
  note: string;
  device_claimed_at: string;
  time_source: AttendanceTimeSource;
  time_anchor_issued_at: string | null;
  elapsed_since_anchor_ms: number | null;
  time_token_digest: string | null;
  photo_storage_key: string;
  photo_sha256: string;
  photo_size_bytes: number;
  photo_mime_type: "image/jpeg";
  received_at: string;
};

export type RecordAttendanceCheckInResult =
  | { ok: true; checkin: AttendanceCheckInProjection }
  | { ok: false; code: AttendanceErrorCode };

export type AttendanceRepository = {
  lookupCheckInIdempotency(
    input: LookupAttendanceCheckInInput,
  ): Promise<LookupAttendanceCheckInResult>;
  recordCheckIn(input: RecordAttendanceCheckInInput): Promise<RecordAttendanceCheckInResult>;
};

const KNOWN_RPC_ERROR_TOKENS: ReadonlyMap<string, AttendanceErrorCode> = new Map([
  ["ACTOR_NOT_AVAILABLE", "ACTOR_NOT_AVAILABLE"],
  ["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_CONFLICT"],
  ["IDEMPOTENCY_KEY_INVALID", "IDEMPOTENCY_KEY_INVALID"],
  ["GPS_COORDINATES_INVALID", "GPS_COORDINATES_INVALID"],
  ["GPS_ACCURACY_INVALID", "GPS_ACCURACY_INVALID"],
  ["CAPTURED_AT_INVALID", "CAPTURED_AT_INVALID"],
  ["CAPTURED_AT_FUTURE", "CAPTURED_AT_FUTURE"],
  ["ATTENDANCE_TIME_TOKEN_INVALID", "ATTENDANCE_TIME_TOKEN_INVALID"],
  ["ATTENDANCE_SYNC_WINDOW_EXPIRED", "ATTENDANCE_SYNC_WINDOW_EXPIRED"],
  ["ATTENDANCE_TIME_ELAPSED_INVALID", "ATTENDANCE_TIME_ELAPSED_INVALID"],
  ["ATTENDANCE_TIME_MISMATCH", "ATTENDANCE_TIME_MISMATCH"],
  ["PHOTO_INVALID", "PHOTO_INVALID"],
  ["ATTENDANCE_REQUEST_INVALID", "ATTENDANCE_REQUEST_INVALID"],
]);

function serviceRoleRpc(): AttendanceRpcCaller {
  const clientPromise = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await clientPromise).rpc(name, args);
}

function classifyRpcError(error: { code?: string; message?: string }): AttendanceErrorCode {
  const trimmedMessage = typeof error.message === "string" ? error.message.trim() : "";
  const exactToken = KNOWN_RPC_ERROR_TOKENS.get(trimmedMessage);
  if (exactToken) {
    return exactToken;
  }

  for (const [token, mapped] of KNOWN_RPC_ERROR_TOKENS.entries()) {
    if (trimmedMessage.includes(token)) {
      return mapped;
    }
  }

  if (error.code === "42501") {
    return "ACTOR_NOT_AVAILABLE";
  }
  if (error.code === "40001") {
    return "IDEMPOTENCY_CONFLICT";
  }
  if (error.code === "22023" || error.code === "23514") {
    return "ATTENDANCE_REQUEST_INVALID";
  }
  return "ATTENDANCE_UNAVAILABLE";
}

export function createServiceAttendanceRepository(
  rpc?: AttendanceRpcCaller,
): AttendanceRepository {
  let resolvedRpc = rpc;

  return {
    async lookupCheckInIdempotency(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_lookup_checkin_idempotency", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });

        if (result.error) {
          return { ok: false, code: classifyRpcError(result.error) };
        }

        const raw = result.data;
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          console.error("[attendance] idempotency lookup RPC returned non-object payload");
          return { ok: false, code: "ATTENDANCE_UNAVAILABLE" };
        }

        const record = raw as Record<string, unknown>;
        if (record.found === false && Object.getOwnPropertyNames(record).length === 1) {
          return { ok: true, found: false };
        }

        if (record.found === true && Object.getOwnPropertyNames(record).length === 2) {
          const projected = projectCheckInRecord(record.checkin);
          if (!projected || projected.replayed !== true) {
            console.error("[attendance] idempotency lookup RPC returned non-canonical projection");
            return { ok: false, code: "ATTENDANCE_UNAVAILABLE" };
          }
          return { ok: true, found: true, checkin: projected };
        }

        console.error("[attendance] idempotency lookup RPC returned unexpected shape");
        return { ok: false, code: "ATTENDANCE_UNAVAILABLE" };
      } catch {
        console.error("[attendance] idempotency lookup RPC call failed");
        return { ok: false, code: "ATTENDANCE_UNAVAILABLE" };
      }
    },

    async recordCheckIn(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_record_checkin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
          p_latitude: input.latitude,
          p_longitude: input.longitude,
          p_accuracy_meters: input.accuracy_meters,
          p_address_hint: input.address_hint,
          p_note: input.note,
          p_device_claimed_at: input.device_claimed_at,
          p_time_source: input.time_source,
          p_time_anchor_issued_at: input.time_anchor_issued_at,
          p_elapsed_since_anchor_ms: input.elapsed_since_anchor_ms,
          p_time_token_digest: input.time_token_digest,
          p_photo_storage_key: input.photo_storage_key,
          p_photo_sha256: input.photo_sha256,
          p_photo_size_bytes: input.photo_size_bytes,
          p_photo_mime_type: input.photo_mime_type,
          p_received_at: input.received_at,
        });

        if (result.error) {
          return { ok: false, code: classifyRpcError(result.error) };
        }

        const projected = projectCheckInRecord(result.data);
        if (!projected) {
          console.error("[attendance] check-in RPC returned non-canonical projection");
          return { ok: false, code: "ATTENDANCE_UNAVAILABLE" };
        }

        return { ok: true, checkin: projected };
      } catch {
        console.error("[attendance] check-in RPC call failed");
        return { ok: false, code: "ATTENDANCE_UNAVAILABLE" };
      }
    },
  };
}
