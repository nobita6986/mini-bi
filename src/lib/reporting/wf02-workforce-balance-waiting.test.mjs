import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  diffYmdDays,
  evaluateWorkforceSnapshotAndTransitions,
  formatPlacementRatePercent,
  formatSignedBalanceDelta,
  formatWaitingDaysAverage,
  formatWorkforceBalanceNotApplicableLabel,
  parseWorkforceReportingPayload,
  shiftYmdDays,
  WORKFORCE_BALANCE_COLUMN_LABELS,
  WORKFORCE_NON_ATTENDANCE_NOTE,
  WORKFORCE_WAITING_SAMPLE_LABELS,
} from "./wf02-workforce-balance-waiting.ts";

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

test("WF-02 (1): 2.3 Period balance satisfies exact conservation equation for every status (ON, UNCONFIRMED, OFF, UNKNOWN)", () => {
  const episodes = [
    // Pre-period episodes (first_work_date < 2026-10-01 => in opening snapshot at 2026-09-30):
    { entry_id: uuid(1), first_work_date: "2026-09-20" }, // ON at 09-30 -> OFF on 10-05 -> ON on 10-12
    { entry_id: uuid(2), first_work_date: "2026-09-25" }, // UNCONFIRMED at 09-30 -> ON on 10-03
    { entry_id: uuid(3), first_work_date: "2026-09-28" }, // UNKNOWN at 09-30 (no event <= 09-30) -> ON on 10-04
    // In-period new episodes (2026-10-01 <= first_work_date <= 2026-10-15):
    { entry_id: uuid(4), first_work_date: "2026-10-02" }, // New UNCONFIRMED (10-02) -> ON (10-06) -> OFF (10-14)
    { entry_id: uuid(5), first_work_date: "2026-10-03" }, // New UNCONFIRMED (10-03) -> OFF (10-09)
    { entry_id: uuid(6), first_work_date: "2026-10-05" }, // New ON (10-05), stays ON
    { entry_id: uuid(7), first_work_date: "2026-10-07" }, // New UNCONFIRMED (10-07), stays UNCONFIRMED
    { entry_id: uuid(8), first_work_date: "2026-10-08" }, // New episode with no status event -> UNKNOWN
    // Future episode (first_work_date > 2026-10-15):
    { entry_id: uuid(9), first_work_date: "2026-10-20" },
  ];

  const events = [
    // Ep 1: ON (09-20) -> OFF (10-05) -> ON (10-12)
    { event_id: uuid(101), entry_id: uuid(1), status: "ON", effective_date: "2026-09-20", version: 1 },
    { event_id: uuid(102), entry_id: uuid(1), status: "OFF", effective_date: "2026-10-05", version: 2 },
    { event_id: uuid(103), entry_id: uuid(1), status: "ON", effective_date: "2026-10-12", version: 3 },
    // Ep 2: UNCONFIRMED (09-25) -> ON (10-03)
    { event_id: uuid(201), entry_id: uuid(2), status: "UNCONFIRMED", effective_date: "2026-09-25", version: 1 },
    { event_id: uuid(202), entry_id: uuid(2), status: "ON", effective_date: "2026-10-03", version: 2 },
    // Ep 3: first event on 10-04 (ON) -> transitions UNKNOWN -> ON in period
    { event_id: uuid(301), entry_id: uuid(3), status: "ON", effective_date: "2026-10-04", version: 1 },
    // Ep 4: UNCONFIRMED (10-02) -> ON (10-06) -> OFF (10-14)
    { event_id: uuid(401), entry_id: uuid(4), status: "UNCONFIRMED", effective_date: "2026-10-02", version: 1 },
    { event_id: uuid(402), entry_id: uuid(4), status: "ON", effective_date: "2026-10-06", version: 2 },
    { event_id: uuid(403), entry_id: uuid(4), status: "OFF", effective_date: "2026-10-14", version: 3 },
    // Ep 5: UNCONFIRMED (10-03) -> OFF (10-09)
    { event_id: uuid(501), entry_id: uuid(5), status: "UNCONFIRMED", effective_date: "2026-10-03", version: 1 },
    { event_id: uuid(502), entry_id: uuid(5), status: "OFF", effective_date: "2026-10-09", version: 2 },
    // Ep 6: ON (10-05)
    { event_id: uuid(601), entry_id: uuid(6), status: "ON", effective_date: "2026-10-05", version: 1 },
    // Ep 7: UNCONFIRMED (10-07)
    { event_id: uuid(701), entry_id: uuid(7), status: "UNCONFIRMED", effective_date: "2026-10-07", version: 1 },
  ];

  const res = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });

  assert.equal(res.balance.applicable, true);
  if (!res.balance.applicable) return;

  assert.equal(res.balance.openingAsOfDate, "2026-09-30");
  assert.equal(res.balance.closingAsOfDate, "2026-10-15");

  // Opening snapshot at 2026-09-30: Ep 1 (ON), Ep 2 (UNCONFIRMED), Ep 3 (UNKNOWN) => total 3
  assert.equal(res.balance.openingSnapshot.eligibleEpisodeTotal, 3);
  assert.equal(res.balance.openingSnapshot.onCount, 1);
  assert.equal(res.balance.openingSnapshot.unconfirmedCount, 1);
  assert.equal(res.balance.openingSnapshot.offCount, 0);
  assert.equal(res.balance.openingSnapshot.unknownCount, 1);

  // New episodes in period [10-01..10-15]: Ep 4,5,7 (UNCONFIRMED=3), Ep 6 (ON=1), Ep 8 (UNKNOWN=1) => total 5
  assert.deepEqual(res.balance.newEpisodesInPeriod, {
    total: 5,
    initialOn: 1,
    initialUnconfirmed: 3,
    initialOff: 0,
    initialUnknown: 1,
  });

  // Verify conservation equation on every status row:
  for (const [key, row] of Object.entries(res.balance.byStatus)) {
    assert.equal(
      row.openingCount + row.newEpisodeInflowCount + row.transitionInflowCount - row.outflowCount,
      row.closingCount,
      `Conservation failed for status ${key}`,
    );
    assert.equal(row.newEpisodeInflowCount + row.transitionInflowCount, row.totalInflowCount);
    assert.equal(row.totalInflowCount - row.outflowCount, row.netChange);
  }

  // ON: opening=1 (Ep1), new=1 (Ep6), transIn=4 (Ep2 UNC->ON, Ep3 UNK->ON, Ep4 UNC->ON, Ep1 OFF->ON),
  //     outflow=2 (Ep1 ON->OFF, Ep4 ON->OFF) => closing = 1 + 1 + 4 - 2 = 4 (Ep1, Ep2, Ep3, Ep6)
  assert.equal(res.balance.byStatus.on.openingCount, 1);
  assert.equal(res.balance.byStatus.on.newEpisodeInflowCount, 1);
  assert.equal(res.balance.byStatus.on.transitionInflowCount, 4);
  assert.deepEqual(res.balance.byStatus.on.transitionInflowBySource, {
    fromOn: 0,
    fromUnconfirmed: 2,
    fromOff: 1,
    fromUnknown: 1,
  });
  assert.equal(res.balance.byStatus.on.outflowCount, 2);
  assert.equal(res.balance.byStatus.on.netChange, 3);
  assert.equal(res.balance.byStatus.on.closingCount, 4);

  // UNCONFIRMED: opening=1 (Ep2), new=3 (Ep4,Ep5,Ep7), transIn=0, outflow=3 (Ep2->ON, Ep4->ON, Ep5->OFF) => closing=1 (Ep7)
  assert.equal(res.balance.byStatus.unconfirmed.openingCount, 1);
  assert.equal(res.balance.byStatus.unconfirmed.newEpisodeInflowCount, 3);
  assert.equal(res.balance.byStatus.unconfirmed.transitionInflowCount, 0);
  assert.equal(res.balance.byStatus.unconfirmed.outflowCount, 3);
  assert.equal(res.balance.byStatus.unconfirmed.closingCount, 1);

  // OFF: opening=0, new=0, transIn=3 (Ep1 ON->OFF, Ep4 ON->OFF, Ep5 UNC->OFF), outflow=1 (Ep1 OFF->ON) => closing=2 (Ep4, Ep5)
  assert.equal(res.balance.byStatus.off.openingCount, 0);
  assert.equal(res.balance.byStatus.off.newEpisodeInflowCount, 0);
  assert.equal(res.balance.byStatus.off.transitionInflowCount, 3);
  assert.equal(res.balance.byStatus.off.outflowCount, 1);
  assert.equal(res.balance.byStatus.off.closingCount, 2);

  // UNKNOWN: opening=1 (Ep3), new=1 (Ep8), transIn=0, outflow=1 (Ep3 UNK->ON) => closing=1 (Ep8)
  assert.equal(res.balance.byStatus.unknown.openingCount, 1);
  assert.equal(res.balance.byStatus.unknown.newEpisodeInflowCount, 1);
  assert.equal(res.balance.byStatus.unknown.transitionInflowCount, 0);
  assert.equal(res.balance.byStatus.unknown.outflowCount, 1);
  assert.equal(res.balance.byStatus.unknown.closingCount, 1);

  // Totals: opening=3 + new=5 = closing=8, transitionInflowTotal=7 === transitionOutflowTotal=7
  assert.deepEqual(res.balance.totals, {
    openingEligibleTotal: 3,
    newEpisodeTotal: 5,
    transitionInflowTotal: 7,
    transitionOutflowTotal: 7,
    netEligibleChange: 5,
    closingEligibleTotal: 8,
  });
});

