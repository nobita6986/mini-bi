/**
 * PRE-W2-HF-D1 - Duplicate-CCCD report is Dashboard-only (navigation + tab).
 *
 * Bao cao CCCD trung chi con nam trong tab Dashboard `/dashboard?tab=duplicate-cccd` (tab thu ba
 * sau "Bao cao theo nhom"); KHONG con muc navigation doc lap. `canViewDuplicateCccdReport` van mo
 * cho moi account nghiep vu hop le (actor resolve ok) va general/team khong bi mo rong. Quyen that
 * do API/RPC (#87) quyet dinh.
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
  // The only way to open the report is the Dashboard entry itself.
  assert.equal(findEntryByPath("/dashboard")?.id, "dashboard");
  // No standalone report page was recreated.
  assert.equal(NAV_ENTRIES.some((candidate) => candidate.path.startsWith("/reports")), false);
  assert.equal(findEntryByPath("/reports/duplicate-cccd"), undefined);
  assert.throws(
    () => readFileSync(new URL("../../app/reports/duplicate-cccd/page.tsx", import.meta.url), "utf8"),
    "the standalone report page must stay gone",
  );
});

test("the CCCD report is the Dashboard tab right after the team tab", () => {
  const tabs = readFileSync(
    new URL("../../components/dashboard/bod-dashboard-tabs.tsx", import.meta.url), "utf8");
  assert.match(tabs, /key: "general", label: "Báo cáo tổng quát"/);
  assert.match(tabs, /key: "team", label: "Báo cáo theo nhóm"/);
  assert.match(tabs, /key: "duplicate-cccd", label: "Báo cáo CCCD trùng"/);
  assert.ok(tabs.indexOf('key: "team"') < tabs.indexOf('key: "duplicate-cccd"'),
    "the CCCD tab must come right after the team tab");
  assert.match(tabs, /DuplicateCccdReportPanel/);
  assert.match(tabs, /canViewDuplicateCccd/);
  assert.match(tabs, /tab\.key === "duplicate-cccd"[\s\S]*canViewDuplicateCccd/);
  assert.match(tabs, /primaryTabLabel === undefined/);
  assert.match(tabs, /id="bod-panel-duplicate-cccd"/);
});

test("the Dashboard page + view server-gate the CCCD tab for every audience", () => {
  const page = readFileSync(new URL("../../app/dashboard/page.tsx", import.meta.url), "utf8");
  assert.match(page, /canViewDuplicateCccdReport\(actor\)/);
  assert.match(page, /type DashboardTab = "general" \| "deep" \| "team" \| "duplicate-cccd"/);
  assert.match(page, /tab === "duplicate-cccd" && !canViewDuplicateCccd/);
  // `source` (a general-only filter) is stripped before the deep/CCCD/team tab renders.
  assert.match(page, /\(tab === "deep" \|\| tab === "team" \|\| tab === "duplicate-cccd"\) && sourcePresent/);
  assert.match(page, /normalizedDashboardPath\(params, tab, true\)/);
  assert.match(page, /canViewDuplicateCccd=\{canViewDuplicateCccd\}/);

  const view = readFileSync(
    new URL("../../components/dashboard/dashboard-view.tsx", import.meta.url), "utf8");
  // Every dashboard audience gets the shared tab shell while scoped audiences
  // keep their own report as the primary tab.
  assert.match(view, /primaryTabLabel="Báo cáo theo nhóm"/);
  assert.match(view, /primaryTabLabel="Tổng quan cá nhân"/);
  assert.match(view, /mode\.kind === "team"/);
  assert.match(view, /mode\.kind === "own"/);
  assert.ok(view.indexOf('mode.kind === "team"') < view.indexOf("<BodDashboardTabs"),
    "team-scoped branch uses the tab shell");
});

test("the panel keeps masked CCCD + states and never consumes dashboard filters", () => {
  const panel = readFileSync(
    new URL("../../components/reporting/duplicate-cccd-report-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /maskedCccd/);
  for (const state of ["loading", "denied", "unavailable", "error"]) {
    assert.ok(panel.includes(`kind === "${state}"`), state);
  }
  assert.match(panel, /Thử tải lại/);
  assert.match(panel, /EmptyState/);
  assert.match(panel, /nextDuplicateCccdReportPage/);
  assert.match(panel, /\/api\/direct-entry\/duplicate-cccd-report/);
  assert.match(panel, /buildDuplicateCccdReportQuery\(\{ page, page_size: pageSize \}\)/);
  assert.match(panel, /useNotify\(\)/);
  // The panel is independent of dashboard URL filters: it never reads them.
  assert.doesNotMatch(panel, /useQueryStates|useSearchParams|nuqs|bucket_key/);
  assert.doesNotMatch(panel, /project_id|authority/);
});

test("the API route keeps the existing server-side gate", () => {
  const route = readFileSync(
    new URL("../../app/api/direct-entry/duplicate-cccd-report/route.ts", import.meta.url), "utf8");
  assert.match(route, /DIRECT_ENTRY_API_ENABLED/);
  assert.match(route, /createDuplicateCccdReportRepository/);
});
