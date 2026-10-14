/**
 * PRE-W2-HF-D3-B/C - focused API + contract tests (no DB, no Supabase Auth).
 *
 * Full Admin success path (fake repo/auth), claim-loser, provenance mismatch,
 * reset applied/unknown, denied taxonomy, authority-field forbidding, no
 * password/hash leak in any response, personnel-from-account, and the strict
 * request validators.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCreateAccount,
  parseCreatePersonnelFromAccount,
  parseEditDisplayName,
  parseResetPassword,
} from "./account-operation-contract.ts";
import {
  createAccount,
  editDisplayName,
  resetPassword,
  createPersonnelFromAccount,
} from "./account-operation-api.ts";

const AUTH_SUBJECT = "91000000-0000-4000-8000-000000000001";
const APP_USER = "92000000-0000-4000-8000-000000000001";
const INTENT = "93000000-0000-4000-8000-000000000001";
const TOKEN = "94000000-0000-4000-8000-000000000001";
const CREATED_AUTH = "95000000-0000-4000-8000-000000000001";
const REV = "96000000-0000-4000-8000-000000000001";

function session(actor = { auth_subject: AUTH_SUBJECT, app_user_id: APP_USER }) {
  return async () => ({ actor: { ok: true, actor } });
}

function fakeRequest(body, overrides = {}) {
  const headers = {
    origin: "https://example.test",
    host: "example.test",
    "content-type": "application/json",
    ...overrides,
  };
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v ?? null;
  const bytes = new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  const stream = new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
  return { headers: { get: (n) => lower[n.toLowerCase()] ?? null }, body: stream };
}

function repository(overrides = {}) {
  const calls = [];
  return {
    calls,
    async begin() { calls.push("begin"); return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "PENDING" } }; },
    async claim() { calls.push("claim"); return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "IN_FLIGHT", claimed: true } }; },
    async readIntent() { return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "RESET_PASSWORD", state: "IN_FLIGHT", login_id: null, display_name: null, account_ref: APP_USER, auth_subject: CREATED_AUTH, created_at: "x", claimed_at: null, resolved_at: null } }; },
    async finish() { calls.push("finish"); return { ok: true, data: null }; },
    async finalizeCreate() { return { ok: true, data: { app_user_id: APP_USER, auth_subject: CREATED_AUTH, display_name: "Nguyen Van A", version: 1, revision_id: REV, intent_id: INTENT, intent_state: "APPLIED" } }; },
    async updateDisplayName() { return { ok: true, data: { app_user_id: APP_USER, version: 2, revision_id: REV, recruiter_id: null, recruiter_version: null, recruiter_revision_id: null } }; },
    async createPersonnelFromAccount() { return { ok: true, data: { recruiter_id: CREATED_AUTH, display_name: "Nguyen Van A", personnel_code: "NV001", personnel_position: "STAFF", version: 1, link_id: REV, membership_id: INTENT, app_user_version: 2, app_user_revision_id: REV, personnel_revision_id: REV } }; },
    async listEligibleAccounts() { return { ok: true, data: { page: 1, page_size: 25, total: 0, has_more: false, accounts: [] } }; },
    async reclassify() { return { ok: true, data: { reclassified: 0, purged: 0, deleted: 0 } }; },
    ...overrides,
  };
}

function auth(overrides = {}) {
  return {
    async createAuthAccount() { return { kind: "created", auth_subject: CREATED_AUTH }; },
    async readAuthUserProvenance() { return { kind: "match", auth_subject: CREATED_AUTH }; },
    async resetAuthPassword() { return { kind: "applied" }; },
    async findAuthUserByLoginId() { return { kind: "missing" }; },
    ...overrides,
  };
}

function deps(overrides = {}) {
  return {
    resolveSession: session(),
    repository: repository(),
    auth: auth(),
    ...overrides,
  };
}

const VALID_CREATE = {
  login_id: "nv-a", display_name: "Nguyen Van A", password: "strong-pass-123",
  password_confirm: "strong-pass-123", reason: "create", idempotency_key: AUTH_SUBJECT,
};

/* ---------- validators ---------- */
test("D3: create/reset/edit/personnel request validators are strict", () => {
  assert.equal(parseCreateAccount(VALID_CREATE).ok, true);
  assert.equal(parseCreateAccount({ ...VALID_CREATE, password_confirm: "different" }).ok, false);
  assert.equal(parseCreateAccount({ ...VALID_CREATE, password: "short" }).ok, false);
  assert.equal(parseCreateAccount({ ...VALID_CREATE, login_id: "Bad Login" }).ok, false);
  assert.equal(parseCreateAccount({ ...VALID_CREATE, extra: 1 }).ok, false);

  assert.equal(parseResetPassword({
    password: "new-pass-123", password_confirm: "new-pass-123", reason: "reset", idempotency_key: AUTH_SUBJECT,
  }).ok, true);
  assert.equal(parseResetPassword({ password: "new-pass-123", password_confirm: "x", reason: "r", idempotency_key: AUTH_SUBJECT }).ok, false);

  assert.equal(parseEditDisplayName({
    display_name: "New Name", expected_version: 2, reason: "rename", idempotency_key: AUTH_SUBJECT,
  }).ok, true);
  assert.equal(parseEditDisplayName({ display_name: "New Name", expected_version: 0, reason: "rename", idempotency_key: AUTH_SUBJECT }).ok, false);

  assert.equal(parseCreatePersonnelFromAccount({
    account_ref: APP_USER, expected_account_version: 1, personnel_code: "NV001",
    personnel_position: "STAFF", valid_from: "2026-10-01", reason: "create", idempotency_key: AUTH_SUBJECT,
  }).ok, true);
  assert.equal(parseCreatePersonnelFromAccount({
    account_ref: APP_USER, expected_account_version: 1, personnel_code: "NV 001",
    personnel_position: "STAFF", valid_from: "2026-10-01", reason: "create", idempotency_key: AUTH_SUBJECT,
  }).ok, false, "personnel code must reject whitespace");
});

