import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDuplicateCccdPreflightError,
  createDuplicateCccdPreflightRepository,
} from "./submission-duplicate-cccd-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const submissionId = "b1000000-0000-4000-8000-000000000001";
const fingerprint = "a".repeat(64);

function validData(overrides = {}) {
  return {
    submission_id: submissionId,
    version: 2,
    fingerprint,
    conflict_count: 1,
    conflicts: [{
      conflict_ref: "0123456789ab",
      draft_display_name: "Nguyen Van Draft",
      project_display: "Project A",
      employment_status: "ON",
      cccd_last4: "8901",
    }],
    ...overrides,
  };
}

test("the repository calls only the preflight RPC with the server actor", async () => {
  const calls = [];
  const repository = createDuplicateCccdPreflightRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: validData(), error: null };
  });
  const result = await repository.preflight({ ...actor, submission_id: submissionId });
  assert.equal(result.ok, true);
  assert.equal(result.data.conflict_count, 1);
  assert.equal(result.data.conflicts[0].employment_status_label, "Đang làm việc");
  assert.deepEqual(calls, [{
    name: "direct_entry_submission_duplicate_cccd_preflight",
    args: {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_submission_id: submissionId,
    },
  }]);
});

test("database denial codes are preserved as sanitized kinds", async () => {
  assert.equal(classifyDuplicateCccdPreflightError({ code: "42501" }), "denied");
  assert.equal(classifyDuplicateCccdPreflightError({ code: "P0002" }), "not-found");
  assert.equal(classifyDuplicateCccdPreflightError({ code: "22023" }), "invalid");
  assert.equal(classifyDuplicateCccdPreflightError({ code: "XX000" }), "unavailable");
  assert.equal(classifyDuplicateCccdPreflightError({}), "unavailable");
  for (const [error, kind] of [
    [{ code: "42501" }, "denied"],
    [{ code: "P0002" }, "not-found"],
    [{ code: "22023" }, "invalid"],
    [{ code: "ZZZZZ" }, "unavailable"],
  ]) {
    const repository = createDuplicateCccdPreflightRepository(async () => ({ data: null, error }));
    const result = await repository.preflight({ ...actor, submission_id: submissionId });
    assert.deepEqual(result, { ok: false, kind }, JSON.stringify(error));
    assert.equal("data" in result, false);
  }
});

test("malformed payloads fail closed and transport failures never leak the raw error", async () => {
  const payloads = [
    null,
    [],
    "REVIEW",
    validData({ submission_id: "b1000000-0000-4000-8000-000000000002" }),
    validData({ fingerprint: "A".repeat(64) }),
    validData({ version: 0 }),
    validData({ conflict_count: 0 }),
    validData({ conflicts: [{ ...validData().conflicts[0], extra: 1 }] }),
    validData({ conflicts: [{ ...validData().conflicts[0], employment_status: "OFF" }] }),
  ];
  for (const payload of payloads) {
    const repository = createDuplicateCccdPreflightRepository(async () => ({ data: payload, error: null }));
    assert.deepEqual(
      await repository.preflight({ ...actor, submission_id: submissionId }),
      { ok: false, kind: "unavailable" },
      JSON.stringify(payload),
    );
  }

  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const repository = createDuplicateCccdPreflightRepository(async () => {
      throw new Error("private submission b1000000 detail");
    });
    const result = await repository.preflight({ ...actor, submission_id: submissionId });
    assert.deepEqual(result, { ok: false, kind: "unavailable" });
    assert.doesNotMatch(JSON.stringify(result), /b1000000|private/);
    assert.doesNotMatch(logged.join(" "), /b1000000|private/);
  } finally {
    console.error = originalError;
  }
});
