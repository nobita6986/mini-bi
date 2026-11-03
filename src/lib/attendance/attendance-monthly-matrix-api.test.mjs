import assert from "node:assert/strict";
import test from "node:test";

import {
  computeExplanationDecideRequestFingerprint,
  computeExplanationSubmitRequestFingerprint,
  exportAttendanceMonthlyMatrixXlsx,
  getAttendanceBranchesAdmin,
  getAttendanceExplanationApprovalInbox,
  getAttendanceMonthlyMatrixReport,
  getAttendanceSlotPoliciesAdmin,
  getMyAttendanceExplanations,
  postAttendanceBranchAssignmentAdmin,
  postAttendanceBranchUnassignAdmin,
  postAttendanceSlotPolicyAdmin,
  postDecideAttendanceExplanation,
  postOrPutAttendanceBranchAdmin,
  postSubmitAttendanceExplanation,
} from "./attendance-monthly-matrix-api.ts";
import {
  ATTENDANCE_MONTHLY_MATRIX_EXPORT_ROW_LIMIT,
  DEFAULT_ATTENDANCE_SLOT_POLICY,
  parseAssignBranchBody,
  parseAttendanceExplanationApprovalInboxQuery,
  parseAttendanceExplanationsQuery,
  parseAttendanceMonthlyMatrixQuery,
  parseCreateSlotPolicyBody,
  parseDecideAttendanceExplanationBody,
  parseSubmitAttendanceExplanationBody,
  parseUnassignBranchBody,
  parseUpsertBranchBody,
} from "./attendance-monthly-matrix-contract.ts";
import {
  ATTENDANCE_REPORT_MAX_PAGE_SIZE,
} from "./attendance-report-contract.ts";
import {
  createServiceAttendanceMonthlyMatrixRepository,
} from "./attendance-monthly-matrix-repository.ts";
import {
  projectAdminUpdateLocationRequest,
  updateProjectLocationAdmin,
} from "../direct-entry/project-admin-api.ts";
import {
  authenticateHrpSyncRequest,
  resetHrpSyncRateLimiterForTests,
} from "../integrations/hrp/auth.ts";
import {
  handleHrpSyncCatalogGet,
} from "../integrations/hrp/catalog-api.ts";

const AUTH_SUBJECT = "19000000-0000-4000-8000-0000000000a1";
const APP_USER_ID = "29000000-0000-4000-8000-0000000000a1";
const STAFF_USER_ID = "29000000-0000-4000-8000-0000000000b2";
const BRANCH_ID = "39000000-0000-4000-8000-0000000000c1";
const ASSIGNMENT_ID = "49000000-0000-4000-8000-0000000000d1";
const IDEMPOTENCY_KEY = "59000000-0000-4000-8000-0000000000e1";
const HRP_AUTH_SUBJECT = "69000000-0000-4000-8000-0000000000f1";
const HRP_APP_USER_ID = "79000000-0000-4000-8000-0000000000f2";
const REQUEST_ID = "89000000-0000-4000-8000-0000000000f3";

const ALL_SCOPE = [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }];
const FULL_ADMIN_CAPS = ["entry_admin", "recruiter_master_manage", "team_master_manage"];
const BOD_PRIVILEGED_CAPS = ["entry_privileged_edit"];
const BOD_WORK_REPORTS_CAPS = ["report_analytics_view", "report_view"];
const STAFF_CAPS = ["report_view"];

function makeSessionOk(capabilities = FULL_ADMIN_CAPS, scopes = ALL_SCOPE) {
  return {
    actor: {
      ok: true,
      actor: {
        auth_subject: AUTH_SUBJECT,
        app_user_id: APP_USER_ID,
        display_name: "Admin Test",
        enabled: true,
        capabilities,
        scopes,
        self_recruiter_suggestion: null,
        session: {
          provider: "supabase",
          verification: "getUser",
          authenticated_at: "2026-10-25T01:00:00.000Z",
        },
      },
    },
    response_headers: {},
  };
}

function buildValidMonthlyMatrixReport(overrides = {}) {
  return {
    viewer: {
      can_configure_hq: true,
      can_manage_branches: true,
    },
    filters: {
      year_month: "2026-10",
      from_date: "2026-10-01",
      to_date: "2026-10-03",
      branch_id: null,
      employee_id: null,
      search: null,
      timezone: "Asia/Ho_Chi_Minh",
    },
    days_in_month: 3,
    calendar_days: [
      { business_date: "2026-10-01", day_of_month: 1, day_of_week: 4 },
      { business_date: "2026-10-02", day_of_month: 2, day_of_week: 5 },
      { business_date: "2026-10-03", day_of_month: 3, day_of_week: 6 },
    ],
    current_hq: {
      version: 1,
      latitude: 21.028511,
      longitude: 105.804817,
      effective_from: "2026-10-01T00:00:00.000Z",
      effective_from_local: "2026-10-01 07:00:00",
      configured_by_display_name: "Admin Test",
    },
    branch_options: [
      {
        branch_id: BRANCH_ID,
        branch_code: "BN01",
        display_name: "Chi nhánh Bắc Ninh",
        active: true,
        latitude: 21.186082,
        longitude: 106.076314,
        version: 1,
      },
    ],
    employee_options: [
      {
        app_user_id: STAFF_USER_ID,
        display_name: "Nguyễn Văn A",
        personnel_code: "NV001",
        branch_id: BRANCH_ID,
        branch_code: "BN01",
        branch_name: "Chi nhánh Bắc Ninh",
      },
    ],
    overview: {
      total_employees: 1,
      employees_with_checkins: 1,
      employees_with_approved_leave: 1,
      total_checkins: 2,
      total_checkin_days: 1,
      total_approved_leave_days: 1,
      total_approved_leave_units: 1,
      total_no_checkin_days: 2,
      total_no_checkin_without_leave_days: 1,
    },
    pagination: {
      page: 1,
      page_size: 25,
      total_rows: 1,
      total_pages: 1,
      has_more: false,
      snapshot_token: "a".repeat(32),
    },
    items: [
      {
        app_user_id: STAFF_USER_ID,
        employee_display_name: "Nguyễn Văn A",
        personnel_code: "NV001",
        enabled: true,
        branch: {
          branch_id: BRANCH_ID,
          branch_code: "BN01",
          display_name: "Chi nhánh Bắc Ninh",
          address: "TP Bắc Ninh",
          latitude: 21.186082,
          longitude: 106.076314,
          active: true,
          version: 1,
          valid_from: "2026-10-01",
          valid_to: null,
        },
        summary: {
          checkin_day_count: 1,
          total_checkins: 2,
          approved_leave_day_count: 1,
          approved_leave_units: 1,
          checkin_and_leave_day_count: 0,
          no_checkin_day_count: 2,
          no_checkin_without_leave_day_count: 1,
          distance_computed_count: 2,
          distance_unavailable_count: 0,
          min_distance_meters: 15.2,
          max_distance_meters: 42.5,
        },
        days: [
          {
            business_date: "2026-10-01",
            day_of_month: 1,
            has_checkin: true,
            checkin_count: 2,
            first_checkin_id: "99000000-0000-4000-8000-000000000001",
            last_checkin_id: "99000000-0000-4000-8000-000000000002",
            first_captured_at: "2026-10-01T01:00:00.000Z",
            first_captured_at_local: "2026-10-01 08:00:00",
            first_time_local: "08:00",
            last_captured_at: "2026-10-01T10:30:00.000Z",
            last_captured_at_local: "2026-10-01 17:30:00",
            last_time_local: "17:30",
            verified_checkin_count: 2,
            unverified_checkin_count: 0,
            distance_target_kind: "BRANCH",
            branch_id_used: BRANCH_ID,
            branch_code_used: "BN01",
            branch_name_used: "Chi nhánh Bắc Ninh",
            branch_version_used: 1,
            hq_version_used: null,
            distance_status: "COMPUTED",
            distance_meters: 15.2,
            min_distance_meters: 15.2,
            max_distance_meters: 42.5,
            has_approved_leave: false,
            approved_leave_units: 0,
            approved_leaves: [],
            day_status: "CHECKED_IN",
          },
          {
            business_date: "2026-10-02",
            day_of_month: 2,
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
            has_approved_leave: true,
            approved_leave_units: 1,
            approved_leaves: [
              {
                request_id: "89000000-0000-4000-8000-000000000001",
                leave_date: "2026-10-02",
                session_code: "FULL",
                leave_type: "ANNUAL",
                half_day_units: 2,
              },
            ],
            day_status: "APPROVED_LEAVE",
          },
          {
            business_date: "2026-10-03",
            day_of_month: 3,
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
          },
        ],
      },
    ],
    ...overrides,
  };
}

