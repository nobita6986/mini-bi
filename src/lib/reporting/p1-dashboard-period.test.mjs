import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { computeReporting } from "./p1-reporting.ts";
import {
  aggregateDailyTrendPoints,
  buildTrendByResolution,
  computeCompositionInsights,
  formatSharePct,
  MAX_TREND_DAYS,
  monthBoundsYmd,
  startOfMondayWeekYmd,
  TREND_RESOLUTION_OPTIONS,
} from "./p1-dashboard-period.ts";

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

test("Wave 2 (1.3) — composition insights compute leading project, provider & employment shares, and separate unknown/invalid with coverage", () => {
  const facts = [
    fact({ project_key: "alpha", project_display: "Alpha", provider_type_key: "hrp", employment_type_key: "thời vụ", recruited_count: 8 }),
    fact({ project_key: "beta", project_display: "Beta", provider_type_key: "vendor", employment_type_key: "chính thức", recruited_count: 6 }),
    fact({ project_key: "beta", project_display: "Beta", provider_type_key: "__unknown__", employment_type_key: "__unknown__", recruited_count: 4 }),
    fact({ project_key: "gamma", project_display: "Gamma", provider_type_key: "__invalid__", employment_type_key: "__invalid__", recruited_count: 2 }),
  ];
  const data = computeReporting([SRC], facts, {}, new Set([SRC.id]));
  const insights = computeCompositionInsights(data);

  assert.equal(insights.filteredTotal, 20);
  assert.ok(insights.leadingProject);
  // Beta has 6 + 4 = 10 total (50% of 20), Alpha has 8 (40% of 20)
  assert.equal(insights.leadingProject.key, "beta");
  assert.equal(insights.leadingProject.display, "Beta");
  assert.equal(insights.leadingProject.count, 10);
  assert.equal(insights.leadingProject.shareOfFilteredPct, 50);
  assert.equal(insights.leadingProject.tiedOtherCount, 0);

  // Provider: HRP=8, Vendor=6, Unknown=4, Invalid=2 (never merged into HRP or Vendor!)
  assert.equal(insights.provider.total, 20);
  assert.equal(insights.provider.hrpCount, 8);
  assert.equal(insights.provider.vendorCount, 6);
  assert.equal(insights.provider.unknownCount, 4);
  assert.equal(insights.provider.invalidCount, 2);
  assert.equal(insights.provider.classifiedTotal, 14);
  assert.equal(insights.provider.unclassifiedTotal, 6);
  assert.equal(insights.provider.hrpShareOfTotalPct, 40);
  assert.equal(insights.provider.vendorShareOfTotalPct, 30);
  assert.equal(insights.provider.unknownShareOfTotalPct, 20);
  assert.equal(insights.provider.invalidShareOfTotalPct, 10);
  assert.equal(insights.provider.classifiedCoveragePct, 70);
  assert.equal(insights.provider.providerFilterActive, false);

  // Employment: Thời vụ=8 (40%), Chính thức=6 (30%), Unknown=4 (20%), Invalid=2 (10%)
  assert.equal(insights.employment.total, 20);
  assert.equal(insights.employment.seasonalCount, 8);
  assert.equal(insights.employment.permanentCount, 6);
  assert.equal(insights.employment.unknownCount, 4);
  assert.equal(insights.employment.invalidCount, 2);
  assert.equal(insights.employment.seasonalSharePct, 40);
  assert.equal(insights.employment.permanentSharePct, 30);
  assert.equal(insights.employment.classifiedCoveragePct, 70);
});

test("Wave 2 (1.3) — zero totals and empty states produce null shares without NaN/Infinity", () => {
  const emptyData = computeReporting([SRC], [], {}, new Set());
  const insights = computeCompositionInsights(emptyData);

  assert.equal(insights.filteredTotal, 0);
  assert.equal(insights.leadingProject, null);
  assert.equal(insights.provider.hrpShareOfTotalPct, null);
  assert.equal(insights.provider.vendorShareOfTotalPct, null);
  assert.equal(insights.provider.classifiedCoveragePct, null);
  assert.equal(insights.employment.seasonalSharePct, null);
  assert.equal(insights.employment.permanentSharePct, null);
  assert.equal(formatSharePct(null), "—");
  assert.equal(formatSharePct(33.3333), "33.3%");
  assert.equal(formatSharePct(50), "50%");
});

