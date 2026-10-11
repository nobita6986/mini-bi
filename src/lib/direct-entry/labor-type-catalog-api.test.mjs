import assert from "node:assert/strict";
import test from "node:test";

import {
  createLaborTypeCatalog,
  getLaborTypeCatalog,
  laborTypeCatalogCreateRequest,
  laborTypeCatalogListQuery,
  laborTypeCatalogSetActiveRequest,
  laborTypeCatalogUpdateRequest,
  listLaborTypeCatalog,
  setLaborTypeCatalogActive,
  updateLaborTypeCatalog,
} from "./labor-type-catalog-api.ts";
import {
  LABOR_TYPE_KEY,
  laborTypeCatalogCreateResult,
  laborTypeCatalogItem,
  laborTypeCatalogList,
  laborTypeCatalogMutation,
} from "./labor-type-catalog-contract.ts";
import {
  classifyLaborTypeCatalogError,
  createLaborTypeCatalogRepository,
} from "./labor-type-catalog-repository.ts";

const ACTOR = { auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222" };
const KEY = "55555555-5555-4555-8555-555555555555";
const REV = "99999999-9999-4999-8999-999999999999";

const ITEM = { labor_type_key: "OUTSOURCED", display_name: "Gia công",
  reporting_key: "gia công", sort_order: 30, active: true, version: 1, revision_count: 0 };
const MUTATION = { labor_type_key: "OUTSOURCED", display_name: "Gia công",
  reporting_key: "gia công", sort_order: 30, active: false, version: 2, revision_id: REV };
const CREATE = { ...MUTATION, created: true };
const LIST = { authorization_date: "2026-10-11", include_inactive: true, search: null,
  page: 1, page_size: 20, total: 1, labor_types: [ITEM] };

function deps(result, session = { actor: { ok: true, actor: ACTOR } }) {
  const calls = { session: 0, rpc: [] };
  return {
    calls,
    dependencies: {
      resolveSession: async () => { calls.session += 1; return session; },
      repository: {
        listLaborTypes: async (i) => { calls.rpc.push(["list", i]); return result; },
        getLaborType: async (i) => { calls.rpc.push(["get", i]); return result; },
        createLaborType: async (i) => { calls.rpc.push(["create", i]); return result; },
        updateLaborType: async (i) => { calls.rpc.push(["update", i]); return result; },
        setLaborTypeActive: async (i) => { calls.rpc.push(["active", i]); return result; },
      },
    },
  };
}
function jsonRequest(body, path = "/api/admin/catalog/labor-types", headers = {}) {
  return new Request("https://app.test" + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test",
      host: "app.test", "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify(body),
  });
}
const CREATE_BODY = { expected_version: 0, labor_type_key: "PROBATION",
  display_name: "Thử việc", sort_order: 40, reason: "Synthetic reason",
  idempotency_key: KEY };
const UPDATE_BODY = { expected_version: 1, display_name: "Thử việc",
  sort_order: 45, reason: "Synthetic reason", idempotency_key: KEY };
const ACTIVE_BODY = { active: false, expected_version: 1,
  reason: "Synthetic reason", idempotency_key: KEY };

test("W02C contract accepts exactly the reviewed projection shapes", () => {
  assert.deepEqual(laborTypeCatalogItem(ITEM), ITEM);
  assert.deepEqual(laborTypeCatalogList(LIST), LIST);
  assert.deepEqual(laborTypeCatalogMutation(MUTATION), MUTATION);
  assert.deepEqual(laborTypeCatalogCreateResult(CREATE), CREATE);
  assert.equal(laborTypeCatalogItem({ ...ITEM, extra: 1 }), null);
  const withoutReporting = { ...ITEM };
  delete withoutReporting.reporting_key;
  assert.equal(laborTypeCatalogItem(withoutReporting), null);
  assert.equal(laborTypeCatalogItem({ ...ITEM, labor_type_key: "outsourced" }), null);
  assert.equal(laborTypeCatalogItem({ ...ITEM, labor_type_key: "1BAD" }), null);
  assert.equal(laborTypeCatalogItem({ ...ITEM, active: "true" }), null);
  assert.equal(laborTypeCatalogItem({ ...ITEM, version: -1 }), null);
  assert.equal(laborTypeCatalogItem(null), null);
  assert.equal(laborTypeCatalogList({ ...LIST, labor_types: [{ ...ITEM, sort_order: "30" }] }), null);
  assert.equal(laborTypeCatalogCreateResult({ ...CREATE, created: false }), null);
  assert.equal(laborTypeCatalogMutation({ ...MUTATION, revision_count: 1 }), null);
  // The canonical key format is the only accepted shape.
  assert.ok(LABOR_TYPE_KEY.test("TEMPORARY"));
  assert.ok(LABOR_TYPE_KEY.test("A_1"));
  assert.ok(!LABOR_TYPE_KEY.test(""));
  assert.ok(!LABOR_TYPE_KEY.test("A".repeat(65)));
});

