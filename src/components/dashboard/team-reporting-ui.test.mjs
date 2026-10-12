import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const view = readFileSync(new URL("./dashboard-view.tsx", import.meta.url), "utf8");
const tabs = readFileSync(new URL("./bod-dashboard-tabs.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("./team-reporting-panel.tsx", import.meta.url), "utf8");
const chart = readFileSync(new URL("./team-bucket-chart.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../../app/dashboard/page.tsx", import.meta.url), "utf8");
const nav = readFileSync(new URL("../../lib/admin/admin-navigation.ts", import.meta.url), "utf8");
const navTest = readFileSync(new URL("../../lib/admin/admin-navigation.test.mjs", import.meta.url), "utf8");
const accountTest = readFileSync(new URL("../admin/account-manager.test.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

test("W06D: only DB-confirmed all reaches the two-tab shell", () => {
  assert.match(view, /resolveDashboardMode\(\{ ok: report\.ok, audience \}\)/);
  assert.match(view, /mode\.kind === "team"/);
  assert.match(view, /mode\.kind === "own"/);
  assert.match(view, /<BodDashboardTabs/);
  assert.ok(view.indexOf('mode.kind === "team"') < view.indexOf("<BodDashboardTabs"));
  assert.ok(view.indexOf('mode.kind === "own"') < view.indexOf("<BodDashboardTabs"));
  assert.match(tabs, /Báo cáo tổng quát/);
  assert.match(tabs, /Báo cáo theo nhóm/);
});

test("W06D: tab URL/history and source normalization use the locked contract", () => {
  assert.match(tabs, /parseAsString/);
  for (const fragment of [
    "useQueryStates(queryParsers",
    "history: \"push\"",
    "shallow: true",
    "scroll: false",
    "needsAuthoritativeReload",
    "shallow: !needsAuthoritativeReload",
  ]) assert.ok(tabs.includes(fragment), fragment);
  assert.match(tabs, /rawTab === "duplicate-cccd" && canViewDuplicateCccd[\s\S]*: "general";/);
  assert.match(tabs, /source: next === "general" \? source : null/);
  assert.match(tabs, /history: "push", shallow: !needsAuthoritativeReload, scroll: false/);
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /role="tabpanel"/);
  assert.match(tabs, /aria-selected/);
  assert.match(tabs, /aria-controls/);
  assert.match(tabs, /tabIndex=\{activeTab === tab\.key \? 0 : -1\}/);
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) assert.ok(tabs.includes(key));
  assert.match(page, /normalizedDashboardTab/);
  assert.match(page, /params\.source !== undefined/);
  assert.match(page, /normalizedDashboardPath\(params, tab, true\)/);
  assert.match(page, /if \(key === "tab" \|\| \(removeSource && key === "source"\)/);
});

test("W06D: missing tab defaults general; repeated or malformed tab normalizes general", () => {
  assert.match(page, /type DashboardTab = "general" \| "team" \| "duplicate-cccd"/);
  assert.match(page, /typeof value === "string" &&[\s\S]*\(value === "general" \|\| value === "team" \|\| value === "duplicate-cccd"\)/);
  assert.match(page, /rawTab !== undefined && tab === null/);
  assert.match(page, /normalizedDashboardPath\(params, "general", false\)/);
  assert.match(page, /query\.set\("tab", tab\)/);
});

test("W06D: direct team tab with source normalizes before reporting fetch", () => {
  const normalize = page.indexOf("normalizedDashboardPath(params, tab, true)");
  const fetch = page.indexOf("fetchCutoverReporting(params, actor.actor)");
  assert.ok(normalize >= 0 && normalize < fetch);
  assert.match(page, /params\.source !== undefined/);
});

test("W06D: team aggregate consumes byTeam and never regroups facts client-side", () => {
  assert.match(panel, /data\.byTeam/);
  assert.match(panel, /sortBuckets\(data\.byTeam\)/);
  assert.match(chart, /stableColorForKey/);
  assert.match(chart, /\{bucket\.display\}/);
  assert.doesNotMatch(panel, /team_memberships|recruiter_team|Admin Catalog/);
  assert.doesNotMatch(panel, /fetchCutoverReporting|createServiceSupabaseClient|\.rpc\(/);
});

test("W06D: bucket selection is accessible and internal identifiers stay off the surface", () => {
  assert.match(panel, /aria-pressed=\{selectedKey === bucket\.key\}/);
  assert.match(panel, /<button/);
  assert.match(panel, /bucket\.display/);
  assert.match(panel, /selectedBucket\.display/);
  assert.doesNotMatch(panel, /<[^>]+>\{(?:bucket|selectedBucket)\.key\}<\/|title=\{[^}]*\.key/);
  for (const forbidden of ["team_id", "team_code", "auth_subject", "app_user_id", "entry_id", "submission_id"]) {
    assert.doesNotMatch(panel, new RegExp(forbidden));
  }
  assert.match(panel, /UNKNOWN_TEAM_BUCKET_KEY/);
  assert.match(panel, /bucket\.display/);
});

test("W06D: drill-down sends only allowed filters, uses opaque cursor, and renders seven fields", () => {
  assert.match(panel, /\/api\/reporting\/team-drill-down/);
  assert.match(panel, /bucket_key: bucketKey/);
  assert.match(panel, /limit: "25"/);
  assert.match(panel, /params\.set\("cursor", cursor\)/);
  assert.doesNotMatch(panel, /params\.set\("source"/);
  for (const field of [
    "business_date", "project_display", "recruiter_display", "provider_type_display",
    "employment_type_display", "recruited_count", "first_work_date",
  ]) assert.match(panel, new RegExp(field));
  assert.match(panel, /scope="col"/);
  assert.match(panel, /<caption className="sr-only"/);
});

test("W06D: unknown split, loading/error/retry/empty/load-more/end and reset are explicit", () => {
  assert.match(panel, /Tổng hợp từ dữ liệu cũ \(tổng hợp theo ngày, không phải entry-level\)/);
  assert.match(panel, /Anomaly Direct Entry \(không gán được team\)/);
  assert.match(panel, /Đang tải chi tiết nhóm/);
  assert.match(panel, /Không tải được chi tiết nhóm/);
  assert.match(panel, /Thử tải lại/);
  assert.match(panel, /Chưa có dòng chi tiết/);
  assert.match(panel, /Tải thêm/);
  assert.match(panel, /Đã hiển thị hết kết quả/);
  assert.match(panel, /setRows\(\[\]\)/);
  assert.match(panel, /setNextCursor\(null\)/);
  assert.match(panel, /TeamReportingPanelContent key=\{querySignature\}/);
  assert.match(panel, /requestId\.current/);
  assert.match(panel, /AbortController/);
  assert.doesNotMatch(panel, /IntersectionObserver|setInterval|setTimeout/);
});

test("W06D: mobile contract uses bounded inner table overflow, not body-level overflow", () => {
  assert.match(panel, /overflow-x-auto/);
  assert.doesNotMatch(panel, /overflow-x-scroll|w-screen|min-w-screen|fixed inset-0/);
  assert.match(chart, /grid-cols-1/);
});

test("W06D: approved Admin navigation labels are exact and routes remain unchanged", () => {
  assert.match(nav, /id: "personnel", label: "Nhân sự tuyển dụng", href: "\/admin\/catalog\/personnel"/);
  assert.match(nav, /id: "accounts", label: "Tài khoản truy cập", href: "\/admin\/access\/accounts"/);
  assert.match(navTest, /Nhân sự tuyển dụng/);
  assert.match(navTest, /Tài khoản truy cập/);
  assert.match(accountTest, /label: "Tài khoản truy cập"/);
});

test("W06D: focused lane is registered once and canonical test invokes it once", () => {
  assert.ok(packageJson.scripts["test:p3-w06d"]);
  assert.match(packageJson.scripts["test:p3-w06d"], /team-reporting-ui\.test\.mjs/);
  const occurrences = packageJson.scripts.test.match(/test:p3-w06d/g) ?? [];
  assert.equal(occurrences.length, 1);
});
