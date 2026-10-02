/**
 * P1.5-W03 — Golden tests cho deterministic analytics feature engine.
 *
 * Fixture synthetic; không DB, không AI, không mạng. Test độc lập hoàn toàn với AI:
 * mọi khẳng định đều là số học/invariant trên packet.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { buildFeaturePacket, validateReportingFacts } from "./feature-engine.ts";
import { buildPacketFromSource } from "./packet-builder.mjs";
import { canonicalJson, sha256Hex, scanForbiddenPacketContent } from "./engine-shared.mjs";
import { validateAnalysisPacket } from "../analytics/contracts/analysis-packet.ts";

const IDENT_DIR = new URL("../../../docs/contracts/fixtures/p1.5-identity/", import.meta.url);
const baseCatalog = JSON.parse(readFileSync(new URL("catalog.json", IDENT_DIR), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

const META = {
  generated_at: "2026-10-12T00:00:00Z",
  generated_from: "reporting-read-model",
  lineage_ref: "1".repeat(64),
  access_scope_hash: "2".repeat(64),
};

/** Fact reporting aggregate (key thô, chỉ tồn tại server-side). */
const F = (date, project, recruiter, provider, employment, count, sourceKey = "src-a") => ({
  business_date: date,
  project_key: project,
  recruiter_key: recruiter,
  provider_type_key: provider,
  employment_type_key: employment,
  recruited_count: count,
  source_key: sourceKey,
});

const SH = (...keys) =>
  keys.map((key) => ({ source_key: key, status: "covered", quality: "ok", has_current_facts: true }));

function build(options) {
  return buildPacketFromSource({
    request: options.request ?? { period: { type: "week", as_of_date: "2026-10-11" } },
    facts: options.facts ?? [],
    source_health: options.source_health ?? SH("src-a"),
    catalog: options.catalog ?? baseCatalog,
    metadata: options.metadata ?? META,
  });
}

function ok(result, label = "packet") {
  assert.ok(result.ok, label + " phải hợp lệ: " + (result.ok ? "" : result.code + " " + result.message + " @" + result.path));
  return result;
}

function expectFail(result, code, label = "packet") {
  assert.equal(result.ok, false, label + " phải fail-closed");
  assert.equal(result.code, code, label + " code");
  assert.equal(result.packet, undefined, label + " không được phát packet một phần");
  return result;
}

const byRef = (list) => Object.fromEntries(list.map((entry) => [entry.subject_ref, entry]));

/** Tuần: W41 = 2026-10-05..10-11 (current), W40 = 2026-09-28..10-04 (comparable). */
const WEEKS = {
  w32: "2026-08-03",
  w33: "2026-08-10",
  w34: "2026-08-17",
  w35: "2026-08-24",
  w36: "2026-08-31",
  w37: "2026-09-07",
  w38: "2026-09-14",
  w39: "2026-09-21",
  w40: "2026-09-28",
  w41: "2026-10-05",
};

/** Dataset nền: mỗi tuần W32..W41 có một fact proj-a/rec-alpha/hrp/thời vụ. */
function weeklyFacts(totals) {
  const dates = [WEEKS.w32, WEEKS.w33, WEEKS.w34, WEEKS.w35, WEEKS.w36, WEEKS.w37, WEEKS.w38, WEEKS.w39, WEEKS.w40, WEEKS.w41];
  return dates.map((date, index) => F(date, "proj-alpha", "rec-alpha", "hrp", "thời vụ", totals[index]));
}

// ---------------------------------------------------------------------------
// Determinism nền: hash + canonical JSON
// ---------------------------------------------------------------------------

test("W03 hash: sha256 đúng vector chuẩn và canonical JSON ổn định theo key order", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }));
});

// ---------------------------------------------------------------------------
// Golden case: total tăng + concentrated driver
// ---------------------------------------------------------------------------

test("W03 golden: total tăng, driver tập trung, concentration/contribution đúng số học", () => {
  const facts = [
    F("2026-09-29", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 2),
    F("2026-09-30", "proj-beta", "rec-bravo", "hrp", "chính thức", 2),
    F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 6),
    F("2026-10-07", "proj-beta", "rec-bravo", "hrp", "chính thức", 2),
  ];
  const { packet, detail } = ok(build({ facts }), "golden-up");

  assert.equal(packet.period.period_ref, "week:2026-W41");
  assert.equal(packet.period.start, "2026-10-05");
  assert.equal(packet.period.end, "2026-10-11");
  assert.equal(packet.period.status, "complete");
  assert.equal(packet.period.elapsed_days, 7);
  assert.equal(packet.period.comparable.period_ref, "week:2026-W40");
  assert.equal(packet.period.comparable.start, "2026-09-28");

  assert.deepEqual(packet.totals, { current: 8, comparable: 4, delta: 4, delta_pct: 1 });
  assert.equal(packet.stability.trend_direction, "up");

  const project = byRef(packet.drivers.project);
  const alpha = packet.subjects.find((s) => s.kind === "project" && s.ref !== "scope");
  assert.ok(alpha);
  assert.equal(project[alpha.ref].current, 6);
  assert.equal(project[alpha.ref].comparable, 2);
  assert.equal(project[alpha.ref].delta, 4);
  assert.equal(project[alpha.ref].delta_contribution_share, 1);
  assert.equal(project[alpha.ref].share_of_current, 6 / 8);

  const concentration = packet.concentration.project;
  assert.equal(concentration.top1_share, 6 / 8);
  assert.equal(concentration.top3_share, 1);
  assert.equal(concentration.distinct_subjects, 2);
  assert.ok(concentration.top1_share <= concentration.top3_share);
  assert.equal(concentration.top1_ref, alpha.ref);

  // series daily zero-fill + invariant sum(series) = totals.current
  assert.equal(packet.series.granularity, "day");
  assert.equal(packet.series.points.length, 7);
  assert.equal(packet.series.points[0].period_start, "2026-10-05");
  assert.equal(packet.series.points.reduce((acc, point) => acc + point.value, 0), 8);
  assert.deepEqual(packet.series.points.map((point) => point.value), [0, 6, 2, 0, 0, 0, 0]);
  assert.equal(detail.current.end, "2026-10-11");

  // team: mọi recruiter resolve được team ⇒ available, coverage = 1
  assert.equal(packet.team_mapping.availability, "available");
  assert.equal(packet.team_mapping.coverage_ratio, 1);
  assert.equal(packet.team_mapping.unmapped_recruited_count, 0);
  assert.equal(packet.team_mapping.teams_in_scope, packet.subjects.filter((s) => s.kind === "team").length);
  assert.ok(packet.drivers.team.length > 0);
});

