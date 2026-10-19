import assert from "node:assert/strict";
import test from "node:test";

import { deleteDraftSubmission } from "./submission-delete-api.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
  capabilities: ["submission_create"],
};
const submissionId = "b1000000-0000-4000-8000-000000000001";
const idempotencyKey = "submission-delete-synthetic-key";

function request(body, headers = {}) {
  return new Request(`https://example.test/api/direct-entry/submissions/${submissionId}`, {
    method: "DELETE",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function dependencies(overrides = {}) {
  const calls = [];
  let sessions = 0;
  return {
    calls,
    sessionCount: () => sessions,
    resolveSession: async () => {
      sessions += 1;
      return { actor: { ok: true, actor }, response_headers: {} };
    },
    repository: {
      async deleteDraftSubmission(input) {
        calls.push(input);
        return {
          ok: true,
          data: {
            submission_id: input.submission_id,
            deleted: true,
            version: input.expected_version + 1,
            entries_deleted: 2,
            cleanup_objects_queued: 3,
          },
        };
      },
      ...overrides,
    },
  };
}

test("gate, CSRF, path, query, body, idempotency and authority fail before session/RPC", async () => {
  const deps = dependencies();
  assert.equal((await deleteDraftSubmission(request({ expected_version: 3 }), submissionId, undefined, deps)).status, 404);
  assert.equal((await deleteDraftSubmission(
    request({ expected_version: 3 }, { origin: "https://attacker.test" }), submissionId, "true", deps,
  )).status, 403);
  assert.equal((await deleteDraftSubmission(request({ expected_version: 3 }), "bad-id", "true", deps)).status, 400);
  assert.equal((await deleteDraftSubmission(
    new Request("https://example.test/api/direct-entry/submissions/" + submissionId + "?actor=other", {
      method: "DELETE",
      headers: {
        origin: "https://example.test", host: "example.test",
        "content-type": "application/json", "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ expected_version: 3 }),
    }), submissionId, "true", deps,
  )).status, 400);
  assert.equal((await deleteDraftSubmission(
    request({ expected_version: 3 }, { "content-type": "text/plain" }), submissionId, "true", deps,
  )).status, 400);
  assert.equal((await deleteDraftSubmission(request("not json"), submissionId, "true", deps)).status, 400);
  assert.equal((await deleteDraftSubmission(request({ expected_version: 3, actor }), submissionId, "true", deps)).status, 400);
  assert.equal((await deleteDraftSubmission(
    request({ expected_version: 3 }, { "idempotency-key": " " }), submissionId, "true", deps,
  )).status, 400);
  assert.equal(deps.sessionCount(), 0);
  assert.equal(deps.calls.length, 0);
});

test("server session actor is the sole actor sent to the repository", async () => {
  const deps = dependencies();
  const response = await deleteDraftSubmission(
    request({ expected_version: 3, app_user_id: "client-controlled" }), submissionId, "true", deps,
  );
  assert.equal(response.status, 400);
  const valid = await deleteDraftSubmission(request({ expected_version: 3 }), submissionId, "true", deps);
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), {
    ok: true,
    submission_id: submissionId,
    deleted: true,
    version: 4,
    entries_deleted: 2,
    cleanup_objects_queued: 3,
  });
  assert.deepEqual(deps.calls, [{
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    submission_id: submissionId,
    expected_version: 3,
    idempotency_key: idempotencyKey,
  }]);
  assert.equal(valid.headers.get("cache-control"), "private, no-store");
});

test("session and database denials return sanitized errors", async () => {
  const noSession = dependencies();
  noSession.resolveSession = async () => ({ actor: { ok: false, reason: "UNAUTHENTICATED" } });
  assert.equal((await deleteDraftSubmission(
    request({ expected_version: 3 }), submissionId, "true", noSession,
  )).status, 401);
  for (const [kind, status, code] of [
    ["denied", 403, "SUBMISSION_DELETE_DENIED"],
    ["not-found", 404, "SUBMISSION_NOT_FOUND"],
    ["conflict", 409, "SUBMISSION_CONFLICT"],
    ["processing", 409, "SUBMISSION_PROCESSING"],
    ["invalid", 400, "SUBMISSION_DELETE_INVALID"],
    ["unavailable", 500, "SUBMISSION_DELETE_UNAVAILABLE"],
  ]) {
    const deps = dependencies({
      async deleteDraftSubmission() { return { ok: false, kind }; },
    });
    const response = await deleteDraftSubmission(
      request({ expected_version: 3 }), submissionId, "true", deps,
    );
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { ok: false, code });
  }
});
