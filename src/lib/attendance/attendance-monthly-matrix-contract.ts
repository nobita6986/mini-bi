import {
  ATTENDANCE_BUSINESS_TIMEZONE,
  ATTENDANCE_DISTANCE_STATUSES,
  ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE,
  ATTENDANCE_REPORT_MAX_PAGE,
  ATTENDANCE_REPORT_MAX_PAGE_SIZE,
  ATTENDANCE_REPORT_MAX_SEARCH_LENGTH,
  isValidIsoCalendarDate,
  projectHqLocation,
  type AttendanceDistanceStatus,
  type AttendanceHqLocationProjection,
} from "./attendance-report-contract.ts";

export const ATTENDANCE_MONTHLY_MATRIX_EXPORT_ROW_LIMIT = 1_000;
export const ATTENDANCE_MONTHLY_MATRIX_EXPORT_PAGE_SIZE = 100;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const YEAR_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const BRANCH_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._:-]{0,63}$/;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const ADDRESS_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const ATTENDANCE_MONTHLY_MATRIX_DAY_STATUSES = [
  "CHECKED_IN",
  "APPROVED_LEAVE",
  "CHECKED_IN_AND_LEAVE",
  "NO_CHECKIN",
] as const;

export type AttendanceMonthlyMatrixDayStatus =
  (typeof ATTENDANCE_MONTHLY_MATRIX_DAY_STATUSES)[number];

export const ATTENDANCE_DISTANCE_TARGET_KINDS = ["HQ", "BRANCH"] as const;
export type AttendanceDistanceTargetKind =
  (typeof ATTENDANCE_DISTANCE_TARGET_KINDS)[number];

export const ATTENDANCE_MATRIX_LEAVE_SESSION_CODES = ["FULL", "AM", "PM"] as const;
export type AttendanceMatrixLeaveSessionCode =
  (typeof ATTENDANCE_MATRIX_LEAVE_SESSION_CODES)[number];

export const ATTENDANCE_MATRIX_LEAVE_TYPES = [
  "ANNUAL",
  "BEREAVEMENT",
  "MARRIAGE",
  "SICK",
  "UNPAID",
  "MATERNITY",
] as const;
export type AttendanceMatrixLeaveType = (typeof ATTENDANCE_MATRIX_LEAVE_TYPES)[number];

export const ATTENDANCE_SLOT_CODES = ["SLOT_1", "SLOT_2", "SLOT_3", "SLOT_4"] as const;
export type AttendanceSlotCode = (typeof ATTENDANCE_SLOT_CODES)[number];

export const ATTENDANCE_SLOT_SESSION_CODES = ["AM", "PM"] as const;
export type AttendanceSlotSessionCode = (typeof ATTENDANCE_SLOT_SESSION_CODES)[number];

export const ATTENDANCE_SLOT_STATUSES = [
  "ON_TIME",
  "OUT_OF_GRACE",
  "LEAVE_COVERED",
  "MISSING",
] as const;
export type AttendanceSlotStatus = (typeof ATTENDANCE_SLOT_STATUSES)[number];

export const ATTENDANCE_CHECKIN_DEVIATION_STATUSES = [
  "ON_TIME",
  "EARLY",
  "LATE",
] as const;
export type AttendanceCheckinDeviationStatus =
  (typeof ATTENDANCE_CHECKIN_DEVIATION_STATUSES)[number];

export const ATTENDANCE_SLOT_MAX_GRACE_MINUTES = 240;

export const ATTENDANCE_MONTHLY_MATRIX_ERROR_CODES = [
  "UNAUTHENTICATED",
  "ACTOR_NOT_AVAILABLE",
  "ATTENDANCE_REPORT_ACCESS_DENIED",
  "ATTENDANCE_BRANCH_WRITE_DENIED",
  "ATTENDANCE_SLOT_POLICY_WRITE_DENIED",
  "CSRF_REJECTED",
  "CONTENT_TYPE_INVALID",
  "BODY_TOO_LARGE",
  "ATTENDANCE_REPORT_QUERY_INVALID",
  "ATTENDANCE_MATRIX_MONTH_INVALID",
  "ATTENDANCE_REPORT_PAGINATION_INVALID",
  "ATTENDANCE_REPORT_SEARCH_INVALID",
  "ATTENDANCE_REPORT_EMPLOYEE_INVALID",
  "ATTENDANCE_REPORT_BRANCH_INVALID",
  "ATTENDANCE_REPORT_FILTER_CONFLICT",
  "ATTENDANCE_MATRIX_EXPORT_ROW_LIMIT_EXCEEDED",
  "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE",
  "ATTENDANCE_BRANCH_INVALID",
  "ATTENDANCE_BRANCH_NOT_FOUND",
  "ATTENDANCE_BRANCH_CODE_CONFLICT",
  "ATTENDANCE_BRANCH_VERSION_CONFLICT",
  "ATTENDANCE_BRANCH_INACTIVE",
  "ATTENDANCE_BRANCH_TARGET_USER_INVALID",
  "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID",
  "ATTENDANCE_BRANCH_ASSIGNMENT_NOT_FOUND",
  "ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP",
  "ATTENDANCE_BRANCH_ASSIGNMENT_ALREADY_CLOSED",
  "ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID",
  "ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT",
  "ATTENDANCE_SLOT_POLICY_INVALID",
  "ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST",
  "ATTENDANCE_SLOT_POLICY_OVERLAP",
  "ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT",
  "IDEMPOTENCY_KEY_INVALID",
  "IDEMPOTENCY_CONFLICT",
  "ATTENDANCE_REPORT_UNAVAILABLE",
] as const;

export type AttendanceMonthlyMatrixErrorCode =
  (typeof ATTENDANCE_MONTHLY_MATRIX_ERROR_CODES)[number];

const MATRIX_ERROR_HTTP_STATUS: Readonly<Record<AttendanceMonthlyMatrixErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  ACTOR_NOT_AVAILABLE: 403,
  ATTENDANCE_REPORT_ACCESS_DENIED: 403,
  ATTENDANCE_BRANCH_WRITE_DENIED: 403,
  ATTENDANCE_SLOT_POLICY_WRITE_DENIED: 403,
  CSRF_REJECTED: 403,
  CONTENT_TYPE_INVALID: 400,
  BODY_TOO_LARGE: 413,
  ATTENDANCE_REPORT_QUERY_INVALID: 400,
  ATTENDANCE_MATRIX_MONTH_INVALID: 400,
  ATTENDANCE_REPORT_PAGINATION_INVALID: 400,
  ATTENDANCE_REPORT_SEARCH_INVALID: 400,
  ATTENDANCE_REPORT_EMPLOYEE_INVALID: 400,
  ATTENDANCE_REPORT_BRANCH_INVALID: 400,
  ATTENDANCE_REPORT_FILTER_CONFLICT: 400,
  ATTENDANCE_MATRIX_EXPORT_ROW_LIMIT_EXCEEDED: 422,
  ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE: 409,
  ATTENDANCE_BRANCH_INVALID: 400,
  ATTENDANCE_BRANCH_NOT_FOUND: 404,
  ATTENDANCE_BRANCH_CODE_CONFLICT: 409,
  ATTENDANCE_BRANCH_VERSION_CONFLICT: 409,
  ATTENDANCE_BRANCH_INACTIVE: 422,
  ATTENDANCE_BRANCH_TARGET_USER_INVALID: 422,
  ATTENDANCE_BRANCH_ASSIGNMENT_INVALID: 400,
  ATTENDANCE_BRANCH_ASSIGNMENT_NOT_FOUND: 404,
  ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP: 409,
  ATTENDANCE_BRANCH_ASSIGNMENT_ALREADY_CLOSED: 409,
  ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID: 400,
  ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT: 409,
  ATTENDANCE_SLOT_POLICY_INVALID: 400,
  ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST: 422,
  ATTENDANCE_SLOT_POLICY_OVERLAP: 409,
  ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_INVALID: 400,
  IDEMPOTENCY_CONFLICT: 409,
  ATTENDANCE_REPORT_UNAVAILABLE: 503,
};

export function attendanceMonthlyMatrixHttpStatusForError(
  code: AttendanceMonthlyMatrixErrorCode,
): number {
  return MATRIX_ERROR_HTTP_STATUS[code];
}

export type ParsedAttendanceMonthlyMatrixQuery = {
  year_month: string | null;
  branch_id: string | null;
  employee_id: string | null;
  search: string | null;
  page: number;
  page_size: number;
};

export type ParsedAttendanceMonthlyMatrixExportQuery = {
  year_month: string | null;
  branch_id: string | null;
  employee_id: string | null;
  search: string | null;
};

export type AttendanceMonthlyMatrixCalendarDayProjection = {
  business_date: string;
  day_of_month: number;
  day_of_week: number;
};

export type AttendanceBranchOptionProjection = {
  branch_id: string;
  branch_code: string;
  display_name: string;
  active: boolean;
  latitude: number | null;
  longitude: number | null;
  version: number;
};

export type AttendanceMonthlyMatrixEmployeeOptionProjection = {
  app_user_id: string;
  display_name: string;
  personnel_code: string | null;
  branch_id: string | null;
  branch_code: string | null;
  branch_name: string | null;
};

export type AttendanceMonthlyMatrixOverviewProjection = {
  total_employees: number;
  employees_with_checkins: number;
  employees_with_approved_leave: number;
  total_checkins: number;
  total_checkin_days: number;
  total_approved_leave_days: number;
  total_approved_leave_units: number;
  total_no_checkin_days: number;
  total_no_checkin_without_leave_days: number;
};

export type AttendanceMonthlyMatrixPaginationProjection = {
  page: number;
  page_size: number;
  total_rows: number;
  total_pages: number;
  has_more: boolean;
  snapshot_token: string;
};

export type AttendanceMonthlyMatrixEmployeeBranchProjection = {
  branch_id: string;
  branch_code: string;
  display_name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  version: number;
  valid_from: string;
  valid_to: string | null;
};

export type AttendanceMonthlyMatrixEmployeeSummaryProjection = {
  checkin_day_count: number;
  total_checkins: number;
  approved_leave_day_count: number;
  approved_leave_units: number;
  checkin_and_leave_day_count: number;
  no_checkin_day_count: number;
  no_checkin_without_leave_day_count: number;
  distance_computed_count: number;
  distance_unavailable_count: number;
  min_distance_meters: number | null;
  max_distance_meters: number | null;
};

export type AttendanceMonthlyMatrixApprovedLeaveItemProjection = {
  request_id: string;
  leave_date: string;
  session_code: AttendanceMatrixLeaveSessionCode;
  leave_type: AttendanceMatrixLeaveType;
  half_day_units: number;
};

export type AttendanceSlotConfigItemProjection = {
  slot_code: AttendanceSlotCode;
  slot_index: 1 | 2 | 3 | 4;
  session_code: AttendanceSlotSessionCode;
  target_time: string;
  grace_before_minutes: number;
  grace_after_minutes: number;
};

export type AttendanceSlotPolicyProjection = {
  version: number;
  effective_from_date: string;
  effective_to_date: string | null;
  configured_at: string;
  configured_at_local: string;
  configured_by_display_name: string;
  slots: [
    AttendanceSlotConfigItemProjection,
    AttendanceSlotConfigItemProjection,
    AttendanceSlotConfigItemProjection,
    AttendanceSlotConfigItemProjection,
  ];
};

export type AttendanceMonthlyMatrixSlotPolicySummaryProjection = {
  current_policy: AttendanceSlotPolicyProjection;
  latest_policy: AttendanceSlotPolicyProjection;
  month_policies: AttendanceSlotPolicyProjection[];
};

