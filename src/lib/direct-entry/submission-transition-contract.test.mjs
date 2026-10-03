import assert from "node:assert/strict";
import test from "node:test";

import {
  SUBMISSION_STATES,
  SUBMISSION_TRANSITIONS,
  allowedTargetStates,
  findForbiddenClientField,
  isAllowedTransition,
  isSubmissionState,
  isTerminalSubmissionState,
  projectSubmissionTransitionRequest,
  projectSubmissionTransitionResult,
} from "./submission-transition-contract.ts";

const submissionId = "b1000000-0000-4000-8000-000000000001";

function validRequest(overrides = {}) {
  return {
    expected_version: 1,
    target_state: "REVIEW",
    idempotency_key: "submission-transition-synthetic-key",
    ...overrides,
  };
}

test("transition matrix: DRAFT -> REVIEW, REVIEW -> DRAFT, REVIEW -> SUBMITTED only", () => {
  assert.deepEqual([...SUBMISSION_STATES], ["DRAFT", "REVIEW", "SUBMITTED"]);
  assert.deepEqual([...allowedTargetStates("DRAFT")], ["REVIEW"]);
  assert.deepEqual([...allowedTargetStates("REVIEW")], ["DRAFT", "SUBMITTED"]);
  assert.deepEqual([...allowedTargetStates("SUBMITTED")], []);
  assert.equal(isAllowedTransition("DRAFT", "REVIEW"), true);
  assert.equal(isAllowedTransition("REVIEW", "DRAFT"), true);
  assert.equal(isAllowedTransition("REVIEW", "SUBMITTED"), true);
  assert.equal(isAllowedTransition("DRAFT", "SUBMITTED"), false);
  assert.equal(isAllowedTransition("SUBMITTED", "DRAFT"), false);
  assert.equal(isAllowedTransition("SUBMITTED", "REVIEW"), false);
  assert.equal(isAllowedTransition("SUBMITTED", "SUBMITTED"), false);
  assert.equal(isAllowedTransition("draft", "REVIEW"), false);
  assert.equal(isAllowedTransition("DRAFT", null), false);
  assert.equal(isTerminalSubmissionState("SUBMITTED"), true);
  assert.equal(isTerminalSubmissionState("REVIEW"), false);
  assert.equal(Object.isFrozen(SUBMISSION_TRANSITIONS), true);
  assert.equal(isSubmissionState("REVIEW"), true);
  assert.equal(isSubmissionState("review"), false);
});

test("exact valid requests pass for all three target states", () => {
  for (const target of ["REVIEW", "DRAFT", "SUBMITTED"]) {
    const result = projectSubmissionTransitionRequest(validRequest({ target_state: target }));
    assert.equal(result.ok, true, target);
    assert.deepEqual(result.value, {
      expected_version: 1,
      target_state: target,
      idempotency_key: "submission-transition-synthetic-key",
    });
  }
  const key = projectSubmissionTransitionRequest(validRequest({ idempotency_key: "9f1c2d3e-0000-4000-8000-000000000001" }));
  assert.equal(key.ok, true);
  assert.equal(key.value.idempotency_key, "9f1c2d3e-0000-4000-8000-000000000001");
});

test("unknown, missing and extra fields are rejected", () => {
  assert.deepEqual(projectSubmissionTransitionRequest(null), { ok: false, code: "SUBMISSION_TRANSITION_INVALID" });
  assert.equal(projectSubmissionTransitionRequest([]).ok, false);
  assert.equal(projectSubmissionTransitionRequest("REVIEW").ok, false);
  assert.equal(projectSubmissionTransitionRequest(validRequest({ extra: 1 })).ok, false);
  assert.equal(projectSubmissionTransitionRequest(validRequest({ reason: "vi sao" })).ok, false);
  const missing = validRequest();
  delete missing.idempotency_key;
  assert.deepEqual(projectSubmissionTransitionRequest(missing), { ok: false, code: "SUBMISSION_TRANSITION_INVALID" });
  const missingVersion = validRequest();
  delete missingVersion.expected_version;
  assert.equal(projectSubmissionTransitionRequest(missingVersion).ok, false);
  const missingState = validRequest();
  delete missingState.target_state;
  assert.equal(projectSubmissionTransitionRequest(missingState).ok, false);
});

