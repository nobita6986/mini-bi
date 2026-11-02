import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildAssignEmployeeToBranchPayload,
  buildGoogleMapsCoordinatesUrl,
  buildMonthlyMatrixExportUrl,
  buildMonthlyMatrixReportQuery,
  buildUnassignEmployeeFromBranchPayload,
  buildUpsertBranchPayload,
  describeBranchAssignmentStatus,
  describeMatrixDayCell,
  formatMatrixDistanceStatusLabel,
  formatMatrixWeekdayLabel,
  getVietnamCurrentYearMonth,
  mapBranchAdminMutationError,
  mapMonthlyMatrixExportError,
  mapMonthlyMatrixReportError,
  resolveMutualExclusiveEmployeeOrSearch,
  validateMonthlyMatrixFilters,
} from "./attendance-monthly-matrix-ui-model.ts";

const managerSource = readFileSync(
  new URL("../../components/admin/attendance-report-manager.tsx", import.meta.url),
  "utf8",
);
const matrixPanelSource = readFileSync(
  new URL("../../components/admin/attendance-monthly-matrix-panel.tsx", import.meta.url),
  "utf8",
);

const BRANCH_ID = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const INTENT_KEY = "44444444-4444-4444-8444-444444444444";

test("monthly matrix query builder: enforces year_month, branch_id, default page_size=25 and mutual exclusion between employee_id and search", () => {
  const currentMonth = getVietnamCurrentYearMonth(new Date("2026-10-15T05:00:00Z"));
  assert.equal(currentMonth, "2026-10");

  // Search mode ignores employeeId even if passed
  const searchQuery = buildMonthlyMatrixReportQuery({
    yearMonth: "2026-10",
    branchId: BRANCH_ID,
    filterMode: "search",
    employeeId: EMPLOYEE_ID,
    search: "  Nguyễn Văn A ",
  });
  const searchParams = new URLSearchParams(searchQuery);
  assert.equal(searchParams.get("year_month"), "2026-10");
  assert.equal(searchParams.get("branch_id"), BRANCH_ID);
  assert.equal(searchParams.get("search"), "Nguyễn Văn A");
  assert.equal(searchParams.get("employee_id"), null);
  assert.equal(searchParams.get("page"), "1");
  assert.equal(searchParams.get("page_size"), "25");

  // Employee mode ignores search even if passed
  const employeeQuery = buildMonthlyMatrixReportQuery({
    yearMonth: "2026-10",
    branchId: BRANCH_ID,
    filterMode: "employee",
    employeeId: EMPLOYEE_ID,
    search: "Nguyễn Văn A",
    page: 3,
  });
  const empParams = new URLSearchParams(employeeQuery);
  assert.equal(empParams.get("year_month"), "2026-10");
  assert.equal(empParams.get("branch_id"), BRANCH_ID);
  assert.equal(empParams.get("employee_id"), EMPLOYEE_ID);
  assert.equal(empParams.get("search"), null);
  assert.equal(empParams.get("page"), "3");
  assert.equal(empParams.get("page_size"), "25");

  // Fallback mutual exclusion when filterMode is omitted
  const resolved = resolveMutualExclusiveEmployeeOrSearch({
    employeeId: EMPLOYEE_ID,
    search: "conflict",
  });
  assert.equal(resolved.employeeId, EMPLOYEE_ID);
  assert.equal(resolved.search, null);

  assert.equal(
    validateMonthlyMatrixFilters({
      yearMonth: "2026-10",
      filterMode: "search",
      employeeId: "",
      search: "NV001",
    }),
    null,
  );
  assert.notEqual(
    validateMonthlyMatrixFilters({
      yearMonth: "2026-13",
      filterMode: "search",
      employeeId: "",
      search: "",
    }),
    null,
  );
});