export type AttendanceSlotCheckinItemProjection = {
  checkin_id: string;
  sequence_in_day: number;
  captured_at: string;
  captured_at_local: string;
  time_local: string;
  time_verified: boolean;
  assigned_slot_code: AttendanceSlotCode;
  delta_minutes: number;
  over_grace_minutes: number;
  deviation_status: AttendanceCheckinDeviationStatus;
  distance_target_kind: AttendanceDistanceTargetKind | null;
  distance_status: AttendanceDistanceStatus | null;
  distance_meters: number | null;
};

export type AttendanceMonthlyMatrixDaySlotProjection = {
  slot_code: AttendanceSlotCode;
  slot_index: 1 | 2 | 3 | 4;
  session_code: AttendanceSlotSessionCode;
  target_time: string;
  grace_before_minutes: number;
  grace_after_minutes: number;
  is_leave_covered: boolean;
  slot_status: AttendanceSlotStatus;
  checkins: AttendanceSlotCheckinItemProjection[];
};

export const DEFAULT_ATTENDANCE_SLOT_POLICY: AttendanceSlotPolicyProjection = {
  version: 1,
  effective_from_date: "2000-01-01",
  effective_to_date: null,
  configured_at: "2000-01-01T00:00:00.000Z",
  configured_at_local: "2000-01-01 00:00:00",
  configured_by_display_name: "Mặc định hệ thống",
  slots: [
    {
      slot_code: "SLOT_1",
      slot_index: 1,
      session_code: "AM",
      target_time: "08:00",
      grace_before_minutes: 15,
      grace_after_minutes: 15,
    },
    {
      slot_code: "SLOT_2",
      slot_index: 2,
      session_code: "AM",
      target_time: "11:00",
      grace_before_minutes: 15,
      grace_after_minutes: 15,
    },
    {
      slot_code: "SLOT_3",
      slot_index: 3,
      session_code: "PM",
      target_time: "13:00",
      grace_before_minutes: 15,
      grace_after_minutes: 15,
    },
    {
      slot_code: "SLOT_4",
      slot_index: 4,
      session_code: "PM",
      target_time: "17:00",
      grace_before_minutes: 15,
      grace_after_minutes: 15,
    },
  ],
};

export type AttendanceMonthlyMatrixDayCellProjection = {
  business_date: string;
  day_of_month: number;
  policy_version_used: number;
  has_checkin: boolean;
  checkin_count: number;
  first_checkin_id: string | null;
  last_checkin_id: string | null;
  first_captured_at: string | null;
  first_captured_at_local: string | null;
  first_time_local: string | null;
  last_captured_at: string | null;
  last_captured_at_local: string | null;
  last_time_local: string | null;
  verified_checkin_count: number;
  unverified_checkin_count: number;
  distance_target_kind: AttendanceDistanceTargetKind | null;
  branch_id_used: string | null;
  branch_code_used: string | null;
  branch_name_used: string | null;
  branch_version_used: number | null;
  hq_version_used: number | null;
  distance_status: AttendanceDistanceStatus | null;
  distance_meters: number | null;
  min_distance_meters: number | null;
  max_distance_meters: number | null;
  has_approved_leave: boolean;
  approved_leave_units: number;
  approved_leaves: AttendanceMonthlyMatrixApprovedLeaveItemProjection[];
  day_status: AttendanceMonthlyMatrixDayStatus;
  missing_slot_count: number;
  late_or_early_checkin_count: number;
  slots: AttendanceMonthlyMatrixDaySlotProjection[];
};

export type AttendanceMonthlyMatrixEmployeeRowProjection = {
  app_user_id: string;
  employee_display_name: string;
  personnel_code: string | null;
  enabled: boolean;
  branch: AttendanceMonthlyMatrixEmployeeBranchProjection | null;
  summary: AttendanceMonthlyMatrixEmployeeSummaryProjection;
  days: AttendanceMonthlyMatrixDayCellProjection[];
};

export type AttendanceMonthlyMatrixReportProjection = {
  viewer: {
    can_configure_hq: boolean;
    can_manage_branches: boolean;
    can_manage_slot_policy: boolean;
  };
  filters: {
    year_month: string;
    from_date: string;
    to_date: string;
    branch_id: string | null;
    employee_id: string | null;
    search: string | null;
    timezone: typeof ATTENDANCE_BUSINESS_TIMEZONE;
  };
  days_in_month: number;
  calendar_days: AttendanceMonthlyMatrixCalendarDayProjection[];
  current_hq: AttendanceHqLocationProjection | null;
  slot_policy: AttendanceMonthlyMatrixSlotPolicySummaryProjection;
  branch_options: AttendanceBranchOptionProjection[];
  employee_options: AttendanceMonthlyMatrixEmployeeOptionProjection[];
  overview: AttendanceMonthlyMatrixOverviewProjection;
  pagination: AttendanceMonthlyMatrixPaginationProjection;
  items: AttendanceMonthlyMatrixEmployeeRowProjection[];
};

export type AttendanceSlotPoliciesAdminListProjection = {
  viewer: {
    can_manage_slot_policy: boolean;
  };
  business_date: string;
  current_policy: AttendanceSlotPolicyProjection;
  latest_policy: AttendanceSlotPolicyProjection;
  versions: AttendanceSlotPolicyProjection[];
};

export type CreateAttendanceSlotPolicyResultProjection = {
  replayed: boolean;
  policy: AttendanceSlotPolicyProjection;
};

export type ParsedCreateSlotPolicyRequest = {
  effective_from_date: string;
  slot_1_time: string;
  slot_1_grace_before_minutes: number;
  slot_1_grace_after_minutes: number;
  slot_2_time: string;
  slot_2_grace_before_minutes: number;
  slot_2_grace_after_minutes: number;
  slot_3_time: string;
  slot_3_grace_before_minutes: number;
  slot_3_grace_after_minutes: number;
  slot_4_time: string;
  slot_4_grace_before_minutes: number;
  slot_4_grace_after_minutes: number;
  expected_version: number;
  idempotency_key: string;
};

export type AttendanceBranchAdminItemProjection = {
  branch_id: string;
  branch_code: string;
  display_name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  version: number;
  active_assignment_count: number;
  created_at: string;
  updated_at: string;
  updated_by_display_name: string;
};

export type AttendanceBranchAssignmentAdminItemProjection = {
  assignment_id: string;
  app_user_id: string;
  employee_display_name: string;
  personnel_code: string | null;
  branch_id: string;
  branch_code: string;
  branch_name: string;
  valid_from: string;
  valid_to: string | null;
  effective: boolean;
  version: number;
  created_at: string;
  updated_at: string;
};

export type AttendanceBranchAdminEmployeeOptionProjection = {
  app_user_id: string;
  display_name: string;
  personnel_code: string | null;
  enabled: boolean;
};

export type AttendanceBranchesAdminListProjection = {
  viewer: {
    can_manage_branches: boolean;
  };
  business_date: string;
  include_inactive: boolean;
  branches: AttendanceBranchAdminItemProjection[];
  assignments: AttendanceBranchAssignmentAdminItemProjection[];
  employee_options: AttendanceBranchAdminEmployeeOptionProjection[];
};

export type AttendanceBranchSavedProjection = {
  branch_id: string;
  branch_code: string;
  display_name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  version: number;
  updated_at: string;
  updated_by_display_name: string;
};

export type UpsertAttendanceBranchResultProjection = {
  replayed: boolean;
  branch: AttendanceBranchSavedProjection;
};

export type AssignAttendanceBranchResultProjection = {
  replayed: boolean;
  assignment: {
    assignment_id: string;
    app_user_id: string;
    branch_id: string;
    branch_code: string;
    branch_name: string;
    valid_from: string;
    valid_to: string | null;
    version: number;
  };
};

export type UnassignAttendanceBranchResultProjection = {
  replayed: boolean;
  assignment: {
    assignment_id: string;
    app_user_id: string;
    branch_id: string;
    valid_from: string;
    valid_to: string | null;
    version: number;
  };
};

export type ParsedUpsertBranchRequest = {
  branch_code: string;
  display_name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  active: boolean;
  expected_version: number;
  idempotency_key: string;
};

export type ParsedAssignBranchRequest = {
  target_app_user_id: string;
  branch_id: string;
  valid_from: string | null;
  expected_version: number;
  idempotency_key: string;
};

export type ParsedUnassignBranchRequest = {
  valid_to: string | null;
  expected_version: number;
  idempotency_key: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== expected.length) return false;
  const set = new Set(expected);
  return actual.every((key) => set.has(key));
}

