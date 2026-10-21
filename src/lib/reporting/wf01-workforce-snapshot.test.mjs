import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  evaluateWorkforceSnapshotAndTransitions,
  formatWorkforceTransitionsNotApplicableLabel,
  parseWorkforceReportingPayload,
  resolveWorkforceAsOfDate,
  resolveWorkforceReportingForActor,
  WORKER_STATUS_FROZEN_LABELS,
  WORKFORCE_INITIAL_STATUS_LABELS,
  WORKFORCE_SNAPSHOT_STATUS_LABELS,
  WORKFORCE_TRANSITION_PAIR_LABELS,
  WORKFORCE_UNIT_METADATA_NOTE,
} from "./wf01-workforce-snapshot.ts";

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

test("WF-01 (1): Snapshot as-of evaluates ON, UNCONFIRMED, and OFF across different asOfDate milestones", () => {
  const episodes = [
    { entry_id: uuid(1), first_work_date: "2026-10-01" },
    { entry_id: uuid(2), first_work_date: "2026-10-02" },
    { entry_id: uuid(3), first_work_date: "2026-10-03" },
  ];
  const events = [
    // Episode 1: UNCONFIRMED on 10-01 -> ON on 10-05 -> OFF on 10-12
    { event_id: uuid(101), entry_id: uuid(1), status: "UNCONFIRMED", effective_date: "2026-10-01", version: 1 },
    { event_id: uuid(102), entry_id: uuid(1), status: "ON", effective_date: "2026-10-05", version: 2 },
    { event_id: uuid(103), entry_id: uuid(1), status: "OFF", effective_date: "2026-10-12", version: 3 },
    // Episode 2: ON on 10-02
    { event_id: uuid(201), entry_id: uuid(2), status: "ON", effective_date: "2026-10-02", version: 1 },
    // Episode 3: UNCONFIRMED on 10-03 -> OFF on 10-08
    { event_id: uuid(301), entry_id: uuid(3), status: "UNCONFIRMED", effective_date: "2026-10-03", version: 1 },
    { event_id: uuid(302), entry_id: uuid(3), status: "OFF", effective_date: "2026-10-08", version: 2 },
  ];

  // Milestone 1: as-of 2026-10-03
  const m1 = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-03" },
  });
  assert.equal(m1.snapshot.asOfDate, "2026-10-03");
  assert.equal(m1.snapshot.asOfSource, "filter_to");
  assert.equal(m1.snapshot.eligibleEpisodeTotal, 3);
  assert.equal(m1.snapshot.onCount, 1); // ep2
  assert.equal(m1.snapshot.unconfirmedCount, 2); // ep1, ep3
  assert.equal(m1.snapshot.offCount, 0);
  assert.equal(m1.snapshot.unknownCount, 0);

  // Milestone 2: as-of 2026-10-06
  const m2 = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-06" },
  });
  assert.equal(m2.snapshot.eligibleEpisodeTotal, 3);
  assert.equal(m2.snapshot.onCount, 2); // ep1, ep2
  assert.equal(m2.snapshot.unconfirmedCount, 1); // ep3
  assert.equal(m2.snapshot.offCount, 0);

  // Milestone 3: as-of 2026-10-15
  const m3 = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });
  assert.equal(m3.snapshot.eligibleEpisodeTotal, 3);
  assert.equal(m3.snapshot.onCount, 1); // ep2
  assert.equal(m3.snapshot.unconfirmedCount, 0);
  assert.equal(m3.snapshot.offCount, 2); // ep1, ep3
});

