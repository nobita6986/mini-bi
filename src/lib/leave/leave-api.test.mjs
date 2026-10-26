import assert from "node:assert/strict";
import { test } from "node:test";

import {
  handleExportMonthlyLeaveReport,
  handleGetApprovalInbox,
  handleGetLeaveAdminConfig,
  handleGetMonthlyLeaveReport,
  handleGetMyLeaveSummary,
  handlePatchLeaveAdminConfig,
  handlePostApplyOpeningBalances,
  handlePostCreateLeaveRequest,
  handlePostDecideLeaveRequest,
  handlePostPreviewOpeningBalances,
  handlePostWithdrawLeaveRequest,
} from "./leave-api.ts";
import {
  leaveHttpStatusForError,
  parseApplyOpeningBatchBody,
  parseCreateLeaveRequestBody,
  parseDecideLeaveRequestBody,
  parseMonthlyReportQuery,
  parseMyLeaveSummaryQuery,
  parsePatchAdminConfigBody,
} from "./leave-contract.ts";
import { mapLeaveRpcError } from "./leave-repository.ts";

const ACTOR_AUTH = "00000000-0000-4000-8000-000000000101";
const ACTOR_APP = "00000000-0000-4000-8000-000000000201";
const TARGET_APP = "00000000-0000-4000-8000-000000000202";
const REQ_ID = "00000000-0000-4000-8000-000000000301";

function mockActiveSession() {
  return async () => ({
    actor: {
      ok: true,
      actor: {
        auth_subject: ACTOR_AUTH,
        app_user_id: ACTOR_APP,
        enabled: true,
        capabilities: [],
        scopes: [],
      },
    },
  });
}

function createNoopRepo(overrides = {}) {
  return {
    async getMySummary() {
      return { ok: true, data: { leave_year: 2026 } };
    },
    async createRequest() {
      return { ok: true, data: { replayed: false, request: { request_id: REQ_ID } } };
    },
    async withdrawRequest() {
      return { ok: true, data: { replayed: false, request: { request_id: REQ_ID, status: "WITHDRAWN" } } };
    },
    async listApprovalInbox() {
      return { ok: true, data: { total: 0, items: [] } };
    },
    async decideRequest() {
      return { ok: true, data: { replayed: false, request: { request_id: REQ_ID, status: "APPROVED" } } };
    },
    async getAdminOverview() {
      return { ok: true, data: { total_employees: 0, employees: [] } };
    },
    async patchAdminConfig() {
      return { ok: true, data: { replayed: false } };
    },
    async previewOpeningBatch() {
      return { ok: true, data: { valid: true, rows: [] } };
    },
    async applyOpeningBatch() {
      return { ok: true, data: { replayed: false, batch: { batch_id: REQ_ID } } };
    },
    async getMonthlyReport() {
      return {
        ok: true,
        data: {
          year_month: "2026-03",
          leave_year: 2026,
          month: 3,
          total: 1,
          rows: [
            {
              app_user_id: ACTOR_APP,
              account: {
                personnel_code: "NV001",
                display_name: "Nguyễn Văn A",
                login_id: "nguyenvana",
              },
              routing: {
                team_name: "Team Alpha",
              },
              employment_status: "OFFICIAL",
              unit_kind: "RECRUITMENT",
              work_start_date: "2025-01-10",
              official_effective_date: "2025-03-10",
              month_paid_leave_units: 3,
              month_unpaid_probation_units: 0,
              month_unpaid_other_units: 0,
              month_pending_units: 1,
              balance: {
                carry_over_granted_units: 2,
                monthly_accrued_units: 6,
                seniority_granted_units: 0,
                consumed_units: 3,
                reserved_units: 2,
                expired_units: 0,
                available_units: 3,
              },
            },
          ],
        },
      };
    },
    ...overrides,
  };
}

