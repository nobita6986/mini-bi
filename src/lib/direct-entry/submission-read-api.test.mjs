import assert from "node:assert/strict";
import test from "node:test";

import { listOwnSubmissions, readOwnSubmission } from "./submission-read-api.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
  ok: true,
};
const submissionId = "b1000000-0000-4000-8000-000000000001",
  entryA = "c1000000-0000-4000-8000-000000000001";
const createdAt = "2026-10-04T09:00:00.000000Z";
const cursor = "20261004090100000000:" + submissionId;

const listItem = {
  submission_id: submissionId,
  state: "DRAFT",
  version: 1,
  entry_count: 1,
  created_at: createdAt,
  updated_at: createdAt,
  submitted_at: null,
  allowed_transitions: ["REVIEW"],
  project_scoped: false,
};
const detail = { ...listItem, entry_ids: [entryA] };

function request(path, headers = {}) {
  return new Request("https://example.test" + path, { method: "GET", headers });
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
      async listOwnSubmissions(input) {
        calls.push({ name: "list", input });
        return { ok: true, data: { items: [listItem], page_size: input.page_size,
          has_more: false, next_cursor: null } };
      },
      async readOwnSubmission(input) {
        calls.push({ name: "read", input });
        return { ok: true, data: detail };
      },
      ...overrides,
    },
  };
}

test("gate runs before query, session and repository", async () => {
  const deps = dependencies();
  assert.equal((await listOwnSubmissions(request("/api/direct-entry/submissions"), undefined, deps)).status, 404);
  assert.equal((await readOwnSubmission(
    request("/api/direct-entry/submissions/" + submissionId), submissionId, undefined, deps)).status, 404);
  assert.equal(deps.sessionCount(), 0);
  assert.equal(deps.calls.length, 0);
});

test("query and path validation fail before session", async () => {
  const deps = dependencies();
  for (const path of [
    "/api/direct-entry/submissions?page_size=0",
    "/api/direct-entry/submissions?page_size=51",
    "/api/direct-entry/submissions?cursor=nope",
    "/api/direct-entry/submissions?state=draft",
    "/api/direct-entry/submissions?order=created_at",
  ]) {
    const response = await listOwnSubmissions(request(path), "true", deps);
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).code, "SUBMISSION_QUERY_INVALID", path);
  }
  assert.equal((await readOwnSubmission(
    request("/api/direct-entry/submissions/not-a-uuid"), "not-a-uuid", "true", deps)).status, 400);
  assert.equal((await readOwnSubmission(
    request("/api/direct-entry/submissions/" + submissionId + "?state=DRAFT"),
    submissionId, "true", deps)).status, 400);
  assert.equal(deps.sessionCount(), 0);
  assert.equal(deps.calls.length, 0);
});

test("session and actor mapping fail closed before the repository", async () => {
  for (const [session, status, code] of [
    [{ actor: { ok: false, reason: "UNAUTHENTICATED" } }, 401, "UNAUTHENTICATED"],
    [{ actor: { ok: false, reason: "ACTOR_DISABLED" } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: { auth_subject: actor.auth_subject } } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: null } }, 403, "ACTOR_NOT_AVAILABLE"],
  ]) {
    const deps = dependencies();
    deps.resolveSession = async () => ({ ...session, response_headers: {} });
    const listed = await listOwnSubmissions(request("/api/direct-entry/submissions"), "true", deps);
    assert.equal(listed.status, status, code);
    assert.equal((await listed.json()).code, code);
    const read = await readOwnSubmission(
      request("/api/direct-entry/submissions/" + submissionId), submissionId, "true", deps);
    assert.equal(read.status, status, code);
    assert.equal(deps.calls.length, 0);
  }
});

test("list and detail success return the exact projection with no-store", async () => {
  const listDeps = dependencies();
  const listed = await listOwnSubmissions(
    request("/api/direct-entry/submissions?page_size=20&state=DRAFT&cursor=" + cursor),
    "true", listDeps,
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), {
    ok: true, items: [listItem], page_size: 20, has_more: false, next_cursor: null,
  });
  assert.equal(listed.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(listDeps.calls, [{
    name: "list",
    input: {
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      page_size: 20,
      cursor,
      state: "DRAFT",
    },
  }]);

  const defaults = dependencies();
  await listOwnSubmissions(request("/api/direct-entry/submissions"), "true", defaults);
  assert.deepEqual(defaults.calls[0].input, {
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    page_size: 20,
    cursor: null,
    state: null,
  });

  const readDeps = dependencies();
  const read = await readOwnSubmission(
    request("/api/direct-entry/submissions/" + submissionId), submissionId, "true", readDeps);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { ok: true, ...detail });
  assert.equal(read.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(readDeps.calls, [{
    name: "read",
    input: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id, submission_id: submissionId },
  }]);
});

test("repository kinds map to a sanitized vocabulary without enumeration", async () => {
  for (const [kind, status, code] of [
    ["denied", 403, "SUBMISSION_READ_DENIED"],
    ["not-found", 404, "SUBMISSION_NOT_FOUND"],
    ["invalid", 400, "SUBMISSION_ID_INVALID"],
    ["unavailable", 500, "SUBMISSION_UNAVAILABLE"],
  ]) {
    const readDeps = dependencies({ async readOwnSubmission() { return { ok: false, kind }; } });
    const response = await readOwnSubmission(
      request("/api/direct-entry/submissions/" + submissionId), submissionId, "true", readDeps);
    assert.equal(response.status, status, kind);
    assert.deepEqual(await response.json(), { ok: false, code }, kind);
  }
  for (const [kind, status, code] of [
    ["denied", 403, "SUBMISSION_READ_DENIED"],
    ["not-found", 404, "SUBMISSION_NOT_FOUND"],
    ["invalid", 400, "SUBMISSION_QUERY_INVALID"],
    ["unavailable", 500, "SUBMISSION_UNAVAILABLE"],
  ]) {
    const listDeps = dependencies({ async listOwnSubmissions() { return { ok: false, kind }; } });
    const response = await listOwnSubmissions(
      request("/api/direct-entry/submissions"), "true", listDeps);
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
      async listOwnSubmissions() { throw new Error("private b1000000 list detail"); },
      async readOwnSubmission() { throw new Error("private b1000000 read detail"); },
    });
    const listed = await listOwnSubmissions(
      request("/api/direct-entry/submissions"), "true", throwing);
    assert.equal(listed.status, 500);
    assert.deepEqual(await listed.json(), { ok: false, code: "SUBMISSION_UNAVAILABLE" });
    const read = await readOwnSubmission(
      request("/api/direct-entry/submissions/" + submissionId), submissionId, "true", throwing);
    assert.equal(read.status, 500);
    assert.deepEqual(await read.json(), { ok: false, code: "SUBMISSION_UNAVAILABLE" });

    const sessionFailure = dependencies();
    sessionFailure.resolveSession = async () => { throw new Error("private session detail"); };
    const failed = await listOwnSubmissions(
      request("/api/direct-entry/submissions"), "true", sessionFailure);
    assert.equal(failed.status, 500);
    assert.equal(sessionFailure.calls.length, 0);
    assert.doesNotMatch(logged.join(" "), /b1000000|private detail/);
  } finally {
    console.error = originalError;
  }
});
