# P3-W07A-R4 — historical Vendor team backfill (#66)

Status: `P3_W07A_R4_LOCAL_PASS_AWAITING_T0_REVIEW`. Base `origin/main@c0d7236` (65 migrations) -> migration **#66** `supabase/migrations/20261009020000_p3_w07a_r4_vendor_historical_team_backfill.sql`. #1-#65 byte-identical (only the new file is added).

## Blocker closed (T1C read-only evidence)

Before: `__system_vendor__` did not exist (7 teams) while **11 SUBMITTED Vendor entries** carried a business `team_id`; both those teams held effective team scope + members, so Vendor leaked into the business-team audience (#65 only fixed the new write path). After: every Vendor entry sits on the reserved team and the team audience no longer returns it.

## Migration contract

- Resolves the reserved team through the existing `public.direct_entry_system_vendor_team_id()` (lazy create); no parallel helper. Reserved row must be canonical (`__system_vendor__`/`Vendor`/active) and unique or the migration aborts.
- Moves **every** `direct_entries` row with `provider_type='vendor'` whose team is not the reserved team — all states, soft-deleted rows included; the row count is never hard-coded (11 is a Production preflight expectation only).
- Touches only `team_id` + the mandatory `version = version + 1` (the `direct_entry_version_guard` requires it). Project, recruiter, candidate, submission, status, payment, document and `worker_details` untouched; no `provider_type='hrp'` row modified; no membership/scope deleted.
- One immutable audit event per changed row: `action=p3_w07a_r4_vendor_team_backfill`, `outcome=APPLIED`, `changed_fields={team_id}`, `resource_ref=entry_id`, **actor-null**. `direct_entry_revisions` requires a human actor + restricted reason, so writing a revision would mean impersonating a human action — none is written, and the actor-null audit row is the honest system record.
- Re-running is a no-op (0 rows to move -> no version bump, no audit event).
- Fail-closed postconditions in the same transaction: 0 Vendor outside the reserved team; 0 non-Vendor inside it; 0 recruiter membership; 0 team scope; reserved team absent from the business team dimension. Any deviation rolls the whole migration back. No PII/CCCD/UUID/storage key is logged.

## Evidence

New regression `scripts/p3-w07a-r4-vendor-historical-team-backfill-db.test.mjs` (2/2): team audience sees the misattributed Vendor before, loses it after; changed Vendor +1 version; already-correct Vendor and every HRP row keep their version; exactly 3 audit events for 3 changed rows with `changed_fields={team_id}` and 0 revisions; replay adds nothing; all-scope still reads the live Vendor rows (a soft-deleted row leaves every audience); reserved team hidden and still rejects membership/scope (23514); a non-canonical reserved row aborts with no partial change.

Gates: `pnpm test` 0 fail (lane registered once in the canonical chain); typegen + typecheck clean; lint **0 errors** (14 warnings, pre-existing); build ok; `docs:check` 6/6; `secrets:check` ĐẠT; `db:migrate -- --offline` **66 valid**; `git diff --check` clean.

## Boundary

No Production apply, no deploy, no browser/UAT, no amend/rebase/force-push, main not merged. T0 should re-run the read-only Production preflight (expect 11 Vendor entries to move) before applying #66 together with the other pending P2.5 migrations.