test("W02C feature gate runs before session and repository", async () => {
  const d = deps({ ok: true, data: LIST });
  const res = await listLaborTypeCatalog(new Request("https://app.test/x"), "false", d.dependencies);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { ok: false, code: "NOT_FOUND" });
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("W02C same-origin is enforced before session and repository on mutations", async () => {
  const d = deps({ ok: true, data: CREATE });
  const blocked = await createLaborTypeCatalog(
    jsonRequest(CREATE_BODY, "/x", { origin: "https://evil.test" }), "true", d.dependencies);
  assert.equal(blocked.status, 403);
  assert.deepEqual(await blocked.json(), { ok: false, code: "CSRF_REJECTED" });
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("W02C content-type and bounded JSON are enforced before the repository", async () => {
  const d = deps({ ok: true, data: CREATE });
  const wrong = new Request("https://app.test/x", { method: "POST",
    headers: { "content-type": "text/plain", origin: "https://app.test", host: "app.test",
      "sec-fetch-site": "same-origin" }, body: "{}" });
  const res = await createLaborTypeCatalog(wrong, "true", d.dependencies);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, code: "CONTENT_TYPE_INVALID" });
  assert.equal(d.calls.rpc.length, 0);
});

test("W02C a client authority field is rejected before the repository", async () => {
  const d = deps({ ok: true, data: CREATE });
  const res = await createLaborTypeCatalog(
    jsonRequest({ ...CREATE_BODY, app_user_id: ACTOR.app_user_id }), "true", d.dependencies);
  assert.equal(res.status, 400);
  assert.equal(d.calls.session, 0);
  assert.equal(d.calls.rpc.length, 0);
});

test("W02C the idempotency header must match the body key", async () => {
  const d = deps({ ok: true, data: CREATE });
  const res = await createLaborTypeCatalog(
    jsonRequest(CREATE_BODY, "/x", { "idempotency-key": REV }), "true", d.dependencies);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, code: "IDEMPOTENCY_KEY_MISMATCH" });
  assert.equal(d.calls.rpc.length, 0);
});

test("W02C session failures are sanitized and never reach the repository", async () => {
  const denied = deps({ ok: true, data: LIST },
    { actor: { ok: false, reason: "NOT_MAPPED" } });
  const res = await listLaborTypeCatalog(new Request("https://app.test/x"), "true", denied.dependencies);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });
  assert.equal(denied.calls.rpc.length, 0);

  const unauthenticated = deps({ ok: true, data: LIST },
    { actor: { ok: false, reason: "UNAUTHENTICATED" } });
  const unauth = await listLaborTypeCatalog(new Request("https://app.test/x"), "true",
    unauthenticated.dependencies);
  assert.equal(unauth.status, 401);
  assert.deepEqual(await unauth.json(), { ok: false, code: "UNAUTHENTICATED" });
});