test("W03 golden: total giảm nhưng MỘT subject tăng (delta âm tổng, delta dương cục bộ)", () => {
  const facts = [
    F("2026-09-29", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5),
    F("2026-09-30", "proj-beta", "rec-bravo", "hrp", "chính thức", 5),
    F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 8),
    F("2026-10-07", "proj-beta", "rec-bravo", "hrp", "chính thức", 0),
  ];
  const { packet } = ok(build({ facts }), "golden-down");
  assert.equal(packet.totals.current, 8);
  assert.equal(packet.totals.comparable, 10);
  assert.equal(packet.totals.delta, -2);
  assert.equal(packet.totals.delta_pct, -0.2);
  assert.equal(packet.stability.trend_direction, "down");

  const entries = packet.drivers.project;
  const rising = entries.find((entry) => entry.delta === 3);
  const falling = entries.find((entry) => entry.delta === -5);
  assert.ok(rising && falling);
  // delta_contribution_share dùng |delta| / SUM(|delta|) ⇒ 3/8 và 5/8, dấu nằm ở delta.
  assert.equal(rising.delta_contribution_share, 3 / 8);
  assert.equal(falling.delta_contribution_share, 5 / 8);
  const sum = entries.reduce((acc, entry) => acc + entry.delta_contribution_share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

// ---------------------------------------------------------------------------
// Comparable / current = 0
// ---------------------------------------------------------------------------

test("W03 golden: comparable = 0 ⇒ delta_pct null, không tuyên bố growth rate", () => {
  const facts = [
    F("2026-09-29", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 0),
    F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 7),
  ];
  const { packet, detail } = ok(build({ facts }), "comparable-zero");
  assert.equal(packet.totals.current, 7);
  assert.equal(packet.totals.comparable, 0);
  assert.equal(packet.totals.delta, 7);
  assert.equal(packet.totals.delta_pct, null);
  assert.ok(!packet.evidence.some((entry) => entry.metric === "recruited_delta_pct"));
  const alpha = packet.drivers.project[0];
  // comparable = 0 nhưng mẫu số SUM(|delta|) > 0 ⇒ contribution vẫn xác định; chỉ delta_pct là null.
  assert.equal(alpha.delta_contribution_share, 1);
  assert.equal(alpha.comparable, 0);
  assert.equal(detail.comparable.start, "2026-09-28");
});

test("W03 golden: current = 0 (không có fact trong kỳ) ⇒ không có growth claim, không chia 0", () => {
  const facts = [F("2026-09-29", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5)];
  const { packet } = ok(build({ facts }), "current-zero");
  assert.equal(packet.totals.current, 0);
  assert.equal(packet.totals.comparable, 5);
  assert.equal(packet.totals.delta, -5);
  assert.equal(packet.totals.delta_pct, -1);
  assert.equal(packet.team_mapping.coverage_ratio, null);
  assert.equal(packet.team_mapping.availability, "unavailable");
  assert.equal(packet.data_quality.unknown_share, null);
  assert.equal(packet.concentration.project.top1_share, null);
  assert.equal(packet.concentration.project.distinct_subjects, 0);
  assert.equal(packet.stability.trend_direction, "down");
  assert.equal(packet.series.points.reduce((acc, point) => acc + point.value, 0), 0);
});

// ---------------------------------------------------------------------------
// Period: PTD + custom
// ---------------------------------------------------------------------------

test("W03 period: week PTD so cùng số ngày đã trôi qua của tuần trước", () => {
  const facts = weeklyFacts([1, 1, 1, 1, 1, 1, 1, 1, 4, 6]);
  const { packet } = ok(build({ facts, request: { period: { type: "week", as_of_date: "2026-10-07" } } }), "ptd-week");
  assert.equal(packet.period.status, "period_to_date");
  assert.equal(packet.period.period_to_date, true);
  assert.equal(packet.period.end, "2026-10-11");
  assert.equal(packet.period.elapsed_days, 3);
  assert.equal(packet.period.comparable.period_ref, "week:2026-W40");
  assert.equal(packet.period.comparable.start, "2026-09-28");
  assert.equal(packet.period.comparable.end, "2026-09-30");
  assert.equal(packet.period.comparable.elapsed_days, 3);
  assert.equal(packet.totals.current, 6);
  assert.equal(packet.totals.comparable, 4);
  assert.equal(packet.series.points.length, 3);
  assert.equal(packet.series.points.reduce((acc, point) => acc + point.value, 0), 6);
});

test("W03 period: month PTD cắt comparable theo độ dài tháng trước (tháng 2 ngắn hơn)", () => {
  const facts = [
    F("2026-02-10", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 2),
    F("2026-02-28", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 3),
    F("2026-03-01", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 1),
    F("2026-03-30", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 4),
  ];
  const { packet } = ok(
    build({ facts, request: { period: { type: "month", as_of_date: "2026-03-30" } } }),
    "ptd-month-feb"
  );
  assert.equal(packet.period.period_ref, "month:2026-03");
  assert.equal(packet.period.status, "period_to_date");
  assert.equal(packet.period.elapsed_days, 30);
  assert.equal(packet.period.comparable.period_ref, "month:2026-02");
  assert.equal(packet.period.comparable.start, "2026-02-01");
  assert.equal(packet.period.comparable.end, "2026-02-28");
  assert.equal(packet.period.comparable.elapsed_days, 30);
  assert.equal(packet.totals.current, 5);
  assert.equal(packet.totals.comparable, 5);
});

test("W03 period: quarter dùng weekly points và period_ref quarter:YYYY-Qn", () => {
  const facts = [
    F("2026-07-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 3),
    F("2026-08-03", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 4),
    F("2026-09-28", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5),
  ];
  const { packet } = ok(build({ facts, request: { period: { type: "quarter", as_of_date: "2026-09-30" } } }), "quarter");
  assert.equal(packet.period.period_ref, "quarter:2026-Q3");
  assert.equal(packet.period.start, "2026-07-01");
  assert.equal(packet.period.end, "2026-09-30");
  assert.equal(packet.series.granularity, "week");
  assert.equal(packet.series.points[0].period_start, "2026-07-01");
  assert.equal(packet.series.points[packet.series.points.length - 1].period_end, "2026-09-30");
  assert.equal(packet.series.points.reduce((acc, point) => acc + point.value, 0), 12);
  assert.equal(packet.totals.current, 12);
  assert.equal(packet.period.comparable.period_ref, "quarter:2026-Q2");
});

test("W03 period: custom so với khoảng liền trước CÙNG số ngày; chặn tương lai/from>to", () => {
  const facts = [
    F("2026-09-20", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 3),
    F("2026-09-25", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 4),
    F("2026-10-01", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5),
  ];
  const { packet } = ok(
    build({
      facts,
      request: { period: { type: "custom", as_of_date: "2026-10-11", custom_from: "2026-10-01", custom_to: "2026-10-10" } },
    }),
    "custom"
  );
  assert.equal(packet.period.period_ref, "custom:2026-10-01/2026-10-10");
  assert.equal(packet.period.elapsed_days, 10);
  assert.equal(packet.period.comparable.period_ref, "custom:2026-09-21/2026-09-30");
  assert.equal(packet.period.comparable.start, "2026-09-21");
  assert.equal(packet.period.comparable.end, "2026-09-30");
  assert.equal(packet.period.comparable.elapsed_days, 10);
  assert.equal(packet.totals.current, 5);
  assert.equal(packet.totals.comparable, 4);
  assert.equal(packet.totals.delta, 1);
  assert.equal(packet.totals.delta_pct, 0.25);
  assert.equal(packet.series.granularity, "day");
  assert.equal(packet.series.points.length, 10);

  expectFail(
    build({ facts, request: { period: { type: "custom", as_of_date: "2026-10-11", custom_from: "2026-10-10", custom_to: "2026-10-01" } } }),
    "REQUEST_CUSTOM_RANGE_INVALID",
    "custom from>to"
  );
  expectFail(
    build({ facts, request: { period: { type: "custom", as_of_date: "2026-10-11", custom_from: "2026-10-01", custom_to: "2026-10-20" } } }),
    "REQUEST_CUSTOM_FUTURE_DATE",
    "custom future"
  );
  expectFail(
    build({ facts, request: { period: { type: "week", as_of_date: "2026-10-11", custom_from: "2026-10-01", custom_to: "2026-10-02" } } }),
    "REQUEST_CUSTOM_RANGE_UNEXPECTED",
    "custom on week"
  );
});

// ---------------------------------------------------------------------------
// Baseline / sufficiency / stability
// ---------------------------------------------------------------------------

test("W03 sufficiency: đủ/thiếu baseline tuần, tháng, quý và 8 tuần day-of-week", () => {
  // Dữ liệu chỉ trải 2 tuần hoàn tất trước kỳ hiện tại ⇒ thiếu baseline tuần và thiếu 8 tuần day-of-week.
  const short = ok(
    build({
      facts: [
        F("2026-09-21", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 1),
        F("2026-09-28", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 1),
        F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 2),
      ],
    }),
    "short-baseline"
  );
  const shortSuff = Object.fromEntries(short.packet.sufficiency.map((row) => [row.key, row]));
  assert.equal(shortSuff.trend_weekly.actual_points, 2);
  assert.equal(shortSuff.trend_weekly.status, "not_met");
  assert.equal(shortSuff.trend_weekly.reason_code, "BASELINE_NOT_MET");
  assert.equal(shortSuff.trend_weekly.required_points, 4);
  assert.equal(shortSuff.day_of_week.actual_points, 2);
  assert.equal(shortSuff.day_of_week.status, "not_met");
  assert.equal(shortSuff.day_of_week.required_points, 8);
  assert.equal(shortSuff.consistency.actual_points, 3);
  assert.equal(shortSuff.consistency.status, "not_met");

  const long = ok(build({ facts: weeklyFacts([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]) }), "long-baseline");
  const longSuff = Object.fromEntries(long.packet.sufficiency.map((row) => [row.key, row]));
  assert.equal(longSuff.trend_weekly.actual_points, 9);
  assert.equal(longSuff.trend_weekly.status, "met");
  assert.equal(longSuff.day_of_week.actual_points, 9);
  assert.equal(longSuff.day_of_week.status, "met");
  // Tháng 8 bắt đầu trước dataStart (2026-08-03) nên chỉ có 1 tháng hoàn tất (tháng 9).
  assert.equal(longSuff.trend_monthly.actual_points, 1);
  assert.equal(longSuff.trend_monthly.status, "not_met");
  assert.equal(longSuff.trend_quarterly.actual_points, 0);
  assert.equal(longSuff.trend_quarterly.status, "not_met");
  assert.equal(longSuff.consistency.required_points, 4);
});

/** Bốn điểm cùng semantics: 3 tuần hoàn tất (W38..W40) + tuần hiện tại W41. */
function fourWeekFacts(totals) {
  return [
    F("2026-09-14", "proj-alpha", "rec-alpha", "hrp", "thời vụ", totals[0]),
    F("2026-09-21", "proj-alpha", "rec-alpha", "hrp", "thời vụ", totals[1]),
    F("2026-09-28", "proj-alpha", "rec-alpha", "hrp", "thời vụ", totals[2]),
    F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", totals[3]),
  ];
}

test("W03 stability: low/medium/high volatility theo cv population (band đã khóa)", () => {
  const low = ok(build({ facts: fourWeekFacts([10, 10, 10, 10]) }), "cv-low").packet;
  assert.equal(low.stability.period_points, 4);
  assert.equal(low.stability.mean, 10);
  assert.equal(low.stability.stddev, 0);
  assert.equal(low.stability.cv, 0);
  assert.equal(low.stability.volatility, "low");

  const medium = ok(build({ facts: fourWeekFacts([10, 10, 20, 20]) }), "cv-medium").packet;
  assert.equal(medium.stability.period_points, 4);
  assert.equal(medium.stability.mean, 15);
  assert.ok(Math.abs(medium.stability.cv - 5 / 15) < 1e-12);
  assert.equal(medium.stability.volatility, "medium");

  const high = ok(build({ facts: fourWeekFacts([0, 0, 0, 20]) }), "cv-high").packet;
  assert.equal(high.stability.period_points, 4);
  assert.equal(high.stability.mean, 5);
  assert.ok(high.stability.cv > 1);
  assert.equal(high.stability.volatility, "high");

  const unknown = ok(build({ facts: [F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5)] }), "cv-unknown").packet;
  assert.equal(unknown.stability.period_points, 1);
  assert.equal(unknown.stability.cv, null);
  assert.equal(unknown.stability.volatility, "unknown");
  assert.equal(unknown.stability.trend_direction, "unknown");
});

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

