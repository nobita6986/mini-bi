import "server-only";

import {
  projectAssignBranchResult,
  projectAttendanceBranchesAdminList,
  projectAttendanceMonthlyMatrixReport,
  projectUnassignBranchResult,
  projectUpsertBranchResult,
  type AssignAttendanceBranchResultProjection,
  type AttendanceBranchesAdminListProjection,
  type AttendanceMonthlyMatrixErrorCode,
  type AttendanceMonthlyMatrixReportProjection,
  type UnassignAttendanceBranchResultProjection,
  type UpsertAttendanceBranchResultProjection,
} from "./attendance-monthly-matrix-contract.ts";
import type { AttendanceRpcCaller } from "./attendance-repository.ts";

export type GetAttendanceMonthlyMatrixReportInput = {
  auth_subject: string;
  app_user_id: string;
  year_month: string | null;
  branch_id: string | null;
  employee_id: string | null;
  search: string | null;
  page: number;
  page_size: number;
};

export type GetAttendanceMonthlyMatrixReportResult =
  | { ok: true; report: AttendanceMonthlyMatrixReportProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type ListAttendanceBranchesAdminInput = {
  auth_subject: string;
  app_user_id: string;
  include_inactive: boolean;
};

export type ListAttendanceBranchesAdminResult =
  | { ok: true; data: AttendanceBranchesAdminListProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type UpsertAttendanceBranchAdminInput = {
  auth_subject: string;
  app_user_id: string;
  branch_id: string | null;
  branch_code: string;
  display_name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  expected_version: number;
  idempotency_key: string;
  request_fingerprint: string;
};

export type UpsertAttendanceBranchAdminResult =
  | { ok: true; result: UpsertAttendanceBranchResultProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type AssignEmployeeBranchAdminInput = {
  auth_subject: string;
  app_user_id: string;
  target_app_user_id: string;
  branch_id: string;
  valid_from: string | null;
  expected_version: number;
  idempotency_key: string;
  request_fingerprint: string;
};

export type AssignEmployeeBranchAdminResult =
  | { ok: true; result: AssignAttendanceBranchResultProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type UnassignEmployeeBranchAdminInput = {
  auth_subject: string;
  app_user_id: string;
  assignment_id: string;
  valid_to: string | null;
  expected_version: number;
  idempotency_key: string;
  request_fingerprint: string;
};

export type UnassignEmployeeBranchAdminResult =
  | { ok: true; result: UnassignAttendanceBranchResultProjection }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode };

export type AttendanceMonthlyMatrixRepository = {
  getMonthlyMatrixReport(
    input: GetAttendanceMonthlyMatrixReportInput,
  ): Promise<GetAttendanceMonthlyMatrixReportResult>;
  listBranchesAdmin(
    input: ListAttendanceBranchesAdminInput,
  ): Promise<ListAttendanceBranchesAdminResult>;
  upsertBranchAdmin(
    input: UpsertAttendanceBranchAdminInput,
  ): Promise<UpsertAttendanceBranchAdminResult>;
  assignEmployeeBranchAdmin(
    input: AssignEmployeeBranchAdminInput,
  ): Promise<AssignEmployeeBranchAdminResult>;
  unassignEmployeeBranchAdmin(
    input: UnassignEmployeeBranchAdminInput,
  ): Promise<UnassignEmployeeBranchAdminResult>;
};

const KNOWN_MATRIX_RPC_TOKENS: ReadonlyMap<string, AttendanceMonthlyMatrixErrorCode> = new Map([
  ["ATTENDANCE_ACTOR_DENIED", "ACTOR_NOT_AVAILABLE"],
  ["ATTENDANCE_REPORT_ACCESS_DENIED", "ATTENDANCE_REPORT_ACCESS_DENIED"],
  ["ATTENDANCE_BRANCH_WRITE_DENIED", "ATTENDANCE_BRANCH_WRITE_DENIED"],
  ["ATTENDANCE_MATRIX_MONTH_INVALID", "ATTENDANCE_MATRIX_MONTH_INVALID"],
  ["ATTENDANCE_REPORT_PAGINATION_INVALID", "ATTENDANCE_REPORT_PAGINATION_INVALID"],
  ["ATTENDANCE_REPORT_SEARCH_INVALID", "ATTENDANCE_REPORT_SEARCH_INVALID"],
  ["ATTENDANCE_REPORT_FILTER_CONFLICT", "ATTENDANCE_REPORT_FILTER_CONFLICT"],
  ["ATTENDANCE_BRANCH_INVALID", "ATTENDANCE_BRANCH_INVALID"],
  ["ATTENDANCE_BRANCH_NOT_FOUND", "ATTENDANCE_BRANCH_NOT_FOUND"],
  ["ATTENDANCE_BRANCH_CODE_CONFLICT", "ATTENDANCE_BRANCH_CODE_CONFLICT"],
  ["ATTENDANCE_BRANCH_VERSION_CONFLICT", "ATTENDANCE_BRANCH_VERSION_CONFLICT"],
  ["ATTENDANCE_BRANCH_INACTIVE", "ATTENDANCE_BRANCH_INACTIVE"],
  ["ATTENDANCE_BRANCH_TARGET_USER_INVALID", "ATTENDANCE_BRANCH_TARGET_USER_INVALID"],
  ["ATTENDANCE_BRANCH_ASSIGNMENT_INVALID", "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID"],
  ["ATTENDANCE_BRANCH_ASSIGNMENT_NOT_FOUND", "ATTENDANCE_BRANCH_ASSIGNMENT_NOT_FOUND"],
  ["ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP", "ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP"],
  ["ATTENDANCE_BRANCH_ASSIGNMENT_ALREADY_CLOSED", "ATTENDANCE_BRANCH_ASSIGNMENT_ALREADY_CLOSED"],
  ["ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID", "ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID"],
  [
    "ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT",
    "ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT",
  ],
  ["ATTENDANCE_IDEMPOTENCY_INVALID", "IDEMPOTENCY_KEY_INVALID"],
  ["IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_CONFLICT"],
]);

function serviceRoleRpc(): AttendanceRpcCaller {
  const clientPromise = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await clientPromise).rpc(name, args);
}

function classifyMatrixRpcError(
  error: { code?: string; message?: string },
  mode: "report" | "branch_write" | "assignment_write",
): AttendanceMonthlyMatrixErrorCode {
  const trimmed = typeof error.message === "string" ? error.message.trim() : "";
  const exact = KNOWN_MATRIX_RPC_TOKENS.get(trimmed);
  if (exact) {
    return exact;
  }

  for (const [token, mapped] of KNOWN_MATRIX_RPC_TOKENS.entries()) {
    if (trimmed.includes(token)) {
      return mapped;
    }
  }

  if (error.code === "42501") {
    return mode === "report"
      ? "ATTENDANCE_REPORT_ACCESS_DENIED"
      : "ATTENDANCE_BRANCH_WRITE_DENIED";
  }
  if (error.code === "P0002") {
    return mode === "assignment_write"
      ? "ATTENDANCE_BRANCH_ASSIGNMENT_NOT_FOUND"
      : "ATTENDANCE_BRANCH_NOT_FOUND";
  }
  if (error.code === "PT409" || error.code === "40001") {
    return mode === "assignment_write"
      ? "ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT"
      : "ATTENDANCE_BRANCH_VERSION_CONFLICT";
  }
  if (error.code === "23505") {
    if (trimmed.includes("attendance_branch_assignments_one_open_idx")) {
      return "ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP";
    }
    if (trimmed.includes("attendance_branches_code_uq")) {
      return "ATTENDANCE_BRANCH_CODE_CONFLICT";
    }
    return "IDEMPOTENCY_CONFLICT";
  }
  if (error.code === "22023" || error.code === "23514") {
    if (mode === "branch_write") return "ATTENDANCE_BRANCH_INVALID";
    if (mode === "assignment_write") return "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID";
    return "ATTENDANCE_REPORT_QUERY_INVALID";
  }

  return "ATTENDANCE_REPORT_UNAVAILABLE";
}

export function createServiceAttendanceMonthlyMatrixRepository(
  rpc?: AttendanceRpcCaller,
): AttendanceMonthlyMatrixRepository {
  let resolvedRpc = rpc;

  return {
    async getMonthlyMatrixReport(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_monthly_matrix_report", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_year_month: input.year_month,
          p_branch_id: input.branch_id,
          p_employee_id: input.employee_id,
          p_search: input.search,
          p_page: input.page,
          p_page_size: input.page_size,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "report") };
        }

        const projected = projectAttendanceMonthlyMatrixReport(result.data);
        if (!projected) {
          console.error("[attendance-monthly-matrix] report RPC returned non-canonical projection");
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, report: projected };
      } catch {
        console.error("[attendance-monthly-matrix] report RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async listBranchesAdmin(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_list_branches_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_include_inactive: input.include_inactive,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "report") };
        }

        const projected = projectAttendanceBranchesAdminList(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] list branches RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, data: projected };
      } catch {
        console.error("[attendance-monthly-matrix] list branches RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async upsertBranchAdmin(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_upsert_branch_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_branch_id: input.branch_id,
          p_branch_code: input.branch_code,
          p_display_name: input.display_name,
          p_address: input.address,
          p_latitude: input.latitude,
          p_longitude: input.longitude,
          p_active: input.active,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "branch_write") };
        }

        const projected = projectUpsertBranchResult(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] upsert branch RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, result: projected };
      } catch {
        console.error("[attendance-monthly-matrix] upsert branch RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async assignEmployeeBranchAdmin(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_assign_employee_branch_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_target_app_user_id: input.target_app_user_id,
          p_branch_id: input.branch_id,
          p_valid_from: input.valid_from,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "assignment_write") };
        }

        const projected = projectAssignBranchResult(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] assign branch RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, result: projected };
      } catch {
        console.error("[attendance-monthly-matrix] assign branch RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },

    async unassignEmployeeBranchAdmin(input) {
      try {
        resolvedRpc ??= serviceRoleRpc();
        const result = await resolvedRpc("attendance_unassign_employee_branch_admin", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_assignment_id: input.assignment_id,
          p_valid_to: input.valid_to,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
          p_request_fingerprint: input.request_fingerprint,
        });

        if (result.error) {
          return { ok: false, code: classifyMatrixRpcError(result.error, "assignment_write") };
        }

        const projected = projectUnassignBranchResult(result.data);
        if (!projected) {
          console.error(
            "[attendance-monthly-matrix] unassign branch RPC returned non-canonical projection",
          );
          return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
        }

        return { ok: true, result: projected };
      } catch {
        console.error("[attendance-monthly-matrix] unassign branch RPC call failed");
        return { ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" };
      }
    },
  };
}
