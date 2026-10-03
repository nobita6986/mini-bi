/**
 * P1.5-W05-S02 — Test projection thuần cho review/history.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { projectHistoryResponse, projectReviewCapability, projectReviewRequest, projectReviewResponse, REVIEW_RPC_READY, REVIEW_RPC_UNAVAILABLE } from "./review-projection.ts";

test("S02-P1: projectReviewResponse — approve/reject hợp lệ + malformed fail-closed", () => {
  const ok = projectReviewResponse({ ok: true, revision_id: "11111111-1111-4111-8111-111111111111", lifecycle_status: "approved", idempotent: false });
  assert.equal(ok.ok, true);
  assert.equal(ok.lifecycle_status, "approved");

  const bad = [
    [{ ok: true, revision_id: "not-uuid", lifecycle_status: "approved", idempotent: false }],
    [{ ok: true, revision_id: "11111111-1111-4111-8111-111111111111", lifecycle_status: "draft", idempotent: false }],
    [{ ok: true, revision_id: "11111111-1111-4111-8111-111111111111", lifecycle_status: "approved" }],
    [null],
    [{ ok: false, code: "AI_REVIEW_CONFLICT" }],
  ];
  for (const raw of bad) {
    const result = projectReviewResponse(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, "AI_INTERNAL");
  }
});

test("S02-P2: projectReviewRequest — decision/expected/reason nghiêm ngặt", () => {
  assert.deepEqual(projectReviewRequest({ decision: "approve", expected_revision_number: 1 }), { ok: true, decision: "approve", expected_revision_number: 1, reason: null });
  assert.equal(projectReviewRequest({ decision: "reject", expected_revision_number: 2, reason: "Lý do hợp lệ" }).ok, true);

  const bad = [
    [{ decision: "publish", expected_revision_number: 1 }],
    [{ decision: "approve" }],
    [{ decision: "approve", expected_revision_number: 0 }],
    [{ decision: "approve", expected_revision_number: "1" }],
    [{ decision: "reject", expected_revision_number: 1 }],
    [{ decision: "reject", expected_revision_number: 1, reason: "x" }],
    [{ decision: "reject", expected_revision_number: 1, reason: "y".repeat(301) }],
    [null],
  ];
  for (const raw of bad) {
    const result = projectReviewRequest(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, "AI_INPUT_INVALID");
  }
});

test("S02-P3: projectHistoryResponse — projection + malformed fail-closed", () => {
  const item = {
    job_id: "11111111-1111-4111-8111-111111111111",
    status: "draft",
    created_at: "2026-10-01T00:00:00Z",
    completed_at: null,
    provider_key: "scripted",
    model_key: "scripted-deterministic-v1",
    revision_id: "22222222-2222-4222-8222-222222222222",
    revision_number: 1,
    lifecycle_status: "draft",
    period: { type: "week", as_of_date: "2026-10-11" },
    dimensions: ["project", "provider"],
    focus: null,
  };
  const ok = projectHistoryResponse({ ok: true, items: [item], next_cursor: "33333333-3333-4333-8333-333333333333", has_more: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.items.length, 1);
  assert.deepEqual(ok.items[0].period, { type: "week", as_of_date: "2026-10-11", custom_from: null, custom_to: null });
  assert.equal(ok.has_more, true);

  const bad = [
    [{ ok: true, items: "nope", next_cursor: null, has_more: false }],
    [{ ok: true, items: [{ ...item, job_id: "bad" }], next_cursor: null, has_more: false }],
    [{ ok: true, items: [{ ...item, status: "weird" }], next_cursor: null, has_more: false }],
    [{ ok: true, items: [{ ...item, dimensions: "x" }], next_cursor: null, has_more: false }],
    [{ ok: true, items: [{ ...item, period: null }], next_cursor: null, has_more: false }],
    [{ ok: true, items: [{ ...item, period: { type: "week", as_of_date: "2026-02-30" } }], next_cursor: null, has_more: false }],
    [{ ok: true, items: [item], next_cursor: null }],
  ];
  for (const raw of bad) {
    const result = projectHistoryResponse(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, "AI_INTERNAL");
  }
});

test("S02-P4: projectReviewCapability — strict boolean + fail-closed all false khi malformed", () => {
  const ready = projectReviewCapability({ ok: true, approve: true, reject: true, regenerate: true });
  assert.deepEqual(ready, { approve: true, reject: true, regenerate: true, reason: REVIEW_RPC_READY });

  // Thiếu/sai kiểu bất kỳ boolean nào ⇒ fail-closed cả ba false + reason unavailable.
  const bad = [
    [null],
    [{ ok: true }],
    [{ ok: true, approve: true, reject: true }],
    [{ ok: true, approve: true, reject: true, regenerate: "true" }],
    [{ ok: true, approve: 1, reject: true, regenerate: true }],
    [{ ok: true, approve: true, reject: false, regenerate: null }],
    [{ ok: false, approve: true, reject: true, regenerate: true }],
  ];
  for (const raw of bad) {
    const result = projectReviewCapability(raw);
    assert.deepEqual(result, { approve: false, reject: false, regenerate: false, reason: REVIEW_RPC_UNAVAILABLE }, JSON.stringify(raw));
  }
});
