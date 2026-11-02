import {
  ATTENDANCE_BUSINESS_TIMEZONE,
  ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE,
  ATTENDANCE_REPORT_MAX_SEARCH_LENGTH,
  isValidIsoCalendarDate,
  type AttendanceDistanceStatus,
} from "./attendance-report-contract.ts";
import {
  ATTENDANCE_MONTHLY_MATRIX_EXPORT_ROW_LIMIT,
  isValidYearMonth,
  type AttendanceBranchAssignmentAdminItemProjection,
  type AttendanceDistanceTargetKind,
  type AttendanceMatrixLeaveSessionCode,
  type AttendanceMatrixLeaveType,
  type AttendanceMonthlyMatrixDayCellProjection,
  type AttendanceMonthlyMatrixDayStatus,
} from "./attendance-monthly-matrix-contract.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BRANCH_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._:-]{0,63}$/;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const ADDRESS_CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export type AttendanceAdminWorkspaceTab = "checkins" | "monthly-matrix" | "branches";

export type MatrixEmployeeFilterMode = "employee" | "search";

export const MATRIX_WEEKDAY_LABELS: Readonly<Record<number, string>> = {
  1: "T2",
  2: "T3",
  3: "T4",
  4: "T5",
  5: "T6",
  6: "T7",
  7: "CN",
};

export const MATRIX_LEAVE_TYPE_LABELS: Readonly<Record<AttendanceMatrixLeaveType, string>> = {
  ANNUAL: "Phép năm",
  MATERNITY: "Thai sản",
  UNPAID: "Không lương",
};

export const MATRIX_LEAVE_SESSION_LABELS: Readonly<
  Record<AttendanceMatrixLeaveSessionCode, string>
> = {
  FULL: "Cả ngày",
  AM: "Sáng",
  PM: "Chiều",
};

export const MATRIX_DAY_STATUS_LABELS: Readonly<Record<AttendanceMonthlyMatrixDayStatus, string>> =
  {
    CHECKED_IN: "Có check-in",
    APPROVED_LEAVE: "Nghỉ phép đã duyệt",
    CHECKED_IN_AND_LEAVE: "Có check-in & Nghỉ phép",
    NO_CHECKIN: "Chưa có check-in",
  };

export type MatrixDayCellTone = "emerald" | "red" | "amber";

export type MatrixLeaveBadgeView = {
  requestId: string;
  leaveType: AttendanceMatrixLeaveType;
  leaveTypeLabel: string;
  sessionCode: AttendanceMatrixLeaveSessionCode;
  sessionLabel: string;
  halfDayUnits: number;
  label: string;
};

export type MatrixDayCellPresentation = {
  dayStatus: AttendanceMonthlyMatrixDayStatus;
  statusLabel: string;
  tone: MatrixDayCellTone;
  isRedHighlight: boolean;
  hasCheckin: boolean;
  checkinCount: number;
  timeRangeLabel: string | null;
  verificationLabel: string | null;
  distanceLabel: string | null;
  targetBadgeLabel: string | null;
  hasApprovedLeave: boolean;
  approvedLeaveUnits: number;
  leaveBadges: MatrixLeaveBadgeView[];
};

