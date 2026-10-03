import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createAuthLoginResponse,
  createAuthLogoutResponse,
  createAuthSessionResponse,
} from "./auth-session-core.ts";

const actor = {
  auth_subject: "auth-subject-must-not-leak",
  app_user_id: "app-user-1",
  enabled: true,
  capabilities: ["entry_create"],
  scopes: [{ kind: "own", reference: "app-user-1", valid_from: "0001-01-01", valid_to: null }],
  self_recruiter_suggestion: "recruiter-1",
  session: { provider: "supabase", verification: "getUser", authenticated_at: null },
};
const repository = { loadByAuthSubject: async () => null };
const validResolution = { ok: true, actor };
const baseDependencies = () => ({
  createClient: async () => { throw new Error("unexpected client creation"); },
  repository,
  resolveActor: async () => validResolution,
  now: () => "2026-01-01T00:00:00.000Z",
});
const request = (path, body) => new Request(`https://app.example${path}`, {
  method: "POST",
  headers: {
    Origin: "https://app.example",
    Host: "app.example",
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});
const credentials = { email: " user@example.com ", password: "  keep exact  " };
const successClient = (overrides = {}) => ({
  auth: {
    signInWithPassword: async () => ({ data: { user: { id: "trusted-auth-subject" } }, error: null }),
    getUser: async () => ({ data: { user: { id: "trusted-auth-subject" } }, error: null }),
    signOut: async () => ({ error: null }),
    ...overrides,
  },
});

test("login validates origin and exact bounded credentials before creating a client", async () => {
  const invalidRequests = [
    [new Request("https://app.example/api/auth/login", { method: "POST", headers: { Host: "app.example" }, body: JSON.stringify(credentials) }), 403],
    [request("/api/auth/login", { ...credentials, role: "admin" }), 400],
    [request("/api/auth/login", { ...credentials, authority: { capabilities: ["*"] } }), 400],
    [request("/api/auth/login", { email: { nested: "user@example.com" }, password: "pw" }), 400],
    [request("/api/auth/login", { email: "user@.example.com", password: "pw" }), 400],
    [new Request("https://app.example/api/auth/login", {
      method: "POST",
      headers: { Origin: "https://app.example", Host: "app.example", "Content-Type": "application/json" },
      body: "x".repeat(4097),
    }), 400],
    [new Request("https://app.example/api/auth/login", {
      method: "POST",
      headers: { Origin: "http://app.example", Host: "app.example", "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    }), 403],
  ];
  for (const [req, expectedStatus] of invalidRequests) {
    let created = 0;
    const response = await createAuthLoginResponse(req, {
      ...baseDependencies(),
      createClient: async () => { created++; return successClient(); },
    });
    assert.equal(response.status, expectedStatus);
    assert.equal(created, 0);
  }
});

test("login verifies returned auth id and returns only the minimal actor projection", async () => {
  let input;
  let resolveInput;
  const dependencies = {
    ...baseDependencies(),
    createClient: async () => successClient({
      signInWithPassword: async (value) => {
        input = value;
        return { data: { user: { id: "trusted-auth-subject" } }, error: null };
      },
    }),
    resolveActor: async (value) => { resolveInput = value; return validResolution; },
  };
  const response = await createAuthLoginResponse(request("/api/auth/login", credentials), dependencies);
  assert.equal(response.status, 200);
  assert.deepEqual(input, { email: "user@example.com", password: credentials.password });
  assert.equal(resolveInput.session.auth_subject, "trusted-auth-subject");
  assert.deepEqual(await response.json(), {
    ok: true,
    actor: {
      app_user_id: actor.app_user_id,
      capabilities: actor.capabilities,
      scopes: actor.scopes,
      self_recruiter_suggestion: actor.self_recruiter_suggestion,
    },
  });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("login returns generic credentials failure and actor rejection signs out locally", async () => {
  const rejected = await createAuthLoginResponse(request("/api/auth/login", credentials), {
    ...baseDependencies(),
    createClient: async () => successClient({
      signInWithPassword: async () => ({ data: { user: null }, error: new Error("provider detail") }),
    }),
  });
  assert.equal(rejected.status, 401);
  assert.deepEqual(await rejected.json(), { ok: false, code: "AUTH_INVALID_CREDENTIALS" });

  let signOutOptions;
  let resolved = 0;
  const unavailable = await createAuthLoginResponse(request("/api/auth/login", credentials), {
    ...baseDependencies(),
    createClient: async () => successClient({
      signOut: async (options) => { signOutOptions = options; return { error: null }; },
    }),
    resolveActor: async () => { resolved++; return { ok: false, reason: "ACTOR_DISABLED" }; },
  });
  assert.equal(unavailable.status, 403);
  assert.equal(resolved, 1);
  assert.deepEqual(signOutOptions, { scope: "local" });
  assert.deepEqual(await unavailable.json(), { ok: false, code: "ACCOUNT_NOT_AVAILABLE" });
});

test("login never exposes credentials, tokens, provider errors, or auth subject", async () => {
  const secrets = ["user@example.com", credentials.password, "access-secret", "refresh-secret", "provider detail"];
  const response = await createAuthLoginResponse(request("/api/auth/login", credentials), {
    ...baseDependencies(),
    createClient: async () => successClient({
      signInWithPassword: async () => ({
        data: { user: null },
        error: Object.assign(new Error("provider detail access-secret refresh-secret"), { status: 400 }),
      }),
    }),
  });
  const output = await response.text();
  for (const secret of secrets) assert.equal(output.includes(secret), false);
  assert.equal(output.includes("auth-subject"), false);
  assert.equal(response.headers.get("cache-control"), "private, no-store");

  const unavailable = await createAuthLoginResponse(request("/api/auth/login", credentials), {
    ...baseDependencies(),
    createClient: async () => successClient({
      signInWithPassword: async () => ({
        data: { user: null },
        error: Object.assign(new Error("provider detail"), { status: 503 }),
      }),
    }),
  });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { ok: false, code: "AUTH_UNAVAILABLE" });
});

test("logout is same-origin guarded, local, idempotent and no-store", async () => {
  let calls = 0;
  const dependencies = {
    createClient: async () => {
      calls++;
      return successClient({
        signOut: async (options) => {
          assert.deepEqual(options, { scope: "local" });
          return { error: null };
        },
      });
    },
  };
  const denied = await createAuthLogoutResponse(
    new Request("https://app.example/api/auth/logout", { method: "POST", headers: { Host: "app.example" } }),
    dependencies,
  );
  assert.equal(denied.status, 403);
  assert.equal(calls, 0);
  const response = await createAuthLogoutResponse(request("/api/auth/logout"), dependencies);
  assert.equal(response.status, 204);
  assert.equal(calls, 1);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const noSession = await createAuthLogoutResponse(request("/api/auth/logout"), {
    createClient: async () => successClient({
      signOut: async () => ({ error: null }),
    }),
  });
  assert.equal(noSession.status, 204);
});

test("session uses the trusted actor result and sanitizes unauthenticated/unavailable states", async () => {
  let getUserCalls = 0;
  const success = await createAuthSessionResponse(async () => {
    getUserCalls++;
    const user = await successClient().auth.getUser();
    assert.equal(user.data.user.id, "trusted-auth-subject");
    return { actor: validResolution };
  });
  assert.equal(getUserCalls, 1);
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("cache-control"), "private, no-store");

  const unauthenticated = await createAuthSessionResponse(async () => ({
    actor: { ok: false, reason: "UNAUTHENTICATED" },
  }));
  assert.equal(unauthenticated.status, 401);
  const unavailable = await createAuthSessionResponse(async () => ({
    actor: { ok: false, reason: "ACTOR_MAPPING_MISSING" },
  }));
  assert.equal(unavailable.status, 403);
  assert.deepEqual(await unavailable.json(), { ok: false, code: "ACCOUNT_NOT_AVAILABLE" });
});

test("route handlers are dynamic Node server compositions and session reuses getUser bootstrap", () => {
  for (const routePath of [
    "../../app/api/auth/login/route.ts",
    "../../app/api/auth/logout/route.ts",
    "../../app/api/auth/session/route.ts",
  ]) {
    const source = readFileSync(new URL(routePath, import.meta.url), "utf8");
    assert.match(source, /export const runtime = "nodejs"/);
    assert.match(source, /export const dynamic = "force-dynamic"/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /createServiceSupabaseClient/);
  }
  const sessionRoute = readFileSync(new URL("../../app/api/auth/session/route.ts", import.meta.url), "utf8");
  assert.match(sessionRoute, /getDirectEntryActor/);
  const sessionCore = readFileSync(new URL("./direct-entry-session-core.ts", import.meta.url), "utf8");
  assert.match(sessionCore, /client\.auth\.getUser\(\)/);
});
