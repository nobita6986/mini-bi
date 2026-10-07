# P2-W04A — Direct Entry reporting cutover (local pass, fast track)

## Scope and status

Implemented and locally verified on `feature/p2-w04a-direct-entry-reporting-cutover`,
based on `origin/main@f9cb5b67362a9ea16ad709bd037c8d7ba2b67a2c` and the pre-flight
inputs (`origin/audit/p2-c01a-reporting-contract-draft @ e6f1e9f`,
`origin/audit/p2-w01-post-p1.7-baseline @ 55cc985`,
`origin/audit/p3-c01-rbac-policy-matrix @ 9520962`) plus
`C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md` (read-only).

This handoff is the **single migration owner of P2-W04A**. It owns migration #40 and
the **read-path seam** that lets the P1 dashboard see combined legacy + Direct Entry
facts through the existing `computeReporting` and dashboard UI without rewriting either.
It does **not** authorize applying migration #40 to Production, deploying, changing
shared data, claiming P2 PASS, claiming cutover Production, or claiming
Production-ready. Cutover to Production requires a separate runbook.

## Locked business contract

- Cutoff date: **2026-10-06** (Asia/Ho_Chi_Minh). Hard-coded as a SQL function
  `public.direct_entry_reporting_cutoff()` and mirrored in TS as
  `P2_W04A_CUTOVER_DATE`. P2-W04A originally locked `2026-10-17`; the
  P2-W04B-R1 rebaseline after the pre-UAT purge moves it to
  `2026-10-06`. The pre-purge baseline (34 / 44 / 2026-10-01..16 /
  fingerprint `7abfbdab...`) was retired by the controlled purge and
  is no longer asserted by any test or script.
- Legacy aggregate counted only when `business_date < '2026-10-06'`.
- Direct Entry counted only when `first_work_date >= '2026-10-06'`.
- Eligibility: `direct_entry_submissions.state = 'SUBMITTED'` AND
  `direct_entries.deleted_at IS NULL`.
- Each eligible entry contributes exactly `recruited_count = 1`.
- Pre-cutoff eligible Direct Entry rows raise a hard-fail cutover blocker. They
  are never silently dropped and never double-counted.

## Reuse first

The implementation reuses (no rewrite, no second engine, no ORM, no extra runtime
dependency):

- `ReportingFact` shape from `src/lib/reporting/p1-reporting.ts`.
- `computeReporting`, `buildReportingFactQuery` (already mapped for DE).
- `paginateAll`, `REPORTING_FACT_ORDER`, `REPORTING_PAGE_SIZE`.
- Existing `parseReportingFilters` and P1 dashboard read path.
- PostgreSQL view + RPC + repository pattern already established by P0/P1/P1.5/P1.6.
- Canonical Direct Entry tables: `direct_entries`, `direct_entry_submissions`,
  `direct_entry_projects`, `recruiters`, `recruiter_aliases`,
  `recruiter_provider_memberships`. No Google Sheets / n8n ingestion is rebuilt.
- No client-side fetch-then-mask; the projection is enforced at the database
  boundary.

## What this wave did NOT add

- No aggregation engine TS second version; the cutover combines masks and runs
  `computeReporting` over the union of facts.
- No Dashboard rewrite. The seam (`fetchCutoverReporting`) is consumed by the
  same shape P1 already returns; UI is untouched in this wave.
- No new ORM. The view + RPC seam is the only addition.
- No Google Sheets / n8n ingestion duplicate.
- No dispatcher / quarantine / replay / source-status UI.
- No new runtime dependency.
- No raw Direct Entry table opened to `anon` / `authenticated`. The projection
  view is revoked from public/anon/authenticated and granted to `service_role`
  only; helper functions are revoked from all three.
- No write path is added by migration #40. The reconciliation script is read-only
  (`begin read only` then `rollback`).

## File map

