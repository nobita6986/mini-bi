import assert from "node:assert/strict";
import test from "node:test";

import {
  createTeamCatalog,
  getTeamCatalog,
  listTeamsCatalog,
  setTeamCatalogActive,
  teamCatalogCreateRequest,
  teamCatalogListQuery,
  teamCatalogSetActiveRequest,
  teamCatalogUpdateRequest,
  updateTeamCatalog,
} from "./team-catalog-api.ts";
import {
  teamCatalogCreateResult,
  teamCatalogItem,
  teamCatalogList,
  teamCatalogMutation,
} from "./team-catalog-contract.ts";
import { classifyTeamCatalogError, createTeamCatalogRepository } from "./team-catalog-repository.ts";

const ACTOR = { auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222" };
const KEY = "55555555-5555-4555-8555-555555555555";
const TEAM = "66666666-6666-4666-8666-666666666666";
const REV = "99999999-9999-4999-8999-999999999999";
const OTHER = "77777777-7777-4777-8777-777777777777";

const ITEM = { team_id: TEAM, code: "TEAM_ONE", display_name: "Synthetic Team",
  active: true, version: 2, revision_count: 2 };
const MUTATION = { team_id: TEAM, code: "TEAM_ONE", display_name: "Synthetic Team",
  active: true, version: 3, revision_id: REV };
const CREATE = { ...MUTATION, created: true };
const LIST = { authorization_date: "2026-10-09", include_inactive: true, search: null,
  page: 1, page_size: 25, total: 1, teams: [ITEM] };

function deps(result, session = { actor: { ok: true, actor: ACTOR } }) {
  const calls = { session: 0, rpc: [] };
  return {
    calls,
    dependencies: {
      resolveSession: async () => { calls.session += 1; return session; },
      repository: {
        listTeams: async (i) => { calls.rpc.push(["list", i]); return result; },
        getTeam: async (i) => { calls.rpc.push(["get", i]); return result; },
        createTeam: async (i) => { calls.rpc.push(["create", i]); return result; },
        updateTeam: async (i) => { calls.rpc.push(["update", i]); return result; },
        setTeamActive: async (i) => { calls.rpc.push(["active", i]); return result; },
      },
    },
  };
}
function jsonRequest(body, path = "/api/admin/catalog/teams", headers = {}) {
  return new Request("https://app.test" + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test",
      host: "app.test", "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify(body),
  });
}
const CREATE_BODY = { expected_version: 0, code: "TEAM_ONE", display_name: "Synthetic Team",
  reason: "Synthetic reason", idempotency_key: KEY };
const UPDATE_BODY = { expected_version: 2, display_name: "Synthetic Team",
  reason: "Synthetic reason", idempotency_key: KEY };
const ACTIVE_BODY = { active: false, expected_version: 2,
  reason: "Synthetic reason", idempotency_key: KEY };

test("the contract accepts exactly the reviewed projection shapes", () => {
  assert.deepEqual(teamCatalogItem(ITEM), ITEM);
  assert.deepEqual(teamCatalogList(LIST), LIST);
  assert.deepEqual(teamCatalogMutation(MUTATION), MUTATION);
  assert.deepEqual(teamCatalogCreateResult(CREATE), CREATE);
  assert.equal(teamCatalogItem({ ...ITEM, extra: 1 }), null);
  const withoutCode = { ...ITEM };
  delete withoutCode.code;
  assert.equal(teamCatalogItem(withoutCode), null);
  assert.equal(teamCatalogItem({ ...ITEM, active: "true" }), null);
  assert.equal(teamCatalogItem({ ...ITEM, version: -1 }), null);
  assert.equal(teamCatalogItem({ ...ITEM, code: "" }), null);
  assert.equal(teamCatalogItem(null), null);
  assert.equal(teamCatalogList({ ...LIST, teams: [{ ...ITEM, revision_count: "2" }] }), null);
  assert.equal(teamCatalogCreateResult({ ...CREATE, created: false }), null);
  assert.equal(teamCatalogMutation({ ...MUTATION, revision_count: 2 }), null);
});

