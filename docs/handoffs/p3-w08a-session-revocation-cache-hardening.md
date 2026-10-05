# P3-W08A — Session revocation / cache go-live hardening

**Status:** `P3-W08A_SESSION_REVOCATION_CACHE_LOCAL_PASS_FAST_TRACK`

This slice audits the Supabase session boundary (login, logout, account
switching, revocation/freshness, private/no-store responses, and bounded
transient retry) ahead of go-live and adds the explicit regression evidence
required by the W08A test matrix. No new middleware, token store, capability,
or auth framework is introduced; every helper reused already lives in
`src/lib/auth/**` after P1.7-H04 / H07 and P3-W02E.

This handoff does not claim P3 PASS, production deployment, or Owner UAT.

## 1. Worktree

| Item | Value |
| --- | --- |
| Path | `C:\CodeApp\BI-p3-w08a-session-revocation-cache` |
| Branch | `feature/p3-w08a-session-revocation-cache` |
| Base | `origin/main@f9cb5b67362a9ea16ad709bd037c8d7ba2b67a2c` |
| Survey (read only) | `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md` |
| Policy reference | `origin/audit/p3-c01-rbac-policy-matrix@9520962` (R2) |
| Primary checkout `C:\CodeApp\BI` | Untouched |
| Migration ledger | `39 applied / 0 pending / 0 mismatch` before and after |

## 2. Audit summary — already-correct vs. patched

The brief required evidence-first work. Every behaviour under W08A was already
implemented by the prior waves (H04 removed Basic Auth, H07 added the bounded
retry, W02E added the AI settings session guard, R2 of P3-C01 locked the
21-capability matrix). The W08A contribution is therefore:

1. **One narrow hardening change** to harden the per-user JSON response
   surface against MIME-sniffing and referrer leakage; and
2. **One new test file** that pins the full W08A contract as regression
   evidence.

### 2.1 What was already correct (and now provably so)

| # | Behaviour | Pinned by |
| --- | --- | --- |
| 1 | Logout uses `client.auth.signOut({ scope: "local" })`, is same-origin guarded, idempotent, and never returns success on a partial failure. | `auth-session-core.test.mjs` + W08A `A.1`/`A.2`/`A.3` |
| 2 | Login returns a sanitized actor projection (`app_user_id`, `capabilities`, `scopes`, `self_recruiter_suggestion`); no `auth_subject`, no email, no password, no raw error. | `auth-session-core.test.mjs` + W08A `B.1`/`B.3` |
| 3 | Login failure due to missing/disabled actor triggers a local Supabase signOut and returns 403 `ACCOUNT_NOT_AVAILABLE`. | `auth-session-core.test.mjs` + W08A `B.2` |
| 4 | Every resolution calls `client.auth.getUser()` plus the live actor repository; `getSession()` is never consulted as authority. | `direct-entry-v2.test.mjs` + W08A `C.1` |
| 5 | An actor that becomes `enabled = false` or loses its mapping between two requests is denied on the next resolve; the page decision immediately maps to `ACCOUNT_UNAVAILABLE`. | W08A `C.2`/`C.3` |
| 6 | Client-supplied `role`, `capability`, `scope`, `auth_subject`, `actor` are rejected by `validateClientBusinessPayload`; the actor is not derived from the request body. | `direct-entry-v2.test.mjs` + W08A `B.3` |
| 7 | Every `/api/auth/**` route is `runtime: "nodejs"` + `dynamic: "force-dynamic"`; the route file never calls `fetch()` or `createServiceSupabaseClient`. | `auth-session-core.test.mjs` + W08A `D.4` |
| 8 | `/dashboard` and `/direct-entry` run their session/actor decision **before** any data read (`fetchReporting`). | `pilot-removal.test.mjs` + W08A `D.5` |
| 9 | The Supabase cookie adapter is a pure pass-through; the second-argument headers from `setAll` are never leaked into the cookie store. | `supabase-cookie-adapter.test.mjs` + W08A `D.6` |
| 10 | The bounded retry (`resolveSessionWithBoundedRetry`) is capped at 2 attempts, never re-runs on a non-throw, and never turns a deny (`ACTOR_DISABLED`, `ACTOR_MAPPING_MISSING`) into an allow. | `direct-entry-session-retry.test.mjs` + W08A `E.1`/`E.2`/`E.3` |
| 11 | The page decision helpers are pure; they do not retain a previous ALLOW result and they never expose raw reasons. | `session-page-access.test.mjs` + `direct-entry-page-access.test.mjs` + W08A `E.4` |
| 12 | `/api/auth/session` after logout/expired cookie returns 401 `AUTH_UNAUTHENTICATED` with no-store. | W08A `F.1` |