test("W03 data quality: source partial/stale/never_succeeded giữ riêng và hạ sufficiency", () => {
  const facts = [
    F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 3, "src-a"),
    F("2026-10-07", "proj-beta", "rec-bravo", "hrp", "chính thức", 2, "src-b"),
  ];
  const sources = [
    { source_key: "src-a", status: "covered", quality: "ok", has_current_facts: true },
    { source_key: "src-b", status: "stale_snapshot", quality: "partial", has_current_facts: false },
    { source_key: "src-c", status: "never_succeeded", quality: "unknown", has_current_facts: false },
  ];
  const { packet, detail } = ok(build({ facts, source_health: sources }), "dq-partial");

  assert.equal(packet.scope.sources_in_scope, 3);
  assert.equal(packet.data_quality.sources.length, 3);
  assert.deepEqual(packet.data_quality.sources.map((row) => row.status), ["covered", "stale_snapshot", "never_succeeded"]);
  assert.deepEqual(packet.data_quality.sources.map((row) => row.source_ref), ["source_01", "source_02", "source_03"]);
  assert.equal(packet.data_quality.coverage_ratio, 1 / 3);
  assert.equal(detail.data_quality.quality, "partial");
  assert.ok(detail.data_quality.degraded_reasons.includes("SOURCE_COVERAGE_INCOMPLETE"));
  for (const row of packet.sufficiency) {
    assert.equal(row.status, "unknown");
    assert.equal(row.reason_code, "SOURCE_COVERAGE_INCOMPLETE");
  }
  const coverage = packet.evidence.find((entry) => entry.metric === "data_quality.source_coverage");
  assert.equal(coverage.value, 1 / 3);
  assert.equal(coverage.unit, "ratio");
});

