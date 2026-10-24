import "server-only";

import type { AttendanceRpcCaller } from "./attendance-repository.ts";
import {
  isValidIsoCalendarDate,
  type AttendanceReportErrorCode,
} from "./attendance-report-contract.ts";
import { isAttendancePhotoObjectKey } from "./r2-attendance-storage.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ITEM_KEYS = [
  "checkin_id", "employee_display_name", "business_date", "sequence_in_day", "captured_at",
  "received_at", "time_source", "latitude", "longitude", "accuracy_meters", "address_hint", "note",
] as const;

type ActorRef = { auth_subject: string; app_user_id: string };

export type AttendanceSelfHistoryQuery = {
  from_date: string;
  to_date: string;
  page: number;
  page_size: number;
};

export type AttendanceSelfHistoryItem = {
  checkin_id: string;
  employee_display_name: string;
  business_date: string;
  sequence_in_day: number;
  captured_at: string;
  received_at: string;
  time_source: "SERVER_ANCHORED" | "DEVICE_CLOCK_UNVERIFIED";
  latitude: number | null;
  longitude: number | null;
  accuracy_meters: number | null;
  address_hint: string;
  note: string;
};

export type AttendanceSelfHistoryPage = {
  items: AttendanceSelfHistoryItem[];
  pagination: {
    page: number;
    page_size: number;
    total_rows: number;
    total_pages: number;
    has_more: boolean;
  };
};

export type AttendanceSelfHistoryResult =
  | { ok: true; page: AttendanceSelfHistoryPage }
  | { ok: false; code: AttendanceReportErrorCode };

export type AttendanceSelfPhotoResult =
  | { ok: true; storage_key: string | null }
  | { ok: false; code: AttendanceReportErrorCode };

export type AttendanceSelfHistoryRepository = {
  getSelfHistory(input: ActorRef & AttendanceSelfHistoryQuery): Promise<AttendanceSelfHistoryResult>;
  getSelfCheckInPhotoStorageKey(input: ActorRef & { checkin_id: string }): Promise<AttendanceSelfPhotoResult>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function projectItem(value: unknown): AttendanceSelfHistoryItem | null {
  if (!isRecord(value) || !hasExactKeys(value, ITEM_KEYS) ||
      typeof value.checkin_id !== "string" || !UUID.test(value.checkin_id) ||
      typeof value.employee_display_name !== "string" || value.employee_display_name.trim() === "" ||
      typeof value.business_date !== "string" || !isValidIsoCalendarDate(value.business_date) ||
      typeof value.sequence_in_day !== "number" || !Number.isSafeInteger(value.sequence_in_day) || value.sequence_in_day < 1 ||
      typeof value.captured_at !== "string" || value.captured_at === "" ||
      typeof value.received_at !== "string" || value.received_at === "" ||
      (value.time_source !== "SERVER_ANCHORED" && value.time_source !== "DEVICE_CLOCK_UNVERIFIED") ||
      typeof value.address_hint !== "string" || typeof value.note !== "string") return null;

  for (const key of ["latitude", "longitude", "accuracy_meters"] as const) {
    const number = value[key];
    if (number !== null && (typeof number !== "number" || !Number.isFinite(number))) return null;
  }
  if (value.latitude !== null && (Number(value.latitude) < -90 || Number(value.latitude) > 90)) return null;
  if (value.longitude !== null && (Number(value.longitude) < -180 || Number(value.longitude) > 180)) return null;
  if (value.accuracy_meters !== null && (Number(value.accuracy_meters) < 0 || Number(value.accuracy_meters) > 100_000)) return null;

  return value as AttendanceSelfHistoryItem;
}

function projectPage(value: unknown, query: AttendanceSelfHistoryQuery): AttendanceSelfHistoryPage | null {
  if (!isRecord(value) || !hasExactKeys(value, ["items", "pagination"]) || !Array.isArray(value.items) ||
      !isRecord(value.pagination) || !hasExactKeys(value.pagination, ["page", "page_size", "total_rows", "total_pages", "has_more"])) return null;
  const pagination = value.pagination;
  if (pagination.page !== query.page || pagination.page_size !== query.page_size ||
      typeof pagination.total_rows !== "number" || !Number.isSafeInteger(pagination.total_rows) || pagination.total_rows < 0 ||
      typeof pagination.total_pages !== "number" || !Number.isSafeInteger(pagination.total_pages) || pagination.total_pages < 1 ||
      typeof pagination.has_more !== "boolean") return null;
  const items = value.items.map(projectItem);
  if (items.some((item) => item === null) || items.length > query.page_size) return null;
  return { items: items as AttendanceSelfHistoryItem[], pagination: pagination as AttendanceSelfHistoryPage["pagination"] };
}

function projectStorageKey(value: unknown): string | null | undefined {
  if (!isRecord(value)) return undefined;
  if (value.found === false && Object.keys(value).length === 1) return null;
  if (value.found === true && Object.keys(value).length === 2 && isAttendancePhotoObjectKey(value.photo_storage_key)) {
    return value.photo_storage_key;
  }
  return undefined;
}

function classify(error: { code?: string; message?: string }): AttendanceReportErrorCode {
  const message = typeof error.message === "string" ? error.message.trim() : "";
  const known = new Map<string, AttendanceReportErrorCode>([
    ["ATTENDANCE_ACTOR_DENIED", "ACTOR_NOT_AVAILABLE"],
    ["ATTENDANCE_REPORT_RANGE_INVALID", "ATTENDANCE_REPORT_RANGE_INVALID"],
    ["ATTENDANCE_REPORT_PAGINATION_INVALID", "ATTENDANCE_REPORT_PAGINATION_INVALID"],
    ["ATTENDANCE_REPORT_QUERY_INVALID", "ATTENDANCE_REPORT_QUERY_INVALID"],
  ]);
  const mapped = known.get(message);
  if (mapped) return mapped;
  if (error.code === "42501") return "ATTENDANCE_REPORT_ACCESS_DENIED";
  if (error.code === "22023") return "ATTENDANCE_REPORT_QUERY_INVALID";
  return "ATTENDANCE_REPORT_UNAVAILABLE";
}

function serviceRoleRpc(): AttendanceRpcCaller {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) => createServiceSupabaseClient());
  return async (name, args) => (await client).rpc(name, args);
}

export function createServiceAttendanceSelfHistoryRepository(rpc?: AttendanceRpcCaller): AttendanceSelfHistoryRepository {
  let resolvedRpc = rpc;
  const callRpc: AttendanceRpcCaller = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };
  const failed = (error: { code?: string; message?: string }): AttendanceSelfHistoryResult => ({ ok: false, code: classify(error) });

  return {
    async getSelfHistory(input) {
      try {
        const result = await callRpc("attendance_self_history", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_from_date: input.from_date,
          p_to_date: input.to_date,
          p_page: input.page,
          p_page_size: input.page_size,
        });
        if (result.error) return failed(result.error);
        const page = projectPage(result.data, input);
        return page ? { ok: true, page } : { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      } catch {
        console.error("[attendance-self] history RPC failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async getSelfCheckInPhotoStorageKey(input) {
      try {
        const result = await callRpc("attendance_self_checkin_photo", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_checkin_id: input.checkin_id,
        });
        if (result.error) return { ok: false, code: classify(result.error) };
        const storageKey = projectStorageKey(result.data);
        return storageKey === undefined
          ? { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }
          : { ok: true, storage_key: storageKey };
      } catch {
        console.error("[attendance-self] photo RPC failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },
  };
}