test("authority and derived fields are rejected as forbidden, including nested ones", () => {
  for (const field of [
    "actor_id", "app_user_id", "auth_subject", "actor", "role", "roles",
    "capability", "capabilities", "scope", "scopes", "scope_kind", "team_id",
    "provider_type", "created_by_user_id", "owner_user_id", "user_id",
    "submitted_at", "submittedAt", "audit", "audit_event_id",
    "revision", "revision_id", "revision_number",
    "state", "version", "submission_version", "created_at", "updated_at",
  ]) {
    const result = projectSubmissionTransitionRequest(validRequest({ [field]: "spoof" }));
    assert.equal(result.ok, false, field);
    assert.equal(result.code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN", field);
    assert.equal(result.field, field, field);
  }
  const nested = projectSubmissionTransitionRequest(validRequest({ meta: { created_by_user_id: submissionId } }));
  assert.equal(nested.ok, false);
  assert.equal(nested.code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  assert.equal(nested.field, "meta.created_by_user_id");
  assert.deepEqual(findForbiddenClientField({ items: [{ ok: 1 }, { owner: "x" }] }), {
    field: "items[1].owner",
  });
  assert.equal(findForbiddenClientField({ expected_version: 1, target_state: "REVIEW" }), null);
});

test("malformed expected_version, target_state and idempotency_key fail closed", () => {
  for (const value of [0, -1, 1.5, "1", null, true, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = projectSubmissionTransitionRequest(validRequest({ expected_version: value }));
    assert.equal(result.ok, false, String(value));
    assert.equal(result.code, "SUBMISSION_TRANSITION_INVALID", String(value));
  }
  assert.equal(projectSubmissionTransitionRequest(validRequest({ expected_version: 2 ** 53 })).ok, false);
  assert.equal(projectSubmissionTransitionRequest(validRequest({ target_state: "review" })).ok, false);
  assert.equal(projectSubmissionTransitionRequest(validRequest({ target_state: "SUBMITTED " })).ok, false);
  assert.equal(projectSubmissionTransitionRequest(validRequest({ target_state: 3 })).ok, false);
  assert.equal(projectSubmissionTransitionRequest(validRequest({ target_state: null })).ok, false);
  for (const value of ["", "   ", 12, null, true, "x".repeat(129)]) {
    assert.equal(projectSubmissionTransitionRequest(validRequest({ idempotency_key: value })).ok, false);
  }
  assert.equal(projectSubmissionTransitionRequest(validRequest({ idempotency_key: "x".repeat(128) })).ok, true);
  assert.equal(projectSubmissionTransitionRequest(validRequest({ idempotency_key: "key\nvalue" })).ok, false);
});

test("result projection is exact and never trusts the raw RPC payload", () => {
  const expected = { submission_id: submissionId, expected_version: 4 };
  assert.deepEqual(
    projectSubmissionTransitionResult({ submission_id: submissionId, state: "REVIEW", version: 5 }, expected),
    { submission_id: submissionId, state: "REVIEW", version: 5 },
  );
  assert.deepEqual(
    projectSubmissionTransitionResult({ submission_id: submissionId, state: "SUBMITTED", version: 5 }, expected),
    { submission_id: submissionId, state: "SUBMITTED", version: 5 },
  );
  assert.equal(projectSubmissionTransitionResult(null, expected), null);
  assert.equal(projectSubmissionTransitionResult([], expected), null);
  assert.equal(projectSubmissionTransitionResult("REVIEW", expected), null);
  assert.equal(projectSubmissionTransitionResult({ submission_id: submissionId, state: "REVIEW", version: 5, reused: true }, expected), null);
  assert.equal(projectSubmissionTransitionResult({ submission_id: submissionId, state: "REVIEW", version: 5, submitted_at: "2026-10-03T00:00:00Z" }, expected), null);
  assert.equal(projectSubmissionTransitionResult({ submission_id: submissionId, state: "REVIEW" }, expected), null);
  assert.equal(projectSubmissionTransitionResult({ submission_id: "b1000000-0000-4000-8000-000000000002", state: "REVIEW", version: 5 }, expected), null);
  assert.equal(projectSubmissionTransitionResult({ submission_id: submissionId, state: "review", version: 5 }, expected), null);
  assert.equal(projectSubmissionTransitionResult({ submission_id: submissionId, state: "REVIEW", version: 6 }, expected), null);
  assert.equal(projectSubmissionTransitionResult({ submission_id: submissionId, state: "REVIEW", version: 4 }, expected), null);
  assert.equal(projectSubmissionTransitionResult({ submission_id: submissionId, state: "REVIEW", version: "5" }, expected), null);
});
