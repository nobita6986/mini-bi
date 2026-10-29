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
});
