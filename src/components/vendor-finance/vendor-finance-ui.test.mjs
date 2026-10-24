import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relUrl) => readFileSync(new URL(relUrl, import.meta.url), "utf8");

const pkgJson = JSON.parse(read("../../../package.json"));
const navRegistry = read("../../lib/navigation/registry.ts");
const desktopNav = read("../app-shell/desktop-nav.tsx");
const mobileNav = read("../app-shell/mobile-nav.tsx");
const appShell = read("../app-shell/app-shell.tsx");

const financeGate = read("../../app/finance/_lib/finance-page-gate.tsx");
const financeLayout = read("../../app/finance/layout.tsx");
const financeIndexPage = read("../../app/finance/page.tsx");
const financeVendorsPage = read("../../app/finance/vendors/page.tsx");
const financeOpeningPage = read("../../app/finance/opening-balance/page.tsx");
const financeVendorDetailPage = read("../../app/finance/vendors/[vendorId]/page.tsx");
const financeDocumentPage = read("../../app/finance/documents/[entryId]/page.tsx");
const financeReportsPage = read("../../app/finance/reports/page.tsx");
const financeProjectAssignmentsPage = read("../../app/finance/project-assignments/page.tsx");

const uiModel = read("../../lib/vendor-finance/ui-model.ts");
const listView = read("./vendor-finance-list-view.tsx");
const detailView = read("./vendor-finance-detail-view.tsx");
const openingWizard = read("./opening-balance-wizard.tsx");
const entryDialogs = read("./vendor-finance-entry-dialogs.tsx");
const evidenceDialogs = read("./vendor-finance-evidence-dialog.tsx");
const documentView = read("./vendor-finance-document-view.tsx");
const monthlyReportView = read("./vendor-finance-monthly-report-view.tsx");
const governanceView = read("./vendor-finance-governance-view.tsx");
const documentCss = read("./vendor-finance-document.module.css");

test("Navigation & AppShell register Tài chính (/finance) with server capability predicate, feature gate, and print-hidden header", () => {
  assert.match(navRegistry, /id:\s*"finance"/);
  assert.match(navRegistry, /label:\s*"Tài chính"/);
  assert.match(navRegistry, /path:\s*"\/finance"/);
  assert.match(navRegistry, /capability:\s*"finance"/);
  assert.match(desktopNav, /finance:\s*Landmark/);
  assert.match(mobileNav, /finance:\s*Landmark/);
  assert.match(appShell, /entry\.id !== "finance" \|\| vendorFinanceEnabled/);
  assert.match(appShell, /process\.env\.DIRECT_ENTRY_API_ENABLED === "true"/);
  assert.match(appShell, /print:hidden/);
});