function makeJsonRequest(url, method, body, origin = "https://bi.example.com") {
  const headers = new Headers({
    host: "bi.example.com",
    ...(origin ? { origin } : {}),
    "content-type": "application/json",
  });
  return new Request(url, {
    method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("parseAttendanceMonthlyMatrixQuery validates year_month, filters, and bounds page_size to 1..100", () => {
  const defaulted = parseAttendanceMonthlyMatrixQuery(
    new URL("https://bi.example.com/api/admin/attendance/monthly-matrix"),
  );
  assert.equal(defaulted.ok, true);
  if (defaulted.ok) {
    assert.equal(defaulted.value.year_month, null);
    assert.equal(defaulted.value.page, 1);
    assert.equal(defaulted.value.page_size, 25);
  }

  const badMonth = parseAttendanceMonthlyMatrixQuery(
    new URL("https://bi.example.com/api/admin/attendance/monthly-matrix?year_month=2026-13"),
  );
  assert.equal(badMonth.ok, false);
  if (!badMonth.ok) {
    assert.equal(badMonth.code, "ATTENDANCE_MATRIX_MONTH_INVALID");
  }

  const oversizePage = parseAttendanceMonthlyMatrixQuery(
    new URL(
      `https://bi.example.com/api/admin/attendance/monthly-matrix?year_month=2026-10&page_size=${ATTENDANCE_REPORT_MAX_PAGE_SIZE + 1}`,
    ),
  );
  assert.equal(oversizePage.ok, false);
  if (!oversizePage.ok) {
    assert.equal(oversizePage.code, "ATTENDANCE_REPORT_PAGINATION_INVALID");
  }
});

test("GET /api/admin/attendance/monthly-matrix enforces Attendance Report reader authority and projects response", async () => {
  const deniedRes = await getAttendanceMonthlyMatrixReport(
    new Request("https://bi.example.com/api/admin/attendance/monthly-matrix?year_month=2026-10"),
    {
      resolveSession: async () => makeSessionOk(STAFF_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => {
          throw new Error("must not call RPC when preflight denies");
        },
        listBranchesAdmin: async () => {
          throw new Error("unused");
        },
        upsertBranchAdmin: async () => {
          throw new Error("unused");
        },
        assignEmployeeBranchAdmin: async () => {
          throw new Error("unused");
        },
        unassignEmployeeBranchAdmin: async () => {
          throw new Error("unused");
        },
      },
    },
  );
  assert.equal(deniedRes.status, 403);
  assert.equal((await deniedRes.json()).code, "ATTENDANCE_REPORT_ACCESS_DENIED");

  for (const caps of [FULL_ADMIN_CAPS, BOD_PRIVILEGED_CAPS, BOD_WORK_REPORTS_CAPS]) {
    const okRes = await getAttendanceMonthlyMatrixReport(
      new Request("https://bi.example.com/api/admin/attendance/monthly-matrix?year_month=2026-10"),
      {
        resolveSession: async () => makeSessionOk(caps, ALL_SCOPE),
        repository: {
          getMonthlyMatrixReport: async () => ({
            ok: true,
            report: buildValidMonthlyMatrixReport(),
          }),
          listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
          upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
          assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
          unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        },
      },
    );
    assert.equal(okRes.status, 200);
    assert.match(okRes.headers.get("cache-control") ?? "", /no-store/);
    const body = await okRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.report.filters.year_month, "2026-10");
    assert.equal(body.report.items.length, 1);
    assert.equal(body.report.items[0].summary.no_checkin_without_leave_day_count, 1);
  }
});

test("GET /api/admin/attendance/monthly-matrix/export aggregates multi-page dataset into XLSX and enforces row/pagination guards", async () => {
  const requestedPages = [];
  const exportRes = await exportAttendanceMonthlyMatrixXlsx(
    new Request("https://bi.example.com/api/admin/attendance/monthly-matrix/export?year_month=2026-10"),
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async (input) => {
          requestedPages.push(input.page);
          const item = {
            ...buildValidMonthlyMatrixReport().items[0],
            app_user_id: input.page === 1 ? STAFF_USER_ID : APP_USER_ID,
            employee_display_name: input.page === 1 ? "Nhân viên Trang 1" : "Nhân viên Trang 2",
          };
          return {
            ok: true,
            report: buildValidMonthlyMatrixReport({
              pagination: {
                page: input.page,
                page_size: 100,
                total_rows: 2,
                total_pages: 2,
                has_more: input.page < 2,
                snapshot_token: "a".repeat(32),
              },
              items: [item],
            }),
          };
        },
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
      },
    },
  );
  assert.equal(exportRes.status, 200);
  assert.deepEqual(requestedPages, [1, 2]);
  assert.match(
    exportRes.headers.get("content-type") ?? "",
    /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/,
  );
  assert.match(
    exportRes.headers.get("content-disposition") ?? "",
    /2026-10\.xlsx/,
  );
  const bytes = new Uint8Array(await exportRes.arrayBuffer());
  assert.equal(bytes[0], 0x50); // 'P'
  assert.equal(bytes[1], 0x4b); // 'K'

  const rowLimitRes = await exportAttendanceMonthlyMatrixXlsx(
    new Request("https://bi.example.com/api/admin/attendance/monthly-matrix/export?year_month=2026-10"),
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({
          ok: true,
          report: buildValidMonthlyMatrixReport({
            pagination: {
              page: 1,
              page_size: 100,
              total_rows: ATTENDANCE_MONTHLY_MATRIX_EXPORT_ROW_LIMIT + 1,
              total_pages: 11,
              has_more: true,
              snapshot_token: "a".repeat(32),
            },
          }),
        }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
      },
    },
  );
  assert.equal(rowLimitRes.status, 422);
  assert.equal((await rowLimitRes.json()).code, "ATTENDANCE_MATRIX_EXPORT_ROW_LIMIT_EXCEEDED");

  const incompleteRes = await exportAttendanceMonthlyMatrixXlsx(
    new Request("https://bi.example.com/api/admin/attendance/monthly-matrix/export?year_month=2026-10"),
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({
          ok: true,
          report: buildValidMonthlyMatrixReport({
            pagination: {
              page: 1,
              page_size: 100,
              total_rows: 3,
              total_pages: 1,
              has_more: false,
              snapshot_token: "a".repeat(32),
            },
            items: [buildValidMonthlyMatrixReport().items[0]],
          }),
        }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
      },
    },
  );
  assert.equal(incompleteRes.status, 409);
  assert.equal((await incompleteRes.json()).code, "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE");

  // Regression: mid-export data edit or same-count employee replacement where total_rows,
  // total_pages, and distinct app_user_ids remain valid, but snapshot_token changes across pages.
  const midExportEditSameCountRes = await exportAttendanceMonthlyMatrixXlsx(
    new Request("https://bi.example.com/api/admin/attendance/monthly-matrix/export?year_month=2026-10"),
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async (input) => {
          const item = {
            ...buildValidMonthlyMatrixReport().items[0],
            app_user_id: input.page === 1 ? STAFF_USER_ID : APP_USER_ID,
            employee_display_name: input.page === 1 ? "Nhân viên Trang 1" : "Nhân viên Thay Thế Cùng Số Dòng",
          };
          return {
            ok: true,
            report: buildValidMonthlyMatrixReport({
              pagination: {
                page: input.page,
                page_size: 100,
                total_rows: 2,
                total_pages: 2,
                has_more: input.page < 2,
                snapshot_token: input.page === 1 ? "a".repeat(32) : "b".repeat(32),
              },
              items: [item],
            }),
          };
        },
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
      },
    },
  );
  assert.equal(midExportEditSameCountRes.status, 409);
  assert.equal(
    (await midExportEditSameCountRes.json()).code,
    "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE",
  );
});