test("monthly matrix day cell presentation: renders CHECKED_IN, APPROVED_LEAVE, CHECKED_IN_AND_LEAVE, NO_CHECKIN with red highlight and never 'vắng không phép'", () => {
  const baseCell = {
    business_date: "2026-10-05",
    day_of_month: 5,
    has_checkin: false,
    checkin_count: 0,
    first_checkin_id: null,
    last_checkin_id: null,
    first_captured_at: null,
    first_captured_at_local: null,
    first_time_local: null,
    last_captured_at: null,
    last_captured_at_local: null,
    last_time_local: null,
    verified_checkin_count: 0,
    unverified_checkin_count: 0,
    distance_target_kind: null,
    branch_id_used: null,
    branch_code_used: null,
    branch_name_used: null,
    branch_version_used: null,
    hq_version_used: null,
    distance_status: null,
    distance_meters: null,
    min_distance_meters: null,
    max_distance_meters: null,
    has_approved_leave: false,
    approved_leave_units: 0,
    approved_leaves: [],
    day_status: "NO_CHECKIN",
  };

  // 1. NO_CHECKIN -> "Chưa có check-in", red tone, never "vắng không phép"
  const noCheckin = describeMatrixDayCell(baseCell);
  assert.equal(noCheckin.statusLabel, "Chưa có check-in");
  assert.equal(noCheckin.tone, "red");
  assert.equal(noCheckin.isRedHighlight, true);
  assert.equal(/vắng không phép/i.test(noCheckin.statusLabel), false);

  // 2. APPROVED_LEAVE -> red tone + explicit leave type and session (FULL, AM, PM)
  const approvedLeave = describeMatrixDayCell({
    ...baseCell,
    has_approved_leave: true,
    approved_leave_units: 1,
    approved_leaves: [
      {
        request_id: REQUEST_ID,
        leave_date: "2026-10-05",
        session_code: "AM",
        leave_type: "ANNUAL",
        half_day_units: 1,
      },
    ],
    day_status: "APPROVED_LEAVE",
  });
  assert.equal(approvedLeave.statusLabel, "Nghỉ phép đã duyệt");
  assert.equal(approvedLeave.tone, "red");
  assert.equal(approvedLeave.isRedHighlight, true);
  assert.equal(approvedLeave.leaveBadges.length, 1);
  assert.equal(approvedLeave.leaveBadges[0].leaveTypeLabel, "Phép năm");
  assert.equal(approvedLeave.leaveBadges[0].sessionLabel, "Sáng");
  assert.equal(approvedLeave.leaveBadges[0].label, "Phép năm (Sáng)");

  // 3. CHECKED_IN -> emerald tone, time range, verification, branch distance
  const checkedIn = describeMatrixDayCell({
    ...baseCell,
    has_checkin: true,
    checkin_count: 2,
    first_time_local: "08:02",
    last_time_local: "17:35",
    verified_checkin_count: 2,
    unverified_checkin_count: 0,
    distance_target_kind: "BRANCH",
    branch_code_used: "HN-CG",
    distance_status: "COMPUTED",
    distance_meters: 145.4,
    day_status: "CHECKED_IN",
  });
  assert.equal(checkedIn.statusLabel, "Có check-in");
  assert.equal(checkedIn.tone, "emerald");
  assert.equal(checkedIn.isRedHighlight, false);
  assert.equal(checkedIn.timeRangeLabel, "08:02 – 17:35 (2 lượt)");
  assert.equal(checkedIn.verificationLabel, "Đã xác thực (2/2)");
  assert.equal(checkedIn.distanceLabel, "CN: HN-CG · 145 m");

  // 4. CHECKED_IN_AND_LEAVE -> amber tone, both check-in and leave info
  const both = describeMatrixDayCell({
    ...baseCell,
    has_checkin: true,
    checkin_count: 1,
    first_time_local: "08:15",
    last_time_local: "08:15",
    verified_checkin_count: 0,
    unverified_checkin_count: 1,
    distance_target_kind: "HQ",
    distance_status: "HQ_NOT_CONFIGURED",
    has_approved_leave: true,
    approved_leave_units: 0.5,
    approved_leaves: [
      {
        request_id: REQUEST_ID,
        leave_date: "2026-10-05",
        session_code: "PM",
        leave_type: "UNPAID",
        half_day_units: 1,
      },
    ],
    day_status: "CHECKED_IN_AND_LEAVE",
  });
  assert.equal(both.statusLabel, "Có check-in & Nghỉ phép");
  assert.equal(both.tone, "amber");
  assert.equal(both.distanceLabel, "HQ · HQ chưa cấu hình tọa độ");
  assert.equal(both.leaveBadges[0].label, "Không lương (Chiều)");

  assert.equal(formatMatrixWeekdayLabel(1), "T2");
  assert.equal(formatMatrixWeekdayLabel(7), "CN");
  assert.equal(
    formatMatrixDistanceStatusLabel("BRANCH_NOT_CONFIGURED", null, "BRANCH", "HCM-01"),
    "CN: HCM-01 · Chi nhánh chưa cấu hình tọa độ",
  );
});

