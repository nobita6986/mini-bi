import assert from "node:assert/strict";
import test from "node:test";

import {
  grantProjectTeamScope,
  listProjectTeamScopes,
  parseListScopesQuery,
  revokeProjectTeamScope,
} from "./project-team-scope-api.ts";

const ACTOR = {
  auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222",
};
const KEY = "55555555-5555-4555-8555-555555555555";
const MAPPING = "77777777-7777-4777-8777-777777777777";
const TEAM = "66666666-6666-4666-8666-666666666666";
const LIST = {
  authorization_date: "2026-10-15", include_history: false, page: 1, page_size: 25,
  total: 1, has_more: false,
  mappings: [{
    mapping_id: MAPPING, project_id: "project-1", project_display_name: "Dự án 1",
    team_id: TEAM, team_display_name: "Nhóm A", team_code: "A",
    valid_from: "2026-10-15", valid_to: null, effective: true, state: "CURRENT",
    version: 1, revoked_at: null, created_at: "2026-10-15T00:00:00Z",
  }],
};

function dependencies(result, session = { actor: { ok: true, actor: ACTOR }, response_headers: {} }) {
  const calls = { session: 0, repository: [] };
  return {
    calls,
    value: {
      resolveSession: async () => { calls.session += 1; return session; },
      repository: {
        listScopes: async (input) => { calls.repository.push(["list", input]); return result; },
        grantScope: async (input) => { calls.repository.push(["grant", input]); return result; },
        revokeScope: async (input) => { calls.repository.push(["revoke", input]); return result; },
      },
    },
  };
}

function post(path, body, headers = {}) {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json", origin: "https://app.test", host: "app.test",
      "sec-fetch-site": "same-origin", ...headers,
    },
    body: JSON.stringify(body),
  });
}

const grantBody = {
  project_id: "project-1", team_id: TEAM, expected_pair_version: 0,
  effective_from: "2026-10-15", reason: "UAT grant", idempotency_key: KEY,
};
const revokeBody = {
  mapping_id: MAPPING, expected_pair_version: 1,
  effective_to: "2026-10-15", reason: "same-day cancellation", idempotency_key: KEY,
};