test("HRP Branch Admin contracts and handlers enforce entry_admin @ all, coordinate pair rules, and app_user_id assignment", async () => {
  const halfCoords = parseUpsertBranchBody({
    branch_code: "bn01",
    display_name: "Chi nhánh Bắc Ninh",
    latitude: 21.186082,
    longitude: null,
    expected_version: 0,
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(halfCoords.ok, false);
  if (!halfCoords.ok) {
    assert.equal(halfCoords.code, "ATTENDANCE_BRANCH_INVALID");
  }

  const recruiterFieldRejected = parseAssignBranchBody({
    app_user_id: STAFF_USER_ID,
    recruiter_id: STAFF_USER_ID,
    branch_id: BRANCH_ID,
    valid_from: "2026-10-01",
    expected_version: 1,
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(recruiterFieldRejected.ok, false);

  const bodWriteDenied = await postOrPutAttendanceBranchAdmin(
    makeJsonRequest("https://bi.example.com/api/admin/attendance/branches", "POST", {
      branch_code: "BN01",
      display_name: "Chi nhánh Bắc Ninh",
      address: "TP Bắc Ninh",
      latitude: 21.186082,
      longitude: 106.076314,
      active: true,
      expected_version: 0,
      idempotency_key: IDEMPOTENCY_KEY,
    }),
    null,
    {
      resolveSession: async () => makeSessionOk(BOD_PRIVILEGED_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => {
          throw new Error("BoD must not reach branch upsert RPC");
        },
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
      },
    },
  );
  assert.equal(bodWriteDenied.status, 403);
  assert.equal((await bodWriteDenied.json()).code, "ATTENDANCE_BRANCH_WRITE_DENIED");

  const overlapConflict = await postAttendanceBranchAssignmentAdmin(
    makeJsonRequest("https://bi.example.com/api/admin/attendance/branches/assignments", "POST", {
      app_user_id: STAFF_USER_ID,
      branch_id: BRANCH_ID,
      valid_from: "2026-10-01",
      expected_version: 1,
      idempotency_key: IDEMPOTENCY_KEY,
    }),
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({
          ok: false,
          code: "ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP",
        }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
      },
    },
  );
  assert.equal(overlapConflict.status, 409);
  assert.equal((await overlapConflict.json()).code, "ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP");

  const listOk = await getAttendanceBranchesAdmin(
    new Request("https://bi.example.com/api/admin/attendance/branches"),
    {
      resolveSession: async () => makeSessionOk(BOD_PRIVILEGED_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({
          ok: true,
          data: {
            viewer: { can_manage_branches: false },
            include_inactive: true,
            branches: [
              {
                branch_id: BRANCH_ID,
                branch_code: "BN01",
                display_name: "Chi nhánh Bắc Ninh",
                address: "TP Bắc Ninh",
                latitude: 21.186082,
                longitude: 106.076314,
                active: true,
                version: 1,
                active_assignment_count: 1,
                created_at: "2026-10-01T00:00:00.000Z",
                updated_at: "2026-10-01T00:00:00.000Z",
                updated_by_display_name: "Admin Test",
              },
            ],
            assignments: [],
            employee_options: [],
          },
        }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
      },
    },
  );
  assert.equal(listOk.status, 200);

  const updateOk = await postOrPutAttendanceBranchAdmin(
    makeJsonRequest(`https://bi.example.com/api/admin/attendance/branches/${BRANCH_ID}`, "PUT", {
      branch_code: "BN01",
      display_name: "Chi nhánh Bắc Ninh",
      address: "TP Bắc Ninh",
      latitude: 21.186082,
      longitude: 106.076314,
      active: true,
      expected_version: 1,
      idempotency_key: IDEMPOTENCY_KEY,
    }),
    BRANCH_ID,
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({
          ok: true,
          result: {
            replayed: false,
            branch: {
              branch_id: BRANCH_ID,
              branch_code: "BN01",
              display_name: "Chi nhánh Bắc Ninh",
              address: "TP Bắc Ninh",
              latitude: 21.186082,
              longitude: 106.076314,
              active: true,
              version: 2,
              active_assignment_count: 1,
              created_at: "2026-10-01T00:00:00.000Z",
              updated_at: "2026-10-02T00:00:00.000Z",
              updated_by_display_name: "Admin Test",
            },
          },
        }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
      },
    },
  );
  assert.equal(updateOk.status, 200);

  const unassignParsed = parseUnassignBranchBody({
    valid_to: "2026-10-31",
    expected_version: 1,
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(unassignParsed.ok, true);

  const unassignOk = await postAttendanceBranchUnassignAdmin(
    makeJsonRequest(
      `https://bi.example.com/api/admin/attendance/branches/assignments/${ASSIGNMENT_ID}/unassign`,
      "POST",
      {
        valid_to: "2026-10-31",
        expected_version: 1,
        idempotency_key: IDEMPOTENCY_KEY,
      },
    ),
    ASSIGNMENT_ID,
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({
          ok: true,
          result: {
            replayed: false,
            assignment: {
              assignment_id: ASSIGNMENT_ID,
              app_user_id: STAFF_USER_ID,
              employee_display_name: "Nguyễn Văn A",
              personnel_code: "NV001",
              branch_id: BRANCH_ID,
              branch_code: "BN01",
              branch_name: "Chi nhánh Bắc Ninh",
              valid_from: "2026-10-01",
              valid_to: "2026-10-31",
              effective: false,
              version: 2,
              created_at: "2026-10-01T00:00:00.000Z",
              updated_at: "2026-10-02T00:00:00.000Z",
            },
          },
        }),
      },
    },
  );
  assert.equal(unassignOk.status, 200);
});

test("Project Location Admin contract and endpoint validate coordinates, radius 50..2000, clear, and OCC", async () => {
  const validSet = projectAdminUpdateLocationRequest({
    expected_version: 2,
    address: "KCN Yên Phong, Bắc Ninh",
    latitude: 21.198765,
    longitude: 105.987654,
    radius_meters: 300,
    clear: false,
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(validSet.ok, true);

  const invalidRadius = projectAdminUpdateLocationRequest({
    expected_version: 2,
    address: "KCN Yên Phong",
    latitude: 21.198765,
    longitude: 105.987654,
    radius_meters: 10,
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(invalidRadius.ok, false);

  const validClear = projectAdminUpdateLocationRequest({
    expected_version: 2,
    clear: true,
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(validClear.ok, true);

  let calledInput = null;
  const res = await updateProjectLocationAdmin(
    makeJsonRequest("https://bi.example.com/api/direct-entry/projects/proj_1/location", "PUT", {
      expected_version: 2,
      address: "KCN Yên Phong, Bắc Ninh",
      latitude: 21.198765,
      longitude: 105.987654,
      radius_meters: 300,
      idempotency_key: IDEMPOTENCY_KEY,
    }),
    "proj_1",
    "true",
    {
      resolveSession: async () => ({
        actor: {
          ok: true,
          actor: {
            auth_subject: AUTH_SUBJECT,
            app_user_id: APP_USER_ID,
          },
        },
        response_headers: {},
      }),
      repository: {
        listProjects: async () => ({ ok: false, kind: "unavailable" }),
        getProject: async () => ({ ok: false, kind: "unavailable" }),
        listAssignments: async () => ({ ok: false, kind: "unavailable" }),
        getProjectDetail: async () => ({ ok: false, kind: "unavailable" }),
        listManagerCandidates: async () => ({ ok: false, kind: "unavailable" }),
        createProject: async () => ({ ok: false, kind: "unavailable" }),
        updateProject: async () => ({ ok: false, kind: "unavailable" }),
        updateProjectLocation: async (input) => {
          calledInput = input;
          return {
            ok: true,
            data: {
              project_id: "proj_1",
              display_name: "Dự án Yên Phong",
              active: true,
              version: 3,
              revision_id: "99000000-0000-4000-8000-000000000099",
              location: {
                address: "KCN Yên Phong, Bắc Ninh",
                latitude: 21.198765,
                longitude: 105.987654,
                radius_meters: 300,
                confirmed_at: "2026-10-25T02:00:00.000Z",
              },
            },
          };
        },
        setProjectActive: async () => ({ ok: false, kind: "unavailable" }),
        assignManager: async () => ({ ok: false, kind: "unavailable" }),
        unassignManager: async () => ({ ok: false, kind: "unavailable" }),
      },
    },
  );
  assert.equal(res.status, 200);
  assert.ok(calledInput);
  assert.equal(calledInput.project_id, "proj_1");
  assert.equal(calledInput.expected_version, 2);
  assert.equal(calledInput.radius_meters, 300);
});

test("HRP Integration Catalog API enforces Bearer M2M auth, key rotation, kill switch, rate limit <= 60 req/min/key, X-Request-Id echo, and catalog schema", async () => {
  resetHrpSyncRateLimiterForTests();
  const baseEnv = {
    HRP_SYNC_API_ENABLED: "true",
    HRP_SYNC_API_KEY: "primary-secret-key-256bit-value-001",
    HRP_SYNC_API_KEY_NEXT: "secondary-rotated-key-256bit-value-002",
    HRP_SYNC_AUTH_SUBJECT: HRP_AUTH_SUBJECT,
  };

  // 1. Kill switch
  const disabledRes = await handleHrpSyncCatalogGet(
    new Request("https://bi.example.com/api/integrations/hrp/v1/catalog", {
      headers: { authorization: `Bearer ${baseEnv.HRP_SYNC_API_KEY}` },
    }),
    {
      env: { ...baseEnv, HRP_SYNC_API_ENABLED: "false" },
      nowMs: 1_700_000_000_000,
    },
  );
  assert.equal(disabledRes.status, 503);
  assert.equal((await disabledRes.json()).error.code, "SERVICE_DISABLED");

  // 2. Unauthorized on wrong token
  const unauthRes = await handleHrpSyncCatalogGet(
    new Request("https://bi.example.com/api/integrations/hrp/v1/catalog", {
      headers: { authorization: "Bearer wrong-token" },
    }),
    {
      env: baseEnv,
      nowMs: 1_700_000_000_000,
    },
  );
  assert.equal(unauthRes.status, 401);
  assert.equal((await unauthRes.json()).error.code, "INVALID_BEARER_TOKEN");

  // 3. Both primary and secondary keys succeed and echo X-Request-Id
  for (const token of [baseEnv.HRP_SYNC_API_KEY, baseEnv.HRP_SYNC_API_KEY_NEXT]) {
    const okRes = await handleHrpSyncCatalogGet(
      new Request("https://bi.example.com/api/integrations/hrp/v1/catalog", {
        headers: {
          authorization: `Bearer ${token}`,
          "x-request-id": REQUEST_ID,
        },
      }),
      {
        env: baseEnv,
        nowMs: 1_700_000_000_000,
        resolveActor: async () => ({
          ok: true,
          actor: {
            auth_subject: HRP_AUTH_SUBJECT,
            app_user_id: HRP_APP_USER_ID,
          },
        }),
        repository: {
          getCatalog: async () => ({
            ok: true,
            data: {
              ok: true,
              serverTime: "2026-10-25T03:00:00.000Z",
              projects: [
                {
                  projectId: "proj_luxshare_bn",
                  displayName: "Luxshare Bắc Ninh",
                  active: true,
                  version: 4,
                  updatedAt: "2026-10-25T02:00:00.000Z",
                  location: {
                    address: "KCN Quế Võ, Bắc Ninh",
                    latitude: 21.163421,
                    longitude: 106.15389,
                    radiusMeters: 300,
                    confirmedAt: "2026-10-25T02:00:00.000Z",
                  },
                },
              ],
              recruiters: [],
              laborTypes: [],
            },
          }),
        },
      },
    );
    assert.equal(okRes.status, 200);
    assert.equal(okRes.headers.get("x-request-id"), REQUEST_ID);
    assert.match(okRes.headers.get("cache-control") ?? "", /no-store/);
    const body = await okRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.projects[0].location.radiusMeters, 300);
  }

  // 4. Rate limit: 60 allowed in window, 61st returns 429 RATE_LIMITED
  resetHrpSyncRateLimiterForTests();
  const fixedNow = 1_700_000_120_000;
  for (let i = 1; i <= 60; i += 1) {
    const auth = authenticateHrpSyncRequest(
      new Request("https://bi.example.com/api/integrations/hrp/v1/catalog", {
        headers: { authorization: `Bearer ${baseEnv.HRP_SYNC_API_KEY}` },
      }),
      { env: baseEnv, nowMs: fixedNow },
    );
    assert.equal(auth.ok, true);
  }
  const rateLimited = authenticateHrpSyncRequest(
    new Request("https://bi.example.com/api/integrations/hrp/v1/catalog", {
      headers: { authorization: `Bearer ${baseEnv.HRP_SYNC_API_KEY}` },
    }),
    { env: baseEnv, nowMs: fixedNow },
  );
  assert.equal(rateLimited.ok, false);
  if (!rateLimited.ok) {
    assert.equal(rateLimited.status, 429);
    assert.equal(rateLimited.code, "RATE_LIMITED");
    assert.ok(rateLimited.retryAfterSeconds >= 1);
  }
});

test("Attendance Slot Policy Admin contract and handlers enforce Full Admin on POST, allow BoD on GET, and map overlap/past/version conflict errors", async () => {
  const validBody = {
    effective_from_date: "2026-11-01",
    slot_1: { target_time: "07:30", grace_before_minutes: 15, grace_after_minutes: 15 },
    slot_2: { target_time: "11:30", grace_before_minutes: 15, grace_after_minutes: 15 },
    slot_3: { target_time: "13:00", grace_before_minutes: 15, grace_after_minutes: 15 },
    slot_4: { target_time: "17:00", grace_before_minutes: 15, grace_after_minutes: 15 },
    expected_version: 1,
    idempotency_key: IDEMPOTENCY_KEY,
  };

  const parsed = parseCreateSlotPolicyBody(validBody);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.slots.length, 4);
  }

  // Flexible 6-slot payload accepted
  const parsedSixSlots = parseCreateSlotPolicyBody({
    effective_from_date: "2026-11-05",
    slots: [
      { slot_label: "Time 1", target_time: "07:30", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 2", target_time: "09:30", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 3", target_time: "11:30", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 4", target_time: "13:00", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 5", target_time: "15:00", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 6", target_time: "17:00", grace_before_minutes: 15, grace_after_minutes: 15 },
    ],
    expected_version: 1,
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(parsedSixSlots.ok, true);
  if (parsedSixSlots.ok) {
    assert.equal(parsedSixSlots.value.slots.length, 6);
    assert.equal(parsedSixSlots.value.slots[5].slot_code, "SLOT_6");
    assert.equal(parsedSixSlots.value.slots[5].slot_label, "Time 6");
  }

  // Empty slots array rejected
  const emptySlots = parseCreateSlotPolicyBody({
    effective_from_date: "2026-11-05",
    slots: [],
    expected_version: 1,
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(emptySlots.ok, false);

  // Non-monotonic slot times rejected with ATTENDANCE_SLOT_POLICY_INVALID
  const badOrder = parseCreateSlotPolicyBody({
    ...validBody,
    slot_2: { target_time: "07:00", grace_before_minutes: 15, grace_after_minutes: 15 },
  });
  assert.equal(badOrder.ok, false);
  if (!badOrder.ok) {
    assert.equal(badOrder.code, "ATTENDANCE_SLOT_POLICY_INVALID");
  }

  // GET allowed for BoD reader
  const getRes = await getAttendanceSlotPoliciesAdmin(
    new Request("https://bi.example.com/api/admin/attendance/slot-policies"),
    {
      resolveSession: async () => makeSessionOk(BOD_PRIVILEGED_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        getSlotPoliciesAdmin: async () => ({
          ok: true,
          data: {
            viewer: { can_manage_slot_policy: false },
            business_date: "2026-10-25",
            current_policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
            latest_policy: DEFAULT_ATTENDANCE_SLOT_POLICY,
            versions: [DEFAULT_ATTENDANCE_SLOT_POLICY],
          },
        }),
        createSlotPolicyAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
      },
    },
  );
  assert.equal(getRes.status, 200);
  const getJson = await getRes.json();
  assert.equal(getJson.ok, true);
  assert.equal(getJson.current_policy.version, 1);
  assert.equal(getJson.current_policy.slots.length, 5);
  assert.deepEqual(
    getJson.current_policy.slots.map((s) => s.target_time),
    ["07:30", "10:00", "13:00", "15:00", "16:30"],
  );

  // POST denied for BoD reader
  const bodDeniedRes = await postAttendanceSlotPolicyAdmin(
    makeJsonRequest("https://bi.example.com/api/admin/attendance/slot-policies", "POST", validBody),
    {
      resolveSession: async () => makeSessionOk(BOD_PRIVILEGED_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        getSlotPoliciesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        createSlotPolicyAdmin: async () => {
          throw new Error("BoD must not reach createSlotPolicyAdmin RPC");
        },
      },
    },
  );
  assert.equal(bodDeniedRes.status, 403);
  assert.equal((await bodDeniedRes.json()).code, "ATTENDANCE_SLOT_POLICY_WRITE_DENIED");

  // POST past effective date returns 422 ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST
  const pastRes = await postAttendanceSlotPolicyAdmin(
    makeJsonRequest("https://bi.example.com/api/admin/attendance/slot-policies", "POST", validBody),
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        getSlotPoliciesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        createSlotPolicyAdmin: async () => ({
          ok: false,
          code: "ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST",
        }),
      },
    },
  );
  assert.equal(pastRes.status, 422);
  assert.equal((await pastRes.json()).code, "ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST");

  // POST overlap returns 409 ATTENDANCE_SLOT_POLICY_OVERLAP
  const overlapRes = await postAttendanceSlotPolicyAdmin(
    makeJsonRequest("https://bi.example.com/api/admin/attendance/slot-policies", "POST", validBody),
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        getSlotPoliciesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        createSlotPolicyAdmin: async () => ({
          ok: false,
          code: "ATTENDANCE_SLOT_POLICY_OVERLAP",
        }),
      },
    },
  );
  assert.equal(overlapRes.status, 409);
  assert.equal((await overlapRes.json()).code, "ATTENDANCE_SLOT_POLICY_OVERLAP");

  // POST success returns 201 and projected policy
  const okRes = await postAttendanceSlotPolicyAdmin(
    makeJsonRequest("https://bi.example.com/api/admin/attendance/slot-policies", "POST", validBody),
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        getSlotPoliciesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        createSlotPolicyAdmin: async () => ({
          ok: true,
          result: {
            replayed: false,
            policy: {
              ...DEFAULT_ATTENDANCE_SLOT_POLICY,
              version: 2,
              effective_from_date: "2026-11-01",
            },
          },
        }),
      },
    },
  );
  assert.equal(okRes.status, 201);
  const okJson = await okRes.json();
  assert.equal(okJson.ok, true);
  assert.equal(okJson.policy.version, 2);
  assert.equal(okJson.policy.effective_from_date, "2026-11-01");
});

test("Wave 2 Attendance Explanation contracts, fingerprints, and API handlers enforce same-origin, validation, idempotency, and approver routing", async () => {
  const EXPLANATION_ID = "69000000-0000-4000-8000-0000000000e9";

  // 1. Query and body parsers
  const parsedOverviewQuery = parseAttendanceExplanationsQuery(
    new URL("https://bi.example.com/api/attendance/explanations?business_date=2026-10-07&limit=20&offset=0"),
  );
  assert.equal(parsedOverviewQuery.ok, true);
  if (parsedOverviewQuery.ok) {
    assert.equal(parsedOverviewQuery.value.business_date, "2026-10-07");
    assert.equal(parsedOverviewQuery.value.limit, 20);
  }

  const parsedSubmitBody = parseSubmitAttendanceExplanationBody({
    business_date: "2026-10-07",
    slot_code: "SLOT_2",
    reason: "  Đi gặp đối tác tuyển dụng  ",
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(parsedSubmitBody.ok, true);
  if (parsedSubmitBody.ok) {
    assert.equal(parsedSubmitBody.value.slot_code, "SLOT_2");
    assert.equal(parsedSubmitBody.value.reason, "Đi gặp đối tác tuyển dụng");
  }

  assert.equal(
    parseSubmitAttendanceExplanationBody({
      business_date: "2026-10-07",
      slot_code: "SLOT_99",
      reason: "Invalid slot",
      idempotency_key: IDEMPOTENCY_KEY,
    }).ok,
    false,
  );

  const parsedInboxQuery = parseAttendanceExplanationApprovalInboxQuery(
    new URL("https://bi.example.com/api/attendance/explanations/approvals?status=PENDING&limit=20&offset=0"),
  );
  assert.equal(parsedInboxQuery.ok, true);
  if (parsedInboxQuery.ok) {
    assert.equal(parsedInboxQuery.value.status, "PENDING");
    assert.equal(parsedInboxQuery.value.limit, 20);
  }

  const parsedDecideBody = parseDecideAttendanceExplanationBody({
    decision: "APPROVE",
    expected_row_version: 1,
    decision_note: "  Xác nhận hợp lệ ",
    idempotency_key: IDEMPOTENCY_KEY,
  });
  assert.equal(parsedDecideBody.ok, true);
  if (parsedDecideBody.ok) {
    assert.equal(parsedDecideBody.value.decision, "APPROVE");
    assert.equal(parsedDecideBody.value.decision_note, "Xác nhận hợp lệ");
  }

  // 2. Request fingerprints are deterministic and sensitive to field changes
  const fp1 = computeExplanationSubmitRequestFingerprint({
    app_user_id: STAFF_USER_ID,
    business_date: "2026-10-07",
    slot_code: "SLOT_1",
    reason: "Lý do A",
  });
  const fp2 = computeExplanationSubmitRequestFingerprint({
    app_user_id: STAFF_USER_ID,
    business_date: "2026-10-07",
    slot_code: "SLOT_2",
    reason: "Lý do A",
  });
  assert.notEqual(fp1, fp2);

  const dfp1 = computeExplanationDecideRequestFingerprint({
    app_user_id: APP_USER_ID,
    explanation_id: EXPLANATION_ID,
    decision: "APPROVE",
    expected_row_version: 1,
    decision_note: "",
  });
  const dfp2 = computeExplanationDecideRequestFingerprint({
    app_user_id: APP_USER_ID,
    explanation_id: EXPLANATION_ID,
    decision: "REJECT",
    expected_row_version: 1,
    decision_note: "",
  });
  assert.notEqual(dfp1, dfp2);

  const sampleExplanationItem = {
    explanation_id: EXPLANATION_ID,
    app_user_id: STAFF_USER_ID,
    requester: {
      app_user_id: STAFF_USER_ID,
      display_name: "Nguyễn Văn A",
      login_id: "nva",
      personnel_code: "NV001",
      recruiter_id: null,
      account_enabled: true,
    },
    business_date: "2026-10-07",
    slot_code: "SLOT_1",
    slot_index: 1,
    slot_label: "Time 1",
    session_code: "AM",
    target_time: "07:30",
    grace_before_minutes: 15,
    grace_after_minutes: 15,
    policy_version_used: 1,
    original_slot_status: "MISSING",
    effective_slot_status: "MISSING",
    related_checkins: [],
    reason: "Đi khảo sát dự án sáng sớm",
    status: "PENDING",
    route_kind: "TEAM_LEADER",
    unit_kind_snapshot: "RECRUITMENT",
    primary_approver: {
      app_user_id: APP_USER_ID,
      display_name: "Admin Test",
      login_id: "admin",
      personnel_code: "AD001",
      recruiter_id: null,
      account_enabled: true,
    },
    routed_team: {
      team_id: BRANCH_ID,
      team_code: "TEAM-01",
      team_name: "Team Bắc Ninh",
    },
    fallback_reason: null,
    submitted_at: "2026-10-07T02:00:00.000Z",
    submitted_at_local: "2026-10-07 09:00:00",
    decided_at: null,
    decided_at_local: null,
    decided_by: null,
    decision_note: "",
    row_version: 1,
    updated_at: "2026-10-07T02:00:00.000Z",
    audit_events: [],
  };

  // 3. GET /api/attendance/explanations
  const getOverviewRes = await getMyAttendanceExplanations(
    new Request("https://bi.example.com/api/attendance/explanations?business_date=2026-10-07"),
    {
      resolveSession: async () => makeSessionOk(STAFF_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        getMyExplanationsOverview: async () => ({
          ok: true,
          data: {
            viewer: {
              app_user_id: STAFF_USER_ID,
              can_submit_explanation: true,
              can_approve_explanations: false,
              is_shared_non_employee: false,
              is_full_admin: false,
              is_bod: false,
            },
            routing: {
              route_kind: "TEAM_LEADER",
              unit_kind: "RECRUITMENT",
              primary_approver: sampleExplanationItem.primary_approver,
              team_id: BRANCH_ID,
              team_code: "TEAM-01",
              team_name: "Team Bắc Ninh",
              fallback_reason: null,
              profile_configured: true,
            },
            today_local: "2026-10-08",
            selected_date: "2026-10-07",
            day_evaluation: {
              business_date: "2026-10-07",
              policy_version_used: 1,
              slots: [],
            },
            pagination: {
              limit: 50,
              offset: 0,
              total_rows: 1,
            },
            items: [sampleExplanationItem],
          },
        }),
      },
    },
  );
  assert.equal(getOverviewRes.status, 200);
  const overviewJson = await getOverviewRes.json();
  assert.equal(overviewJson.ok, true);
  assert.equal(overviewJson.items.length, 1);
  assert.equal(overviewJson.items[0].explanation_id, EXPLANATION_ID);

  // 4. POST /api/attendance/explanations returns 201 on fresh submit and 409 on ineligible slot
  const submitCreatedRes = await postSubmitAttendanceExplanation(
    makeJsonRequest("https://bi.example.com/api/attendance/explanations", "POST", {
      business_date: "2026-10-07",
      slot_code: "SLOT_1",
      reason: "Đi khảo sát dự án sáng sớm",
      idempotency_key: IDEMPOTENCY_KEY,
    }),
    {
      resolveSession: async () => makeSessionOk(STAFF_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        submitExplanation: async () => ({
          ok: true,
          result: {
            replayed: false,
            explanation: sampleExplanationItem,
          },
        }),
      },
    },
  );
  assert.equal(submitCreatedRes.status, 201);

  const submitIneligibleRes = await postSubmitAttendanceExplanation(
    makeJsonRequest("https://bi.example.com/api/attendance/explanations", "POST", {
      business_date: "2026-10-07",
      slot_code: "SLOT_1",
      reason: "Khung giờ đã đúng giờ",
      idempotency_key: IDEMPOTENCY_KEY,
    }),
    {
      resolveSession: async () => makeSessionOk(STAFF_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        submitExplanation: async () => ({
          ok: false,
          code: "ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE",
        }),
      },
    },
  );
  assert.equal(submitIneligibleRes.status, 409);
  assert.equal(
    (await submitIneligibleRes.json()).code,
    "ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE",
  );

  // 5. GET /api/attendance/explanations/approvals & POST decision
  const getInboxRes = await getAttendanceExplanationApprovalInbox(
    new Request("https://bi.example.com/api/attendance/explanations/approvals?status=PENDING"),
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listExplanationApprovalInbox: async () => ({
          ok: true,
          data: {
            viewer: {
              app_user_id: APP_USER_ID,
              can_approve_explanations: true,
              is_full_admin: true,
              is_bod: false,
            },
            pagination: {
              limit: 20,
              offset: 0,
              total_rows: 1,
              pending_count: 1,
            },
            items: [{ ...sampleExplanationItem, can_decide: true }],
          },
        }),
      },
    },
  );
  assert.equal(getInboxRes.status, 200);

  const decideOkRes = await postDecideAttendanceExplanation(
    makeJsonRequest(
      `https://bi.example.com/api/attendance/explanations/approvals/${EXPLANATION_ID}/decision`,
      "POST",
      {
        decision: "APPROVE",
        expected_row_version: 1,
        decision_note: "Đồng ý giải trình",
        idempotency_key: IDEMPOTENCY_KEY,
      },
    ),
    EXPLANATION_ID,
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: {
        getMonthlyMatrixReport: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        listBranchesAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        upsertBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        assignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        unassignEmployeeBranchAdmin: async () => ({ ok: false, code: "ATTENDANCE_REPORT_UNAVAILABLE" }),
        decideExplanation: async () => ({
          ok: true,
          result: {
            replayed: false,
            explanation: {
              ...sampleExplanationItem,
              status: "APPROVED",
              effective_slot_status: "EXPLAINED_APPROVED",
              decided_at: "2026-10-08T01:00:00.000Z",
              decided_at_local: "2026-10-08 08:00:00",
              decided_by: sampleExplanationItem.primary_approver,
              decision_note: "Đồng ý giải trình",
              row_version: 2,
            },
          },
        }),
      },
    },
  );
  assert.equal(decideOkRes.status, 200);
  const decideJson = await decideOkRes.json();
  assert.equal(decideJson.ok, true);
  assert.equal(decideJson.explanation.status, "APPROVED");
  assert.equal(decideJson.explanation.effective_slot_status, "EXPLAINED_APPROVED");

  // 6. Regression test: createServiceAttendanceMonthlyMatrixRepository + API handlers
  // must call exact Wave 2 RPC names and exact DB parameter names (p_actor_auth_subject, p_actor_app_user_id)
  const rpcCalls = [];
  const rpcBackedRepository = createServiceAttendanceMonthlyMatrixRepository(async (name, args) => {
    rpcCalls.push({ name, args });

    if (name === "attendance_get_my_explanations_overview") {
      return {
        data: {
          viewer: {
            app_user_id: APP_USER_ID,
            can_submit_explanation: true,
            can_approve_explanations: true,
            is_shared_non_employee: false,
            is_full_admin: true,
            is_bod: false,
          },
          routing: {
            route_kind: "TEAM_LEADER",
            unit_kind: "RECRUITMENT",
            primary_approver: sampleExplanationItem.primary_approver,
            team_id: BRANCH_ID,
            team_code: "TEAM-01",
            team_name: "Team Bắc Ninh",
            fallback_reason: null,
            profile_configured: true,
          },
          today_local: "2026-10-08",
          selected_date: "2026-10-07",
          day_evaluation: {
            business_date: "2026-10-07",
            policy_version_used: 1,
            slots: [
              {
                slot_code: "SLOT_1",
                slot_index: 1,
                slot_label: "Time 1",
                session_code: "AM",
                target_time: "07:30",
                grace_before_minutes: 15,
                grace_after_minutes: 15,
                is_leave_covered: false,
                original_slot_status: "MISSING",
                slot_status: "MISSING",
                eligible_for_explanation: true,
                checkins: [],
                explanation: null,
              },
            ],
          },
          pagination: {
            limit: 50,
            offset: 0,
            total_rows: 1,
          },
          items: [sampleExplanationItem],
        },
        error: null,
      };
    }

    if (name === "attendance_submit_explanation") {
      return {
        data: {
          replayed: false,
          explanation: sampleExplanationItem,
        },
        error: null,
      };
    }

    if (name === "attendance_list_explanation_approval_inbox") {
      return {
        data: {
          viewer: {
            app_user_id: APP_USER_ID,
            can_approve_explanations: true,
            is_full_admin: true,
            is_bod: false,
          },
          pagination: {
            limit: 50,
            offset: 0,
            total_rows: 1,
            pending_count: 1,
          },
          items: [{ ...sampleExplanationItem, can_decide: true }],
        },
        error: null,
      };
    }

    if (name === "attendance_decide_explanation") {
      return {
        data: {
          replayed: false,
          explanation: {
            ...sampleExplanationItem,
            status: "APPROVED",
            effective_slot_status: "EXPLAINED_APPROVED",
            decided_at: "2026-10-08T01:00:00.000Z",
            decided_at_local: "2026-10-08 08:00:00",
            decided_by: sampleExplanationItem.primary_approver,
            decision_note: "Đồng ý giải trình",
            row_version: 2,
          },
        },
        error: null,
      };
    }

    return {
      data: null,
      error: { code: "42883", message: `unexpected RPC ${name}` },
    };
  });

  const overviewViaRepoRes = await getMyAttendanceExplanations(
    new Request("https://bi.example.com/api/attendance/explanations?business_date=2026-10-07"),
    {
      resolveSession: async () => makeSessionOk(STAFF_CAPS, ALL_SCOPE),
      repository: rpcBackedRepository,
    },
  );
  assert.equal(overviewViaRepoRes.status, 200);

  const expectedSubmitFp = computeExplanationSubmitRequestFingerprint({
    app_user_id: APP_USER_ID,
    business_date: "2026-10-07",
    slot_code: "SLOT_1",
    reason: "Đi khảo sát dự án sáng sớm",
  });
  const submitViaRepoRes = await postSubmitAttendanceExplanation(
    makeJsonRequest("https://bi.example.com/api/attendance/explanations", "POST", {
      business_date: "2026-10-07",
      slot_code: "SLOT_1",
      reason: "Đi khảo sát dự án sáng sớm",
      idempotency_key: IDEMPOTENCY_KEY,
    }),
    {
      resolveSession: async () => makeSessionOk(STAFF_CAPS, ALL_SCOPE),
      repository: rpcBackedRepository,
    },
  );
  assert.equal(submitViaRepoRes.status, 201);

  const inboxViaRepoRes = await getAttendanceExplanationApprovalInbox(
    new Request("https://bi.example.com/api/attendance/explanations/approvals?status=PENDING"),
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: rpcBackedRepository,
    },
  );
  assert.equal(inboxViaRepoRes.status, 200);

  const expectedDecideFp = computeExplanationDecideRequestFingerprint({
    app_user_id: APP_USER_ID,
    explanation_id: EXPLANATION_ID,
    decision: "APPROVE",
    expected_row_version: 1,
    decision_note: "Đồng ý giải trình",
  });
  const decideViaRepoRes = await postDecideAttendanceExplanation(
    makeJsonRequest(
      `https://bi.example.com/api/attendance/explanations/approvals/${EXPLANATION_ID}/decision`,
      "POST",
      {
        decision: "APPROVE",
        expected_row_version: 1,
        decision_note: "Đồng ý giải trình",
        idempotency_key: IDEMPOTENCY_KEY,
      },
    ),
    EXPLANATION_ID,
    {
      resolveSession: async () => makeSessionOk(FULL_ADMIN_CAPS, ALL_SCOPE),
      repository: rpcBackedRepository,
    },
  );
  assert.equal(decideViaRepoRes.status, 200);

  assert.equal(rpcCalls.length, 4);

  assert.equal(rpcCalls[0].name, "attendance_get_my_explanations_overview");
  assert.deepEqual(rpcCalls[0].args, {
    p_actor_auth_subject: AUTH_SUBJECT,
    p_actor_app_user_id: APP_USER_ID,
    p_business_date: "2026-10-07",
  });
  assert.equal("p_auth_subject" in rpcCalls[0].args, false);
  assert.equal("p_app_user_id" in rpcCalls[0].args, false);

  assert.equal(rpcCalls[1].name, "attendance_submit_explanation");
  assert.deepEqual(rpcCalls[1].args, {
    p_actor_auth_subject: AUTH_SUBJECT,
    p_actor_app_user_id: APP_USER_ID,
    p_business_date: "2026-10-07",
    p_slot_code: "SLOT_1",
    p_reason: "Đi khảo sát dự án sáng sớm",
    p_idempotency_key: IDEMPOTENCY_KEY,
    p_request_fingerprint: expectedSubmitFp,
  });
  assert.equal("p_auth_subject" in rpcCalls[1].args, false);
  assert.equal("p_app_user_id" in rpcCalls[1].args, false);

  assert.equal(rpcCalls[2].name, "attendance_list_explanation_approval_inbox");
  assert.deepEqual(rpcCalls[2].args, {
    p_actor_auth_subject: AUTH_SUBJECT,
    p_actor_app_user_id: APP_USER_ID,
    p_status_filter: "PENDING",
  });
  assert.equal("p_auth_subject" in rpcCalls[2].args, false);
  assert.equal("p_app_user_id" in rpcCalls[2].args, false);

  assert.equal(rpcCalls[3].name, "attendance_decide_explanation");
  assert.deepEqual(rpcCalls[3].args, {
    p_actor_auth_subject: AUTH_SUBJECT,
    p_actor_app_user_id: APP_USER_ID,
    p_explanation_id: EXPLANATION_ID,
    p_decision: "APPROVE",
    p_expected_row_version: 1,
    p_decision_note: "Đồng ý giải trình",
    p_idempotency_key: IDEMPOTENCY_KEY,
    p_request_fingerprint: expectedDecideFp,
  });
  assert.equal("p_auth_subject" in rpcCalls[3].args, false);
  assert.equal("p_app_user_id" in rpcCalls[3].args, false);
});