export function getVietnamCurrentYearMonth(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "2026";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

export function getVietnamTodayIsoDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Builds a Google Maps search URL when both latitude and longitude are valid finite numbers.
 * Returns null if either coordinate is missing, NaN, or infinite.
 */
export function buildGoogleMapsCoordinatesUrl(
  latitude: unknown,
  longitude: unknown,
): string | null {
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  const normalizedLat = Object.is(latitude, -0) ? 0 : latitude;
  const normalizedLon = Object.is(longitude, -0) ? 0 : longitude;
  return `https://www.google.com/maps/search/?api=1&query=${normalizedLat},${normalizedLon}`;
}

/**
 * Enforces mutual exclusion between employee_id and search.
 * Never sends both employee_id and search at the same time.
 */
export function resolveMutualExclusiveEmployeeOrSearch(input: {
  filterMode?: MatrixEmployeeFilterMode;
  employeeId?: string | null;
  search?: string | null;
}): { employeeId: string | null; search: string | null } {
  const trimmedEmployeeId = typeof input.employeeId === "string" ? input.employeeId.trim() : "";
  const trimmedSearch = typeof input.search === "string" ? input.search.trim() : "";

  if (input.filterMode === "employee") {
    return {
      employeeId: trimmedEmployeeId.length > 0 ? trimmedEmployeeId : null,
      search: null,
    };
  }
  if (input.filterMode === "search") {
    return {
      employeeId: null,
      search: trimmedSearch.length > 0 ? trimmedSearch : null,
    };
  }
  if (trimmedEmployeeId.length > 0) {
    return { employeeId: trimmedEmployeeId, search: null };
  }
  if (trimmedSearch.length > 0) {
    return { employeeId: null, search: trimmedSearch };
  }
  return { employeeId: null, search: null };
}

export function buildMonthlyMatrixReportQuery(input: {
  yearMonth: string;
  branchId?: string | null;
  filterMode?: MatrixEmployeeFilterMode;
  employeeId?: string | null;
  search?: string | null;
  page?: number;
  pageSize?: number;
}): string {
  const params = new URLSearchParams();
  const trimmedMonth = input.yearMonth.trim();
  if (trimmedMonth.length > 0) {
    params.set("year_month", trimmedMonth);
  }
  const trimmedBranch = typeof input.branchId === "string" ? input.branchId.trim() : "";
  if (trimmedBranch.length > 0) {
    params.set("branch_id", trimmedBranch);
  }

  const { employeeId, search } = resolveMutualExclusiveEmployeeOrSearch(input);
  if (employeeId !== null) {
    params.set("employee_id", employeeId);
  } else if (search !== null) {
    params.set("search", search);
  }

  const safePage =
    typeof input.page === "number" && Number.isSafeInteger(input.page) && input.page >= 1
      ? input.page
      : 1;
  const safePageSize =
    typeof input.pageSize === "number" &&
    Number.isSafeInteger(input.pageSize) &&
    input.pageSize >= 1
      ? input.pageSize
      : ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE;

  params.set("page", String(safePage));
  params.set("page_size", String(safePageSize));
  return params.toString();
}

export function buildMonthlyMatrixExportUrl(input: {
  yearMonth: string;
  branchId?: string | null;
  filterMode?: MatrixEmployeeFilterMode;
  employeeId?: string | null;
  search?: string | null;
}): string {
  const params = new URLSearchParams();
  const trimmedMonth = input.yearMonth.trim();
  if (trimmedMonth.length > 0) {
    params.set("year_month", trimmedMonth);
  }
  const trimmedBranch = typeof input.branchId === "string" ? input.branchId.trim() : "";
  if (trimmedBranch.length > 0) {
    params.set("branch_id", trimmedBranch);
  }

  const { employeeId, search } = resolveMutualExclusiveEmployeeOrSearch(input);
  if (employeeId !== null) {
    params.set("employee_id", employeeId);
  } else if (search !== null) {
    params.set("search", search);
  }

  const query = params.toString();
  return query.length > 0
    ? `/api/admin/attendance/monthly-matrix/export?${query}`
    : "/api/admin/attendance/monthly-matrix/export";
}

export function formatMatrixWeekdayLabel(dayOfWeek: number): string {
  return MATRIX_WEEKDAY_LABELS[dayOfWeek] ?? `T${dayOfWeek}`;
}

export function formatMatrixDistanceTargetLabel(
  kind: AttendanceDistanceTargetKind | null,
  branchCodeUsed: string | null,
): string | null {
  if (kind === "BRANCH") {
    return branchCodeUsed ? `CN: ${branchCodeUsed}` : "Chi nhánh";
  }
  if (kind === "HQ") {
    return "HQ";
  }
  return null;
}

export function formatMatrixDistanceStatusLabel(
  status: AttendanceDistanceStatus | null,
  distanceMeters: number | null,
  targetKind: AttendanceDistanceTargetKind | null,
  branchCodeUsed: string | null,
): string | null {
  if (!status) return null;
  const prefix = formatMatrixDistanceTargetLabel(targetKind, branchCodeUsed);
  const withPrefix = (detail: string) => (prefix ? `${prefix} · ${detail}` : detail);

  if (status === "COMPUTED" && typeof distanceMeters === "number" && Number.isFinite(distanceMeters)) {
    const distanceText =
      distanceMeters >= 1000
        ? `${(distanceMeters / 1000).toFixed(2)} km`
        : `${Math.round(distanceMeters)} m`;
    return withPrefix(distanceText);
  }
  if (status === "BRANCH_NOT_CONFIGURED") {
    return withPrefix("Chi nhánh chưa cấu hình tọa độ");
  }
  if (status === "HQ_NOT_CONFIGURED") {
    return withPrefix("HQ chưa cấu hình tọa độ");
  }
  if (status === "INVALID_GPS") {
    return withPrefix("GPS không hợp lệ");
  }
  return null;
}

export function describeMatrixDayCell(
  cell: AttendanceMonthlyMatrixDayCellProjection,
): MatrixDayCellPresentation {
  const statusLabel = MATRIX_DAY_STATUS_LABELS[cell.day_status];
  const tone: MatrixDayCellTone =
    cell.day_status === "NO_CHECKIN" || cell.day_status === "APPROVED_LEAVE"
      ? "red"
      : cell.day_status === "CHECKED_IN_AND_LEAVE"
        ? "amber"
        : "emerald";

  let timeRangeLabel: string | null = null;
  let verificationLabel: string | null = null;
  if (cell.has_checkin) {
    const first = cell.first_time_local ?? "--:--";
    const last = cell.last_time_local ?? first;
    timeRangeLabel =
      cell.checkin_count > 1 && last !== first
        ? `${first} – ${last} (${cell.checkin_count} lượt)`
        : cell.checkin_count > 1
          ? `${first} (${cell.checkin_count} lượt)`
          : `${first} (1 lượt)`;

    if (cell.unverified_checkin_count === 0 && cell.verified_checkin_count > 0) {
      verificationLabel = `Đã xác thực (${cell.verified_checkin_count}/${cell.checkin_count})`;
    } else if (cell.verified_checkin_count > 0 && cell.unverified_checkin_count > 0) {
      verificationLabel = `Xác thực ${cell.verified_checkin_count}/${cell.checkin_count}`;
    } else {
      verificationLabel = `Chưa xác thực (${cell.unverified_checkin_count})`;
    }
  }

  const targetBadgeLabel = formatMatrixDistanceTargetLabel(
    cell.distance_target_kind,
    cell.branch_code_used,
  );
  const distanceLabel = cell.has_checkin
    ? formatMatrixDistanceStatusLabel(
        cell.distance_status,
        cell.distance_meters,
        cell.distance_target_kind,
        cell.branch_code_used,
      )
    : null;

  const leaveBadges: MatrixLeaveBadgeView[] = cell.approved_leaves.map((item) => {
    const leaveTypeLabel = MATRIX_LEAVE_TYPE_LABELS[item.leave_type] ?? item.leave_type;
    const sessionLabel = MATRIX_LEAVE_SESSION_LABELS[item.session_code] ?? item.session_code;
    return {
      requestId: item.request_id,
      leaveType: item.leave_type,
      leaveTypeLabel,
      sessionCode: item.session_code,
      sessionLabel,
      halfDayUnits: item.half_day_units,
      label: `${leaveTypeLabel} (${sessionLabel})`,
    };
  });

  return {
    dayStatus: cell.day_status,
    statusLabel,
    tone,
    isRedHighlight: tone === "red",
    hasCheckin: cell.has_checkin,
    checkinCount: cell.checkin_count,
    timeRangeLabel,
    verificationLabel,
    distanceLabel,
    targetBadgeLabel,
    hasApprovedLeave: cell.has_approved_leave,
    approvedLeaveUnits: cell.approved_leave_units,
    leaveBadges,
  };
}

export function validateMonthlyMatrixFilters(input: {
  yearMonth: string;
  filterMode: MatrixEmployeeFilterMode;
  employeeId: string;
  search: string;
}): string | null {
  const trimmedMonth = input.yearMonth.trim();
  if (!isValidYearMonth(trimmedMonth)) {
    return "Tháng báo cáo phải đúng định dạng YYYY-MM (năm từ 2000 đến 2100).";
  }
  if (input.filterMode === "employee" && input.employeeId.trim() !== "") {
    if (!UUID_PATTERN.test(input.employeeId.trim())) {
      return "Nhân sự được chọn không hợp lệ.";
    }
  }
  if (input.filterMode === "search" && input.search.trim() !== "") {
    const trimmedSearch = input.search.trim();
    if (
      trimmedSearch.length > 100 ||
      trimmedSearch.length > ATTENDANCE_REPORT_MAX_SEARCH_LENGTH ||
      CONTROL_CHAR_PATTERN.test(trimmedSearch)
    ) {
      return "Từ khóa tìm kiếm tối đa 100 ký tự và không chứa ký tự điều khiển.";
    }
  }
  return null;
}

export function mapMonthlyMatrixReportError(status: number, code: string | null): string {
  if (status === 401 || code === "UNAUTHENTICATED") {
    return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
  }
  if (status === 403 || code === "ATTENDANCE_REPORT_ACCESS_DENIED") {
    return "Tài khoản hiện tại không có quyền xem báo cáo ma trận chấm công tháng.";
  }
  if (code === "ATTENDANCE_MATRIX_MONTH_INVALID") {
    return "Tháng báo cáo không hợp lệ (định dạng YYYY-MM).";
  }
  if (code === "ATTENDANCE_REPORT_FILTER_CONFLICT") {
    return "Chỉ được lọc theo nhân sự cụ thể hoặc tìm kiếm từ khóa, không gửi đồng thời cả hai.";
  }
  if (code === "ATTENDANCE_REPORT_BRANCH_INVALID") {
    return "Chi nhánh lọc không hợp lệ.";
  }
  if (code === "ATTENDANCE_REPORT_EMPLOYEE_INVALID") {
    return "Nhân sự lọc không hợp lệ.";
  }
  if (code === "ATTENDANCE_REPORT_SEARCH_INVALID") {
    return "Từ khóa tìm kiếm không hợp lệ (tối đa 100 ký tự).";
  }
  return "Không thể tải báo cáo ma trận chấm công tháng lúc này. Vui lòng thử lại.";
}

export function mapMonthlyMatrixExportError(status: number, code: string | null): string {
  if (status === 422 || code === "ATTENDANCE_MATRIX_EXPORT_ROW_LIMIT_EXCEEDED") {
    return `Báo cáo vượt giới hạn xuất tối đa ${ATTENDANCE_MONTHLY_MATRIX_EXPORT_ROW_LIMIT.toLocaleString("vi-VN")} nhân viên. Vui lòng lọc theo chi nhánh hoặc từ khóa tìm kiếm trước khi xuất Excel.`;
  }
  if (status === 409 || code === "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE") {
    return "Dữ liệu chấm công hoặc nghỉ phép vừa thay đổi trong lúc xuất tệp. Vui lòng bấm Xuất Excel để thử lại.";
  }
  if (status === 401 || code === "UNAUTHENTICATED") {
    return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
  }
  if (status === 403 || code === "ATTENDANCE_REPORT_ACCESS_DENIED") {
    return "Tài khoản hiện tại không có quyền xuất Excel báo cáo ma trận chấm công.";
  }
  if (code === "ATTENDANCE_REPORT_FILTER_CONFLICT") {
    return "Bộ lọc xuất báo cáo không hợp lệ (không gửi đồng thời mã nhân sự và từ khóa tìm kiếm).";
  }
  return "Không thể xuất tệp Excel ma trận chấm công lúc này. Vui lòng thử lại.";
}

export type BranchMutationPayloadResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string };