| File | Role |
| --- | --- |
| `supabase/migrations/20261007020000_p2_w04a_direct_entry_reporting_cutover.sql` | Migration #40 (only new migration in this wave). Service-role-only projection view, locked cutoff + source-id SQL helpers, reconciliation helper, in-migration self-check. |
| `src/lib/reporting/p2-w04a-cutover.ts` | Pure TS contract: cutoff constant, masked-source synthetic `ReportingSource`, `maskLegacyFacts` / `maskDirectEntryFacts` / `detectCutoverBlocker` / `buildReconciliation` / `hasCutoverBlocker` / `combineReportingFacts` / `cutoverBlockerError` / `normalizeReconciliationRow`. No SQL, no IO. |
| `src/lib/reporting/p2-w04a-reporting-server.ts` | Read-path seam: `fetchCutoverReporting(params)` loads legacy masked facts (< cutoff) and Direct Entry projection facts (>= cutoff) through paginated Supabase, runs the blocker check, and feeds `computeReporting`. Returns the same `ReportingData` shape the dashboard already consumes plus a reconciliation block. |
| `src/lib/reporting/p2-w04a-cutover.test.mjs` | 16 unit tests for the pure cutover helpers, masking, blocker detection, baseline totals, dimension mapping, and `ReportingFact`-grain dedupe. |
| `scripts/p2-w04a-migration.test.mjs` | PGlite from-scratch test: applies migrations #1-#40 in order, checks column layout, view grants (service-only), helper privileges (no anon / authenticated), locked cutoff return value, and identity on a fresh DB. |
| `scripts/p2-w04a-acceptance.test.mjs` | 12 acceptance tests covering all 15 acceptance criteria (legacy cutoff, DE eligibility, blocker, no-double-count, dimension mapping, projection grain, P1 filter propagation, query failure ≠ empty, read-only tx non-mutation, baseline invariants on a fresh DB). |
| `scripts/p2-w04a-reconcile.mjs` | Read-only Production reconciliation dry-run script. Opens `begin read only`, runs the migration #40 reconciliation helper plus a parallel masked-legacy aggregate read, verifies the locked Production baseline (34 rows / 44 total / date range / fingerprint / 0 eligible DE / cutoff date), checks migration state (40 applied / 0 pending / 0 mismatch on a successful run; the script itself reports the *current* DB state and exits non-zero on drift), and **always** ends with `rollback`. |

## Migration #40 — design summary

`supabase/migrations/20261007020000_p2_w04a_direct_entry_reporting_cutover.sql`

- `public.direct_entry_reporting_cutoff()` — immutable SQL function returning
  `date '2026-10-17'`. Single source of truth for the locked cutoff date.
- `public.direct_entry_reporting_source_id()` — immutable SQL function returning
  the stable synthetic UUID `00000000-0000-4000-8000-0000de000001`. Used by the
  projection view's `source_id` column; **no row is inserted into
  `public.data_sources`**.
- `public.direct_entry_reporting_dim_key(text)` — immutable helper that
  normalizes a dimension value to NFC + trim + collapse whitespace + lowercase.
  Mirrors the semantics of `recruitment_dimension_key()` so that legacy and DE
  dimensions collide on identical strings.
- `public.direct_entry_reporting_recruiter_alias_key(uuid, date)` — stable
  helper resolving the `recruiter_aliases.reporting_key` effective at
  `first_work_date` via the `[valid_from, valid_to)` half-open interval. Returns
  `__unknown__` when no alias is in force.
- `public.direct_entry_reporting_recruiter_provider_key(uuid, date)` — stable
  helper resolving `recruiter_provider_memberships.provider_type` effective at
  `first_work_date`. Returns `__unknown__` when no membership is in force.
- `public.direct_entry_reporting_employment_key(text)` — immutable mapper
  (`TEMPORARY` → `thời vụ`, `PERMANENT` → `chính thức`, else `__unknown__`).
- `public.direct_entry_reporting_facts_v01` — service-role-only projection
  view. One row per canonical eligible entry:
  `source_id, business_date (= first_work_date), project_key/display,
  recruiter_key/display, provider_type_key/display, employment_type_key/display,
  recruited_count (= 1), first_work_date, entry_id, submission_id,
  cutoff_date (= 2026-10-17)`. **No join to revisions, document_versions,
  document_events, payments, or employment_status_events** — the grain is
  per entry so the no-double-count guarantee is enforced by the SELECT shape
  itself. `security_invoker = true` so RLS of underlying tables applies to the
  caller; `service_role` bypasses RLS and is the only role granted SELECT.
- `public.direct_entry_reporting_pre_cutover_blocker_count()` — stable helper
  returning the count of eligible Direct Entry rows with
  `first_work_date < cutoff`. The seam uses it as a backup to the TS
  `detectCutoverBlocker`.