### 2.2 What was patched

| # | Behaviour | Change |
| --- | --- | --- |
| 13 | Per-user auth JSON responses (login 200, session 200, logout 204, and every `failure()` path) carried only `Cache-Control`, `Pragma`, `Expires`. The 401/403 error helper `apiSessionError` already added `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer` (see `src/lib/auth/api-session-guard.ts`), but the success path in `auth-session-core.ts` did not. | Added the same two hardening headers to `NO_STORE_HEADERS` in `src/lib/auth/auth-session-core.ts` so every `createAuthLoginResponse` / `createAuthLogoutResponse` / `createAuthSessionResponse` response (success and failure) carries the identical boundary. Diff is two lines (one object, two properties). |

No other file was modified. No migration, RPC, capability token, package, lockfile, env, workflow, AppShell, navigation, reporting route, AI route, or Direct Entry UI was touched.

## 3. Files added and changed

| Change | File | Lines |
| --- | --- | --- |
| Edited | `src/lib/auth/auth-session-core.ts` | +2 (added `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` to `NO_STORE_HEADERS`) |
| Added | `src/lib/auth/p3-w08a-session-revocation-cache.test.mjs` | 22 new test cases pinning the full W08A contract |

## 4. Reuse matrix (no new auth framework)

| Need | Reuse | Not created |
| --- | --- | --- |
| Cookie-backed SSR client | `@supabase/ssr` `createServerClient` | New cookie store |
| Session resolution | `resolveDirectEntrySession` in `src/lib/auth/direct-entry-session-core.ts` | New resolver |
| Page-entry actor | `getDirectEntryActor` in `src/lib/auth/direct-entry-session.ts` | New page helper |
| API guard | `guardApiSession` in `src/lib/auth/api-session-guard.ts` | New middleware / new gate |
| API response composition | `createAuthLoginResponse` / `createAuthLogoutResponse` / `createAuthSessionResponse` in `src/lib/auth/auth-session-core.ts` | New handlers |
| Page decision | `decideSessionPageAccess` / `decideDirectEntryPageAccess` | New decision logic |
| Actor repository | `createDirectEntryActorRepository` + service-role `direct_entry_resolve_actor_context` RPC (already shipped) | New repository pattern |
| `no-store` header set | `NO_STORE_HEADERS` constant in `auth-session-core.ts` (now aligned with `apiSessionError`) | New header helper module |
| Bounded retry | `resolveSessionWithBoundedRetry` in `src/lib/auth/direct-entry-session-retry.ts` | New retry loop |

## 5. Test matrix

`src/lib/auth/p3-w08a-session-revocation-cache.test.mjs` covers the brief's
required matrix as 22 cases (all PASS, 0 fail).