test("the feature gate runs before session and repository", async () => {
  const d = deps({ ok: true, data: LIST });
  const res = await listTeamsCatalog(new Request("https://app.test/x"), "false", d.dependencies);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("same-origin is enforced before session and repository on mutations", async () => {
  const d = deps({ ok: true, data: CREATE });
  const res = await createTeamCatalog(
    jsonRequest(CREATE_BODY, "/api/admin/catalog/teams", { origin: "https://evil.test" }),
    "true", d.dependencies);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "CSRF_REJECTED");
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("content-type, body and client authority fields are rejected before session", async () => {
  const d = deps({ ok: true, data: CREATE });
  const wrongType = new Request("https://app.test/x", { method: "POST",
    headers: { "content-type": "text/plain", origin: "https://app.test", host: "app.test" },
    body: "{}" });
  assert.equal((await createTeamCatalog(wrongType, "true", d.dependencies)).status, 400);

  const broken = new Request("https://app.test/x", { method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test", host: "app.test" },
    body: "{not json" });
  const brokenRes = await createTeamCatalog(broken, "true", d.dependencies);
  assert.equal(brokenRes.status, 400);
  assert.equal((await brokenRes.json()).code, "BODY_INVALID");

  for (const forbidden of [{ actor: "x" }, { auth_subject: "x" }, { capabilities: [] },
    { scope: "all" }, { role: "admin" }, { app_user_id: "x" }, { scopes: [] }]) {
    const res = await createTeamCatalog(
      jsonRequest({ ...CREATE_BODY, ...forbidden }), "true", d.dependencies);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("request projections are strict; the generic update cannot reach code or active", () => {
  assert.equal(teamCatalogCreateRequest(CREATE_BODY).ok, true);
  assert.equal(teamCatalogCreateRequest({ ...CREATE_BODY, expected_version: 1 }).ok, false);
  assert.equal(teamCatalogCreateRequest({ ...CREATE_BODY, code: "__system_vendor__" }).ok, false);
  assert.equal(teamCatalogCreateRequest({ ...CREATE_BODY, code: "has space" }).ok, false);
  assert.equal(teamCatalogCreateRequest({ ...CREATE_BODY, code: "" }).ok, false);
  assert.equal(teamCatalogCreateRequest({ ...CREATE_BODY, code: "x".repeat(129) }).ok, false);
  assert.equal(teamCatalogCreateRequest({ ...CREATE_BODY, display_name: "" }).ok, false);
  assert.equal(teamCatalogCreateRequest({ ...CREATE_BODY, reason: "" }).ok, false);
  assert.equal(teamCatalogCreateRequest({ ...CREATE_BODY, idempotency_key: "nope" }).ok, false);
  assert.equal(teamCatalogCreateRequest({ ...CREATE_BODY, extra: 1 }).ok, false);

  assert.equal(teamCatalogUpdateRequest(UPDATE_BODY).ok, true);
  // Regression 8: neither code nor active is part of the generic update contract.
  assert.equal(teamCatalogUpdateRequest({ ...UPDATE_BODY, code: "TEAM_TWO" }).ok, false);
  assert.equal(teamCatalogUpdateRequest({ ...UPDATE_BODY, active: false }).ok, false);
  assert.equal(teamCatalogUpdateRequest({ ...UPDATE_BODY, expected_version: 0 }).ok, false);
  assert.equal(teamCatalogUpdateRequest({ ...UPDATE_BODY, display_name: "" }).ok, false);

  assert.equal(teamCatalogSetActiveRequest(ACTIVE_BODY).ok, true);
  assert.equal(teamCatalogSetActiveRequest({ ...ACTIVE_BODY, active: "false" }).ok, false);
  assert.equal(teamCatalogSetActiveRequest({ ...ACTIVE_BODY, expected_version: null }).ok, false);

  const query = teamCatalogListQuery(new URL("https://app.test/x?search=%20abc%20&page=2&page_size=10&include_inactive=false"));
  assert.deepEqual(query.ok && query.value, { search: "abc", include_inactive: false, page: 2, page_size: 10 });
  for (const value of ["", "1", "TRUE", "yes"]) {
    assert.equal(teamCatalogListQuery(
      new URL("https://app.test/x?include_inactive=" + encodeURIComponent(value))).ok, false, value);
  }
  for (const search of ["?page=0", "?page_size=0", "?page_size=101", "?page=abc",
    "?search=" + "x".repeat(257)]) {
    assert.equal(teamCatalogListQuery(new URL("https://app.test/x" + search)).ok, false, search);
  }
});

test("the session actor is the only actor source", async () => {
  const unauthenticated = deps({ ok: true, data: LIST },
    { actor: { ok: false, reason: "UNAUTHENTICATED" } });
  const denied = await listTeamsCatalog(new Request("https://app.test/x"), "true",
    unauthenticated.dependencies);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).code, "UNAUTHENTICATED");

  const unavailable = deps({ ok: true, data: LIST },
    { actor: { ok: false, reason: "ACTOR_DISABLED" } });
  const actorUnavailable = await listTeamsCatalog(new Request("https://app.test/x"), "true",
    unavailable.dependencies);
  assert.equal(actorUnavailable.status, 403);
  assert.equal((await actorUnavailable.json()).code, "ACTOR_NOT_AVAILABLE");

  const strict = deps({ ok: true, data: LIST });
  const blocked = await listTeamsCatalog(
    new Request("https://app.test/x?include_inactive=yes"), "true", strict.dependencies);
  assert.equal(blocked.status, 400);
  assert.equal((await blocked.json()).code, "TEAM_INVALID");
  assert.equal(strict.calls.rpc.length, 0);

  const d = deps({ ok: true, data: LIST });
  const res = await listTeamsCatalog(
    new Request("https://app.test/x?search=TEAM&page=1&page_size=5"), "true", d.dependencies);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const body = await res.json();
  assert.deepEqual(body.list, LIST);
  assert.deepEqual(d.calls.rpc[0][1],
    { ...ACTOR, search: "TEAM", include_inactive: true, page: 1, page_size: 5 });
});

test("idempotency header mismatch is rejected before the repository", async () => {
  const d = deps({ ok: true, data: CREATE });
  const res = await createTeamCatalog(
    jsonRequest(CREATE_BODY, "/api/admin/catalog/teams", { "idempotency-key": OTHER }),
    "true", d.dependencies);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "IDEMPOTENCY_KEY_MISMATCH");
  assert.equal(d.calls.rpc.length, 0);
});

test("mutations project strict responses and sanitized failures", async () => {
  const ok = deps({ ok: true, data: CREATE });
  const created = await createTeamCatalog(jsonRequest(CREATE_BODY), "true", ok.dependencies);
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { ok: true, team: CREATE });

  const expected = { denied: [403, "TEAM_DENIED"], "not-found": [404, "TEAM_NOT_FOUND"],
    conflict: [409, "TEAM_CONFLICT"], invalid: [400, "TEAM_INVALID"],
    unavailable: [500, "TEAM_UNAVAILABLE"] };
  for (const [kind, [status, code]] of Object.entries(expected)) {
    const d = deps({ ok: false, kind });
    const res = await updateTeamCatalog(
      jsonRequest(UPDATE_BODY, "/api/admin/catalog/teams/" + TEAM), TEAM, "true",
      d.dependencies);
    assert.equal(res.status, status, kind);
    assert.deepEqual(await res.json(), { ok: false, code }, kind);
  }

  const throwing = deps({ ok: true, data: CREATE });
  throwing.dependencies.repository.createTeam = async () => {
    throw new Error("RAW_DB_MESSAGE_SHOULD_NOT_LEAK");
  };
  const failure = await createTeamCatalog(jsonRequest(CREATE_BODY), "true", throwing.dependencies);
  assert.equal(failure.status, 500);
  const text = JSON.stringify(await failure.json());
  assert.equal(text.includes("RAW_DB_MESSAGE_SHOULD_NOT_LEAK"), false);
  assert.equal(text.includes("TEAM_UNAVAILABLE"), true);
});

test("detail and set-active validate the path id and project the response", async () => {
  const d = deps({ ok: true, data: ITEM });
  const res = await getTeamCatalog(new Request("https://app.test/x"), TEAM, "true", d.dependencies);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, team: ITEM });
  assert.deepEqual(d.calls.rpc[0][1], { ...ACTOR, team_id: TEAM });

  const invalid = deps({ ok: true, data: ITEM });
  const res2 = await getTeamCatalog(new Request("https://app.test/x"), "not-a-uuid", "true",
    invalid.dependencies);
  assert.equal(res2.status, 400);
  assert.equal(invalid.calls.session, 0);

  const active = deps({ ok: true, data: MUTATION });
  const res3 = await setTeamCatalogActive(
    jsonRequest(ACTIVE_BODY, "/api/admin/catalog/teams/" + TEAM + "/active"), TEAM, "true",
    active.dependencies);
  assert.equal(res3.status, 200);
  assert.deepEqual(await res3.json(), { ok: true, team: MUTATION });
  assert.deepEqual(active.calls.rpc[0][1],
    { ...ACTOR, team_id: TEAM, active: false, expected_version: 2,
      reason: "Synthetic reason", idempotency_key: KEY });
});