test("WF-01 (2): Episodes with first_work_date > asOfDate are excluded from snapshot at asOfDate", () => {
  const episodes = [
    { entry_id: uuid(1), first_work_date: "2026-10-05" },
    { entry_id: uuid(2), first_work_date: "2026-10-12" },
    { entry_id: uuid(3), first_work_date: "2026-10-20" },
  ];
  const events = [
    { event_id: uuid(101), entry_id: uuid(1), status: "ON", effective_date: "2026-10-05", version: 1 },
    { event_id: uuid(201), entry_id: uuid(2), status: "UNCONFIRMED", effective_date: "2026-10-12", version: 1 },
    { event_id: uuid(301), entry_id: uuid(3), status: "ON", effective_date: "2026-10-20", version: 1 },
  ];

  const res = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-10" },
  });
  assert.equal(res.snapshot.asOfDate, "2026-10-10");
  assert.equal(res.snapshot.eligibleEpisodeTotal, 1);
  assert.equal(res.snapshot.onCount, 1);
  assert.equal(res.snapshot.unconfirmedCount, 0);
  assert.equal(res.snapshot.offCount, 0);
  assert.equal(res.snapshot.unknownCount, 0);
  assert.equal(res.snapshot.futureEpisodeCount, 2);
});

test("WF-01 (3): Episodes with first_work_date <= asOfDate but no status event <= asOfDate fall into unknownCount and sum matches eligibleEpisodeTotal", () => {
  const episodes = [
    { entry_id: uuid(1), first_work_date: "2026-10-01" }, // ON
    { entry_id: uuid(2), first_work_date: "2026-10-02" }, // no event at all -> UNKNOWN
    { entry_id: uuid(3), first_work_date: "2026-10-03" }, // earliest event is 2026-10-15 (> asOfDate) -> UNKNOWN at 2026-10-10
    { entry_id: uuid(4), first_work_date: "2026-10-04" }, // UNCONFIRMED
  ];
  const events = [
    { event_id: uuid(101), entry_id: uuid(1), status: "ON", effective_date: "2026-10-01", version: 1 },
    { event_id: uuid(301), entry_id: uuid(3), status: "ON", effective_date: "2026-10-15", version: 1 },
    { event_id: uuid(401), entry_id: uuid(4), status: "UNCONFIRMED", effective_date: "2026-10-04", version: 1 },
  ];

  const res = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-10" },
  });
  assert.equal(res.snapshot.eligibleEpisodeTotal, 4);
  assert.equal(res.snapshot.onCount, 1);
  assert.equal(res.snapshot.unconfirmedCount, 1);
  assert.equal(res.snapshot.offCount, 0);
  assert.equal(res.snapshot.unknownCount, 2);
  assert.equal(
    res.snapshot.onCount +
      res.snapshot.unconfirmedCount +
      res.snapshot.offCount +
      res.snapshot.unknownCount,
    res.snapshot.eligibleEpisodeTotal,
  );
});