test("Wave 2 (1.3) — filtered denominator reflects active provider/project filter and flags providerFilterActive", () => {
  const facts = [
    fact({ project_key: "alpha", project_display: "Alpha", provider_type_key: "hrp", recruited_count: 5 }),
    fact({ project_key: "alpha", project_display: "Alpha", provider_type_key: "vendor", recruited_count: 15 }),
  ];
  const filtered = computeReporting([SRC], facts, { provider: "vendor" }, new Set([SRC.id]));
  const insights = computeCompositionInsights(filtered);

  assert.equal(insights.filteredTotal, 15);
  assert.equal(insights.provider.providerFilterActive, true);
  assert.equal(insights.provider.vendorCount, 15);
  assert.equal(insights.provider.hrpCount, 0);
  assert.equal(insights.provider.vendorShareOfTotalPct, 100);
});

test("Wave 2 (1.4) — Day, Week, and Month bucket sums each equal filtered recruitedTotal", () => {
  const byDate = {
    "2026-09-28": 2, // Monday
    "2026-09-30": 3, // Wednesday (crosses month into Oct in same ISO week)
    "2026-10-01": 4, // Thursday
    "2026-10-04": 1, // Sunday
    "2026-10-05": 5, // Next Monday
    "2026-10-12": 7, // Following Monday
  };
  const total = 2 + 3 + 4 + 1 + 5 + 7; // 22

  const dayBuckets = buildTrendByResolution(byDate, "day", "2026-09-28", "2026-10-12");
  const weekBuckets = buildTrendByResolution(byDate, "week", "2026-09-28", "2026-10-12");
  const monthBuckets = buildTrendByResolution(byDate, "month", "2026-09-28", "2026-10-12");

  const sumCounts = (arr) => arr.reduce((acc, b) => acc + b.count, 0);
  assert.equal(sumCounts(dayBuckets), total);
  assert.equal(sumCounts(weekBuckets), total);
  assert.equal(sumCounts(monthBuckets), total);

  // Week 1: 2026-09-28 .. 2026-10-04 (crosses Sep -> Oct) = 2 + 3 + 4 + 1 = 10
  assert.equal(weekBuckets[0].key, "2026-09-28");
  assert.equal(weekBuckets[0].startDate, "2026-09-28");
  assert.equal(weekBuckets[0].endDate, "2026-10-04");
  assert.equal(weekBuckets[0].count, 10);

  // Month 1 (2026-09): clipped to [2026-09-28, 2026-09-30] = 2 + 3 = 5
  // Month 2 (2026-10): clipped to [2026-10-01, 2026-10-12] = 4 + 1 + 5 + 7 = 17
  assert.equal(monthBuckets.length, 2);
  assert.deepEqual(monthBuckets[0], {
    key: "2026-09",
    date: "2026-09",
    startDate: "2026-09-28",
    endDate: "2026-09-30",
    count: 5,
  });
  assert.deepEqual(monthBuckets[1], {
    key: "2026-10",
    date: "2026-10",
    startDate: "2026-10-01",
    endDate: "2026-10-12",
    count: 17,
  });
});

