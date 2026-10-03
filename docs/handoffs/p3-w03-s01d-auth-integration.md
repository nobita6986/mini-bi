# P3-W03-S01D — Auth integration release candidate

## Integration provenance

Integration branch `feature/p1.6-integration` was clean at
`726120a607949413db317dbe5834f7118e364e09`, equal to
`origin/feature/p1.6-integration`. `origin/main` was and remains
`2045472d15f98500670dd1a70e84f9b00ba86e70`.

The verified auth commits form the requested direct descendant chain:

1. `612f75d4874abc51e2f04766763dfc9c186f4fb5` — S01A auth session server; parent `726120a607949413db317dbe5834f7118e364e09`.
2. `7c665a615bf8f5418f194b1a16f2246eadb38e10` — S01B login/logout UI; parent `612f75d4874abc51e2f04766763dfc9c186f4fb5`.
3. `56ece710af2c95cee59b96a66f9eef4fdf0b11f3` — S01C source/browser acceptance; parent `7c665a615bf8f5418f194b1a16f2246eadb38e10`.

`726120a` is an ancestor of `56ece71`. The branch was integrated with
`git merge --ff-only`; no cherry-picks or merge commit were used.

## Integrated behavior and scope

- Supabase Auth server routes and the UI consume SSR cookie sessions. Identity
  is verified through `auth.getUser()`; actor resolution receives only the
  trusted Supabase `user.id`. Unavailable actor mappings sign out locally and
  fail closed. Success projection excludes email, tokens, and session objects.
- Basic Auth still gates `/login`, `/login/*`, `/api/auth`, and `/api/auth/*`.
  It remains a pilot outer gate, not Supabase identity or business actor.
- The auth routes do not depend on `DIRECT_ENTRY_API_ENABLED`. Direct Entry
  API/session and UI gates remain fail-closed when their respective flags are
  absent or not exactly enabled.
- AppShell session control renders sign-in/sign-out state, not capabilities or
  scopes. Navigation is not filtered by actor capability; capability-aware nav
  remains deferred.
- No signup, password-reset, admin-user route, or new capability vocabulary
  was added. AI/reporting code and `PILOT_ACTOR_REF` remain unchanged.
- DOCUMENT scope-lock migration #34, submitted-document direct R2 manager, and
  APP-NAV remain present and covered by regression suites.
- No dependency version or lockfile changed. The only reconciliation was
  reproducible test scripts and inclusion of auth UI unit tests in the existing
  `test:server` path, which is part of `pnpm test`.

## Browser, targeted, and aggregate results

- S01C source acceptance: **52/52**.
- S01C prior replay: **113/113** (login UI 8, server/auth + actor 55,
  AppShell/navigation/layout 50).
- CDP screenshot acceptance: **5/5** synthetic screenshots regenerated on the
  integration tree: desktop login, mobile login, invalid credentials,
  unavailable account, and AppShell logout.
- Auth server/session + Basic Auth/proxy + Direct Entry session/authority:
  **55/55**.
- AppShell/navigation/layout: **50/50**.
- R2 direct-upload regression: **32/32**; submitted-document manager/reviewer:
  **28/28**.
- DOCUMENT scope-lock and policy DB suites: **15/15**. S04C local acceptance
  applied all **34 migrations from scratch in PGlite** and passed **13/13**
  checks with synthetic in-memory fixtures.
- Full `pnpm test`: **897 passed / 0 failed** across 19 Node test-runner
  summaries. Auth UI unit tests are included in the `pnpm test` aggregate.

## Release gates

- `pnpm install --frozen-lockfile`: passed; lockfile unchanged.
- `pnpm run test:p3-w03-s01c-source`: 52/52 passed.
- `pnpm run test:p3-w03-s01c-prior`: 113/113 passed.
- `pnpm run test:p3-w03-s01c-browser`: five screenshots passed.
- Targeted auth, pilot/proxy, AppShell/navigation, Direct Entry session/authority,
  R2, and DOCUMENT scope-lock suites: passed as counted above.
- `pnpm test`: 897 passed, 0 failed.
- PGlite from-scratch migration acceptance: all 34 applied.
- DB-aware read-only dry-run: 34 migrations recognized, all checksums match,
  zero pending, zero mismatch.
- `next typegen`, `pnpm typecheck`, full lint, `pnpm build`, `pnpm docs:check`,
  `pnpm secrets:check`, and `git diff --check`: recorded after handoff creation
  before commit.

No Supabase Auth call, user creation, R2 request, DB mutation, environment/CORS
change, or deployment was performed. Production currently has no Supabase user
UAT evidence.

## Next steps and deferrals

1. T0-authorized merge into `main`.
2. Deploy Production with Direct Entry flags still disabled.
3. Owner login/session UAT using a deliberately provisioned account.
4. Only after that acceptance, configure R2 environment and enable the Direct
   Entry API flag, followed by the UI flag.

Capability-aware navigation, real Supabase account UAT, and Production
acceptance are not part of this integration release candidate. Do not treat
this handoff as P3/P1.6 completion or Production readiness.