test("WF-01 (4): Multi-step correction chain (supersedes_event_id) excludes all superseded events from snapshot and transitions", () => {
  const episodes = [{ entry_id: uuid(1), first_work_date: "2026-10-01" }];
  // v1: UNCONFIRMED (2026-10-01)
  // v2: OFF (2026-10-05) -> superseded by v3: ON (2026-10-05) -> superseded by v4: ON (2026-10-06)
  // v5: OFF (2026-10-10) -> superseded by v6: ON (2026-10-10)
  //wait: v4 is ON (2026-10-06) and v6 is OFF (2026-10-12, superseding v5)
  const events = [
    { event_id: uuid(1), entry_id: uuid(1), status: "UNCONFIRMED", effective_date: "2026-10-01", version: 1, supersedes_event_id: null },
    { event_id: uuid(2), entry_id: uuid(1), status: "OFF", effective_date: "2026-10-05", version: 2, supersedes_event_id: null },
    { event_id: uuid(3), entry_id: uuid(1), status: "ON", effective_date: "2026-10-05", version: 3, supersedes_event_id: uuid(2) },
    { event_id: uuid(4), entry_id: uuid(1), status: "ON", effective_date: "2026-10-06", version: 4, supersedes_event_id: uuid(3) },
  ];

  // At 2026-10-05: since v2 and v3 were superseded by v4 (effective 2026-10-06), only v1 (UNCONFIRMED on 2026-10-01) is active <= 2026-10-05!
  const atOct5 = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-05" },
  });
  assert.equal(atOct5.snapshot.unconfirmedCount, 1);
  assert.equal(atOct5.snapshot.onCount, 0);
  assert.equal(atOct5.snapshot.offCount, 0);
  assert.equal(atOct5.transitions.applicable, true);
  if (atOct5.transitions.applicable) {
    assert.equal(atOct5.transitions.pairs.unconfirmedToOff.eventCount, 0);
    assert.equal(atOct5.transitions.pairs.unconfirmedToOn.eventCount, 0);
  }

  // At 2026-10-10: active chain is v1 (UNCONFIRMED, 10-01) -> v4 (ON, 10-06).
  const atOct10 = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-10" },
  });
  assert.equal(atOct10.snapshot.onCount, 1);
  assert.equal(atOct10.snapshot.offCount, 0);
  assert.equal(atOct10.transitions.applicable, true);
  if (atOct10.transitions.applicable) {
    assert.equal(atOct10.transitions.initial.unconfirmed.eventCount, 1);
    assert.equal(atOct10.transitions.pairs.unconfirmedToOn.eventCount, 1);
    assert.equal(atOct10.transitions.pairs.unconfirmedToOff.eventCount, 0);
    assert.equal(atOct10.transitions.totals.transitionEventCount, 1);
  }
});

test("WF-01 (5): Multiple non-superseded events on the same entry_id and same effective_date are ordered strictly by (effective_date, version) without applied_at/event_id tie-break", () => {
  const episodes = [{ entry_id: uuid(1), first_work_date: "2026-10-01" }];
  // Intentionally pass out of order in the input array AND with reversed applied_at / event_id
  // to verify ordering uses only (effective_date, version):
  const events = [
    { event_id: uuid(1), entry_id: uuid(1), status: "ON", effective_date: "2026-10-01", version: 2, applied_at: "2026-10-01T07:00:00Z" },
    { event_id: uuid(99), entry_id: uuid(1), status: "UNCONFIRMED", effective_date: "2026-10-01", version: 1, applied_at: "2026-10-01T09:00:00Z" },
  ];

  const res = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-01" },
  });
  assert.equal(res.snapshot.onCount, 1);
  assert.equal(res.snapshot.unconfirmedCount, 0);
  assert.equal(res.transitions.applicable, true);
  if (res.transitions.applicable) {
    assert.equal(res.transitions.initial.unconfirmed.eventCount, 1);
    assert.equal(res.transitions.initial.on.eventCount, 0);
    assert.equal(res.transitions.pairs.unconfirmedToOn.eventCount, 1);
    assert.equal(res.transitions.pairs.unconfirmedToOn.episodeCount, 1);
  }
});

