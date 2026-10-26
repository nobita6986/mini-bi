import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMonthlyLeaveReportExportUrl,
  buildMonthlyLeaveReportQuery,
  canApplyOpeningBatch,
  canWithdrawOwnLeaveRequest,
  computeOpeningBatchDraftSignature,
  decideLeavePageAccess,
  evaluateLeaveRequestDraft,
  formatHalfDayUnits,
  formatIsoDateVi,
  formatSignedHalfDayUnits,
  halfDayUnitsToDays,
  leaveDecisionActionLabel,
  leaveEmploymentStatusBadge,
  leaveErrorMessage,
  leaveFallbackReasonLabel,
  leaveOpeningRowErrorLabel,
  leavePayTreatmentBadge,
  leaveRequestStatusBadge,
  leaveRouteKindLabel,
  leaveSessionHalfDayUnits,
  leaveSessionLabel,
  leaveSessionShortLabel,
  leaveUnitKindLabel,
  parseDaysInputToHalfDayUnits,
  parseOpeningBalanceBulkText,
  resolveVisibleLeaveTabs,
  validateApproverDecisionInput,
} from "./leave-ui-model.ts";

test("WP2 half-day unit conversions and formatters preserve 1 unit = 0.5 day", () => {
  assert.equal(halfDayUnitsToDays(0), 0);
  assert.equal(halfDayUnitsToDays(1), 0.5);
  assert.equal(halfDayUnitsToDays(2), 1);
  assert.equal(halfDayUnitsToDays(3), 1.5);

  assert.equal(formatHalfDayUnits(0), "0 ngày");
  assert.equal(formatHalfDayUnits(1), "0,5 ngày");
  assert.equal(formatHalfDayUnits(2), "1 ngày");
  assert.equal(formatHalfDayUnits(5), "2,5 ngày");

  assert.equal(formatSignedHalfDayUnits(3), "+1,5 ngày");
  assert.equal(formatSignedHalfDayUnits(-2), "-1 ngày");
  assert.equal(formatSignedHalfDayUnits(0), "0 ngày");

  assert.equal(parseDaysInputToHalfDayUnits("0"), 0);
  assert.equal(parseDaysInputToHalfDayUnits("0.5"), 1);
  assert.equal(parseDaysInputToHalfDayUnits("0,5"), 1);
  assert.equal(parseDaysInputToHalfDayUnits("1.5"), 3);
  assert.equal(parseDaysInputToHalfDayUnits("12"), 24);
  assert.equal(parseDaysInputToHalfDayUnits("0.3"), null);
  assert.equal(parseDaysInputToHalfDayUnits("-1"), null);
  assert.equal(parseDaysInputToHalfDayUnits("abc"), null);
});

test("WP2 session units and Vietnamese labels match WP1 leave contract", () => {
  assert.equal(leaveSessionHalfDayUnits("FULL"), 2);
  assert.equal(leaveSessionHalfDayUnits("AM"), 1);
  assert.equal(leaveSessionHalfDayUnits("PM"), 1);

  assert.equal(leaveSessionShortLabel("FULL"), "Cả ngày");
  assert.equal(leaveSessionShortLabel("AM"), "Buổi sáng");
  assert.equal(leaveSessionShortLabel("PM"), "Buổi chiều");
  assert.equal(leaveSessionLabel("FULL"), "Cả ngày (1 ngày)");

  assert.equal(leaveUnitKindLabel("RECRUITMENT"), "Tuyển dụng");
  assert.equal(leaveUnitKindLabel("MARKETING"), "Marketing");
  assert.equal(leaveUnitKindLabel("IT"), "IT");
  assert.equal(leaveUnitKindLabel("ACCOUNTING"), "Kế toán");

  assert.equal(leaveEmploymentStatusBadge("OFFICIAL").label, "Chính thức");
  assert.equal(leaveEmploymentStatusBadge("PROBATION").label, "Thử việc");
  assert.equal(leaveEmploymentStatusBadge("UNCONFIGURED").label, "Chưa cấu hình");

  assert.equal(leaveRequestStatusBadge("PENDING").label, "Chờ duyệt");
  assert.equal(leaveRequestStatusBadge("APPROVED").label, "Đã duyệt");
  assert.equal(leaveRequestStatusBadge("REJECTED").label, "Từ chối");
  assert.equal(leaveRequestStatusBadge("CANCELLED").label, "Đã hủy sau duyệt");
  assert.equal(leaveRequestStatusBadge("WITHDRAWN").label, "Đã tự rút");

  assert.equal(leavePayTreatmentBadge("PAID_LEAVE").label, "Nghỉ phép có lương");
  assert.equal(leavePayTreatmentBadge("UNPAID_PROBATION").label, "Nghỉ không lương (Thử việc)");
  assert.equal(leaveRouteKindLabel("TEAM_LEADER", "Team Alpha"), "Team Leader (Team Alpha)");
  assert.equal(
    leaveRouteKindLabel("DEPARTMENT_HEAD", null, "MARKETING"),
    "Trưởng bộ phận (Marketing)",
  );
  assert.ok(leaveFallbackReasonLabel("TEAM_WITHOUT_ACTIVE_LEADER")?.includes("Team Leader"));
  assert.equal(formatIsoDateVi("2026-03-31"), "31/03/2026");
});