test("W03 data quality: unknown/invalid độc lập, grain vừa unknown vừa invalid chỉ tính một lần ở packet", () => {
  const facts = [
    F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 4),
    F("2026-10-06", "__unknown__", "rec-bravo", "hrp", "thời vụ", 3),
    F("2026-10-06", "proj-beta", "rec-charlie", "__invalid__", "thời vụ", 2),
    F("2026-10-06", "__unknown__", "rec-echo", "__invalid__", "thời vụ", 5),
  ];
  const { packet, detail } = ok(build({ facts }), "dq-sentinel");
  assert.equal(packet.totals.current, 14);
  // unknown-only = 3 (grain 4 vừa unknown vừa invalid); invalid = 2 + 5 = 7
  assert.equal(packet.data_quality.unknown_count, 3);
  assert.equal(packet.data_quality.invalid_count, 7);
  assert.ok(packet.data_quality.unknown_count + packet.data_quality.invalid_count <= packet.totals.current);
  assert.equal(packet.data_quality.unknown_share, 3 / 14);
  assert.equal(packet.data_quality.invalid_share, 7 / 14);
  // Hai chỉ số độc lập vẫn được phát đầy đủ qua evidence.
  assert.equal(detail.data_quality.unknown_any_count, 8);
  assert.equal(detail.data_quality.invalid_any_count, 7);
  assert.equal(detail.data_quality.overlap_count, 5);
  const metricValue = (metric) => packet.evidence.find((entry) => entry.metric === metric).value;
  assert.equal(metricValue("data_quality.unknown_any_count"), 8);
  assert.equal(metricValue("data_quality.invalid_count"), 7);
  assert.equal(metricValue("data_quality.unknown_invalid_overlap_count"), 5);
  assert.ok(detail.data_quality.degraded_reasons.includes("DIMENSION_UNKNOWN_PRESENT"));
  assert.ok(detail.data_quality.degraded_reasons.includes("DIMENSION_INVALID_PRESENT"));
});

// ---------------------------------------------------------------------------
// Identity / team nhiều time window
// ---------------------------------------------------------------------------

const teamAvailableFacts = [
  F("2026-09-29", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 4),
  F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5),
  F("2026-10-07", "proj-beta", "rec-bravo", "hrp", "chính thức", 3),
];

test("W03 team: current mapping available ⇒ có team driver/subject, coverage khớp G2", () => {
  const { packet } = ok(build({ facts: teamAvailableFacts }), "team-available");
  assert.equal(packet.team_mapping.availability, "available");
  assert.equal(packet.team_mapping.mapped_recruited_count, 8);
  assert.equal(packet.team_mapping.unmapped_recruited_count, 0);
  assert.equal(packet.team_mapping.ambiguous_recruited_count, 0);
  assert.equal(packet.team_mapping.coverage_ratio, 1);
  assert.equal(packet.team_mapping.reason_code, "TEAM_MAPPING_AVAILABLE");
  assert.ok(packet.drivers.team.length > 0);
  assert.equal(packet.drivers.team.reduce((acc, entry) => acc + entry.current, 0), 8);
  assert.ok(packet.subjects.some((subject) => subject.kind === "team"));
});

