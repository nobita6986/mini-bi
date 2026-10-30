import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const layoutSource = readFileSync(
  new URL("../../app/salary-advances/layout.tsx", import.meta.url),
  "utf8"
);
const pageSource = readFileSync(
  new URL("../../app/salary-advances/page.tsx", import.meta.url),
  "utf8"
);
const workspaceSource = readFileSync(
  new URL("./salary-advance-workspace.tsx", import.meta.url),
  "utf8"
);
const uiModelSource = readFileSync(
  new URL("../../lib/salary-advance/salary-advance-ui-model.ts", import.meta.url),
  "utf8"
);

test("/salary-advances layout and page enforce server-side session and DIRECT_ENTRY_API_ENABLED gates", () => {
  assert.match(layoutSource, /resolveNavActorForAppShell/);
  assert.match(layoutSource, /<AppShell\s+actor=\{actor\}>\{children\}<\/AppShell>/);

  assert.match(pageSource, /resolveActorForRequest/);
  assert.match(pageSource, /decideSalaryAdvancePageAccess/);
  assert.match(pageSource, /process\.env\.DIRECT_ENTRY_API_ENABLED/);
  assert.match(pageSource, /redirect\(["']\/login\?next=%2Fsalary-advances["']\)/);
  assert.match(pageSource, /<SalaryAdvanceWorkspace\s*\/>/);
});

test("SalaryAdvanceWorkspace uses shared BI UI primitives and follows motion/storage/R2 hygiene", () => {
  for (const primitive of [
    "PageShell",
    "PageHeader",
    "Card",
    "CardHeader",
    "DataTableContainer",
    "FilterToolbar",
    "FormDialog",
    "CursorLoadMore",
    "StatusBadge",
    "StatusBanner",
    "EmptyState",
    "ErrorState",
    "Button",
    "useNotify",
  ]) {
    assert.match(
      workspaceSource,
      new RegExp(`\\b${primitive}\\b`),
      `Workspace must use shared primitive ${primitive}`
    );
  }

  for (const forbidden of [
    "localStorage",
    "sessionStorage",
    "window.confirm",
    "transition-all",
    "animate-spin",
    "animate-bounce",
    "animate-ping",
    "storage_key",
  ]) {
    assert.equal(
      workspaceSource.includes(forbidden),
      false,
      `Workspace must NOT contain forbidden token: ${forbidden}`
    );
  }
});

test("SalaryAdvanceWorkspace covers 'Yêu cầu tôi tạo' (PM), 'Cần xử lý' (Accountant), 'Đối chiếu ảnh nhận tiền', missing portrait warning & REVIEWED lock, and OCC 409 reload", () => {
  // Capability tabs
  assert.match(uiModelSource, /Yêu cầu tôi tạo/);
  assert.match(uiModelSource, /Cần xử lý/);
  assert.match(uiModelSource, /Giám sát toàn miền/);

  // Side-by-side comparison panel "Đối chiếu ảnh nhận tiền"
  assert.match(workspaceSource, /Đối chiếu ảnh nhận tiền/);
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-photo-comparison-panel"/
  );
  assert.match(
    workspaceSource,
    /grid-cols-1\s+lg:grid-cols-2/,
    "Comparison panel must be side-by-side on wide screens and stacked vertically on narrow screens"
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-worker-portrait-card"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-evidence-photo-card"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-missing-portrait-warning"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-confirm-reviewed-btn"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-request-retake-btn"/
  );

  // Action buttons gated strictly by availableActions (derived from server allowed_actions)
  assert.match(workspaceSource, /availableActions\.canApprove/);
  assert.match(workspaceSource, /availableActions\.canRequestInfo/);
  assert.match(workspaceSource, /availableActions\.canReject/);
  assert.match(workspaceSource, /availableActions\.canMarkHandledExternally/);
  assert.match(workspaceSource, /availableActions\.canProvideInfo/);
  assert.match(workspaceSource, /availableActions\.canWithdraw/);
  assert.match(workspaceSource, /availableActions\.canPostMessage/);
  assert.match(workspaceSource, /comparisonModel\.canUploadEvidence/);
  assert.match(workspaceSource, /comparisonModel\.canReviewEvidence/);
  assert.match(workspaceSource, /!comparisonModel\.canConfirmReviewed/);

  // Timeline & 409 OCC reload handling
  assert.match(workspaceSource, /data-testid="salary-advance-timeline"/);
  assert.match(workspaceSource, /data-testid="salary-advance-conflict-banner"/);
  assert.match(workspaceSource, /handleConflictReload/);
  assert.match(workspaceSource, /Idempotency-Key/);
});

test("SalaryAdvanceWorkspace guards loadRequests, loadRequestDetail, and loadProjectWorkers against out-of-order responses and stale selections", () => {
  // Uses LatestRequestTracker with AbortSignal for all 3 async loaders
  assert.match(workspaceSource, /createLatestRequestTracker/);
  assert.match(workspaceSource, /requestsTrackerRef/);
  assert.match(workspaceSource, /detailTrackerRef/);
  assert.match(workspaceSource, /workersTrackerRef/);
  assert.match(workspaceSource, /signal:\s*req\.signal/);

  // Worker selection reconciliation never auto-selects nextWorkers[0]
  assert.match(workspaceSource, /reconcileSelectedWorkerEntryId/);
  assert.equal(
    workspaceSource.includes("nextWorkers[0].worker_entry_id"),
    false,
    "loadProjectWorkers must never auto-select nextWorkers[0].worker_entry_id"
  );

  // Active detail must be gated by resolveActiveRequestDetail(detail, selectedRequestId)
  assert.match(
    workspaceSource,
    /const\s+activeDetail\s*=\s*resolveActiveRequestDetail\(\s*detail\s*,\s*selectedRequestId\s*\)/
  );
  assert.match(
    workspaceSource,
    /evaluateEvidenceComparisonPanel\(\s*activeDetail/
  );
  assert.match(
    workspaceSource,
    /resolveAvailableRequestActions\(\s*activeDetail\?\.request\.allowed_actions\s*\)/
  );

  // Post-response UI updates in all 4 request-scoped mutation handlers must verify selectedRequestIdRef.current === targetRequest.request_id
  assert.match(workspaceSource, /resolveScopedMutationFailureOutcome/);
  assert.match(
    workspaceSource,
    /if\s*\(\s*selectedRequestIdRef\.current\s*!==\s*requestId\s*\)/,
    "handleConflictReload must guard against setting conflictBannerMessage when selectedRequestId has changed"
  );
  const selectedIdEqualMatches = workspaceSource.match(
    /selectedRequestIdRef\.current\s*===\s*targetRequest\.request_id/g
  );
  assert.ok(
    (selectedIdEqualMatches?.length ?? 0) >= 8,
    "All request-scoped mutation handlers must guard post-await UI updates with selectedRequestIdRef.current === targetRequest.request_id"
  );
});

test("SalaryAdvanceWorkspace renders a compact single-row desktop filter bar with wider search input, concise labels/options, responsive wrapping, and preserved filter behavior", () => {
  // FilterToolbar wraps the 4 filter controls inside a responsive grid that places all 4 on one row on desktop (lg:)
  // while giving the search input a wider track (1.65fr) than the 3 selects (1.05fr, 0.95fr, 0.95fr)
  assert.match(workspaceSource, /dataTestId="salary-advance-filter-toolbar"/);
  assert.match(workspaceSource, /data-testid="salary-advance-filter-grid"/);
  assert.match(
    workspaceSource,
    /grid\s+grid-cols-1\s+gap-2\.5\s+sm:grid-cols-2\s+lg:grid-cols-\[minmax\(0,1\.05fr\)_minmax\(0,0\.95fr\)_minmax\(0,0\.95fr\)_minmax\(0,1\.65fr\)\]\s+lg:items-end/,
    "Filter grid must wrap cleanly on mobile/tablet and place all 4 controls on one row on desktop with wider search column"
  );

  // Action buttons are compact and non-wrapping on the same desktop row
  assert.match(workspaceSource, /data-testid="salary-advance-apply-search-btn"/);
  assert.match(workspaceSource, /data-testid="salary-advance-refresh-btn"/);
  assert.match(workspaceSource, /whitespace-nowrap\s+shrink-0/);

  // Concise labels, option texts, and search placeholder
  assert.match(workspaceSource, /<option value="ALL">Tất cả dự án<\/option>/);
  assert.match(workspaceSource, /\{\s*value:\s*"ALL",\s*label:\s*"Tất cả trạng thái"\s*\}/);
  assert.match(workspaceSource, /\{\s*value:\s*"ALL",\s*label:\s*"Tất cả ảnh"\s*\}/);
  assert.match(workspaceSource, /placeholder="Mã NV hoặc tên NLĐ"/);
  assert.match(
    workspaceSource,
    /htmlFor="salary-advance-search-input"[\s\S]*?>\s*Tìm NLĐ\s*<\/label>/
  );

  // Ensure verbose old option labels / placeholder are removed
  assert.equal(workspaceSource.includes("Tất cả dự án trong phạm vi"), false);
  assert.equal(workspaceSource.includes("Tất cả trạng thái yêu cầu"), false);
  assert.equal(workspaceSource.includes("Tất cả trạng thái ảnh nhận tiền"), false);
  assert.equal(
    workspaceSource.includes("Nhập mã nhân viên hoặc họ tên NLĐ..."),
    false
  );

  // Preserved filter state bindings and query params
  assert.match(workspaceSource, /fetchSalaryAdvanceRequestListPage/);
  assert.match(uiModelSource, /queryParams\.set\("project_id",\s*params\.projectFilter\)/);
  assert.match(
    uiModelSource,
    /queryParams\.set\("request_state",\s*params\.requestStateFilter\)/
  );
  assert.match(
    uiModelSource,
    /queryParams\.set\("evidence_review_state",\s*params\.evidenceStateFilter\)/
  );
  assert.match(
    uiModelSource,
    /queryParams\.set\("search",\s*params\.appliedSearch\.trim\(\)\)/
  );
});

test("SalaryAdvanceWorkspace prevents infinite request list loading by keying loadRequests on primitive tab identifiers and referentially stable badge counts", () => {
  assert.match(
    workspaceSource,
    /const\s+currentTabId\s*=\s*currentTabConfig\?\.id\s*\?\?\s*null/
  );
  assert.match(
    workspaceSource,
    /const\s+currentTabQueue\s*=\s*currentTabConfig\?\.queue\s*\?\?\s*null/
  );
  assert.match(
    workspaceSource,
    /},\s*\[\s*currentTabId\s*,\s*currentTabQueue\s*,\s*loadRequests\s*\]\s*\)/,
    "loadRequests effect must depend on primitive currentTabId and currentTabQueue instead of currentTabConfig object reference"
  );
  assert.match(workspaceSource, /updateTabBadgeCountsForTab/);
  assert.equal(
    workspaceSource.includes("[currentTabConfig, loadRequests]"),
    false,
    "loadRequests effect must not depend on currentTabConfig object reference"
  );
});

test("SalaryAdvanceWorkspace applies resolveSalaryAdvanceActorDisplayName consistently and never falls back to raw actor UUIDs", () => {
  assert.match(workspaceSource, /resolveSalaryAdvanceActorDisplayName/);
  for (const forbiddenUuidFallback of [
    "activeDetail.request.created_by_user_id",
    "comparisonModel.selectedEvidence.uploadedByUserId",
    "comparisonModel.selectedEvidence.reviewedByUserId",
    "ev.actor_user_id",
  ]) {
    assert.equal(
      workspaceSource.includes(forbiddenUuidFallback),
      false,
      `Workspace must not fall back to raw UUID field: ${forbiddenUuidFallback}`
    );
  }
});

test("SalaryAdvanceWorkspace renders mandatory payment method selection, self-owned bank account details, worker eligibility blocking banners, and BANK_TRANSFER receipt comparison", () => {
  // Mandatory payment method selector in Create Request dialog
  assert.match(workspaceSource, /data-testid="salary-advance-create-payment-method"/);
  assert.match(workspaceSource, /data-testid="salary-advance-payment-method-cash"/);
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-payment-method-bank-transfer"/
  );
  assert.match(workspaceSource, /data-testid="salary-advance-worker-bank-info"/);

  // Worker eligibility blocking in Create Request dialog and Detail view
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-worker-eligibility-banner"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-detail-worker-ineligible-banner"/
  );
  assert.match(workspaceSource, /data-testid="salary-advance-detail-payment-method"/);
  assert.match(workspaceSource, /data-testid="salary-advance-detail-bank-destination"/);

  // Comparison panel supports both CASH (worker portrait) and BANK_TRANSFER (bank destination + transfer receipt)
  assert.match(
    workspaceSource,
    /comparisonModel\.requiresWorkerPortraitComparison/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-bank-destination-card"/
  );
  assert.match(workspaceSource, /Đối chiếu chứng từ chuyển khoản/);
  assert.match(workspaceSource, /2\. Chứng từ chuyển khoản \(Bill\)/);
});