test("WP2 decideLeavePageAccess and resolveVisibleLeaveTabs project strictly from server authority", () => {
  assert.equal(decideLeavePageAccess({ enabledFlag: "false", actor: null }), "NOT_FOUND");
  assert.equal(
    decideLeavePageAccess({
      enabledFlag: "true",
      actor: { ok: false, reason: "UNAUTHENTICATED" },
    }),
    "REDIRECT_LOGIN",
  );
  assert.equal(
    decideLeavePageAccess({
      enabledFlag: "true",
      actor: { ok: false, reason: "ACTOR_DISABLED" },
    }),
    "ACCOUNT_UNAVAILABLE",
  );

  // Regular employee: only personal tab
  const staffTabs = resolveVisibleLeaveTabs({
    app_user_id: "u1",
    is_shared_non_employee: false,
    is_full_admin: false,
    is_bod: false,
    is_hr_operator: false,
    is_hr_report_viewer: false,
    is_team_leader: false,
    is_department_approver: false,
    can_submit_request: true,
    can_approve_requests: false,
    can_view_monthly_report: false,
    can_manage_config: false,
  });
  assert.deepEqual(
    staffTabs.map((t) => t.id),
    ["personal"],
  );

  // Team Leader / Approver: personal + approvals with badge count
  const leaderTabs = resolveVisibleLeaveTabs(
    {
      app_user_id: "u2",
      is_shared_non_employee: false,
      is_full_admin: false,
      is_bod: false,
      is_hr_operator: false,
      is_hr_report_viewer: false,
      is_team_leader: true,
      is_department_approver: false,
      can_submit_request: true,
      can_approve_requests: true,
      can_view_monthly_report: false,
      can_manage_config: false,
    },
    4,
  );
  assert.deepEqual(
    leaderTabs.map((t) => ({ id: t.id, badge: t.badgeCount ?? null })),
    [
      { id: "personal", badge: null },
      { id: "approvals", badge: 4 },
    ],
  );

  // HR Report Viewer: personal + reports
  const hrViewerTabs = resolveVisibleLeaveTabs({
    app_user_id: "u3",
    is_shared_non_employee: false,
    is_full_admin: false,
    is_bod: false,
    is_hr_operator: false,
    is_hr_report_viewer: true,
    is_team_leader: false,
    is_department_approver: false,
    can_submit_request: true,
    can_approve_requests: false,
    can_view_monthly_report: true,
    can_manage_config: false,
  });
  assert.deepEqual(
    hrViewerTabs.map((t) => t.id),
    ["personal", "reports"],
  );

  // Full Admin / BoD: all 4 tabs
  const adminTabs = resolveVisibleLeaveTabs({
    app_user_id: "u4",
    is_shared_non_employee: false,
    is_full_admin: true,
    is_bod: false,
    is_hr_operator: false,
    is_hr_report_viewer: false,
    is_team_leader: false,
    is_department_approver: false,
    can_submit_request: true,
    can_approve_requests: true,
    can_view_monthly_report: true,
    can_manage_config: true,
  });
  assert.deepEqual(
    adminTabs.map((t) => t.id),
    ["personal", "approvals", "admin", "reports"],
  );
});

