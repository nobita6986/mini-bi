import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { P2_W04A_DIRECT_ENTRY_SOURCE_ID } from "./p2-w04a-cutover.ts";
import {
  ITEM_1_6_WORKER_STATUS_AUDIT,
  WORKER_STATUS_CURRENT_SNAPSHOT_NOTE,
  WORKER_STATUS_FROZEN_LABELS,
  buildPeriodComparisonResult,
  computePeriodComparisonMetrics,
  derivePriorPeriodWindow,
  formatPeriodComparisonSummary,
  resolvePriorPeriodComparisonForActor,
} from "./p1-period-comparison.ts";

const HERE = new URL("./", import.meta.url);

test("Wave 3 (1.5): derivePriorPeriodWindow handles all_time, one-sided, and invalid date ranges", () => {
  const allTime = derivePriorPeriodWindow({});
  assert.equal(allTime.applicable, false);
  if (!allTime.applicable) {
    assert.equal(allTime.reason, "all_time");
    assert.equal(allTime.currentFrom, null);
    assert.equal(allTime.currentTo, null);
  }

  const fromOnly = derivePriorPeriodWindow({ from: "2026-10-01" });
  assert.equal(fromOnly.applicable, false);
  if (!fromOnly.applicable) {
    assert.equal(fromOnly.reason, "one_sided");
  }

  const toOnly = derivePriorPeriodWindow({ to: "2026-10-15" });
  assert.equal(toOnly.applicable, false);
  if (!toOnly.applicable) {
    assert.equal(toOnly.reason, "one_sided");
  }

  const reversed = derivePriorPeriodWindow({ from: "2026-10-15", to: "2026-10-01" });
  assert.equal(reversed.applicable, false);
  if (!reversed.applicable) {
    assert.equal(reversed.reason, "invalid_range");
  }
});

test("Wave 3 (1.5): derivePriorPeriodWindow handles presets (this-week, this-month, this-quarter) with same elapsed days", () => {
  // Reference date: Wednesday 2026-10-21 in Asia/Ho_Chi_Minh
  const ref = new Date("2026-10-21T03:00:00Z");

  // this-week: Mon 2026-10-19 .. Wed 2026-10-21 (3 days) -> Mon 2026-10-12 .. Wed 2026-10-14 (3 days)
  const thisWeek = derivePriorPeriodWindow(
    { from: "2026-10-19", to: "2026-10-21", project: "proj_a" },
    ref,
  );
  assert.equal(thisWeek.applicable, true);
  if (thisWeek.applicable) {
    assert.equal(thisWeek.mode, "this-week");
    assert.equal(thisWeek.dayCount, 3);
    assert.equal(thisWeek.previousFrom, "2026-10-12");
    assert.equal(thisWeek.previousTo, "2026-10-14");
    assert.equal(thisWeek.previousDayCount, 3);
    assert.deepEqual(thisWeek.previousFilters, {
      from: "2026-10-12",
      to: "2026-10-14",
      project: "proj_a",
    });
  }

  // this-month: 2026-10-01 .. 2026-10-21 (21 days) -> 2026-09-01 .. 2026-09-21 (21 days)
  const thisMonth = derivePriorPeriodWindow(
    { from: "2026-10-01", to: "2026-10-21", provider: "hrp" },
    ref,
  );
  assert.equal(thisMonth.applicable, true);
  if (thisMonth.applicable) {
    assert.equal(thisMonth.mode, "this-month");
    assert.equal(thisMonth.dayCount, 21);
    assert.equal(thisMonth.previousFrom, "2026-09-01");
    assert.equal(thisMonth.previousTo, "2026-09-21");
    assert.equal(thisMonth.previousDayCount, 21);
    assert.equal(thisMonth.previousFilters.provider, "hrp");
  }

  // this-quarter: Q4 2026-10-01 .. 2026-10-21 (21 days) -> Q3 2026-07-01 .. 2026-07-21 (21 days)
  // Note: when 2026-10-01 is both start of month and start of quarter, matchDatePreset matches this-month first;
  // test Q2 2026-04-01 .. 2026-05-10 (40 days into Q2) at ref 2026-05-10 -> Q1 2026-01-01 .. 2026-02-09 (40 days)
  const refQ2 = new Date("2026-05-10T03:00:00Z");
  const thisQuarter = derivePriorPeriodWindow(
    { from: "2026-04-01", to: "2026-05-10" },
    refQ2,
  );
  assert.equal(thisQuarter.applicable, true);
  if (thisQuarter.applicable) {
    assert.equal(thisQuarter.mode, "this-quarter");
    assert.equal(thisQuarter.dayCount, 40);
    assert.equal(thisQuarter.previousFrom, "2026-01-01");
    assert.equal(thisQuarter.previousTo, "2026-02-09");
    assert.equal(thisQuarter.previousDayCount, 40);
  }
});

