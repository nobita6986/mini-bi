import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applyDashboardDefaultDateParams,
  resolveDashboardDateRange,
} from "./p1-date-presets.ts";
import {
  evaluateWorkforceSnapshotAndTransitions,
  formatDurationDaysAverage,
  formatRetentionRatePercent,
  parseWorkforceReportingPayload,
  WORKFORCE_DURATION_BUCKET_LABELS,
  WORKFORCE_DURATION_SAMPLE_LABELS,
  WORKFORCE_NON_ATTENDANCE_NOTE,
  WORKFORCE_RETENTION_CHECKPOINT_LABELS,
  WORKFORCE_UNIT_METADATA_NOTE,
} from "./wf03-workforce-tenure-retention.ts";

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

test("WF-03 (1): 2.5 Active ON tenure and in-period status presence days across continuous ON, ON->OFF, UNCONFIRMED->ON, UNCONFIRMED->OFF, same-day/superseded, future, and unknown episodes", () => {
  const episodes = [
    // Ep 1: Continuous ON from 2026-09-25 through asOf 2026-10-15 ([09-25, 10-16)) => 21 days ON (clipped in [10-01, 10-16) = 15 days)
    { entry_id: uuid(1), first_work_date: "2026-09-25", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 2: ON (2026-10-02) -> OFF (2026-10-08) ([10-02, 10-08)) => 6 days ON (exited after ON; clipped in [10-01, 10-16) = 6 days)
    { entry_id: uuid(2), first_work_date: "2026-10-02", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 3: UNCONFIRMED (2026-10-01) -> ON (2026-10-06) -> superseded OFF (2026-10-09) -> correction ON (2026-10-09) => ON [10-06, 10-16) = 10 days (waiting 5 days NOT counted in ON tenure)
    { entry_id: uuid(3), first_work_date: "2026-10-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 4: UNCONFIRMED (2026-10-03) -> OFF (2026-10-10) => never entered ON (excluded from ON duration samples)
    { entry_id: uuid(4), first_work_date: "2026-10-03", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 5: Same-day UNCONFIRMED v1 (2026-10-04) -> ON v2 (2026-10-04) -> OFF v3 (2026-10-11) ([10-04, 10-11)) => 7 days ON
    { entry_id: uuid(5), first_work_date: "2026-10-04", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 6: Missing status events <= asOf => unknownStatusEpisodeCount = 1 (never coerced to 0/ON/OFF/UNCONFIRMED)
    { entry_id: uuid(6), first_work_date: "2026-10-05", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 7: Future episode (first_work_date > asOf) => excluded from eligibleEpisodeTotal
    { entry_id: uuid(7), first_work_date: "2026-10-20", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
  ];

  const events = [
    { event_id: uuid(101), entry_id: uuid(1), status: "ON", effective_date: "2026-09-25", version: 1 },

    { event_id: uuid(201), entry_id: uuid(2), status: "ON", effective_date: "2026-10-02", version: 1 },
    { event_id: uuid(202), entry_id: uuid(2), status: "OFF", effective_date: "2026-10-08", version: 2 },

    { event_id: uuid(301), entry_id: uuid(3), status: "UNCONFIRMED", effective_date: "2026-10-01", version: 1 },
    { event_id: uuid(302), entry_id: uuid(3), status: "ON", effective_date: "2026-10-06", version: 2 },
    { event_id: uuid(303), entry_id: uuid(3), status: "OFF", effective_date: "2026-10-09", version: 3 },
    { event_id: uuid(304), entry_id: uuid(3), status: "ON", effective_date: "2026-10-09", version: 4, supersedes_event_id: uuid(303) },

    { event_id: uuid(401), entry_id: uuid(4), status: "UNCONFIRMED", effective_date: "2026-10-03", version: 1 },
    { event_id: uuid(402), entry_id: uuid(4), status: "OFF", effective_date: "2026-10-10", version: 2 },

    { event_id: uuid(501), entry_id: uuid(5), status: "UNCONFIRMED", effective_date: "2026-10-04", version: 1 },
    { event_id: uuid(502), entry_id: uuid(5), status: "ON", effective_date: "2026-10-04", version: 2 },
    { event_id: uuid(503), entry_id: uuid(5), status: "OFF", effective_date: "2026-10-11", version: 3 },

    { event_id: uuid(701), entry_id: uuid(7), status: "ON", effective_date: "2026-10-20", version: 1 },
  ];

  const res = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });

  const d = res.duration;
  assert.equal(d.asOfDate, "2026-10-15");
  assert.equal(d.eligibleEpisodeTotal, 6);
  assert.equal(d.knownStatusEpisodeCount, 5);
  assert.equal(d.unknownStatusEpisodeCount, 1);
  assert.equal(d.everOnEpisodeCount, 4); // Ep 1 (21d), Ep 2 (6d), Ep 3 (10d), Ep 5 (7d)
  assert.equal(d.neverOnEpisodeCount, 1); // Ep 4

  // All Ever ON: 4 episodes, total = 21 + 6 + 10 + 7 = 44 days, avg = 11, max = 21
  assert.deepEqual(d.allEverOn, {
    episodeCount: 4,
    intervalCount: 4,
    totalOnDays: 44,
    avgOnDaysPerEpisode: 11,
    avgOnDaysPerInterval: 11,
    maxOnDays: 21,
  });

  // Currently ON at 2026-10-15: Ep 1 (21d), Ep 3 (10d) => 2 episodes, 31 days, avg = 15.5, max = 21
  assert.deepEqual(d.currentlyOn, {
    episodeCount: 2,
    intervalCount: 2,
    totalOnDays: 31,
    avgOnDaysPerEpisode: 15.5,
    avgOnDaysPerInterval: 15.5,
    maxOnDays: 21,
  });

  // Exited after ON: Ep 2 (6d), Ep 5 (7d) => 2 episodes, 13 days, avg = 6.5, max = 7
  assert.deepEqual(d.exitedAfterOn, {
    episodeCount: 2,
    intervalCount: 2,
    totalOnDays: 13,
    avgOnDaysPerEpisode: 6.5,
    avgOnDaysPerInterval: 6.5,
    maxOnDays: 7,
  });

  // Distribution: Ep 2 (6d) & Ep 5 (7d) in 0..7; Ep 3 (10d) & Ep 1 (21d) in 8..30
  assert.deepEqual(d.distribution, {
    days0To7Count: 2,
    days8To30Count: 2,
    days31To90Count: 0,
    days91PlusCount: 0,
  });

  // Period presence clipped to half-open [2026-10-01, 2026-10-16):
  // Ep 1: [10-01, 10-16) = 15 days
  // Ep 2: [10-02, 10-08) = 6 days
  // Ep 3: [10-06, 10-16) = 10 days
  // Ep 5: [10-04, 10-11) = 7 days
  // Total = 15 + 6 + 10 + 7 = 38 days across 4 active episodes (avg = 9.5 days)
  assert.equal(d.periodPresence.applicable, true);
  if (d.periodPresence.applicable) {
    assert.equal(d.periodPresence.activeOnEpisodeCount, 4);
    assert.equal(d.periodPresence.inPeriodOnDays, 38);
    assert.equal(d.periodPresence.avgInPeriodOnDaysPerActiveEpisode, 9.5);
  }
});

test("WF-03 (1b): Half-open day counting boundary cases (ON on as_of = 1d, ON 01/10..15/10 = 15d, ON 02/10..OFF 08/10 = 6d, ON on to = 1d in period, ON ending on from = 0d in period and excluded from activeOnEpisodeCount)", () => {
  // 1. ON starts right on as_of (2026-10-15) and remains active => 1 day totalOnDays & 1 day in period
  const case1 = evaluateWorkforceSnapshotAndTransitions({
    episodes: [
      { entry_id: uuid(1), first_work_date: "2026-10-15", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    ],
    events: [
      { event_id: uuid(101), entry_id: uuid(1), status: "ON", effective_date: "2026-10-15", version: 1 },
    ],
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });
  assert.equal(case1.duration.allEverOn.totalOnDays, 1);
  assert.equal(case1.duration.currentlyOn.totalOnDays, 1);
  assert.equal(case1.duration.periodPresence.applicable, true);
  if (case1.duration.periodPresence.applicable) {
    assert.equal(case1.duration.periodPresence.activeOnEpisodeCount, 1);
    assert.equal(case1.duration.periodPresence.inPeriodOnDays, 1);
  }

  // 2. ON continuous from 2026-10-01 through 2026-10-15 => 15 days
  const case2 = evaluateWorkforceSnapshotAndTransitions({
    episodes: [
      { entry_id: uuid(2), first_work_date: "2026-10-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    ],
    events: [
      { event_id: uuid(201), entry_id: uuid(2), status: "ON", effective_date: "2026-10-01", version: 1 },
    ],
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });
  assert.equal(case2.duration.allEverOn.totalOnDays, 15);
  assert.equal(case2.duration.currentlyOn.totalOnDays, 15);
  if (case2.duration.periodPresence.applicable) {
    assert.equal(case2.duration.periodPresence.activeOnEpisodeCount, 1);
    assert.equal(case2.duration.periodPresence.inPeriodOnDays, 15);
  }

  // 3. ON 2026-10-02, OFF effective 2026-10-08 => [2026-10-02, 2026-10-08) = 6 days (day 08/10 does not belong to ON)
  const case3 = evaluateWorkforceSnapshotAndTransitions({
    episodes: [
      { entry_id: uuid(3), first_work_date: "2026-10-02", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    ],
    events: [
      { event_id: uuid(301), entry_id: uuid(3), status: "ON", effective_date: "2026-10-02", version: 1 },
      { event_id: uuid(302), entry_id: uuid(3), status: "OFF", effective_date: "2026-10-08", version: 2 },
    ],
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });
  assert.equal(case3.duration.allEverOn.totalOnDays, 6);
  assert.equal(case3.duration.exitedAfterOn.totalOnDays, 6);
  if (case3.duration.periodPresence.applicable) {
    assert.equal(case3.duration.periodPresence.activeOnEpisodeCount, 1);
    assert.equal(case3.duration.periodPresence.inPeriodOnDays, 6);
  }

  // 4 & 5. Combined period boundary check:
  //   - Ep A: ON starts on `to` (2026-10-15) and remains active => 1 day in period, counted in activeOnEpisodeCount.
  //   - Ep B: ON starts 2026-09-25 and ends (OFF effective) right on `from` (2026-10-01) => [09-25, 10-01) has 6 totalOnDays,
  //           but 0 days in [10-01, 10-16) and MUST NOT be counted in activeOnEpisodeCount!
  const case5Only = evaluateWorkforceSnapshotAndTransitions({
    episodes: [
      { entry_id: uuid(5), first_work_date: "2026-09-25", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    ],
    events: [
      { event_id: uuid(501), entry_id: uuid(5), status: "ON", effective_date: "2026-09-25", version: 1 },
      { event_id: uuid(502), entry_id: uuid(5), status: "OFF", effective_date: "2026-10-01", version: 2 },
    ],
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });
  assert.equal(case5Only.duration.allEverOn.totalOnDays, 6);
  assert.equal(case5Only.duration.periodPresence.applicable, true);
  if (case5Only.duration.periodPresence.applicable) {
    assert.equal(case5Only.duration.periodPresence.activeOnEpisodeCount, 0);
    assert.equal(case5Only.duration.periodPresence.inPeriodOnDays, 0);
    assert.equal(case5Only.duration.periodPresence.avgInPeriodOnDaysPerActiveEpisode, null);
  }
});

test("WF-03 (2): 2.6 Continuous cohort retention at D7 / D30 / D90 boundary days (6, 7, 8, 30, 31, 90, 91), ON->OFF->ON before checkpoint stays exited, maturity separation, UNCONFIRMED->ON cohort start, and rehire episode isolation", () => {
  // Reference asOfDate = 2026-10-15
  // Seed episodes with exact boundary exit days relative to their first ON effective_date:
  const episodes = [
    // Ep 1: ON at 2026-06-01, exits after 6 days (2026-06-07) => matured at D7/D30/D90, exited at D7/D30/D90
    { entry_id: uuid(1), first_work_date: "2026-06-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 2: ON at 2026-06-01, exits at exactly day 7 (2026-06-08 = d7_date) => exited at D7/D30/D90
    { entry_id: uuid(2), first_work_date: "2026-06-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 3: ON at 2026-06-01, exits at day 8 (2026-06-09 > d7_date) => retained at D7, exited at D30/D90
    { entry_id: uuid(3), first_work_date: "2026-06-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 4: ON at 2026-06-01, exits at day 30 (2026-07-01 = d30_date) => retained at D7, exited at D30/D90
    { entry_id: uuid(4), first_work_date: "2026-06-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 5: ON at 2026-06-01, exits at day 31 (2026-07-02 > d30_date) => retained at D7 & D30, exited at D90
    { entry_id: uuid(5), first_work_date: "2026-06-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 6: ON at 2026-06-01, exits at day 90 (2026-08-30 = d90_date) => retained at D7 & D30, exited at D90
    { entry_id: uuid(6), first_work_date: "2026-06-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 7: ON at 2026-06-01, exits at day 91 (2026-08-31 > d90_date) => retained at D7, D30, and D90!
    { entry_id: uuid(7), first_work_date: "2026-06-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 8: UNCONFIRMED at 2026-09-01, enters ON at 2026-09-10 (cohort_start_date = 2026-09-10, NOT 09-01!).
    //       At asOf 2026-10-15: age from ON is 35 days => matured for D7 (09-17) and D30 (10-10), immature for D90 (12-09). Continuously ON.
    { entry_id: uuid(8), first_work_date: "2026-09-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 9: ON at 2026-10-05 => at asOf 2026-10-15, age is 10 days => matured for D7 (10-12), immature for D30 (11-04) and D90. Continuously ON.
    { entry_id: uuid(9), first_work_date: "2026-10-05", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 10 (Rehire of worker from Ep 1 with new entry_id): ON at 2026-10-12 => age is 3 days => immature for D7 (10-19), D30, D90.
    //        Must NOT rescue Ep 1's early exit at day 6!
    { entry_id: uuid(10), first_work_date: "2026-10-12", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 11: UNCONFIRMED only (2026-10-02) => neverEnteredOnCount = 1
    { entry_id: uuid(11), first_work_date: "2026-10-02", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 12: Unknown status (no events) => unknownStatusEpisodeCount = 1
    { entry_id: uuid(12), first_work_date: "2026-10-03", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    // Ep 13: Same-episode ON (2026-06-01) -> OFF (2026-06-04, day 3) -> ON (2026-06-06, day 5 before D7=2026-06-08):
    //        Returning to ON in the same episode does NOT restore continuous retention at D7/D30/D90!
    { entry_id: uuid(13), first_work_date: "2026-06-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
  ];

  const events = [
    { event_id: uuid(101), entry_id: uuid(1), status: "ON", effective_date: "2026-06-01", version: 1 },
    { event_id: uuid(102), entry_id: uuid(1), status: "OFF", effective_date: "2026-06-07", version: 2 },

    { event_id: uuid(201), entry_id: uuid(2), status: "ON", effective_date: "2026-06-01", version: 1 },
    { event_id: uuid(202), entry_id: uuid(2), status: "OFF", effective_date: "2026-06-08", version: 2 },

    { event_id: uuid(301), entry_id: uuid(3), status: "ON", effective_date: "2026-06-01", version: 1 },
    { event_id: uuid(302), entry_id: uuid(3), status: "OFF", effective_date: "2026-06-09", version: 2 },

    { event_id: uuid(401), entry_id: uuid(4), status: "ON", effective_date: "2026-06-01", version: 1 },
    { event_id: uuid(402), entry_id: uuid(4), status: "OFF", effective_date: "2026-07-01", version: 2 },

    { event_id: uuid(501), entry_id: uuid(5), status: "ON", effective_date: "2026-06-01", version: 1 },
    { event_id: uuid(502), entry_id: uuid(5), status: "OFF", effective_date: "2026-07-02", version: 2 },

    { event_id: uuid(601), entry_id: uuid(6), status: "ON", effective_date: "2026-06-01", version: 1 },
    { event_id: uuid(602), entry_id: uuid(6), status: "OFF", effective_date: "2026-08-30", version: 2 },

    { event_id: uuid(701), entry_id: uuid(7), status: "ON", effective_date: "2026-06-01", version: 1 },
    { event_id: uuid(702), entry_id: uuid(7), status: "OFF", effective_date: "2026-08-31", version: 2 },

    { event_id: uuid(801), entry_id: uuid(8), status: "UNCONFIRMED", effective_date: "2026-09-01", version: 1 },
    { event_id: uuid(802), entry_id: uuid(8), status: "ON", effective_date: "2026-09-10", version: 2 },

    { event_id: uuid(901), entry_id: uuid(9), status: "ON", effective_date: "2026-10-05", version: 1 },

    { event_id: uuid(1001), entry_id: uuid(10), status: "ON", effective_date: "2026-10-12", version: 1 },

    { event_id: uuid(1101), entry_id: uuid(11), status: "UNCONFIRMED", effective_date: "2026-10-02", version: 1 },

    { event_id: uuid(1301), entry_id: uuid(13), status: "ON", effective_date: "2026-06-01", version: 1 },
    { event_id: uuid(1302), entry_id: uuid(13), status: "OFF", effective_date: "2026-06-04", version: 2 },
    { event_id: uuid(1303), entry_id: uuid(13), status: "ON", effective_date: "2026-06-06", version: 3 },
  ];

  const res = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });

  const r = res.retention;
  assert.equal(r.eligibleEpisodeTotal, 13);
  assert.equal(r.cohortEpisodeTotal, 11); // Ep 1..10 + Ep 13
  assert.equal(r.neverEnteredOnCount, 1); // Ep 11
  assert.equal(r.unknownStatusEpisodeCount, 1); // Ep 12
  assert.equal(r.continuouslyRetainedCount, 3); // Ep 8, Ep 9, Ep 10 (Ep 13 left ON on 06-04 so NOT continuously retained)
  assert.equal(r.exitedFromOnTotal, 8); // Ep 1..7 + Ep 13

  // D7 checkpoint:
  // Matured: Ep 1..9 + Ep 13 (10 episodes); Immature: Ep 10 (1 episode)
  // Exited <= D7: Ep 1 (day 6), Ep 2 (day 7), Ep 13 (OFF at day 3 even though ON again at day 5) => 3 episodes
  // Continuously Retained > D7: Ep 3..9 => 7 episodes
  assert.deepEqual(r.checkpoints.d7, {
    checkpointDays: 7,
    maturedCount: 10,
    immatureCount: 1,
    retainedCount: 7,
    exitedCount: 3,
    retentionRate: 7 / 10,
    attritionRate: 3 / 10,
  });

  // D30 checkpoint:
  // Matured: Ep 1..8 + Ep 13 (9 episodes); Immature: Ep 9, Ep 10 (2 episodes)
  // Exited <= D30: Ep 1 (6d), Ep 2 (7d), Ep 3 (8d), Ep 4 (30d), Ep 13 (3d) => 5 episodes
  // Continuously Retained > D30: Ep 5 (31d), Ep 6 (90d), Ep 7 (91d), Ep 8 (still ON at 35d) => 4 episodes
  assert.deepEqual(r.checkpoints.d30, {
    checkpointDays: 30,
    maturedCount: 9,
    immatureCount: 2,
    retainedCount: 4,
    exitedCount: 5,
    retentionRate: 4 / 9,
    attritionRate: 5 / 9,
  });

  // D90 checkpoint:
  // Matured: Ep 1..7 + Ep 13 (8 episodes); Immature: Ep 8, Ep 9, Ep 10 (3 episodes)
  // Exited <= D90: Ep 1..6 + Ep 13 => 7 episodes
  // Continuously Retained > D90: Ep 7 (exited at day 91) => 1 episode
  assert.deepEqual(r.checkpoints.d90, {
    checkpointDays: 90,
    maturedCount: 8,
    immatureCount: 3,
    retainedCount: 1,
    exitedCount: 7,
    retentionRate: 1 / 8,
    attritionRate: 7 / 8,
  });

  // Period cohort in [2026-10-01 .. 2026-10-15]: Ep 9 (10-05) and Ep 10 (10-12) entered ON in period, both retained at 10-15
  assert.equal(r.periodCohort.applicable, true);
  if (r.periodCohort.applicable) {
    assert.equal(r.periodCohort.enteredOnCount, 2);
    assert.equal(r.periodCohort.retainedAtToCount, 2);
    assert.equal(r.periodCohort.exitedByToCount, 0);
    assert.equal(r.periodCohort.inPeriodRetentionRate, 1);
  }
});

test("WF-03 (3): Verify UNCONFIRMED->ON cohort start date determines D30 maturity (never first_work_date)", () => {
  // Episode starts waiting on 2026-09-10 (35 days before 2026-10-15), but enters ON on 2026-09-20 (25 days before 2026-10-15).
  // Since cohort_start_date = 2026-09-20, at 2026-10-15 it is matured for D7 (2026-09-27 <= 10-15)
  // but IMMATURE for D30 (2026-10-20 > 10-15)!
  const res = evaluateWorkforceSnapshotAndTransitions({
    episodes: [
      { entry_id: uuid(1), first_work_date: "2026-09-10", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
    ],
    events: [
      { event_id: uuid(101), entry_id: uuid(1), status: "UNCONFIRMED", effective_date: "2026-09-10", version: 1 },
      { event_id: uuid(102), entry_id: uuid(1), status: "ON", effective_date: "2026-09-20", version: 2 },
    ],
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });

  assert.equal(res.retention.checkpoints.d7.maturedCount, 1);
  assert.equal(res.retention.checkpoints.d7.immatureCount, 0);
  assert.equal(res.retention.checkpoints.d30.maturedCount, 0);
  assert.equal(res.retention.checkpoints.d30.immatureCount, 1);
  assert.equal(res.retention.checkpoints.d30.retentionRate, null);
});

test("WF-03 (4): Fail-closed payload validation rejects broken duration or retention invariants", () => {
  const basePayload = {
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
      applicable: false,
      reason: "all_time",
      from_date: null,
      to_date: null,
    },
    balance: {
      applicable: false,
      reason: "all_time",
      from_date: null,
      to_date: null,
    },
    waiting: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      eligible_episode_total: 2,
      waiting_episode_total: 1,
      direct_on_episode_count: 1,
      direct_off_episode_count: 0,
      unknown_episode_count: 0,
      all_waiting: { episode_count: 1, interval_count: 1, total_waiting_days: 5, max_waiting_days: 5 },
      completed_waiting: { episode_count: 0, interval_count: 0, total_waiting_days: 0, max_waiting_days: null },
      placed_to_on: { episode_count: 0, interval_count: 0, total_waiting_days: 0, max_waiting_days: null },
      exited_without_on: { episode_count: 0, interval_count: 0, total_waiting_days: 0, max_waiting_days: null },
      currently_waiting: { episode_count: 1, interval_count: 1, total_waiting_days: 5, max_waiting_days: 5 },
      period_waiting: { applicable: false, reason: "all_time", from_date: null, to_date: null },
    },
    duration: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      eligible_episode_total: 2,
      known_status_episode_count: 2,
      unknown_status_episode_count: 0,
      ever_on_episode_count: 1,
      never_on_episode_count: 1,
      all_ever_on: { episode_count: 1, interval_count: 1, total_on_days: 12, max_on_days: 12 },
      currently_on: { episode_count: 1, interval_count: 1, total_on_days: 12, max_on_days: 12 },
      exited_after_on: { episode_count: 0, interval_count: 0, total_on_days: 0, max_on_days: null },
      distribution: {
        days_0_to_7_count: 0,
        days_8_to_30_count: 1,
        days_31_to_90_count: 0,
        days_91_plus_count: 0,
      },
      period_presence: { applicable: false, reason: "all_time", from_date: null, to_date: null },
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
      period_cohort: { applicable: false, reason: "all_time", from_date: null, to_date: null },
    },
    dimensions: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      eligible_episode_total: 2,
      by_recruiter: [
        {
          key: "r1",
          display: "Recruiter 1",
          is_unknown: false,
          active: true,
          eligible_episode_count: 2,
          on_count: 1,
          unconfirmed_count: 1,
          off_count: 0,
          unknown_count: 0,
          waiting_episode_count: 1,
          completed_waiting_episode_count: 0,
          placed_to_on_episode_count: 0,
          exited_without_on_episode_count: 0,
          currently_waiting_episode_count: 1,
          total_waiting_days: 5,
          ever_on_episode_count: 1,
          never_on_episode_count: 1,
          continuously_retained_count: 1,
          exited_from_on_count: 0,
          total_on_days: 12,
          checkpoints: {
            d7: { checkpoint_days: 7, matured_count: 1, immature_count: 0, retained_count: 1, exited_count: 0 },
            d30: { checkpoint_days: 30, matured_count: 0, immature_count: 1, retained_count: 0, exited_count: 0 },
            d90: { checkpoint_days: 90, matured_count: 0, immature_count: 1, retained_count: 0, exited_count: 0 },
          },
        },
      ],
      by_team: [
        {
          key: "t1",
          display: "Team 1",
          is_unknown: false,
          active: true,
          eligible_episode_count: 2,
          on_count: 1,
          unconfirmed_count: 1,
          off_count: 0,
          unknown_count: 0,
          waiting_episode_count: 1,
          completed_waiting_episode_count: 0,
          placed_to_on_episode_count: 0,
          exited_without_on_episode_count: 0,
          currently_waiting_episode_count: 1,
          total_waiting_days: 5,
          ever_on_episode_count: 1,
          never_on_episode_count: 1,
          continuously_retained_count: 1,
          exited_from_on_count: 0,
          total_on_days: 12,
          checkpoints: {
            d7: { checkpoint_days: 7, matured_count: 1, immature_count: 0, retained_count: 1, exited_count: 0 },
            d30: { checkpoint_days: 30, matured_count: 0, immature_count: 1, retained_count: 0, exited_count: 0 },
            d90: { checkpoint_days: 90, matured_count: 0, immature_count: 1, retained_count: 0, exited_count: 0 },
          },
        },
      ],
      by_provider: [
        {
          key: "p1",
          display: "Provider 1",
          is_unknown: false,
          active: true,
          eligible_episode_count: 2,
          on_count: 1,
          unconfirmed_count: 1,
          off_count: 0,
          unknown_count: 0,
          waiting_episode_count: 1,
          completed_waiting_episode_count: 0,
          placed_to_on_episode_count: 0,
          exited_without_on_episode_count: 0,
          currently_waiting_episode_count: 1,
          total_waiting_days: 5,
          ever_on_episode_count: 1,
          never_on_episode_count: 1,
          continuously_retained_count: 1,
          exited_from_on_count: 0,
          total_on_days: 12,
          checkpoints: {
            d7: { checkpoint_days: 7, matured_count: 1, immature_count: 0, retained_count: 1, exited_count: 0 },
            d30: { checkpoint_days: 30, matured_count: 0, immature_count: 1, retained_count: 0, exited_count: 0 },
            d90: { checkpoint_days: 90, matured_count: 0, immature_count: 1, retained_count: 0, exited_count: 0 },
          },
        },
      ],
      by_project: [
        {
          key: "prj1",
          display: "Project 1",
          is_unknown: false,
          active: true,
          eligible_episode_count: 2,
          on_count: 1,
          unconfirmed_count: 1,
          off_count: 0,
          unknown_count: 0,
          waiting_episode_count: 1,
          completed_waiting_episode_count: 0,
          placed_to_on_episode_count: 0,
          exited_without_on_episode_count: 0,
          currently_waiting_episode_count: 1,
          total_waiting_days: 5,
          ever_on_episode_count: 1,
          never_on_episode_count: 1,
          continuously_retained_count: 1,
          exited_from_on_count: 0,
          total_on_days: 12,
          checkpoints: {
            d7: { checkpoint_days: 7, matured_count: 1, immature_count: 0, retained_count: 1, exited_count: 0 },
            d30: { checkpoint_days: 30, matured_count: 0, immature_count: 1, retained_count: 0, exited_count: 0 },
            d90: { checkpoint_days: 90, matured_count: 0, immature_count: 1, retained_count: 0, exited_count: 0 },
          },
        },
      ],
    },
    leave_reasons: {
      as_of_date: "2026-10-15",
      as_of_source: "filter_to",
      off_episode_total: 0,
      with_reason_episode_count: 0,
      standardized_episode_count: 0,
      unclassified_free_text_episode_count: 0,
      missing_reason_episode_count: 0,
      by_category: [
        { key: "personal_or_family", kind: "standardized", episode_count: 0, from_on_count: 0, from_unconfirmed_without_on_count: 0 },
        { key: "health", kind: "standardized", episode_count: 0, from_on_count: 0, from_unconfirmed_without_on_count: 0 },
        { key: "compensation_or_benefits", kind: "standardized", episode_count: 0, from_on_count: 0, from_unconfirmed_without_on_count: 0 },
        { key: "work_conditions_or_shift", kind: "standardized", episode_count: 0, from_on_count: 0, from_unconfirmed_without_on_count: 0 },
        { key: "relocation_or_distance", kind: "standardized", episode_count: 0, from_on_count: 0, from_unconfirmed_without_on_count: 0 },
        { key: "contract_or_project_end", kind: "standardized", episode_count: 0, from_on_count: 0, from_unconfirmed_without_on_count: 0 },
        { key: "discipline_or_performance", kind: "standardized", episode_count: 0, from_on_count: 0, from_unconfirmed_without_on_count: 0 },
        { key: "other_career_or_study", kind: "standardized", episode_count: 0, from_on_count: 0, from_unconfirmed_without_on_count: 0 },
        { key: "unclassified_free_text", kind: "unclassified_free_text", episode_count: 0, from_on_count: 0, from_unconfirmed_without_on_count: 0 },
        { key: "missing_or_unknown", kind: "missing_or_unknown", episode_count: 0, from_on_count: 0, from_unconfirmed_without_on_count: 0 },
      ],
      period_leave_reasons: { applicable: false, reason: "all_time", from_date: null, to_date: null },
    },
  };

  assert.equal(parseWorkforceReportingPayload(basePayload).status, "ready");

  // 1. Break duration distribution sum invariant
  const brokenDist = structuredClone(basePayload);
  brokenDist.duration.distribution.days_0_to_7_count = 1;
  const resBrokenDist = parseWorkforceReportingPayload(brokenDist);
  assert.equal(resBrokenDist.status, "unavailable");
  assert.equal(resBrokenDist.reason, "duration_distribution_sum_invariant_violated");

  // 2. Break retention checkpoint partition (retained + exited !== matured)
  const brokenCheckpoint = structuredClone(basePayload);
  brokenCheckpoint.retention.checkpoints.d7.exited_count = 1;
  const resBrokenCp = parseWorkforceReportingPayload(brokenCheckpoint);
  assert.equal(resBrokenCp.status, "unavailable");
  assert.equal(resBrokenCp.reason, "invalid_retention_checkpoint_metrics");

  // 3. Break retention monotonicity (d30 matured > d7 matured)
  const brokenMonotonic = structuredClone(basePayload);
  brokenMonotonic.retention.checkpoints.d7.matured_count = 0;
  brokenMonotonic.retention.checkpoints.d7.immature_count = 1;
  brokenMonotonic.retention.checkpoints.d7.retained_count = 0;
  brokenMonotonic.retention.checkpoints.d30.matured_count = 1;
  brokenMonotonic.retention.checkpoints.d30.immature_count = 0;
  brokenMonotonic.retention.checkpoints.d30.retained_count = 1;
  const resBrokenMono = parseWorkforceReportingPayload(brokenMonotonic);
  assert.equal(resBrokenMono.status, "unavailable");
  assert.equal(resBrokenMono.reason, "retention_checkpoint_monotonicity_violated");
});

test("WF-03 (5): UI copy cleanup removes technical tokens, uses 'Duy trì liên tục' instead of 'Còn làm', defaults date filter to 'Tháng này', and places Workforce Analytics at the bottom of all 4 dashboard views", () => {
  assert.equal(formatDurationDaysAverage(null), "—");
  assert.match(formatDurationDaysAverage(12.5), /12[,.]5 ngày/);
  assert.equal(formatRetentionRatePercent(null), "—");
  assert.match(formatRetentionRatePercent(0.875), /87[,.]5%/);

  // 1. Verify no technical tokens in UI constants or WorkforceSnapshotSection copy:
  const forbiddenTokens = [
    "entry_id",
    "event_id",
    "business_date",
    "first_work_date",
    "effective_date",
    "non-superseded",
    "episode",
  ];
  for (const token of forbiddenTokens) {
    assert.ok(
      !WORKFORCE_UNIT_METADATA_NOTE.includes(token),
      `WORKFORCE_UNIT_METADATA_NOTE must not contain technical token '${token}'`,
    );
    assert.ok(
      !WORKFORCE_NON_ATTENDANCE_NOTE.includes(token),
      `WORKFORCE_NON_ATTENDANCE_NOTE must not contain technical token '${token}'`,
    );
  }
  assert.ok(WORKFORCE_UNIT_METADATA_NOTE.includes("đợt làm việc"));
  assert.ok(WORKFORCE_UNIT_METADATA_NOTE.includes("lần thay đổi trạng thái"));
  assert.ok(WORKFORCE_UNIT_METADATA_NOTE.includes("ngày ghi nhận tuyển dụng"));
  assert.ok(WORKFORCE_UNIT_METADATA_NOTE.includes("ngày bắt đầu làm việc"));
  assert.ok(WORKFORCE_UNIT_METADATA_NOTE.includes("ngày trạng thái có hiệu lực"));
  assert.ok(WORKFORCE_NON_ATTENDANCE_NOTE.includes("đã loại các bản ghi bị thay thế hoặc điều chỉnh"));
  assert.ok(WORKFORCE_DURATION_SAMPLE_LABELS.ALL_EVER_ON.includes("đợt làm việc"));
  assert.ok(WORKFORCE_DURATION_BUCKET_LABELS.DAYS_91_PLUS.includes("91 ngày"));
  assert.ok(WORKFORCE_RETENTION_CHECKPOINT_LABELS.D7.includes("D7"));

  const sharedUi = readFileSync(
    new URL("../../components/dashboard/dashboard-shared.tsx", import.meta.url),
    "utf8",
  );
  // Extract WorkforceSnapshotSection + WorkforceDeepSection blocks from dashboard-shared.tsx
  const wfStart = sharedUi.indexOf("export function WorkforceSnapshotSection");
  const wfEnd = sharedUi.indexOf("export function WorkforceDeepReportPanel");
  const wfSectionSource = sharedUi.slice(wfStart, wfEnd);
  // Strip identifier property accesses (e.g. .episodeCount, .eligibleEpisodeTotal, .futureEpisodeCount, .activeWaitingEpisodeCount, .activeOnEpisodeCount, .avgOnDaysPerEpisode, .avgWaitingDaysPerEpisode, .unknownStatusEpisodeCount, .everOnEpisodeCount, .neverOnEpisodeCount, .cohortEpisodeTotal, .transitionEpisodeCount, .newEpisodeInflowCount, .newEpisodeTotal) before checking visible copy
  const wfVisibleCopy = wfSectionSource.replace(
    /\b[A-Za-z0-9_]*[Ee]pisode[A-Za-z0-9_]*\b/g,
    "",
  );
  for (const token of forbiddenTokens) {
    assert.ok(
      !wfVisibleCopy.includes(token),
      `WorkforceSnapshotSection visible UI must not contain technical token '${token}'`,
    );
  }
  assert.ok(wfSectionSource.includes("Thâm niên làm việc &amp; ngày hiện diện theo trạng thái"));
  assert.ok(wfSectionSource.includes("Nghỉ sớm &amp; giữ chân theo mốc D7 / D30 / D90"));
  assert.ok(wfSectionSource.includes("Duy trì liên tục"));
  assert.ok(!wfSectionSource.includes("Còn làm"), "UI must use 'Duy trì liên tục' instead of 'Còn làm'");

  // 2. Verify default date filter "Tháng này" on server & client:
  const refDate = new Date("2026-10-22T03:00:00.000Z");
  const defaultResolved = resolveDashboardDateRange({}, refDate);
  assert.deepEqual(defaultResolved, {
    from: "2026-10-01",
    to: "2026-10-22",
    isExplicitAllTime: false,
    isDefaultThisMonth: true,
  });
  const serverParams = applyDashboardDefaultDateParams({}, refDate);
  assert.equal(serverParams.from, "2026-10-01");
  assert.equal(serverParams.to, "2026-10-22");

  const explicitAllTime = resolveDashboardDateRange({ range: "all" }, refDate);
  assert.equal(explicitAllTime.from, null);
  assert.equal(explicitAllTime.to, null);
  assert.equal(explicitAllTime.isExplicitAllTime, true);

  // 3. Verify Workforce Analytics overview is placed at the bottom of BoD dashboard-view.tsx,
  // and scoped views (own-dashboard-view.tsx, team-report-view.tsx) do not render WorkforceSnapshotSection:
  const bodView = readFileSync(
    new URL("../../components/dashboard/dashboard-view.tsx", import.meta.url),
    "utf8",
  );
  const lastSectionInBod = bodView.lastIndexOf('aria-label="Phân bổ tuyển dụng"');
  const lastWfInBod = bodView.lastIndexOf("<WorkforceStatusSection");
  assert.ok(
    lastSectionInBod > 0 && lastWfInBod > lastSectionInBod,
    "WorkforceStatusSection must appear after 'Phân bổ tuyển dụng' at the bottom of dashboard-view.tsx",
  );

  const ownView = readFileSync(
    new URL("../../components/dashboard/own-dashboard-view.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    ownView,
    /<WorkforceSnapshotSection/,
    "own-dashboard-view.tsx must not render WorkforceSnapshotSection",
  );

  const teamReportView = readFileSync(
    new URL("../../components/dashboard/team-report-view.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    teamReportView,
    /<WorkforceSnapshotSection/,
    "team-report-view.tsx must not render WorkforceSnapshotSection",
  );
});
