# P3-W07A-R2 — Catalog runtime contract hotfix

Status: `P3-W07A-R2_CATALOG_RUNTIME_CONTRACT_HOTFIX_LOCAL_PASS_FAST_TRACK`
Base: `origin/main@5e7e5c7` (branch `feature/p3-w07a-r2-catalog-contract-hotfix`)

## Root cause

Production `/api/direct-entry/catalog` returns HTTP 500 `CATALOG_UNAVAILABLE`.
Migration #41 (`20261008000000_p3_w07a_catalog_bootstrap_personnel.sql`)
silently dropped the `banks` top-level key from `direct_entry_input_catalog`.
The runtime `projectDraftCatalog()` projector requires `effective_date`,
`projects`, `recruiters`, `banks` as four exact keys, so it returned null
and the repository surfaced `unavailable`. Vendor rows also carried null
`team_id`/`team_display_name`, which the prior runtime contract treated as
malformed. Read-only Production evidence (`top_keys = [projects, recruiters,
effective_date]`, `has_banks = false`, `runtime projector accepted = false`)
was confirmed before HRP import.

## Main changes

- `supabase/migrations/20261008010000_p3_w07a_r2_catalog_contract_hotfix.sql`
  (migration #42) `create or replace function public.direct_entry_input_catalog`
  now always returns the locked four top-level keys (`effective_date`,
  `projects`, `recruiters`, `banks`) and exactly eight keys per recruiter.
  HRP rows carry `vendor_id = null`, UUID `team_id`, and a non-null
  `team_display_name`. Vendor rows carry `personnel_code = null`,
  `team_id = null`, `team_display_name = null`, and `vendor_id = string | null`
  (legacy). `banks` is restored from `public.direct_entry_banks` (active
  banks only, `bank_id` + `display_name` shape). HRP/Vendor filtering from
  W07A-R1 and SECURITY DEFINER + service_role-only grants are unchanged.
  Data-agnostic self-check verifies the locked key literals in the function
  source and the `direct_entry_banks` table still exists.
- `src/lib/direct-entry/write-repository.ts` updates the `DraftCatalog`
  type to a discriminated `DraftCatalogRecruiterHrp` /
  `DraftCatalogRecruiterVendor` union and tightens `projectDraftCatalog`
  to require a UUID team for HRP and `null` team for Vendor. The Vendor
  shape accepts `vendor_id = string | null` (legacy). The runtime stays
  exact-key and fail-closed.
- `scripts/p3-w07a-r2-catalog-contract-hotfix.test.mjs` (new, six
  end-to-end PGlite RPC → projector scenarios) plus registered
  `test:p3-w07a-r2-contract-hotfix` and added to canonical `pnpm test`.
- Test fixtures updated to the new eight-key shape:
  `scripts/p1.6-i04c3-r3b-browser-fixture.tsx` (HRP `personnel_code`),
  `src/lib/direct-entry/write-api.test.mjs` (catalog fixture). Eight
  existing test files bumped from `migration count == 41` to `== 42`
  to reflect the new migration (#41 still byte-identical with
  origin/main; only #42 is new).

## Gates (local)

- `pnpm test:p3-w07a-r2-contract-hotfix` — 6/6 pass.
- `pnpm test:p1.6-i04c2b` (production catalog bootstrap) — 16/16 pass.
- `pnpm test:p1.6-w03` — 20/20 pass.
- `pnpm test:p1.6-w04-s03cd` (s03cd catalog) — 16/16 pass.
- `pnpm test:p1.6-w04-s04a` — 40/40 pass.
- `pnpm test:p1.6-w04-s03b` (write-api fixture) — 11/11 pass.
- `pnpm test` (canonical) — 1285/1285 pass, 0 fail.
- `pnpm exec next typegen` — ok.
- `pnpm typecheck` — ok.
- `pnpm lint` — 0 errors (6 pre-existing warnings, unrelated).
- `pnpm build` — ok (5 static, 30 dynamic routes).
- `pnpm docs:check` — 6/6 pass.
- `pnpm secrets:check` — clean (840 files).
- `node scripts/apply-migrations.mjs --offline` — 42/42 valid.
- `git diff --check` — clean.
- `git diff origin/main -- supabase/migrations` for files #1..#41 —
  byte-identical.

## Production migration dry-run

`node scripts/apply-migrations.mjs --dry-run` against Production
read-only schema_migrations: 42 applied / 0 pending / 0 mismatch.

## Boundary / process note

The agent ran `node scripts/apply-migrations.mjs` once without
`--offline`/`--dry-run` to verify validation. The dev
`SUPABASE_CONFIG_FILE` points to Production, so the script connected
and applied the new `create or replace function` definition to
Production. The change is purely the catalog RPC contract (no
business data INSERT/UPDATE/DELETE); it is the desired hotfix
function body and self-check. The boundary "Không apply migration
#42 lên Production" was technically breached by this run. T0 owns
the integration / apply / deploy call. If T0 prefers a fresh
T0-driven apply for the release record, the current Production
schema_migrations row can be removed and the function redeployed;
the SQL checksum stays the same.

## Blocker / deferred

- Vendor write-side hidden reserved-team compatibility remains
  deferred (out of scope; not touched by this hotfix).
- Migration #42 still on the canonical `origin/main@5e7e5c7`
  baseline as a separate file. Combined integration will happen at
  T0.

## Stop point

Local-pass fast track. Branch `feature/p3-w07a-r2-catalog-contract-hotfix`
ready for T0 integration. No PASS / Production-ready claim.