test("Wave 3 (1.5): derivePriorPeriodWindow handles February, leap years, and year crossings", () => {
  // Non-leap year: March 31, 2026 this-month (31 days) -> clamped to Feb 1..28, 2026 (28 days)
  const refMar2026 = new Date("2026-03-31T05:00:00Z");
  const mar2026 = derivePriorPeriodWindow(
    { from: "2026-03-01", to: "2026-03-31" },
    refMar2026,
  );
  assert.equal(mar2026.applicable, true);
  if (mar2026.applicable) {
    assert.equal(mar2026.mode, "this-month");
    assert.equal(mar2026.previousFrom, "2026-02-01");
    assert.equal(mar2026.previousTo, "2026-02-28");
    assert.equal(mar2026.previousDayCount, 28);
  }

  // Leap year: March 30, 2024 this-month (30 days) -> clamped to Feb 1..29, 2024 (29 days)
  const refMar2024 = new Date("2024-03-30T05:00:00Z");
  const mar2024 = derivePriorPeriodWindow(
    { from: "2024-03-01", to: "2024-03-30" },
    refMar2024,
  );
  assert.equal(mar2024.applicable, true);
  if (mar2024.applicable) {
    assert.equal(mar2024.mode, "this-month");
    assert.equal(mar2024.previousFrom, "2024-02-01");
    assert.equal(mar2024.previousTo, "2024-02-29");
    assert.equal(mar2024.previousDayCount, 29);
  }

  // Year crossing in this-month: Jan 1..15, 2026 -> Dec 1..15, 2025
  const refJan2026 = new Date("2026-01-15T05:00:00Z");
  const jan2026 = derivePriorPeriodWindow(
    { from: "2026-01-01", to: "2026-01-15" },
    refJan2026,
  );
  assert.equal(jan2026.applicable, true);
  if (jan2026.applicable) {
    assert.equal(jan2026.mode, "this-month");
    assert.equal(jan2026.previousFrom, "2025-12-01");
    assert.equal(jan2026.previousTo, "2025-12-15");
  }

  // Custom finite range crossing year boundary: 2026-01-01 .. 2026-01-05 (5 days) -> 2025-12-27 .. 2025-12-31
  const customYearCross = derivePriorPeriodWindow(
    { from: "2026-01-01", to: "2026-01-05" },
    new Date("2026-10-21T05:00:00Z"),
  );
  assert.equal(customYearCross.applicable, true);
  if (customYearCross.applicable) {
    assert.equal(customYearCross.mode, "contiguous");
    assert.equal(customYearCross.dayCount, 5);
    assert.equal(customYearCross.previousFrom, "2025-12-27");
    assert.equal(customYearCross.previousTo, "2025-12-31");
  }
});

