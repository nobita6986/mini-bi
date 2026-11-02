import assert from "node:assert/strict";
import test from "node:test";

import {
  exportAttendanceMonthlyMatrixXlsx,
  getAttendanceBranchesAdmin,
  getAttendanceMonthlyMatrixReport,
  postAttendanceBranchAssignmentAdmin,
  postAttendanceBranchUnassignAdmin,
  postOrPutAttendanceBranchAdmin,
} from "./attendance-monthly-matrix-api.ts";
import {
  ATTENDANCE_MONTHLY_MATRIX_EXPORT_ROW_LIMIT,
  parseAssignBranchBody,
  parseAttendanceMonthlyMatrixQuery,
  parseUnassignBranchBody,
  parseUpsertBranchBody,
} from "./attendance-monthly-matrix-contract.ts";
import {
  ATTENDANCE_REPORT_MAX_PAGE_SIZE,
} from "./attendance-report-contract.ts";
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
