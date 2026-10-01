import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

import { normalizeDimensionKey } from "../contracts/daily-recruitment-breakdown.ts";
import { parseReportingFilters, isRealCalendarDate } from "./p1-filter.ts";
import { computeReporting, reportingQueryFailed, REPORTING_QUERY_FAILED_CODE } from "./p1-reporting.ts";

const dir = path.join(process.cwd(), "docs", "contracts", "fixtures", "p1-reporting");
const input = JSON.parse(readFileSync(path.join(dir, "input.json"), "utf8"));
const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8"));

const PROVIDER_KEY = { HRP: "hrp", Vendor: "vendor", "Không xác định": "__unknown__", "Không hợp lệ": "__invalid__" };
const EMPLOYMENT_KEY = { "Thời vụ": "thời vụ", "Chính thức": "chính thức", "Không xác định": "__unknown__", "Không hợp lệ": "__invalid__" };
const freeKey = (display) => (display === "Không xác định" ? "__unknown__" : normalizeDimensionKey(display));

const sources = input.sources.map((s) => ({ ...s, last_seen_at: null }));
const facts = input.breakdown.map((b) => ({
  source_id: b.source_id,
  business_date: b.business_date,
  project_key: freeKey(b.project_display),
  project_display: b.project_display,
  recruiter_key: freeKey(b.recruiter_display),
  recruiter_display: b.recruiter_display,
  provider_type_key: PROVIDER_KEY[b.provider_type_display],
  provider_type_display: b.provider_type_display,
  employment_type_key: EMPLOYMENT_KEY[b.employment_type_display],
  employment_type_display: b.employment_type_display,
  recruited_count: b.recruited_count,
}));

const scopeIds = new Set(sources.filter((s) => s.active && !s.is_test).map((s) => s.id));

function run(params) {
  const parsed = parseReportingFilters(params, scopeIds);
  assert.equal(parsed.ok, true, "parse phải thành công: " + (parsed.ok ? "" : parsed.message));
  return computeReporting(sources, facts, parsed.filters);
}

test("1. no filter = 18", () => {
  assert.equal(run({}).recruitedTotal, expected.cases.no_filter.recruited_total);
});

test("2. date range = 11", () => {
  const r = run({ from: "2026-10-02", to: "2026-10-03" });
  assert.equal(r.recruitedTotal, expected.cases.date_range.recruited_total);
  assert.deepEqual(r.byDate, expected.cases.date_range.by_date);
});

test("3. project + provider = 5", () => {
  assert.equal(run({ project: "Dự án A", provider: "hrp" }).recruitedTotal, expected.cases.project_provider.recruited_total);
});

test("4. recruiter + employment = 3", () => {
  assert.equal(run({ recruiter: "Nguyễn Văn A", employment: "chính thức" }).recruitedTotal, expected.cases.recruiter_employment.recruited_total);
});

test("5. unknown/invalid groups", () => {
  const e = expected.cases.unknown_invalid_groups;
  assert.equal(run({ provider: "__unknown__" }).recruitedTotal, e.provider_unknown);
  assert.equal(run({ provider: "__invalid__" }).recruitedTotal, e.provider_invalid);
  assert.equal(run({ employment: "__unknown__" }).recruitedTotal, e.employment_unknown);
  assert.equal(run({ employment: "__invalid__" }).recruitedTotal, e.employment_invalid);
  assert.equal(run({ project: "__unknown__" }).recruitedTotal, e.project_unknown);
  assert.equal(run({ recruiter: "__unknown__" }).recruitedTotal, e.recruiter_unknown);
});

test("6. fixture 200 người bị loại", () => {
  const r = run({});
  assert.equal(r.recruitedTotal, 18);
  assert.ok(!r.byProject["Dự án Fixture"]);
  assert.ok(!r.sources.some((s) => s.drive_file_id === "P0FIXTURE_DRIVE_FILE_A"));
  assert.equal(r.recruitedTotal + 200, 218);
});

test("7. coverage counts + ratio 0.75", () => {
  const r = run({});
  const e = expected.cases.coverage;
  assert.equal(r.coverage.expected, e.sources_expected);
  assert.equal(r.coverage.succeeded, e.sources_succeeded);
  assert.equal(r.coverage.partial, e.sources_partial);
  assert.equal(r.coverage.failed, e.sources_failed);
  assert.equal(r.coverage.neverSucceeded, e.sources_never_succeeded);
  assert.equal(r.coverage.coverageRatio, e.coverage_ratio);
});

test("8. breakdown totals khớp recruitedTotal", () => {
  const r = run({});
  const sum = (o) => Object.values(o).reduce((a, v) => a + v, 0);
  assert.equal(sum(r.byDate), r.recruitedTotal);
  assert.equal(sum(r.byProject), r.recruitedTotal);
  assert.equal(sum(r.byRecruiter), r.recruitedTotal);
  assert.equal(sum(r.byProvider), r.recruitedTotal);
  assert.equal(sum(r.byEmployment), r.recruitedTotal);
});

test("9. expected=0 => coverageRatio=null", () => {
  const r = computeReporting([], [], {});
  assert.equal(r.coverage.expected, 0);
  assert.equal(r.coverage.coverageRatio, null);
  assert.equal(r.empty.noSources, true);
  assert.equal(r.recruitedTotal, 0);
});

test("10. invalid calendar date", () => {
  assert.equal(parseReportingFilters({ from: "2026-02-30" }, scopeIds).ok, false);
  assert.equal(isRealCalendarDate("2026-02-30"), false);
  assert.equal(isRealCalendarDate("2026-02-28"), true);
});

test("11. from > to", () => {
  assert.equal(parseReportingFilters({ from: "2026-10-03", to: "2026-10-01" }, scopeIds).ok, false);
});

test("12. invalid provider/employment/source UUID", () => {
  assert.equal(parseReportingFilters({ provider: "nope" }, scopeIds).ok, false);
  assert.equal(parseReportingFilters({ employment: "nope" }, scopeIds).ok, false);
  assert.equal(parseReportingFilters({ source: "not-a-uuid" }, scopeIds).ok, false);
});

test("13. source UUID ngoài scope", () => {
  assert.equal(parseReportingFilters({ source: "99999999-9999-4999-8999-999999999999" }, scopeIds).ok, false);
});

test("14. DB error không trở thành dữ liệu 0", () => {
  const err = reportingQueryFailed();
  assert.equal(err.ok, false);
  assert.equal(err.code, REPORTING_QUERY_FAILED_CODE);
  assert.ok(err.message.length > 0);
  assert.ok(!("data" in err));
  const empty = computeReporting([], [], {});
  assert.equal(empty.empty.noSources, true);
});
