import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const HERE = new URL("./", import.meta.url);
const view = readFileSync(new URL("./dashboard-view.tsx", HERE), "utf8");
const team = readFileSync(new URL("./team-dashboard-view.tsx", HERE), "utf8");
const own = readFileSync(new URL("./own-dashboard-view.tsx", HERE), "utf8");
const filters = readFileSync(new URL("./dashboard-filters.tsx", HERE), "utf8");
const page = readFileSync(new URL("../../app/dashboard/page.tsx", HERE), "utf8");

const SCOPED_VIEWS = ["team-dashboard-view.tsx", "own-dashboard-view.tsx"];
const SCOPED_SOURCES = [team, own];

test("W06C: the dashboard dispatches on the DB-authoritative audience", () => {
  assert.match(view, /resolveDashboardAudienceKind/);
  assert.match(view, /resolveScopedDashboardView/);
  assert.match(view, /<TeamDashboardView/);
  assert.match(view, /<OwnDashboardView/);
  // BoD layout is gated behind a DB-confirmed `all`.
  assert.match(view, /audienceKind !== "all"/);
  assert.ok(
    view.indexOf("audienceKind !== \"all\"") < view.indexOf("BoD · Báo cáo điều hành"),
    "the BoD hero must render only after the all-audience gate",
  );
});

test("W06C: the page passes the audience from the scoped payload, never a UI role", () => {
  assert.match(page, /audience=\{report\.ok \? report\.audience : null\}/);
  // No UI-side audience inference: the page never reads capabilities or scopes.
  assert.ok(!/capabilities/.test(page), "the page must not derive the audience from capabilities");
  assert.ok(!/\.scopes/.test(page), "the page must not derive the audience from actor scopes");
});

test("W06C: team dashboard has its own UX (member roster), not a relabelled BoD page", () => {
  assert.match(team, /buildMemberContributions/);
  assert.ok(team.includes("Đóng góp của thành viên nhóm"), "team roster panel must exist");
  assert.ok(team.includes("Trung bình/người"), "team summary metrics must exist");
  assert.match(team, /showMemberRanking|view\.showProjectProviderMix/);
  // The team page must not reuse the BoD hero/title or the BoD KPI labels.
  assert.ok(!team.includes("BoD · Báo cáo điều hành"));
  assert.ok(!team.includes('label="Tổng tuyển mới"'));
  assert.ok(!team.includes("Theo người tuyển"));
});

test("W06C: own dashboard is personal (no roster, no recruiter filter)", () => {
  assert.ok(own.includes("Tóm tắt của tôi"));
  assert.ok(!own.includes("buildMemberContributions"), "own must not render a member roster");
  assert.ok(!own.includes("Đóng góp của thành viên"), "own must not render a member roster panel");
  assert.ok(!own.includes("RecruiterBarChart"), "own must not render a recruiter ranking chart");
  assert.ok(!own.includes("ProjectProviderMixCard"), "own must not render the provider mix card");
  assert.match(own, /showRecruiter=\{view\.showRecruiterFilter\}/);
});

test("W06C: scoped dashboards never render global source metadata", () => {
  for (let i = 0; i < SCOPED_SOURCES.length; i += 1) {
    const src = SCOPED_SOURCES[i];
    const name = SCOPED_VIEWS[i];
    for (const forbidden of [
      "drive_file_id",
      "file_name",
      "latest_run_status",
      "reporting_latest_sync_runs",
      "reporting_sources_with_current_facts",
      "data_sources",
      "options.sources",
      "Nguồn báo cáo",
      "Độ phủ dữ liệu",
      "Đồng bộ",
    ]) {
      assert.ok(!src.includes(forbidden), name + " must not render global source metadata: " + forbidden);
    }
  }
});

test("W06C: scoped dashboards consume props only (no parallel fetch, no service-role reads)", () => {
  for (let i = 0; i < SCOPED_SOURCES.length; i += 1) {
    const src = SCOPED_SOURCES[i];
    const name = SCOPED_VIEWS[i];
    for (const forbidden of [
      "fetchCutoverReporting",
      "p2-w04a-reporting-server",
      "p2-w04a-options-server",
      ".rpc(",
      "createServiceSupabaseClient",
    ]) {
      assert.ok(!src.includes(forbidden), name + " must not issue its own fetch: " + forbidden);
    }
    assert.match(src, /data: ReportingData/, name + " must receive data via props");
  }
});

test("W06C: the recruiter filter is optional so own can hide it", () => {
  assert.match(filters, /showRecruiter = true/);
  assert.match(filters, /showRecruiter\?: boolean/);
  assert.match(filters, /showRecruiter \? \(/);
});
