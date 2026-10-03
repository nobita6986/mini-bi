import assert from "node:assert/strict";
import test from "node:test";

import { listChangeRequests, readChangeRequest } from "./change-request-read-api.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
  ok: true,
};
const entryA = "c1000000-0000-4000-8000-000000000001";
const requestId = "d1000000-0000-4000-8000-000000000001";
const createdAt = "2026-10-03T10:00:00.000000Z";
const cursor = "20261003100400000000:" + requestId;

const listItem = {
  request_id: requestId,
  state: "PENDING",
  version: 1,
  created_at: createdAt,
  item_count: 1,
  entry_ids: [entryA],
  can_withdraw: true,
  can_decide: false,
};
const detail = {
  request_id: requestId,
  state: "PENDING",
  version: 1,
  created_at: createdAt,
  items: [{ entry_id: entryA, target_kind: "ENTRY_FIELD", expected_version: 1,
    proposal: { labor_type: "PERMANENT" } }],
  can_withdraw: true,
  can_decide: false,
};

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
      async listChangeRequests(input) {
        calls.push({ name: "list", input });
        return { ok: true, data: {
          requests: input.state === null ? [listItem] : [listItem],
          page_size: input.page_size,
          has_more: false,
          next_cursor: null,
        } };
      },
      async readChangeRequest(input) {
        calls.push({ name: "read", input });
        return { ok: true, data: detail };
      },
      ...overrides,
    },
  };
}

test("gate runs before query, session and repository", async () => {
  const deps = dependencies();
  assert.equal((await listChangeRequests(request("/api/direct-entry/change-requests"), undefined, deps)).status, 404);
  assert.equal((await readChangeRequest(
    request("/api/direct-entry/change-requests/" + requestId), requestId, undefined, deps)).status, 404);
  assert.equal(deps.sessionCount(), 0);
  assert.equal(deps.calls.length, 0);
});

test("query and path validation fail before session", async () => {
  const deps = dependencies();
  for (const path of [
    "/api/direct-entry/change-requests?page_size=0",
    "/api/direct-entry/change-requests?page_size=51",
    "/api/direct-entry/change-requests?cursor=nope",
    "/api/direct-entry/change-requests?state=pending",
    "/api/direct-entry/change-requests?order=created_at",
  ]) {
    const response = await listChangeRequests(request(path), "true", deps);
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).code, "CHANGE_REQUEST_QUERY_INVALID", path);
  }
  assert.equal((await readChangeRequest(
    request("/api/direct-entry/change-requests/not-a-uuid"), "not-a-uuid", "true", deps)).status, 400);
  assert.equal((await readChangeRequest(
    request("/api/direct-entry/change-requests/" + requestId + "?state=PENDING"),
    requestId, "true", deps)).status, 400);
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
    const listed = await listChangeRequests(request("/api/direct-entry/change-requests"), "true", deps);
    assert.equal(listed.status, status, code);
    assert.equal((await listed.json()).code, code);
    const read = await readChangeRequest(
      request("/api/direct-entry/change-requests/" + requestId), requestId, "true", deps);
    assert.equal(read.status, status, code);
    assert.equal(deps.calls.length, 0);
  }
});

test("list success returns the exact projection with no-store", async () => {
  const deps = dependencies();
  const response = await listChangeRequests(
    request("/api/direct-entry/change-requests?page_size=20&state=PENDING&cursor=" + cursor),
    "true", deps,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, requests: [listItem], page_size: 20, has_more: false, next_cursor: null,
  });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(deps.calls, [{
    name: "list",
    input: {
      auth_subject: actor.auth_subject,
      app_user_id: actor.app_user_id,
      page_size: 20,
      cursor,
      state: "PENDING",
    },
  }]);

  const defaults = dependencies();
  const fallback = await listChangeRequests(
    request("/api/direct-entry/change-requests"), "true", defaults);
  assert.deepEqual(defaults.calls[0].input, {
    auth_subject: actor.auth_subject,
    app_user_id: actor.app_user_id,
    page_size: 20,
    cursor: null,
    state: null,
  });
  assert.equal(fallback.status, 200);
});

test("detail success returns the exact projection", async () => {
  const deps = dependencies();
  const response = await readChangeRequest(
    request("/api/direct-entry/change-requests/" + requestId), requestId, "true", deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ...detail });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(deps.calls, [{
    name: "read",
    input: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id, request_id: requestId },
  }]);
});

test("repository kinds map to a sanitized vocabulary with no enumeration", async () => {
  for (const [kind, status, code] of [
    ["denied", 403, "CHANGE_REQUEST_DENIED"],
    ["not-found", 404, "CHANGE_REQUEST_NOT_FOUND"],
    ["invalid", 400, "CHANGE_REQUEST_ID_INVALID"],
    ["unavailable", 500, "CHANGE_REQUEST_UNAVAILABLE"],
  ]) {
    const readDeps = dependencies({
      async readChangeRequest() { return { ok: false, kind }; },
    });
    const response = await readChangeRequest(
      request("/api/direct-entry/change-requests/" + requestId), requestId, "true", readDeps);
    assert.equal(response.status, status, kind);
    assert.deepEqual(await response.json(), { ok: false, code }, kind);
  }
  for (const [kind, status, code] of [
    ["denied", 403, "CHANGE_REQUEST_DENIED"],
    ["not-found", 404, "CHANGE_REQUEST_NOT_FOUND"],
    ["invalid", 400, "CHANGE_REQUEST_QUERY_INVALID"],
    ["unavailable", 500, "CHANGE_REQUEST_UNAVAILABLE"],
  ]) {
    const listDeps = dependencies({
      async listChangeRequests() { return { ok: false, kind }; },
    });
    const response = await listChangeRequests(
      request("/api/direct-entry/change-requests"), "true", listDeps);
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
      async listChangeRequests() { throw new Error("private d1000000 list detail"); },
      async readChangeRequest() { throw new Error("private d1000000 read detail"); },
    });
    const listed = await listChangeRequests(
      request("/api/direct-entry/change-requests"), "true", throwing);
    assert.equal(listed.status, 500);
    assert.deepEqual(await listed.json(), { ok: false, code: "CHANGE_REQUEST_UNAVAILABLE" });
    const read = await readChangeRequest(
      request("/api/direct-entry/change-requests/" + requestId), requestId, "true", throwing);
    assert.equal(read.status, 500);
    assert.deepEqual(await read.json(), { ok: false, code: "CHANGE_REQUEST_UNAVAILABLE" });

    const sessionFailure = dependencies();
    sessionFailure.resolveSession = async () => { throw new Error("private session detail"); };
    const failed = await listChangeRequests(
      request("/api/direct-entry/change-requests"), "true", sessionFailure);
    assert.equal(failed.status, 500);
    assert.equal(sessionFailure.calls.length, 0);
    assert.doesNotMatch(logged.join(" "), /d1000000|private detail/);
  } finally {
    console.error = originalError;
  }
});
