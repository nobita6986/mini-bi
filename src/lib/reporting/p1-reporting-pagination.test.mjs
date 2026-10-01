import assert from "node:assert/strict";
import { test } from "node:test";

import { buildReportingFactQuery, computeReporting } from "./p1-reporting.ts";
import {
  paginateAll,
  REPORTING_FACT_ORDER,
  REPORTING_PAGINATION_FAILED_CODE,
  REPORTING_COUNT_MISMATCH_CODE,
  REPORTING_RESULT_TOO_LARGE_CODE,
} from "./p1-reporting-pagination.ts";

/** Mock loader mô phỏng DB đã lọc + order sẵn; chỉ áp dụng range. */
function arrayLoader(allRows, opts = {}) {
  const calls = [];
  const failAt = opts.failAt ?? null;
  const countOverride = opts.countOverride;
  const loader = async ([from, to]) => {
    calls.push([from, to]);
    if (calls.length - 1 === failAt) return { rows: [], count: null, error: { code: "X", message: "boom" } };
    const rows = allRows.slice(from, to + 1);
    const count = countOverride !== undefined ? countOverride : allRows.length;
    return { rows, count };
  };
  return { loader, calls };
}

function numRows(n) {
  return Array.from({ length: n }, (_, i) => ({ n: i }));
}

test("1. 999 dòng: lấy đủ trong 1 page", async () => {
  const { loader, calls } = arrayLoader(numRows(999));
  const r = await paginateAll(loader);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 999);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [0, 999]);
});

test("2. đúng 1.000 dòng: không mất dòng cuối", async () => {
  const { loader, calls } = arrayLoader(numRows(1000));
  const r = await paginateAll(loader);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1000);
  assert.equal(r.rows[999].n, 999);
  assert.equal(calls.length, 1);
});

test("3. 1.001 dòng: phải lấy page tiếp theo", async () => {
  const { loader, calls } = arrayLoader(numRows(1001));
  const r = await paginateAll(loader);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1001);
  assert.equal(r.rows[1000].n, 1000);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [[0, 999], [1000, 1999]]);
});

test("4. 2.501 dòng giả lập: tổng và bucket đầy đủ", async () => {
  const srcA = { id: "11111111-1111-4111-8111-111111111111", drive_file_id: "A", active: true, is_test: false, latest_run_status: "succeeded", last_successful_sync_at: "2026-10-01T00:00:00Z", last_seen_at: null };
  const srcB = { id: "22222222-2222-4222-8222-222222222222", drive_file_id: "B", active: true, is_test: false, latest_run_status: "succeeded", last_successful_sync_at: "2026-10-01T00:00:00Z", last_seen_at: null };
  const facts = [];
  for (let i = 0; i < 2501; i++) {
    facts.push({
      source_id: i % 2 === 0 ? srcA.id : srcB.id,
      business_date: "2026-10-01",
      project_key: "p" + (i % 5),
      project_display: "P" + (i % 5),
      recruiter_key: "r",
      recruiter_display: "R",
      provider_type_key: "hrp",
      provider_type_display: "HRP",
      employment_type_key: "thời vụ",
      employment_type_display: "Thời vụ",
      recruited_count: 1,
    });
  }
  const { loader, calls } = arrayLoader(facts);
  const r = await paginateAll(loader);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 2501);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);

  const data = computeReporting([srcA, srcB], r.rows, {}, new Set([srcA.id, srcB.id]));
  assert.equal(data.recruitedTotal, 2501);
  const bucketSum = Object.values(data.byProject).reduce((a, b) => a + b.recruitedCount, 0);
  assert.equal(bucketSum, 2501);
  assert.equal(Object.keys(data.byProject).length, 5);
});

test("5. order ổn định đúng khóa chính, range liên tục không trùng/lệch", async () => {
  assert.deepEqual([...REPORTING_FACT_ORDER], [
    "source_id", "business_date", "project_key", "recruiter_key", "provider_type_key", "employment_type_key",
  ]);
  const { loader, calls } = arrayLoader(numRows(2501));
  await paginateAll(loader);
  // Helper chỉ thay đổi range; order/filter nằm ở query builder (áp dụng MỘT lần).
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test("6. filter giữ nguyên ở mọi page (chỉ range thay đổi)", () => {
  const ids = new Set(["a", "b"]);
  const plan = buildReportingFactQuery({ from: "2026-10-01", project: "x", provider: "hrp", source: "a" }, ids);
  assert.equal(plan.skip, false);
  // Cùng một plan => server áp dụng cùng filter cho mọi page; helper chỉ đổi range.
  assert.equal(plan.query.source, "a");
  assert.equal(plan.query.from, "2026-10-01");
  assert.equal(plan.query.project, "x");
  assert.equal(plan.query.provider, "hrp");
  assert.deepEqual(plan.query.scopeIds, ["a", "b"]);
});

test("7. page thứ hai lỗi => toàn request lỗi (không partial)", async () => {
  const { loader } = arrayLoader(numRows(2001), { failAt: 1 });
  const r = await paginateAll(loader);
  assert.equal(r.ok, false);
  assert.equal(r.code, REPORTING_PAGINATION_FAILED_CODE);
  assert.ok(!("rows" in r));
});

test("8. exact count không khớp số dòng => lỗi", async () => {
  const mismatch = await paginateAll(arrayLoader(numRows(1000), { countOverride: 999 }).loader);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, REPORTING_COUNT_MISMATCH_CODE);

  const missing = await paginateAll(arrayLoader(numRows(10), { countOverride: null }).loader);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, REPORTING_COUNT_MISMATCH_CODE);
});

test("9. scope rỗng => skip, không query presence/facts", () => {
  assert.equal(buildReportingFactQuery({}, new Set()).skip, true);
  assert.deepEqual(buildReportingFactQuery({}, new Set()).query.scopeIds, []);
});

test("10. hard ceiling: vượt maxRows => REPORTING_RESULT_TOO_LARGE (không truncate)", async () => {
  const r = await paginateAll(arrayLoader(numRows(2501)).loader, { maxRows: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, REPORTING_RESULT_TOO_LARGE_CODE);
});