test("WF-02 (2): 2.3 Balance ignores superseded events and no-op repeat events, and reconciles same-day transitions", () => {
  const episodes = [{ entry_id: uuid(1), first_work_date: "2026-10-01" }];
  const events = [
    // v1: UNCONFIRMED on 10-01
    { event_id: uuid(1), entry_id: uuid(1), status: "UNCONFIRMED", effective_date: "2026-10-01", version: 1 },
    // v2: OFF on 10-01 (superseded by v3)
    { event_id: uuid(2), entry_id: uuid(1), status: "OFF", effective_date: "2026-10-01", version: 2 },
    // v3: UNCONFIRMED on 10-01 (supersedes v2 -> becomes no-op repeat after v1!)
    { event_id: uuid(3), entry_id: uuid(1), status: "UNCONFIRMED", effective_date: "2026-10-01", version: 3, supersedes_event_id: uuid(2) },
    // v4: ON on 10-01 (same-day placement UNCONFIRMED -> ON)
    { event_id: uuid(4), entry_id: uuid(1), status: "ON", effective_date: "2026-10-01", version: 4 },
  ];

  const res = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-05" },
  });

  assert.equal(res.balance.applicable, true);
  if (res.balance.applicable) {
    assert.equal(res.balance.byStatus.unconfirmed.newEpisodeInflowCount, 1);
    assert.equal(res.balance.byStatus.unconfirmed.outflowCount, 1);
    assert.equal(res.balance.byStatus.unconfirmed.closingCount, 0);
    assert.equal(res.balance.byStatus.on.newEpisodeInflowCount, 0);
    assert.equal(res.balance.byStatus.on.transitionInflowCount, 1);
    assert.equal(res.balance.byStatus.on.closingCount, 1);
    assert.equal(res.balance.byStatus.off.transitionInflowCount, 0);
  }
  assert.equal(res.waiting.placedToOn.episodeCount, 1);
  assert.equal(res.waiting.placedToOn.totalWaitingDays, 0);
  assert.equal(res.waiting.placedToOn.avgWaitingDaysPerEpisode, 0);
});

