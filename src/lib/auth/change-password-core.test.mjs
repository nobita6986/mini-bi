import assert from "node:assert/strict";
import test from "node:test";

import { createChangePasswordResponse } from "./change-password-core.ts";

const SESSION_USER = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "vinhnt.td@hrpartner.vn",
};

const validPayload = () => ({
  currentPassword: "old-secret-pw",
  newPassword: "new-secret-pw",
  confirmPassword: "new-secret-pw",
});

const post = (payload) =>
  new Request("https://app.example/api/auth/change-password", {
    method: "POST",
    headers: {
      Origin: "https://app.example",
      Host: "app.example",
      "Content-Type": "application/json",
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

function clientRecorder(overrides = {}) {
  const calls = {
    getUser: 0,
    signIn: 0,
    update: 0,
    updateArg: null,
    signInArg: null,
  };
  const defaultGetUser = async () => ({ data: { user: SESSION_USER }, error: null });
  const defaultSignIn = async (input) => {
    calls.signInArg = input;
    return { data: { user: SESSION_USER }, error: null };
  };
  const defaultUpdate = async (input) => {
    calls.updateArg = input;
    return { data: { user: SESSION_USER }, error: null };
  };
  const getUser = overrides.getUser ?? defaultGetUser;
  const signIn = overrides.signIn ?? defaultSignIn;
  const update = overrides.update ?? defaultUpdate;
  const client = {
    auth: {
      getUser: async () => {
        calls.getUser++;
        return getUser();
      },
      signInWithPassword: async (input) => {
        calls.signIn++;
        calls.signInArg = input;
        return signIn(input);
      },
      updateUser: async (input) => {
        calls.update++;
        calls.updateArg = input;
        return update(input);
      },
    },
  };
  return { client, calls };
}

test("change-password rejects cross-origin and any non-JSON / unbounded body before creating a client", async () => {
  let created = 0;
  const deps = {
    createClient: async () => { created++; return clientRecorder().client; },
    now: () => "2026-01-01T00:00:00.000Z",
  };
  const invalidRequests = [
    [new Request("https://app.example/api/auth/change-password", { method: "POST", headers: { Host: "app.example" }, body: JSON.stringify(validPayload()) }), 403],
    [new Request("https://app.example/api/auth/change-password", { method: "POST", headers: { Origin: "https://app.example", Host: "app.example" }, body: "x".repeat(4097) }), 400],
    [post({ ...validPayload(), email: "attacker@hrpartner.vn" }), 400],
    [post({ ...validPayload(), user_id: "11111111-1111-1111-1111-111111111111" }), 400],
    [post({ ...validPayload(), app_user_id: "11111111-1111-1111-1111-111111111111" }), 400],
    [post({ currentPassword: "old-secret-pw", newPassword: "new-secret-pw" }), 400],
    [post({ currentPassword: "old-secret-pw", newPassword: "new-secret-pw", confirmPassword: "different" }), 400],
    [post({ currentPassword: "old-secret-pw", newPassword: "short", confirmPassword: "short" }), 400],
    [post({ currentPassword: "same-secret-pw", newPassword: "same-secret-pw", confirmPassword: "same-secret-pw" }), 400],
    [post({ currentPassword: 12345, newPassword: "new-secret-pw", confirmPassword: "new-secret-pw" }), 400],
  ];
  for (const [request, expectedStatus] of invalidRequests) {
    const response = await createChangePasswordResponse(request, deps);
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(created, 0, "client must never be created for an invalid request");
});

test("change-password returns UNAUTHENTICATED when the active session is missing", async () => {
  const { client, calls } = clientRecorder({
    getUser: async () => ({ data: { user: null }, error: null }),
  });
  const response = await createChangePasswordResponse(post(validPayload()), {
    createClient: async () => client,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.clone().json(), { ok: false, code: "AUTH_UNAUTHENTICATED" });
  assert.equal(calls.getUser, 1);
  assert.equal(calls.signIn, 0, "must not re-auth without a live session");
  assert.equal(calls.update, 0, "must not call updateUser without a live session");
});

test("change-password rejects current password mismatches with sanitized INVALID_CURRENT_PASSWORD code", async () => {
  const { client, calls } = clientRecorder({
    signIn: async () => ({
      data: { user: null },
      error: Object.assign(new Error("provider detail access-secret"), { status: 400 }),
    }),
  });
  const response = await createChangePasswordResponse(post(validPayload()), {
    createClient: async () => client,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  assert.equal(response.status, 401);
  const sanitizedOutput = await response.clone().text();
  assert.equal(sanitizedOutput.includes("provider detail"), false);
  assert.equal(sanitizedOutput.includes("access-secret"), false);
  assert.equal(sanitizedOutput.includes("old-secret-pw"), false, "must never leak the current password");
  assert.equal(sanitizedOutput.includes("new-secret-pw"), false, "must never leak the new password");
  assert.equal(sanitizedOutput.includes("vinhnt.td"), false, "must never leak the HRP identifier");
  assert.deepEqual(await response.clone().json(), { ok: false, code: "AUTH_INVALID_CURRENT_PASSWORD" });
  assert.equal(calls.getUser, 1);
  assert.equal(calls.signIn, 1);
  assert.equal(calls.update, 0, "must not call updateUser when current password fails");
});

test("change-password rejects re-auth that returns a different auth_subject", async () => {
  const { client, calls } = clientRecorder({
    signIn: async () => ({
      data: { user: { id: "22222222-2222-2222-2222-222222222222", email: "vinhnt.td@hrpartner.vn" } },
      error: null,
    }),
  });
  const response = await createChangePasswordResponse(post(validPayload()), {
    createClient: async () => client,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.clone().json(), { ok: false, code: "AUTH_INVALID_CURRENT_PASSWORD" });
  assert.equal(calls.update, 0);
});

test("change-password maps HR Partner IDs to the internal email and ignores client-supplied identifiers", async () => {
  const { client, calls } = clientRecorder({
    getUser: async () => ({
      data: { user: { id: SESSION_USER.id, email: "VinhNT.TD" } },
      error: null,
    }),
  });
  const response = await createChangePasswordResponse(post(validPayload()), {
    createClient: async () => client,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.signInArg, { email: "vinhnt.td@hrpartner.vn", password: "old-secret-pw" });
  assert.deepEqual(calls.updateArg, { password: "new-secret-pw" });
  assert.deepEqual(await response.clone().json(), { ok: true });
});

test("change-password succeeds on the live session and never echoes the new password", async () => {
  const { client, calls } = clientRecorder();
  const response = await createChangePasswordResponse(post(validPayload()), {
    createClient: async () => client,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  assert.equal(response.status, 200);
  const body = await response.clone().text();
  assert.equal(body.includes("new-secret-pw"), false);
  assert.equal(body.includes("old-secret-pw"), false);
  assert.equal(body.includes("vinhnt.td"), false);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(calls.getUser, 1);
  assert.equal(calls.signIn, 1);
  assert.equal(calls.update, 1);
});

test("change-password returns PASSWORD_TOO_WEAK when Supabase rejects the update as too weak", async () => {
  const { client, calls } = clientRecorder({
    update: async () => ({
      data: { user: null },
      error: Object.assign(new Error("Password should be at least 8 characters"), { status: 422 }),
    }),
  });
  const response = await createChangePasswordResponse(post(validPayload()), {
    createClient: async () => client,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  assert.equal(response.status, 422);
  const weakOutput = await response.clone().text();
  assert.equal(weakOutput.includes("characters"), false);
  assert.equal(weakOutput.includes("password"), false, "must not echo provider wording about the new password");
  assert.deepEqual(await response.clone().json(), { ok: false, code: "AUTH_PASSWORD_TOO_WEAK" });
  assert.equal(calls.update, 1);
});

test("change-password returns ACTOR_NOT_AVAILABLE when the session is bound to a disabled account", async () => {
  const { client, calls } = clientRecorder();
  const response = await createChangePasswordResponse(post(validPayload()), {
    createClient: async () => client,
    now: () => "2026-01-01T00:00:00.000Z",
    resolveActor: async () => ({ ok: false, reason: "ACTOR_DISABLED" }),
    repository: { loadByAuthSubject: async () => null },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.clone().json(), { ok: false, code: "ACCOUNT_NOT_AVAILABLE" });
  assert.equal(calls.signIn, 0, "must not re-auth when the actor is disabled");
  assert.equal(calls.update, 0, "must not update the password when the actor is disabled");
});

test("change-password returns AUTH_UNAVAILABLE if the session has no email and cannot be re-authenticated", async () => {
  const { client } = clientRecorder({
    getUser: async () => ({ data: { user: { id: SESSION_USER.id, email: null } }, error: null }),
  });
  const response = await createChangePasswordResponse(post(validPayload()), {
    createClient: async () => client,
    now: () => "2026-01-01T00:00:00.000Z",
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.clone().json(), { ok: false, code: "AUTH_UNAVAILABLE" });
});