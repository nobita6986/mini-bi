# P3-W05A — Actor-scoped reporting + team scope (Handoff)

**Status:** `P3-W05A_ACTOR_SCOPED_REPORTING_TEAM_SCOPE_LOCAL_PASS_AWAITING_UX`
**Base:** `origin/main@6a81f5637d61bdd66d09c835ba613482609b8ea8`
**Branch:** `feature/p3-w05a-actor-scoped-reporting-team-scope`

## What changed

- Migration #47 `20261008070000_p3_w05a_actor_scoped_reporting.sql` (rebased onto
  `origin/main@ebb8217` by P3-W05A-I01-R1; migrations #1-#46 stay byte-identical):
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

## Gates

- W05A targeted 32 pass; W04A/W04B impacted 42 pass; actor/session/grant 71 pass.
- `next typegen` / `typecheck` / `lint` (0 errors) / `build` / `docs:check` / `git diff --check` pass.
- `db:migrate --offline`: 45 valid; `--dry-run`: 44 applied, 1 pending, 0 mismatch.
- Production read-only: 7 active HRP team leaders, 0 team-scope grants, 0 leaders with invalid link/membership, ledger 44/0/0.

## Deferred / out of scope

- W06C BoD/Team/Own UX (T1A). No UI built here. Production untouched (no apply, no deploy, no push to main).

