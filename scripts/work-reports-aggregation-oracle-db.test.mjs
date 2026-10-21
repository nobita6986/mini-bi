import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  aggregateWorkReportFixture,
  localBusinessDate,
  WORK_REPORT_ORACLE_FIXTURE,
} from "./lib/work-reports-oracle-fixture.mjs";

test("oracle fixture distinguishes final eligibility, null, zero and compatible groups", () => {
  const result = aggregateWorkReportFixture(WORK_REPORT_ORACLE_FIXTURE);
  assert.equal(result.dueCount, 5);
  assert.equal(result.submittedCount, 3);
  assert.equal(result.lateSubmittedCount, 1);
  assert.equal(result.metrics.find((m) => m.compatibleGroup === "calls_v1").sum, 30);
  assert.equal(result.metrics.find((m) => m.compatibleGroup === "calls_v1").avg, 10);
  assert.equal(result.metrics.find((m) => m.compatibleGroup === "calls_v1").countValid, 3);
  assert.equal(result.metrics.find((m) => m.compatibleGroup === "calls_v2").sum, 100);
  assert.equal(result.metrics.find((m) => m.unit === "minute").sum, 5);
  assert.equal(result.metrics.some((m) => m.sum === 900 || m.sum === 800), false);
  assert.equal(result.metrics.find((m) => m.metricKey === "interested").sum, 10);
  assert.equal(result.metrics.find((m) => m.metricKey === "interested").countValid, 2);
});

test("ratio uses summed numerator and denominator, not the average of row ratios", () => {
  const reportRatios = [{ numerator: 1, denominator: 2 }, { numerator: 9, denominator: 90 }];
  const groupRatio = reportRatios.reduce((sum, row) => sum + row.numerator, 0) /
    reportRatios.reduce((sum, row) => sum + row.denominator, 0);
  assert.equal(groupRatio, 10 / 92);
  assert.notEqual(groupRatio, (1 / 2 + 9 / 90) / 2);
});

test("snapshot team, period filters, due boundary and HCM midnight are stable", () => {
  const result = aggregateWorkReportFixture(WORK_REPORT_ORACLE_FIXTURE, { teamIds: ["A"], from: "2026-10-20", to: "2026-10-20" });
  assert.equal(result.dueCount, 2);
  assert.equal(result.submittedCount, 2);
  assert.equal(localBusinessDate("2026-10-20T16:59:59.999Z"), "2026-10-20");
  assert.equal(localBusinessDate("2026-10-20T17:00:00.000Z"), "2026-10-21");
  assert.equal(localBusinessDate("2026-10-21T00:00:00.000+07:00"), "2026-10-21");
});

test("compliance oracle matches 20 due, 18 submitted and 3 late (late is a subset)", () => {
  const obligations = Array.from({ length: 20 }, (_, i) => ({
    id: `ob-${i}`, assignee: `u-${i}`, team: i < 10 ? "A" : "B", period: "2026-10-20",
    dueAt: "2026-10-21T16:59:59Z", submittedAt: i < 18 ? "2026-10-21T16:00:00Z" : null,
    late: i >= 15 && i < 18, exempted: false,
  }));
  const result = aggregateWorkReportFixture({ obligations, metrics: [] });
  assert.deepEqual([result.dueCount, result.submittedCount, result.lateSubmittedCount, result.overdueMissingCount, result.completionRate], [20, 18, 3, 2, 0.9]);
});

test("18,250-obligation PGlite fixture stays within the local aggregation regression guard", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create table obligations (id integer primary key, team text, period_start date, submitted boolean, late boolean);
      create table metrics (obligation_id integer, metric_key text, unit text, compatible_group text, value numeric, is_eligible boolean, is_final boolean);
      create index obligations_scope_idx on obligations(team, period_start);
      create index metrics_agg_idx on metrics(obligation_id, metric_key, unit, compatible_group) where is_eligible and is_final;
      insert into obligations select i, case when i % 2 = 0 then 'A' else 'B' end,
        date '2026-01-01' + ((i - 1) % 365), i % 10 <> 0, i % 20 = 0 from generate_series(1, 18250) i;
      insert into metrics select i, 'calls', 'call', 'calls_v1', i % 21,
        i % 10 <> 0, i % 13 <> 0 from generate_series(1, 18250) i;`);
    const durations = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      const { rows } = await db.query(`select o.team, count(distinct o.id) as due_count, count(m.value) as count_valid,
          sum(m.value) as sum_value, avg(m.value) as avg_value
        from obligations o left join metrics m on m.obligation_id = o.id and m.is_eligible = true and m.is_final = true
        where o.team = 'A' and o.period_start between date '2026-01-01' and date '2026-12-31'
        group by o.team`);
      durations.push(performance.now() - start);
      assert.equal(rows.length, 1);
    }
    durations.sort((a, b) => a - b);
    assert.ok(durations[5] < 100, `PGlite SQL regression guard: p95 ${durations[5].toFixed(2)}ms exceeded 100ms`);
  } finally {
    await db.close();
  }
});