test("WF-01 (6): Strictly separates initial episode events (prev_status IS NULL: INITIAL_ON, INITIAL_UNCONFIRMED; no INITIAL_OFF KPI) from state transitions (UNCONFIRMED->ON, UNCONFIRMED->OFF, ON->OFF, OFF->ON)", () => {
  const episodes = [
    { entry_id: uuid(1), first_work_date: "2026-09-25" }, // started before period
    { entry_id: uuid(2), first_work_date: "2026-10-02" }, // started in period (UNCONFIRMED -> ON -> OFF -> ON)
    { entry_id: uuid(3), first_work_date: "2026-10-04" }, // started in period (UNCONFIRMED -> OFF)
    { entry_id: uuid(4), first_work_date: "2026-10-05" }, // started in period (INITIAL_ON only)
  ];
  const events = [
    // Ep 1: started ON on 09-25 (outside period), then ON -> OFF on 10-03 (inside period)
    { event_id: uuid(11), entry_id: uuid(1), status: "ON", effective_date: "2026-09-25", version: 1 },
    { event_id: uuid(12), entry_id: uuid(1), status: "OFF", effective_date: "2026-10-03", version: 2 },
    // Ep 2: INITIAL_UNCONFIRMED (10-02) -> ON (10-04) -> OFF (10-08) -> ON (10-12) -> OFF (10-14)
    { event_id: uuid(21), entry_id: uuid(2), status: "UNCONFIRMED", effective_date: "2026-10-02", version: 1 },
    { event_id: uuid(22), entry_id: uuid(2), status: "ON", effective_date: "2026-10-04", version: 2 },
    { event_id: uuid(23), entry_id: uuid(2), status: "OFF", effective_date: "2026-10-08", version: 3 },
    { event_id: uuid(24), entry_id: uuid(2), status: "ON", effective_date: "2026-10-12", version: 4 },
    { event_id: uuid(25), entry_id: uuid(2), status: "OFF", effective_date: "2026-10-14", version: 5 },
    // Ep 3: INITIAL_UNCONFIRMED (10-04) -> OFF (10-09)
    { event_id: uuid(31), entry_id: uuid(3), status: "UNCONFIRMED", effective_date: "2026-10-04", version: 1 },
    { event_id: uuid(32), entry_id: uuid(3), status: "OFF", effective_date: "2026-10-09", version: 2 },
    // Ep 4: INITIAL_ON (10-05)
    { event_id: uuid(41), entry_id: uuid(4), status: "ON", effective_date: "2026-10-05", version: 1 },
  ];

  const res = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-15" },
  });
  assert.equal(res.transitions.applicable, true);
  if (res.transitions.applicable) {
    // Initial events in [10-01, 10-15]: Ep 2 (UNCONFIRMED), Ep 3 (UNCONFIRMED), Ep 4 (ON). Ep 1 initial was 09-25.
    assert.deepEqual(res.transitions.initial.total, { eventCount: 3, episodeCount: 3 });
    assert.deepEqual(res.transitions.initial.on, { eventCount: 1, episodeCount: 1 });
    assert.deepEqual(res.transitions.initial.unconfirmed, { eventCount: 2, episodeCount: 2 });
    assert.equal("off" in res.transitions.initial, false);

    // Transitions:
    // UNCONFIRMED -> ON: Ep 2 (1 event, 1 episode)
    assert.deepEqual(res.transitions.pairs.unconfirmedToOn, { eventCount: 1, episodeCount: 1 });
    // UNCONFIRMED -> OFF: Ep 3 (1 event, 1 episode)
    assert.deepEqual(res.transitions.pairs.unconfirmedToOff, { eventCount: 1, episodeCount: 1 });
    // ON -> OFF: Ep 1 (1 event) + Ep 2 (2 events on 10-08 and 10-14) => 3 events across 2 distinct episodes!
    assert.deepEqual(res.transitions.pairs.onToOff, { eventCount: 3, episodeCount: 2 });
    // OFF -> ON: Ep 2 (1 event on 10-12, 1 episode)
    assert.deepEqual(res.transitions.pairs.offToOn, { eventCount: 1, episodeCount: 1 });
    // Total transition events = 1 + 1 + 3 + 1 = 6 events across 3 distinct episodes (Ep 1, Ep 2, Ep 3)
    assert.equal(res.transitions.totals.transitionEventCount, 6);
    assert.equal(res.transitions.totals.transitionEpisodeCount, 3);
  }
});

test("WF-01 (7): Consecutive non-superseded events with identical status (prev_status = status) are not counted as transitions", () => {
  const episodes = [{ entry_id: uuid(1), first_work_date: "2026-10-01" }];
  const events = [
    { event_id: uuid(1), entry_id: uuid(1), status: "ON", effective_date: "2026-10-01", version: 1 },
    { event_id: uuid(2), entry_id: uuid(1), status: "ON", effective_date: "2026-10-04", version: 2 },
    { event_id: uuid(3), entry_id: uuid(1), status: "OFF", effective_date: "2026-10-08", version: 3 },
  ];

  const res = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-10" },
  });
  assert.equal(res.transitions.applicable, true);
  if (res.transitions.applicable) {
    assert.equal(res.transitions.totals.transitionEventCount, 1); // only ON -> OFF
    assert.equal(res.transitions.totals.noopRepeatEventCount, 1);
    assert.equal(res.transitions.totals.noopRepeatEpisodeCount, 1);
    assert.equal(res.transitions.pairs.onToOff.eventCount, 1);
    assert.equal(res.transitions.pairs.other.eventCount, 0);
  }
});