export function buildUpsertBranchPayload(input: {
  branchCode: string;
  displayName: string;
  address: string;
  latitudeInput: string;
  longitudeInput: string;
  active: boolean;
  expectedVersion: number;
  idempotencyKey: string;
}): BranchMutationPayloadResult {
  const branchCode = input.branchCode.trim().toUpperCase();
  if (!BRANCH_CODE_PATTERN.test(branchCode)) {
    return {
      ok: false,
      message:
        "Mã chi nhánh phải bắt đầu bằng chữ in hoa hoặc số, chỉ gồm A-Z, 0-9, ., _, :, - (tối đa 64 ký tự).",
    };
  }

  const displayName = input.displayName.trim();
  if (
    displayName.length < 1 ||
    displayName.length > 256 ||
    CONTROL_CHAR_PATTERN.test(displayName)
  ) {
    return {
      ok: false,
      message: "Tên chi nhánh bắt buộc (1–256 ký tự) và không chứa ký tự điều khiển.",
    };
  }

  const address = input.address.trim();
  if (address.length > 500 || ADDRESS_CONTROL_CHAR_PATTERN.test(address)) {
    return {
      ok: false,
      message: "Địa chỉ chi nhánh tối đa 500 ký tự và không chứa ký tự điều khiển.",
    };
  }

  const rawLat = input.latitudeInput.trim();
  const rawLon = input.longitudeInput.trim();
  if ((rawLat === "") !== (rawLon === "")) {
    return {
      ok: false,
      message: "Vĩ độ và kinh độ chi nhánh phải cùng nhập hoặc cùng để trống.",
    };
  }

  let latitude: number | null = null;
  let longitude: number | null = null;
  if (rawLat !== "" && rawLon !== "") {
    const parsedLat = Number(rawLat);
    const parsedLon = Number(rawLon);
    if (!Number.isFinite(parsedLat) || parsedLat < -90 || parsedLat > 90) {
      return { ok: false, message: "Vĩ độ chi nhánh phải nằm trong khoảng từ -90 đến 90." };
    }
    if (!Number.isFinite(parsedLon) || parsedLon < -180 || parsedLon > 180) {
      return { ok: false, message: "Kinh độ chi nhánh phải nằm trong khoảng từ -180 đến 180." };
    }
    latitude = Object.is(parsedLat, -0) ? 0 : parsedLat;
    longitude = Object.is(parsedLon, -0) ? 0 : parsedLon;
  }

  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    return { ok: false, message: "Phiên bản dữ liệu chi nhánh không hợp lệ. Vui lòng tải lại." };
  }

  const key = input.idempotencyKey.trim().toLowerCase();
  if (!UUID_PATTERN.test(key)) {
    return { ok: false, message: "Khóa chống gửi trùng (idempotency_key) không hợp lệ." };
  }

  return {
    ok: true,
    body: {
      branch_code: branchCode,
      display_name: displayName,
      address,
      latitude,
      longitude,
      active: Boolean(input.active),
      expected_version: input.expectedVersion,
      idempotency_key: key,
    },
  };
}

