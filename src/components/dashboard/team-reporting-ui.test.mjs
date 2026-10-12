import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const view = readFileSync(new URL("./dashboard-view.tsx", import.meta.url), "utf8");
const tabs = readFileSync(new URL("./bod-dashboard-tabs.tsx", import.meta.url), "utf8");
const leader = readFileSync(new URL("./team-dashboard-view.tsx", import.meta.url), "utf8");
const report = readFileSync(new URL("./team-report-view.tsx", import.meta.url), "utf8");
const detail = readFileSync(new URL("./team-entry-detail.tsx", import.meta.url), "utf8");
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
  assert.match(tabs, /rawTab === "team" \? "team" : "general"/);
  assert.match(tabs, /source: next === "team" \? null : source/);
  assert.match(tabs, /history: "push", shallow: !needsAuthoritativeReload, scroll: false/);
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /role="tabpanel"/);
  assert.match(tabs, /aria-selected/);
  assert.match(tabs, /aria-controls/);
  assert.match(tabs, /tabIndex=\{activeTab === tab\.key \? 0 : -1\}/);
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) assert.ok(tabs.includes(key));
  assert.match(page, /normalizedDashboardTab/);
  assert.match(page, /params\.source !== undefined/);
  assert.match(page, /normalizedDashboardPath\(params, "team", true\)/);
  assert.match(page, /if \(key === "tab" \|\| \(removeSource && key === "source"\)/);
});

test("W06D: missing tab defaults general; repeated or malformed tab normalizes general", () => {
  assert.match(page, /type DashboardTab = "general" \| "team"/);
  assert.match(page, /typeof value === "string" && \(value === "general" \|\| value === "team"\)/);
  assert.match(page, /rawTab !== undefined && tab === null/);
  assert.match(page, /normalizedDashboardPath\(params, "general", false\)/);
  assert.match(page, /query\.set\("tab", tab\)/);
});

test("W06D: direct team tab with source normalizes before reporting fetch", () => {
  const normalize = page.indexOf('normalizedDashboardPath(params, "team", true)');
  const fetch = page.indexOf("fetchCutoverReporting(params, actor.actor)");
  assert.ok(normalize >= 0 && normalize < fetch);
  assert.match(page, /params\.source !== undefined/);
});

test("W06D-R2: one shared report component serves both Team Leader and BoD", () => {
  // Both the Team Leader report and the BoD team tab import the SAME module.
  assert.match(leader, /import \{ TeamReportView, type TeamReportViewConfig \} from "\.\/team-report-view"/);
  assert.match(tabs, /import \{ TeamReportView, type TeamReportViewConfig \} from "\.\/team-report-view"/);
  assert.match(leader, /<TeamReportView/);
  assert.match(tabs, /<TeamReportView/);
  // The old separate BoD-only panel must be gone.
  assert.doesNotMatch(leader, /TeamReportingPanel/);
  assert.doesNotMatch(tabs, /TeamReportingPanel/);
});

test("W06D-R2: 'Theo HRP/Vendor của nhóm' card is removed from the shared report", () => {
  assert.doesNotMatch(report, /Theo HRP\/Vendor của nhóm/);
  assert.doesNotMatch(report, /ProviderDonut/);
  assert.doesNotMatch(leader, /Theo HRP\/Vendor của nhóm/);
});

test("W06D-R2: section order keeps the entry-level detail list at the end", () => {
  const member = report.indexOf("aria-label={view.memberAriaLabel}");
  const trend = report.indexOf('aria-label="Xu hướng tuyển dụng của nhóm"');
  const project = report.indexOf('title="Theo dự án trong nhóm"');
  const employment = report.indexOf('title="Theo loại hình làm việc của nhóm"');
  const entry = report.indexOf("<TeamEntryDetail");
  assert.ok(member >= 0, "member section present");
  assert.ok(member < trend && trend < project && project < employment && employment < entry,
    "member < trend < project < employment < entry detail");
  assert.match(report, /Danh sách chi tiết từng dòng/);
  assert.match(report, /heading=\{view\.entryHeading\}/);
});