test("W03 team: có fact recruiter không map được team ⇒ partial và remainder được ghi rõ", () => {
  const facts = [...teamAvailableFacts, F("2026-10-08", "proj-gamma", "rec-golf", "vendor", "chính thức", 2)];
  const { packet, detail } = ok(build({ facts }), "team-partial");
  assert.equal(packet.team_mapping.availability, "partial");
  assert.equal(packet.team_mapping.mapped_recruited_count, 8);
  assert.equal(packet.team_mapping.unmapped_recruited_count, 2);
  assert.equal(packet.team_mapping.coverage_ratio, 8 / 10);
  assert.equal(detail.breakdown_remainder.team, 2);
  assert.equal(packet.drivers.team.reduce((acc, entry) => acc + entry.current, 0) + 2, packet.totals.current);
  const remainder = packet.evidence.find((entry) => entry.metric === "breakdown_remainder.team");
  assert.equal(remainder.value, 2);
  assert.deepEqual(detail.breakdown_remainder.recruiter, 0);
});

test("W03 team: current ambiguous ⇒ redact TOÀN BỘ team (không team subject/driver, teams_in_scope 0)", () => {
  const catalog = clone(baseCatalog);
  catalog.aliases.push({
    alias_id: "alias_901",
    recruiter_id: "rcr_005",
    reporting_key: "rec-bravo",
    valid_from: "2026-10-01",
    valid_to: null,
  });
  const { packet } = ok(build({ facts: teamAvailableFacts, catalog }), "team-ambiguous-current");
  assert.equal(packet.team_mapping.availability, "ambiguous");
  assert.ok(packet.team_mapping.ambiguous_recruited_count > 0);
  assert.equal(packet.team_mapping.teams_in_scope, 0);
  assert.deepEqual(packet.drivers.team, []);
  assert.equal(packet.subjects.filter((subject) => subject.kind === "team").length, 0);
  assert.deepEqual(packet.concentration.team, { top1_ref: null, top1_share: null, top3_share: null, distinct_subjects: 0 });
  // Nhưng recruiter/project/provider vẫn phân tích bình thường.
  assert.ok(packet.drivers.recruiter.length > 0);
  assert.equal(packet.totals.current, 8);
});

test("W03 team: chỉ historical/comparable ambiguous KHÔNG làm sai current team coverage", () => {
  const catalog = clone(baseCatalog);
  catalog.aliases.push({
    alias_id: "alias_902",
    recruiter_id: "rcr_005",
    reporting_key: "rec-bravo",
    valid_from: "2026-09-28",
    valid_to: "2026-10-05",
  });
  // rec-bravo mơ hồ CHỈ trong tuần so sánh (W40); tuần hiện tại resolve bình thường.
  const facts = [
    F("2026-09-29", "proj-alpha", "rec-bravo", "hrp", "thời vụ", 4),
    F("2026-10-06", "proj-alpha", "rec-bravo", "hrp", "thời vụ", 5),
    F("2026-10-07", "proj-beta", "rec-alpha", "hrp", "chính thức", 3),
  ];
  const { packet, detail } = ok(build({ facts, catalog }), "team-ambiguous-comparable");
  assert.equal(packet.team_mapping.availability, "available");
  assert.equal(packet.team_mapping.coverage_ratio, 1);
  assert.ok(packet.drivers.team.length > 0);
  assert.equal(detail.breakdown_remainder.team, 0);
  // Comparable window mơ hồ ⇒ team comparison phải null (không so sánh trên dữ liệu không giải được).
  for (const entry of packet.drivers.team) {
    assert.equal(entry.comparable, null);
    assert.equal(entry.delta, null);
    assert.equal(entry.delta_contribution_share, null);
  }
  assert.ok(packet.drivers.team.every((entry) => entry.current > 0));
});

test("W03 identity: recruiter/team inactive vẫn resolve fact lịch sử đúng effective date", () => {
  const catalog = clone(baseCatalog);
  catalog.team_memberships.push({
    membership_id: "tm_900",
    recruiter_id: "rcr_008",
    team_id: "team_004",
    valid_from: "2026-01-01",
    valid_to: null,
  });
  const facts = [
    F("2026-06-15", "proj-alpha", "rec-delta", "hrp", "thời vụ", 2),
    F("2026-06-16", "proj-beta", "rec-golf", "vendor", "chính thức", 3),
  ];
  const { packet } = ok(
    build({ facts, catalog, request: { period: { type: "week", as_of_date: "2026-06-21" } } }),
    "inactive-historical"
  );
  assert.equal(packet.period.period_ref, "week:2026-W25");
  assert.equal(packet.totals.current, 5);
  assert.equal(packet.team_mapping.availability, "available");
  assert.equal(packet.drivers.recruiter.length, 2);
  assert.equal(packet.drivers.team.length, 2);
  assert.equal(packet.drivers.team.reduce((acc, entry) => acc + entry.current, 0), 5);
});

test("W03 identity: ref opaque ổn định trên UNION (current + comparable + baseline)", () => {
  const facts = [
    F("2026-08-10", "proj-alpha", "rec-echo", "hrp", "thời vụ", 1),
    F("2026-09-29", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 2),
    F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 3),
    F("2026-10-06", "proj-beta", "rec-bravo", "hrp", "chính thức", 4),
  ];
  const { packet } = ok(build({ facts }), "union-refs");
  // rec-alpha có mặt ở CẢ comparable và current ⇒ phải quy về CÙNG một opaque ref.
  const alpha = packet.drivers.recruiter.find((entry) => entry.current === 3);
  assert.ok(alpha);
  assert.equal(alpha.comparable, 2);
  const recruiterRefs = packet.subjects.filter((subject) => subject.kind === "recruiter").map((subject) => subject.ref);
  assert.equal(recruiterRefs.length, 2);
  assert.equal(new Set(recruiterRefs).size, 2);
  assert.ok(recruiterRefs.every((ref) => /^recruiter_[0-9]{2}$/.test(ref)));
  const second = ok(build({ facts: [...facts].reverse() }), "union-refs-reversed").packet;
  assert.deepEqual(second.subjects, packet.subjects);
  assert.deepEqual(second.drivers.recruiter, packet.drivers.recruiter);
});