test("/finance/** routes enforce server-side renderVendorFinancePageGate with view vs record modes and Next.js 16 async params", () => {
  assert.match(financeLayout, /export const dynamic = "force-dynamic"/);
  assert.match(financeLayout, /resolveNavActorForAppShell\(/);
  assert.match(financeLayout, /<AppShell actor=\{actor\}>/);

  assert.match(financeGate, /import "server-only"/);
  assert.match(financeGate, /await connection\(\)/);
  assert.match(financeGate, /process\.env\.DIRECT_ENTRY_API_ENABLED/);
  assert.match(financeGate, /resolveActorForRequest\(\)/);
  assert.match(financeGate, /createVendorFinanceRepository\(\)\.getActorAccess\(/);
  assert.match(financeGate, /decideVendorFinancePageAccess\(/);
  assert.match(financeGate, /case "NOT_FOUND":\s*notFound\(\)/);
  assert.match(financeGate, /case "REDIRECT_LOGIN":/);
  assert.match(financeGate, /case "ACCOUNT_UNAVAILABLE":\s*return <AccountUnavailable \/>/);
  assert.match(financeGate, /case "TEMPORARY_UNAVAILABLE":\s*return <TemporaryUnavailable \/>/);
  assert.match(financeGate, /case "ACCESS_DENIED":\s*return <AccessDenied \/>/);

  for (const pageSrc of [
    financeIndexPage,
    financeVendorsPage,
    financeOpeningPage,
    financeVendorDetailPage,
    financeDocumentPage,
    financeReportsPage,
    financeProjectAssignmentsPage,
  ]) {
    assert.match(pageSrc, /export const dynamic = "force-dynamic"/);
    assert.match(pageSrc, /renderVendorFinancePageGate\(/);
  }

  // Opening balance wizard route is strictly gated by `requiredMode: "record"` (blocks BoD / view-only on direct URL)
  assert.match(financeOpeningPage, /requiredMode:\s*"record"/);
  // Project assignments & global roles governance route is strictly gated by `requiredMode: "admin"`
  assert.match(financeProjectAssignmentsPage, /requiredMode:\s*"admin"/);
  for (const viewPageSrc of [
    financeIndexPage,
    financeVendorsPage,
    financeVendorDetailPage,
    financeDocumentPage,
    financeReportsPage,
  ]) {
    assert.match(viewPageSrc, /requiredMode:\s*"view"/);
  }

  // Next.js 16 async params validation
  assert.match(financeVendorDetailPage, /params:\s*Promise<\{\s*vendorId:\s*string\s*\}>/);
  assert.match(financeVendorDetailPage, /await params/);
  assert.match(financeVendorDetailPage, /isCanonicalUiVendorId\(/);
  assert.match(financeDocumentPage, /params:\s*Promise<\{\s*entryId:\s*string\s*\}>/);
  assert.match(financeDocumentPage, /await params/);
  assert.match(financeDocumentPage, /isUuidString\(/);
});

test("Vendor List & Detail views implement KPIs, debounced search, pagination, view-only gating, and non-optimistic server refreshes", () => {
  // Vendor list view
  assert.match(listView, /PageShell/);
  assert.match(listView, /PageHeader/);
  assert.match(listView, /FilterToolbar/);
  assert.match(listView, /DataTableContainer/);
  assert.match(listView, /DATA_TABLE_CLASS/);
  assert.match(listView, /OffsetPager/);
  assert.match(listView, /StatusBadge/);
  assert.match(listView, /vfin-kpi-payable/);
  assert.match(listView, /vfin-kpi-advance/);
  assert.match(listView, /vfin-kpi-nonzero-count/);
  assert.match(listView, /vfin-kpi-net/);
  assert.match(listView, /vfin-view-only-badge/);
  assert.match(listView, /canRecord \? \(\s*<Link\s+href="\/finance\/opening-balance"/);
  assert.doesNotMatch(listView, /method:\s*"(POST|PUT|PATCH|DELETE)"/);

  // Vendor detail view: KPIs, accessible tablist, CursorLoadMore ledger, OffsetPager reconciliations, role-gated write CTAs
  assert.match(detailView, /CursorLoadMore/);
  assert.match(detailView, /OffsetPager/);
  assert.match(detailView, /role="tablist"/);
  assert.match(detailView, /role="tab"/);
  assert.match(detailView, /role="tabpanel"/);
  assert.match(detailView, /ArrowRight/);
  assert.match(detailView, /ArrowLeft/);
  assert.match(detailView, /data-ui-panel-motion="true"/);
  assert.match(detailView, /vendor\.totals\.debt_recorded_minor/);
  assert.match(detailView, /vendor\.totals\.payroll_recorded_minor/);
  assert.match(detailView, /vendor\.totals\.payment_recorded_minor/);
  assert.match(detailView, /vendor\.totals\.advance_recorded_minor/);
  assert.match(detailView, /canRecord && entry\.can_reverse/);
  assert.match(detailView, /canRecord && entry\.can_attach_evidence/);
  assert.match(detailView, /canReconcile && rec\.can_attach_evidence/);
  assert.match(detailView, /vendor && canReconcile/);
  assert.match(detailView, /vendor && canRecord && allowedEntryTypes\.length > 0/);
  assert.match(detailView, /vfin-subledger-switcher/);
});

test("VFIN-02: Monthly project debt report & Full Admin governance views enforce non-netted sub-ledgers, MISSING_CANONICAL_SOURCE revenue disclosure, and OCC/idempotent admin dialogs", () => {
  assert.match(monthlyReportView, /PROJECT_REVENUE_MISSING_SOURCE_LABEL_VI/);
  assert.match(monthlyReportView, /PROJECT_REVENUE_MISSING_SOURCE_NOTE_VI/);
  assert.match(monthlyReportView, /parseMonthlyReportEnvelope\(/);
  assert.match(monthlyReportView, /buildMonthlyReportUrl\(/);
  assert.match(monthlyReportView, /buildVendorEntriesUrl\(/);
  assert.match(monthlyReportView, /CursorLoadMore/);
  assert.doesNotMatch(monthlyReportView, /method:\s*"(POST|PUT|PATCH|DELETE)"/);

  assert.match(governanceView, /role="tablist"/);
  assert.match(governanceView, /vfin-governance-panel-assignments/);
  assert.match(governanceView, /vfin-governance-panel-vendors/);
  assert.match(governanceView, /vfin-governance-panel-global-roles/);
  assert.match(governanceView, /buildAssignProjectAccountantRequest\(/);
  assert.match(governanceView, /buildEndProjectAccountantRequest\(/);
  assert.match(governanceView, /buildSetProjectVendorLinkRequest\(/);
  assert.match(governanceView, /buildAssignGlobalRoleRequest\(/);
  assert.match(governanceView, /buildEndGlobalRoleRequest\(/);
  assert.doesNotMatch(governanceView, /type="checkbox"/);
});

test("Entry, Reversal, Reconciliation, Evidence, and Opening Balance Wizard honor two-phase evidence commit, non-auto-adjustment, and atomic batch rules", () => {
  // Record entry & Reconciliation dialogs lock into post-commit evidence recovery if image upload fails
  assert.match(entryDialogs, /vfin-record-entry-evidence-recovery/);
  assert.match(entryDialogs, /vfin-reconciliation-evidence-recovery/);
  assert.match(entryDialogs, /uploadEvidenceForCommittedTarget\(/);
  assert.match(evidenceDialogs, /uploadEvidenceForCommittedTarget\(/);
  assert.match(evidenceDialogs, /parseEvidenceDownloadEnvelope\(/);

  // Reconciliation explicitly states it never auto-creates an adjustment and never calls /entries
  assert.match(entryDialogs, /Không tự động sinh điều chỉnh \(adjustment\)/);
  const [, recDialogSection] = entryDialogs.split("export function CreateVendorReconciliationDialog");
  assert.ok(recDialogSection);
  assert.doesNotMatch(recDialogSection, /buildVendorEntriesUrl|buildRecordEntryRequest/);

  // Opening balance 3-step wizard (`input` -> `preview` -> `confirm` -> `applied`) + whole-batch rollback alert
  assert.match(openingWizard, /vfin-opening-step-input/);
  assert.match(openingWizard, /vfin-opening-step-preview/);
  assert.match(openingWizard, /vfin-opening-step-confirm/);
  assert.match(openingWizard, /vfin-opening-step-applied/);
  assert.match(openingWizard, /buildOpeningPreviewRequest\(/);
  assert.match(openingWizard, /buildOpeningApplyRequest\(/);
  assert.match(openingWizard, /parseOpeningPreviewEnvelope\(/);
  assert.match(openingWizard, /parseOpeningApplyEnvelope\(/);
  assert.match(openingWizard, /isWholeBatchRollback/);
  assert.match(openingWizard, /Toàn bộ lô đầu kỳ bị từ chối/);
  assert.match(openingWizard, /toàn bộ lô\s+sẽ tự động hủy/);
  assert.match(uiModel, /Toàn bộ lô đầu kỳ đã được hủy nguyên vẹn/);
});

test("Semantic printable voucher uses HTML + @media print CSS, server snapshot fields, mandatory non-bank-proof disclaimer, and zero PDF libraries", () => {
  assert.match(documentView, /<article/);
  assert.match(documentView, /window\.print\(\)/);
  assert.match(documentView, /\/brand\/hrpartner-logo\.png/);
  assert.match(documentView, /entry\.vendor_display_name_snapshot/);
  assert.match(documentView, /entry\.document_no/);
  assert.match(documentView, /entry\.document_title_vi/);
  assert.match(documentView, /vfin-voucher-disclaimer/);
  assert.match(documentView, /VFIN_UI_INTERNAL_DISCLAIMER_VI/);

  assert.match(documentCss, /@page\s*\{\s*size:\s*A4 portrait;\s*margin:\s*12mm;\s*\}/);
  assert.match(documentCss, /@media print/);
  assert.match(documentCss, /\.screenOnly\s*\{\s*display:\s*none !important;\s*\}/);

  const allDeps = {
    ...(pkgJson.dependencies ?? {}),
    ...(pkgJson.devDependencies ?? {}),
  };
  for (const forbiddenPdfPkg of [
    "jspdf",
    "pdfmake",
    "html2pdf.js",
    "@react-pdf/renderer",
    "puppeteer-pdf",
    "react-to-print",
  ]) {
    assert.equal(
      forbiddenPdfPkg in allDeps,
      false,
      `Forbidden PDF/print library ${forbiddenPdfPkg} must not be added`,
    );
  }
});

test("Client Vendor Finance modules contain zero browser Supabase calls, zero permission editors, zero floating-point money math, and zero node/server-only runtime imports", () => {
  const clientFiles = [
    ["ui-model.ts", uiModel],
    ["vendor-finance-list-view.tsx", listView],
    ["vendor-finance-detail-view.tsx", detailView],
    ["opening-balance-wizard.tsx", openingWizard],
    ["vendor-finance-entry-dialogs.tsx", entryDialogs],
    ["vendor-finance-evidence-dialog.tsx", evidenceDialogs],
    ["vendor-finance-document-view.tsx", documentView],
    ["vendor-finance-monthly-report-view.tsx", monthlyReportView],
    ["vendor-finance-governance-view.tsx", governanceView],
  ];

  for (const [name, src] of clientFiles) {
    assert.doesNotMatch(src, /from\s+["']node:/, `${name} must not import node:*`);
    assert.doesNotMatch(src, /["']server-only["']/, `${name} must not import server-only`);
    assert.doesNotMatch(
      src,
      /@supabase\/|supabase\.from\(|rest\/v1|service_role/i,
      `${name} must not access Supabase/PostgREST from browser`,
    );
    assert.doesNotMatch(
      src,
      /import\s+(?!type\b)[^;]*vendor-finance-contract/,
      `${name} must only use import type from vendor-finance-contract`,
    );
    assert.doesNotMatch(
      src,
      /parseFloat\s*\(|Number\.parseFloat\s*\(/,
      `${name} must not use parseFloat for monetary values`,
    );
    assert.doesNotMatch(
      src,
      /ma trận quyền|permission.?matrix|capability.?editor/i,
      `${name} must not introduce permission editor or matrix`,
    );
    assert.equal(
      src.includes("text-primary-foreground"),
      false,
      `${name} must not use broken token text-primary-foreground`,
    );
  }
});
