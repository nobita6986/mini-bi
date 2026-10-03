import assert from "node:assert/strict";
import test from "node:test";

import { transitionSubmission } from "./submission-transition-api.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
  capabilities: ["submission_create"],
  ok: true,
};
const submissionId = "b1000000-0000-4000-8000-000000000001";
const idempotencyKey = "submission-transition-synthetic-key";

function validBody(overrides = {}) {
  return {
    expected_version: 3,
    target_state: "REVIEW",
    idempotency_key: idempotencyKey,
    ...overrides,
  };
}

function request(body, headers = {}, id = submissionId) {
  return new Request(`https://example.test/api/direct-entry/submissions/${id}/transition`, {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function dependencies(overrides = {}) {
  const calls = [];
  let sessions = 0;
  const deps = {
    calls,
    sessionCount: () => sessions,
    resolveSession: async () => {
      sessions += 1;
      return { actor: { ok: true, actor }, response_headers: {} };
    },
    repository: {
      async transitionSubmission(input) {
        calls.push(input);
        return {
          ok: true,
          data: {
            submission_id: input.submission_id,
            state: input.target_state,
            version: input.expected_version + 1,
          },
        };
      },
      ...overrides,
    },
  };
  return deps;
}

test("gate, CSRF, submissionId, content-type and authority fields fail before session or RPC", async () => {
  const deps = dependencies();
  assert.equal((await transitionSubmission(request(validBody()), submissionId, undefined, deps)).status, 404);
  assert.equal((await transitionSubmission(
    request(validBody(), { origin: "https://attacker.test" }), submissionId, "true", deps)).status, 403);
  assert.equal((await transitionSubmission(request(validBody()), "not-a-uuid", "true", deps)).status, 400);
  assert.equal((await transitionSubmission(
    request(validBody(), { "content-type": "text/plain" }), submissionId, "true", deps)).status, 400);
  assert.equal((await transitionSubmission(request("not json"), submissionId, "true", deps)).status, 400);
  assert.equal((await transitionSubmission(
    request(validBody({ extra: 1 })), submissionId, "true", deps)).status, 400);
  assert.equal((await transitionSubmission(
    request({ ...validBody(), actor: { app_user_id: actor.app_user_id } }), submissionId, "true", deps)).status, 400);
  assert.equal((await transitionSubmission(
    request(validBody({ idempotency_key: "other-key" }), { "idempotency-key": idempotencyKey }), submissionId, "true", deps)).status, 400);
  assert.equal(deps.sessionCount(), 0);
  assert.equal(deps.calls.length, 0);

  const authority = await transitionSubmission(
    request({ ...validBody(), created_by_user_id: actor.app_user_id }), submissionId, "true", deps);
  assert.equal(authority.status, 400);
  assert.equal((await authority.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  const nested = await transitionSubmission(
    request({ ...validBody(), meta: { submitted_at: "2026-10-03T00:00:00Z" } }), submissionId, "true", deps);
  assert.equal(nested.status, 400);
  assert.equal((await nested.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  assert.equal(deps.sessionCount(), 0);
});

test("session and actor mapping fail closed before the repository is called", async () => {
  for (const [session, status, code] of [
    [{ actor: { ok: false, reason: "UNAUTHENTICATED" } }, 401, "UNAUTHENTICATED"],
    [{ actor: { ok: false, reason: "ACTOR_DISABLED" } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: false, reason: "ACTOR_MAPPING_MISSING" } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: false, reason: "AMBIGUOUS_TEAM_MEMBERSHIP" } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: { auth_subject: actor.auth_subject } } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: { auth_subject: "not-a-uuid", app_user_id: actor.app_user_id } } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: null } }, 403, "ACTOR_NOT_AVAILABLE"],
  ]) {
    const deps = dependencies();
    deps.resolveSession = async () => ({ ...session, response_headers: {} });
    const response = await transitionSubmission(request(validBody()), submissionId, "true", deps);
    assert.equal(response.status, status, code);
    assert.equal((await response.json()).code, code);
    assert.equal(deps.calls.length, 0);
  }
});

test("valid transitions use only the server-derived actor and return the exact projection", async () => {
  for (const target of ["REVIEW", "DRAFT", "SUBMITTED"]) {
    const deps = dependencies();
    const response = await transitionSubmission(
      request(validBody({ target_state: target })), submissionId, "true", deps);
    assert.equal(response.status, 200, target);
    assert.deepEqual(await response.json(), {
      ok: true,
      submission_id: submissionId,
      state: target,
      version: 4,
    });
    assert.deepEqual(deps.calls, [{
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      submission_id: submissionId,
      expected_version: 3,
      target_state: target,
      idempotency_key: idempotencyKey,
    }]);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("idempotency replay and changed payload stay distinct at the boundary", async () => {
  const seen = [];
  const deps = dependencies({
    async transitionSubmission(input) {
      seen.push(input.idempotency_key + "|" + input.target_state + "|" + input.expected_version);
      if (input.target_state !== "REVIEW") return { ok: false, kind: "conflict" };
      return {
        ok: true,
        data: { submission_id: input.submission_id, state: input.target_state, version: 4 },
      };
    },
  });
  const first = await transitionSubmission(request(validBody()), submissionId, "true", deps);
  assert.equal(first.status, 200);
  const replay = await transitionSubmission(request(validBody()), submissionId, "true", deps);
  assert.deepEqual(await replay.json(), { ok: true, submission_id: submissionId, state: "REVIEW", version: 4 });
  const changed = await transitionSubmission(
    request(validBody({ target_state: "DRAFT" })), submissionId, "true", deps);
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).code, "SUBMISSION_CONFLICT");
  assert.deepEqual(seen, [idempotencyKey + "|REVIEW|3", idempotencyKey + "|REVIEW|3", idempotencyKey + "|DRAFT|3"]);
});

test("repository kinds map to a consistent sanitized HTTP vocabulary", async () => {
  for (const [kind, status, code] of [
    ["denied", 403, "SUBMISSION_DENIED"],
    ["not-found", 404, "SUBMISSION_NOT_FOUND"],
    ["conflict", 409, "SUBMISSION_CONFLICT"],
    ["invalid", 400, "SUBMISSION_TRANSITION_INVALID"],
    ["unavailable", 500, "SUBMISSION_UNAVAILABLE"],
  ]) {
    const deps = dependencies({ async transitionSubmission() { return { ok: false, kind }; } });
    const response = await transitionSubmission(request(validBody()), submissionId, "true", deps);
    assert.equal(response.status, status, kind);
    assert.deepEqual(await response.json(), { ok: false, code }, kind);
  }
});

test("unexpected repository or session failures never leak raw detail", async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const throwing = dependencies({
      async transitionSubmission() { throw new Error("private b1000000 submission detail"); },
    });
    const failure = await transitionSubmission(request(validBody()), submissionId, "true", throwing);
    assert.equal(failure.status, 500);
    assert.deepEqual(await failure.json(), { ok: false, code: "SUBMISSION_UNAVAILABLE" });

    const sessionFailure = dependencies();
    sessionFailure.resolveSession = async () => { throw new Error("private session detail"); };
    const unavailable = await transitionSubmission(request(validBody()), submissionId, "true", sessionFailure);
    assert.equal(unavailable.status, 500);
    assert.deepEqual(await unavailable.json(), { ok: false, code: "SUBMISSION_UNAVAILABLE" });
    assert.equal(sessionFailure.calls.length, 0);

    assert.doesNotMatch(logged.join(" "), /b1000000|private detail/);
  } finally {
    console.error = originalError;
  }
});