// ---------------------------------------------------------------------------
// Project × provider mix
// ---------------------------------------------------------------------------

test("W03 project×provider: HRP-heavy / Vendor-heavy / balanced / sentinel giữ semantics R7", () => {
  const facts = [
    F("2026-10-06", "proj-hrp", "rec-alpha", "hrp", "thời vụ", 6),
    F("2026-10-06", "proj-hrp", "rec-bravo", "vendor", "chính thức", 2),
    F("2026-10-06", "proj-vendor", "rec-charlie", "vendor", "thời vụ", 7),
    F("2026-10-06", "proj-vendor", "rec-echo", "hrp", "chính thức", 1),
    F("2026-10-06", "proj-balanced", "rec-foxtrot", "hrp", "thời vụ", 5),
    F("2026-10-06", "proj-balanced", "rec-golf", "vendor", "chính thức", 5),
    F("2026-10-06", "proj-sentinel", "__unknown__", "hrp", "thời vụ", 4),
    F("2026-10-06", "proj-sentinel", "rec-alpha", "__invalid__", "thời vụ", 3),
    F("2026-10-06", "proj-sentinel", "rec-bravo", "__unknown__", "__unknown__", 1),
  ];
  const { packet } = ok(build({ facts }), "mix");
  const mix = byRef(packet.project_provider_mix);
  const subjectOf = (projectKey) => {
    for (const row of packet.project_provider_mix) {
      const match = facts.some((fact) => fact.project_key === projectKey);
      if (match) return row;
    }
    return null;
  };
  assert.ok(subjectOf("proj-hrp"));
  const rows = packet.project_provider_mix;
  assert.equal(rows.length, 4);
  assert.equal(rows.reduce((acc, row) => acc + row.project_total, 0), packet.totals.current);
  const hrpProject = rows.find((row) => row.hrp_count === 6 && row.vendor_count === 2);
  assert.equal(hrpProject.hrp_share, 6 / 8);
  assert.equal(hrpProject.vendor_share, 2 / 8);
  const balanced = rows.find((row) => row.hrp_count === 5 && row.vendor_count === 5);
  assert.equal(balanced.hrp_share, 0.5);
  const sentinel = rows.find((row) => row.unknown_count > 0 && row.invalid_count > 0);
  assert.equal(sentinel.known_total, sentinel.hrp_count + sentinel.vendor_count);
  assert.equal(sentinel.project_total, sentinel.hrp_count + sentinel.vendor_count + sentinel.unknown_count + sentinel.invalid_count);
  assert.equal(sentinel.known_coverage, sentinel.known_total / sentinel.project_total);
  assert.equal(mix[sentinel.subject_ref].unknown_count, sentinel.unknown_count);
  // Không ép sentinel sang HRP/Vendor.
  assert.equal(sentinel.hrp_share + sentinel.vendor_share <= 1, true);
});

// ---------------------------------------------------------------------------
// Determinism / hash / privacy / strict validation
// ---------------------------------------------------------------------------

const goldenScenarios = () => [
  { label: "up", facts: weeklyFacts([1, 2, 3, 4, 5, 6, 7, 8, 4, 6]) },
  { label: "team-partial", facts: [...teamAvailableFacts, F("2026-10-08", "proj-gamma", "rec-golf", "vendor", "chính thức", 2)] },
  { label: "current-zero", facts: [F("2026-09-29", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5)] },
  { label: "sentinel", facts: [F("2026-10-06", "__unknown__", "__invalid__", "__invalid__", "__unknown__", 3)] },
  { label: "empty", facts: [] },
];

test("W03 determinism: đảo thứ tự input ⇒ packet byte-equivalent", () => {
  for (const scenario of goldenScenarios()) {
    const forward = ok(build({ facts: scenario.facts }), scenario.label + "-forward").packet;
    const reversed = ok(build({ facts: [...scenario.facts].reverse() }), scenario.label + "-reversed").packet;
    assert.equal(JSON.stringify(reversed), JSON.stringify(forward), scenario.label + " JSON");
    assert.equal(canonicalJson(reversed), canonicalJson(forward), scenario.label + " canonical");
    assert.equal(reversed.snapshot.hash, forward.snapshot.hash, scenario.label + " hash");
  }
});

test("W03 determinism: đổi fact/metric/scope ⇒ snapshot hash đổi; scope hash độc lập với kỳ", () => {
  const base = ok(build({ facts: weeklyFacts([1, 1, 1, 1, 1, 1, 1, 1, 1, 2]) }), "hash-base").packet;
  const changedCount = ok(build({ facts: weeklyFacts([1, 1, 1, 1, 1, 1, 1, 1, 1, 3]) }), "hash-count").packet;
  assert.notEqual(changedCount.snapshot.hash, base.snapshot.hash);
  assert.equal(changedCount.scope.scope_hash, base.scope.scope_hash);

  const changedScope = ok(
    build({
      facts: weeklyFacts([1, 1, 1, 1, 1, 1, 1, 1, 1, 2]),
      request: { period: { type: "week", as_of_date: "2026-10-11" }, scope: { dimensions: ["project", "provider"] } },
    }),
    "hash-scope"
  ).packet;
  assert.notEqual(changedScope.scope.scope_hash, base.scope.scope_hash);
  assert.notEqual(changedScope.snapshot.hash, base.snapshot.hash);
  assert.deepEqual(changedScope.scope.dimensions, ["project", "provider"]);
  assert.deepEqual(changedScope.drivers.recruiter, []);
  assert.deepEqual(changedScope.drivers.team, []);

  const otherPeriod = ok(
    build({ facts: weeklyFacts([1, 1, 1, 1, 1, 1, 1, 1, 1, 2]), request: { period: { type: "week", as_of_date: "2026-10-04" } } }),
    "hash-period"
  ).packet;
  assert.notEqual(otherPeriod.snapshot.hash, base.snapshot.hash);
  assert.notEqual(otherPeriod.period.period_ref, base.period.period_ref);
});

