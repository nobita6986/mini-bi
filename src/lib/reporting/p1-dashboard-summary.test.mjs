import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { computeReporting } from "./p1-reporting.ts";
import {
  computeDashboardSummary,
  formatAvgPerActiveDay,
  formatPeakDayHint,
  SUMMARY_KPI_LABELS,
} from "./p1-dashboard-summary.ts";

const SRC = {
  id: "11111111-1111-4111-8111-111111111111",
  drive_file_id: "SYN",
  file_name: "Syn.xlsx",
  active: true,
  is_test: false,
  latest_run_status: "succeeded",
  last_successful_sync_at: "2026-10-01T00:00:00Z",
  last_seen_at: null,
};

function fact(overrides = {}) {
  return {
    source_id: SRC.id,
    business_date: "2026-10-01",
    project_key: "proj_a",
    project_display: "Dự án A",
    recruiter_key: "rec_a",
    recruiter_display: "Nguyễn Văn A",
    provider_type_key: "hrp",
    provider_type_display: "HRP",
    employment_type_key: "thời vụ",
    employment_type_display: "Thời vụ",
    recruited_count: 1,
    ...overrides,
  };
}

test("Wave 1 — empty states (noSources, noFacts, noMatches) yield zero counts and avgPerActiveDay = 0", () => {
  const noSources = computeDashboardSummary(computeReporting([], [], {}, new Set()));
  assert.deepEqual(noSources, {
    recruitedTotal: 0,
    activeRecruiterBucketCount: 0,
    activeProjectBucketCount: 0,
    activeHiringDays: 0,
    avgPerActiveDay: 0,
    peakDailyCount: null,
    peakDates: [],
    primaryPeakDate: null,
    tiedPeakDates: [],
  });

  const noFacts = computeDashboardSummary(computeReporting([SRC], [], {}, new Set()));
  assert.equal(noFacts.recruitedTotal, 0);
  assert.equal(noFacts.activeHiringDays, 0);
  assert.equal(noFacts.avgPerActiveDay, 0);
  assert.equal(noFacts.peakDailyCount, null);
  assert.deepEqual(noFacts.peakDates, []);

  const noMatches = computeDashboardSummary(
    computeReporting([SRC], [fact()], { project: "nonexistent" }, new Set([SRC.id])),
  );
  assert.equal(noMatches.recruitedTotal, 0);
  assert.equal(noMatches.activeRecruiterBucketCount, 0);
  assert.equal(noMatches.activeProjectBucketCount, 0);
  assert.equal(noMatches.activeHiringDays, 0);
  assert.equal(noMatches.avgPerActiveDay, 0);
  assert.equal(noMatches.peakDailyCount, null);
  assert.equal(formatAvgPerActiveDay(noMatches.avgPerActiveDay), "0.0");
  assert.equal(formatAvgPerActiveDay(null), "—");
  assert.equal(formatPeakDayHint(noMatches), "chưa có ngày phát sinh");
});

test("Wave 1 — zero active days with synthetic byDate zero entries never divides by zero or invents a peak", () => {
  const summary = computeDashboardSummary({
    recruitedTotal: 0,
    byDate: { "2026-10-01": 0, "2026-10-02": 0 },
    byRecruiter: {},
    byProject: {},
    empty: { noSources: false, noFacts: false, noMatches: false },
  });
  assert.equal(summary.activeHiringDays, 0);
  assert.equal(summary.avgPerActiveDay, 0);
  assert.equal(summary.peakDailyCount, null);
  assert.deepEqual(summary.peakDates, []);
  assert.equal(summary.primaryPeakDate, null);
  assert.deepEqual(summary.tiedPeakDates, []);
});

test("Wave 1 — single and multiple recruiter/project buckets with identical filter preserve recruitedTotal", () => {
  const singleData = computeReporting([SRC], [fact({ recruited_count: 4 })], {}, new Set([SRC.id]));
  const singleSummary = computeDashboardSummary(singleData);
  assert.equal(singleSummary.recruitedTotal, singleData.recruitedTotal);
  assert.equal(singleSummary.recruitedTotal, 4);
  assert.equal(singleSummary.activeRecruiterBucketCount, 1);
  assert.equal(singleSummary.activeProjectBucketCount, 1);
  assert.equal(singleSummary.activeHiringDays, 1);
  assert.equal(singleSummary.avgPerActiveDay, 4);
  assert.equal(singleSummary.peakDailyCount, 4);
  assert.equal(singleSummary.primaryPeakDate, "2026-10-01");
  assert.deepEqual(singleSummary.tiedPeakDates, []);
  assert.equal(formatPeakDayHint(singleSummary), "ngày 2026-10-01");

  const multiFacts = [
    fact({ business_date: "2026-10-01", project_key: "p1", recruiter_key: "r1", recruited_count: 3 }),
    fact({ business_date: "2026-10-02", project_key: "p2", recruiter_key: "r2", recruited_count: 5 }),
    fact({ business_date: "2026-10-03", project_key: "p3", recruiter_key: "r1", recruited_count: 2 }),
  ];
  const filteredData = computeReporting([SRC], multiFacts, { from: "2026-10-01", to: "2026-10-03" }, new Set([SRC.id]));
  const multiSummary = computeDashboardSummary(filteredData);
  assert.equal(multiSummary.recruitedTotal, filteredData.recruitedTotal);
  assert.equal(multiSummary.recruitedTotal, 10);
  assert.equal(multiSummary.activeRecruiterBucketCount, 2);
  assert.equal(multiSummary.activeProjectBucketCount, 3);
  assert.equal(multiSummary.activeHiringDays, 3);
});