test("WF-02 (3 & 4): 2.4 Waiting duration in contiguous UNCONFIRMED intervals, sample denominators, placement rates, and period waiting", () => {
  const episodes = [
    // Ep 1: UNCONFIRMED (09-25) -> no-op repeat UNCONFIRMED (09-28) -> ON (10-05) -> OFF (10-12)
    //       Waiting interval is [09-25 .. 10-05] = 10 days (1 contiguous interval), placedToOn = true.
    //       Note: naive (as_of 10-15 - first_work_date 09-25) would be 20 days — must be 10 days!
    { entry_id: uuid(1), first_work_date: "2026-09-25" },
    // Ep 2: UNCONFIRMED (10-01) -> ON (10-04) => 3 days waiting, placedToOn = true.
    { entry_id: uuid(2), first_work_date: "2026-10-01" },
    // Ep 3: UNCONFIRMED (10-02) -> OFF (10-08) => 6 days waiting, exitedWithoutOn = true.
    { entry_id: uuid(3), first_work_date: "2026-10-02" },
    // Ep 4: UNCONFIRMED (10-10) -> still UNCONFIRMED at 10-15 => 5 days waiting, currentlyWaiting = true.
    { entry_id: uuid(4), first_work_date: "2026-10-10" },
    // Ep 5: Direct ON (10-03) -> never UNCONFIRMED => directOnEpisodeCount = 1.
    { entry_id: uuid(5), first_work_date: "2026-10-03" },
  ];

  const events = [
    { event_id: uuid(101), entry_id: uuid(1), status: "UNCONFIRMED", effective_date: "2026-09-25", version: 1 },
    { event_id: uuid(102), entry_id: uuid(1), status: "UNCONFIRMED", effective_date: "2026-09-28", version: 2 },
    { event_id: uuid(103), entry_id: uuid(1), status: "ON", effective_date: "2026-10-05", version: 3 },
    { event_id: uuid(104), entry_id: uuid(1), status: "OFF", effective_date: "2026-10-12", version: 4 },

    { event_id: uuid(201), entry_id: uuid(2), status: "UNCONFIRMED", effective_date: "2026-10-01", version: 1 },
    { event_id: uuid(202), entry_id: uuid(2), status: "ON", effective_date: "2026-10-04", version: 2 },

    { event_id: uuid(301), entry_id: uuid(3), status: "UNCONFIRMED", effective_date: "2026-10-02", version: 1 },
    { event_id: uuid(302), entry_id: uuid(3), status: "OFF", effective_date: "2026-10-08", version: 2 },

    { event_id: uuid(401), entry_id: uuid(4), status: "UNCONFIRMED", effective_date: "2026-10-10", version: 1 },

    { event_id: uuid(501), entry_id: uuid(5), status: "ON", effective_date: "2026-10-03", version: 1 },
  ];

  const res = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });

  const w = res.waiting;
  assert.equal(w.asOfDate, "2026-10-15");
  assert.equal(w.eligibleEpisodeTotal, 5);
  assert.equal(w.waitingEpisodeTotal, 4); // Ep 1, 2, 3, 4
  assert.equal(w.directOnEpisodeCount, 1); // Ep 5
  assert.equal(w.directOffEpisodeCount, 0);
  assert.equal(w.unknownEpisodeCount, 0);

  // Sample 1: allWaiting (Ep 1: 10d, Ep 2: 3d, Ep 3: 6d, Ep 4: 5d => 4 episodes, 24 days, avg 6.0, max 10)
  assert.deepEqual(w.allWaiting, {
    episodeCount: 4,
    intervalCount: 4,
    totalWaitingDays: 24,
    avgWaitingDaysPerEpisode: 6,
    avgWaitingDaysPerInterval: 6,
    maxWaitingDays: 10,
  });

  // Sample 2: completedWaiting (Ep 1: 10d, Ep 2: 3d, Ep 3: 6d => 3 episodes, 19 days, avg 19/3, max 10)
  assert.equal(w.completedWaiting.episodeCount, 3);
  assert.equal(w.completedWaiting.totalWaitingDays, 19);
  assert.equal(w.completedWaiting.maxWaitingDays, 10);

  // Sample 3: placedToOn (Ep 1: 10d, Ep 2: 3d => 2 episodes, 13 days, avg 6.5, max 10)
  assert.deepEqual(w.placedToOn, {
    episodeCount: 2,
    intervalCount: 2,
    totalWaitingDays: 13,
    avgWaitingDaysPerEpisode: 6.5,
    avgWaitingDaysPerInterval: 6.5,
    maxWaitingDays: 10,
  });

  // Sample 4: exitedWithoutOn (Ep 3: 6d => 1 episode, 6 days, avg 6, max 6)
  assert.deepEqual(w.exitedWithoutOn, {
    episodeCount: 1,
    intervalCount: 1,
    totalWaitingDays: 6,
    avgWaitingDaysPerEpisode: 6,
    avgWaitingDaysPerInterval: 6,
    maxWaitingDays: 6,
  });

  // Sample 5: currentlyWaiting (Ep 4: 5d => 1 episode, 5 days, avg 5, max 5)
  assert.deepEqual(w.currentlyWaiting, {
    episodeCount: 1,
    intervalCount: 1,
    totalWaitingDays: 5,
    avgWaitingDaysPerEpisode: 5,
    avgWaitingDaysPerInterval: 5,
    maxWaitingDays: 5,
  });
  assert.equal(w.currentlyWaiting.episodeCount, res.snapshot.unconfirmedCount);

  // Placement rates:
  assert.equal(w.placementRateOfWaiting, 2 / 4); // 50%
  assert.equal(w.placementRateOfCompletedWaiting, 2 / 3); // 66.7%

  // Period waiting in [2026-10-01 .. 2026-10-15]:
  // Ep 1 clipped to [10-01 .. 10-05] = 4 days in period (full interval = 10 days, placed on 10-05).
  // Ep 2 [10-01 .. 10-04] = 3 days in period (placed on 10-04).
  // Ep 3 [10-02 .. 10-08] = 6 days in period (exited on 10-08).
  // Ep 4 [10-10 .. 10-15] = 5 days in period (still waiting).
  // Total inPeriodWaitingDays = 4 + 3 + 6 + 5 = 18 days across 4 active waiting episodes (avg 4.5 days).
  assert.equal(w.periodWaiting.applicable, true);
  if (w.periodWaiting.applicable) {
    assert.equal(w.periodWaiting.activeWaitingEpisodeCount, 4);
    assert.equal(w.periodWaiting.inPeriodWaitingDays, 18);
    assert.equal(w.periodWaiting.avgInPeriodWaitingDaysPerActiveEpisode, 4.5);
    assert.deepEqual(w.periodWaiting.placedInPeriod, {
      eventCount: 2,
      episodeCount: 2,
      totalWaitingDays: 13,
      avgWaitingDaysPerEvent: 6.5,
      avgWaitingDaysPerEpisode: 6.5,
    });
    assert.deepEqual(w.periodWaiting.exitedInPeriod, {
      eventCount: 1,
      episodeCount: 1,
      totalWaitingDays: 6,
      avgWaitingDaysPerEvent: 6,
      avgWaitingDaysPerEpisode: 6,
    });
  }
});