test("W02C list query parses strictly and never defaults to include_inactive true", () => {
  const url = new URL("https://app.test/x?search=%20Gia%20c%C3%B4ng%20&include_inactive=false&page=2&page_size=50");
  assert.deepEqual(laborTypeCatalogListQuery(url),
    { ok: true, value: { search: "Gia công", include_inactive: false, page: 2, page_size: 50 } });
  assert.deepEqual(laborTypeCatalogListQuery(new URL("https://app.test/x")),
    { ok: true, value: { search: null, include_inactive: true, page: 1, page_size: 100 } });
  for (const bad of ["?include_inactive=1", "?include_inactive=", "?page=0", "?page=1001",
    "?page_size=0", "?page_size=101", "?page=abc"]) {
    const parsed = laborTypeCatalogListQuery(new URL("https://app.test/x" + bad));
    assert.equal(parsed.ok, false, bad);
    assert.equal(parsed.response.status, 400, bad);
  }
  const tooLong = laborTypeCatalogListQuery(new URL("https://app.test/x?search=" + "a".repeat(257)));
  assert.equal(tooLong.ok, false);
});

test("W02C create request is strict and never accepts reporting_key", () => {
  assert.deepEqual(laborTypeCatalogCreateRequest(CREATE_BODY),
    { ok: true, value: CREATE_BODY });
  for (const bad of [
    { ...CREATE_BODY, expected_version: 1 },
    { ...CREATE_BODY, labor_type_key: "probation" },
    { ...CREATE_BODY, labor_type_key: "BAD KEY" },
    { ...CREATE_BODY, display_name: "   " },
    { ...CREATE_BODY, sort_order: -1 },
    { ...CREATE_BODY, sort_order: 100001 },
    { ...CREATE_BODY, sort_order: 1.5 },
    { ...CREATE_BODY, reason: "" },
    { ...CREATE_BODY, idempotency_key: "not-a-uuid" },
    { ...CREATE_BODY, reporting_key: "probation" },
    { ...CREATE_BODY, active: false },
  ]) {
    const parsed = laborTypeCatalogCreateRequest(bad);
    assert.equal(parsed.ok, false, JSON.stringify(bad));
    assert.equal(parsed.response.status, 400);
  }
});

test("W02C update request is strict, needs OCC and cannot move the key", () => {
  assert.deepEqual(laborTypeCatalogUpdateRequest(UPDATE_BODY), { ok: true, value: UPDATE_BODY });
  for (const bad of [
    { ...UPDATE_BODY, expected_version: 0 },
    { ...UPDATE_BODY, expected_version: null },
    { ...UPDATE_BODY, display_name: "" },
    { ...UPDATE_BODY, sort_order: 100001 },
    { ...UPDATE_BODY, labor_type_key: "OUTSOURCED" },
    { ...UPDATE_BODY, reporting_key: "gia công" },
    { ...UPDATE_BODY, active: true },
  ]) {
    const parsed = laborTypeCatalogUpdateRequest(bad);
    assert.equal(parsed.ok, false, JSON.stringify(bad));
  }
});

test("W02C set-active request is strict and needs OCC", () => {
  assert.deepEqual(laborTypeCatalogSetActiveRequest(ACTIVE_BODY),
    { ok: true, value: ACTIVE_BODY });
  for (const bad of [
    { ...ACTIVE_BODY, active: "false" },
    { ...ACTIVE_BODY, expected_version: 0 },
    { ...ACTIVE_BODY, reason: "" },
    { ...ACTIVE_BODY, display_name: "Gia công" },
  ]) {
    assert.equal(laborTypeCatalogSetActiveRequest(bad).ok, false, JSON.stringify(bad));
  }
});