test("leave-contract parsers validate inputs and build deterministic fingerprints", () => {
  const summaryQuery = parseMyLeaveSummaryQuery(
    new URL("https://bi.example.com/api/leave/me?year=2026"),
  );
  assert.deepEqual(summaryQuery, { ok: true, leave_year: 2026 });

  const badSummaryQuery = parseMyLeaveSummaryQuery(
    new URL("https://bi.example.com/api/leave/me?actor=123"),
  );
  assert.deepEqual(badSummaryQuery, { ok: false, code: "INVALID_QUERY" });

  const createParsed1 = parseCreateLeaveRequestBody({
    idempotency_key: "idem-001",
    reason: "Nghỉ việc gia đình",
    days: [
      { leave_date: "2026-03-21", session_code: "am" },
      { leave_date: "2026-03-20", session_code: "FULL" },
    ],
  });
  const createParsed2 = parseCreateLeaveRequestBody({
    idempotency_key: "idem-002",
    reason: "Nghỉ việc gia đình",
    days: [
      { leave_date: "2026-03-20", session_code: "FULL" },
      { leave_date: "2026-03-21", session_code: "AM" },
    ],
  });
  assert.equal(createParsed1.ok, true);
  assert.equal(createParsed2.ok, true);
  assert.equal(
    createParsed1.data.request_fingerprint,
    createParsed2.data.request_fingerprint,
    "Sorting days produces deterministic fingerprint regardless of input order",
  );

  const dupDate = parseCreateLeaveRequestBody({
    idempotency_key: "idem-dup",
    reason: "Nghỉ phép",
    days: [
      { leave_date: "2026-03-20", session_code: "AM" },
      { leave_date: "2026-03-20", session_code: "PM" },
    ],
  });
  assert.deepEqual(dupDate, {
    ok: false,
    code: "LEAVE_REQUEST_DUPLICATE_DATE",
  });

  const rejectWithoutReason = parseDecideLeaveRequestBody(REQ_ID, {
    idempotency_key: "idem-dec-1",
    decision: "REJECT",
    expected_row_version: 1,
    reason: "   ",
  });
  assert.deepEqual(rejectWithoutReason, {
    ok: false,
    code: "LEAVE_REASON_REQUIRED",
  });

  const cancelWithoutReason = parseDecideLeaveRequestBody(REQ_ID, {
    idempotency_key: "idem-dec-2",
    decision: "CANCEL_APPROVED",
    expected_row_version: 2,
  });
  assert.deepEqual(cancelWithoutReason, {
    ok: false,
    code: "LEAVE_REASON_REQUIRED",
  });

  const approveWithoutReason = parseDecideLeaveRequestBody(REQ_ID, {
    idempotency_key: "idem-dec-3",
    decision: "APPROVE",
    expected_row_version: 1,
  });
  assert.equal(approveWithoutReason.ok, true);

  const patchPolicy = parsePatchAdminConfigBody({
    operation: "UPDATE_POLICY",
    carry_over_expiry_month: 3,
    carry_over_expiry_day: 31,
    expected_row_version: 1,
    reason: "Cấu hình hạn phép năm cũ 31/03",
    idempotency_key: "idem-pol-1",
  });
  assert.equal(patchPolicy.ok, true);

  const patchGrant = parsePatchAdminConfigBody({
    operation: "MANAGE_MODULE_GRANT",
    action: "GRANT",
    target_app_user_id: TARGET_APP,
    role_code: "HR_REPORT_VIEWER",
    expected_row_version: 0,
    reason: "Cấp quyền xem báo cáo phép tháng cho HR",
    idempotency_key: "idem-grant-1",
  });
  assert.equal(patchGrant.ok, true);

  const applyBatch = parseApplyOpeningBatchBody({
    leave_year: 2026,
    reason: "Nhập số dư đầu kỳ 2026",
    idempotency_key: "idem-open-1",
    rows: [
      {
        app_user_id: TARGET_APP,
        carry_over_units: 4,
        opening_current_year_units: 0,
        seniority_units: 2,
        note: "Đầu kỳ",
      },
    ],
  });
  assert.equal(applyBatch.ok, true);

  const reportQuery = parseMonthlyReportQuery(
    new URL("https://bi.example.com/api/leave/reports/monthly?month=2026-03&unit_kind=MARKETING"),
  );
  assert.equal(reportQuery.ok, true);
});