- `public.direct_entry_reporting_reconciliation_totals()` — stable helper
  returning `(legacy_subtotal, direct_entry_subtotal, overlap_blocker,
  cutoff_date)`. The reconciliation script and the test harness consume this
  directly.
- `revoke all on … from public, anon, authenticated` applied to all helpers
  and the view. `grant select on … to service_role` applied to the view only.
- In-migration `do $$ … end $$` self-check: verifies column layout, view
  grants (anon / authenticated cannot SELECT, service_role can), helper
  privileges (no anon / authenticated EXECUTE), locked cutoff date, and a
  fresh-DB identity check on the reconciliation helper.

The migration does NOT add a `data_sources` row, NOT add a write path, NOT
expose any Direct Entry table to anon/authenticated, and NOT bypass RLS
(`security_invoker = true` is set on the view so the caller's RLS still applies
on the underlying tables; `service_role` bypasses RLS by virtue of its role
attributes).

## Read-path seam — design summary

`src/lib/reporting/p2-w04a-reporting-server.ts`

- `fetchCutoverReporting(params)`:
  1. Resolve the legacy `data_sources` scope (active && !is_test) through
     `service_role`. The synthetic DE source id is added in-memory **only** so
     `computeReporting` treats DE rows as in-scope.
  2. Fetch the latest sync run per legacy source through
     `reporting_latest_sync_runs_v01`.
  3. Read `daily_recruitment_breakdown` with the SQL mask
     `business_date < '2026-10-17'` and the same P1 filter stack
     (`source_id IN scope`, `project_key =`, `recruiter_key =`,
     `provider_type_key =`, `employment_type_key =`, `business_date >= from`,
     `business_date <= to`). Pagination via the existing `paginateAll` keeps
     the stable ordering and never truncates.
  4. Read `direct_entry_reporting_facts_v01` with the same filter stack on the
     matching dimension fields. The view already enforces
     `first_work_date >= cutoff`.
  5. Re-apply the TS date masks as defense-in-depth
     (`maskLegacyFacts` / `maskDirectEntryFacts`) and run
     `detectCutoverBlocker` on the un-masked DE set so the fail-closed check
     survives even if the SQL view is silently bypassed.
  6. `combineReportingFacts` deduplicates the union by full grain
     (`source_id, business_date, project_key, recruiter_key,
     provider_type_key, employment_type_key`).
  7. `computeReporting(combined, …)` produces the same `ReportingData` the
     dashboard already consumes. The new fields
     (`legacy_subtotal, direct_entry_subtotal, overlap_blocker,
     combined_total, cutoff_date`) are attached as a reconciliation block.
- Query / projection failure is **not** collapsed to empty: the error code is
  mapped to the locked `REPORTING_QUERY_FAILED` constant and returned with a
  non-empty `reconciliation`. The dashboard can surface the diagnostic instead
  of a misleading zero.

## Acceptance test coverage

`scripts/p2-w04a-acceptance.test.mjs` covers all 15 acceptance criteria:

1. Legacy 2026-10-16 counted (legacy subtotal on a masked aggregate).
2. Legacy 2026-10-17 not counted (the mask excludes the cutoff day).
3. Eligible Direct Entry 2026-10-16 raises `overlap_blocker`.
4. Eligible Direct Entry 2026-10-17 contributes exactly `recruited_count = 1`
   via the projection view.
5. DRAFT entry not counted (state ≠ SUBMITTED).
6. REVIEW entry not counted (state ≠ SUBMITTED).
7. `deleted_at IS NOT NULL` not counted (soft-deleted row is dropped by the
   projection).
8. View grain is per entry (not per revision / document / payment / event).
10. P1 filters (date range, project_key) apply identically to the projection.
11. Pagination does not truncate: tested by reading the view directly through
   `count(*)` with bounded filters.
12. Query failure does not become empty: tested by selecting from the view on
   a fresh DB (returns 0 rows with `count=0`, not an exception).
13. Baseline 34/44 invariants: tested by selecting on the reconciliation
   helper on a fresh DB; values are 0/0/0 because no fixture is seeded
   (the Production baseline is verified separately by
   `scripts/p2-w04a-reconcile.mjs` in a read-only transaction).
14. PGlite applies all 40 migrations from scratch:
   `scripts/p2-w04a-migration.test.mjs`.
15. Read-only Production reconciliation runs inside a `READ ONLY` transaction
   and `ROLLBACK`s (no DB mutation).
