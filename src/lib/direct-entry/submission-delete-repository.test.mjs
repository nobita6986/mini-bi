import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySubmissionDeleteError,
  createSubmissionDeleteRepository,
} from "./submission-delete-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const submissionId = "b1000000-0000-4000-8000-000000000001";
const input = {
  ...actor,
  submission_id: submissionId,
  expected_version: 3,
  idempotency_key: "submission-delete-synthetic-key",
};
const success = {
  submission_id: submissionId,
  deleted: true,
  version: 4,
  entries_deleted: 2,
  cleanup_objects_queued: 3,
};

test("repository calls only the atomic delete RPC with server actor and strict projection", async () => {
  const calls = [];
  const repository = createSubmissionDeleteRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: success, error: null };
  });
  assert.deepEqual(await repository.deleteDraftSubmission(input), { ok: true, data: success });
  assert.deepEqual(calls, [{
    name: "direct_entry_delete_draft_submission",
    args: {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_submission_id: submissionId,
      p_expected_version: 3,
      p_idempotency_key: input.idempotency_key,
    },
  }]);
});

test("SQL state, ownership, version and processing errors are not conflated", async () => {
  for (const [code, message, kind] of [
    ["40001", "stale", "conflict"],
    ["55000", "not a draft", "conflict"],
    ["55P03", "document processing", "processing"],
    ["42501", "scope", "denied"],
    ["P0002", "missing", "not-found"],
    ["22023", "invalid idempotency key", "invalid"],
    ["22023", "idempotency key reused with different input", "conflict"],
    ["XX000", "private", "unavailable"],
  ]) {
    assert.equal(classifySubmissionDeleteError({ code, message }), kind, `${code} ${message}`);
    const repository = createSubmissionDeleteRepository(async () => ({
      data: null,
      error: { code, message },
    }));
    assert.deepEqual(await repository.deleteDraftSubmission(input), { ok: false, kind });
  }
});

test("malformed database response and transport failures fail closed", async () => {
  const invalid = createSubmissionDeleteRepository(async () => ({
    data: { ...success, scope: "all" },
    error: null,
  }));
  assert.deepEqual(await invalid.deleteDraftSubmission(input), {
    ok: false,
    kind: "unavailable",
  });
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const failing = createSubmissionDeleteRepository(async () => {
      throw new Error("private worker details");
    });
    assert.deepEqual(await failing.deleteDraftSubmission(input), {
      ok: false,
      kind: "unavailable",
    });
    assert.doesNotMatch(logs.join(" "), /private worker details/);
  } finally {
    console.error = originalError;
  }
});