test("SalaryAdvanceWorkspace places PM and Accountant queue tabs/badges in PageHeader actions with role='tablist' strictly wrapping only tab buttons and CTA buttons outside tablist, supports dismissing 'Lưu ý nghiệp vụ', exports filtered Excel for accountants, and hides OFF workers in picker", () => {
  // 1. Header action groups, accessible tablist isolation, & badges
  assert.match(workspaceSource, /data-testid="salary-advance-header-actions"/);
  assert.match(workspaceSource, /data-testid="salary-advance-header-tablist"/);
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-header-cta-actions"/
  );
  assert.match(
    workspaceSource,
    /data-testid=\{`salary-advance-tab-\$\{tab\.id\}`\}/
  );
  assert.match(
    workspaceSource,
    /data-testid=\{`salary-advance-tab-badge-\$\{tab\.id\}`\}/
  );
  assert.match(workspaceSource, /data-testid="salary-advance-open-create-btn"/);
  assert.match(workspaceSource, /data-testid="salary-advance-export-excel-btn"/);
  assert.match(workspaceSource, /Xuất Excel/);

  // Verify role="tablist" wraps ONLY visibleTabs -> HeaderTabButton and does NOT contain CTA buttons
  const tablistStart = workspaceSource.indexOf(
    'data-testid="salary-advance-header-tablist"'
  );
  const ctaGroupStart = workspaceSource.indexOf(
    'data-testid="salary-advance-header-cta-actions"'
  );
  assert.ok(tablistStart > 0, "Expected salary-advance-header-tablist in header");
  assert.ok(
    ctaGroupStart > tablistStart,
    "Expected salary-advance-header-cta-actions to be rendered outside and after salary-advance-header-tablist"
  );
  const tablistBlock = workspaceSource.slice(tablistStart, ctaGroupStart);
  assert.match(tablistBlock, /<HeaderTabButton/);
  assert.equal(
    tablistBlock.includes("salary-advance-open-create-btn"),
    false,
    "Create Request button must NOT be inside role='tablist'"
  );
  assert.equal(
    tablistBlock.includes("salary-advance-export-excel-btn"),
    false,
    "Export Excel button must NOT be inside role='tablist'"
  );

  // Verify badge count updates use serverBadgeCount, surface capped badge indicators (badge_count_capped / badge_counts_capped -> badgeDisplayText / data-badge-capped), and guard against filtered/paginated truncation
  assert.match(workspaceSource, /serverBadgeCount:\s*outcome\.data\.badge_count/);
  assert.match(
    workspaceSource,
    /serverBadgeCapped:\s*outcome\.data\.badge_count_capped/
  );
  assert.match(workspaceSource, /hasMore:\s*outcome\.data\.has_more/);
  assert.match(workspaceSource, /loadedContext\.badge_counts/);
  assert.match(workspaceSource, /loadedContext\.badge_counts_capped/);
  assert.match(workspaceSource, /updateTabBadgeCappedForTab/);
  assert.match(
    workspaceSource,
    /data-badge-capped=\{tab\.badgeCapped\s*\?\s*"true"\s*:\s*"false"\}/
  );
  assert.match(
    workspaceSource,
    /<StatusBadge\s+tone=\{badgeTone\}>\{tab\.badgeDisplayText\}<\/StatusBadge>/
  );
  assert.match(
    workspaceSource,
    /includeBadge:\s*Boolean\(options\?\.includeBadge\s*&&\s*!isAppend\)/
  );
  assert.match(uiModelSource, /queryParams\.set\("include_badge",\s*"1"\)/);
  assert.match(uiModelSource, /formatTabBadgeDisplayText/);

  // 2. Dismissible "Lưu ý nghiệp vụ" banner
  assert.match(
    workspaceSource,
    /dataTestId="salary-advance-business-notice-banner"/
  );
  assert.match(
    workspaceSource,
    /dismissTestId="salary-advance-dismiss-business-notice-btn"/
  );
  assert.match(workspaceSource, /dismissLabel="Đóng lưu ý nghiệp vụ"/);
  assert.match(
    workspaceSource,
    /onDismiss=\{\(\)\s*=>\s*setBusinessNoticeDismissed\(true\)\}/
  );

  // 3. Accountant Excel export uses active filter state and buildSalaryAdvanceExportUrl
  assert.match(workspaceSource, /buildSalaryAdvanceExportUrl/);
  assert.match(workspaceSource, /handleExportExcel/);
  assert.match(uiModelSource, /\/api\/salary-advance\/requests\/export/);

  // 4. Worker picker filters out OFF workers while preserving remaining workers with explicit ineligibility reasons
  assert.match(workspaceSource, /filterSelectableProjectWorkers/);
  assert.match(
    workspaceSource,
    /\[Không đủ ĐK:\s*\$\{eligibility\.reasonLabels\.join\("; "\)\s*\|\|\s*eligibility\.statusLabel\}\]/
  );
  assert.match(uiModelSource, /isProjectWorkerHiddenFromPicker/);
});