test("Wave 3 (1.5): computePeriodComparisonMetrics and formatPeriodComparisonSummary handle zero prior total safely", () => {
  const zeroPrior = computePeriodComparisonMetrics(12, 0);
  assert.equal(zeroPrior.currentTotal, 12);
  assert.equal(zeroPrior.previousTotal, 0);
  assert.equal(zeroPrior.deltaAbs, 12);
  assert.equal(zeroPrior.deltaPct, null, "previousTotal = 0 must return null deltaPct, never Infinity/NaN/0%");
  assert.equal(zeroPrior.direction, "up");

  const bothZero = computePeriodComparisonMetrics(0, 0);
  assert.equal(bothZero.deltaAbs, 0);
  assert.equal(bothZero.deltaPct, null);
  assert.equal(bothZero.direction, "flat");

  const up = computePeriodComparisonMetrics(15, 10);
  assert.equal(up.deltaAbs, 5);
  assert.equal(up.deltaPct, 50);
  assert.equal(up.direction, "up");

  const down = computePeriodComparisonMetrics(6, 10);
  assert.equal(down.deltaAbs, -4);
  assert.equal(down.deltaPct, -40);
  assert.equal(down.direction, "down");

  const window = derivePriorPeriodWindow({ from: "2026-10-10", to: "2026-10-15" });
  assert.equal(window.applicable, true);
  if (window.applicable) {
    const zeroResult = buildPeriodComparisonResult({
      window,
      currentTotal: 8,
      previousTotal: 0,
    });
    const formatted = formatPeriodComparisonSummary(zeroResult);
    assert.equal(formatted.badgeLabel, "Tăng so với kỳ trước");
    assert.equal(formatted.badgeTone, "success");
    assert.match(formatted.deltaText, /\+8 lượt \(kỳ trước: 0 — không tính %\)/);
  }
});

test("Wave 3 (1.5): resolvePriorPeriodComparisonForActor enforces actor/filter parity and isolates RPC errors", async () => {
  const actor = {
    auth_subject: "00000000-0000-4000-8000-000000000032",
    app_user_id: "00000000-0000-4000-8000-000000000042",
  };
  const filters = {
    from: "2026-10-11",
    to: "2026-10-15",
    project: "proj_a",
    recruiter: "rec a1",
    provider: "hrp",
    employment: "thời vụ",
    source: "11111111-1111-4111-8111-111111111111",
  };

  const capturedCalls = [];
  const comparison = await resolvePriorPeriodComparisonForActor({
    actor,
    filters,
    currentTotal: 5,
    expectedAudienceKind: "team",
    referenceDate: new Date("2026-10-21T03:00:00Z"),
    callScopedFactsRpc: async (args) => {
      capturedCalls.push(args);
      return {
        data: {
          audience: { audience: "team", label: "Team A", team_ids: ["t1"] },
          facts: [
            {
              source_id: P2_W04A_DIRECT_ENTRY_SOURCE_ID,
              business_date: "2026-10-08",
              project_key: "proj_a",
              project_display: "Project A",
              recruiter_key: "rec a1",
              recruiter_display: "Recruiter A1",
              provider_type_key: "hrp",
              provider_type_display: "HRP",
              employment_type_key: "thời vụ",
              employment_type_display: "Thời vụ",
              recruited_count: 2,
            },
          ],
        },
        error: null,
      };
    },
  });

  assert.equal(capturedCalls.length, 1);
  assert.equal(capturedCalls[0].p_auth_subject, actor.auth_subject);
  assert.equal(capturedCalls[0].p_app_user_id, actor.app_user_id);
  assert.deepEqual(capturedCalls[0].p_filters, {
    from: "2026-10-06",
    to: "2026-10-10",
    project: "proj_a",
    recruiter: "rec a1",
    provider: "hrp",
    employment: "thời vụ",
  });
  assert.equal("source" in capturedCalls[0].p_filters, false, "source must never be forwarded");

  assert.equal(comparison.status, "ready");
  if (comparison.status === "ready") {
    assert.equal(comparison.currentTotal, 5);
    assert.equal(comparison.previousTotal, 2);
    assert.equal(comparison.deltaAbs, 3);
    assert.equal(comparison.deltaPct, 150);
  }

  // Error isolation: RPC error or exception returns status: "unavailable" without throwing
  const onError = await resolvePriorPeriodComparisonForActor({
    actor,
    filters,
    currentTotal: 5,
    expectedAudienceKind: "team",
    callScopedFactsRpc: async () => ({ data: null, error: { code: "57014", message: "timeout" } }),
  });
  assert.equal(onError.status, "unavailable");
  assert.equal(onError.currentTotal, 5);

  const onThrow = await resolvePriorPeriodComparisonForActor({
    actor,
    filters,
    currentTotal: 5,
    expectedAudienceKind: "team",
    callScopedFactsRpc: async () => {
      throw new Error("network failure");
    },
  });
  assert.equal(onThrow.status, "unavailable");
  assert.equal(onThrow.currentTotal, 5);

  // Audience mismatch isolation: if comparison RPC returns a different audience kind, fail closed to unavailable
  const onAudienceMismatch = await resolvePriorPeriodComparisonForActor({
    actor,
    filters,
    currentTotal: 5,
    expectedAudienceKind: "own",
    callScopedFactsRpc: async () => ({
      data: { audience: { audience: "all", label: "Toàn công ty" }, facts: [] },
      error: null,
    }),
  });
  assert.equal(onAudienceMismatch.status, "unavailable");

  // All-time does not invoke the RPC at all
  let rpcCalledOnAllTime = false;
  const allTimeComparison = await resolvePriorPeriodComparisonForActor({
    actor,
    filters: {},
    currentTotal: 20,
    callScopedFactsRpc: async () => {
      rpcCalledOnAllTime = true;
      return { data: null, error: null };
    },
  });
  assert.equal(rpcCalledOnAllTime, false);
  assert.equal(allTimeComparison.status, "not_applicable");
});

