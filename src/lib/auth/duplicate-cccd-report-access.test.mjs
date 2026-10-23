/**
 * PRE-W2-HF-D1 + HF Duplicate CCCD Self-Service Actions - Duplicate-CCCD report Dashboard tab,
 * controlled actions, and route gates.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { NAV_ENTRIES, findEntryByPath } from "../navigation/registry.ts";
import { canViewDuplicateCccdReport } from "./direct-entry-page-access.ts";

function actor(capabilities = [], scopes = [{ kind: "all", reference: "all" }]) {
  return {
    ok: true,
    actor: {
      auth_subject: "subject-fixture",
      app_user_id: "user-fixture",
      display_name: "Fixture",
      enabled: true,
      capabilities,
      scopes,
      self_recruiter_suggestion: null,
      session: { provider: "supabase", verification: "getUser", authenticated_at: null },
    },
  };
}

test("canViewDuplicateCccdReport follows the resolved actor and fails closed", () => {
  assert.equal(canViewDuplicateCccdReport(actor([])), true);
  assert.equal(canViewDuplicateCccdReport(actor(["entry_own"], [{ kind: "own", reference: "own" }])), true);
  assert.equal(canViewDuplicateCccdReport(
    actor(["team_manager_assign"], [{ kind: "team", reference: "t" }])), true);
  assert.equal(canViewDuplicateCccdReport(null), false);
  for (const reason of [
    "UNAUTHENTICATED", "ACTOR_DISABLED", "ACTOR_MAPPING_MISSING", "AMBIGUOUS_RECRUITER_LINK",
  ]) {
    assert.equal(canViewDuplicateCccdReport({ ok: false, reason }), false, reason);
  }
});

test("the report is Dashboard-only: no standalone nav entry or page", () => {
  assert.equal(NAV_ENTRIES.some((candidate) => candidate.id === "duplicate-cccd-report"), false,
    "the standalone menu entry must be removed");
  assert.equal(NAV_ENTRIES.some((candidate) => candidate.path.startsWith("/dashboard?tab=")), false,
    "no nav entry should deep-link to a dashboard tab");
  assert.equal(findEntryByPath("/dashboard")?.id, "dashboard");
  assert.equal(NAV_ENTRIES.some((candidate) => candidate.path.startsWith("/reports")), false);
  assert.equal(NAV_ENTRIES.some((candidate) => candidate.id === "workforce-offboarding"), false,
    "offboarding moved beside duplicate CCCD inside Dashboard");
  assert.equal(findEntryByPath("/reports/duplicate-cccd"), undefined);
  assert.throws(
    () => readFileSync(new URL("../../app/reports/duplicate-cccd/page.tsx", import.meta.url), "utf8"),
    "the standalone report page must stay gone",
  );
});

test("the CCCD report follows team and the offboarding report follows CCCD", () => {
  const tabs = readFileSync(
    new URL("../../components/dashboard/bod-dashboard-tabs.tsx", import.meta.url), "utf8");
  assert.match(tabs, /key: "general", label: "Báo cáo tổng quát"/);
  assert.match(tabs, /key: "team", label: "Báo cáo theo nhóm"/);
  assert.match(tabs, /key: "duplicate-cccd", label: "Báo cáo CCCD trùng"/);
  assert.match(tabs, /key: "offboarding", label: "Báo cáo NLĐ nghỉ việc"/);
  assert.ok(tabs.indexOf('key: "team"') < tabs.indexOf('key: "duplicate-cccd"'),
    "the CCCD tab must come right after the team tab");
  assert.ok(tabs.indexOf('key: "duplicate-cccd"') < tabs.indexOf('key: "offboarding"'),
    "the offboarding tab must come after duplicate CCCD");
  assert.match(tabs, /DuplicateCccdReportPanel/);
  assert.match(tabs, /canViewDuplicateCccd/);
  assert.match(tabs, /tab\.key === "duplicate-cccd"\s*\?\s*canViewDuplicateCccd/);
  assert.match(tabs, /rawTab === "duplicate-cccd" && canViewDuplicateCccd/);
  assert.match(tabs, /primaryTabLabel === undefined/);
  assert.match(tabs, /id="bod-panel-duplicate-cccd"/);
});

test("the Dashboard page + view server-gate the CCCD tab for every audience", () => {
  const page = readFileSync(new URL("../../app/dashboard/page.tsx", import.meta.url), "utf8");
  assert.match(page, /canViewDuplicateCccdReport\(actor\)/);
  assert.match(page, /type DashboardTab = "general" \| "deep" \| "team" \| "duplicate-cccd" \| "offboarding"/);
  assert.match(page, /tab === "duplicate-cccd" && !canViewDuplicateCccd/);
  assert.match(page, /tab === "duplicate-cccd" \|\| tab === "offboarding"\) && sourcePresent/);
  assert.match(page, /normalizedDashboardPath\(params, tab, true\)/);
  assert.match(page, /canViewDuplicateCccd=\{canViewDuplicateCccd\}/);

  const view = readFileSync(
    new URL("../../components/dashboard/dashboard-view.tsx", import.meta.url), "utf8");
  assert.match(view, /primaryTabLabel="Báo cáo theo nhóm"/);
  assert.match(view, /primaryTabLabel="Tổng quan cá nhân"/);
  assert.match(view, /mode\.kind === "team"/);
  assert.match(view, /mode\.kind === "own"/);
  assert.ok(view.indexOf('mode.kind === "team"') < view.indexOf("<BodDashboardTabs"),
    "team-scoped branch uses the tab shell");
});

test("the panel keeps masked CCCD + states, controlled actions, managed_only filter, and never consumes dashboard filters", () => {
  const panel = readFileSync(
    new URL("../../components/reporting/duplicate-cccd-report-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /maskedCccd/);
  for (const state of ["loading", "denied", "unavailable", "error"]) {
    assert.ok(panel.includes(`kind === "${state}"`), state);
  }
  assert.match(panel, /Thử tải lại/);
  assert.match(panel, /EmptyState/);
  assert.match(panel, /nextDuplicateCccdReportPage/);
  assert.match(panel, /clampDuplicateCccdReportPage/);
  assert.match(panel, /\/api\/direct-entry\/duplicate-cccd-report/);
  assert.match(panel, /buildDuplicateCccdReportQuery\(\{ page, page_size: pageSize, managed_only: managedOnly \}\)/);
  assert.match(panel, /Chỉ dự án tôi quản lý/);
  assert.match(panel, /key=\{episode\.entry_id\}/);
  assert.match(panel, /episode\.can_mark_off/);
  assert.match(panel, /episode\.can_self_withdraw/);
  assert.match(panel, /Rút trùng/);
  assert.match(panel, /FormDialog/);
  assert.match(panel, /Lý do nghỉ việc/);
  assert.match(panel, /\/privileged-edit/);
  assert.match(panel, /\/api\/direct-entry\/duplicate-cccd-report\/self-withdraw/);
  assert.match(panel, /không xóa hồ sơ gốc/);
  assert.match(panel, /useNotify\(\)/);
  // The panel is independent of dashboard URL filters and never mentions internal authority/project_id.
  assert.doesNotMatch(panel, /useQueryStates|useSearchParams|nuqs|bucket_key/);
  assert.doesNotMatch(panel, /project_id|authority/);
  assert.doesNotMatch(panel, /animate-bounce|animate-ping|animate-spin/);
});

test("both GET report and POST self-withdraw routes keep the server-side DIRECT_ENTRY_API_ENABLED gate", () => {
  const route = readFileSync(
    new URL("../../app/api/direct-entry/duplicate-cccd-report/route.ts", import.meta.url), "utf8");
  assert.match(route, /DIRECT_ENTRY_API_ENABLED/);
  assert.match(route, /createDuplicateCccdReportRepository/);

  const selfWithdrawRoute = readFileSync(
    new URL("../../app/api/direct-entry/duplicate-cccd-report/self-withdraw/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(selfWithdrawRoute, /DIRECT_ENTRY_API_ENABLED/);
  assert.match(selfWithdrawRoute, /createDuplicateCccdSelfWithdrawRepository/);
  assert.match(selfWithdrawRoute, /duplicateCccdSelfWithdraw/);
});