function isUuidString(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function parseHhMmToMinutes(value: string): number | null {
  if (!HH_MM_PATTERN.test(value)) return null;
  const [hh, mm] = value.split(":");
  return Number(hh) * 60 + Number(mm);
}

export function isValidYearMonth(value: string): boolean {
  const match = YEAR_MONTH_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  return year >= 2000 && year <= 2100;
}

/**
 * Deterministic 4-slot evaluation helper shared between contract fallbacks and tests.
 * Tie-break rule: when a check-in is equidistant between two adjacent slots,
 * it is deterministically assigned to the earlier slot (`slot_index asc`).
 */
export function evaluateAttendanceDaySlots(input: {
  policy?: Pick<AttendanceSlotPolicyProjection, "version" | "slots">;
  checkins: readonly {
    checkin_id: string;
    sequence_in_day: number;
    captured_at: string;
    captured_at_local: string;
    time_local: string;
    time_verified: boolean;
    distance_target_kind: AttendanceDistanceTargetKind | null;
    distance_status: AttendanceDistanceStatus | null;
    distance_meters: number | null;
  }[];
  approved_leaves: readonly Pick<
    AttendanceMonthlyMatrixApprovedLeaveItemProjection,
    "session_code"
  >[];
}): {
  policy_version_used: number;
  missing_slot_count: number;
  late_or_early_checkin_count: number;
  slots: AttendanceMonthlyMatrixDaySlotProjection[];
} {
  const policy = input.policy ?? DEFAULT_ATTENDANCE_SLOT_POLICY;
  const amCovered = input.approved_leaves.some(
    (item) => item.session_code === "FULL" || item.session_code === "AM",
  );
  const pmCovered = input.approved_leaves.some(
    (item) => item.session_code === "FULL" || item.session_code === "PM",
  );

  const slotTargets = policy.slots.map((slot) => ({
    ...slot,
    target_minute: parseHhMmToMinutes(slot.target_time) ?? 0,
  }));

  const sortedCheckins = [...input.checkins].sort((a, b) => {
    if (a.captured_at !== b.captured_at) {
      return a.captured_at.localeCompare(b.captured_at);
    }
    if (a.sequence_in_day !== b.sequence_in_day) {
      return a.sequence_in_day - b.sequence_in_day;
    }
    return a.checkin_id.localeCompare(b.checkin_id);
  });

  const bucketBySlotIndex = new Map<number, AttendanceSlotCheckinItemProjection[]>();
  for (const slot of slotTargets) {
    bucketBySlotIndex.set(slot.slot_index, []);
  }

  let lateOrEarlyCount = 0;

  for (const checkin of sortedCheckins) {
    const checkinMinute = parseHhMmToMinutes(checkin.time_local) ?? 0;
    let bestSlot = slotTargets[0]!;
    let bestDistance = Math.abs(checkinMinute - bestSlot.target_minute);

    for (let i = 1; i < slotTargets.length; i += 1) {
      const candidate = slotTargets[i]!;
      const distance = Math.abs(checkinMinute - candidate.target_minute);
      // Strictly `<` preserves deterministic tie-break to earlier slot (`slot_index asc`).
      if (distance < bestDistance) {
        bestSlot = candidate;
        bestDistance = distance;
      }
    }

    const deltaMinutes = checkinMinute - bestSlot.target_minute;
    let deviationStatus: AttendanceCheckinDeviationStatus = "ON_TIME";
    let overGraceMinutes = 0;

    if (deltaMinutes < -bestSlot.grace_before_minutes) {
      deviationStatus = "EARLY";
      overGraceMinutes = -deltaMinutes - bestSlot.grace_before_minutes;
      lateOrEarlyCount += 1;
    } else if (deltaMinutes > bestSlot.grace_after_minutes) {
      deviationStatus = "LATE";
      overGraceMinutes = deltaMinutes - bestSlot.grace_after_minutes;
      lateOrEarlyCount += 1;
    }

    bucketBySlotIndex.get(bestSlot.slot_index)!.push({
      checkin_id: checkin.checkin_id.toLowerCase(),
      sequence_in_day: checkin.sequence_in_day,
      captured_at: checkin.captured_at,
      captured_at_local: checkin.captured_at_local,
      time_local: checkin.time_local,
      time_verified: checkin.time_verified,
      assigned_slot_code: bestSlot.slot_code,
      delta_minutes: deltaMinutes,
      over_grace_minutes: overGraceMinutes,
      deviation_status: deviationStatus,
      distance_target_kind: checkin.distance_target_kind,
      distance_status: checkin.distance_status,
      distance_meters:
        checkin.distance_meters === null ? null : normalizeZero(checkin.distance_meters),
    });
  }

  let missingSlotCount = 0;
  const slots: AttendanceMonthlyMatrixDaySlotProjection[] = slotTargets.map((slot) => {
    const slotCheckins = bucketBySlotIndex.get(slot.slot_index) ?? [];
    const isLeaveCovered = slot.session_code === "AM" ? amCovered : pmCovered;
    const hasOutOfGrace = slotCheckins.some((item) => item.deviation_status !== "ON_TIME");

    let slotStatus: AttendanceSlotStatus;
    if (slotCheckins.length > 0 && hasOutOfGrace) {
      slotStatus = "OUT_OF_GRACE";
    } else if (slotCheckins.length > 0) {
      slotStatus = "ON_TIME";
    } else if (isLeaveCovered) {
      slotStatus = "LEAVE_COVERED";
    } else {
      slotStatus = "MISSING";
      missingSlotCount += 1;
    }

    return {
      slot_code: slot.slot_code,
      slot_index: slot.slot_index,
      session_code: slot.session_code,
      target_time: slot.target_time,
      grace_before_minutes: slot.grace_before_minutes,
      grace_after_minutes: slot.grace_after_minutes,
      is_leave_covered: isLeaveCovered,
      slot_status: slotStatus,
      checkins: slotCheckins,
    };
  });

  return {
    policy_version_used: policy.version,
    missing_slot_count: missingSlotCount,
    late_or_early_checkin_count: lateOrEarlyCount,
    slots,
  };
}

function parseSharedMatrixFilters(
  url: URL,
  allowedKeys: ReadonlySet<string>,
):
  | {
      ok: true;
      value: {
        year_month: string | null;
        branch_id: string | null;
        employee_id: string | null;
        search: string | null;
      };
    }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_REPORT_QUERY_INVALID" };
    }
  }
  for (const key of allowedKeys) {
    if (url.searchParams.getAll(key).length > 1) {
      return { ok: false, code: "ATTENDANCE_REPORT_QUERY_INVALID" };
    }
  }

  const rawYearMonth = url.searchParams.get("year_month");
  const yearMonth =
    rawYearMonth !== null && rawYearMonth.trim() !== "" ? rawYearMonth.trim() : null;
  if (yearMonth !== null && !isValidYearMonth(yearMonth)) {
    return { ok: false, code: "ATTENDANCE_MATRIX_MONTH_INVALID" };
  }

  const rawBranchId = url.searchParams.get("branch_id");
  let branchId: string | null = null;
  if (rawBranchId !== null) {
    const trimmed = rawBranchId.trim();
    if (trimmed.length > 0) {
      if (!isUuidString(trimmed)) {
        return { ok: false, code: "ATTENDANCE_REPORT_BRANCH_INVALID" };
      }
      branchId = trimmed.toLowerCase();
    }
  }

  const rawEmployeeId = url.searchParams.get("employee_id");
  let employeeId: string | null = null;
  if (rawEmployeeId !== null) {
    const trimmed = rawEmployeeId.trim();
    if (trimmed.length > 0) {
      if (!isUuidString(trimmed)) {
        return { ok: false, code: "ATTENDANCE_REPORT_EMPLOYEE_INVALID" };
      }
      employeeId = trimmed.toLowerCase();
    }
  }

  const rawSearch = url.searchParams.get("search");
  let search: string | null = null;
  if (rawSearch !== null) {
    const trimmed = rawSearch.trim();
    if (
      trimmed.length > 100 ||
      trimmed.length > ATTENDANCE_REPORT_MAX_SEARCH_LENGTH ||
      CONTROL_CHAR_PATTERN.test(trimmed)
    ) {
      return { ok: false, code: "ATTENDANCE_REPORT_SEARCH_INVALID" };
    }
    search = trimmed.length > 0 ? trimmed : null;
  }

  if (search !== null && employeeId !== null) {
    return { ok: false, code: "ATTENDANCE_REPORT_FILTER_CONFLICT" };
  }

  return {
    ok: true,
    value: {
      year_month: yearMonth,
      branch_id: branchId,
      employee_id: employeeId,
      search,
    },
  };
}

export function parseAttendanceMonthlyMatrixQuery(
  url: URL,
):
  | { ok: true; value: ParsedAttendanceMonthlyMatrixQuery }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  const allowedKeys = new Set([
    "year_month",
    "branch_id",
    "employee_id",
    "search",
    "page",
    "page_size",
  ]);
  const shared = parseSharedMatrixFilters(url, allowedKeys);
  if (!shared.ok) return shared;

  const rawPage = url.searchParams.get("page") ?? "1";
  const rawPageSize =
    url.searchParams.get("page_size") ?? String(ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE);
  if (!/^\d{1,6}$/.test(rawPage) || !/^\d{1,6}$/.test(rawPageSize)) {
    return { ok: false, code: "ATTENDANCE_REPORT_PAGINATION_INVALID" };
  }
  const page = Number(rawPage);
  const pageSize = Number(rawPageSize);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > ATTENDANCE_REPORT_MAX_PAGE ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > ATTENDANCE_REPORT_MAX_PAGE_SIZE
  ) {
    return { ok: false, code: "ATTENDANCE_REPORT_PAGINATION_INVALID" };
  }

  return {
    ok: true,
    value: {
      ...shared.value,
      page,
      page_size: pageSize,
    },
  };
}

export function parseAttendanceMonthlyMatrixExportQuery(
  url: URL,
):
  | { ok: true; value: ParsedAttendanceMonthlyMatrixExportQuery }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  const allowedKeys = new Set(["year_month", "branch_id", "employee_id", "search"]);
  return parseSharedMatrixFilters(url, allowedKeys);
}

export function parseAttendanceBranchesAdminQuery(
  url: URL,
):
  | { ok: true; value: { include_inactive: boolean } }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  const allowedKeys = new Set(["include_inactive"]);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length > 1) {
      return { ok: false, code: "ATTENDANCE_REPORT_QUERY_INVALID" };
    }
  }
  const rawInclude = url.searchParams.get("include_inactive");
  if (rawInclude === null || rawInclude.trim() === "") {
    return { ok: true, value: { include_inactive: true } };
  }
  const normalized = rawInclude.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return { ok: true, value: { include_inactive: true } };
  }
  if (normalized === "false" || normalized === "0") {
    return { ok: true, value: { include_inactive: false } };
  }
  return { ok: false, code: "ATTENDANCE_REPORT_QUERY_INVALID" };
}

function resolveIdempotencyKey(
  bodyKeyRaw: unknown,
  headerIdempotencyKey?: string | null,
): string | null {
  const trimmedHeaderKey = headerIdempotencyKey?.trim() ?? "";
  const bodyKey = typeof bodyKeyRaw === "string" ? bodyKeyRaw.trim() : "";
  const resolvedKey = bodyKey || trimmedHeaderKey;
  if (!isUuidString(resolvedKey)) {
    return null;
  }
  if (
    trimmedHeaderKey !== "" &&
    (!isUuidString(trimmedHeaderKey) ||
      (bodyKey !== "" && trimmedHeaderKey.toLowerCase() !== bodyKey.toLowerCase()))
  ) {
    return null;
  }
  return resolvedKey.toLowerCase();
}

export function parseCreateSlotPolicyBody(
  body: unknown,
  headerIdempotencyKey?: string | null,
):
  | { ok: true; value: ParsedCreateSlotPolicyRequest }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  if (!isRecord(body)) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
  }
  const allowedKeys = new Set([
    "effective_from_date",
    "slots",
    "slot_1",
    "slot_2",
    "slot_3",
    "slot_4",
    "expected_version",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
  }

  const effectiveFromDate =
    typeof body.effective_from_date === "string" ? body.effective_from_date.trim() : "";
  if (
    !isValidIsoCalendarDate(effectiveFromDate) ||
    effectiveFromDate < "2000-01-01" ||
    effectiveFromDate > "2100-12-31"
  ) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
  }

  const rawSlotsList = Array.isArray(body.slots)
    ? body.slots
    : body.slot_1 !== undefined ||
        body.slot_2 !== undefined ||
        body.slot_3 !== undefined ||
        body.slot_4 !== undefined
      ? [body.slot_1, body.slot_2, body.slot_3, body.slot_4]
      : null;

  if (!rawSlotsList || rawSlotsList.length !== 4) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
  }

  const parsedSlots: {
    slot_code: AttendanceSlotCode;
    target_time: string;
    grace_before_minutes: number;
    grace_after_minutes: number;
  }[] = [];

  for (let i = 0; i < 4; i += 1) {
    const rawSlot = rawSlotsList[i];
    const expectedCode = ATTENDANCE_SLOT_CODES[i]!;
    if (!isRecord(rawSlot)) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }
    const slotAllowedKeys = new Set([
      "slot_code",
      "target_time",
      "grace_before_minutes",
      "grace_after_minutes",
    ]);
    for (const key of Object.keys(rawSlot)) {
      if (!slotAllowedKeys.has(key)) {
        return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
      }
    }

    if (
      rawSlot.slot_code !== undefined &&
      rawSlot.slot_code !== expectedCode
    ) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }

    const targetTime =
      typeof rawSlot.target_time === "string" ? rawSlot.target_time.trim() : "";
    const graceBefore = rawSlot.grace_before_minutes;
    const graceAfter = rawSlot.grace_after_minutes;

    if (
      !HH_MM_PATTERN.test(targetTime) ||
      typeof graceBefore !== "number" ||
      !Number.isSafeInteger(graceBefore) ||
      graceBefore < 0 ||
      graceBefore > ATTENDANCE_SLOT_MAX_GRACE_MINUTES ||
      typeof graceAfter !== "number" ||
      !Number.isSafeInteger(graceAfter) ||
      graceAfter < 0 ||
      graceAfter > ATTENDANCE_SLOT_MAX_GRACE_MINUTES
    ) {
      return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
    }

    parsedSlots.push({
      slot_code: expectedCode,
      target_time: targetTime,
      grace_before_minutes: graceBefore,
      grace_after_minutes: graceAfter,
    });
  }

  if (
    !(
      parsedSlots[0]!.target_time < parsedSlots[1]!.target_time &&
      parsedSlots[1]!.target_time < parsedSlots[2]!.target_time &&
      parsedSlots[2]!.target_time < parsedSlots[3]!.target_time
    )
  ) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
  }

  const expectedVersion = body.expected_version;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return { ok: false, code: "ATTENDANCE_SLOT_POLICY_INVALID" };
  }

  const idempotencyKey = resolveIdempotencyKey(body.idempotency_key, headerIdempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  return {
    ok: true,
    value: {
      effective_from_date: effectiveFromDate,
      slot_1_time: parsedSlots[0]!.target_time,
      slot_1_grace_before_minutes: parsedSlots[0]!.grace_before_minutes,
      slot_1_grace_after_minutes: parsedSlots[0]!.grace_after_minutes,
      slot_2_time: parsedSlots[1]!.target_time,
      slot_2_grace_before_minutes: parsedSlots[1]!.grace_before_minutes,
      slot_2_grace_after_minutes: parsedSlots[1]!.grace_after_minutes,
      slot_3_time: parsedSlots[2]!.target_time,
      slot_3_grace_before_minutes: parsedSlots[2]!.grace_before_minutes,
      slot_3_grace_after_minutes: parsedSlots[2]!.grace_after_minutes,
      slot_4_time: parsedSlots[3]!.target_time,
      slot_4_grace_before_minutes: parsedSlots[3]!.grace_before_minutes,
      slot_4_grace_after_minutes: parsedSlots[3]!.grace_after_minutes,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
    },
  };
}