export function buildAssignEmployeeToBranchPayload(input: {
  appUserId: string;
  branch: { branch_id: string; active: boolean; version: number } | null;
  validFrom: string;
  idempotencyKey: string;
}): BranchMutationPayloadResult {
  const userId = input.appUserId.trim().toLowerCase();
  if (!UUID_PATTERN.test(userId)) {
    return { ok: false, message: "Vui lòng chọn nhân viên hợp lệ để phân công chi nhánh." };
  }
  if (!input.branch || !UUID_PATTERN.test(input.branch.branch_id)) {
    return { ok: false, message: "Vui lòng chọn chi nhánh HRP hợp lệ." };
  }
  if (!input.branch.active) {
    return {
      ok: false,
      message: "Không thể gán nhân viên mới vào chi nhánh đã ngừng hoạt động.",
    };
  }
  if (
    typeof input.branch.version !== "number" ||
    !Number.isSafeInteger(input.branch.version) ||
    input.branch.version < 1
  ) {
    return { ok: false, message: "Phiên bản chi nhánh không hợp lệ. Vui lòng tải lại." };
  }

  const trimmedValidFrom = input.validFrom.trim();
  let validFrom: string | null = null;
  if (trimmedValidFrom !== "") {
    if (!isValidIsoCalendarDate(trimmedValidFrom)) {
      return { ok: false, message: "Ngày bắt đầu hiệu lực phải đúng định dạng YYYY-MM-DD." };
    }
    validFrom = trimmedValidFrom;
  }

  const key = input.idempotencyKey.trim().toLowerCase();
  if (!UUID_PATTERN.test(key)) {
    return { ok: false, message: "Khóa chống gửi trùng (idempotency_key) không hợp lệ." };
  }

  return {
    ok: true,
    body: {
      app_user_id: userId,
      branch_id: input.branch.branch_id.toLowerCase(),
      valid_from: validFrom,
      expected_version: input.branch.version,
      idempotency_key: key,
    },
  };
}