test("monthly matrix Excel export: builds export URL without pagination and maps 422/409/403 errors", () => {
  const url = buildMonthlyMatrixExportUrl({
    yearMonth: "2026-10",
    branchId: BRANCH_ID,
    filterMode: "employee",
    employeeId: EMPLOYEE_ID,
    search: "ignored",
  });
  assert.ok(url.startsWith("/api/admin/attendance/monthly-matrix/export?"));
  const parsed = new URL(url, "https://example.test");
  assert.equal(parsed.searchParams.get("year_month"), "2026-10");
  assert.equal(parsed.searchParams.get("branch_id"), BRANCH_ID);
  assert.equal(parsed.searchParams.get("employee_id"), EMPLOYEE_ID);
  assert.equal(parsed.searchParams.get("search"), null);
  assert.equal(parsed.searchParams.get("page"), null);
  assert.equal(parsed.searchParams.get("page_size"), null);

  const rowLimitMsg = mapMonthlyMatrixExportError(
    422,
    "ATTENDANCE_MATRIX_EXPORT_ROW_LIMIT_EXCEEDED",
  );
  assert.match(rowLimitMsg, /1\.000/);

  const incompleteMsg = mapMonthlyMatrixExportError(
    409,
    "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE",
  );
  assert.match(incompleteMsg, /thay đổi.*thử lại/i);

  const deniedMsg = mapMonthlyMatrixExportError(403, "ATTENDANCE_REPORT_ACCESS_DENIED");
  assert.match(deniedMsg, /không có quyền/i);

  const filterConflictMsg = mapMonthlyMatrixReportError(
    400,
    "ATTENDANCE_REPORT_FILTER_CONFLICT",
  );
  assert.match(filterConflictMsg, /không gửi đồng thời/i);
});