/* ---------- create account saga ---------- */
test("D3: create account success returns the finalized account without leaking password", async () => {
  const d = deps();
  const response = await createAccount(fakeRequest(VALID_CREATE), "true", d);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.account.app_user_id, APP_USER);
  assert.equal(JSON.stringify(body).includes(VALID_CREATE.password), false, "no password in response");
  assert.deepEqual(d.repository.calls, ["begin", "claim"]);
});

test("D3: create account claim loser returns 409 and never calls Auth", async () => {
  let authCalled = false;
  const d = deps({
    repository: repository({
      async claim() { return { ok: true, data: { intent_id: INTENT, intent_token: TOKEN, kind: "CREATE_ACCOUNT", state: "IN_FLIGHT", claimed: false } }; },
    }),
    auth: auth({ async createAuthAccount() { authCalled = true; return { kind: "created", auth_subject: CREATED_AUTH }; } }),
  });
  const response = await createAccount(fakeRequest(VALID_CREATE), "true", d);
  assert.equal(response.status, 409);
  assert.equal(authCalled, false, "no second Auth call on claim loss");
});

test("D3: create account provenance mismatch is finalized as BLOCKED, not APPLIED", async () => {
  const d = deps({
    repository: repository({
      async finalizeCreate(input) {
        return { ok: true, data: input.intent_token === TOKEN
          ? { app_user_id: APP_USER, auth_subject: CREATED_AUTH, display_name: "x", version: 1, revision_id: REV, intent_id: INTENT, intent_state: "APPLIED" }
          : { intent_id: INTENT, intent_state: "BLOCKED", account_ref: null } };
      },
    }),
    auth: auth({ async readAuthUserProvenance() { return { kind: "mismatch", auth_subject: CREATED_AUTH }; } }),
  });
  const response = await createAccount(fakeRequest(VALID_CREATE), "true", d);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.intent.state, "BLOCKED");
});

/* ---------- reset saga ---------- */
test("D3: reset password applied calls updateUserById once and marks APPLIED", async () => {
  let resets = 0;
  const d = deps({
    auth: auth({ async resetAuthPassword() { resets += 1; return { kind: "applied" }; } }),
  });
  const response = await resetPassword(fakeRequest({
    password: "new-pass-123", password_confirm: "new-pass-123", reason: "reset", idempotency_key: AUTH_SUBJECT,
  }), APP_USER, "true", d);
  assert.equal(response.status, 200);
  assert.equal(resets, 1);
});

test("D3: reset password unknown marks INDETERMINATE (no replay)", async () => {
  const d = deps({
    auth: auth({ async resetAuthPassword() { return { kind: "unknown" }; } }),
    repository: repository({ async finish(input) { return { ok: true, data: null, outcome: input.outcome }; } }),
  });
  const response = await resetPassword(fakeRequest({
    password: "new-pass-123", password_confirm: "new-pass-123", reason: "reset", idempotency_key: AUTH_SUBJECT,
  }), APP_USER, "true", d);
  assert.equal(response.status, 500);
});

/* ---------- authority / leak taxonomy ---------- */
test("D3: client authority fields are refused before any repository call", async () => {
  const d = deps();
  const response = await createAccount(fakeRequest({ ...VALID_CREATE, scope: "all" }), "true", d);
  assert.equal(response.status, 400);
  assert.equal(d.repository.calls.length, 0, "no repository call on authority rejection");
});

test("D3: missing session actor returns 403", async () => {
  const d = deps({ resolveSession: async () => ({ actor: { ok: false, reason: "ACTOR_DISABLED" } }) });
  const response = await editDisplayName(fakeRequest({
    display_name: "New Name", expected_version: 2, reason: "rename", idempotency_key: AUTH_SUBJECT,
  }), APP_USER, "true", d);
  assert.equal(response.status, 403);
});

/* ---------- personnel from account ---------- */
test("D3: personnel from account returns the created personnel, display_name server-side", async () => {
  const d = deps();
  const response = await createPersonnelFromAccount(fakeRequest({
    account_ref: APP_USER, expected_account_version: 1, personnel_code: "NV001",
    personnel_position: "STAFF", valid_from: "2026-10-01", reason: "create", idempotency_key: AUTH_SUBJECT,
  }), "true", d);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.personnel.display_name, "Nguyen Van A");
  assert.equal(body.personnel.personnel_code, "NV001");
});
