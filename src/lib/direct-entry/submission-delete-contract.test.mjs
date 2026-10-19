import assert from "node:assert/strict";
import test from "node:test";

import {
  projectSubmissionDeleteRequest,
  projectSubmissionDeleteResult,
  SUBMISSION_DELETE_RESULT_KEYS,
} from "./submission-delete-contract.ts";

const submissionId = "b1000000-0000-4000-8000-000000000001";

test("delete request accepts only expected version", () => {
  assert.deepEqual(projectSubmissionDeleteRequest({ expected_version: 3 }), { expected_version: 3 });
  for (const invalid of [
    null,
    [],
    {},
    { expected_version: 0 },
    { expected_version: 1.5 },
    { expected_version: 3, actor: "untrusted" },
    { expected_version: 3, idempotency_key: "key-in-body" },
  ]) assert.equal(projectSubmissionDeleteRequest(invalid), null, JSON.stringify(invalid));
});

test("delete result is exact and tied to the expected version", () => {
  const result = {
    submission_id: submissionId,
    deleted: true,
    version: 4,
    entries_deleted: 2,
    cleanup_objects_queued: 3,
  };
  assert.deepEqual(projectSubmissionDeleteResult(result, {
    submission_id: submissionId,
    expected_version: 3,
  }), result);
  assert.deepEqual(SUBMISSION_DELETE_RESULT_KEYS, [
    "cleanup_objects_queued", "deleted", "entries_deleted", "submission_id", "version",
  ]);
  assert.equal(projectSubmissionDeleteResult({ ...result, version: 5 }, {
    submission_id: submissionId,
    expected_version: 3,
  }), null);
  assert.equal(projectSubmissionDeleteResult({ ...result, storage_key: "private/key" }, {
    submission_id: submissionId,
    expected_version: 3,
  }), null);
});