test("Wave 1 — separate bucket keys with duplicate display names are never collapsed, and zero-valued buckets are excluded", () => {
  const summary = computeDashboardSummary({
    recruitedTotal: 9,
    byDate: { "2026-10-01": 9 },
    byRecruiter: {
      "rec_key_1": { key: "rec_key_1", display: "Nguyễn Văn A", recruitedCount: 4 },
      "rec_key_2": { key: "rec_key_2", display: "Nguyễn Văn A", recruitedCount: 5 },
      "rec_key_zero": { key: "rec_key_zero", display: "Trần Thị B", recruitedCount: 0 },
    },
    byProject: {
      "proj_key_1": { key: "proj_key_1", display: "Dự án Chung", recruitedCount: 3 },
      "proj_key_2": { key: "proj_key_2", display: "Dự án Chung", recruitedCount: 6 },
      "proj_key_zero": { key: "proj_key_zero", display: "Dự án Trống", recruitedCount: 0 },
    },
    empty: { noSources: false, noFacts: false, noMatches: false },
  });

  assert.equal(summary.activeRecruiterBucketCount, 2, "must count separate keys with duplicate display names");
  assert.equal(summary.activeProjectBucketCount, 2, "must count separate project keys and exclude 0-count buckets");
});

test("Wave 1 — peak ties sort ascending (earliest date first) and disclose count of tied peak days + all dates", () => {
  const summary = computeDashboardSummary({
    recruitedTotal: 15,
    byDate: {
      "2026-10-05": 6,
      "2026-10-02": 6,
      "2026-10-03": 3,
      "2026-10-04": 0,
    },
    byRecruiter: { r1: { key: "r1", display: "R1", recruitedCount: 15 } },
    byProject: { p1: { key: "p1", display: "P1", recruitedCount: 15 } },
    empty: { noSources: false, noFacts: false, noMatches: false },
  });

  assert.equal(summary.activeHiringDays, 3);
  assert.equal(summary.peakDailyCount, 6);
  assert.deepEqual(summary.peakDates, ["2026-10-02", "2026-10-05"]);
  assert.equal(summary.primaryPeakDate, "2026-10-02");
  assert.deepEqual(summary.tiedPeakDates, ["2026-10-05"]);
  assert.equal(
    formatPeakDayHint(summary),
    "ngày 2026-10-02 (2 ngày đồng đỉnh: 2026-10-02, 2026-10-05)",
  );

  const threeWayTie = computeDashboardSummary({
    recruitedTotal: 18,
    byDate: {
      "2026-10-09": 6,
      "2026-10-01": 6,
      "2026-10-04": 6,
    },
    byRecruiter: { r1: { key: "r1", display: "R1", recruitedCount: 18 } },
    byProject: { p1: { key: "p1", display: "P1", recruitedCount: 18 } },
    empty: { noSources: false, noFacts: false, noMatches: false },
  });
  assert.equal(
    formatPeakDayHint(threeWayTie),
    "ngày 2026-10-01 (3 ngày đồng đỉnh: 2026-10-01, 2026-10-04, 2026-10-09)",
  );
});

test("Wave 1 — avgPerActiveDay remains unrounded in helper and rounds to 1 decimal only at display time", () => {
  const summary = computeDashboardSummary({
    recruitedTotal: 7,
    byDate: {
      "2026-10-01": 3,
      "2026-10-02": 2,
      "2026-10-03": 2,
    },
    byRecruiter: { r1: { key: "r1", display: "R1", recruitedCount: 7 } },
    byProject: { p1: { key: "p1", display: "P1", recruitedCount: 7 } },
    empty: { noSources: false, noFacts: false, noMatches: false },
  });

  assert.equal(summary.avgPerActiveDay, 7 / 3);
  assert.notEqual(summary.avgPerActiveDay, 2.3, "helper must not prematurely round avgPerActiveDay");
  assert.equal(formatAvgPerActiveDay(summary.avgPerActiveDay), "2.3");
});

test("Wave 1 — all audience views adopt computeDashboardSummary with consistent labels, no duplicate KPIs, and no unique-person claims", () => {
  assert.equal(SUMMARY_KPI_LABELS.activeRecruiters, "Recruiter có phát sinh tuyển");
  assert.equal(SUMMARY_KPI_LABELS.activeProjects, "Dự án có tuyển");

  const bodView = readFileSync(new URL("../../components/dashboard/dashboard-view.tsx", import.meta.url), "utf8");
  const teamView = readFileSync(new URL("../../components/dashboard/team-report-view.tsx", import.meta.url), "utf8");
  const teamAdapter = readFileSync(new URL("../../components/dashboard/team-dashboard-view.tsx", import.meta.url), "utf8");
  const ownView = readFileSync(new URL("../../components/dashboard/own-dashboard-view.tsx", import.meta.url), "utf8");

  for (const [name, src] of [
    ["dashboard-view.tsx", bodView],
    ["team-report-view.tsx", teamView],
    ["own-dashboard-view.tsx", ownView],
  ]) {
    assert.match(src, /computeDashboardSummary\(/, `${name} must use computeDashboardSummary`);
    assert.match(src, /Dự án có tuyển/, `${name} must render Dự án có tuyển`);
    assert.match(src, /Trung bình\/ngày có tuyển/, `${name} must render Trung bình/ngày có tuyển`);
    assert.match(src, /Đỉnh tuyển\/ngày/, `${name} must render Đỉnh tuyển/ngày`);
    assert.doesNotMatch(src, /số người duy nhất/i, `${name} must never claim unique people`);
  }

  assert.match(bodView, /Recruiter có phát sinh tuyển/);
  assert.match(teamAdapter, /Recruiter có phát sinh tuyển/);
  assert.equal(ownView.split('label="Dự án có tuyển"').length - 1, 1, "own view must not duplicate Dự án có tuyển");
});