export function buildUnassignEmployeeFromBranchPayload(input: {
  validTo: string;
  expectedVersion: number;
  idempotencyKey: string;
}): BranchMutationPayloadResult {
  const trimmedValidTo = input.validTo.trim();
  let validTo: string | null = null;
  if (trimmedValidTo !== "") {
    if (!isValidIsoCalendarDate(trimmedValidTo)) {
      return { ok: false, message: "Ngày kết thúc hiệu lực phải đúng định dạng YYYY-MM-DD." };
    }
    validTo = trimmedValidTo;
  }

  if (
    typeof input.expectedVersion !== "number" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    return { ok: false, message: "Phiên bản phân công không hợp lệ. Vui lòng tải lại." };
  }

  const key = input.idempotencyKey.trim().toLowerCase();
  if (!UUID_PATTERN.test(key)) {
    return { ok: false, message: "Khóa chống gửi trùng (idempotency_key) không hợp lệ." };
  }

  return {
    ok: true,
    body: {
      valid_to: validTo,
      expected_version: input.expectedVersion,
      idempotency_key: key,
    },
  };
}

export function mapBranchAdminMutationError(
  status: number,
  code: string | null,
): { isConflict: boolean; message: string } {
  if (code === "ATTENDANCE_BRANCH_CODE_CONFLICT") {
    return {
      isConflict: true,
      message: "Mã chi nhánh HRP đã tồn tại. Vui lòng dùng mã khác hoặc tải lại danh sách.",
    };
  }
  if (code === "ATTENDANCE_BRANCH_VERSION_CONFLICT") {
    return {
      isConflict: true,
      message:
        "Chi nhánh đã được cập nhật ở phiên khác (xung đột phiên bản). Vui lòng tải lại dữ liệu trước khi tiếp tục.",
    };
  }
  if (code === "ATTENDANCE_BRANCH_INACTIVE") {
    return {
      isConflict: false,
      message: "Chi nhánh đang ngừng hoạt động nên không thể gán nhân viên mới.",
    };
  }
  if (code === "ATTENDANCE_BRANCH_TARGET_USER_INVALID") {
    return {
      isConflict: false,
      message: "Nhân viên được chọn không hợp lệ hoặc không thuộc diện chấm công HRP.",
    };
  }
  if (code === "ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP") {
    return {
      isConflict: true,
      message:
        "Khoảng thời gian hiệu lực bị chồng lấn với một phân công chi nhánh khác của nhân viên này.",
    };
  }
  if (code === "ATTENDANCE_BRANCH_ASSIGNMENT_ALREADY_CLOSED") {
    return {
      isConflict: true,
      message: "Phân công chi nhánh này đã kết thúc trước đó. Vui lòng tải lại danh sách.",
    };
  }
  if (code === "ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID") {
    return {
      isConflict: false,
      message: "Khoảng ngày hiệu lực không hợp lệ (ngày kết thúc phải từ ngày bắt đầu trở đi).",
    };
  }
  if (code === "ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT") {
    return {
      isConflict: true,
      message:
        "Phân công chi nhánh đã được cập nhật ở phiên khác. Vui lòng tải lại dữ liệu trước khi tiếp tục.",
    };
  }
  if (code === "IDEMPOTENCY_CONFLICT") {
    return {
      isConflict: true,
      message: "Thao tác bị trùng khóa xử lý (Idempotency). Vui lòng tải lại dữ liệu.",
    };
  }
  if (status === 403 || code === "ATTENDANCE_BRANCH_WRITE_DENIED") {
    return {
      isConflict: false,
      message: "Tài khoản hiện tại chỉ có quyền xem, không có quyền quản trị chi nhánh HRP.",
    };
  }
  if (status === 401 || code === "UNAUTHENTICATED") {
    return {
      isConflict: false,
      message: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
    };
  }
  if (status === 404 || code === "ATTENDANCE_BRANCH_NOT_FOUND" || code === "ATTENDANCE_BRANCH_ASSIGNMENT_NOT_FOUND") {
    return {
      isConflict: true,
      message: "Không tìm thấy chi nhánh hoặc bản ghi phân công. Vui lòng tải lại danh sách.",
    };
  }
  if (status === 409) {
    return {
      isConflict: true,
      message: "Dữ liệu đã thay đổi ở nơi khác. Vui lòng tải lại trước khi thao tác tiếp.",
    };
  }
  return {
    isConflict: false,
    message: "Không thể lưu thay đổi chi nhánh HRP lúc này. Vui lòng thử lại.",
  };
}

export function describeBranchAssignmentStatus(
  assignment: Pick<
    AttendanceBranchAssignmentAdminItemProjection,
    "effective" | "valid_from" | "valid_to"
  >,
): {
  statusLabel: string;
  rangeLabel: string;
  canUnassign: boolean;
  tone: "emerald" | "amber" | "slate";
} {
  if (assignment.valid_to !== null) {
    return {
      statusLabel: "Đã kết thúc",
      rangeLabel: `${assignment.valid_from} → ${assignment.valid_to}`,
      canUnassign: false,
      tone: "slate",
    };
  }
  if (assignment.effective) {
    return {
      statusLabel: "Đang hiệu lực",
      rangeLabel: `Từ ${assignment.valid_from}`,
      canUnassign: true,
      tone: "emerald",
    };
  }
  return {
    statusLabel: "Sắp hiệu lực",
    rangeLabel: `Từ ${assignment.valid_from}`,
    canUnassign: true,
    tone: "amber",
  };
}