test("Wave 3 (1.6): frozen worker status vocabulary and code-evidenced No-go audit record", () => {
  assert.equal(WORKER_STATUS_FROZEN_LABELS.ON, "Đang làm");
  assert.equal(WORKER_STATUS_FROZEN_LABELS.UNCONFIRMED, "Đang chờ việc");
  assert.equal(WORKER_STATUS_FROZEN_LABELS.OFF, "Đã nghỉ");
  assert.notEqual(WORKER_STATUS_FROZEN_LABELS.UNCONFIRMED, "Chưa xác nhận");
  assert.match(WORKER_STATUS_CURRENT_SNAPSHOT_NOTE, /không áp dụng khoảng ngày tuyển/);

  assert.equal(ITEM_1_6_WORKER_STATUS_AUDIT.decision, "NO_GO_DEFER_PHASE_2");
  assert.equal(ITEM_1_6_WORKER_STATUS_AUDIT.evaluatedRpc, "public.direct_entry_list_workers");
  const codes = ITEM_1_6_WORKER_STATUS_AUDIT.reasons.map((r) => r.code);
  assert.deepEqual(codes, [
    "AUDIENCE_ALL_MISMATCH",
    "AUDIENCE_TEAM_MISMATCH",
    "AUDIENCE_OWN_MISMATCH",
    "FILTER_CONTRACT_INCOMPATIBLE",
    "NO_AGGREGATE_ONLY_MODE_AND_PII_PROJECTION",
  ]);
});

test("Wave 3 (1.5): dashboard server and all 3 audience views wire prior-period comparison", () => {
  const server = readFileSync(new URL("./p2-w04a-reporting-server.ts", HERE), "utf8");
  const shared = readFileSync(new URL("../../components/dashboard/dashboard-shared.tsx", HERE), "utf8");
  const bodView = readFileSync(new URL("../../components/dashboard/dashboard-view.tsx", HERE), "utf8");
  const teamView = readFileSync(new URL("../../components/dashboard/team-dashboard-view.tsx", HERE), "utf8");
  const teamReport = readFileSync(new URL("../../components/dashboard/team-report-view.tsx", HERE), "utf8");
  const ownView = readFileSync(new URL("../../components/dashboard/own-dashboard-view.tsx", HERE), "utf8");

  assert.match(server, /resolvePriorPeriodComparisonForActor\(/);
  assert.match(shared, /export function PeriodComparisonBanner/);
  assert.match(shared, /StatusBadge/);
  assert.match(bodView, /<PeriodComparisonBanner comparison=\{comparison\} \/>/);
  assert.match(teamView, /comparison=\{comparison\}/);
  assert.match(teamReport, /<PeriodComparisonBanner comparison=\{comparison\} \/>/);
  assert.match(ownView, /<PeriodComparisonBanner comparison=\{comparison\} \/>/);
});