test("leave-api enforces feature gate, rejects disallowed authority headers, and enforces CSRF on mutations", async () => {
  const deps = {
    resolveSession: mockActiveSession(),
    repository: createNoopRepo(),
  };

  const gated = await handleGetMyLeaveSummary(
    new Request("https://bi.example.com/api/leave/me"),
    "false",
    deps,
  );
  assert.equal(gated.status, 404);

  for (const header of [
    "x-app-user-id",
    "x-actor-id",
    "x-auth-subject",
    "x-capabilities",
    "x-scope",
    "x-approver-id",
  ]) {
    const res = await handleGetMyLeaveSummary(
      new Request("https://bi.example.com/api/leave/me", {
        headers: { [header]: "spoofed" },
      }),
      "true",
      deps,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "DISALLOWED_AUTHORITY_HEADER");
  }

  const crossOriginPost = await handlePostCreateLeaveRequest(
    new Request("https://bi.example.com/api/leave/requests", {
      method: "POST",
      headers: {
        Host: "bi.example.com",
        Origin: "https://evil.example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idempotency_key: "idem-1",
        reason: "Nghỉ phép",
        days: [{ leave_date: "2026-03-20", session_code: "FULL" }],
      }),
    }),
    "true",
    deps,
  );
  assert.equal(crossOriginPost.status, 403);
  const csrfBody = await crossOriginPost.json();
  assert.equal(csrfBody.code, "CSRF_ORIGIN_MISMATCH");
});

test("leave-api passes session-resolved actor to repository and maps status codes accurately", async () => {
  let capturedSummaryInput = null;
  let capturedCreateInput = null;

  const deps = {
    resolveSession: mockActiveSession(),
    repository: createNoopRepo({
      async getMySummary(input) {
        capturedSummaryInput = input;
        return { ok: true, data: { leave_year: 2026, available_units: 6 } };
      },
      async createRequest(input) {
        capturedCreateInput = input;
        return {
          ok: true,
          data: { replayed: false, request: { request_id: REQ_ID } },
        };
      },
    }),
  };

  const summaryRes = await handleGetMyLeaveSummary(
    new Request("https://bi.example.com/api/leave/me?year=2026"),
    "true",
    deps,
  );
  assert.equal(summaryRes.status, 200);
  assert.deepEqual(capturedSummaryInput, {
    auth_subject: ACTOR_AUTH,
    app_user_id: ACTOR_APP,
    leave_year: 2026,
  });

  const createRes = await handlePostCreateLeaveRequest(
    new Request("https://bi.example.com/api/leave/requests", {
      method: "POST",
      headers: {
        Host: "bi.example.com",
        Origin: "https://bi.example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idempotency_key: "idem-create-1",
        reason: "Nghỉ việc riêng",
        days: [{ leave_date: "2026-03-25", session_code: "AM" }],
      }),
    }),
    "true",
    deps,
  );
  assert.equal(createRes.status, 201);
  assert.equal(capturedCreateInput.auth_subject, ACTOR_AUTH);
  assert.equal(capturedCreateInput.app_user_id, ACTOR_APP);

  assert.equal(
    mapLeaveRpcError({ code: "23505", message: "LEAVE_REQUEST_OVERLAP" }),
    "LEAVE_REQUEST_OVERLAP",
  );
  assert.equal(leaveHttpStatusForError("LEAVE_REQUEST_OVERLAP"), 409);
  assert.equal(leaveHttpStatusForError("LEAVE_ROW_VERSION_CONFLICT"), 409);
  assert.equal(leaveHttpStatusForError("LEAVE_INSUFFICIENT_BALANCE"), 422);
  assert.equal(leaveHttpStatusForError("LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED"), 422);
  assert.equal(leaveHttpStatusForError("LEAVE_SHARED_ACCOUNT_FORBIDDEN"), 403);
  assert.equal(leaveHttpStatusForError("LEAVE_REPORT_FORBIDDEN"), 403);
});

