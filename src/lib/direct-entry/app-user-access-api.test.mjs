import assert from "node:assert/strict";
import test from "node:test";

import {
  getAccount,
  listAccounts,
  mutateAccount,
} from "./app-user-access-api.ts";
import { createAccountAccessRepository, classifyAccountAccessError } from "./app-user-access-repository.ts";
import {
  projectExistingAccount,
  projectExistingAccountList,
} from "./app-user-access-contract.ts";

const ACTOR = {
  auth_subject: "10000000-0000-4000-8000-000000000101",
  app_user_id: "20000000-0000-4000-8000-000000000101",
  display_name: "Synthetic Admin",
  enabled: true,
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
  scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
  self_recruiter_suggestion: null,
  session: { provider: "supabase", verification: "getUser", authenticated_at: null },
};
const ACCOUNT = {
  account_ref: "40000000-0000-4000-8000-000000000103",
  account_label: "TK-abcdef12",
  enabled: true,
  version: 1,
};
const LIST = { enabled: "all", page: 1, page_size: 25, total: 1, accounts: [ACCOUNT] };
function deps(overrides = {}) {
  return {
    resolveSession: async () => ({ actor: { ok: true, actor: ACTOR } }),
    repository: {
      listAccounts: async () => ({ ok: true, data: LIST }),
      getAccount: async () => ({ ok: true, data: ACCOUNT }),
      enableAccount: async () => ({ ok: true, data: null }),
      disableAccount: async () => ({ ok: true, data: null }),
      ...overrides,
    },
  };
}
function request(url, init = {}) {
  return new Request(`https://app.test${url}`, init);
}
function json(body, headers = {}) {
  return { method: "POST", headers: { origin: "https://app.test", host: "app.test", "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

test("strict projection rejects raw identity and extra fields", () => {
  assert.deepEqual(Object.keys(projectExistingAccount(ACCOUNT)).sort(), ["account_label", "account_ref", "enabled", "version"]);
  assert.deepEqual(Object.keys(projectExistingAccountList(LIST)).sort(), ["accounts", "enabled", "page", "page_size", "total"]);
  assert.equal(projectExistingAccount({ ...ACCOUNT, email: "x@example.test" }), null);
  assert.equal(projectExistingAccount({ ...ACCOUNT, auth_subject: ACTOR.auth_subject }), null);
  assert.equal(projectExistingAccountList({ ...LIST, raw_uuid: ACCOUNT.account_ref }), null);
});

test("R2 API list/detail allow only strict server projections", async () => {
  const list = await listAccounts(request("/api/admin/access/accounts?enabled=all&page=1&page_size=25"), "true", deps());
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { ok: true, list: LIST });
  const detail = await getAccount(request("/api/admin/access/accounts/ref"), ACCOUNT.account_ref, "true", deps());
  assert.equal(detail.status, 200);
  assert.deepEqual(await detail.json(), { ok: true, account: ACCOUNT });
  const malformed = await listAccounts(request("/api/admin/access/accounts?search=x"), "true", deps());
  assert.deepEqual([malformed.status, await malformed.json()], [400, { ok: false, code: "ACCOUNT_INVALID" }]);
  const malformedRepo = createAccountAccessRepository(async () => ({ data: { ...LIST, accounts: [{ ...ACCOUNT, email: "x@example.test" }] }, error: null }));
  const leaked = await listAccounts(request("/api/admin/access/accounts"), "true", deps({
    listAccounts: (...args) => malformedRepo.listAccounts(args[0]),
  }));
  assert.deepEqual([leaked.status, await leaked.json()], [500, { ok: false, code: "ACCOUNT_UNAVAILABLE" }]);
});

test("R2 API mutations enforce gate, same-origin, bounded exact body and return no row", async () => {
  let called = null;
  const repository = {
    ...deps().repository,
    disableAccount: async (input) => { called = input; return { ok: true, data: null }; },
  };
  const response = await mutateAccount(request("/api/admin/access/accounts/ref/disable", json({
    expected_version: 1, reason: "R2 reason", idempotency_key: "r2-key",
  }, { "idempotency-key": "r2-key" })), ACCOUNT.account_ref, "disable", "true", deps(repository));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(called, { auth_subject: ACTOR.auth_subject, app_user_id: ACTOR.app_user_id, target_app_user_id: ACCOUNT.account_ref, expected_version: 1, reason: "R2 reason", idempotency_key: "r2-key" });

  const mismatch = await mutateAccount(request("/api/admin/access/accounts/ref/disable", json({ expected_version: 1, reason: "R2 reason", idempotency_key: "r2-key" }, { "idempotency-key": "other" })), ACCOUNT.account_ref, "disable", "true", deps());
  assert.equal(mismatch.status, 400);
  const csrf = await mutateAccount(request("/api/admin/access/accounts/ref/disable", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test", host: "app.test" }, body: JSON.stringify({ expected_version: 1, reason: "x", idempotency_key: "k" }) }), ACCOUNT.account_ref, "disable", "true", deps());
  assert.equal(csrf.status, 403);
  const off = await mutateAccount(request("/api/admin/access/accounts/ref/disable", json({ expected_version: 1, reason: "x", idempotency_key: "k" })), ACCOUNT.account_ref, "disable", "false", deps());
  assert.equal(off.status, 404);
});

test("R2 API denies unavailable actors and maps repository taxonomy", async () => {
  const denied = await listAccounts(request("/api/admin/access/accounts"), "true", {
    ...deps(), resolveSession: async () => ({ actor: { ok: false, reason: "ACTOR_DISABLED" } }),
  });
  assert.deepEqual([denied.status, await denied.json()], [403, { ok: false, code: "ACTOR_NOT_AVAILABLE" }]);
  for (const [sqlstate, kind] of [["40001", "conflict"], ["42501", "denied"], ["P0002", "not-found"], ["22023", "invalid"], ["XX000", "unavailable"]]) {
    assert.equal(classifyAccountAccessError({ code: sqlstate }), kind);
  }
  const malformedRepo = createAccountAccessRepository(async () => ({ data: { ...ACCOUNT, extra: true }, error: null }));
  const malformed = await getAccount(request("/api/admin/access/accounts/ref"), ACCOUNT.account_ref, "true", deps({
    getAccount: (...args) => malformedRepo.getAccount(args[0]),
  }));
  assert.equal(malformed.status, 500);
});

test("repository exposes only canonical read/lifecycle RPCs", async () => {
  const calls = [];
  const repo = createAccountAccessRepository(async (name, args) => {
    calls.push([name, args]);
    if (name === "direct_entry_list_app_users_admin") return { data: LIST, error: null };
    if (name === "direct_entry_get_app_user_admin") return { data: ACCOUNT, error: null };
    return { data: { change: "disable" }, error: null };
  });
  await repo.listAccounts({ auth_subject: ACTOR.auth_subject, app_user_id: ACTOR.app_user_id, enabled: "all", page: 1, page_size: 25 });
  await repo.getAccount({ auth_subject: ACTOR.auth_subject, app_user_id: ACTOR.app_user_id, target_app_user_id: ACCOUNT.account_ref });
  await repo.disableAccount({ auth_subject: ACTOR.auth_subject, app_user_id: ACTOR.app_user_id, target_app_user_id: ACCOUNT.account_ref, expected_version: 1, reason: "x", idempotency_key: "k" });
  assert.deepEqual(calls.map(([name]) => name), ["direct_entry_list_app_users_admin", "direct_entry_get_app_user_admin", "direct_entry_disable_app_user"]);
});
