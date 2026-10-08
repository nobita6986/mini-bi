import assert from "node:assert/strict";
import test from "node:test";

import { privilegedEditEntry, projectPrivilegedEditRequest } from "./privileged-edit-api.ts";
import { classifyPrivilegedEditError, createPrivilegedEditRepository } from "./privileged-edit-repository.ts";

const actor = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  app_user_id: "92000000-0000-4000-8000-000000000001",
};
const entryId = "c1000000-0000-4000-8000-000000000001";
const validBody = {
  expected_entry_version: 3,
  patch: { labor_type: "PERMANENT" },
  reason: "R3 correction",
};

function request(body = validBody, headers = {}) {
  return new Request("https://example.test/api/direct-entry/entries/" + entryId + "/privileged-edit", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": "00000000-0000-4000-8000-000000000900",
      ...headers,
    },
    body: JSON.stringify(body),
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
      async edit(input) {
        calls.push(input);
        return { ok: true, data: { entry_id: entryId, version: 4 } };
      },
      ...overrides,
    },
  };
}

test("R3: patch projection is strict and refuses authority keys and malformed CMT/CCCD", () => {
  assert.deepEqual(projectPrivilegedEditRequest(validBody), {
    expected_entry_version: 3, patch: { labor_type: "PERMANENT" }, reason: "R3 correction",
  });
  for (const bad of [
    { ...validBody, expected_entry_version: 0 },
    { ...validBody, expected_entry_version: "3" },
    { ...validBody, reason: "   " },
    { ...validBody, patch: {} },
    { ...validBody, patch: { team_id: "x" } },
    { ...validBody, patch: { provider_type: "vendor" } },
    { ...validBody, patch: { app_user_id: actor.app_user_id } },
    { ...validBody, patch: { version: 9 } },
    { ...validBody, patch: { labor_type: "OFFICIAL" } },
    { ...validBody, patch: { project_id: "bad project" } },
    { ...validBody, patch: { first_work_date: "01/02/2026" } },
    { ...validBody, patch: { recruiter_id: "nope" } },
    { ...validBody, extra: 1 },
    { patch: { labor_type: "PERMANENT" }, reason: "x" },
    null, [], "x",
  ]) {
    assert.equal(projectPrivilegedEditRequest(bad), null, JSON.stringify(bad));
  }
  // The canonical CMT/CCCD rule of P2.5-HF-R2 applies on this path too.
  assert.equal(projectPrivilegedEditRequest({ ...validBody,
    patch: { worker_details: { national_id: { state: "provided", value: "012345678901" } } } }) !== null,
  true);
  for (const bad of ["0123 456 78901", "NOT-REAL", "12345678"]) {
    assert.equal(projectPrivilegedEditRequest({ ...validBody,
      patch: { worker_details: { national_id: { state: "provided", value: bad } } } }), null, bad);
  }
});

test("R3: the API gate, CSRF, headers and session fail closed before the repository", async () => {
  const gated = dependencies();
  assert.equal((await privilegedEditEntry(request(), entryId, undefined, gated)).status, 404);
  assert.equal(gated.sessionCount(), 0);

  for (const [label, req, status, code] of [
    ["bad entry id", request(), 400, "ENTRY_ID_INVALID"],
    ["no origin", request(validBody, { origin: "" }), 403, "CSRF_REJECTED"],
    ["cross origin", request(validBody, { origin: "https://evil.test" }), 403, "CSRF_REJECTED"],
    ["bad content type", request(validBody, { "content-type": "text/plain" }), 400,
      "CONTENT_TYPE_INVALID"],
    ["missing idempotency key", request(validBody, { "idempotency-key": "" }), 400,
      "IDEMPOTENCY_KEY_INVALID"],
    ["invalid body", request({ expected_entry_version: 1 }), 400, "PRIVILEGED_EDIT_INVALID"],
    ["authority field", request({ ...validBody, patch: { team_id: "x" } }), 400,
      "CLIENT_AUTHORITY_FIELD_FORBIDDEN"],
  ]) {
    const deps = dependencies();
    const response = await privilegedEditEntry(req, label === "bad entry id" ? "nope" : entryId,
      "true", deps);
    assert.equal(response.status, status, label);
    assert.equal((await response.json()).code, code, label);
    assert.equal(deps.sessionCount(), 0, label);
    assert.equal(deps.calls.length, 0, label);
  }

  for (const [session, status, code] of [
    [{ actor: { ok: false, reason: "UNAUTHENTICATED" } }, 401, "UNAUTHENTICATED"],
    [{ actor: { ok: false, reason: "ACTOR_DISABLED" } }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: null } }, 403, "ACTOR_NOT_AVAILABLE"],
  ]) {
    const deps = dependencies();
    deps.resolveSession = async () => ({ ...session, response_headers: {} });
    const response = await privilegedEditEntry(request(), entryId, "true", deps);
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
    assert.equal(deps.calls.length, 0);
  }
});