test("W02C extensibility: a fourth type passes every shape check with no source vocabulary", () => {
  // Mandatory extensibility proof (survey section 7): the ONLY gate on a new
  // labor type is the canonical key format plus the active catalog projection.
  // No validator, contract or projection may carry a closed three-key set.
  for (const key of ["PROBATION", "SEASONAL_2", "A"]) {
    const parsed = laborTypeCatalogCreateRequest({ ...CREATE_BODY, labor_type_key: key });
    assert.equal(parsed.ok, true, key);
    assert.equal(parsed.value.labor_type_key, key);
  }
  const fourth = { labor_type_key: "PROBATION", display_name: "Thử việc",
    reporting_key: "probation", sort_order: 40, active: true, version: 1, revision_count: 1 };
  assert.deepEqual(laborTypeCatalogItem(fourth), fourth);
  assert.deepEqual(laborTypeCatalogList({ ...LIST, total: 2, labor_types: [ITEM, fourth] }),
    { ...LIST, total: 2, labor_types: [ITEM, fourth] });
  // The retired closed set must not exist anywhere in the modules.
  const sources = [
    laborTypeCatalogItem.toString(), laborTypeCatalogList.toString(),
    laborTypeCatalogCreateRequest.toString(), laborTypeCatalogUpdateRequest.toString(),
    laborTypeCatalogSetActiveRequest.toString(),
  ].join("\n");
  assert.equal(sources.includes("TEMPORARY"), false);
  assert.equal(sources.includes("PERMANENT"), false);
});

test("W02C SQLSTATE taxonomy is closed and never leaks the raw message", () => {
  assert.equal(classifyLaborTypeCatalogError({ code: "40001" }), "conflict");
  assert.equal(classifyLaborTypeCatalogError({ code: "23505" }), "conflict");
  assert.equal(classifyLaborTypeCatalogError({ code: "42501" }), "denied");
  assert.equal(classifyLaborTypeCatalogError({ code: "P0002" }), "not-found");
  assert.equal(classifyLaborTypeCatalogError({ code: "23514" }), "invalid");
  assert.equal(classifyLaborTypeCatalogError({ code: "23503" }), "invalid");
  assert.equal(classifyLaborTypeCatalogError({ code: "22023" }), "invalid");
  assert.equal(classifyLaborTypeCatalogError({ code: "22023",
    message: "idempotency key reused with different input" }), "conflict");
  assert.equal(classifyLaborTypeCatalogError({ code: "XX000" }), "unavailable");
  assert.equal(classifyLaborTypeCatalogError({}), "unavailable");
});

test("W02C repository calls only the five canonical RPCs with server actor refs", async () => {
  const seen = [];
  const repository = createLaborTypeCatalogRepository(async (name, args) => {
    seen.push([name, args]);
    if (name === "direct_entry_list_labor_types_admin") return { data: LIST, error: null };
    if (name === "direct_entry_get_labor_type_admin") return { data: ITEM, error: null };
    if (name === "direct_entry_create_labor_type") return { data: CREATE, error: null };
    return { data: MUTATION, error: null };
  });
  const actor = { auth_subject: ACTOR.auth_subject, app_user_id: ACTOR.app_user_id };
  assert.equal((await repository.listLaborTypes({ ...actor, search: null, include_inactive: true,
    page: 1, page_size: 20 })).ok, true);
  assert.equal((await repository.getLaborType({ ...actor, labor_type_key: "OUTSOURCED" })).ok, true);
  assert.equal((await repository.createLaborType({ ...actor, expected_version: 0,
    labor_type_key: "PROBATION", display_name: "Thử việc", sort_order: 40, reason: "r",
    idempotency_key: KEY })).ok, true);
  assert.equal((await repository.updateLaborType({ ...actor, labor_type_key: "OUTSOURCED",
    expected_version: 1, display_name: "Gia công", sort_order: 30, reason: "r",
    idempotency_key: KEY })).ok, true);
  assert.equal((await repository.setLaborTypeActive({ ...actor, labor_type_key: "OUTSOURCED",
    active: false, expected_version: 1, reason: "r", idempotency_key: KEY })).ok, true);

  assert.deepEqual(seen.map(([name]) => name), [
    "direct_entry_list_labor_types_admin",
    "direct_entry_get_labor_type_admin",
    "direct_entry_create_labor_type",
    "direct_entry_update_labor_type",
    "direct_entry_set_labor_type_active",
  ]);
  for (const [, args] of seen) {
    assert.equal(args.p_auth_subject, ACTOR.auth_subject);
    assert.equal(args.p_app_user_id, ACTOR.app_user_id);
    // The client can never push a reporting key through the repository.
    assert.equal(Object.hasOwn(args, "p_reporting_key"), false);
  }
  assert.deepEqual(seen[2][1], { p_auth_subject: ACTOR.auth_subject,
    p_app_user_id: ACTOR.app_user_id, p_expected_version: 0, p_labor_type_key: "PROBATION",
    p_display_name: "Thử việc", p_sort_order: 40, p_reason: "r", p_idempotency_key: KEY });
});