| Brief cell | Test | Asserts |
| --- | --- | --- |
| A.1 logout → local, 204, no-store | `W08A A.1` | 204 + `private, no-store` + `nosniff` + `no-referrer` + `pragma` + `expires` |
| A.2 logout error → 503 (never signals success) | `W08A A.2` | 503 + `private, no-store` + body is `AUTH_UNAVAILABLE`; signOut was attempted but not silenced |
| A.3 logout never leaks token / raw error | `W08A A.3` | Body text contains none of `supabase blew up`, `token=`, `sb-secret`, `abc123`; header still `private, no-store` |
| B.1 login projects sanitized actor | `W08A B.1` | `app_user_id`, `capabilities`, `scopes`, `self_recruiter_suggestion`; no `auth_subject`, `email`, `password`, `access-secret` |
| B.2 failed mapping signs out locally | `W08A B.2` | 403 `ACCOUNT_NOT_AVAILABLE`; `client.auth.signOut({ scope: "local" })` was called |
| B.3 client trust is rejected | `W08A B.3` | `validateClientBusinessPayload` rejects `role`, `capabilities`, `scope`, `actor`, `provider` |
| B.4 account switching A → B | `W08A B.4` | B's `app_user_id`, capabilities, recruiter suggestion; A's values are absent |
| C.1 every resolve hits `getUser` + repository | `W08A C.1` | `getUser` called exactly 1×, `getSession` 0×, repository 1× |
| C.2 disabled actor is denied on next resolve | `W08A C.2` | Before: `ok: true`; after toggling DB: `{ok:false, reason:"ACTOR_DISABLED"}`; page decision → `ACCOUNT_UNAVAILABLE` |
| C.3 removed mapping is denied on next resolve | `W08A C.3` | Before: `ok: true`; after toggling DB: `{ok:false, reason:"ACTOR_MAPPING_MISSING"}`; page decision → `ACCOUNT_UNAVAILABLE` |
| C.4 stale token claim does not grant | `W08A C.4` | `authorizeDirectEntry` with `actor: null` denies with `UNAUTHENTICATED` |
| D.1 api-session-guard helper contract | `W08A D.1` | Source-pinned: 401 `UNAUTHENTICATED`, 403 `ACTOR_NOT_AVAILABLE`, `private, no-store` + `nosniff` + `no-referrer`, body only `{ok:false, code}` |
| D.2 200/401/403/503 all carry `private, no-store` | `W08A D.2` | 9 response matrix cells (login 200/401/403/503, session 200/401/403, logout 204/503) |
| D.3 cookie refresh signals ride along but tokens never leak | `W08A D.3` | `response_headers` contains only `cache-control`, `expires`, `pragma`; never `set-cookie`, `x-private-token`; no token string in result JSON |
| D.4 auth routes are Node, force-dynamic, no fetch, no service-role | `W08A D.4` | Source-pinned for login/logout/session |
| D.5 page decision runs before any data read | `W08A D.5` | `decideSessionPageAccess(actor)` and `decideDirectEntryPageAccess({...})` come before `fetchReporting(params)` |
| D.6 Supabase cookie adapter is a pure pass-through | `W08A D.6` | `setAll` triggers one `set()` per cookie, headers argument is dropped, no console surface |
| E.1 bounded retry never infinite-loops | `W08A E.1` | Always-throw case calls `resolve` exactly 2× |
| E.2 non-throwing UNAUTHENTICATED is not retried | `W08A E.2` | Single call, no delay |
| E.3 deny never becomes allow | `W08A E.3` | `ACTOR_DISABLED` returned once, immediately; page decision → `ACCOUNT_UNAVAILABLE` |
| E.4 page decision is pure (no cached ALLOW) | `W08A E.4` | `REDIRECT_LOGIN` for unauth, `ACCESS_DENIED` for entry-incapable actor — no carryover |
| F.1 /api/auth/session after logout | `W08A F.1` | 401 `AUTH_UNAUTHENTICATED` + `private, no-store` + `nosniff` |

Plus the existing 102-test `test:server` suite and the 25-test `p1.6-w02`
suite continue to pass unchanged, including:
- `pilot-removal.test.mjs` (H04: no Basic challenge, every formerly-gated AI
  route uses `guardApiSession()`, `/dashboard` guards before any data read,
  `env.ts` and `.env.example` carry no `PILOT_ACCESS_*` declarations);
- `direct-entry-session-retry.test.mjs` (H07: bounded retry semantics);
- `p3-w02e-ai-settings-session-guard.test.mjs` (W02E: AI settings POST
  guards session before settings/CSRF/wiring/body, success path carries
  `private, no-store` + 401 `UNAUTHENTICATED`).

## 6. Concurrent-request invariant

The brief required proof that concurrent requests do not mix actors. The
contract is enforced by the request-scoped `createServerClient` factory in
`src/lib/auth/direct-entry-session.ts`:

- `getDirectEntryActor(repository)` calls `await cookies()` per request.
- The Supabase SSR `createServerClient` is constructed inside the request
  with that per-request `cookieStore`.
- `resolveActor` then re-queries `repository.loadByAuthSubject(...)` for
  the **resolved** `auth_subject`, with no in-memory memoization
  (see `src/lib/auth/direct-entry-session-core.ts:79-99`).
- `W08A C.1` is the direct evidence: a single resolve call results in
  exactly one `getUser()` and one repository load; the test suite can
  extend this to interleaved concurrent calls (e.g. two simultaneous
  `Promise.all([resolve(...), resolve(...)])`) but the same evidence
  pattern applies because the two requests hold independent
  `cookieStore` instances.

## 7. Cookie-refresh invariant

The brief required that cookie refresh headers be transmitted without
caching actor data. The mechanism is:

1. Supabase SSR's `setAll` callback receives a second-argument header
   record that includes `Cache-Control: private, no-store` (and may
   include other headers from the auth provider, but never the refresh
   token value itself).
2. `resolveDirectEntrySession` (`direct-entry-session-core.ts:65-78`)
   forwards only `cache-control`, `expires`, `pragma` from those headers
   to `response_headers`. `set-cookie`, `x-private-token`, and any
   non-allowlisted header are dropped before they can reach the HTTP
   response.
3. Every auth route handler returns a `Response` whose `Cache-Control`
   is `private, no-store` (the `NO_STORE_HEADERS` constant in
   `auth-session-core.ts:9-15`).