test("WF-01 (8 & 9): Excludes deleted_at, voided_at, non-SUBMITTED submissions, and out-of-scope episodes", () => {
  const episodes = [
    { entry_id: uuid(1), first_work_date: "2026-10-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null, scope_allowed: true },
    { entry_id: uuid(2), first_work_date: "2026-10-01", submission_state: "DRAFT", deleted_at: null, voided_at: null, scope_allowed: true },
    { entry_id: uuid(3), first_work_date: "2026-10-01", submission_state: "SUBMITTED", deleted_at: "2026-10-02T00:00:00Z", voided_at: null, scope_allowed: true },
    { entry_id: uuid(4), first_work_date: "2026-10-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: "2026-10-02T00:00:00Z", scope_allowed: true },
    { entry_id: uuid(5), first_work_date: "2026-10-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null, scope_allowed: false },
  ];
  const events = episodes.map((ep, idx) => ({
    event_id: uuid(100 + idx),
    entry_id: ep.entry_id,
    status: "ON",
    effective_date: "2026-10-01",
    version: 1,
  }));

  const res = evaluateWorkforceSnapshotAndTransitions({
    episodes,
    events,
    filters: { from: "2026-10-01", to: "2026-10-10" },
  });
  assert.equal(res.snapshot.eligibleEpisodeTotal, 1);
  assert.equal(res.snapshot.onCount, 1);
  assert.equal(res.transitions.applicable, true);
  if (res.transitions.applicable) {
    assert.equal(res.transitions.initial.total.episodeCount, 1);
  }
});

test("WF-01 (10): Frozen status vocabulary uses 'Đang chờ việc' for UNCONFIRMED, never 'Chưa xác nhận', does not expose INITIAL_OFF KPI, and never labels OFF->ON as rehire", () => {
  assert.equal(WORKER_STATUS_FROZEN_LABELS.ON, "Đang làm");
  assert.equal(WORKER_STATUS_FROZEN_LABELS.UNCONFIRMED, "Đang chờ việc");
  assert.equal(WORKER_STATUS_FROZEN_LABELS.OFF, "Đã nghỉ");
  assert.equal(WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED, "Đang chờ việc");
  assert.equal(WORKFORCE_SNAPSHOT_STATUS_LABELS.UNKNOWN, "Chưa xác định trạng thái");
  assert.equal(WORKFORCE_TRANSITION_PAIR_LABELS.OFF_TO_ON, "Đã nghỉ → Đang làm");
  assert.equal("INITIAL_OFF" in WORKFORCE_INITIAL_STATUS_LABELS, false);
  assert.deepEqual(Object.keys(WORKFORCE_INITIAL_STATUS_LABELS), ["INITIAL_ON", "INITIAL_UNCONFIRMED"]);
  assert.ok(!Object.values(WORKFORCE_SNAPSHOT_STATUS_LABELS).includes("Chưa xác nhận"));
  assert.ok(!Object.values(WORKFORCE_TRANSITION_PAIR_LABELS).some((v) => v.includes("Chưa xác nhận")));
  assert.ok(!Object.values(WORKFORCE_TRANSITION_PAIR_LABELS).some((v) => /rehire|tái tuyển dụng|tái kích hoạt/i.test(v)));
  assert.ok(!Object.values(WORKFORCE_INITIAL_STATUS_LABELS).some((v) => v.includes("Chưa xác nhận")));
  assert.ok(WORKFORCE_UNIT_METADATA_NOTE.includes("entry_id"));
  assert.ok(WORKFORCE_UNIT_METADATA_NOTE.includes("rehire"));
  assert.ok(WORKFORCE_UNIT_METADATA_NOTE.includes("business_date"));

  const sharedUi = readFileSync(new URL("../../components/dashboard/dashboard-shared.tsx", import.meta.url), "utf8");
  assert.ok(!sharedUi.includes("Chưa xác nhận"), "dashboard-shared.tsx must never render 'Chưa xác nhận'");
  assert.ok(!sharedUi.includes("INITIAL_OFF"), "dashboard-shared.tsx must not render INITIAL_OFF KPI");
  assert.ok(sharedUi.includes("Tính đến ngày {snapshot.asOfDate}"));
  assert.ok(sharedUi.includes("WORKFORCE_SNAPSHOT_STATUS_LABELS.UNCONFIRMED"));
});

test("WF-01 (11): Error/unavailable isolation and fail-closed payload validation never fabricate 0", async () => {
  // 1. RPC returns error -> status: "unavailable"
  const errRes = await resolveWorkforceReportingForActor({
    actor: { auth_subject: uuid(1), app_user_id: uuid(2) },
    filters: { from: "2026-10-01", to: "2026-10-10" },
    expectedAudienceKind: "all",
    callWorkforceRpc: async () => ({ error: { code: "500" } }),
  });
  assert.equal(errRes.status, "unavailable");

  // 2. Audience mismatch -> status: "unavailable"
  const mismatchRes = await resolveWorkforceReportingForActor({
    actor: { auth_subject: uuid(1), app_user_id: uuid(2) },
    filters: { from: "2026-10-01", to: "2026-10-10" },
    expectedAudienceKind: "team",
    callWorkforceRpc: async () => ({
      data: {
        audience: { audience: "own", label: "Cá nhân", team_ids: [], recruiter_id: uuid(9) },
      },
    }),
  });
  assert.equal(mismatchRes.status, "unavailable");

  // 3. Broken snapshot invariant (on + unconfirmed + off + unknown !== eligibleEpisodeTotal) -> status: "unavailable"
  const brokenInvariant = parseWorkforceReportingPayload({
    snapshot: {
      as_of_date: "2026-10-10",
      as_of_source: "filter_to",
      eligible_episode_total: 10,
      on_count: 4,
      unconfirmed_count: 2,
      off_count: 1,
      unknown_count: 0,
      future_episode_count: 0,
    },
    transitions: {
      applicable: false,
      reason: "all_time",
      from_date: null,
      to_date: null,
    },
  });
  assert.equal(brokenInvariant.status, "unavailable");
  assert.equal(brokenInvariant.reason, "snapshot_sum_invariant_violated");

  // 4. All-time / one-sided filter rules for asOfDate and transitions.applicable:
  const allTimeAsOf = resolveWorkforceAsOfDate(
    {},
    { referenceDate: new Date("2026-10-22T03:00:00.000Z") },
  );
  assert.equal(allTimeAsOf.asOfDate, "2026-10-22");
  assert.equal(allTimeAsOf.asOfSource, "current_hcm_date");

  const oneSided = evaluateWorkforceSnapshotAndTransitions({
    episodes: [],
    events: [],
    filters: { from: "2026-10-01" },
    referenceDate: new Date("2026-10-22T03:00:00.000Z"),
  });
  assert.equal(oneSided.snapshot.asOfDate, "2026-10-22");
  assert.equal(oneSided.snapshot.asOfSource, "current_hcm_date");
  assert.equal(oneSided.transitions.applicable, false);
  if (!oneSided.transitions.applicable) {
    assert.equal(oneSided.transitions.reason, "one_sided");
    assert.equal(oneSided.transitions.windowLabel, formatWorkforceTransitionsNotApplicableLabel("one_sided"));
  }
});