export function parseUpsertBranchBody(
  body: unknown,
  headerIdempotencyKey?: string | null,
):
  | { ok: true; value: ParsedUpsertBranchRequest }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  if (!isRecord(body)) {
    return { ok: false, code: "ATTENDANCE_BRANCH_INVALID" };
  }
  const allowedKeys = new Set([
    "branch_code",
    "display_name",
    "address",
    "latitude",
    "longitude",
    "active",
    "expected_version",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_BRANCH_INVALID" };
    }
  }

  const branchCode =
    typeof body.branch_code === "string" ? body.branch_code.trim().toUpperCase() : "";
  const displayName =
    typeof body.display_name === "string" ? body.display_name.trim() : "";
  const address =
    body.address === undefined || body.address === null
      ? ""
      : typeof body.address === "string"
        ? body.address.trim()
        : null;

  if (
    !BRANCH_CODE_PATTERN.test(branchCode) ||
    displayName.length < 1 ||
    displayName.length > 256 ||
    CONTROL_CHAR_PATTERN.test(displayName) ||
    address === null ||
    address.length > 500 ||
    ADDRESS_CONTROL_CHAR_PATTERN.test(address)
  ) {
    return { ok: false, code: "ATTENDANCE_BRANCH_INVALID" };
  }

  const rawLat = body.latitude === undefined ? null : body.latitude;
  const rawLon = body.longitude === undefined ? null : body.longitude;
  if ((rawLat === null) !== (rawLon === null)) {
    return { ok: false, code: "ATTENDANCE_BRANCH_INVALID" };
  }
  let latitude: number | null = null;
  let longitude: number | null = null;
  if (rawLat !== null && rawLon !== null) {
    if (
      !isFiniteNumber(rawLat) ||
      rawLat < -90 ||
      rawLat > 90 ||
      !isFiniteNumber(rawLon) ||
      rawLon < -180 ||
      rawLon > 180
    ) {
      return { ok: false, code: "ATTENDANCE_BRANCH_INVALID" };
    }
    latitude = normalizeZero(rawLat);
    longitude = normalizeZero(rawLon);
  }

  const active = body.active === undefined ? true : body.active;
  if (typeof active !== "boolean") {
    return { ok: false, code: "ATTENDANCE_BRANCH_INVALID" };
  }

  const expectedVersion = body.expected_version;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    return { ok: false, code: "ATTENDANCE_BRANCH_INVALID" };
  }

  const idempotencyKey = resolveIdempotencyKey(body.idempotency_key, headerIdempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  return {
    ok: true,
    value: {
      branch_code: branchCode,
      display_name: displayName,
      address,
      latitude,
      longitude,
      active,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
    },
  };
}

export function parseAssignBranchBody(
  body: unknown,
  headerIdempotencyKey?: string | null,
):
  | { ok: true; value: ParsedAssignBranchRequest }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  if (!isRecord(body)) {
    return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
  }
  const allowedKeys = new Set([
    "app_user_id",
    "branch_id",
    "valid_from",
    "expected_version",
    "idempotency_key",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
    }
  }

  const rawUserId = typeof body.app_user_id === "string" ? body.app_user_id.trim() : "";
  const rawBranchId = typeof body.branch_id === "string" ? body.branch_id.trim() : "";
  if (!isUuidString(rawUserId) || !isUuidString(rawBranchId)) {
    return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
  }

  let validFrom: string | null = null;
  if (body.valid_from !== undefined && body.valid_from !== null) {
    if (typeof body.valid_from !== "string" || !isValidIsoCalendarDate(body.valid_from.trim())) {
      return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
    }
    validFrom = body.valid_from.trim();
  }

  const expectedVersion = body.expected_version;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
  }

  const idempotencyKey = resolveIdempotencyKey(body.idempotency_key, headerIdempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  return {
    ok: true,
    value: {
      target_app_user_id: rawUserId.toLowerCase(),
      branch_id: rawBranchId.toLowerCase(),
      valid_from: validFrom,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
    },
  };
}

export function parseUnassignBranchBody(
  body: unknown,
  headerIdempotencyKey?: string | null,
):
  | { ok: true; value: ParsedUnassignBranchRequest }
  | { ok: false; code: AttendanceMonthlyMatrixErrorCode } {
  if (!isRecord(body)) {
    return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
  }
  const allowedKeys = new Set(["valid_to", "expected_version", "idempotency_key"]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
    }
  }

  let validTo: string | null = null;
  if (body.valid_to !== undefined && body.valid_to !== null) {
    if (typeof body.valid_to !== "string" || !isValidIsoCalendarDate(body.valid_to.trim())) {
      return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
    }
    validTo = body.valid_to.trim();
  }

  const expectedVersion = body.expected_version;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return { ok: false, code: "ATTENDANCE_BRANCH_ASSIGNMENT_INVALID" };
  }

  const idempotencyKey = resolveIdempotencyKey(body.idempotency_key, headerIdempotencyKey);
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  return {
    ok: true,
    value: {
      valid_to: validTo,
      expected_version: expectedVersion,
      idempotency_key: idempotencyKey,
    },
  };
}

function projectSlotConfigItem(
  value: unknown,
  expectedIndex: 1 | 2 | 3 | 4,
): AttendanceSlotConfigItemProjection | null {
  const expectedCode = ATTENDANCE_SLOT_CODES[expectedIndex - 1]!;
  const expectedSession: AttendanceSlotSessionCode = expectedIndex <= 2 ? "AM" : "PM";
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "slot_code",
      "slot_index",
      "session_code",
      "target_time",
      "grace_before_minutes",
      "grace_after_minutes",
    ])
  ) {
    return null;
  }
  if (
    value.slot_code !== expectedCode ||
    value.slot_index !== expectedIndex ||
    value.session_code !== expectedSession ||
    typeof value.target_time !== "string" ||
    !HH_MM_PATTERN.test(value.target_time) ||
    typeof value.grace_before_minutes !== "number" ||
    !Number.isSafeInteger(value.grace_before_minutes) ||
    value.grace_before_minutes < 0 ||
    value.grace_before_minutes > ATTENDANCE_SLOT_MAX_GRACE_MINUTES ||
    typeof value.grace_after_minutes !== "number" ||
    !Number.isSafeInteger(value.grace_after_minutes) ||
    value.grace_after_minutes < 0 ||
    value.grace_after_minutes > ATTENDANCE_SLOT_MAX_GRACE_MINUTES
  ) {
    return null;
  }

  return {
    slot_code: expectedCode,
    slot_index: expectedIndex,
    session_code: expectedSession,
    target_time: value.target_time,
    grace_before_minutes: value.grace_before_minutes,
    grace_after_minutes: value.grace_after_minutes,
  };
}

export function projectAttendanceSlotPolicy(
  value: unknown,
): AttendanceSlotPolicyProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "effective_from_date",
      "effective_to_date",
      "configured_at",
      "configured_at_local",
      "configured_by_display_name",
      "slots",
    ])
  ) {
    return null;
  }
  if (
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.effective_from_date !== "string" ||
    !isValidIsoCalendarDate(value.effective_from_date) ||
    (value.effective_to_date !== null &&
      (typeof value.effective_to_date !== "string" ||
        !isValidIsoCalendarDate(value.effective_to_date))) ||
    typeof value.configured_at !== "string" ||
    typeof value.configured_at_local !== "string" ||
    typeof value.configured_by_display_name !== "string" ||
    value.configured_by_display_name.trim().length === 0 ||
    !Array.isArray(value.slots) ||
    value.slots.length !== 4
  ) {
    return null;
  }

  const slot1 = projectSlotConfigItem(value.slots[0], 1);
  const slot2 = projectSlotConfigItem(value.slots[1], 2);
  const slot3 = projectSlotConfigItem(value.slots[2], 3);
  const slot4 = projectSlotConfigItem(value.slots[3], 4);
  if (!slot1 || !slot2 || !slot3 || !slot4) {
    return null;
  }
  if (
    !(
      slot1.target_time < slot2.target_time &&
      slot2.target_time < slot3.target_time &&
      slot3.target_time < slot4.target_time
    )
  ) {
    return null;
  }

  return {
    version: value.version,
    effective_from_date: value.effective_from_date,
    effective_to_date: value.effective_to_date,
    configured_at: value.configured_at,
    configured_at_local: value.configured_at_local,
    configured_by_display_name: value.configured_by_display_name,
    slots: [slot1, slot2, slot3, slot4],
  };
}

function projectSlotPolicySummary(
  value: unknown,
): AttendanceMonthlyMatrixSlotPolicySummaryProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["current_policy", "latest_policy", "month_policies"]) ||
    !Array.isArray(value.month_policies)
  ) {
    return null;
  }
  const currentPolicy = projectAttendanceSlotPolicy(value.current_policy);
  const latestPolicy = projectAttendanceSlotPolicy(value.latest_policy);
  if (!currentPolicy || !latestPolicy) {
    return null;
  }
  const monthPolicies: AttendanceSlotPolicyProjection[] = [];
  for (const raw of value.month_policies) {
    const projected = projectAttendanceSlotPolicy(raw);
    if (!projected) return null;
    monthPolicies.push(projected);
  }
  return {
    current_policy: currentPolicy,
    latest_policy: latestPolicy,
    month_policies: monthPolicies,
  };
}