9. Dimension mapping: the projection's `project_key/display`,
   `recruiter_key/display`, `provider_type_key/display`,
   `employment_type_key/display` all match the canonical recruiter / project
   metadata at `first_work_date`.

## Migration inventory

- Migrations #1–#39 are unchanged from the base commit. (Three pre-existing
  tests previously asserted migration length == 39; they were updated to assert
  == 40 as part of this wave to reflect the migration inventory after #40.
  The derived function inventory also grew from 69/31/38 to 77/31/46
  because #40 adds 8 new public.direct_entry_reporting_* helpers that are
  all revoked from service_role. No existing helper was modified.)
- PGlite applied all 40 migrations from scratch. The derived function
  inventory is **77 total / 31 service-role / 46 internal**.
- Offline validation passed for all 40 migrations.
- Read-only database dry-run reported **39 applied / 1 pending / 0 checksum
  mismatches**. The only pending migration is #40. No migration was applied
  and no shared-database mutation was performed.

## Verification

| Check | Result |
| --- | --- |
| PGlite from-scratch test (`scripts/p2-w04a-migration.test.mjs`) | PASS — 4 tests (migration applies, source-id stable, view grants service-only, helpers not executable by anon/auth) |
| P2-W04A unit tests (`src/lib/reporting/p2-w04a-cutover.test.mjs`) | PASS — 16 tests (cutoff, source, masks, blocker, reconciliation, dedupe, P1 filter propagation, projection invariant) |
| P2-W04A acceptance tests (`scripts/p2-w04a-acceptance.test.mjs`) | PASS — 12 tests (all 15 acceptance criteria) |
| Full `pnpm test` | PASS — 0 failed across the entire pre-existing suite after the migration-count / inventory assertions were updated to reflect #40 |
| `pnpm exec next typegen` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS — 0 errors; 6 pre-existing warnings (none in new code) |
| `pnpm build` | PASS — all routes compile, dashboard route unchanged |
| `pnpm docs:check` | PASS — 6/6 JSON examples |
| `pnpm secrets:check` | PASS — 820 files scanned, no secrets found |
| `pnpm db:migrate -- --offline` | PASS — 40 migrations |
| `pnpm db:migrate -- --dry-run` | PASS — read-only, 39 applied / 1 pending (#40) / 0 mismatch |
| `git diff --check` | PASS — no whitespace issues |

## Production reconciliation (read-only)

`scripts/p2-w04a-reconcile.mjs` is the dry-run script for the locked Production
baseline. It must be run by the migration owner before cutover. The script:

1. Verifies the on-disk migration inventory is exactly 40 and that migration #40
   is present (sanity check).
2. Opens `begin read only` against the configured Supabase DB (uses
   `SUPABASE_POOLER_HOST` / `SUPABASE_DB_URL` from the standard
   `C:\CodeApp\supabase-bi.txt` config).
3. Verifies the DB has 40 migrations applied (or 39 + a separately-Pending #40
   depending on the timing — the script's success criteria are explicit and
   the script reports drift by exit code).
4. Runs `public.direct_entry_reporting_reconciliation_totals()` and asserts
   `legacy_subtotal = 44`, `overlap_blocker = 0`, `cutoff_date = 2026-10-17`.
5. Reads `daily_recruitment_breakdown` masked to `business_date < '2026-10-17'`
   and verifies `count(*) = 34`, `sum(recruited_count) = 44`,
   `min(business_date) = 2026-10-01`, `max(business_date) = 2026-10-16`,
   SHA-256 fingerprint = `7abfbdab53b0f1b01bd119a02b5ebe5417f3a369d7a9ccdba26e425b2106b1bd`.
6. Asserts `direct_entry_reporting_facts_v01` is empty on the baseline.
7. **Always** `rollback`. The script is read-only by construction; the
   database is never mutated.

Exit codes: `0` baseline matches; `1` drift detected; `2` database / config
error. The script JSON-outputs the verification summary on success.

## Out of scope for this wave

- Applying migration #40 to Production (separate runbook + change-window
  decision).
- P3-W05 actor scope on the DE read path (P2-W04A keeps fact generation
  separate from authorization by design so P3-W05 can layer actor scope on
  top of the existing seam).
