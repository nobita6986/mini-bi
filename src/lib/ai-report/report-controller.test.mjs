/**
 * P1.5-W05-S01-R2 — Behavioral flow test CHO CONTROLLER THẬT panel dùng (không render tĩnh):
 * capability ready -> submit -> enqueue UUID -> poll active -> poll draft -> analysis/lifecycle/history cập nhật.
 * Kèm case malformed draft, close khi poll đang bay, switch job khi poll cũ đang bay (generation cancellation).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createReportController } from "./report-controller.ts";

const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";
const REV = "33333333-3333-4333-8333-333333333333";

function capabilityResponse() {
  return { ok: true, ai_enabled: true, config_ready: true, review: { approve: false, reject: false, regenerate: true, reason: "review_rpc_pending" } };
}

function enqueueResponse(jobId) {
  return { ok: true, request_id: jobId, job_id: jobId, status: "requested", reused: false, cache_hit: false, revision_id: null };
}

function activeResponse(jobId) {
  return { ok: true, job_id: jobId, status: "ai_generating", error_code: null, attempts: 1, max_attempts: 3, revision: null, review_capability: { approve: false, reject: false, regenerate: true, reason: "review_rpc_pending" } };
}

function draftResponse(jobId) {
  return {
    ok: true,
    job_id: jobId,
    status: "draft",
    error_code: null,
    attempts: 1,
    max_attempts: 3,
    revision: {
      revision_id: REV,
      revision_number: 1,
      lifecycle_status: "draft",
      contract_version: "business-analysis/0.1",
      created_at: "2026-10-02T00:00:00.000Z",
      analysis: {
        contract_version: "business-analysis/0.1",
        period_ref: "week:2026-W41",
        executive_analysis: "Tuyển dụng tuần này tăng nhẹ.",
        executive_evidence_refs: ["ev_01"],
        findings: [
          { finding_id: "f_01", category: "driver", subject_ref: "project_01", headline: "Dự án A dẫn đầu", analysis: "Dự án A tuyển 5 người.", evidence_refs: ["ev_02"], confidence: "medium", limitations: [], recommended_action: null },
        ],
        overall_limitations: ["Chất lượng dữ liệu chưa đầy đủ ở một nguồn"],
      },
    },
    review_capability: { approve: false, reject: false, regenerate: true, reason: "review_rpc_pending" },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function fakeFetch() {
  const calls = [];
  const pending = [];
  const fetchJson = (path, options) => {
    calls.push({ path, options });
    const d = deferred();
    pending.push({ path, options, d });
    return d.promise;
  };
  return { fetchJson, calls, pending };
}

function manualScheduler() {
  const tasks = [];
  const schedule = {
    set: (fn, ms) => { const t = { fn, ms, done: false }; tasks.push(t); return t; },
    clear: (handle) => { handle.done = true; },
    pendingCount: () => tasks.filter((t) => !t.done).length,
    runNext: () => { const t = tasks.find((x) => !x.done); if (!t) return false; t.done = true; t.fn(); return true; },
  };
  return schedule;
}

test("S01-R2-F1: flow thật — capability ready → enqueue → poll active → poll draft → analysis/lifecycle/history", async () => {
  const fetch = fakeFetch();
  const schedule = manualScheduler();
  const events = { capability: null, jobs: [] };
  const ctrl = createReportController({
    fetchJson: fetch.fetchJson,
    schedule,
    events: {
      onCapability: (cap, err) => { events.capability = cap; events.capError = err; },
      onJob: (id, view, err) => { events.jobs.push({ id, view, err }); },
    },
  });

  const capPromise = ctrl.loadCapability();
  assert.equal(events.capability, null, "capability fetch còn pending");
  fetch.pending[0].d.resolve({ ok: true, httpStatus: 200, code: "AI_INTERNAL", record: capabilityResponse() });
  await capPromise;
  assert.equal(events.capability.ai_enabled, true);
  assert.equal(events.capability.review.regenerate, true);

  const enqueuePromise = ctrl.enqueue({ period: { type: "week", as_of_date: "2026-10-11" }, scope: { dimensions: ["project"] } });
  fetch.pending[1].d.resolve({ ok: true, httpStatus: 202, code: "AI_INTERNAL", record: enqueueResponse(JOB_A) });
  const enqueued = await enqueuePromise;
  assert.equal(enqueued.ok, true);
  assert.equal(enqueued.jobId, JOB_A);

  // Poll lần 1 (do enqueue tự startPolling lịch chạy 0ms) -> active.
  assert.equal(schedule.runNext(), true);
  assert.equal(fetch.pending[2].path.includes(JOB_A), true);
  fetch.pending[2].d.resolve({ ok: true, httpStatus: 200, code: "AI_INTERNAL", record: activeResponse(JOB_A) });
  await Promise.resolve();
  assert.equal(events.jobs.length, 1, "poll active phải emit onJob");
  assert.equal(events.jobs[0].view.status, "ai_generating");
  assert.equal(events.jobs[0].view.revision, null);
  assert.equal(schedule.pendingCount() >= 1, true, "active phải lịch poll kế tiếp");

  // Poll lần 2 -> draft.
  assert.equal(schedule.runNext(), true);
  fetch.pending[3].d.resolve({ ok: true, httpStatus: 200, code: "AI_INTERNAL", record: draftResponse(JOB_A) });
  await Promise.resolve();
  assert.equal(events.jobs.length, 2);
  assert.equal(events.jobs[1].view.status, "draft");
  assert.equal(events.jobs[1].view.revision.lifecycle_status, "draft");
  assert.equal(events.jobs[1].view.revision.analysis.executive_analysis, "Tuyển dụng tuần này tăng nhẹ.");
  assert.equal(events.jobs[1].view.revision.analysis.findings.length, 1);
  assert.equal(schedule.pendingCount(), 0, "draft là terminal, không lịch poll mới");
});

test("S01-R2-F2: malformed draft ⇒ onJob lỗi, dừng, không đặt timer mới", async () => {
  const fetch = fakeFetch();
  const schedule = manualScheduler();
  const events = { jobs: [] };
  const ctrl = createReportController({ fetchJson: fetch.fetchJson, schedule, events: { onCapability: () => {}, onJob: (id, view, err) => { events.jobs.push({ id, view, err }); } } });

  const enqueuePromise = ctrl.enqueue({});
  fetch.pending[0].d.resolve({ ok: true, httpStatus: 202, code: "AI_INTERNAL", record: enqueueResponse(JOB_A) });
  await enqueuePromise;

  schedule.runNext(); // poll 1
  const malformed = draftResponse(JOB_A);
  malformed.revision.analysis.findings = "boom"; // sai kiểu
  fetch.pending[1].d.resolve({ ok: true, httpStatus: 200, code: "AI_INTERNAL", record: malformed });
  await Promise.resolve();
  assert.equal(events.jobs.length, 1);
  assert.equal(events.jobs[0].view, null);
  assert.equal(events.jobs[0].err.includes("không hợp lệ"), true);
  assert.equal(schedule.pendingCount(), 0, "malformed phải dừng");
});

test("S01-R2-F3: close khi poll đang bay — response cũ TUYỆT ĐỐI không áp dụng, không đặt timer mới", async () => {
  const fetch = fakeFetch();
  const schedule = manualScheduler();
  const events = { jobs: [] };
  const ctrl = createReportController({ fetchJson: fetch.fetchJson, schedule, events: { onCapability: () => {}, onJob: (id, view, err) => { events.jobs.push({ id, view, err }); } } });

  ctrl.startPolling(JOB_A);
  schedule.runNext(); // poll A đang bay (pending[0])
  assert.equal(fetch.pending[0].path.includes(JOB_A), true);

  ctrl.stopPolling(); // đóng drawer
  assert.equal(fetch.pending[0].options.signal.aborted, true, "request đang bay phải bị abort");

  fetch.pending[0].d.resolve({ ok: true, httpStatus: 200, code: "AI_INTERNAL", record: draftResponse(JOB_A) });
  await Promise.resolve();
  assert.equal(events.jobs.length, 0, "response cũ không được áp dụng");
  assert.equal(schedule.pendingCount(), 0, "không đặt timer mới sau khi đóng");
});

test("S01-R2-F4: switch job khi poll cũ đang bay — job mới thắng, response cũ không ghi đè", async () => {
  const fetch = fakeFetch();
  const schedule = manualScheduler();
  const events = { jobs: [] };
  const ctrl = createReportController({ fetchJson: fetch.fetchJson, schedule, events: { onCapability: () => {}, onJob: (id, view, err) => { events.jobs.push({ id, view, err }); } } });

  ctrl.startPolling(JOB_A);
  schedule.runNext(); // A đang bay (pending[0])

  ctrl.startPolling(JOB_B); // switch: gen++ cho A, abort A, lịch B
  schedule.runNext(); // B đang bay (pending[1])
  assert.equal(fetch.pending[1].path.includes(JOB_B), true);

  // A về trước (stale) => bị bỏ.
  fetch.pending[0].d.resolve({ ok: true, httpStatus: 200, code: "AI_INTERNAL", record: draftResponse(JOB_A) });
  await Promise.resolve();
  assert.equal(events.jobs.length, 0, "response của A (cũ) không được áp dụng");

  // B về sau => áp dụng.
  fetch.pending[1].d.resolve({ ok: true, httpStatus: 200, code: "AI_INTERNAL", record: draftResponse(JOB_B) });
  await Promise.resolve();
  assert.equal(events.jobs.length, 1);
  assert.equal(events.jobs[0].id, JOB_B);
  assert.equal(events.jobs[0].view.revision.lifecycle_status, "draft");
});