function projectSlotCheckinItem(
  value: unknown,
  expectedSlotCode: AttendanceSlotCode,
): AttendanceSlotCheckinItemProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "checkin_id",
      "sequence_in_day",
      "captured_at",
      "captured_at_local",
      "time_local",
      "time_verified",
      "assigned_slot_code",
      "delta_minutes",
      "over_grace_minutes",
      "deviation_status",
      "distance_target_kind",
      "distance_status",
      "distance_meters",
    ])
  ) {
    return null;
  }
  if (
    !isUuidString(value.checkin_id) ||
    typeof value.sequence_in_day !== "number" ||
    !Number.isSafeInteger(value.sequence_in_day) ||
    value.sequence_in_day < 1 ||
    typeof value.captured_at !== "string" ||
    typeof value.captured_at_local !== "string" ||
    typeof value.time_local !== "string" ||
    !HH_MM_PATTERN.test(value.time_local) ||
    typeof value.time_verified !== "boolean" ||
    value.assigned_slot_code !== expectedSlotCode ||
    typeof value.delta_minutes !== "number" ||
    !Number.isSafeInteger(value.delta_minutes) ||
    typeof value.over_grace_minutes !== "number" ||
    !Number.isSafeInteger(value.over_grace_minutes) ||
    value.over_grace_minutes < 0 ||
    !ATTENDANCE_CHECKIN_DEVIATION_STATUSES.includes(
      value.deviation_status as AttendanceCheckinDeviationStatus,
    ) ||
    (value.distance_target_kind !== null &&
      !ATTENDANCE_DISTANCE_TARGET_KINDS.includes(
        value.distance_target_kind as AttendanceDistanceTargetKind,
      )) ||
    (value.distance_status !== null &&
      !ATTENDANCE_DISTANCE_STATUSES.includes(value.distance_status as AttendanceDistanceStatus)) ||
    (value.distance_meters !== null &&
      (!isFiniteNumber(value.distance_meters) || value.distance_meters < 0))
  ) {
    return null;
  }

  return {
    checkin_id: value.checkin_id.toLowerCase(),
    sequence_in_day: value.sequence_in_day,
    captured_at: value.captured_at,
    captured_at_local: value.captured_at_local,
    time_local: value.time_local,
    time_verified: value.time_verified,
    assigned_slot_code: expectedSlotCode,
    delta_minutes: value.delta_minutes,
    over_grace_minutes: value.over_grace_minutes,
    deviation_status: value.deviation_status as AttendanceCheckinDeviationStatus,
    distance_target_kind: value.distance_target_kind as AttendanceDistanceTargetKind | null,
    distance_status: value.distance_status as AttendanceDistanceStatus | null,
    distance_meters:
      value.distance_meters === null ? null : normalizeZero(value.distance_meters),
  };
}

function projectDaySlot(
  value: unknown,
  expectedIndex: 1 | 2 | 3 | 4,
): AttendanceMonthlyMatrixDaySlotProjection | null {
  const expectedCode = ATTENDANCE_SLOT_CODES[expectedIndex - 1]!;
  const expectedSession: AttendanceSlotSessionCode = expectedIndex <= 2 ? "AM" : "PM";
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "slot_code",
      "slot_index",
      "session_code",
      "target_time",
      "grace_before_minutes",
      "grace_after_minutes",
      "is_leave_covered",
      "slot_status",
      "checkins",
    ])
  ) {
    return null;
  }

  if (
    value.slot_code !== expectedCode ||
    value.slot_index !== expectedIndex ||
    value.session_code !== expectedSession ||
    typeof value.target_time !== "string" ||
    !HH_MM_PATTERN.test(value.target_time) ||
    typeof value.grace_before_minutes !== "number" ||
    !Number.isSafeInteger(value.grace_before_minutes) ||
    value.grace_before_minutes < 0 ||
    value.grace_before_minutes > ATTENDANCE_SLOT_MAX_GRACE_MINUTES ||
    typeof value.grace_after_minutes !== "number" ||
    !Number.isSafeInteger(value.grace_after_minutes) ||
    value.grace_after_minutes < 0 ||
    value.grace_after_minutes > ATTENDANCE_SLOT_MAX_GRACE_MINUTES ||
    typeof value.is_leave_covered !== "boolean" ||
    !ATTENDANCE_SLOT_STATUSES.includes(value.slot_status as AttendanceSlotStatus) ||
    !Array.isArray(value.checkins)
  ) {
    return null;
  }

  const checkins: AttendanceSlotCheckinItemProjection[] = [];
  for (const rawCheckin of value.checkins) {
    const projectedCheckin = projectSlotCheckinItem(rawCheckin, expectedCode);
    if (!projectedCheckin) return null;
    checkins.push(projectedCheckin);
  }

  return {
    slot_code: expectedCode,
    slot_index: expectedIndex,
    session_code: expectedSession,
    target_time: value.target_time,
    grace_before_minutes: value.grace_before_minutes,
    grace_after_minutes: value.grace_after_minutes,
    is_leave_covered: value.is_leave_covered,
    slot_status: value.slot_status as AttendanceSlotStatus,
    checkins,
  };
}

function projectCalendarDay(
  value: unknown,
): AttendanceMonthlyMatrixCalendarDayProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["business_date", "day_of_month", "day_of_week"])
  ) {
    return null;
  }
  if (
    typeof value.business_date !== "string" ||
    !isValidIsoCalendarDate(value.business_date) ||
    typeof value.day_of_month !== "number" ||
    !Number.isSafeInteger(value.day_of_month) ||
    value.day_of_month < 1 ||
    value.day_of_month > 31 ||
    typeof value.day_of_week !== "number" ||
    !Number.isSafeInteger(value.day_of_week) ||
    value.day_of_week < 1 ||
    value.day_of_week > 7
  ) {
    return null;
  }
  return {
    business_date: value.business_date,
    day_of_month: value.day_of_month,
    day_of_week: value.day_of_week,
  };
}

function projectBranchOption(value: unknown): AttendanceBranchOptionProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "branch_id",
      "branch_code",
      "display_name",
      "active",
      "latitude",
      "longitude",
      "version",
    ])
  ) {
    return null;
  }
  if (
    !isUuidString(value.branch_id) ||
    typeof value.branch_code !== "string" ||
    !BRANCH_CODE_PATTERN.test(value.branch_code) ||
    typeof value.display_name !== "string" ||
    value.display_name.trim().length === 0 ||
    typeof value.active !== "boolean" ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    (value.latitude === null) !== (value.longitude === null)
  ) {
    return null;
  }
  if (
    value.latitude !== null &&
    (!isFiniteNumber(value.latitude) || value.latitude < -90 || value.latitude > 90)
  ) {
    return null;
  }
  if (
    value.longitude !== null &&
    (!isFiniteNumber(value.longitude) || value.longitude < -180 || value.longitude > 180)
  ) {
    return null;
  }
  return {
    branch_id: value.branch_id.toLowerCase(),
    branch_code: value.branch_code,
    display_name: value.display_name,
    active: value.active,
    latitude: value.latitude === null ? null : normalizeZero(value.latitude),
    longitude: value.longitude === null ? null : normalizeZero(value.longitude),
    version: value.version,
  };
}

function projectEmployeeOption(
  value: unknown,
): AttendanceMonthlyMatrixEmployeeOptionProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "app_user_id",
      "display_name",
      "personnel_code",
      "branch_id",
      "branch_code",
      "branch_name",
    ])
  ) {
    return null;
  }
  if (
    !isUuidString(value.app_user_id) ||
    typeof value.display_name !== "string" ||
    value.display_name.trim().length === 0 ||
    (value.personnel_code !== null && typeof value.personnel_code !== "string") ||
    (value.branch_id !== null && !isUuidString(value.branch_id)) ||
    (value.branch_code !== null && typeof value.branch_code !== "string") ||
    (value.branch_name !== null && typeof value.branch_name !== "string")
  ) {
    return null;
  }
  return {
    app_user_id: value.app_user_id.toLowerCase(),
    display_name: value.display_name,
    personnel_code: value.personnel_code,
    branch_id: value.branch_id === null ? null : value.branch_id.toLowerCase(),
    branch_code: value.branch_code,
    branch_name: value.branch_name,
  };
}

function projectOverview(value: unknown): AttendanceMonthlyMatrixOverviewProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "total_employees",
      "employees_with_checkins",
      "employees_with_approved_leave",
      "total_checkins",
      "total_checkin_days",
      "total_approved_leave_days",
      "total_approved_leave_units",
      "total_no_checkin_days",
      "total_no_checkin_without_leave_days",
    ])
  ) {
    return null;
  }
  const intKeys = [
    "total_employees",
    "employees_with_checkins",
    "employees_with_approved_leave",
    "total_checkins",
    "total_checkin_days",
    "total_approved_leave_days",
    "total_no_checkin_days",
    "total_no_checkin_without_leave_days",
  ] as const;
  for (const key of intKeys) {
    const num = value[key];
    if (typeof num !== "number" || !Number.isSafeInteger(num) || num < 0) {
      return null;
    }
  }
  if (!isFiniteNumber(value.total_approved_leave_units) || value.total_approved_leave_units < 0) {
    return null;
  }
  return {
    total_employees: value.total_employees as number,
    employees_with_checkins: value.employees_with_checkins as number,
    employees_with_approved_leave: value.employees_with_approved_leave as number,
    total_checkins: value.total_checkins as number,
    total_checkin_days: value.total_checkin_days as number,
    total_approved_leave_days: value.total_approved_leave_days as number,
    total_approved_leave_units: normalizeZero(value.total_approved_leave_units),
    total_no_checkin_days: value.total_no_checkin_days as number,
    total_no_checkin_without_leave_days: value.total_no_checkin_without_leave_days as number,
  };
}

function projectPagination(value: unknown): AttendanceMonthlyMatrixPaginationProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "page",
      "page_size",
      "total_rows",
      "total_pages",
      "has_more",
      "snapshot_token",
    ])
  ) {
    return null;
  }
  if (
    typeof value.page !== "number" ||
    !Number.isSafeInteger(value.page) ||
    value.page < 1 ||
    typeof value.page_size !== "number" ||
    !Number.isSafeInteger(value.page_size) ||
    value.page_size < 1 ||
    typeof value.total_rows !== "number" ||
    !Number.isSafeInteger(value.total_rows) ||
    value.total_rows < 0 ||
    typeof value.total_pages !== "number" ||
    !Number.isSafeInteger(value.total_pages) ||
    value.total_pages < 0 ||
    typeof value.has_more !== "boolean" ||
    typeof value.snapshot_token !== "string" ||
    !/^[0-9a-f]{32}$/.test(value.snapshot_token)
  ) {
    return null;
  }
  return {
    page: value.page,
    page_size: value.page_size,
    total_rows: value.total_rows,
    total_pages: value.total_pages,
    has_more: value.has_more,
    snapshot_token: value.snapshot_token,
  };
}

function projectEmployeeBranch(
  value: unknown,
): AttendanceMonthlyMatrixEmployeeBranchProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "branch_id",
      "branch_code",
      "display_name",
      "address",
      "latitude",
      "longitude",
      "active",
      "version",
      "valid_from",
      "valid_to",
    ])
  ) {
    return null;
  }
  if (
    !isUuidString(value.branch_id) ||
    typeof value.branch_code !== "string" ||
    !BRANCH_CODE_PATTERN.test(value.branch_code) ||
    typeof value.display_name !== "string" ||
    value.display_name.trim().length === 0 ||
    typeof value.address !== "string" ||
    typeof value.active !== "boolean" ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    typeof value.valid_from !== "string" ||
    !isValidIsoCalendarDate(value.valid_from) ||
    (value.valid_to !== null &&
      (typeof value.valid_to !== "string" || !isValidIsoCalendarDate(value.valid_to))) ||
    (value.latitude === null) !== (value.longitude === null)
  ) {
    return null;
  }
  if (
    value.latitude !== null &&
    (!isFiniteNumber(value.latitude) || value.latitude < -90 || value.latitude > 90)
  ) {
    return null;
  }
  if (
    value.longitude !== null &&
    (!isFiniteNumber(value.longitude) || value.longitude < -180 || value.longitude > 180)
  ) {
    return null;
  }
  return {
    branch_id: value.branch_id.toLowerCase(),
    branch_code: value.branch_code,
    display_name: value.display_name,
    address: value.address,
    latitude: value.latitude === null ? null : normalizeZero(value.latitude),
    longitude: value.longitude === null ? null : normalizeZero(value.longitude),
    active: value.active,
    version: value.version,
    valid_from: value.valid_from,
    valid_to: value.valid_to,
  };
}

