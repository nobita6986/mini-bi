import "server-only";

import {
  projectAttendanceAdminReport,
  projectSetHqLocationResult,
  type AttendanceAdminReportProjection,
  type AttendanceReportErrorCode,
  type SetAttendanceHqLocationProjection,
} from "./attendance-report-contract.ts";
import type { AttendanceRpcCaller } from "./attendance-repository.ts";
import { isAttendancePhotoObjectKey } from "./r2-attendance-storage.ts";

export type GetAttendanceAdminReportInput = {
  auth_subject: string;
  app_user_id: string;
  from_date: string | null;
  to_date: string | null;
  page: number;
  page_size: number;
  search: string | null;
};

export type GetAttendanceAdminReportResult =
  | { ok: true; report: AttendanceAdminReportProjection }
  | { ok: false; code: AttendanceReportErrorCode };

export type SetAttendanceHqLocationInput = {
  auth_subject: string;
  app_user_id: string;
  latitude: number;
  longitude: number;
  expected_version: number;
  idempotency_key: string;
  request_fingerprint: string;
};

export type SetAttendanceHqLocationResult =
  | { ok: true; result: SetAttendanceHqLocationProjection }
  | { ok: false; code: AttendanceReportErrorCode };

export type GetAttendancePhotoStorageKeyResult =
  | { ok: true; storage_key: string | null }
  | { ok: false; code: AttendanceReportErrorCode };

type AttendanceActorRef = { auth_subject: string; app_user_id: string };

export type AttendanceAdminReportRepository = {
  getAdminReport(
    input: GetAttendanceAdminReportInput,
  ): Promise<GetAttendanceAdminReportResult>;
  setHqLocation(
    input: SetAttendanceHqLocationInput,
  ): Promise<SetAttendanceHqLocationResult>;
  getCheckInPhotoStorageKey(
    input: AttendanceActorRef & { checkin_id: string },
  ): Promise<GetAttendancePhotoStorageKeyResult>;
};

function projectPhotoStorageKey(value: unknown): string | null | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.found === false && Object.keys(record).length === 1) return null;
  if (
    record.found === true &&
    Object.keys(record).length === 2 &&
    isAttendancePhotoObjectKey(record.photo_storage_key)
  ) {
    return record.photo_storage_key;
  }
  return undefined;
}

const KNOWN_REPORT_RPC_TOKENS: ReadonlyMap<string, AttendanceReportErrorCode> = new Map([
  ["ATTENDANCE_ACTOR_DENIED", "ACTOR_NOT_AVAILABLE"],
  ["ATTENDANCE_REPORT_ACCESS_DENIED", "ATTENDANCE_REPORT_ACCESS_DENIED"],
  ["ATTENDANCE_REPORT_RANGE_INVALID", "ATTENDANCE_REPORT_RANGE_INVALID"],
  ["ATTENDANCE_REPORT_PAGINATION_INVALID", "ATTENDANCE_REPORT_PAGINATION_INVALID"],
  ["ATTENDANCE_REPORT_SEARCH_INVALID", "ATTENDANCE_REPORT_SEARCH_INVALID"],
  ["ATTENDANCE_HQ_COORDINATES_INVALID", "ATTENDANCE_HQ_COORDINATES_INVALID"],
  ["ATTENDANCE_HQ_VERSION_CONFLICT", "ATTENDANCE_HQ_VERSION_CONFLICT"],
  ["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_CONFLICT"],
]);

function serviceRoleRpc(): AttendanceRpcCaller {
  const clientPromise = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await clientPromise).rpc(name, args);
}

function classifyReportRpcError(
  error: { code?: string; message?: string },
  mode: "report" | "hq",
): AttendanceReportErrorCode {
  const trimmed = typeof error.message === "string" ? error.message.trim() : "";
  const exact = KNOWN_REPORT_RPC_TOKENS.get(trimmed);
  if (exact) {
    return exact;
  }

  for (const [token, mapped] of KNOWN_REPORT_RPC_TOKENS.entries()) {
    if (trimmed.includes(token)) {
      return mapped;
    }
  }

  if (error.code === "42501") {
    return mode === "hq"
      ? "ATTENDANCE_HQ_MANAGE_DENIED"
      : "ATTENDANCE_REPORT_ACCESS_DENIED";
  }
  if (error.code === "40001") {
    return "ATTENDANCE_HQ_VERSION_CONFLICT";
  }
  if (error.code === "23505") {
    return "IDEMPOTENCY_CONFLICT";
  }
  if (error.code === "22023" || error.code === "23514") {
    return mode === "hq"
      ? "ATTENDANCE_HQ_COORDINATES_INVALID"
      : "ATTENDANCE_REPORT_QUERY_INVALID";
  }

  return "ATTENDANCE_REPORT_UNAVAILABLE";
}

export function createServiceAttendanceAdminReportRepository(
  rpc?: AttendanceRpcCaller,
): AttendanceAdminReportRepository {
  let resolvedRpc = rpc;

  return {
    async getAdminReport(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_admin_report", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_from_date: input.from_date,
          p_to_date: input.to_date,
          p_page: input.page,
          p_page_size: input.page_size,
          p_search: input.search,
        });

        if (result.error) {
          return { ok: false, code: classifyReportRpcError(result.error, "report") };
        }

        const projected = projectAttendanceAdminReport(result.data);
        if (!projected) {
          console.error("[attendance-admin] report RPC returned non-canonical projection");
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, report: projected };
      } catch {
        console.error("[attendance-admin] report RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async setHqLocation(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_set_hq_location", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_latitude: input.latitude,
          p_longitude: input.longitude,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });

        if (result.error) {
          return { ok: false, code: classifyReportRpcError(result.error, "hq") };
        }

        const projected = projectSetHqLocationResult(result.data);
        if (!projected) {
          console.error("[attendance-admin] set HQ RPC returned non-canonical projection");
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, result: projected };
      } catch {
        console.error("[attendance-admin] set HQ RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async getCheckInPhotoStorageKey(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_admin_checkin_photo", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_checkin_id: input.checkin_id,
        });
        if (result.error) {
          return { ok: false, code: classifyReportRpcError(result.error, "report") };
        }
        const storageKey = projectPhotoStorageKey(result.data);
        if (storageKey === undefined) {
          console.error("[attendance-admin] photo RPC returned non-canonical projection");
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }
        return { ok: true, storage_key: storageKey };
      } catch {
        console.error("[attendance-admin] photo RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },
  };
}
