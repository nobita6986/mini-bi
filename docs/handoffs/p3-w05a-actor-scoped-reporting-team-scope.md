# P3-W05A — Actor-scoped reporting + team scope (Handoff)

**Status:** `P3-W05A-I01-R2_REBASELINE_054D543_LOCAL_PASS_AWAITING_T0_REVIEW`
**Base:** `origin/main@054d54360c6b94f4a8173bb8d0248019fe8d3fc9` (rebaselined by
P3-W05A-I01-R2; the original #45 review base was
`origin/main@6a81f5637d61bdd66d09c835ba613482609b8ea8`, then `ebb8217` for I01-R1)
**Branch:** `feature/p3-w05a-i01-r2-rebaseline-054d543`

## What changed

- Migration #48 `20261008080000_p3_w05a_actor_scoped_reporting.sql` (rebased onto
  `origin/main@054d543` by P3-W05A-I01-R2; P2-W04C owns #47 at
  `20261008070000_p2_w04c_cutoff_rebaseline_2026_09_30.sql`, migrations #1-#47
  stay byte-identical and the W05A body is unchanged from the #45 review):
  - `direct_entry_reporting_resolve_audience(uuid,uuid)` — DB-side actor verify + audience `all > team > own` (sanitized jsonb).
  - `direct_entry_reporting_authorized_entries(uuid,uuid)` — shared authorized-row predicate.
  - `direct_entry_reporting_scoped_facts(uuid,uuid,jsonb)` / `direct_entry_reporting_scoped_options(uuid,uuid)` — filter at the SQL boundary.
  - `direct_entry_seed_team_scope_grants()` — idempotent, fail-closed seed for the 7 TEAM_LEADER recruiters.
  - All helpers are SECURITY DEFINER, service_role-only; public/anon/authenticated revoked.
- Server: `fetchCutoverReporting(params, actor)` and `fetchCutoverReportingOptions(actor)` now require an actor and call the scoped RPCs (no unscoped fallback).
- Audience projection `src/lib/reporting/p3-w05a-audience.ts` exports `{ kind, label }` for W06C (no UUID/grants/PII).
- Dashboard page passes the resolved actor only after `decideSessionPageAccess` returns ALLOW.

## Scope rules (locked)

- all: legacy (< cutoff) + Direct Entry (>= cutoff); team: `direct_entries.team_id` in effective team scope; own: `recruiter_id` = verified link.
- Legacy aggregate is excluded fail-closed for team/own; out-of-scope filters return empty without error.

## Gates (P3-W05A-I01-R2 rebaseline)

- `pnpm test:p3-w05a` — 53/53 (audience projection, page, source filter, actor-scoped DB,
  team-scope seed, multi-team regression).
- `pnpm test` (canonical) — 1403/1403, 0 fail.
- `pnpm exec next typegen` ok; `pnpm typecheck` ok; `pnpm lint` 0 errors (10 pre-existing
  warnings, none introduced here); `pnpm build` ok; `pnpm docs:check` 6/6;
  `pnpm secrets:check` ĐẠT (892 files); `git diff --check` clean.
- `pnpm db:migrate --offline` — 48 valid; `--dry-run` — 47 applied (checksum matches), exactly
  1 pending (`20261008080000_p3_w05a_actor_scoped_reporting.sql`), 0 mismatch. Read-only; no
  Production apply, no deploy.

## Rebaseline notes (I01-R2)

- P2-W04C already owns migration #47 (`20261008070000_p2_w04c_cutoff_rebaseline_2026_09_30.sql`),
  so the append-only W05A migration was renamed to `20261008080000` (#48). Its body is unchanged
  from the #45 review — only the filename and the migration-number comments differ. Migrations
  #1-#47 stay byte-identical to `origin/main@054d543`.
- W04C's migration and the frozen `EXPECTED_MIGRATION_COUNT = 47` in
  `scripts/p2-w04a-reconcile.mjs` are deliberately untouched: that verifier tracks the applied
  Production release, which does not include W05A. Only the on-disk inventory assertions (13
  places) move to 48.
- W05A fixtures now follow W04C's cutoff rebaseline to 2026-09-30: the legacy aggregate seed is
  2026-09-25 (2026-10-01 would now fall on the Direct Entry side) and E15 asserts the new cutoff
  with a 2026-09-29 pre-cutoff Direct Entry row. W05A logic, ACLs and the multi-team regression
  are unchanged.
- No source branch was rewritten: the 7 W05A commits were replayed as new commits on top of
  `054d543`. No force-push, no amend, no history edit; the source branches keep their commits.

## Deferred / out of scope

- W06C BoD/Team/Own UX (T1A). No UI built here. Production untouched (no apply, no deploy, no push to main).