function projectEmployeeSummary(
  value: unknown,
): AttendanceMonthlyMatrixEmployeeSummaryProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "checkin_day_count",
      "total_checkins",
      "approved_leave_day_count",
      "approved_leave_units",
      "checkin_and_leave_day_count",
      "no_checkin_day_count",
      "no_checkin_without_leave_day_count",
      "distance_computed_count",
      "distance_unavailable_count",
      "min_distance_meters",
      "max_distance_meters",
    ])
  ) {
    return null;
  }
  const intKeys = [
    "checkin_day_count",
    "total_checkins",
    "approved_leave_day_count",
    "checkin_and_leave_day_count",
    "no_checkin_day_count",
    "no_checkin_without_leave_day_count",
    "distance_computed_count",
    "distance_unavailable_count",
  ] as const;
  for (const key of intKeys) {
    const num = value[key];
    if (typeof num !== "number" || !Number.isSafeInteger(num) || num < 0) {
      return null;
    }
  }
  if (!isFiniteNumber(value.approved_leave_units) || value.approved_leave_units < 0) {
    return null;
  }
  if (
    value.min_distance_meters !== null &&
    (!isFiniteNumber(value.min_distance_meters) || value.min_distance_meters < 0)
  ) {
    return null;
  }
  if (
    value.max_distance_meters !== null &&
    (!isFiniteNumber(value.max_distance_meters) || value.max_distance_meters < 0)
  ) {
    return null;
  }
  return {
    checkin_day_count: value.checkin_day_count as number,
    total_checkins: value.total_checkins as number,
    approved_leave_day_count: value.approved_leave_day_count as number,
    approved_leave_units: normalizeZero(value.approved_leave_units),
    checkin_and_leave_day_count: value.checkin_and_leave_day_count as number,
    no_checkin_day_count: value.no_checkin_day_count as number,
    no_checkin_without_leave_day_count: value.no_checkin_without_leave_day_count as number,
    distance_computed_count: value.distance_computed_count as number,
    distance_unavailable_count: value.distance_unavailable_count as number,
    min_distance_meters:
      value.min_distance_meters === null ? null : normalizeZero(value.min_distance_meters),
    max_distance_meters:
      value.max_distance_meters === null ? null : normalizeZero(value.max_distance_meters),
  };
}

function projectApprovedLeaveItem(
  value: unknown,
): AttendanceMonthlyMatrixApprovedLeaveItemProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "request_id",
      "leave_date",
      "session_code",
      "leave_type",
      "half_day_units",
    ])
  ) {
    return null;
  }
  if (
    !isUuidString(value.request_id) ||
    typeof value.leave_date !== "string" ||
    !isValidIsoCalendarDate(value.leave_date) ||
    !ATTENDANCE_MATRIX_LEAVE_SESSION_CODES.includes(
      value.session_code as AttendanceMatrixLeaveSessionCode,
    ) ||
    !ATTENDANCE_MATRIX_LEAVE_TYPES.includes(value.leave_type as AttendanceMatrixLeaveType) ||
    (value.half_day_units !== 1 && value.half_day_units !== 2)
  ) {
    return null;
  }
  return {
    request_id: value.request_id.toLowerCase(),
    leave_date: value.leave_date,
    session_code: value.session_code as AttendanceMatrixLeaveSessionCode,
    leave_type: value.leave_type as AttendanceMatrixLeaveType,
    half_day_units: value.half_day_units,
  };
}

function projectDayCell(value: unknown): AttendanceMonthlyMatrixDayCellProjection | null {
  if (!isRecord(value)) {
    return null;
  }
  const baseKeys = [
    "business_date",
    "day_of_month",
    "has_checkin",
    "checkin_count",
    "first_checkin_id",
    "last_checkin_id",
    "first_captured_at",
    "first_captured_at_local",
    "first_time_local",
    "last_captured_at",
    "last_captured_at_local",
    "last_time_local",
    "verified_checkin_count",
    "unverified_checkin_count",
    "distance_target_kind",
    "branch_id_used",
    "branch_code_used",
    "branch_name_used",
    "branch_version_used",
    "hq_version_used",
    "distance_status",
    "distance_meters",
    "min_distance_meters",
    "max_distance_meters",
    "has_approved_leave",
    "approved_leave_units",
    "approved_leaves",
    "day_status",
  ] as const;

  const fullKeys = [
    ...baseKeys,
    "policy_version_used",
    "missing_slot_count",
    "late_or_early_checkin_count",
    "slots",
  ] as const;

  const hasFullFourSlotKeys = hasExactKeys(value, fullKeys);
  const hasLegacyBaseKeys = !hasFullFourSlotKeys && hasExactKeys(value, baseKeys);
  if (!hasFullFourSlotKeys && !hasLegacyBaseKeys) {
    return null;
  }

  if (
    typeof value.business_date !== "string" ||
    !isValidIsoCalendarDate(value.business_date) ||
    typeof value.day_of_month !== "number" ||
    !Number.isSafeInteger(value.day_of_month) ||
    value.day_of_month < 1 ||
    value.day_of_month > 31 ||
    typeof value.has_checkin !== "boolean" ||
    typeof value.checkin_count !== "number" ||
    !Number.isSafeInteger(value.checkin_count) ||
    value.checkin_count < 0 ||
    typeof value.verified_checkin_count !== "number" ||
    !Number.isSafeInteger(value.verified_checkin_count) ||
    value.verified_checkin_count < 0 ||
    typeof value.unverified_checkin_count !== "number" ||
    !Number.isSafeInteger(value.unverified_checkin_count) ||
    value.unverified_checkin_count < 0 ||
    typeof value.has_approved_leave !== "boolean" ||
    !isFiniteNumber(value.approved_leave_units) ||
    value.approved_leave_units < 0 ||
    !Array.isArray(value.approved_leaves) ||
    !ATTENDANCE_MONTHLY_MATRIX_DAY_STATUSES.includes(
      value.day_status as AttendanceMonthlyMatrixDayStatus,
    )
  ) {
    return null;
  }

  if (value.first_checkin_id !== null && !isUuidString(value.first_checkin_id)) return null;
  if (value.last_checkin_id !== null && !isUuidString(value.last_checkin_id)) return null;
  if (value.first_captured_at !== null && typeof value.first_captured_at !== "string") return null;
  if (value.first_captured_at_local !== null && typeof value.first_captured_at_local !== "string") {
    return null;
  }
  if (
    value.first_time_local !== null &&
    (typeof value.first_time_local !== "string" || !HH_MM_PATTERN.test(value.first_time_local))
  ) {
    return null;
  }
  if (value.last_captured_at !== null && typeof value.last_captured_at !== "string") return null;
  if (value.last_captured_at_local !== null && typeof value.last_captured_at_local !== "string") {
    return null;
  }
  if (
    value.last_time_local !== null &&
    (typeof value.last_time_local !== "string" || !HH_MM_PATTERN.test(value.last_time_local))
  ) {
    return null;
  }

  if (
    value.distance_target_kind !== null &&
    !ATTENDANCE_DISTANCE_TARGET_KINDS.includes(
      value.distance_target_kind as AttendanceDistanceTargetKind,
    )
  ) {
    return null;
  }
  if (value.branch_id_used !== null && !isUuidString(value.branch_id_used)) return null;
  if (value.branch_code_used !== null && typeof value.branch_code_used !== "string") return null;
  if (value.branch_name_used !== null && typeof value.branch_name_used !== "string") return null;
  if (
    value.branch_version_used !== null &&
    (typeof value.branch_version_used !== "number" ||
      !Number.isSafeInteger(value.branch_version_used) ||
      value.branch_version_used < 1)
  ) {
    return null;
  }
  if (
    value.hq_version_used !== null &&
    (typeof value.hq_version_used !== "number" ||
      !Number.isSafeInteger(value.hq_version_used) ||
      value.hq_version_used < 1)
  ) {
    return null;
  }
  if (
    value.distance_status !== null &&
    !ATTENDANCE_DISTANCE_STATUSES.includes(value.distance_status as AttendanceDistanceStatus)
  ) {
    return null;
  }
  if (
    value.distance_meters !== null &&
    (!isFiniteNumber(value.distance_meters) || value.distance_meters < 0)
  ) {
    return null;
  }
  if (
    value.min_distance_meters !== null &&
    (!isFiniteNumber(value.min_distance_meters) || value.min_distance_meters < 0)
  ) {
    return null;
  }
  if (
    value.max_distance_meters !== null &&
    (!isFiniteNumber(value.max_distance_meters) || value.max_distance_meters < 0)
  ) {
    return null;
  }

  const approvedLeaves: AttendanceMonthlyMatrixApprovedLeaveItemProjection[] = [];
  for (const rawLeave of value.approved_leaves) {
    const projectedLeave = projectApprovedLeaveItem(rawLeave);
    if (!projectedLeave) return null;
    approvedLeaves.push(projectedLeave);
  }

  let policyVersionUsed = 1;
  let missingSlotCount = 0;
  let lateOrEarlyCheckinCount = 0;
  let slots: AttendanceMonthlyMatrixDaySlotProjection[] = [];

  if (hasFullFourSlotKeys) {
    if (
      typeof value.policy_version_used !== "number" ||
      !Number.isSafeInteger(value.policy_version_used) ||
      value.policy_version_used < 1 ||
      typeof value.missing_slot_count !== "number" ||
      !Number.isSafeInteger(value.missing_slot_count) ||
      value.missing_slot_count < 0 ||
      value.missing_slot_count > 4 ||
      typeof value.late_or_early_checkin_count !== "number" ||
      !Number.isSafeInteger(value.late_or_early_checkin_count) ||
      value.late_or_early_checkin_count < 0 ||
      !Array.isArray(value.slots) ||
      value.slots.length !== 4
    ) {
      return null;
    }

    const s1 = projectDaySlot(value.slots[0], 1);
    const s2 = projectDaySlot(value.slots[1], 2);
    const s3 = projectDaySlot(value.slots[2], 3);
    const s4 = projectDaySlot(value.slots[3], 4);
    if (!s1 || !s2 || !s3 || !s4) {
      return null;
    }

    policyVersionUsed = value.policy_version_used;
    missingSlotCount = value.missing_slot_count;
    lateOrEarlyCheckinCount = value.late_or_early_checkin_count;
    slots = [s1, s2, s3, s4];
  } else {
    const synthesizedCheckins: {
      checkin_id: string;
      sequence_in_day: number;
      captured_at: string;
      captured_at_local: string;
      time_local: string;
      time_verified: boolean;
      distance_target_kind: AttendanceDistanceTargetKind | null;
      distance_status: AttendanceDistanceStatus | null;
      distance_meters: number | null;
    }[] = [];

    if (
      value.has_checkin &&
      value.first_checkin_id &&
      value.first_captured_at &&
      value.first_captured_at_local &&
      value.first_time_local
    ) {
      synthesizedCheckins.push({
        checkin_id: value.first_checkin_id,
        sequence_in_day: 1,
        captured_at: value.first_captured_at,
        captured_at_local: value.first_captured_at_local,
        time_local: value.first_time_local,
        time_verified: value.unverified_checkin_count === 0,
        distance_target_kind: value.distance_target_kind as AttendanceDistanceTargetKind | null,
        distance_status: value.distance_status as AttendanceDistanceStatus | null,
        distance_meters:
          value.distance_meters === null ? null : normalizeZero(value.distance_meters),
      });

      if (
        value.checkin_count > 1 &&
        value.last_checkin_id &&
        value.last_checkin_id.toLowerCase() !== value.first_checkin_id.toLowerCase() &&
        value.last_captured_at &&
        value.last_captured_at_local &&
        value.last_time_local
      ) {
        synthesizedCheckins.push({
          checkin_id: value.last_checkin_id,
          sequence_in_day: value.checkin_count,
          captured_at: value.last_captured_at,
          captured_at_local: value.last_captured_at_local,
          time_local: value.last_time_local,
          time_verified: value.unverified_checkin_count === 0,
          distance_target_kind: value.distance_target_kind as AttendanceDistanceTargetKind | null,
          distance_status: value.distance_status as AttendanceDistanceStatus | null,
          distance_meters:
            value.max_distance_meters === null ? null : normalizeZero(value.max_distance_meters),
        });
      }
    }

    const evaluated = evaluateAttendanceDaySlots({
      checkins: synthesizedCheckins,
      approved_leaves: approvedLeaves,
    });
    policyVersionUsed = evaluated.policy_version_used;
    missingSlotCount = evaluated.missing_slot_count;
    lateOrEarlyCheckinCount = evaluated.late_or_early_checkin_count;
    slots = evaluated.slots;
  }

  return {
    business_date: value.business_date,
    day_of_month: value.day_of_month,
    policy_version_used: policyVersionUsed,
    has_checkin: value.has_checkin,
    checkin_count: value.checkin_count,
    first_checkin_id:
      value.first_checkin_id === null ? null : value.first_checkin_id.toLowerCase(),
    last_checkin_id: value.last_checkin_id === null ? null : value.last_checkin_id.toLowerCase(),
    first_captured_at: value.first_captured_at,
    first_captured_at_local: value.first_captured_at_local,
    first_time_local: value.first_time_local,
    last_captured_at: value.last_captured_at,
    last_captured_at_local: value.last_captured_at_local,
    last_time_local: value.last_time_local,
    verified_checkin_count: value.verified_checkin_count,
    unverified_checkin_count: value.unverified_checkin_count,
    distance_target_kind: value.distance_target_kind as AttendanceDistanceTargetKind | null,
    branch_id_used: value.branch_id_used === null ? null : value.branch_id_used.toLowerCase(),
    branch_code_used: value.branch_code_used,
    branch_name_used: value.branch_name_used,
    branch_version_used: value.branch_version_used,
    hq_version_used: value.hq_version_used,
    distance_status: value.distance_status as AttendanceDistanceStatus | null,
    distance_meters:
      value.distance_meters === null ? null : normalizeZero(value.distance_meters),
    min_distance_meters:
      value.min_distance_meters === null ? null : normalizeZero(value.min_distance_meters),
    max_distance_meters:
      value.max_distance_meters === null ? null : normalizeZero(value.max_distance_meters),
    has_approved_leave: value.has_approved_leave,
    approved_leave_units: normalizeZero(value.approved_leave_units),
    approved_leaves: approvedLeaves,
    day_status: value.day_status as AttendanceMonthlyMatrixDayStatus,
    missing_slot_count: missingSlotCount,
    late_or_early_checkin_count: lateOrEarlyCheckinCount,
    slots,
  };
}

