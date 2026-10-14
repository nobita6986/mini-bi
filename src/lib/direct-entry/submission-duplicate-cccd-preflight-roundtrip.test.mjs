/**
 * P3.1-HF-R2 - Regression: duplicate-CCCD preflight wire contract round-trip.
 *
 * Production bug: the preflight API added a sixth internal key
 * (employment_status_label) to every conflict item, but the strict client
 * projection allows exactly the five wire keys, so projectDuplicateCccdPreflight()
 * returned null and the UI showed the generic error instead of the confirmation
 * dialog. This test drives the real repository -> API -> client-projection path.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { duplicateCccdPreflight } from "./submission-duplicate-cccd-api.ts";
import {
  DUPLICATE_CCCD_CONFLICT_KEYS,
  projectDuplicateCccdPreflight,
} from "./submission-duplicate-cccd-contract.ts";
import { createDuplicateCccdPreflightRepository } from "./submission-duplicate-cccd-repository.ts";
import {
  findForbiddenClientField,
  projectSubmissionTransitionRequest,
} from "./submission-transition-contract.ts";

const ACTOR = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const SUBMISSION_ID = "b1000000-0000-4000-8000-000000000001";
const FINGERPRINT = "a".repeat(64);

const WIRE_CONFLICT_KEYS = [
  "cccd_last4", "conflict_ref", "draft_display_name", "employment_status", "project_display",
];

function rawRpcPayload(overrides = {}) {
  return {
    submission_id: SUBMISSION_ID,
    version: 1,
    fingerprint: FINGERPRINT,
    conflict_count: 2,
    conflicts: [
      {
        conflict_ref: "0123456789ab",
        draft_display_name: "Nguyen Van Draft",
        project_display: "Project A",
        employment_status: "ON",
        cccd_last4: "8901",
      },
      {
        conflict_ref: "abcdef012345",
        draft_display_name: "Tran Thi Draft",
        project_display: null,
        employment_status: "UNCONFIRMED",
        cccd_last4: "1234",
      },
    ],
    ...overrides,
  };
}

function repositoryReturning(payload) {
  return createDuplicateCccdPreflightRepository(async () => ({ data: payload, error: null }));
}

async function resolveSession() {
  return { actor: { ok: true, actor: ACTOR }, response_headers: {} };
}

async function preflightBody(payload) {
  const response = await duplicateCccdPreflight(
    new Request("http://localhost/preflight"),
    SUBMISSION_ID,
    "true",
    { resolveSession, repository: repositoryReturning(payload) },
  );
  const body = await response.json();
  return { response, body };
}

// Mirrors direct-entry-live.tsx: the client picks the five keys out of the
// response envelope (dropping `ok`) and never sends the whole body.
function clientProjection(body) {
  return projectDuplicateCccdPreflight({
    submission_id: body.submission_id,
    version: body.version,
    fingerprint: body.fingerprint,
    conflict_count: body.conflict_count,
    conflicts: body.conflicts,
  }, { submission_id: SUBMISSION_ID });
}

test("HF-R2: repository result -> API response -> client projection round-trips", async () => {
  const { response, body } = await preflightBody(rawRpcPayload());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(body.conflict_count, 2);

  assert.equal(body.conflicts.length, 2);
  for (const item of body.conflicts) {
    assert.deepEqual(Object.keys(item).sort(), WIRE_CONFLICT_KEYS);
    assert.equal("employment_status_label" in item, false);
  }

  const projected = clientProjection(body);
  assert.notEqual(projected, null);
  assert.equal(projected.conflict_count, 2);
  assert.equal(projected.conflicts[0].employment_status_label, "Đang làm việc");
  assert.equal(projected.conflicts[1].employment_status_label, "Đang chờ việc");
  assert.deepEqual(
    Object.keys(projected.conflicts[0]).sort(),
    [...DUPLICATE_CCCD_CONFLICT_KEYS, "employment_status_label"].sort(),
  );
});

test("HF-R2: a positive conflict_count reaches the confirmation path, not a generic failure", async () => {
  const { response, body } = await preflightBody(rawRpcPayload());
  assert.equal(response.status, 200);
  const projected = clientProjection(body);
  assert.notEqual(projected, null);
  assert.ok(projected.conflict_count > 0);
  assert.ok(projected.conflicts.length > 0);
});

test("HF-R2: acknowledgement carries fingerprint + count and no raw CCCD or forbidden field", async () => {
  const { body } = await preflightBody(rawRpcPayload());
  const projected = clientProjection(body);
  const acknowledgement = {
    expected_version: projected.version,
    target_state: "REVIEW",
    idempotency_key: "ack-key-hf-r2",
    duplicate_cccd_fingerprint: projected.fingerprint,
    duplicate_cccd_count: projected.conflict_count,
  };
  const parsed = projectSubmissionTransitionRequest(acknowledgement);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.duplicate_cccd_fingerprint, FINGERPRINT);
  assert.equal(parsed.value.duplicate_cccd_count, 2);
  assert.equal(findForbiddenClientField(acknowledgement), null);
  const text = JSON.stringify(acknowledgement);
  assert.equal(/[0-9]{8,}/.test(text), false);
  assert.equal(text.includes("8901"), false);
  assert.equal(text.includes("1234"), false);
});

test("HF-R2: the strict projection keeps rejecting any extra wire key", async () => {
  const { body } = await preflightBody(rawRpcPayload());
  const mutatedConflicts = body.conflicts.map((item) => ({
    ...item,
    employment_status_label: "Đang làm việc",
  }));
  assert.equal(projectDuplicateCccdPreflight({
    submission_id: body.submission_id,
    version: body.version,
    fingerprint: body.fingerprint,
    conflict_count: body.conflict_count,
    conflicts: mutatedConflicts,
  }, { submission_id: SUBMISSION_ID }), null);
});