test("W02C repository maps RPC errors and fails closed on a malformed payload", async () => {
  const denied = createLaborTypeCatalogRepository(async () => ({ data: null,
    error: { code: "42501", message: "catalog operator denied" } }));
  const deniedOutcome = await denied.listLaborTypes({ auth_subject: ACTOR.auth_subject,
    app_user_id: ACTOR.app_user_id, search: null, include_inactive: true, page: 1, page_size: 20 });
  assert.deepEqual(deniedOutcome, { ok: false, kind: "denied" });

  const malformed = createLaborTypeCatalogRepository(async () => ({ data: { ...ITEM, extra: 1 },
    error: null }));
  const malformedOutcome = await malformed.getLaborType({ auth_subject: ACTOR.auth_subject,
    app_user_id: ACTOR.app_user_id, labor_type_key: "OUTSOURCED" });
  assert.deepEqual(malformedOutcome, { ok: false, kind: "unavailable" });
});

test("W02C handlers return the sanitized envelope and the sanitized error code", async () => {
  const ok = deps({ ok: true, data: ITEM });
  const res = await getLaborTypeCatalog(new Request("https://app.test/x"), "OUTSOURCED", "true",
    ok.dependencies);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, labor_type: ITEM });

  const badKey = deps({ ok: true, data: ITEM });
  const invalid = await getLaborTypeCatalog(new Request("https://app.test/x"), "outsourced", "true",
    badKey.dependencies);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { ok: false, code: "LABOR_TYPE_INVALID" });
  assert.equal(badKey.calls.rpc.length, 0);

  const denied = deps({ ok: false, kind: "denied" });
  const deniedRes = await listLaborTypeCatalog(new Request("https://app.test/x"), "true",
    denied.dependencies);
  assert.equal(deniedRes.status, 403);
  assert.deepEqual(await deniedRes.json(), { ok: false, code: "LABOR_TYPE_DENIED" });

  const notFound = deps({ ok: false, kind: "not-found" });
  const notFoundRes = await getLaborTypeCatalog(new Request("https://app.test/x"), "OUTSOURCED",
    "true", notFound.dependencies);
  assert.equal(notFoundRes.status, 404);
  assert.deepEqual(await notFoundRes.json(), { ok: false, code: "LABOR_TYPE_NOT_FOUND" });

  const conflict = deps({ ok: false, kind: "conflict" });
  const conflictRes = await createLaborTypeCatalog(jsonRequest(CREATE_BODY), "true",
    conflict.dependencies);
  assert.equal(conflictRes.status, 409);
  assert.deepEqual(await conflictRes.json(), { ok: false, code: "LABOR_TYPE_CONFLICT" });

  const created = deps({ ok: true, data: CREATE });
  const createdRes = await createLaborTypeCatalog(jsonRequest(CREATE_BODY), "true",
    created.dependencies);
  assert.equal(createdRes.status, 200);
  assert.deepEqual(await createdRes.json(), { ok: true, labor_type: CREATE });

  const deactivated = deps({ ok: true, data: MUTATION });
  const activeRes = await setLaborTypeCatalogActive(jsonRequest(ACTIVE_BODY),
    "OUTSOURCED", "true", deactivated.dependencies);
  assert.equal(activeRes.status, 200);
  assert.deepEqual(await activeRes.json(), { ok: true, labor_type: MUTATION });

  const updated = deps({ ok: true, data: MUTATION });
  const updateRes = await updateLaborTypeCatalog(jsonRequest(UPDATE_BODY), "OUTSOURCED", "true",
    updated.dependencies);
  assert.equal(updateRes.status, 200);
  assert.deepEqual(updateRes.headers.get("cache-control"), "private, no-store");
});
