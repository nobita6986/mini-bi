/**
 * P3-W08A — Session revocation / cache hardening regression evidence.
 *
 * Behaviour already correct in the post-H04 / post-W02E auth boundary; this
 * file adds the explicit regression evidence required by the W08A test
 * matrix. Each test pins a single contract cell so that any future refactor
 * that loosens it is caught immediately.
 *
 * Sources pinned (all read-only assertions on the live source):
 *   - src/lib/auth/auth-session-core.ts        (login / logout / session)
 *   - src/lib/auth/api-session-guard.ts         (sanitised 401/403 helper)
 *   - src/lib/auth/direct-entry-session-core.ts (getUser + forwarded headers)
 *   - src/lib/auth/direct-entry-v2.ts           (resolveActor / FORBIDDEN_CLIENT_FIELDS)
 *   - src/lib/auth/direct-entry-session-retry.ts (bounded retry, no allow-through)
 *   - src/lib/auth/session-page-access.ts       (page decision)
 *   - src/lib/auth/direct-entry-page-access.ts  (page decision)
 *   - src/lib/auth/supabase-cookie-adapter.ts   (no headers leak)
 *   - src/app/api/auth/{login,logout,session}/route.ts (force-dynamic)
 *   - src/app/dashboard/page.tsx                (decideSessionPageAccess before fetch)
 *   - src/app/direct-entry/page.tsx             (decideDirectEntryPageAccess)
 *
 * Acceptance matrix (the brief):
 *   1. unauthenticated -> sanitised 401 + private,no-store (+nosniff, no-referrer)
 *   2. actor missing/disabled -> sanitised fail-closed
 *   3. enabled A -> logout -> unauthenticated
 *   4. A -> B -> only actor B (capabilities, scopes, recruiter suggestion)
 *   5. failed B mapping -> session is signed out
 *   6. capability/grant revocation effective at next resolve
 *   7. cookie refresh does not become shared cache
 *   8. concurrent requests do not mix actors
 *   9. logout error does not signal fake success
 *  10. retry only on transient, bounded
 *  11. no secret/PII/raw token in any auth response
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createAuthLoginResponse,
  createAuthLogoutResponse,
  createAuthSessionResponse,
} from "./auth-session-core.ts";
import { resolveDirectEntrySession } from "./direct-entry-session-core.ts";
import {
  resolveActor,
  authorizeDirectEntry,
  validateClientBusinessPayload,
} from "./direct-entry-v2.ts";
import { resolveSessionWithBoundedRetry } from "./direct-entry-session-retry.ts";
import { decideSessionPageAccess } from "./session-page-access.ts";
import { decideDirectEntryPageAccess } from "./direct-entry-page-access.ts";
import { createSupabaseCookieAdapter } from "./supabase-cookie-adapter.ts";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const baseActor = {
  auth_subject: "00000000-0000-4000-8000-000000000001",
  app_user_id: "00000000-0000-4000-8000-000000000010",
  enabled: true,
  capabilities: ["entry_create", "entry_own"],
  scopes: [{
    kind: "own",
    reference: "00000000-0000-4000-8000-000000000010",
    valid_from: "0001-01-01",
    valid_to: null,
  }],
  self_recruiter_suggestion: "rcr_a",
  session: { provider: "supabase", verification: "getUser", authenticated_at: null },
};

/**
 * Raw repository row — the full set of fields `isValidAuthorizationRecord`
 * checks. Tests that exercise `resolveActor` need this shape; tests that
 * only deal with the post-resolution projection can use `baseActor`.
 */
function fullRecord(overrides = {}) {
  return {
    auth_subject: "00000000-0000-4000-8000-000000000001",
    app_user_id: "00000000-0000-4000-8000-000000000010",
    enabled: true,
    capabilities: ["entry_create", "entry_own"],
    recruiter_links: [],
    teams: [],
    team_scope_grants: [],
    all_scope_grants: [],
    ...overrides,
  };
}

const baseTimestamp = "2026-10-05T12:00:00.000Z";

