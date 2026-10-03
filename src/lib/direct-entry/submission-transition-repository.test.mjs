import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySubmissionTransitionError,
  createSubmissionTransitionRepository,
} from "./submission-transition-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const submissionId = "b1000000-0000-4000-8000-000000000001";

function input(overrides = {}) {
  return {
    ...actor,
    submission_id: submissionId,
    expected_version: 3,
    target_state: "REVIEW",
    idempotency_key: "submission-transition-synthetic-key",
    ...overrides,
  };
}

test("repository calls only the existing transition RPC with server actor and projects strictly", async () => {
  const calls = [];
  const repository = createSubmissionTransitionRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: { submission_id: submissionId, state: "REVIEW", version: 4 }, error: null };
  });
  const result = await repository.transitionSubmission(input());
  assert.deepEqual(result, {
    ok: true,
    data: { submission_id: submissionId, state: "REVIEW", version: 4 },
  });
  assert.deepEqual(calls, [{
    name: "direct_entry_transition_submission",
    args: {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_submission_id: submissionId,
      p_expected_version: 3,
      p_target_state: "REVIEW",
      p_idempotency_key: "submission-transition-synthetic-key",
    },
  }]);
});

test("REVIEW -> DRAFT and REVIEW -> SUBMITTED pass the target state through unchanged", async () => {
  const calls = [];
  const repository = createSubmissionTransitionRepository(async (name, args) => {
    calls.push(args);
    return { data: { submission_id: submissionId, state: args.p_target_state, version: 4 }, error: null };
  });
  assert.deepEqual(await repository.transitionSubmission(input({ target_state: "DRAFT" })), {
    ok: true,
    data: { submission_id: submissionId, state: "DRAFT", version: 4 },
  });
  assert.deepEqual(await repository.transitionSubmission(input({ target_state: "SUBMITTED" })), {
    ok: true,
    data: { submission_id: submissionId, state: "SUBMITTED", version: 4 },
  });
  assert.deepEqual(calls.map((call) => call.p_target_state), ["DRAFT", "SUBMITTED"]);
});

test("database denial codes are preserved as sanitized kinds", async () => {
  assert.equal(classifySubmissionTransitionError({ code: "40001" }), "conflict");
  assert.equal(classifySubmissionTransitionError({ code: "23505" }), "conflict");
  assert.equal(classifySubmissionTransitionError({ code: "42501" }), "denied");
  assert.equal(classifySubmissionTransitionError({ code: "P0002" }), "not-found");
  assert.equal(classifySubmissionTransitionError({ code: "23514" }), "invalid");
  assert.equal(classifySubmissionTransitionError({ code: "22023", message: "submission transition cannot be a no-op" }), "invalid");
  assert.equal(classifySubmissionTransitionError({ code: "22023", message: "idempotency key reused with different input" }), "conflict");
  assert.equal(classifySubmissionTransitionError({ code: "XX000", message: "internal" }), "unavailable");
  assert.equal(classifySubmissionTransitionError({}), "unavailable");

  for (const [error, kind] of [
    [{ code: "40001" }, "conflict"],
    [{ code: "42501" }, "denied"],
    [{ code: "P0002" }, "not-found"],
    [{ code: "23514" }, "invalid"],
    [{ code: "ZZZZZ" }, "unavailable"],
  ]) {
    const repository = createSubmissionTransitionRepository(async () => ({ data: null, error }));
    const result = await repository.transitionSubmission(input());
    assert.deepEqual(result, { ok: false, kind }, JSON.stringify(error));
    assert.equal("data" in result, false);
  }
});

test("DRAFT -> SUBMITTED database denial is never converted into success", async () => {
  const repository = createSubmissionTransitionRepository(async () => ({
    data: null,
    error: { code: "40001", message: "invalid submission mutation or stale version" },
  }));
  assert.deepEqual(await repository.transitionSubmission(input({ target_state: "SUBMITTED" })), {
    ok: false,
    kind: "conflict",
  });
});

test("malformed or unknown RPC payloads fail closed without returning raw data", async () => {
  const payloads = [
    null,
    [],
    "REVIEW",
    { submission_id: submissionId, state: "REVIEW" },
    { submission_id: submissionId, state: "REVIEW", version: 4, reused: true },
    { submission_id: submissionId, state: "REVIEW", version: 4, submitted_at: "2026-10-03T00:00:00Z" },
    { submission_id: submissionId, state: "review", version: 4 },
    { submission_id: submissionId, state: "REVIEW", version: 5 },
    { submission_id: "b1000000-0000-4000-8000-000000000002", state: "REVIEW", version: 4 },
  ];
  for (const payload of payloads) {
    const repository = createSubmissionTransitionRepository(async () => ({ data: payload, error: null }));
    assert.deepEqual(
      await repository.transitionSubmission(input()),
      { ok: false, kind: "unavailable" },
      JSON.stringify(payload),
    );
  }
});

test("transport failures are sanitized and never leak the raw error", async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const repository = createSubmissionTransitionRepository(async () => {
      throw new Error("private submission b1000000 detail");
    });
    const result = await repository.transitionSubmission(input());
    assert.deepEqual(result, { ok: false, kind: "unavailable" });
    assert.doesNotMatch(JSON.stringify(result), /b1000000|private/);
    assert.doesNotMatch(logged.join(" "), /b1000000|private/);
  } finally {
    console.error = originalError;
  }
});