test("R3: repository classification and API mapping never forward the raw DB message", async () => {
  const cases = [
    ["42501", "PRIVILEGED_EDIT_DENIED", 403],
    ["40001", "VERSION_CONFLICT", 409],
    ["22023", "PRIVILEGED_EDIT_INVALID", 400],
    ["23514", "PRIVILEGED_EDIT_INVALID", 400],
    ["P0002", "ENTRY_NOT_FOUND", 404],
    ["XX000", "PRIVILEGED_EDIT_UNAVAILABLE", 500],
  ];
  for (const [pgCode, code, status] of cases) {
    const classified = classifyPrivilegedEditError({ code: pgCode });
    const deps = dependencies({
      async edit() { return { ok: false, kind: classified.kind, code }; },
    });
    const response = await privilegedEditEntry(request(), entryId, "true", deps);
    assert.equal(response.status, status, pgCode);
    assert.equal((await response.json()).code, code, pgCode);
  }
  const locked = dependencies({
    async edit() { return { ok: false, kind: "denied", code: "PRIVILEGED_EDIT_STATE_LOCKED" }; },
  });
  const lockedResponse = await privilegedEditEntry(request(), entryId, "true", locked);
  assert.equal(lockedResponse.status, 403);
  assert.equal((await lockedResponse.json()).code, "PRIVILEGED_EDIT_STATE_LOCKED");

  for (const [message, expected] of [
    ["worker_active_episode_exists", "WORKER_ACTIVE_EPISODE_EXISTS"],
    ["worker_episode_reopen_forbidden", "WORKER_EPISODE_REOPEN_FORBIDDEN"],
    ["some other unique violation", "PRIVILEGED_EDIT_CONFLICT"],
  ]) {
    const outcome = classifyPrivilegedEditError({ code: "23505", message });
    assert.deepEqual(outcome, { ok: false, kind: "conflict", code: expected });
    assert.equal(JSON.stringify(outcome).includes(message), false, "no raw message");
  }
  const stateLock = classifyPrivilegedEditError({
    code: "42501", message: "privileged edit requires a draft or submitted entry",
  });
  assert.deepEqual(stateLock, { ok: false, kind: "denied", code: "PRIVILEGED_EDIT_STATE_LOCKED" });
});

test("R3: the repository sends only server actor refs and validates the result shape", async () => {
  const calls = [];
  const repository = createPrivilegedEditRepository(async (name, args) => {
    calls.push({ name, args });
    return { data: { entry_id: entryId, version: 4 }, error: null };
  });
  const ok = await repository.edit({
    ...actor, entry_id: entryId, expected_version: 3, patch: { labor_type: "PERMANENT" },
    reason: "R3", idempotency_key: "00000000-0000-4000-8000-000000000900",
  });
  assert.deepEqual(ok, { ok: true, data: { entry_id: entryId, version: 4 } });
  assert.equal(calls[0].name, "direct_entry_privileged_edit");
  assert.deepEqual(calls[0].args, {
    p_auth_subject: actor.auth_subject, p_app_user_id: actor.app_user_id, p_entry_id: entryId,
    p_expected_version: 3, p_patch: { labor_type: "PERMANENT" }, p_reason: "R3",
    p_idempotency_key: "00000000-0000-4000-8000-000000000900",
  });
  for (const data of [
    { entry_id: entryId },
    { entry_id: entryId, version: 4, extra: 1 },
    { entry_id: "d1000000-0000-4000-8000-000000000001", version: 4 },
    { entry_id: entryId, version: 0 },
    { entry_id: entryId, version: "4" },
    null,
  ]) {
    const broken = createPrivilegedEditRepository(async () => ({ data, error: null }));
    const outcome = await broken.edit({
      ...actor, entry_id: entryId, expected_version: 3, patch: { labor_type: "PERMANENT" },
      reason: "R3", idempotency_key: "00000000-0000-4000-8000-000000000900",
    });
    assert.deepEqual(outcome, { ok: false, kind: "unavailable", code: "PRIVILEGED_EDIT_UNAVAILABLE" },
      JSON.stringify(data));
  }
});

test("R3: a successful edit returns only the identity and the new version", async () => {
  const deps = dependencies();
  const response = await privilegedEditEntry(request(), entryId, "true", deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await response.json(), { ok: true, entry_id: entryId, version: 4 });
  assert.deepEqual(deps.calls[0], {
    auth_subject: actor.auth_subject, app_user_id: actor.app_user_id, entry_id: entryId,
    expected_version: 3, patch: { labor_type: "PERMANENT" }, reason: "R3 correction",
    idempotency_key: "00000000-0000-4000-8000-000000000900",
  });
});
