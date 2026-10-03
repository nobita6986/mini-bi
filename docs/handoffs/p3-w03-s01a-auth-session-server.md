# P3-W03-S01A — Auth session server boundary

## Scope and base

Implemented on `feature/p3-auth-session-s01a`, based on
`726120a607949413db317dbe5834f7118e364e09` (`feature/p1.6-integration`).
This change adds only server-side Supabase login, logout, and session
bootstrapping. It does not add login UI, user administration, global capability
guards, nav filtering, or Basic Auth retirement.

## Route contracts

| Route | Contract |
| --- | --- |
| `POST /api/auth/login` | Same-origin JSON `{ email, password }` only; 4096-byte request ceiling, 1024-byte password ceiling, trimmed/validated email, exact fields only. Invalid input returns sanitized `400 AUTH_REQUEST_INVALID`; invalid credentials return `401 AUTH_INVALID_CREDENTIALS`; unavailable provider returns `503 AUTH_UNAVAILABLE`; actor mapping not available returns `403 ACCOUNT_NOT_AVAILABLE`. |
| `POST /api/auth/logout` | Same-origin, body not required; uses `signOut({ scope: "local" })`; returns empty `204`, including when there is no current browser session. Provider failure returns sanitized `503 AUTH_UNAVAILABLE`. |
| `GET /api/auth/session` | Uses existing `getDirectEntryActor()` and its `auth.getUser()` verification. Does not depend on the Direct Entry API feature flag. Unauthenticated returns `401 AUTH_UNAUTHENTICATED`; unavailable actor returns `403 ACCOUNT_NOT_AVAILABLE`. |

All responses are `private, no-store`. Success returns only `app_user_id`,
capabilities, scopes, and the self-recruiter suggestion. No email, auth metadata,
provider claim, token, session object, raw provider/DB error, or client-supplied
actor authority is returned.

Malformed/non-exact login bodies and cross-origin requests are rejected before
the Supabase Auth client is constructed. Passwords are not trimmed or logged.
The request origin is checked against the request URL origin as well as the
existing same-origin guard.

## Cookie and actor lifecycle

- `@supabase/ssr` owns session-cookie parsing, refresh, setting, and local
  removal through the modern `getAll`/`setAll` cookie adapter and Next.js
  `cookies()` API.
- Sign-in, sign-out, and identity verification use the publishable key, never
  the service-role client.
- On successful sign-in, only the returned Supabase `user.id` is passed to
  `resolveActor()` and the existing narrow
  `direct_entry_resolve_actor_context` repository. The repository initializes
  its service-role RPC client lazily after that trusted subject is used.
- Missing, disabled, ambiguous, or malformed actor mappings fail closed; a
  successful auth session is locally signed out before returning the generic
  account-unavailable response.
- Basic Auth remains the outer pilot gate for `/login`, its subpaths,
  `/api/auth`, and all auth API subpaths. It remains separate from Supabase
  identity and business-actor authority.

## Error and privacy matrix

| Condition | Status/code |
| --- | --- |
| Invalid body, extra/client-authority fields, or invalid email | `400 AUTH_REQUEST_INVALID` |
| Origin absent, mismatched, or cross-site | `403 CSRF_REJECTED` |
| Credential/provider authentication rejection | `401 AUTH_INVALID_CREDENTIALS` |
| Missing/disabled/malformed actor mapping | `403 ACCOUNT_NOT_AVAILABLE` |
| Unauthenticated session lookup | `401 AUTH_UNAUTHENTICATED` |
| Unexpected Auth/provider failure | `503 AUTH_UNAVAILABLE` |

The response errors are fixed codes. Raw Supabase errors and credentials are
not logged or serialized.

## Verification

- Auth/session, Basic Auth/proxy, existing Direct Entry session, actor bootstrap,
  and W02 authority targeted suite: **55/55 passed**.
- Standalone W02 authority suite: **25/25 passed**.
- `next typegen`: passed.
- `pnpm typecheck`: passed.
- Targeted ESLint: passed.
- Full `pnpm lint`: passed with zero errors and one pre-existing unused-variable
  warning in `scripts/p1.6-w03-g3-dev-acceptance.mjs`; no warning suppression.
- `pnpm build`: passed; all three auth routes built as dynamic handlers.
- `pnpm docs:check`: **6/6** examples passed.
- `pnpm secrets:check`: **630 files scanned, no secret found**.
- `git diff --check`: passed.
- Full `pnpm test`: deferred to integration; the auth, W02, session-bootstrap,
  and Basic Auth/proxy suites directly affected here were run.
- Migration preflight before changes: **34 applied / 0 pending / 0 checksum
  mismatches**. A final read-only dry-run was attempted, but the environment
  could not resolve the configured Supabase database hostname (`ENOTFOUND`), so
  no final network-backed result was obtained. This task adds no migration and
  made no database connection or mutation.

No real Supabase Auth call, user creation, DB/R2 mutation, environment change,
or deployment was performed.

## Deferred and rollback

Login/logout React UI and Production acceptance remain deferred. Production
acceptance must separately verify cookie behavior, access policy, and all
deployment environment settings before Direct Entry activation.

Rollback is a code deployment rollback to the previous application version.
No migration or user/session database cleanup is required.