test("Wave 2 (1.4) — Monday week start, week crossing year boundary, leap day/month, and filter-boundary clipping", () => {
  // 2025-12-31 is Wednesday; 2026-01-01 is Thursday; Monday of that week is 2025-12-29, Sunday is 2026-01-04
  assert.equal(startOfMondayWeekYmd("2025-12-31"), "2025-12-29");
  assert.equal(startOfMondayWeekYmd("2026-01-04"), "2025-12-29");
  assert.equal(startOfMondayWeekYmd("2026-01-05"), "2026-01-05");

  const yearCrossByDate = {
    "2025-12-30": 3,
    "2026-01-02": 4,
  };
  // Filter bounds [2025-12-30, 2026-01-02] clip the week [2025-12-29, 2026-01-04]
  const clippedWeek = buildTrendByResolution(yearCrossByDate, "week", "2025-12-30", "2026-01-02");
  assert.equal(clippedWeek.length, 1);
  assert.equal(clippedWeek[0].startDate, "2025-12-30", "week start clipped to filter.from");
  assert.equal(clippedWeek[0].endDate, "2026-01-02", "week end clipped to filter.to");
  assert.equal(clippedWeek[0].count, 7);

  // Leap year February 2024 vs non-leap February 2026
  assert.deepEqual(monthBoundsYmd("2024-02-15"), {
    monthKey: "2024-02",
    startDate: "2024-02-01",
    endDate: "2024-02-29",
  });
  assert.deepEqual(monthBoundsYmd("2026-02-15"), {
    monthKey: "2026-02",
    startDate: "2026-02-01",
    endDate: "2026-02-28",
  });

  const leapMonth = buildTrendByResolution(
    { "2024-02-29": 6 },
    "month",
    "2024-02-01",
    "2024-02-29",
  );
  assert.equal(leapMonth.length, 1);
  assert.equal(leapMonth[0].endDate, "2024-02-29");
  assert.equal(leapMonth[0].count, 6);
});

test("Wave 2 (1.4) — MAX_TREND_DAYS guard is preserved for pathological ranges across all resolutions", () => {
  const byDate = {
    "2018-01-01": 2,
    "2026-10-01": 5,
  };
  const dayPts = buildTrendByResolution(byDate, "day", "2018-01-01", "2026-10-01");
  const weekPts = buildTrendByResolution(byDate, "week", "2018-01-01", "2026-10-01");
  const monthPts = buildTrendByResolution(byDate, "month", "2018-01-01", "2026-10-01");

  assert.ok(MAX_TREND_DAYS === 1096);
  assert.equal(dayPts.length, 2, "pathological range skips zero-fill and keeps only active dates");
  assert.equal(weekPts.length, 2);
  assert.equal(monthPts.length, 2);
  assert.equal(dayPts.reduce((a, p) => a + p.count, 0), 7);
  assert.equal(weekPts.reduce((a, p) => a + p.count, 0), 7);
  assert.equal(monthPts.reduce((a, p) => a + p.count, 0), 7);
  assert.deepEqual(aggregateDailyTrendPoints([], "week"), []);
});

test("Wave 2 — TrendChart segmented control is keyboard-accessible, announces resolution, and stays a single chart", () => {
  assert.deepEqual(
    TREND_RESOLUTION_OPTIONS.map((o) => o.label),
    ["Ngày", "Tuần", "Tháng"],
  );

  const trendChartSrc = readFileSync(new URL("../../components/dashboard/trend-chart.tsx", import.meta.url), "utf8");
  assert.match(trendChartSrc, /role="group"/);
  assert.match(trendChartSrc, /aria-label="Độ phân giải xu hướng"/);
  assert.match(trendChartSrc, /aria-pressed=\{active\}/);
  assert.match(trendChartSrc, /aria-live="polite"/);
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
    assert.ok(trendChartSrc.includes(key), `TrendChart must support keyboard key ${key}`);
  }
  assert.equal(
    trendChartSrc.split("<AreaChart").length - 1,
    1,
    "TrendChart must keep a single AreaChart instance",
  );

  const bodView = readFileSync(new URL("../../components/dashboard/dashboard-view.tsx", import.meta.url), "utf8");
  const ownView = readFileSync(new URL("../../components/dashboard/own-dashboard-view.tsx", import.meta.url), "utf8");
  for (const [name, src] of [
    ["dashboard-view.tsx", bodView],
    ["own-dashboard-view.tsx", ownView],
  ]) {
    assert.match(src, /insights\.provider\.hrpCount/, `${name} must render HRP count`);
    assert.match(src, /insights\.provider\.vendorCount/, `${name} must render Vendor count`);
    assert.match(src, /insights\.provider\.unknownCount/, `${name} must render unknown provider count`);
    assert.match(src, /insights\.provider\.invalidCount/, `${name} must render invalid provider count`);
    assert.match(src, /insights\.provider\.classifiedCoveragePct/, `${name} must render provider classification coverage`);
    assert.match(src, /insights\.provider\.providerFilterActive/, `${name} must render provider filter warning`);
    assert.match(src, /<ProviderDonut/, `${name} must reuse ProviderDonut`);
  }
});