test("WF-02 (5): Fail-closed payload validation rejects broken balance conservation or waiting sample partition invariants", () => {
  const validRpcPayload = {
    snapshot: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      eligible_episode_total: 2,
      on_count: 1,
      unconfirmed_count: 1,
      off_count: 0,
      unknown_count: 0,
      future_episode_count: 0,
    },
    transitions: {
      applicable: true,
      from_date: "2026-10-01",
      to_date: "2026-10-15",
      initial: {
        total: { event_count: 2, episode_count: 2 },
        on: { event_count: 0, episode_count: 0 },
        unconfirmed: { event_count: 2, episode_count: 2 },
      },
      pairs: {
        unconfirmed_to_on: { event_count: 1, episode_count: 1 },
        unconfirmed_to_off: { event_count: 0, episode_count: 0 },
        on_to_off: { event_count: 0, episode_count: 0 },
        off_to_on: { event_count: 0, episode_count: 0 },
        other: { event_count: 0, episode_count: 0 },
      },
      totals: {
        transition_event_count: 1,
        transition_episode_count: 1,
        noop_repeat_event_count: 0,
        noop_repeat_episode_count: 0,
      },
    },
    balance: {
      applicable: true,
      from_date: "2026-10-01",
      to_date: "2026-10-15",
      opening_as_of_date: "2026-09-30",
      closing_as_of_date: "2026-10-15",
      opening_snapshot: {
        as_of_date: "2026-09-30",
        as_of_source: "explicit_as_of",
        eligible_episode_total: 0,
        on_count: 0,
        unconfirmed_count: 0,
        off_count: 0,
        unknown_count: 0,
        future_episode_count: 2,
      },
      closing_snapshot: {
        as_of_date: "2026-10-15",
        as_of_source: "filter_to",
        eligible_episode_total: 2,
        on_count: 1,
        unconfirmed_count: 1,
        off_count: 0,
        unknown_count: 0,
        future_episode_count: 0,
      },
      new_episodes_in_period: {
        total: 2,
        initial_on: 0,
        initial_unconfirmed: 2,
        initial_off: 0,
        initial_unknown: 0,
      },
      by_status: {
        on: {
          opening_count: 0,
          new_episode_inflow_count: 0,
          transition_inflow_count: 1,
          transition_inflow_by_source: { from_on: 0, from_unconfirmed: 1, from_off: 0, from_unknown: 0 },
          total_inflow_count: 1,
          outflow_count: 0,
          outflow_by_target: { to_on: 0, to_unconfirmed: 0, to_off: 0 },
          net_change: 1,
          closing_count: 1,
        },
        unconfirmed: {
          opening_count: 0,
          new_episode_inflow_count: 2,
          transition_inflow_count: 0,
          transition_inflow_by_source: { from_on: 0, from_unconfirmed: 0, from_off: 0, from_unknown: 0 },
          total_inflow_count: 2,
          outflow_count: 1,
          outflow_by_target: { to_on: 1, to_unconfirmed: 0, to_off: 0 },
          net_change: 1,
          closing_count: 1,
        },
        off: {
          opening_count: 0,
          new_episode_inflow_count: 0,
          transition_inflow_count: 0,
          transition_inflow_by_source: { from_on: 0, from_unconfirmed: 0, from_off: 0, from_unknown: 0 },
          total_inflow_count: 0,
          outflow_count: 0,
          outflow_by_target: { to_on: 0, to_unconfirmed: 0, to_off: 0 },
          net_change: 0,
          closing_count: 0,
        },
        unknown: {
          opening_count: 0,
          new_episode_inflow_count: 0,
          transition_inflow_count: 0,
          transition_inflow_by_source: { from_on: 0, from_unconfirmed: 0, from_off: 0, from_unknown: 0 },
          total_inflow_count: 0,
          outflow_count: 0,
          outflow_by_target: { to_on: 0, to_unconfirmed: 0, to_off: 0 },
          net_change: 0,
          closing_count: 0,
        },
      },
      totals: {
        opening_eligible_total: 0,
        new_episode_total: 2,
        transition_inflow_total: 1,
        transition_outflow_total: 1,
        net_eligible_change: 2,
        closing_eligible_total: 2,
      },
    },
    waiting: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      eligible_episode_total: 2,
      waiting_episode_total: 2,
      direct_on_episode_count: 0,
      direct_off_episode_count: 0,
      unknown_episode_count: 0,
      all_waiting: { episode_count: 2, interval_count: 2, total_waiting_days: 9, max_waiting_days: 5 },
      completed_waiting: { episode_count: 1, interval_count: 1, total_waiting_days: 4, max_waiting_days: 4 },
      placed_to_on: { episode_count: 1, interval_count: 1, total_waiting_days: 4, max_waiting_days: 4 },
      exited_without_on: { episode_count: 0, interval_count: 0, total_waiting_days: 0, max_waiting_days: null },
      currently_waiting: { episode_count: 1, interval_count: 1, total_waiting_days: 5, max_waiting_days: 5 },
      period_waiting: {
        applicable: true,
        from_date: "2026-10-01",
        to_date: "2026-10-15",
        active_waiting_episode_count: 2,
        in_period_waiting_days: 9,
        placed_in_period: { event_count: 1, episode_count: 1, total_waiting_days: 4 },
        exited_in_period: { event_count: 0, episode_count: 0, total_waiting_days: 0 },
      },
    },
    duration: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      eligible_episode_total: 2,
      known_status_episode_count: 2,
      unknown_status_episode_count: 0,
      ever_on_episode_count: 1,
      never_on_episode_count: 1,
      all_ever_on: { episode_count: 1, interval_count: 1, total_on_days: 10, max_on_days: 10 },
      currently_on: { episode_count: 1, interval_count: 1, total_on_days: 10, max_on_days: 10 },
      exited_after_on: { episode_count: 0, interval_count: 0, total_on_days: 0, max_on_days: null },
      distribution: {
        days_0_to_7_count: 0,
        days_8_to_30_count: 1,
        days_31_to_90_count: 0,
        days_91_plus_count: 0,
      },
      period_presence: {
        applicable: true,
        from_date: "2026-10-01",
        to_date: "2026-10-15",
        active_on_episode_count: 1,
        in_period_on_days: 10,
      },
    },
    retention: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      eligible_episode_total: 2,
      cohort_episode_total: 1,
      never_entered_on_count: 1,
      unknown_status_episode_count: 0,
      continuously_retained_count: 1,
      exited_from_on_total: 0,
      checkpoints: {
        d7: { checkpoint_days: 7, matured_count: 1, immature_count: 0, retained_count: 1, exited_count: 0 },
        d30: { checkpoint_days: 30, matured_count: 0, immature_count: 1, retained_count: 0, exited_count: 0 },
        d90: { checkpoint_days: 90, matured_count: 0, immature_count: 1, retained_count: 0, exited_count: 0 },
      },
      period_cohort: {
        applicable: true,
        from_date: "2026-10-01",
        to_date: "2026-10-15",
        entered_on_count: 1,
        retained_at_to_count: 1,
        exited_by_to_count: 0,
      },
    },
  };

  const okParsed = parseWorkforceReportingPayload(validRpcPayload);
  assert.equal(okParsed.status, "ready");

  // Break conservation equation on ON (outflow_count = 1 without changing net_change, so opening + inflow - outflow !== closing)
  const brokenBalance = structuredClone(validRpcPayload);
  brokenBalance.balance.by_status.on.transition_inflow_count = 2;
  brokenBalance.balance.by_status.on.transition_inflow_by_source.from_unconfirmed = 2;
  brokenBalance.balance.by_status.on.total_inflow_count = 2;
  brokenBalance.balance.by_status.on.net_change = 2;
  const resBrokenBalance = parseWorkforceReportingPayload(brokenBalance);
  assert.equal(resBrokenBalance.status, "unavailable");
  assert.equal(resBrokenBalance.reason, "balance_conservation_invariant_violated");

  // Break single waiting sample invariant (max_waiting_days > total_waiting_days)
  const brokenSample = structuredClone(validRpcPayload);
  brokenSample.waiting.placed_to_on.total_waiting_days = 3;
  const resBrokenSample = parseWorkforceReportingPayload(brokenSample);
  assert.equal(resBrokenSample.status, "unavailable");
  assert.equal(resBrokenSample.reason, "invalid_waiting_sample_metrics");

  // Break waiting sample partition (completed_waiting + currently_waiting !== all_waiting)
  const brokenWaiting = structuredClone(validRpcPayload);
  brokenWaiting.waiting.placed_to_on.total_waiting_days = 3;
  brokenWaiting.waiting.placed_to_on.max_waiting_days = 3;
  const resBrokenWaiting = parseWorkforceReportingPayload(brokenWaiting);
  assert.equal(resBrokenWaiting.status, "unavailable");
  assert.equal(resBrokenWaiting.reason, "waiting_sample_partition_invariant_violated");
});