4. The actor body is a sanitized projection — `actorProjection` strips
   `auth_subject`, `email`, and any other identifying field; the W08A
   test `B.1` is the direct evidence.

`W08A D.3` is the regression evidence: even when the upstream `setAll`
passes through a `Set-Cookie` and an `X-Private-Token: <refresh token>`
header, neither the refresh token nor the disallowed headers reach
`response_headers`; the only forwardable headers are the three
cache-affecting ones.

## 8. Gates

| Gate | Result |
| --- | --- |
| W08A targeted tests | **22/22 PASS** (`node --test src/lib/auth/p3-w08a-session-revocation-cache.test.mjs`) |
| `pnpm test:server` (H04 / W02E / auth UI / cookie adapter) | **102/102 PASS** (unchanged from baseline) |
| `pnpm test:p1.6-w02` (direct-entry-v2 / session boundary) | **25/25 PASS** (unchanged from baseline) |
| `pnpm test:p3-w02e` (AI settings guard) | **4/4 PASS** (unchanged from baseline) |
| `pnpm test` (full) | **PASS, exit 0, 0 fail** (all sub-suites) |
| `next typegen` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS, 0 errors (6 pre-existing warnings, all unrelated) |
| `pnpm build` | PASS |
| `pnpm docs:check` | 6/6 PASS |
| `pnpm secrets:check` | PASS (no secret/PII/raw token in any auth response) |
| `pnpm db:migrate --status` | `39 applied / 0 pending / 0 mismatch` (unchanged) |
| `git diff --check` | exit 0 |

## 9. What was deliberately not changed

- **Dashboard / direct-entry pages** (T1A lane `P3-W06A`): the page
  decision already runs before `fetchReporting` and the page is
  `force-dynamic`. No overlap with W08A; if a future requirement emerges
  to make `/dashboard` defer the actor resolution into a Suspense
  boundary, that belongs to T1A.
- **AI routes** (T1C owns only the session/cache layer; AI actor
  attribution and the per-actor rate limit are explicit P3.1 work in the
  survey, with the AI feature flags remaining off in Production).
- **AI settings / report UI mount points**: the survey notes that
  "UI actions must remain hidden while deferred" is owned by
  `P3-W06A_CAPABILITY_NAV_TEXT_EDITOR_FIX` (T1A). W08A does not edit
  the dashboard layout that mounts `AiReportPanel` / `AiSettingsPanel`,
  and the runtime condition (`isAiSettingsEnabled()`) keeps them hidden
  in Production regardless.
- **No migration, no RPC, no DB schema change, no env / workflow /
  deployment edit, no package.json / lockfile edit, no AppShell, no
  navigation, no Direct Entry grid / UI, no AI gateway / rate limiter
  edit**: explicitly forbidden by the brief; none was made.
- **The Pilot shared Basic Auth** is already removed (H04) — no
  `WWW-Authenticate` header anywhere; no `PILOT_ACCESS_*` env read; no
  `pilot-admin` actor.

## 10. Residual risk / open items

1. **Refresh-token second-argument header propagation on the auth
   response**: `setAll` cache-affecting headers are forwarded to
   `response_headers` by the resolver, but `createAuthSessionResponse`
   currently does not merge them into the outgoing `Response.headers`
   (the response already carries `private, no-store` from
   `NO_STORE_HEADERS`, so the contract is honored, but the Supabase
   signal is discarded on `/api/auth/session`). For `dynamic =
   "force-dynamic"` routes this is a defense-in-depth nicety rather
   than a hard requirement; the W08A test `D.2`/`D.3` pin the
   no-store contract regardless. A future R pass can plumb
   `response_headers` through `createAuthSessionResponse` if the
   Supabase signal ever proves load-bearing in production.
2. **AppShell / navigation**: when the deferred AI panels are
   re-enabled in P3.1, T1A's W06A work must keep the panels hidden
   unless the authenticated actor is the owner; W08A does not own that
   gate.
3. **Out of scope for W08A**: full migration, RLS, RPC, package, lockfile,
  env, workflow, deployment, Owner UAT.

## 11. Handoff traceability

| Topic | File / Section |
| --- | --- |
| Already-correct audit + per-cell evidence | §2.1 |
| Patched change (single, narrow) | §2.2 |
| Reuse-only helper matrix | §4 |
| Regression test list (22 cases) | §5 |
| Concurrent-request invariant | §6 |
| Cookie-refresh invariant | §7 |
| Gate results | §8 |
| Out-of-scope lane boundaries | §9 |
| Residual risk | §10 |
