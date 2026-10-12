/**
 * P3.1-HF-R3-R1 - Dashboard tab placement + server-derived access gate.
 *
 * Khoa: bao cao CCCD trung KHONG con la muc top-level nav; no la tab ngang hang tren Dashboard
 * ngay sau "Bao cao theo nhom". Tab chi la metadata hien thi (server-derived) - quyen that do
 * API/RPC #74 quyet dinh. Predicate dung authority cua RPC: Full Admin triple |
 * catalog_master_manage | entry_privileged_edit, kem effective all scope.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { duplicateCccdReportNavPredicate } from "../navigation/registry-capability.ts";
import { NAV_ENTRIES, findEntryByPath } from "../navigation/registry.ts";
import { canViewDuplicateCccdReport } from "./direct-entry-page-access.ts";

function actor(capabilities, scopes = [{ kind: "all", reference: "all" }]) {
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

const FULL_ADMIN = ["entry_admin", "recruiter_master_manage", "team_master_manage"];

test("the visibility predicate matches exactly the three RPC audiences at all scope", () => {
  const all = [{ kind: "all", reference: "all" }];
  assert.equal(duplicateCccdReportNavPredicate({ capabilities: FULL_ADMIN, scopes: all }), true);
  assert.equal(duplicateCccdReportNavPredicate({ capabilities: ["catalog_master_manage"], scopes: all }), true);
  assert.equal(duplicateCccdReportNavPredicate({ capabilities: ["entry_privileged_edit"], scopes: all }), true);

  for (const capabilities of [
    ["entry_admin"], ["change_review"], ["team_manager_assign"], [], ["pii_view"],
    ["entry_admin", "recruiter_master_manage"],
  ]) {
    assert.equal(duplicateCccdReportNavPredicate({ capabilities, scopes: all }), false,
      JSON.stringify(capabilities));
  }
  for (const scopes of [[], [{ kind: "own", reference: "own" }], [{ kind: "team", reference: "t" }]]) {
    assert.equal(duplicateCccdReportNavPredicate({ capabilities: FULL_ADMIN, scopes }), false);
    assert.equal(duplicateCccdReportNavPredicate({ capabilities: ["catalog_master_manage"], scopes }), false);
    assert.equal(duplicateCccdReportNavPredicate({ capabilities: ["entry_privileged_edit"], scopes }), false);
  }
});

test("canViewDuplicateCccdReport is server-derived and fails closed", () => {
  assert.equal(canViewDuplicateCccdReport(actor(FULL_ADMIN)), true);
  assert.equal(canViewDuplicateCccdReport(actor(["catalog_master_manage"])), true);
  assert.equal(canViewDuplicateCccdReport(actor(["entry_privileged_edit"])), true);
  assert.equal(canViewDuplicateCccdReport(actor(["entry_admin"])), false);
  assert.equal(canViewDuplicateCccdReport(actor(["change_review"])), false);
  assert.equal(canViewDuplicateCccdReport(actor(FULL_ADMIN, [{ kind: "team", reference: "t" }])), false);
  assert.equal(canViewDuplicateCccdReport(null), false);
  assert.equal(canViewDuplicateCccdReport({ ok: false, reason: "UNAUTHENTICATED" }), false);
  assert.equal(canViewDuplicateCccdReport({ ok: false, reason: "ACTOR_DISABLED" }), false);
});

test("the report is no longer a top-level navigation entry and has no standalone page", () => {
  assert.equal(NAV_ENTRIES.some((entry) => entry.id === "duplicate-cccd-report"), false);
  assert.equal(NAV_ENTRIES.some((entry) => entry.path.startsWith("/reports")), false);
  assert.equal(findEntryByPath("/reports/duplicate-cccd"), undefined);
  assert.throws(
    () => readFileSync(new URL("../../app/reports/duplicate-cccd/page.tsx", import.meta.url), "utf8"),
    "the standalone report page must be gone",
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
  assert.match(tabs, /tab\.key !== "duplicate-cccd" \|\| canViewDuplicateCccd/);
  assert.match(tabs, /id="bod-panel-duplicate-cccd"/);
});

test("the Dashboard page server-gates the CCCD tab and keeps URL/tab compatibility", () => {
  const page = readFileSync(new URL("../../app/dashboard/page.tsx", import.meta.url), "utf8");
  assert.match(page, /canViewDuplicateCccdReport\(actor\)/);
  assert.match(page, /type DashboardTab = "general" \| "team" \| "duplicate-cccd"/);
  assert.match(page, /tab === "duplicate-cccd" && !canViewDuplicateCccd/);
  // `source` (a general-only filter) is stripped before the CCCD/team tab renders.
  assert.match(page, /\(tab === "team" \|\| tab === "duplicate-cccd"\) && sourcePresent/);
  assert.match(page, /normalizedDashboardPath\(params, tab, true\)/);
  assert.match(page, /canViewDuplicateCccd=\{canViewDuplicateCccd\}/);
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