test("SalaryAdvanceWorkspace renders work information (first work date + recruiter), 30-day advance summary card, and per-worker advance history modal with period filters and pagination", () => {
  // Work information in detail header
  assert.match(workspaceSource, /data-testid="salary-advance-detail-work-info"/);
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-detail-first-work-date"/
  );
  assert.match(workspaceSource, /data-testid="salary-advance-detail-recruiter"/);
  assert.match(workspaceSource, /Ngày đầu tiên làm việc/);
  assert.match(workspaceSource, /Người tuyển dụng/);
  assert.match(workspaceSource, /formatWorkDateVi/);
  assert.match(workspaceSource, /formatWorkerRecruiterLabel/);

  // 30-day advance summary card in Accountant / Supervisory detail view
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-detail-30d-summary"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-detail-30d-count"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-detail-30d-amount"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-open-worker-history-btn"/
  );
  assert.match(workspaceSource, /sanitizeWorker30dSummary/);
  assert.match(workspaceSource, /Tóm tắt ứng lương 30 ngày gần nhất/);
  assert.match(workspaceSource, /SALARY_ADVANCE_30D_SUMMARY_RULE_NOTICE/);

  // Per-worker history modal / drawer
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-worker-history-dialog"/
  );
  assert.match(
    workspaceSource,
    /data-testid=\{`salary-advance-history-mode-\$\{opt\.mode\}`\}/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-history-month-input"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-history-from-date"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-history-to-date"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-history-apply-range-btn"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-worker-history-totals"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-worker-history-total-count"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-worker-history-total-amount"/
  );
  assert.match(
    workspaceSource,
    /data-testid="salary-advance-worker-history-table"/
  );
  assert.match(workspaceSource, /Ngày đối chiếu chứng từ/);
  assert.match(workspaceSource, /Hoàn tất đối chiếu:/);
  assert.match(workspaceSource, /Tạo yêu cầu:/);
  assert.match(workspaceSource, /fetchSalaryAdvanceWorkerHistoryPage/);
  assert.match(workspaceSource, /historyTrackerRef/);
});