test("W03 privacy: packet không chứa stable id/key thô/display/ref_map; qua được deep-scan", () => {
  const facts = [
    ...teamAvailableFacts,
    F("2026-10-08", "__unknown__", "rec-golf", "__invalid__", "__unknown__", 2),
  ];
  const { packet } = ok(build({ facts }), "privacy");
  assert.equal(scanForbiddenPacketContent(packet), null);
  const serialized = JSON.stringify(packet);
  for (const forbidden of [
    "rcr_",
    "team_001",
    "team_002",
    "team_003",
    "team_004",
    "alias_",
    "membership_id",
    "recruiter_id",
    "team_id",
    "display",
    "ref_map",
    "server_diagnostics",
    "provider_membership_type",
    "rec-alpha",
    "proj-alpha",
    "src-a",
    "file_name",
    "drive_file_id",
    "source_id",
    "@",
  ]) {
    assert.ok(!serialized.includes(forbidden), "packet không được chứa " + forbidden);
  }
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serialized), "không UUID");
  const subjectRefs = packet.subjects.map((subject) => subject.ref);
  for (const ref of subjectRefs) {
    assert.ok(
      /^(?:scope|project_[0-9]{2,}|recruiter_[0-9]{2,}|team_[0-9]{2,}|provider_(?:hrp|vendor|unknown|invalid)|employment_(?:seasonal|official|unknown|invalid))$/.test(ref),
      "ref phải là opaque: " + ref
    );
  }
});

test("W03 strict validator: mọi golden packet pass analysis-packet/0.1", () => {
  const ambiguousCatalog = clone(baseCatalog);
  ambiguousCatalog.aliases.push({
    alias_id: "alias_903",
    recruiter_id: "rcr_005",
    reporting_key: "rec-alpha",
    valid_from: "2026-10-01",
    valid_to: null,
  });
  const scenarios = [
    ...goldenScenarios(),
    { label: "ptd", facts: weeklyFacts([1, 1, 1, 1, 1, 1, 1, 1, 2, 3]), request: { period: { type: "week", as_of_date: "2026-10-07" } } },
    { label: "month", facts: weeklyFacts([1, 1, 1, 1, 1, 1, 1, 1, 2, 3]), request: { period: { type: "month", as_of_date: "2026-10-11" } } },
    { label: "quarter", facts: weeklyFacts([1, 1, 1, 1, 1, 1, 1, 1, 2, 3]), request: { period: { type: "quarter", as_of_date: "2026-10-11" } } },
    { label: "custom", facts: weeklyFacts([1, 1, 1, 1, 1, 1, 1, 1, 2, 3]), request: { period: { type: "custom", as_of_date: "2026-10-11", custom_from: "2026-09-01", custom_to: "2026-10-11" } } },
    { label: "team-ambiguous", facts: teamAvailableFacts, catalog: ambiguousCatalog },
    { label: "partial-sources", facts: teamAvailableFacts, source_health: [{ source_key: "src-a", status: "incomplete", quality: "partial", has_current_facts: true }] },
    { label: "no-sources", facts: [], source_health: [] },
  ];
  for (const scenario of scenarios) {
    const built = ok(build(scenario), scenario.label);
    const validated = validateAnalysisPacket(built.packet);
    assert.ok(validated.ok, scenario.label + " phải pass validator: " + (validated.ok ? "" : validated.code + " " + validated.message));
    // Evidence hợp lệ và id ổn định
    for (const evidence of built.packet.evidence) {
      assert.ok(/^ev_[0-9]{2,}$/.test(evidence.evidence_id));
      assert.equal(evidence.snapshot_ref, built.packet.snapshot.hash);
      assert.equal(evidence.scope_ref, built.packet.scope.scope_hash);
      assert.equal(evidence.period_ref, built.packet.period.period_ref);
      assert.ok(evidence.subject_ref === "scope" || built.packet.subjects.some((subject) => subject.ref === evidence.subject_ref));
    }
  }
});

test("W03 invariants: totals = sum(series) = sum(mix) = sum(breakdown) + remainder", () => {
  const facts = [
    ...teamAvailableFacts,
    F("2026-09-29", "proj-beta", "rec-charlie", "vendor", "chính thức", 2),
    F("2026-10-08", "proj-gamma", "rec-golf", "__unknown__", "thời vụ", 1),
  ];
  const { packet, detail } = ok(build({ facts }), "invariants");
  assert.equal(packet.series.points.reduce((acc, point) => acc + point.value, 0), packet.totals.current);
  assert.equal(packet.project_provider_mix.reduce((acc, row) => acc + row.project_total, 0), packet.totals.current);
  for (const dimension of ["project", "recruiter", "team", "provider", "employment"]) {
    const covered = packet.drivers[dimension].reduce((acc, entry) => acc + entry.current, 0);
    assert.equal(covered + detail.breakdown_remainder[dimension], packet.totals.current, dimension + " reconcile");
  }
  // provider/employment/project là breakdown đầy đủ ⇒ remainder = 0
  assert.equal(detail.breakdown_remainder.project, 0);
  assert.equal(detail.breakdown_remainder.provider, 0);
  assert.equal(detail.breakdown_remainder.employment, 0);
});

// ---------------------------------------------------------------------------
// Fail-closed input
// ---------------------------------------------------------------------------

test("W03 fail-closed: request sai ⇒ lỗi rõ ràng, không phát packet", () => {
  const facts = teamAvailableFacts;
  expectFail(build({ facts, request: { period: { type: "day", as_of_date: "2026-10-11" } } }), "REQUEST_INVALID_PERIOD_TYPE", "period type");
  expectFail(build({ facts, request: { period: { type: "week", as_of_date: "2026-02-30" } } }), "REQUEST_INVALID_AS_OF_DATE", "as_of");
  expectFail(build({ facts, request: { period: { type: "week", as_of_date: "2026-10-11" }, scope: { dimensions: [] } } }), "REQUEST_INVALID_DIMENSIONS", "dimensions");
  expectFail(
    build({ facts, request: { period: { type: "week", as_of_date: "2026-10-11" }, scope: { dimensions: ["project", "project"] } } }),
    "REQUEST_INVALID_DIMENSIONS",
    "dimensions dup"
  );
  expectFail(
    build({ facts, request: { period: { type: "custom", as_of_date: "2026-10-11", custom_from: "2025-01-01", custom_to: "2026-10-11" } } }),
    "REQUEST_CUSTOM_TOO_LONG",
    "custom > 400 ngày"
  );
});

