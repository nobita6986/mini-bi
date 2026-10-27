import assert from "node:assert/strict";
import { test } from "node:test";

import {
  autoAllocateDraftDaysByBalance,
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
  leaveRequestStatusBadge,
  leaveRouteKindLabel,
  leaveSessionHalfDayUnits,
  leaveSessionLabel,
  leaveSessionShortLabel,
  leaveTypeBadge,
  leaveTypeLabel,
  leaveTypeShortLabel,
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

  assert.equal(leaveTypeBadge("ANNUAL").label, "Phép năm");
  assert.equal(leaveTypeBadge("BEREAVEMENT").label, "Nghỉ tang");
  assert.equal(leaveTypeBadge("MARRIAGE").label, "Nghỉ cưới");
  assert.equal(leaveTypeBadge("SICK").label, "Nghỉ ốm");
  assert.equal(leaveTypeBadge("UNPAID").label, "Nghỉ không lương");
  assert.equal(leaveTypeShortLabel("MARRIAGE"), "Nghỉ cưới");
  assert.ok(leaveTypeLabel("BEREAVEMENT").includes("tối đa 3 ngày"));
  assert.ok(leaveTypeLabel("SICK").includes("tối đa 7 ngày"));
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

test("WP2 evaluateLeaveRequestDraft validates explicit leave types, per-type day limits, multi-type allocation, and balance", () => {
  const officialBalance = {
    has_profile: true,
    profile_configured: true,
    employment_status: "OFFICIAL",
    work_start_date: "2025-01-15",
    official_effective_date: "2025-03-15",
    available_units: 6, // 3 days available
  };

  // 1. Official employee with 1 FULL day + 1 AM half-day = 3 units (1.5 days) ANNUAL, sufficient balance
  const okOfficial = evaluateLeaveRequestDraft({
    days: [
      { leave_date: "2026-05-10", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2026-05-11", session_code: "AM", leave_type: "ANNUAL" },
    ],
    reason: "",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(okOfficial.valid, true);
  assert.equal(okOfficial.reason_error, null);
  assert.equal(okOfficial.total_units, 3);
  assert.equal(okOfficial.total_days, 1.5);
  assert.equal(okOfficial.annual_units, 3);
  assert.equal(okOfficial.non_annual_units, 0);
  assert.equal(okOfficial.unpaid_notice, null);

  // 2. Requesting 4 days ANNUAL when only 3 days (6 units) remain -> blocked with split suggestion
  const insufficient = evaluateLeaveRequestDraft({
    days: [
      { leave_date: "2026-05-10", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2026-05-11", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2026-05-12", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2026-05-13", session_code: "FULL", leave_type: "ANNUAL" },
    ],
    reason: "Nghỉ phép 4 ngày",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(insufficient.valid, false);
  assert.equal(insufficient.exceeds_available_balance, true);
  assert.equal(insufficient.can_split_excess_annual_to_unpaid, true);

  // Auto-splitting 4 days with 3 days (6 units) available -> 3 days ANNUAL + 1 day UNPAID, now valid!
  const splitDays = autoAllocateDraftDaysByBalance(
    [
      { leave_date: "2026-05-10", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2026-05-11", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2026-05-12", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2026-05-13", session_code: "FULL", leave_type: "ANNUAL" },
    ],
    6,
    "UNPAID",
  );
  assert.deepEqual(
    splitDays.map((d) => d.leave_type),
    ["ANNUAL", "ANNUAL", "ANNUAL", "UNPAID"],
  );
  const validAfterSplit = evaluateLeaveRequestDraft({
    days: splitDays,
    reason: "Nghỉ phép 4 ngày chia 3 phép năm + 1 không lương",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(validAfterSplit.valid, true);
  assert.equal(validAfterSplit.annual_units, 6);
  assert.equal(validAfterSplit.non_annual_units, 2);

  // Auto-splitting when 0.5 day (1 unit) ANNUAL remains on a FULL day -> splits that date into AM ANNUAL + PM UNPAID
  const halfDaySplit = autoAllocateDraftDaysByBalance(
    [{ leave_date: "2026-05-10", session_code: "FULL", leave_type: "ANNUAL" }],
    1,
    "UNPAID",
  );
  assert.deepEqual(halfDaySplit, [
    { leave_date: "2026-05-10", session_code: "AM", leave_type: "ANNUAL" },
    { leave_date: "2026-05-10", session_code: "PM", leave_type: "UNPAID" },
  ]);

  // 3. Non-annual leave (UNPAID / SICK / MARRIAGE / BEREAVEMENT) with 0 available annual balance is valid
  const unpaidWithZeroBalance = evaluateLeaveRequestDraft({
    days: [{ leave_date: "2026-05-12", session_code: "PM", leave_type: "UNPAID" }],
    reason: "Việc riêng",
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
  assert.equal(unpaidWithZeroBalance.valid, true);
  assert.equal(unpaidWithZeroBalance.total_units, 1);
  assert.equal(unpaidWithZeroBalance.annual_units, 0);
  assert.equal(unpaidWithZeroBalance.non_annual_units, 1);

  // 4. Per-request type limits: BEREAVEMENT > 3 days (6 units) is rejected
  const overBereavement = evaluateLeaveRequestDraft({
    days: [
      { leave_date: "2026-05-10", session_code: "FULL", leave_type: "BEREAVEMENT" },
      { leave_date: "2026-05-11", session_code: "FULL", leave_type: "BEREAVEMENT" },
      { leave_date: "2026-05-12", session_code: "FULL", leave_type: "BEREAVEMENT" },
      { leave_date: "2026-05-13", session_code: "AM", leave_type: "BEREAVEMENT" },
    ],
    reason: "",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(overBereavement.valid, false);
  assert.deepEqual(
    overBereavement.exceeded_type_limits.map((item) => item.leave_type),
    ["BEREAVEMENT"],
  );

  // 5. Duplicate date with same leave_type in the same request is rejected, but AM + PM with different leave_type is allowed
  const duplicate = evaluateLeaveRequestDraft({
    days: [
      { leave_date: "2026-05-15", session_code: "AM", leave_type: "ANNUAL" },
      { leave_date: "2026-05-15", session_code: "PM", leave_type: "ANNUAL" },
    ],
    reason: "Trùng ngày",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.duplicate_dates.length, 1);

  const sameDateDiffTypes = evaluateLeaveRequestDraft({
    days: [
      { leave_date: "2026-05-15", session_code: "AM", leave_type: "ANNUAL" },
      { leave_date: "2026-05-15", session_code: "PM", leave_type: "SICK" },
    ],
    reason: "Sáng phép năm chiều nghỉ ốm",
    leaveYear: 2026,
    balance: officialBalance,
  });
  assert.equal(sameDateDiffTypes.valid, true);

  // 6. Cross-year date is rejected
  const wrongYear = evaluateLeaveRequestDraft({
    days: [{ leave_date: "2027-01-02", session_code: "FULL", leave_type: "ANNUAL" }],
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

  // Reject without a reason is allowed
  assert.equal(
    validateApproverDecisionInput({
      actorAppUserId: "leader-1",
      request: { status: "PENDING", app_user_id: "user-1" },
      decision: "REJECT",
      reason: "   ",
    }).ok,
    true,
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

  // Cancel approved requires APPROVED status but not a reason
  assert.equal(
    validateApproverDecisionInput({
      actorAppUserId: "leader-1",
      request: { status: "APPROVED", app_user_id: "user-1" },
      decision: "CANCEL_APPROVED",
      reason: "",
    }).ok,
    true,
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

  // Allowed when preview succeeded and signatures match; admin reason is optional
  assert.equal(
    canApplyOpeningBatch({
      leaveYear: 2026,
      rows: bulk.rows,
      preview: validPreview,
      previewSignature: sig1,
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
    }).ok,
    false,
  );

  // Optional reason does not block applying a valid preview
  assert.equal(
    canApplyOpeningBatch({
      leaveYear: 2026,
      rows: bulk.rows,
      preview: validPreview,
      previewSignature: sig1,
    }).ok,
    true,
  );

  // Blocked when preview has error rows
  assert.equal(
    canApplyOpeningBatch({
      leaveYear: 2026,
      rows: bulk.rows,
      preview: { ...validPreview, valid: false, error_row_count: 1 },
      previewSignature: sig1,
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