test("leave-api monthly report and .xlsx export return valid workbook with formatted half-day units", async () => {
  const deps = {
    resolveSession: mockActiveSession(),
    repository: createNoopRepo(),
  };

  const jsonRes = await handleGetMonthlyLeaveReport(
    new Request("https://bi.example.com/api/leave/reports/monthly?month=2026-03"),
    "true",
    deps,
  );
  assert.equal(jsonRes.status, 200);
  const jsonPayload = await jsonRes.json();
  assert.equal(jsonPayload.ok, true);
  assert.equal(jsonPayload.data.year_month, "2026-03");

  const exportRes = await handleExportMonthlyLeaveReport(
    new Request("https://bi.example.com/api/leave/reports/monthly/export?month=2026-03"),
    "true",
    deps,
  );
  assert.equal(exportRes.status, 200);
  assert.equal(
    exportRes.headers.get("content-type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.match(
    exportRes.headers.get("content-disposition") ?? "",
    /bao-cao-nghi-phep-thang-2026-03\.xlsx/,
  );

  const arrayBuffer = await exportRes.arrayBuffer();
  assert.ok(arrayBuffer.byteLength > 100);

  const imported = await import("exceljs");
  const workbook = new imported.default.Workbook();
  await workbook.xlsx.load(Buffer.from(arrayBuffer));
  const sheet = workbook.getWorksheet("Nghỉ phép 2026-03");
  assert.ok(sheet, "Worksheet Nghỉ phép 2026-03 exists");
  assert.equal(sheet.getRow(2).getCell(1).value, "NV001");
  assert.equal(sheet.getRow(2).getCell(2).value, "Nguyễn Văn A");
  assert.equal(sheet.getRow(2).getCell(9).value, "1.5"); // 3 half-day units = 1.5 days
  assert.equal(sheet.getRow(2).getCell(12).value, "0.5"); // 1 half-day unit = 0.5 days

  const sameOriginHeaders = {
    Host: "bi.example.com",
    Origin: "https://bi.example.com",
    "Content-Type": "application/json",
  };

  // Also smoke-check withdraw, approvals inbox, decide, admin overview/patch, opening preview/apply
  const withdrawRes = await handlePostWithdrawLeaveRequest(
    new Request(`https://bi.example.com/api/leave/requests/${REQ_ID}/withdraw`, {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({ idempotency_key: "w-1", expected_row_version: 1, reason: "Đổi lịch" }),
    }),
    REQ_ID,
    "true",
    deps,
  );
  assert.equal(withdrawRes.status, 200);

  const inboxRes = await handleGetApprovalInbox(
    new Request("https://bi.example.com/api/leave/approvals?status=PENDING"),
    "true",
    deps,
  );
  assert.equal(inboxRes.status, 200);

  const decideRes = await handlePostDecideLeaveRequest(
    new Request(`https://bi.example.com/api/leave/approvals/${REQ_ID}/decision`, {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({ idempotency_key: "d-1", decision: "APPROVE", expected_row_version: 1 }),
    }),
    REQ_ID,
    "true",
    deps,
  );
  assert.equal(decideRes.status, 200);

  const adminGetRes = await handleGetLeaveAdminConfig(
    new Request("https://bi.example.com/api/leave/admin/config"),
    "true",
    deps,
  );
  assert.equal(adminGetRes.status, 200);

  const adminPatchRes = await handlePatchLeaveAdminConfig(
    new Request("https://bi.example.com/api/leave/admin/config", {
      method: "PATCH",
      headers: sameOriginHeaders,
      body: JSON.stringify({
        operation: "UPDATE_POLICY",
        carry_over_expiry_month: 3,
        carry_over_expiry_day: 31,
        expected_row_version: 1,
        reason: "Cập nhật hạn phép chuyển năm",
        idempotency_key: "p-1",
      }),
    }),
    "true",
    deps,
  );
  assert.equal(adminPatchRes.status, 200);

  const previewRes = await handlePostPreviewOpeningBalances(
    new Request("https://bi.example.com/api/leave/admin/opening-balances/preview", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({
        leave_year: 2026,
        rows: [{ app_user_id: TARGET_APP, carry_over_units: 2, opening_current_year_units: 0, seniority_units: 0 }],
      }),
    }),
    "true",
    deps,
  );
  assert.equal(previewRes.status, 200);

  const applyRes = await handlePostApplyOpeningBalances(
    new Request("https://bi.example.com/api/leave/admin/opening-balances/apply", {
      method: "POST",
      headers: sameOriginHeaders,
      body: JSON.stringify({
        leave_year: 2026,
        reason: "Áp dụng số dư đầu kỳ",
        idempotency_key: "a-1",
        rows: [{ app_user_id: TARGET_APP, carry_over_units: 2, opening_current_year_units: 0, seniority_units: 0 }],
      }),
    }),
    "true",
    deps,
  );
  assert.equal(applyRes.status, 201);
});