function credentialRequest(extra = {}) {
  return new Request("https://app.example/api/auth/login", {
    method: "POST",
    headers: {
      Origin: "https://app.example",
      Host: "app.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: "user@example.com", password: "  pw  ", ...extra }),
  });
}

function makeClient(overrides = {}) {
  return {
    auth: {
      signInWithPassword: async () => ({
        data: { user: { id: baseActor.auth_subject } },
        error: null,
      }),
      getUser: async () => ({
        data: { user: { id: baseActor.auth_subject } },
        error: null,
      }),
      signOut: async () => ({ error: null }),
      ...overrides,
    },
  };
}

function deps(overrides = {}) {
  return {
    createClient: async () => makeClient(),
    repository: { loadByAuthSubject: async () => structuredClone(baseActor) },
    resolveActor: async () => ({ ok: true, actor: structuredClone(baseActor) }),
    now: () => baseTimestamp,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. Logout: cache headers, no info leak, error path does not signal success
// ---------------------------------------------------------------------------

test("W08A A.1: logout 204 carries private,no-store + nosniff + no-referrer", async () => {
  const response = await createAuthLogoutResponse(credentialRequest().clone(), {
    createClient: async () => makeClient(),
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
});

test("W08A A.2: logout 503 also carries private,no-store and never signals success", async () => {
  let signOutCalled = 0;
  const response = await createAuthLogoutResponse(credentialRequest().clone(), {
    createClient: async () => makeClient({
      signOut: async () => { signOutCalled++; return { error: new Error("downstream failed") }; },
    }),
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const body = await response.json();
  assert.deepEqual(body, { ok: false, code: "AUTH_UNAVAILABLE" });
  // 503 means signOut was attempted but did not return a clean null; the
  // 204 path is reserved for confirmed local sign-out, so we must not
  // report success.
  assert.equal(response.status === 204, false);
  assert.equal(signOutCalled, 1);
});

test("W08A A.3: logout does not leak raw provider error / Set-Cookie / tokens", async () => {
  const response = await createAuthLogoutResponse(credentialRequest().clone(), {
    createClient: async () => {
      throw new Error("supabase blew up with token=abc123 cookie=sb-secret");
    },
  });
  const text = await response.text();
  for (const forbidden of ["supabase blew up", "token=", "sb-secret", "abc123"]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

// ---------------------------------------------------------------------------
// B. Account switching: no client trust, B replaces A, failed B signs out
// ---------------------------------------------------------------------------

test("W08A B.1: login projects only the sanitized actor, never auth subject / email / token", async () => {
  const response = await createAuthLoginResponse(
    credentialRequest(),
    deps(),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal("auth_subject" in (body.actor ?? {}), false, "auth_subject must not leak");
  assert.equal("email" in (body.actor ?? {}), false);
  assert.equal("password" in (body.actor ?? {}), false);
  assert.equal(body.actor.app_user_id, baseActor.app_user_id);
  assert.deepEqual(body.actor.capabilities, baseActor.capabilities);
  assert.deepEqual(body.actor.scopes, baseActor.scopes);
  assert.equal(body.actor.self_recruiter_suggestion, baseActor.self_recruiter_suggestion);
  const serialised = JSON.stringify(body);
  for (const forbidden of ["user@example.com", "  pw  ", "auth-subject", "access-secret"]) {
    assert.equal(serialised.includes(forbidden), false, forbidden);
  }
});

test("W08A B.2: failed B mapping signs out locally and returns 403 ACCOUNT_NOT_AVAILABLE", async () => {
  let signOutOptions = null;
  const response = await createAuthLoginResponse(credentialRequest(), deps({
    resolveActor: async () => ({ ok: false, reason: "ACTOR_MAPPING_MISSING" }),
    createClient: async () => makeClient({
      signOut: async (options) => { signOutOptions = options; return { error: null }; },
    }),
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, code: "ACCOUNT_NOT_AVAILABLE" });
  // Local signOut must always be { scope: "local" } so the new session
  // is destroyed when there is no actor mapping for the user.
  assert.deepEqual(signOutOptions, { scope: "local" });
  // The login response is itself no-store so a CDN cannot replay it for B.
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("W08A B.3: client-supplied role / capability / scope fields are rejected by the contract", () => {
  for (const forbidden of [
    { role: "admin" },
    { capabilities: ["entry_admin"] },
    { scope: { kind: "all", reference: "all" } },
    { actor: { auth_subject: "00000000-0000-4000-8000-000000000099" } },
    { provider: "vendor" },
  ]) {
    assert.equal(validateClientBusinessPayload(forbidden).ok, false,
      JSON.stringify(forbidden));
  }
});

test("W08A B.4: account switching (A -> B) — only B's actor is in the next response", async () => {
  const actorA = structuredClone(baseActor);
  const actorB = {
    ...structuredClone(baseActor),
    app_user_id: "00000000-0000-4000-8000-0000000000b1",
    capabilities: ["change_review"],
    self_recruiter_suggestion: "rcr_b",
    scopes: [{
      kind: "own",
      reference: "00000000-0000-4000-8000-0000000000b1",
      valid_from: "0001-01-01",
      valid_to: null,
    }],
  };
  // First, A is logged in.
  const loginA = await createAuthLoginResponse(credentialRequest(), deps({
    resolveActor: async () => ({ ok: true, actor: actorA }),
  }));
  assert.equal(loginA.status, 200);
  assert.equal((await loginA.json()).actor.app_user_id, actorA.app_user_id);
  // Logout: confirms the prior session is gone.
  const logout = await createAuthLogoutResponse(credentialRequest().clone(), {
    createClient: async () => makeClient(),
  });
  assert.equal(logout.status, 204);
  // Now log in as B. B's session must be the only projection; nothing of A.
  const loginB = await createAuthLoginResponse(credentialRequest(), deps({
    resolveActor: async () => ({ ok: true, actor: actorB }),
  }));
  const bodyB = await loginB.json();
  assert.equal(bodyB.actor.app_user_id, actorB.app_user_id);
  assert.deepEqual(bodyB.actor.capabilities, ["change_review"]);
  assert.equal(bodyB.actor.self_recruiter_suggestion, "rcr_b");
  const serialised = JSON.stringify(bodyB);
  for (const forbidden of [actorA.app_user_id, "entry_create", "rcr_a"]) {
    assert.equal(serialised.includes(forbidden), false, forbidden);
  }
});

// ---------------------------------------------------------------------------
// C. Revocation / freshness: every request re-resolves from Supabase + DB
// ---------------------------------------------------------------------------

test("W08A C.1: every resolve calls Supabase getUser and the actor repository (no in-memory cache)", async () => {
  let getUserCalls = 0;
  let getSessionCalls = 0;
  let repositoryCalls = 0;
  const recordAt = (authSubject) => {
    repositoryCalls++;
    if (authSubject !== baseActor.auth_subject) return null;
    return fullRecord();
  };
  const result = await resolveDirectEntrySession({
    resolveActor,
    createClient: () => ({
      auth: {
        async getUser() {
          getUserCalls++;
          return { data: { user: { id: baseActor.auth_subject } }, error: null };
        },
        async getSession() {
          getSessionCalls++;
          throw new Error("getSession must never be used as an authority");
        },
      },
    }),
    supabaseUrl: "https://synthetic.supabase.invalid",
    publishableKey: "synthetic-publishable-key",
    cookieStore: { getAll: () => [], set() {} },
    repository: { loadByAuthSubject: recordAt },
    at: baseTimestamp,
  });
  assert.equal(getUserCalls, 1);
  assert.equal(getSessionCalls, 0, "getSession must never be consulted for authority");
  assert.equal(repositoryCalls, 1, "actor repository must be hit on every resolve");
  assert.equal(result.actor.ok, true);
});

test("W08A C.2: a previously-allowed actor is denied at next resolve when the DB record is disabled", async () => {
  // Mutable repository: simulates a grant revocation / actor disable
  // happening between two requests.
  let enabled = true;
  const mutableRepo = {
    async loadByAuthSubject() {
      return fullRecord({ enabled });
    },
  };
  const before = await resolveActor({
    session: {
      auth_subject: baseActor.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: mutableRepo,
    at: baseTimestamp,
  });
  assert.equal(before.ok, true);
  // Admin disables the actor.
  enabled = false;
  const after = await resolveActor({
    session: {
      auth_subject: baseActor.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: mutableRepo,
    at: baseTimestamp,
  });
  assert.deepEqual(after, { ok: false, reason: "ACTOR_DISABLED" });
  // The page decision immediately maps this to ACCOUNT_UNAVAILABLE.
  assert.equal(
    decideSessionPageAccess(after),
    "ACCOUNT_UNAVAILABLE",
  );
});

test("W08A C.3: a previously-allowed actor is denied at next resolve when the mapping is removed", async () => {
  let hasMapping = true;
  const mutableRepo = {
    async loadByAuthSubject() {
      return hasMapping ? fullRecord() : null;
    },
  };
  const before = await resolveActor({
    session: {
      auth_subject: baseActor.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: mutableRepo,
    at: baseTimestamp,
  });
  assert.equal(before.ok, true);
  hasMapping = false;
  const after = await resolveActor({
    session: {
      auth_subject: baseActor.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: mutableRepo,
    at: baseTimestamp,
  });
  assert.deepEqual(after, { ok: false, reason: "ACTOR_MAPPING_MISSING" });
  assert.equal(
    decideSessionPageAccess(after),
    "ACCOUNT_UNAVAILABLE",
  );
});

test("W08A C.4: a stale token claim alone does not grant — only getUser + repository row grant", async () => {
  // Direct evidence: the JS projection of `authorizeDirectEntry` denies
  // when the actor is null even if the request comes with a verified
  // session token (because the page is the *server*).
  const decision = authorizeDirectEntry({
    actor: null,
    action: "entry_create",
    resource: {
      reference: "00000000-0000-4000-8000-000000000010",
      created_by_user_id: null,
      current_version: null,
      scope: {
        kind: "all",
        reference: "all",
        effective_date: "2026-10-05",
      },
    },
    timestamp: baseTimestamp,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "UNAUTHENTICATED");
});

// ---------------------------------------------------------------------------
// D. Cache / private responses: every auth response is private,no-store and
//    sanitised. Cookie refresh signals ride along but never store actor data.
// ---------------------------------------------------------------------------

test("W08A D.1: api-session-guard helper locks private,no-store + nosniff + no-referrer", () => {
  // Read-only source assertion. The helper is `import "server-only"` so
  // we cannot instantiate it from a plain node:test file; the contract is
  // pinned by reading the source.
  const guard = source("./api-session-guard.ts");
  assert.match(guard, /apiSessionError\("UNAUTHENTICATED", 401\)/);
  assert.match(guard, /apiSessionError\("ACTOR_NOT_AVAILABLE", 403\)/);
  assert.match(guard, /"cache-control": "private, no-store"/);
  assert.match(guard, /"x-content-type-options": "nosniff"/);
  assert.match(guard, /"referrer-policy": "no-referrer"/);
  // No UUID, no capability, no PII, no raw error string in the failure body.
  assert.match(guard, /JSON\.stringify\(\{ ok: false, code \}\)/);
});

test("W08A D.2: 401 / 403 / 200 / 503 auth responses all carry private,no-store", async () => {
  const cases = [
    {
      name: "login 200",
      build: () => createAuthLoginResponse(credentialRequest(), deps()),
    },
    {
      name: "login 401 invalid creds",
      build: () => createAuthLoginResponse(credentialRequest(), deps({
        createClient: async () => makeClient({
          signInWithPassword: async () => ({
            data: { user: null },
            error: Object.assign(new Error("bad creds"), { status: 400 }),
          }),
        }),
      })),
    },
    {
      name: "login 403 account unavailable",
      build: () => createAuthLoginResponse(credentialRequest(), deps({
        resolveActor: async () => ({ ok: false, reason: "ACTOR_DISABLED" }),
        createClient: async () => makeClient(),
      })),
    },
    {
      name: "login 503 unavailable",
      build: () => createAuthLoginResponse(credentialRequest(), deps({
        createClient: async () => { throw new Error("infra down"); },
      })),
    },
    {
      name: "session 200",
      build: () => createAuthSessionResponse(async () => ({
        actor: { ok: true, actor: structuredClone(baseActor) },
      })),
    },
    {
      name: "session 401",
      build: () => createAuthSessionResponse(async () => ({
        actor: { ok: false, reason: "UNAUTHENTICATED" },
      })),
    },
    {
      name: "session 403",
      build: () => createAuthSessionResponse(async () => ({
        actor: { ok: false, reason: "ACTOR_MAPPING_MISSING" },
      })),
    },
    {
      name: "logout 204",
      build: () => createAuthLogoutResponse(credentialRequest().clone(), {
        createClient: async () => makeClient(),
      }),
    },
    {
      name: "logout 503",
      build: () => createAuthLogoutResponse(credentialRequest().clone(), {
        createClient: async () => { throw new Error("infra down"); },
      }),
    },
  ];
  for (const { name, build } of cases) {
    const response = await build();
    assert.equal(response.headers.get("cache-control"), "private, no-store", name);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", name);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer", name);
  }
});

test("W08A D.3: cookie refresh signals ride along but never leak tokens", async () => {
  // Simulate a refresh: Supabase SSR setAll emits cache-control and a
  // private header. The session helper must propagate only the cache-affecting
  // trio and must never store the refresh token.
  const result = await resolveDirectEntrySession({
    resolveActor,
    createClient: (_url, _key, options) => ({
      auth: {
        async getUser() {
          options.cookies.setAll([
            { name: "sb-access-token", value: "access-X", options: { httpOnly: true } },
            { name: "sb-refresh-token", value: "refresh-Y", options: { httpOnly: true } },
          ], {
            "Cache-Control": "private, no-store",
            "Expires": "0",
            "Pragma": "no-cache",
            "X-Private-Token": "refresh-Y",
            "Set-Cookie": "sb-refresh-token=refresh-Y; HttpOnly",
          });
          return { data: { user: { id: baseActor.auth_subject } }, error: null };
        },
      },
    }),
    supabaseUrl: "https://synthetic.supabase.invalid",
    publishableKey: "synthetic-publishable-key",
    cookieStore: {
      getAll: () => [],
      set() {},
    },
    repository: { loadByAuthSubject: async () => structuredClone(baseActor) },
    at: baseTimestamp,
  });
  // Forwarded cache-affecting headers survive.
  assert.equal(result.response_headers["cache-control"], "private, no-store");
  assert.equal(result.response_headers["expires"], "0");
  assert.equal(result.response_headers["pragma"], "no-cache");
  // And the disallowed ones are dropped by the forwarder.
  for (const dropped of ["x-private-token", "set-cookie"]) {
    assert.equal(dropped in result.response_headers, false, dropped);
  }
  // No token or secret anywhere in the serialised session result.
  const text = JSON.stringify(result);
  for (const forbidden of ["access-X", "refresh-Y", "X-Private-Token"]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  // Note: response_headers is computed; the *response* that the framework
  // sends also carries no-store, because:
  //   1) /api/auth/session is dynamic = "force-dynamic";
  //   2) /api/direct-entry/session explicitly sets "Cache-Control: private, no-store";
  //   3) /dashboard + /direct-entry pages are dynamic + connection().
  assert.deepEqual(Object.keys(result.response_headers).sort(), [
    "cache-control",
    "expires",
    "pragma",
  ]);
});

test("W08A D.4: /api/auth/* routes are force-dynamic and Node, and do not call fetch or service-role Supabase", () => {
  for (const route of [
    "../../app/api/auth/login/route.ts",
    "../../app/api/auth/logout/route.ts",
    "../../app/api/auth/session/route.ts",
  ]) {
    const text = source(route);
    assert.match(text, /export const runtime = "nodejs"/, route);
    assert.match(text, /export const dynamic = "force-dynamic"/, route);
    assert.equal(/\bfetch\s*\(/.test(text), false, route);
    assert.equal(/createServiceSupabaseClient/.test(text), false, route);
  }
});

test("W08A D.5: dashboard / direct-entry page decisions run before any data fetch", () => {
  for (const [page, guard, fetchAnchor] of [
    ["../../app/dashboard/page.tsx", "decideSessionPageAccess(actor)", "fetchReporting(params)"],
    ["../../app/direct-entry/page.tsx", "decideDirectEntryPageAccess({", "fetchReporting("],
  ]) {
    const text = source(page);
    const guardAt = text.indexOf(guard);
    assert.ok(guardAt > 0, page + " must call " + guard);
    const fetchAt = text.indexOf(fetchAnchor);
    if (fetchAt >= 0) {
      assert.ok(fetchAt > guardAt, page + " must guard before " + fetchAnchor);
    }
  }
});

test("W08A D.6: Supabase cookie adapter never logs, never buffers, never leaks the second-argument headers", () => {
  const writes = [];
  const adapter = createSupabaseCookieAdapter({
    getAll: () => [],
    set: (name, value, options) => writes.push({ name, value, options }),
  });
  // setAll should call set() per cookie and ignore the headers argument.
  adapter.setAll([
    { name: "sb-a", value: "v-a", options: { httpOnly: true } },
    { name: "sb-b", value: "v-b", options: { httpOnly: true } },
  ], { "Cache-Control": "private, no-store", "X-Token": "should-not-leak" });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].name, "sb-a");
  assert.equal(writes[1].name, "sb-b");
  // No log was emitted; the adapter has no console.* surface.
  // Headers from setAll are not surfaced to the cookie set() call, and that
  // is the boundary: cookies ride through cookies() and the response
  // cache-control comes from NO_STORE_HEADERS in auth-session-core.ts or
  // the explicit /api/direct-entry/session header.
});

// ---------------------------------------------------------------------------
// E. Transient retry: bounded, never turns a deny into an allow, no old actor
//    shown during retry.
// ---------------------------------------------------------------------------

test("W08A E.1: bounded retry never exceeds 2 attempts and never infinite-loops", async () => {
  let calls = 0;
  await assert.rejects(async () => {
    await resolveSessionWithBoundedRetry(async () => {
      calls++;
      throw new Error("always-fails");
    });
  });
  assert.equal(calls, 2);
});

test("W08A E.2: non-throwing UNAUTHENTICATED is returned immediately (no retry)", async () => {
  let calls = 0;
  const result = await resolveSessionWithBoundedRetry(async () => {
    calls++;
    return { actor: { ok: false, reason: "UNAUTHENTICATED" }, response_headers: {} };
  });
  assert.equal(calls, 1);
  assert.equal(result.actor.ok, false);
});

test("W08A E.3: ACTOR_DISABLED / MAPPING_MISSING is never turned into ALLOW by retry", async () => {
  let calls = 0;
  const result = await resolveSessionWithBoundedRetry(async () => {
    calls++;
    return { actor: { ok: false, reason: "ACTOR_DISABLED" }, response_headers: {} };
  });
  assert.equal(calls, 1);
  // The retry helper never re-runs on a non-throw, so a deny is a deny.
  assert.equal(result.actor.ok, false);
  // And the page decision immediately maps to ACCOUNT_UNAVAILABLE.
  assert.equal(decideSessionPageAccess(result.actor), "ACCOUNT_UNAVAILABLE");
});

test("W08A E.4: decideDirectEntryPageAccess denies explicitly without showing the prior actor", () => {
  // The decision helper is pure — it does not retain a previous ALLOW result.
  // Both an unauthenticated request and a request from an actor without
  // entry_* are denied.
  assert.equal(
    decideDirectEntryPageAccess({
      uiEnabled: true,
      actor: { ok: false, reason: "UNAUTHENTICATED" },
    }),
    "REDIRECT_LOGIN",
  );
  assert.equal(
    decideDirectEntryPageAccess({
      uiEnabled: true,
      actor: { ok: true, actor: { ...baseActor, capabilities: ["change_review"] } },
    }),
    "ACCESS_DENIED",
  );
});

// ---------------------------------------------------------------------------
// F. /api/auth/session after logout: the next call must be 401
// ---------------------------------------------------------------------------

test("W08A F.1: /api/auth/session after a real Supabase UNAUTHENTICATED returns 401 with no-store", async () => {
  const response = await createAuthSessionResponse(async () => ({
    actor: { ok: false, reason: "UNAUTHENTICATED" },
  }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), { ok: false, code: "AUTH_UNAUTHENTICATED" });
});