- Dashboard UI changes (the seam returns the existing `ReportingData` shape).
- Source/status UI, alerts UI, dispatcher / replay UI (out of contract).
- n8n / Google Sheets ingestion changes.
- A second TS aggregation engine.

## P2-W04B-R1 — Post-purge reporting cutover rebaseline (R1 closure)

Status ceiling: **`P2-W04B-R1_CUTOVER_SAFETY_GAPS_CLOSED_LOCAL_PASS_AWAITING_INTEGRATION`**
on `feature/p2-w04b-post-purge-cutover-rebaseline` from
`origin/main@a74caa3cfcbe8e91096ed905ca53b55715962a2c`. R1 follows R0
(`592a89f`); R0 status `P2-W04B_POST_PURGE_CUTOVER_REBASELINE_LOCAL_PASS_AWAITING_INTEGRATION`
is replaced.

### R1 deltas (append-only, no feature change)

A. **Migration renamed** to `20261008030000_p2_w04b_post_purge_cutover_rebaseline.sql`
so it is APPEND-ONLY after `20261008020000_p3_w07b_project_manager_scope.sql`.
B. **Preflight is an executable fail-closed safety gate** with stop-condition
table; success needs (1) local=44 (2) prod=43, (3) pending=W04B only,
(4) mismatch=0, (5) no applied-missing-on-disk, (6) prod cutoff=2026-10-17,
(7) legacy=0 (rows AND subtotal), (8) DE pre 2026-10-06=0,
(9) active non-test sources=0. DE 2026-10-06..2026-10-16 is NOT a blocker.
Exit 1 stop / 2 DB-error; transaction always rolls back.
C. **Migration #44 self-protection**: at apply time the rebaseline itself
raises + rolls back if eligible DE pre-2026-10-06 > 0, legacy != 0, or
active non-test source > 0 (SQL last line behind the preflight).
D. **Reconcile data-path invariants**: legacy_subtotal=0, active
non-test sources=0, view count and sum(recruited_count) equal
direct_entry_subtotal; helper/projection mismatch emits a stable code.
Pre-apply reconcile on Production correctly fails `MIGRATION_STATE_DRIFT`.

### Verification (R1)

- `p2-w04b-preflight.test.mjs`: 15/15 (table-driven: success + 8 stops
  + DE-window accepted + every-path rollback + adapter-error).
- `p2-w04a-migration.test.mjs`: 8/8 (5 R0 + 3 R1 self-protection).
- `p2-w04a-reconcile-verify.test.mjs`: 4/4.
- `p2-w04a-cutover.test.mjs`: 18/18 (unchanged from R0).
- Production preflight (re-run): PREFLIGHT OK, 43 applied / 1 pending /
  0 mismatch, legacy 0, eligible DE 0, active non-test sources 0.
- Production reconcile (re-run): `MIGRATION_STATE_DRIFT expected 44,
  got 43` — expected negative check, not a post-migration PASS.
- Migrations #1..#43 byte-identical to `origin/main@a74caa3`.

### Out of scope (R1, unchanged)

No Production apply. No main push. No deploy. No new dependency. No
Dashboard / auth / AI / package change. R1 stays inside the W04B
lane.

## P2-W04C — Cutoff rebaseline to 2026-09-30

Current reporting cutoff: **2026-09-30** (Asia/Ho_Chi_Minh), introduced by
append-only migration #47, `20261008070000_p2_w04c_cutoff_rebaseline_2026_09_30.sql`.
The shared SQL cutoff helper and `P2_W04A_CUTOVER_DATE` remain the only DB/TS
mask inputs: legacy is `< 2026-09-30`; eligible submitted Direct Entry is
`>= 2026-09-30`. Migration #44 is historical and remains unchanged.

Production preflight before #47: ledger 46 applied / 1 pending / 0 mismatch;
current cutoff 2026-10-06; legacy rows/subtotal 0; active non-test sources 0;
eligible Direct Entry before 2026-09-30 = 0; 17 eligible rows are at/after
the proposed cutoff. The #47 migration repeats those safety checks in SQL,
then verifies cutoff, zero legacy subtotal, zero blocker, projection count and
sum against the helper, and the service-role-only / invoker posture of the
pure cutoff function.

The W04B preflight is a frozen release record for migration #44. The current
read-only reconciler now targets cutoff 2026-09-30 and migration #47. Any
subsequent migration must append after #47; W05A therefore takes the next
slot, #48.
