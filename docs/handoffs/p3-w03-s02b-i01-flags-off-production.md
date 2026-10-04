# P3-W03-S02B-I01 — Integrated flags-off release handoff

## Status and boundaries

`P3-W03-S02B_INTEGRATION_GATES_PASS_FLAGS_OFF_RELEASE_PENDING`

Integration branch: `feature/p1.6-integration`, based on the verified
Production/main source `1577c035758306c54a4cd6be4808bea8452fc7c3`. The Owner
bootstrap, S02B access UX, and J01 activation evidence are integrated with
provenance. This task keeps both Direct Entry flags absent or not `"true"`.
No activation, DB mutation, R2 object operation, Production credential use, or
deployment has occurred before the release phase described below.

This handoff does not declare P3/P1.6 PASS or Production ready. Real
authenticated Direct Entry route UAT remains pending; S02B browser visual
acceptance is **ACCEPTED DEFERRED**.

## Source provenance and reconciliation

The lanes were cherry-picked in the requested order with `git cherry-pick -x`;
no cherry-pick conflicts occurred.

| Lane | Source commits | Integration commits |
| --- | --- | --- |
| First Owner bootstrap | `3e248b2`, `d582bff`, `dcb4ce3` | `cc80b9b`, `cb5de36`, `0a4de85` |
| S02B access UX | `8b1816c`, `a27a0d2`, `24fc221`, `e03cdfd` | `fd6ba27`, `5bed842`, `0fb8b2c`, `b2059a6` |
| T1C activation/J01 docs | `2285921`, `f3372ec` | `3703e65`, `c51809c` |

Reconciliation details:

- S02B final source is `e03cdfd86d690d4691e600e79a7762774c25c46b`.
- Pure route-decision matrix passes. With the UI flag off, the final route
  decision is `NOT_FOUND`; with it on, the page follows the final exhaustive
  decision helper, not interim R1 behavior.
- Browser visual is **ACCEPTED DEFERRED**, not PASS. Real Production route
  happy/negative UAT is **PENDING**.
- The S01C source-acceptance check now counts the session bootstrap request
  separately from the account-unavailable logout request. This preserves its
  one-session-fetch assertion while reflecting the integrated logout behavior.
- J01 matrix and audit now identify the final S02B source, flags-off evidence,
  current 34/0/0 migration state, pending authenticated route UAT, and the
  accepted browser-visual deferral.
- Ordinary rollback disables/unsets only the two Direct Entry flags and
  redeploys the approved `main` source. Preserve all R2 environment
  configuration; do not delete DB or R2 data as part of rollback.

## First Owner bootstrap and UAT evidence

- The isolated S02A operator previously applied the first-owner bootstrap in a
  single transaction. Sanitized verification reported one enabled app-user
  mapping, all 21 canonical capabilities, and the effective `own` and `all`
  scopes; actor projection matched those counts. No team scope was fabricated.
- Two subsequent read-only replays reported the same mapping/capability/scope
  counts with no duplicate grant/scope rows and no second audit event. No
  unsupported bootstrap audit action was fabricated.
- Owner-attested Production login UAT passed on **2026-10-04** (date only):
  sign-in redirected to Dashboard, refresh preserved the session, opening
  Login while signed in redirected to Dashboard, logout returned to Login,
  refresh after logout did not silently sign in, and signing in again worked.
  This is Owner attestation, not an agent-operated credential test.
- No account identifier, Auth UUID, app-user ID, password, cookie, authorization
  header, or raw capability payload is included here. The S02B-I01 integration
  did not rerun the bootstrap or mutate the database.

## Preflight evidence (read-only)

- `origin/main` was verified at `1577c035758306c54a4cd6be4808bea8452fc7c3`
  before integration.
- Production alias was `https://bi.hrpartner.vn`; its observed deployment was
  Ready, sourced from `main` at that exact SHA.
- Presence-only Production checks passed for Pilot Basic Auth, Supabase keys,
  and all four R2 keys. Both Direct Entry flags were absent or not `"true"`.
  No values were read into this handoff.
- The Production DB-aware migration dry-run reported **34 applied / 0 pending /
  0 checksum mismatch**. No migration was applied.
- Unauthenticated smoke before integration observed `GET /` → 200 and Basic
  Auth `401` for `/login`, `/api/auth/session`, `/dashboard`, `/direct-entry`,
  and `/api/direct-entry/session`.
- The First Owner bootstrap was not rerun or mutated in this integration task.
- No R2 object was read, written, or deleted. No Supabase Auth user or
  Production environment setting was changed.

## Integration gates

- `pnpm install --frozen-lockfile`: passed.
- First Owner bootstrap tests, including PGlite migration-from-scratch coverage:
  **7/7 passed**.
- P3 S01A auth/session tests: **55/55 passed**.
- P3 S01C source acceptance: **52/52 passed**.
- P3 S01C prior checks (S01B, S01A replay, AppShell/navigation): **113/113
  passed**.
- S02B route/access-denied/login/AppShell/navigation targeted tests: **61/61
  passed**.
- R2/document offline, payment, submission, and change-request regression
  suites: passed.
- Full `pnpm test`: **897/897 passed** across 19 test commands.
- `pnpm exec next typegen`: passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with 0 errors and 3 warnings in existing unrelated
  locations.
- `pnpm build`: passed on Next.js 16.3.8.
- `pnpm docs:check`: **6/6 examples passed**.
- `pnpm secrets:check`: passed; 1,011 files scanned.
- Final read-only DB-aware migration dry-run: **34 applied / 0 pending /
  0 checksum mismatch**.
- `git diff --check`: passed.

## Release phase — flags remain off

After this integration commit is pushed, the authorized release sequence is:

1. Re-fetch and verify `origin/main` is still
   `1577c035758306c54a4cd6be4808bea8452fc7c3`.
2. Fast-forward push the verified integration HEAD to `origin/main`; do not
   force-push or add a direct docs commit on `main`.
3. Wait for Git-integrated Production deployment and verify target Production,
   Ready state, branch `main`, exact integration commit, and alias
   `https://bi.hrpartner.vn`.
4. Verify both Direct Entry flags remain absent or not `"true"`.
5. Without Basic Auth credentials, verify `GET /` → 200 and each protected
   path below → 401 Basic Auth challenge:
   `/login`, `/api/auth/session`, `/dashboard`, `/direct-entry`,
   `/api/direct-entry/session`.
6. Stop on any mismatch. Do not activate Direct Entry in this task.

If deployment or smoke fails, leave both flags off and follow the deployment
rollback procedure without changing R2 configuration or deleting DB rows,
revisions, audit, or R2 objects.