test("WF-02 (6): Formatting helpers, non-attendance disclaimer, and UI contract guards", () => {
  assert.equal(shiftYmdDays("2026-10-01", -1), "2026-09-30");
  assert.equal(diffYmdDays("2026-10-01", "2026-10-15"), 14);
  assert.equal(formatSignedBalanceDelta(0), "0");
  assert.equal(formatSignedBalanceDelta(5), "+5");
  assert.equal(formatSignedBalanceDelta(-3), "−3");
  assert.equal(formatWaitingDaysAverage(null), "—");
  assert.match(formatWaitingDaysAverage(4.5), /4[,.]5 ngày/);
  assert.equal(formatPlacementRatePercent(null), "—");
  assert.match(formatPlacementRatePercent(0.625), /62[,.]5%/);
  assert.match(formatWorkforceBalanceNotApplicableLabel("all_time"), /Tất cả thời gian/);

  assert.ok(WORKFORCE_NON_ATTENDANCE_NOTE.includes("ngày trạng thái có hiệu lực"));
  assert.ok(WORKFORCE_NON_ATTENDANCE_NOTE.includes("không phải dữ liệu chấm công"));
  assert.equal(WORKFORCE_BALANCE_COLUMN_LABELS.OPENING, "Đầu kỳ");
  assert.equal(WORKFORCE_BALANCE_COLUMN_LABELS.CLOSING, "Cuối kỳ");
  assert.ok(WORKFORCE_WAITING_SAMPLE_LABELS.ALL_WAITING.includes("Đang chờ việc"));

  const sharedUi = readFileSync(new URL("../../components/dashboard/dashboard-shared.tsx", import.meta.url), "utf8");
  assert.ok(sharedUi.includes("Đối soát cân bằng đầu kỳ / cuối kỳ"));
  assert.ok(sharedUi.includes("Thời gian chờ việc &amp; tỷ lệ bố trí việc"));
  assert.ok(sharedUi.includes("WORKFORCE_NON_ATTENDANCE_NOTE"));
  assert.ok(!sharedUi.includes("Chưa xác nhận"));
  assert.ok(!sharedUi.includes("INITIAL_OFF"));
});