test("list requires resolved active actor, forwards bounded filters, and is private no-store", async () => {
  const d = dependencies({ ok: true, data: LIST });
  const response = await listProjectTeamScopes(
    new Request("https://app.test/api?project_id=project-1&include_history=true&page=2&page_size=50"),
    "true", d.value,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(d.calls.repository[0], ["list", {
    ...ACTOR, project_id: "project-1", team_id: null, include_history: true, page: 2, page_size: 50,
  }]);
  assert.deepEqual((await response.json()).list, LIST);
});

test("query rejects unknown, duplicate, malformed, and out-of-range pagination before session", async () => {
  const invalid = [
    "?actor=admin", "?page=1&page=2", "?page=0", "?page=1001", "?page_size=101",
    "?team_id=not-a-uuid", "?include_history=yes",
  ];
  for (const query of invalid) {
    const d = dependencies({ ok: true, data: LIST });
    const response = await listProjectTeamScopes(new Request(`https://app.test/api${query}`), "true", d.value);
    assert.equal(response.status, 400, query);
    assert.equal(d.calls.session, 0, query);
    assert.equal(d.calls.repository.length, 0, query);
  }
  assert.equal(parseListScopesQuery(new URL("https://app.test/api?page=1000&page_size=100")).ok, true);
});

test("grant and revoke derive actor from session and forward OCC, reason, and idempotency", async () => {
  const grant = dependencies({ ok: true, data: { mapping_id: MAPPING, project_id: "project-1",
    team_id: TEAM, valid_from: "2026-10-15", valid_to: null, version: 1, created: true } });
  const grantResponse = await grantProjectTeamScope(post("/api", grantBody), "true", grant.value);
  assert.equal(grantResponse.status, 200);
  assert.equal(grantResponse.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(grant.calls.repository[0], ["grant", { ...ACTOR, ...grantBody }]);

  const revoke = dependencies({ ok: true, data: { mapping_id: MAPPING, project_id: "project-1",
    team_id: TEAM, valid_to: "2026-10-15", version: 2, revoked: true } });
  const revokeResponse = await revokeProjectTeamScope(post("/api", revokeBody), "true", revoke.value);
  assert.equal(revokeResponse.status, 200);
  assert.deepEqual(revoke.calls.repository[0], ["revoke", { ...ACTOR, ...revokeBody }]);
});

test("flag, CSRF, and content-type reject before session or repository", async () => {
  const disabled = dependencies({ ok: true, data: LIST });
  assert.equal((await grantProjectTeamScope(post("/api", grantBody), "false", disabled.value)).status, 404);
  const csrf = dependencies({ ok: true, data: LIST });
  const csrfResponse = await grantProjectTeamScope(post("/api", grantBody, { origin: "https://evil.test" }), "true", csrf.value);
  assert.equal(csrfResponse.status, 403);
  assert.equal((await csrfResponse.json()).code, "CSRF_REJECTED");
  const contentType = dependencies({ ok: true, data: LIST });
  const wrongType = new Request("https://app.test/api", {
    method: "POST", headers: { origin: "https://app.test", host: "app.test", "content-type": "text/plain" }, body: "{}",
  });
  assert.equal((await grantProjectTeamScope(wrongType, "true", contentType.value)).status, 400);
  for (const d of [disabled, csrf, contentType]) {
    assert.equal(d.calls.session, 0);
    assert.equal(d.calls.repository.length, 0);
  }
});

test("anonymous, disabled, and malformed actor are denied without mapping reads", async () => {
  const cases = [
    [{ actor: { ok: false, reason: "UNAUTHENTICATED" }, response_headers: {} }, 401, "UNAUTHENTICATED"],
    [{ actor: { ok: false, reason: "ACTOR_DISABLED" }, response_headers: {} }, 403, "ACTOR_NOT_AVAILABLE"],
    [{ actor: { ok: true, actor: { ...ACTOR, app_user_id: "bad" } }, response_headers: {} }, 403, "ACTOR_NOT_AVAILABLE"],
  ];
  for (const [session, status, code] of cases) {
    const d = dependencies({ ok: true, data: LIST }, session);
    const response = await listProjectTeamScopes(new Request("https://app.test/api"), "true", d.value);
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
    assert.equal(d.calls.repository.length, 0);
  }
});

test("authority fields and unknown body keys are rejected before session", async () => {
  for (const extra of [{ actor: "admin" }, { auth_subject: ACTOR.auth_subject },
    { app_user_id: ACTOR.app_user_id }, { capabilities: ["entry_admin"] }, { scope: "all" }]) {
    const d = dependencies({ ok: true, data: LIST });
    const response = await grantProjectTeamScope(post("/api", { ...grantBody, ...extra }), "true", d.value);
    assert.equal(response.status, 400, JSON.stringify(extra));
    assert.equal((await response.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
    assert.equal(d.calls.session, 0);
    assert.equal(d.calls.repository.length, 0);
  }
  const d = dependencies({ ok: true, data: LIST });
  const response = await grantProjectTeamScope(post("/api", { ...grantBody, extra: true }), "true", d.value);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "PROJECT_TEAM_SCOPE_INVALID");
  assert.equal(d.calls.session, 0);
});

test("sanitized repository errors retain status taxonomy and never expose DB text", async () => {
  for (const [kind, status, code] of [
    ["denied", 403, "PROJECT_TEAM_SCOPE_DENIED"], ["not-found", 404, "PROJECT_TEAM_SCOPE_NOT_FOUND"],
    ["conflict", 409, "PROJECT_TEAM_SCOPE_CONFLICT"], ["invalid", 400, "PROJECT_TEAM_SCOPE_INVALID"],
    ["unavailable", 500, "PROJECT_TEAM_SCOPE_UNAVAILABLE"],
  ]) {
    const d = dependencies({ ok: false, kind });
    const response = await grantProjectTeamScope(post("/api", grantBody), "true", d.value);
    assert.equal(response.status, status);
    const text = await response.text();
    assert.ok(text.includes(code));
    assert.equal(text.includes("database"), false);
  }
});