function projectEmployeeRow(
  value: unknown,
  expectedDaysInMonth: number,
): AttendanceMonthlyMatrixEmployeeRowProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "app_user_id",
      "employee_display_name",
      "personnel_code",
      "enabled",
      "branch",
      "summary",
      "days",
    ])
  ) {
    return null;
  }
  if (
    !isUuidString(value.app_user_id) ||
    typeof value.employee_display_name !== "string" ||
    value.employee_display_name.trim().length === 0 ||
    (value.personnel_code !== null && typeof value.personnel_code !== "string") ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.days) ||
    value.days.length !== expectedDaysInMonth
  ) {
    return null;
  }

  let branch: AttendanceMonthlyMatrixEmployeeBranchProjection | null = null;
  if (value.branch !== null) {
    branch = projectEmployeeBranch(value.branch);
    if (!branch) return null;
  }

  const summary = projectEmployeeSummary(value.summary);
  if (!summary) return null;

  const days: AttendanceMonthlyMatrixDayCellProjection[] = [];
  for (const rawDay of value.days) {
    const projectedDay = projectDayCell(rawDay);
    if (!projectedDay) return null;
    days.push(projectedDay);
  }

  return {
    app_user_id: value.app_user_id.toLowerCase(),
    employee_display_name: value.employee_display_name,
    personnel_code: value.personnel_code,
    enabled: value.enabled,
    branch,
    summary,
    days,
  };
}

export function projectAttendanceMonthlyMatrixReport(
  value: unknown,
): AttendanceMonthlyMatrixReportProjection | null {
  if (!isRecord(value)) {
    return null;
  }
  const baseRootKeys = [
    "viewer",
    "filters",
    "days_in_month",
    "calendar_days",
    "current_hq",
    "branch_options",
    "employee_options",
    "overview",
    "pagination",
    "items",
  ] as const;
  const fullRootKeys = [...baseRootKeys, "slot_policy"] as const;

  const hasSlotPolicyKey = hasExactKeys(value, fullRootKeys);
  const hasBaseRootKeys = !hasSlotPolicyKey && hasExactKeys(value, baseRootKeys);
  if (!hasSlotPolicyKey && !hasBaseRootKeys) {
    return null;
  }

  if (!isRecord(value.viewer)) {
    return null;
  }
  const viewerHasSlotFlag = hasExactKeys(value.viewer, [
    "can_configure_hq",
    "can_manage_branches",
    "can_manage_slot_policy",
  ]);
  const viewerHasLegacyFlags =
    !viewerHasSlotFlag &&
    hasExactKeys(value.viewer, ["can_configure_hq", "can_manage_branches"]);
  if (
    (!viewerHasSlotFlag && !viewerHasLegacyFlags) ||
    typeof value.viewer.can_configure_hq !== "boolean" ||
    typeof value.viewer.can_manage_branches !== "boolean" ||
    (viewerHasSlotFlag && typeof value.viewer.can_manage_slot_policy !== "boolean")
  ) {
    return null;
  }

  if (
    !isRecord(value.filters) ||
    !hasExactKeys(value.filters, [
      "year_month",
      "from_date",
      "to_date",
      "branch_id",
      "employee_id",
      "search",
      "timezone",
    ])
  ) {
    return null;
  }
  const filters = value.filters;
  if (
    typeof filters.year_month !== "string" ||
    !isValidYearMonth(filters.year_month) ||
    typeof filters.from_date !== "string" ||
    !isValidIsoCalendarDate(filters.from_date) ||
    typeof filters.to_date !== "string" ||
    !isValidIsoCalendarDate(filters.to_date) ||
    (filters.branch_id !== null && !isUuidString(filters.branch_id)) ||
    (filters.employee_id !== null && !isUuidString(filters.employee_id)) ||
    (filters.search !== null && typeof filters.search !== "string") ||
    filters.timezone !== ATTENDANCE_BUSINESS_TIMEZONE
  ) {
    return null;
  }

  if (
    typeof value.days_in_month !== "number" ||
    !Number.isSafeInteger(value.days_in_month) ||
    value.days_in_month < 1 ||
    value.days_in_month > 31 ||
    !Array.isArray(value.calendar_days) ||
    value.calendar_days.length !== value.days_in_month
  ) {
    return null;
  }

  const calendarDays: AttendanceMonthlyMatrixCalendarDayProjection[] = [];
  for (const rawCal of value.calendar_days) {
    const projectedCal = projectCalendarDay(rawCal);
    if (!projectedCal) return null;
    calendarDays.push(projectedCal);
  }

  let currentHq: AttendanceHqLocationProjection | null = null;
  if (value.current_hq !== null) {
    currentHq = projectHqLocation(value.current_hq);
    if (!currentHq) return null;
  }

  let slotPolicy: AttendanceMonthlyMatrixSlotPolicySummaryProjection = {
    current_policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
    latest_policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
    month_policies: [DEFAULT_ATTENDANCE_SLOT_POLICY],
  };
  if (hasSlotPolicyKey) {
    const projectedPolicySummary = projectSlotPolicySummary(value.slot_policy);
    if (!projectedPolicySummary) return null;
    slotPolicy = projectedPolicySummary;
  }

  if (!Array.isArray(value.branch_options) || !Array.isArray(value.employee_options)) {
    return null;
  }
  const branchOptions: AttendanceBranchOptionProjection[] = [];
  for (const rawOpt of value.branch_options) {
    const projectedOpt = projectBranchOption(rawOpt);
    if (!projectedOpt) return null;
    branchOptions.push(projectedOpt);
  }

  const employeeOptions: AttendanceMonthlyMatrixEmployeeOptionProjection[] = [];
  for (const rawOpt of value.employee_options) {
    const projectedOpt = projectEmployeeOption(rawOpt);
    if (!projectedOpt) return null;
    employeeOptions.push(projectedOpt);
  }

  const overview = projectOverview(value.overview);
  if (!overview) return null;

  const pagination = projectPagination(value.pagination);
  if (!pagination) return null;

  if (!Array.isArray(value.items)) return null;
  const items: AttendanceMonthlyMatrixEmployeeRowProjection[] = [];
  for (const rawItem of value.items) {
    const projectedItem = projectEmployeeRow(rawItem, value.days_in_month);
    if (!projectedItem) return null;
    items.push(projectedItem);
  }

  return {
    viewer: {
      can_configure_hq: value.viewer.can_configure_hq,
      can_manage_branches: value.viewer.can_manage_branches,
      can_manage_slot_policy: viewerHasSlotFlag
        ? (value.viewer.can_manage_slot_policy as boolean)
        : value.viewer.can_configure_hq,
    },
    filters: {
      year_month: filters.year_month,
      from_date: filters.from_date,
      to_date: filters.to_date,
      branch_id: filters.branch_id === null ? null : filters.branch_id.toLowerCase(),
      employee_id: filters.employee_id === null ? null : filters.employee_id.toLowerCase(),
      search: filters.search,
      timezone: ATTENDANCE_BUSINESS_TIMEZONE,
    },
    days_in_month: value.days_in_month,
    calendar_days: calendarDays,
    current_hq: currentHq,
    slot_policy: slotPolicy,
    branch_options: branchOptions,
    employee_options: employeeOptions,
    overview,
    pagination,
    items,
  };
}

export function projectAttendanceSlotPoliciesAdminList(
  value: unknown,
): AttendanceSlotPoliciesAdminListProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "viewer",
      "business_date",
      "current_policy",
      "latest_policy",
      "versions",
    ])
  ) {
    return null;
  }
  if (
    !isRecord(value.viewer) ||
    !hasExactKeys(value.viewer, ["can_manage_slot_policy"]) ||
    typeof value.viewer.can_manage_slot_policy !== "boolean" ||
    typeof value.business_date !== "string" ||
    !isValidIsoCalendarDate(value.business_date) ||
    !Array.isArray(value.versions) ||
    value.versions.length < 1
  ) {
    return null;
  }

  const currentPolicy = projectAttendanceSlotPolicy(value.current_policy);
  const latestPolicy = projectAttendanceSlotPolicy(value.latest_policy);
  if (!currentPolicy || !latestPolicy) {
    return null;
  }

  const versions: AttendanceSlotPolicyProjection[] = [];
  for (const raw of value.versions) {
    const projected = projectAttendanceSlotPolicy(raw);
    if (!projected) return null;
    versions.push(projected);
  }

  return {
    viewer: {
      can_manage_slot_policy: value.viewer.can_manage_slot_policy,
    },
    business_date: value.business_date,
    current_policy: currentPolicy,
    latest_policy: latestPolicy,
    versions,
  };
}