test("repository maps SQLSTATE to sanitized kinds and calls the canonical RPCs", async () => {
  assert.equal(classifyTeamCatalogError({ code: "40001" }), "conflict");
  assert.equal(classifyTeamCatalogError({ code: "23505" }), "conflict");
  assert.equal(classifyTeamCatalogError({ code: "42501" }), "denied");
  assert.equal(classifyTeamCatalogError({ code: "P0002" }), "not-found");
  assert.equal(classifyTeamCatalogError({ code: "23514" }), "invalid");
  assert.equal(classifyTeamCatalogError({ code: "22023", message: "reason required" }), "invalid");
  assert.equal(classifyTeamCatalogError({ code: "22023",
    message: "idempotency key reused with different input" }), "conflict");
  assert.equal(classifyTeamCatalogError({ code: "XX000" }), "unavailable");

  const calls = [];
  const repository = createTeamCatalogRepository(async (name, args) => {
    calls.push([name, args]);
    if (name === "direct_entry_list_teams_admin") return { data: LIST, error: null };
    if (name === "direct_entry_get_team_admin") return { data: ITEM, error: null };
    if (name === "direct_entry_create_team") return { data: CREATE, error: null };
    if (name === "direct_entry_update_team") return { data: MUTATION, error: null };
    if (name === "direct_entry_set_team_active") return { data: MUTATION, error: null };
    return { data: null, error: { code: "XX000" } };
  });

  assert.deepEqual(await repository.listTeams({ ...ACTOR, search: null,
    include_inactive: true, page: 1, page_size: 25 }), { ok: true, data: LIST });
  assert.deepEqual(calls[0], ["direct_entry_list_teams_admin",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id, p_search: null,
      p_include_inactive: true, p_page: 1, p_page_size: 25 }]);

  assert.deepEqual(await repository.getTeam({ ...ACTOR, team_id: TEAM }), { ok: true, data: ITEM });
  assert.deepEqual(calls[1], ["direct_entry_get_team_admin",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id, p_team_id: TEAM }]);

  assert.deepEqual(await repository.createTeam({ ...ACTOR, expected_version: 0, code: "TEAM_ONE",
    display_name: "Synthetic Team", reason: "Synthetic reason", idempotency_key: KEY }),
  { ok: true, data: CREATE });
  assert.deepEqual(calls[2], ["direct_entry_create_team",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id, p_expected_version: 0,
      p_code: "TEAM_ONE", p_display_name: "Synthetic Team", p_reason: "Synthetic reason",
      p_idempotency_key: KEY }]);

  assert.deepEqual(await repository.updateTeam({ ...ACTOR, team_id: TEAM, expected_version: 2,
    display_name: "Synthetic Team", reason: "Synthetic reason", idempotency_key: KEY }),
  { ok: true, data: MUTATION });
  assert.deepEqual(calls[3], ["direct_entry_update_team",
    { p_auth_subject: ACTOR.auth_subject, p_app_user_id: ACTOR.app_user_id, p_team_id: TEAM,
      p_expected_version: 2, p_display_name: "Synthetic Team", p_reason: "Synthetic reason",
      p_idempotency_key: KEY }]);
  assert.equal(Object.keys(calls[3][1]).some((key) => key.includes("active")), false,
    "the generic update sends no active field");

  assert.deepEqual(await repository.setTeamActive({ ...ACTOR, team_id: TEAM, active: false,
    expected_version: 2, reason: "Synthetic reason", idempotency_key: KEY }),
  { ok: true, data: MUTATION });

  const malformed = createTeamCatalogRepository(async () => ({
    data: { unexpected: true }, error: null,
  }));
  assert.deepEqual(await malformed.listTeams({ ...ACTOR, search: null, include_inactive: true,
    page: 1, page_size: 25 }), { ok: false, kind: "unavailable" });

  const denied = createTeamCatalogRepository(async () => ({
    data: null, error: { code: "P0002", message: "team not found" },
  }));
  assert.deepEqual(await denied.getTeam({ ...ACTOR, team_id: TEAM }), { ok: false, kind: "not-found" });
});