test("HRP branch management & employee assignment: validates payloads, blocks inactive branch assignment, and maps OCC/overlap/idempotency errors", () => {
  // 1. Upsert branch requires all-or-nothing coordinates
  assert.equal(
    buildUpsertBranchPayload({
      branchCode: "hn-01",
      displayName: "Chi nhánh Hà Nội",
      address: "Cầu Giấy",
      latitudeInput: "21.0285",
      longitudeInput: "",
      active: true,
      expectedVersion: 0,
      idempotencyKey: INTENT_KEY,
    }).ok,
    false,
  );

  const createdBranch = buildUpsertBranchPayload({
    branchCode: "hn-01",
    displayName: "Chi nhánh Hà Nội",
    address: "Cầu Giấy",
    latitudeInput: "21.028511",
    longitudeInput: "105.804817",
    active: true,
    expectedVersion: 0,
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(createdBranch.ok, true);
  assert.deepEqual(createdBranch.body, {
    branch_code: "HN-01",
    display_name: "Chi nhánh Hà Nội",
    address: "Cầu Giấy",
    latitude: 21.028511,
    longitude: 105.804817,
    active: true,
    expected_version: 0,
    idempotency_key: INTENT_KEY,
  });

  // 2. Prevent assigning employee to an inactive branch
  const inactiveAssign = buildAssignEmployeeToBranchPayload({
    appUserId: EMPLOYEE_ID,
    branch: { branch_id: BRANCH_ID, active: false, version: 2 },
    validFrom: "2026-10-20",
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(inactiveAssign.ok, false);
  assert.match(inactiveAssign.message, /ngừng hoạt động/i);

  // 3. Valid assignment sends app_user_id, branch_id, valid_from, expected_version (branch version), idempotency_key
  const activeAssign = buildAssignEmployeeToBranchPayload({
    appUserId: EMPLOYEE_ID,
    branch: { branch_id: BRANCH_ID, active: true, version: 2 },
    validFrom: "2026-10-20",
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(activeAssign.ok, true);
  assert.deepEqual(activeAssign.body, {
    app_user_id: EMPLOYEE_ID,
    branch_id: BRANCH_ID,
    valid_from: "2026-10-20",
    expected_version: 2,
    idempotency_key: INTENT_KEY,
  });

  // 4. Unassign sends valid_to, expected_version (assignment version), idempotency_key
  const unassign = buildUnassignEmployeeFromBranchPayload({
    validTo: "2026-10-31",
    expectedVersion: 3,
    idempotencyKey: INTENT_KEY,
  });
  assert.equal(unassign.ok, true);
  assert.deepEqual(unassign.body, {
    valid_to: "2026-10-31",
    expected_version: 3,
    idempotency_key: INTENT_KEY,
  });

  // 5. Assignment status description
  assert.equal(
    describeBranchAssignmentStatus({
      effective: true,
      valid_from: "2026-10-01",
      valid_to: null,
    }).statusLabel,
    "Đang hiệu lực",
  );
  assert.equal(
    describeBranchAssignmentStatus({
      effective: false,
      valid_from: "2026-12-01",
      valid_to: null,
    }).statusLabel,
    "Sắp hiệu lực",
  );
  assert.equal(
    describeBranchAssignmentStatus({
      effective: false,
      valid_from: "2026-09-01",
      valid_to: "2026-09-30",
    }).canUnassign,
    false,
  );

  // 6. Error mapping for branch mutations
  for (const [code, expectedConflict] of [
    ["ATTENDANCE_BRANCH_CODE_CONFLICT", true],
    ["ATTENDANCE_BRANCH_VERSION_CONFLICT", true],
    ["ATTENDANCE_BRANCH_INACTIVE", false],
    ["ATTENDANCE_BRANCH_TARGET_USER_INVALID", false],
    ["ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP", true],
    ["ATTENDANCE_BRANCH_ASSIGNMENT_ALREADY_CLOSED", true],
    ["ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID", false],
    ["ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT", true],
    ["IDEMPOTENCY_CONFLICT", true],
    ["ATTENDANCE_BRANCH_WRITE_DENIED", false],
  ]) {
    const mapped = mapBranchAdminMutationError(409, code);
    assert.equal(mapped.isConflict, expectedConflict, `conflict flag for ${code}`);
    assert.ok(mapped.message.length > 10);
  }
});

test("Google Maps coordinate link helper and detailed attendance GpsDetailCell wiring", () => {
  assert.equal(
    buildGoogleMapsCoordinatesUrl(10.776889, 106.700806),
    "https://www.google.com/maps/search/?api=1&query=10.776889,106.700806",
  );
  assert.equal(buildGoogleMapsCoordinatesUrl(-0, 105.8), "https://www.google.com/maps/search/?api=1&query=0,105.8");
  assert.equal(buildGoogleMapsCoordinatesUrl(null, 106.7), null);
  assert.equal(buildGoogleMapsCoordinatesUrl(10.7, null), null);
  assert.equal(buildGoogleMapsCoordinatesUrl(Number.NaN, 106.7), null);
  assert.equal(buildGoogleMapsCoordinatesUrl(10.7, Number.POSITIVE_INFINITY), null);
  assert.equal(buildGoogleMapsCoordinatesUrl(91, 106.7), null);
  assert.equal(buildGoogleMapsCoordinatesUrl(10.7, 181), null);

  // Verify GpsDetailCell in attendance-report-manager.tsx renders <a> with target="_blank" and rel="noreferrer"
  const gpsCellBlock = managerSource.match(/function GpsDetailCell[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.ok(gpsCellBlock.length > 0, "GpsDetailCell must exist in attendance-report-manager.tsx");
  assert.match(gpsCellBlock, /buildGoogleMapsCoordinatesUrl\(item\.latitude,\s*item\.longitude\)/);
  assert.match(gpsCellBlock, /href=\{googleMapsUrl\}/);
  assert.match(gpsCellBlock, /target="_blank"/);
  assert.match(gpsCellBlock, /rel="noreferrer"/);
  // Accuracy and note remain outside the <a> tag
  assert.match(gpsCellBlock, /<\/a>\s*\{item\.accuracy_meters !== null/);
  assert.match(gpsCellBlock, /Ghi chú: \{item\.note\}/);

  // Verify tabs and sections are wired in attendance-report-manager.tsx and attendance-monthly-matrix-panel.tsx
  assert.match(managerSource, /role="tablist"/);
  assert.match(managerSource, /Chi tiết lượt chấm công/);
  assert.match(managerSource, /Ma trận tháng/);
  assert.match(managerSource, /Chi nhánh HRP/);
  assert.match(matrixPanelSource, /\/api\/admin\/attendance\/monthly-matrix/);
  assert.match(matrixPanelSource, /\/api\/admin\/attendance\/branches/);
  assert.match(matrixPanelSource, /\/api\/admin\/attendance\/branches\/assignments/);
  assert.match(matrixPanelSource, /can_manage_branches/);
  assert.match(matrixPanelSource, /Chỉ xem \(BoD\)/);
  assert.equal(/vắng không phép/i.test(matrixPanelSource), false);
});