test("W03 fail-closed: fact sai (ngày/count/danh mục/source) ⇒ lỗi rõ ràng", () => {
  expectFail(build({ facts: [F("2026-13-01", "p", "rec-alpha", "hrp", "thời vụ", 1)] }), "FACT_INVALID_DATE", "date");
  expectFail(build({ facts: [F("2026-10-06", "p", "rec-alpha", "hrp", "thời vụ", -1)] }), "FACT_INVALID_COUNT", "count âm");
  expectFail(build({ facts: [F("2026-10-06", "p", "rec-alpha", "hrp", "thời vụ", 1.5)] }), "FACT_INVALID_COUNT", "count lẻ");
  expectFail(build({ facts: [F("2026-10-06", "p", "rec-alpha", "fulltime", "thời vụ", 1)] }), "FACT_INVALID_PROVIDER_KEY", "provider");
  expectFail(build({ facts: [F("2026-10-06", "p", "rec-alpha", "hrp", "intern", 1)] }), "FACT_INVALID_EMPLOYMENT_KEY", "employment");
  expectFail(build({ facts: [F("2026-10-06", "", "rec-alpha", "hrp", "thời vụ", 1)] }), "FACT_INVALID_PROJECT_KEY", "project rỗng");
  expectFail(build({ facts: [F("2026-10-06", "p", "", "hrp", "thời vụ", 1)] }), "FACT_INVALID_RECRUITER_KEY", "recruiter rỗng");
  expectFail(
    build({ facts: [F("2026-10-06", "p", "rec-alpha", "hrp", "thời vụ", 1, "src-zzz")] }),
    "FACT_SOURCE_UNKNOWN",
    "source lạ"
  );
  expectFail(
    build({ facts: [], source_health: [{ source_key: "src-a", status: "unknown_status", quality: "ok", has_current_facts: true }] }),
    "SOURCE_INVALID_STATUS",
    "source status"
  );
  expectFail(build({ facts: [], metadata: { ...META, lineage_ref: "khong-phai-hash" } }), "METADATA_INVALID_LINEAGE_REF", "lineage");
  expectFail(build({ facts: [], metadata: { ...META, generated_at: "2026-10-12 00:00:00" } }), "METADATA_INVALID_GENERATED_AT", "generated_at");
});

test("W03 fail-closed: catalog/identity sai phải qua validator G2", () => {
  const brokenCatalog = clone(baseCatalog);
  brokenCatalog.aliases[0].recruiter_id = "rcr_999";
  expectFail(build({ facts: teamAvailableFacts, catalog: brokenCatalog }), "CATALOG_DANGLING_RECRUITER", "catalog dangling");
  expectFail(build({ facts: teamAvailableFacts, catalog: {} }), "CATALOG_NOT_OBJECT", "catalog rỗng");
});

test("W03 fail-closed: engine input hỏng (team coverage lệch) ⇒ TEAM_COVERAGE_INCONSISTENT", () => {
  const engineInput = {
    request: { period: { type: "week", as_of_date: "2026-10-11" } },
    facts: [
      {
        business_date: "2026-10-06",
        project_key: "proj-alpha",
        provider_type_key: "hrp",
        employment_type_key: "thời vụ",
        recruited_count: 5,
        source_ref: "source_01",
        recruiter_ref: "recruiter_01",
        team_ref: "team_01",
        identity_classification: "mapped",
        recruiter_quality: "ok",
      },
    ],
    source_health: [{ source_ref: "source_01", status: "covered", quality: "ok", has_current_facts: true }],
    team: {
      current: {
        availability: "available",
        mapped_recruited_count: 5,
        unmapped_recruited_count: 0,
        ambiguous_recruited_count: 0,
        coverage_ratio: 1,
        teams_in_scope: 1,
        reason_code: "TEAM_MAPPING_AVAILABLE",
      },
      comparable: null,
    },
    metadata: META,
  };
  const mismatched = clone(engineInput);
  mismatched.team.current.mapped_recruited_count = 4;
  expectFail(buildFeaturePacket(mismatched), "TEAM_COVERAGE_INCONSISTENT", "team coverage lệch");

  const redactionMissing = clone(engineInput);
  redactionMissing.team.current = {
    availability: "ambiguous",
    mapped_recruited_count: 0,
    unmapped_recruited_count: 0,
    ambiguous_recruited_count: 5,
    coverage_ratio: 0,
    teams_in_scope: 0,
    reason_code: "TEAM_MAPPING_AMBIGUOUS",
  };
  expectFail(buildFeaturePacket(redactionMissing), "TEAM_COVERAGE_INCONSISTENT", "redaction thiếu");

  const packed = ok(buildFeaturePacket(engineInput), "engine trực tiếp");
  assert.equal(packed.packet.totals.current, 5);
  const invalid = clone(engineInput);
  invalid.facts[0].team_ref = null;
  invalid.facts[0].identity_classification = "ambiguous";
  expectFail(buildFeaturePacket(invalid), "TEAM_COVERAGE_INCONSISTENT", "classification lệch");
});

test("W03 fail-closed: reporting fact validator độc lập với builder", () => {
  const mapped = { ...F("2026-10-06", "p", "rec-alpha", "hrp", "thời vụ", 1), source_ref: "source_01" };
  delete mapped.source_key;
  assert.equal(validateReportingFacts([mapped]).ok, true);
  assert.equal(validateReportingFacts(null).ok, false);
  const duplicated = [mapped, { ...mapped }];
  assert.equal(validateReportingFacts(duplicated).code, "FACT_DUPLICATE_GRAIN");
});
