# Pre-W2-HF — Direct Entry-only reporting

> Status: `PRE_W2_HF_DE_REPORTING_DIRECT_ENTRY_ONLY_LOCAL_PASS_AWAITING_GITHUB_CI`
> Base: `origin/main@785bafc` (94 migrations). Branch: `codex/pre-w2-hf-direct-entry-reporting-decouple`.
> Migration: #95, `20261015110000_pre_w2_hf_reporting_direct_entry_only.sql` (append-only).
> No production/staging DB was accessed or changed. No VPS/Vercel deployment or UAT was performed.

## Contract locked from Owner clarification

The app's canonical reporting dataset is submitted Direct Entry. People may be entered with historical work dates; those dates do not make a row legacy. The report does not combine a separate aggregate/source into Direct Entry totals. This removes the prior preflight's unresolved legacy-ownership question.

## Change

- Include submitted, non-deleted Direct Entry rows without the global reporting cutoff. Existing user-selected date-range filters remain in effect.
- Group provider from the stored `direct_entries.provider_type` snapshot; do not re-resolve membership at `first_work_date`.
- Group recruiter using the current recruiter catalog display; do not require an alias interval at `first_work_date`.
- Return no external-source metadata/options and no legacy aggregate in the affected company/team reporting paths. Existing legacy storage/helpers remain untouched.
- Keep DB-authoritative actor/scope checks, service-role-only read ACLs, sanitized projections, pagination and no-store behavior.
- No `UPDATE`, `DELETE`, `TRUNCATE`, or other business-data mutation; migration only replaces reporting read definitions.

## Files/surfaces

- Migration #95 updates the reporting fact view, scoped fact/options RPCs and team drill-down envelope; existing scope/ACL boundaries are preserved.
- Reporting server/core code no longer blocks on cutover metadata or mixes other-source facts.
- Focused tests cover historical dates, stored provider, current recruiter display, source-filter invariance, empty source metadata/options and team drill-down behavior. Migration-ledger pins were advanced to 95 where needed.
- The earlier [preflight](pre-w2-hf-de-reporting-decouple-preflight.md) is retained for history and marked superseded.

## Verification

- `pnpm db:migrate --offline`: 95/95 on this worktree (offline only; no database connection).
- Focused lanes passed: `test:p3-w05a` (46), `test:p3-w05b-a-team-reporting` (13), `test:p3-w06d` (28), `test:p2-de-dim-hotfix` (20), P2-W04A migration/acceptance (38), and recruiter-alias history lane (3).
- `pnpm docs:check`: 6/6; `pnpm secrets:check`: clean; `git diff --check`: clean.
- Full `pnpm test` was not completed locally; the owner asked to let GitHub Actions run it. CI run `38703959166` found one remaining migration-count pin (`94`) in the P1.6 full-profile DB test harness; it was corrected to `95`, and that focused lane passed 41/41. CI must be rerun before treating the full suite as green.
- Typecheck, lint and migration validation passed in CI run `38703959166`; build was canceled after the shard failure, so its result is still pending on the rerun. Secrets/docs steps were skipped by CI after the failure; local checks passed.

## Owner UAT checklist

- Verify a submitted Direct Entry worker with a historical `first_work_date` appears in the report.
- Confirm provider category agrees with the stored worker record despite later membership changes.
- Confirm recruiter appears under the current catalog name without requiring alias history to cover the worker's date.
- Confirm totals/charts/options/team report use Direct Entry only and source filters do not remove or add facts.
- Confirm date-range filters still work and users outside existing scope see no additional rows.

Owner performs UAT. Do not apply the migration to any database until separately instructed.