test("leave-api monthly report .xlsx export paginates beyond 500 employees and fails closed on incomplete or oversized exports", async () => {
  const makeEmployeeRow = (index) => ({
    app_user_id: `29000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    account: {
      app_user_id: `29000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      display_name: `Nhân sự ${index + 1}`,
      login_id: `nv${index + 1}`,
      personnel_code: `NV${String(index + 1).padStart(4, "0")}`,
    },
    routing: {
      route_kind: "TEAM_LEADER",
      routed_team_code: "TEAM_A",
      routed_team_name: "Team Alpha",
      primary_approver: { display_name: "Trưởng nhóm A" },
    },
    employment_status: "OFFICIAL",
    unit_kind: "RECRUITMENT",
    work_start_date: "2025-01-01",
    official_effective_date: "2025-03-01",
    month_paid_leave_units: 2,
    month_unpaid_probation_units: 0,
    month_unpaid_other_units: 0,
    month_pending_units: 0,
    month_approved_request_count: 1,
    balance: {
      total_granted_units: 6,
      carry_over_granted_units: 0,
      carry_over_available_units: 0,
      monthly_accrued_units: 6,
      seniority_granted_units: 0,
      opening_or_adjustment_units: 0,
      available_units: 4,
      reserved_units: 0,
      consumed_units: 2,
      expired_units: 0,
      pending_paid_units: 0,
      pending_unpaid_units: 0,
      approved_unpaid_units: 0,
    },
  });

  const all620Rows = Array.from({ length: 620 }, (_, idx) => makeEmployeeRow(idx));
  const seenOffsets = [];

  const paginatedDeps = {
    resolveSession: mockActiveSession(),
    repository: createNoopRepo({
      async getMonthlyReport(input) {
        seenOffsets.push({ limit: input.limit, offset: input.offset });
        const slice = all620Rows.slice(input.offset, input.offset + input.limit);
        return {
          ok: true,
          data: {
            year_month: input.year_month ?? "2026-03",
            leave_year: 2026,
            month: 3,
            as_of_date: "2026-03-31",
            unit_kind_filter: "ALL",
            total: all620Rows.length,
            limit: input.limit,
            offset: input.offset,
            rows: slice,
          },
        };
      },
    }),
  };

  const export620Res = await handleExportMonthlyLeaveReport(
    new Request("https://bi.example.com/api/leave/reports/monthly/export?month=2026-03"),
    "true",
    paginatedDeps,
  );
  assert.equal(export620Res.status, 200);
  assert.deepEqual(seenOffsets, [
    { limit: 500, offset: 0 },
    { limit: 500, offset: 500 },
  ]);

  const imported = await import("exceljs");
  const workbook = new imported.default.Workbook();
  await workbook.xlsx.load(Buffer.from(await export620Res.arrayBuffer()));
  const sheet = workbook.getWorksheet("Nghỉ phép 2026-03");
  assert.ok(sheet);
  assert.equal(sheet.rowCount, 621, "Header row + 620 employee rows must all be exported");
  assert.equal(sheet.getRow(621).getCell(1).value, "NV0620");

  // Exceeding MAX_LEAVE_REPORT_EXPORT_ROWS (5000) fails closed with 422
  const oversizedDeps = {
    resolveSession: mockActiveSession(),
    repository: createNoopRepo({
      async getMonthlyReport() {
        return {
          ok: true,
          data: {
            year_month: "2026-03",
            leave_year: 2026,
            month: 3,
            as_of_date: "2026-03-31",
            unit_kind_filter: "ALL",
            total: 5001,
            limit: 500,
            offset: 0,
            rows: [makeEmployeeRow(0)],
          },
        };
      },
    }),
  };
  const oversizedRes = await handleExportMonthlyLeaveReport(
    new Request("https://bi.example.com/api/leave/reports/monthly/export?month=2026-03"),
    "true",
    oversizedDeps,
  );
  assert.equal(oversizedRes.status, 422);
  const oversizedBody = await oversizedRes.json();
  assert.equal(oversizedBody.code, "LEAVE_REPORT_EXPORT_LIMIT_EXCEEDED");
});