export function projectCreateSlotPolicyResult(
  value: unknown,
): CreateAttendanceSlotPolicyResultProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["replayed", "policy"]) ||
    typeof value.replayed !== "boolean"
  ) {
    return null;
  }
  const policy = projectAttendanceSlotPolicy(value.policy);
  if (!policy) return null;

  return {
    replayed: value.replayed,
    policy,
  };
}

export function projectAttendanceBranchesAdminList(
  value: unknown,
): AttendanceBranchesAdminListProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "viewer",
      "business_date",
      "include_inactive",
      "branches",
      "assignments",
      "employee_options",
    ])
  ) {
    return null;
  }
  if (
    !isRecord(value.viewer) ||
    !hasExactKeys(value.viewer, ["can_manage_branches"]) ||
    typeof value.viewer.can_manage_branches !== "boolean" ||
    typeof value.business_date !== "string" ||
    !isValidIsoCalendarDate(value.business_date) ||
    typeof value.include_inactive !== "boolean" ||
    !Array.isArray(value.branches) ||
    !Array.isArray(value.assignments) ||
    !Array.isArray(value.employee_options)
  ) {
    return null;
  }

  const branches: AttendanceBranchAdminItemProjection[] = [];
  for (const raw of value.branches) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, [
        "branch_id",
        "branch_code",
        "display_name",
        "address",
        "latitude",
        "longitude",
        "active",
        "version",
        "active_assignment_count",
        "created_at",
        "updated_at",
        "updated_by_display_name",
      ]) ||
      !isUuidString(raw.branch_id) ||
      typeof raw.branch_code !== "string" ||
      !BRANCH_CODE_PATTERN.test(raw.branch_code) ||
      typeof raw.display_name !== "string" ||
      raw.display_name.trim().length === 0 ||
      typeof raw.address !== "string" ||
      typeof raw.active !== "boolean" ||
      typeof raw.version !== "number" ||
      !Number.isSafeInteger(raw.version) ||
      raw.version < 1 ||
      typeof raw.active_assignment_count !== "number" ||
      !Number.isSafeInteger(raw.active_assignment_count) ||
      raw.active_assignment_count < 0 ||
      typeof raw.created_at !== "string" ||
      typeof raw.updated_at !== "string" ||
      typeof raw.updated_by_display_name !== "string" ||
      (raw.latitude === null) !== (raw.longitude === null)
    ) {
      return null;
    }
    if (
      raw.latitude !== null &&
      (!isFiniteNumber(raw.latitude) || raw.latitude < -90 || raw.latitude > 90)
    ) {
      return null;
    }
    if (
      raw.longitude !== null &&
      (!isFiniteNumber(raw.longitude) || raw.longitude < -180 || raw.longitude > 180)
    ) {
      return null;
    }
    branches.push({
      branch_id: raw.branch_id.toLowerCase(),
      branch_code: raw.branch_code,
      display_name: raw.display_name,
      address: raw.address,
      latitude: raw.latitude === null ? null : normalizeZero(raw.latitude),
      longitude: raw.longitude === null ? null : normalizeZero(raw.longitude),
      active: raw.active,
      version: raw.version,
      active_assignment_count: raw.active_assignment_count,
      created_at: raw.created_at,
      updated_at: raw.updated_at,
      updated_by_display_name: raw.updated_by_display_name,
    });
  }

  const assignments: AttendanceBranchAssignmentAdminItemProjection[] = [];
  for (const raw of value.assignments) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, [
        "assignment_id",
        "app_user_id",
        "employee_display_name",
        "personnel_code",
        "branch_id",
        "branch_code",
        "branch_name",
        "valid_from",
        "valid_to",
        "effective",
        "version",
        "created_at",
        "updated_at",
      ]) ||
      !isUuidString(raw.assignment_id) ||
      !isUuidString(raw.app_user_id) ||
      typeof raw.employee_display_name !== "string" ||
      (raw.personnel_code !== null && typeof raw.personnel_code !== "string") ||
      !isUuidString(raw.branch_id) ||
      typeof raw.branch_code !== "string" ||
      typeof raw.branch_name !== "string" ||
      typeof raw.valid_from !== "string" ||
      !isValidIsoCalendarDate(raw.valid_from) ||
      (raw.valid_to !== null &&
        (typeof raw.valid_to !== "string" || !isValidIsoCalendarDate(raw.valid_to))) ||
      typeof raw.effective !== "boolean" ||
      typeof raw.version !== "number" ||
      !Number.isSafeInteger(raw.version) ||
      raw.version < 1 ||
      typeof raw.created_at !== "string" ||
      typeof raw.updated_at !== "string"
    ) {
      return null;
    }
    assignments.push({
      assignment_id: raw.assignment_id.toLowerCase(),
      app_user_id: raw.app_user_id.toLowerCase(),
      employee_display_name: raw.employee_display_name,
      personnel_code: raw.personnel_code,
      branch_id: raw.branch_id.toLowerCase(),
      branch_code: raw.branch_code,
      branch_name: raw.branch_name,
      valid_from: raw.valid_from,
      valid_to: raw.valid_to,
      effective: raw.effective,
      version: raw.version,
      created_at: raw.created_at,
      updated_at: raw.updated_at,
    });
  }

  const employeeOptions: AttendanceBranchAdminEmployeeOptionProjection[] = [];
  for (const raw of value.employee_options) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["app_user_id", "display_name", "personnel_code", "enabled"]) ||
      !isUuidString(raw.app_user_id) ||
      typeof raw.display_name !== "string" ||
      (raw.personnel_code !== null && typeof raw.personnel_code !== "string") ||
      typeof raw.enabled !== "boolean"
    ) {
      return null;
    }
    employeeOptions.push({
      app_user_id: raw.app_user_id.toLowerCase(),
      display_name: raw.display_name,
      personnel_code: raw.personnel_code,
      enabled: raw.enabled,
    });
  }

  return {
    viewer: {
      can_manage_branches: value.viewer.can_manage_branches,
    },
    business_date: value.business_date,
    include_inactive: value.include_inactive,
    branches,
    assignments,
    employee_options: employeeOptions,
  };
}

export function projectUpsertBranchResult(
  value: unknown,
): UpsertAttendanceBranchResultProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, ["replayed", "branch"])) {
    return null;
  }
  if (typeof value.replayed !== "boolean" || !isRecord(value.branch)) {
    return null;
  }
  const b = value.branch;
  if (
    !hasExactKeys(b, [
      "branch_id",
      "branch_code",
      "display_name",
      "address",
      "latitude",
      "longitude",
      "active",
      "version",
      "updated_at",
      "updated_by_display_name",
    ]) ||
    !isUuidString(b.branch_id) ||
    typeof b.branch_code !== "string" ||
    !BRANCH_CODE_PATTERN.test(b.branch_code) ||
    typeof b.display_name !== "string" ||
    b.display_name.trim().length === 0 ||
    typeof b.address !== "string" ||
    typeof b.active !== "boolean" ||
    typeof b.version !== "number" ||
    !Number.isSafeInteger(b.version) ||
    b.version < 1 ||
    typeof b.updated_at !== "string" ||
    typeof b.updated_by_display_name !== "string" ||
    (b.latitude === null) !== (b.longitude === null)
  ) {
    return null;
  }
  if (
    b.latitude !== null &&
    (!isFiniteNumber(b.latitude) || b.latitude < -90 || b.latitude > 90)
  ) {
    return null;
  }
  if (
    b.longitude !== null &&
    (!isFiniteNumber(b.longitude) || b.longitude < -180 || b.longitude > 180)
  ) {
    return null;
  }
  return {
    replayed: value.replayed,
    branch: {
      branch_id: b.branch_id.toLowerCase(),
      branch_code: b.branch_code,
      display_name: b.display_name,
      address: b.address,
      latitude: b.latitude === null ? null : normalizeZero(b.latitude),
      longitude: b.longitude === null ? null : normalizeZero(b.longitude),
      active: b.active,
      version: b.version,
      updated_at: b.updated_at,
      updated_by_display_name: b.updated_by_display_name,
    },
  };
}

export function projectAssignBranchResult(
  value: unknown,
): AssignAttendanceBranchResultProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, ["replayed", "assignment"])) {
    return null;
  }
  if (typeof value.replayed !== "boolean" || !isRecord(value.assignment)) {
    return null;
  }
  const a = value.assignment;
  if (
    !hasExactKeys(a, [
      "assignment_id",
      "app_user_id",
      "branch_id",
      "branch_code",
      "branch_name",
      "valid_from",
      "valid_to",
      "version",
    ]) ||
    !isUuidString(a.assignment_id) ||
    !isUuidString(a.app_user_id) ||
    !isUuidString(a.branch_id) ||
    typeof a.branch_code !== "string" ||
    typeof a.branch_name !== "string" ||
    typeof a.valid_from !== "string" ||
    !isValidIsoCalendarDate(a.valid_from) ||
    (a.valid_to !== null &&
      (typeof a.valid_to !== "string" || !isValidIsoCalendarDate(a.valid_to))) ||
    typeof a.version !== "number" ||
    !Number.isSafeInteger(a.version) ||
    a.version < 1
  ) {
    return null;
  }
  return {
    replayed: value.replayed,
    assignment: {
      assignment_id: a.assignment_id.toLowerCase(),
      app_user_id: a.app_user_id.toLowerCase(),
      branch_id: a.branch_id.toLowerCase(),
      branch_code: a.branch_code,
      branch_name: a.branch_name,
      valid_from: a.valid_from,
      valid_to: a.valid_to,
      version: a.version,
    },
  };
}

export function projectUnassignBranchResult(
  value: unknown,
): UnassignAttendanceBranchResultProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, ["replayed", "assignment"])) {
    return null;
  }
  if (typeof value.replayed !== "boolean" || !isRecord(value.assignment)) {
    return null;
  }
  const a = value.assignment;
  if (
    !hasExactKeys(a, [
      "assignment_id",
      "app_user_id",
      "branch_id",
      "valid_from",
      "valid_to",
      "version",
    ]) ||
    !isUuidString(a.assignment_id) ||
    !isUuidString(a.app_user_id) ||
    !isUuidString(a.branch_id) ||
    typeof a.valid_from !== "string" ||
    !isValidIsoCalendarDate(a.valid_from) ||
    (a.valid_to !== null &&
      (typeof a.valid_to !== "string" || !isValidIsoCalendarDate(a.valid_to))) ||
    typeof a.version !== "number" ||
    !Number.isSafeInteger(a.version) ||
    a.version < 1
  ) {
    return null;
  }
  return {
    replayed: value.replayed,
    assignment: {
      assignment_id: a.assignment_id.toLowerCase(),
      app_user_id: a.app_user_id.toLowerCase(),
      branch_id: a.branch_id.toLowerCase(),
      valid_from: a.valid_from,
      valid_to: a.valid_to,
      version: a.version,
    },
  };
}