test("WP2 evaluateLeaveRequestDraft validates FULL/AM/PM units, duplicate dates, probation unpaid, and official balance", () => {
  const officialBalance = {
    has_profile: true,
    profile_configured: true,
    employment_status: "OFFICIAL",
    work_start_date: "2025-01-15",
    official_effective_date: "2025-03-15",
    available_units: 4,
  };

  // 1. Official employee with 1 FULL day + 1 AM half-day = 3 units (1.5 days), sufficient balance
  const okOfficial = evaluateLeaveRequestDraft({
    days: [
      { leave_date: "2026-05-10", session_code: "FULL" },
      { leave_date: "2026-05-11", session_code: "AM" },
    ],
    reason: "Nghỉ việc gia đình",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(okOfficial.valid, true);
  assert.equal(okOfficial.total_units, 3);
  assert.equal(okOfficial.total_days, 1.5);
  assert.equal(okOfficial.predicted_pay_treatment, "PAID_LEAVE");
  assert.equal(okOfficial.unpaid_notice, null);

  // 2. Official employee exceeding available balance
  const insufficient = evaluateLeaveRequestDraft({
    days: [
      { leave_date: "2026-05-10", session_code: "FULL" },
      { leave_date: "2026-05-11", session_code: "FULL" },
    ],
    reason: "Nghỉ phép",
    leaveYear: 2026,
    balance: { ...officialBalance, available_units: 3 },
  });
  assert.equal(insufficient.valid, false);
  assert.equal(insufficient.exceeds_available_balance, true);

  // 3. Probation employee with 0 available paid leave is allowed as UNPAID_PROBATION
  const probation = evaluateLeaveRequestDraft({
    days: [{ leave_date: "2026-05-12", session_code: "PM" }],
    reason: "Khám sức khỏe",
    leaveYear: 2026,
    balance: {
      has_profile: true,
      profile_configured: true,
      employment_status: "PROBATION",
      work_start_date: "2026-05-01",
      official_effective_date: null,
      available_units: 0,
    },
  });
  assert.equal(probation.valid, true);
  assert.equal(probation.total_units, 1);
  assert.equal(probation.predicted_pay_treatment, "UNPAID_PROBATION");
  assert.ok(probation.unpaid_notice?.includes("Thử việc"));

  // 4. Duplicate date in the same request is rejected
  const duplicate = evaluateLeaveRequestDraft({
    days: [
      { leave_date: "2026-05-15", session_code: "AM" },
      { leave_date: "2026-05-15", session_code: "PM" },
    ],
    reason: "Trùng ngày",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.duplicate_dates.length, 1);

  // 5. Cross-year date is rejected
  const wrongYear = evaluateLeaveRequestDraft({
    days: [{ leave_date: "2027-01-02", session_code: "FULL" }],
    reason: "Khác năm",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(wrongYear.valid, false);
  assert.equal(wrongYear.out_of_year_dates.length, 1);
});

test("WP2 canWithdrawOwnLeaveRequest and validateApproverDecisionInput enforce action rules", () => {
  assert.equal(
    canWithdrawOwnLeaveRequest({
      actorAppUserId: "user-1",
      request: { status: "PENDING", app_user_id: "user-1" },
    }),
    true,
  );
  assert.equal(
    canWithdrawOwnLeaveRequest({
      actorAppUserId: "user-1",
      request: { status: "APPROVED", app_user_id: "user-1" },
    }),
    false,
  );
  assert.equal(
    canWithdrawOwnLeaveRequest({
      actorAppUserId: "user-1",
      request: { status: "PENDING", app_user_id: "user-2" },
    }),
    false,
  );

  // Self approval forbidden
  assert.equal(
    validateApproverDecisionInput({
      actorAppUserId: "user-1",
      request: { status: "PENDING", app_user_id: "user-1" },
      decision: "APPROVE",
      reason: "",
    }).ok,
    false,
  );

  // Approve pending request without reason is ok
  assert.equal(
    validateApproverDecisionInput({
      actorAppUserId: "leader-1",
      request: { status: "PENDING", app_user_id: "user-1" },
      decision: "APPROVE",
      reason: "",
    }).ok,
    true,
  );

  // Reject requires reason
  assert.equal(
    validateApproverDecisionInput({
      actorAppUserId: "leader-1",
      request: { status: "PENDING", app_user_id: "user-1" },
      decision: "REJECT",
      reason: "   ",
    }).ok,
    false,
  );
  assert.equal(
    validateApproverDecisionInput({
      actorAppUserId: "leader-1",
      request: { status: "PENDING", app_user_id: "user-1" },
      decision: "REJECT",
      reason: "Thiếu nhân sự trực ca",
    }).ok,
    true,
  );

  // Cancel approved requires APPROVED status and reason
  assert.equal(
    validateApproverDecisionInput({
      actorAppUserId: "leader-1",
      request: { status: "APPROVED", app_user_id: "user-1" },
      decision: "CANCEL_APPROVED",
      reason: "",
    }).ok,
    false,
  );
  assert.equal(
    validateApproverDecisionInput({
      actorAppUserId: "leader-1",
      request: { status: "APPROVED", app_user_id: "user-1" },
      decision: "CANCEL_APPROVED",
      reason: "Nhân sự đi làm lại theo điều động",
    }).ok,
    true,
  );
  assert.equal(leaveDecisionActionLabel("CANCEL_APPROVED"), "Hủy đơn đã duyệt (hoàn phép)");
});

test("WP2 Opening Balance bulk parser and mandatory preview-before-apply guard", () => {
  const employees = [
    {
      account: {
        app_user_id: "11111111-1111-4111-8111-111111111105",
        display_name: "Nguyen Van A",
        login_id: "nguyenvana",
        personnel_code: "NV005",
        recruiter_id: null,
        account_enabled: true,
      },
      profile: {},
      routing: {},
      balance: {},
    },
  ];
  const bulk = parseOpeningBalanceBulkText(
    [
      "NV005\t2\t1.5\t0.5\tChốt đầu năm",
      "11111111-1111-4111-8111-111111111106,0,3,1,Nhân sự IT",
    ].join("\n"),
    employees,
  );
  assert.equal(bulk.parseErrors.length, 0);
  assert.equal(bulk.rows.length, 2);
  assert.deepEqual(bulk.rows[0], {
    app_user_id: "11111111-1111-4111-8111-111111111105",
    carry_over_units: 4,
    opening_current_year_units: 3,
    seniority_units: 1,
    note: "Chốt đầu năm",
  });
  assert.deepEqual(bulk.rows[1], {
    app_user_id: "11111111-1111-4111-8111-111111111106",
    carry_over_units: 0,
    opening_current_year_units: 6,
    seniority_units: 2,
    note: "Nhân sự IT",
  });

  const sig1 = computeOpeningBatchDraftSignature(2026, bulk.rows);
  const sig2 = computeOpeningBatchDraftSignature(2026, [
    ...bulk.rows.slice(0, 1),
    { ...bulk.rows[1], seniority_units: 4 },
  ]);
  assert.notEqual(sig1, sig2);

  const validPreview = {
    leave_year: 2026,
    carry_over_expires_after_date: "2026-03-31",
    valid: true,
    has_carry_over_expiry_error: false,
    row_count: 2,
    error_row_count: 0,
    total_carry_over_units: 4,
    total_opening_current_year_units: 9,
    total_seniority_units: 3,
    rows: [],
  };

  // Allowed when preview succeeded, signatures match, and reason is provided
  assert.equal(
    canApplyOpeningBatch({
      leaveYear: 2026,
      rows: bulk.rows,
      preview: validPreview,
      previewSignature: sig1,
      reason: "Chốt số dư đầu kỳ 2026",
    }).ok,
    true,
  );

  // Blocked when draft was modified after preview (signature mismatch)
  assert.equal(
    canApplyOpeningBatch({
      leaveYear: 2026,
      rows: [
        ...bulk.rows.slice(0, 1),
        { ...bulk.rows[1], seniority_units: 4 },
      ],
      preview: validPreview,
      previewSignature: sig1,
      reason: "Chốt số dư đầu kỳ 2026",
    }).ok,
    false,
  );

  // Blocked when reason is empty
  assert.equal(
    canApplyOpeningBatch({
      leaveYear: 2026,
      rows: bulk.rows,
      preview: validPreview,
      previewSignature: sig1,
      reason: "   ",
    }).ok,
    false,
  );

  // Blocked when preview has error rows
  assert.equal(
    canApplyOpeningBatch({
      leaveYear: 2026,
      rows: bulk.rows,
      preview: { ...validPreview, valid: false, error_row_count: 1 },
      previewSignature: sig1,
      reason: "Chốt số dư đầu kỳ 2026",
    }).ok,
    false,
  );
});

test("WP2 Monthly report query and export URL builders include server-side filters", () => {
  const qs = buildMonthlyLeaveReportQuery({
    month: "2026-10",
    unit_kind: "MARKETING",
    search: "  Nguyen Van A ",
    limit: 50,
    offset: 100,
  });
  assert.equal(
    qs,
    "?month=2026-10&unit_kind=MARKETING&search=Nguyen+Van+A&limit=50&offset=100",
  );

  const exportUrl = buildMonthlyLeaveReportExportUrl({
    month: "2026-10",
    unit_kind: "ALL",
    search: "NV001",
  });
  assert.equal(
    exportUrl,
    "/api/leave/reports/monthly/export?month=2026-10&search=NV001",
  );

  assert.ok(leaveOpeningRowErrorLabel("LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED").includes("hạn"));
  assert.ok(leaveErrorMessage("LEAVE_SHARED_ACCOUNT_FORBIDDEN").includes("dùng chung"));
});