test("W06D-R2: Team Leader report runs on DB-scoped data with no client authority", () => {
  // The leader adapter passes only view/data/options and never joins teams or
  // reads the Admin Catalog; scope stays with the W05A payload.
  for (const source of [leader, report]) {
    assert.doesNotMatch(source, /team_memberships|recruiter_team|Admin Catalog/);
    assert.doesNotMatch(source, /fetchCutoverReporting|createServiceSupabaseClient|\.rpc\(/);
  }
  assert.match(leader, /view: ScopedDashboardView/);
  assert.match(report, /data\.byTeam/);
  assert.match(report, /sortBuckets\(data\.byTeam\)/);
});

test("W06D: team aggregate consumes byTeam and never regroups facts client-side", () => {
  assert.match(report, /data\.byTeam/);
  assert.match(report, /sortBuckets\(data\.byTeam\)/);
  assert.match(chart, /stableColorForKey/);
  assert.match(chart, /\{bucket\.display\}/);
  assert.doesNotMatch(detail, /team_memberships|recruiter_team|Admin Catalog/);
  assert.doesNotMatch(detail, /fetchCutoverReporting|createServiceSupabaseClient|\.rpc\(/);
});

test("W06D: bucket selection is accessible and internal identifiers stay off the surface", () => {
  assert.match(detail, /aria-pressed=\{selectedKey === bucket\.key\}/);
  assert.match(detail, /<button/);
  assert.match(detail, /bucket\.display/);
  assert.match(detail, /selectedBucket\.display/);
  assert.doesNotMatch(detail, /<[^>]+>\{(?:bucket|selectedBucket)\.key\}<\/|title=\{[^}]*\.key/);
  for (const forbidden of ["team_id", "team_code", "auth_subject", "app_user_id", "entry_id", "submission_id"]) {
    assert.doesNotMatch(detail, new RegExp(forbidden));
  }
  assert.match(detail, /UNKNOWN_TEAM_BUCKET_KEY/);
  assert.match(detail, /bucket\.display/);
});

test("W06D: drill-down sends only allowed filters, uses opaque cursor, and renders seven fields", () => {
  assert.match(detail, /\/api\/reporting\/team-drill-down/);
  assert.match(detail, /bucket_key: bucketKey/);
  assert.match(detail, /limit: "25"/);
  assert.match(detail, /params\.set\("cursor", cursor\)/);
  assert.doesNotMatch(detail, /params\.set\("source"/);
  for (const field of [
    "business_date", "project_display", "recruiter_display", "provider_type_display",
    "employment_type_display", "recruited_count", "first_work_date",
  ]) assert.match(detail, new RegExp(field));
  assert.match(detail, /scope="col"/);
  assert.match(detail, /<caption className="sr-only"/);
});

test("W06D-R2: drill-down request uses the DB-applied filters and resets on team/filter change", () => {
  // Reset on filter change is a full remount keyed on the authoritative filter signature.
  assert.match(detail, /TeamEntryDetailContent key=\{querySignature\}/);
  assert.match(detail, /function drillDownUrl\(data: ReportingData, bucketKey: string, cursor: string \| null\)/);
  assert.match(detail, /const value = data\.applied\[key\]/);
  assert.match(detail, /if \(value\) params\.set\(key, value\)/);
  // Selecting a team always starts at page one and clears the previous rows.
  assert.match(detail, /void loadPage\(bucket\.key, null, false\)/);
  assert.match(detail, /setRows\(\[\]\)/);
  assert.match(detail, /setNextCursor\(null\)/);
});

test("W06D: unknown split, loading/error/retry/empty/load-more/end and reset are explicit", () => {
  assert.match(detail, /Tổng hợp từ dữ liệu cũ \(tổng hợp theo ngày, không phải entry-level\)/);
  assert.match(detail, /Anomaly Direct Entry \(không gán được team\)/);
  assert.match(detail, /Đang tải chi tiết nhóm/);
  assert.match(detail, /Không tải được chi tiết nhóm/);
  assert.match(detail, /Thử tải lại/);
  assert.match(detail, /Chưa có dòng chi tiết/);
  assert.match(detail, /Tải thêm/);
  assert.match(detail, /Đã hiển thị hết kết quả/);
  assert.match(detail, /setRows\(\[\]\)/);
  assert.match(detail, /setNextCursor\(null\)/);
  assert.match(detail, /TeamEntryDetailContent key=\{querySignature\}/);
  assert.match(detail, /requestId\.current/);
  assert.match(detail, /AbortController/);
  assert.doesNotMatch(detail, /IntersectionObserver|setInterval|setTimeout/);
});

test("W06D: mobile contract uses bounded inner table overflow, not body-level overflow", () => {
  assert.match(detail, /overflow-x-auto/);
  assert.doesNotMatch(detail, /overflow-x-scroll|w-screen|min-w-screen|fixed inset-0/);
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
