# P3-W07A-R2 — Catalog runtime contract hotfix

Status: `P3-W07A-R2_CATALOG_HOTFIX_PROD_SCHEMA_APPLIED_CODE_LOCAL_PASS_WAITING_INTEGRATION`
Base: `origin/main@5e7e5c7` (branch `feature/p3-w07a-r2-catalog-contract-hotfix`)

## Root cause

Production `/api/direct-entry/catalog` returned HTTP 500
`CATALOG_UNAVAILABLE`. Migration #41
(`20261008000000_p3_w07a_catalog_bootstrap_personnel.sql`) replaced
`direct_entry_input_catalog` and silently dropped the `banks` top-level
key while emitting Vendor rows with `team_id = team_display_name = null`.
The runtime `projectDraftCatalog()` requires four exact top-level keys
(`effective_date, projects, recruiters, banks`) and a non-null UUID
`team_id` per recruiter, so the projection returned null and the
repository surfaced `unavailable`. Read-only Production evidence
(`top_keys = [projects, recruiters, effective_date]`,
`has_banks = false`, `runtime projector accepted = false`) was
confirmed before HRP import.

## Main changes

- `supabase/migrations/20261008010000_p3_w07a_r2_catalog_contract_hotfix.sql`
  (migration #42) `create or replace function
  public.direct_entry_input_catalog` now always returns the four locked
  top-level keys and exactly eight keys per recruiter. HRP rows carry
  `vendor_id = null`, UUID `team_id`, and a non-null
  `team_display_name`. Vendor rows carry `personnel_code = null`,
  `team_id = team_display_name = null`, and `vendor_id = string | null`
  (legacy). `banks` is restored from `public.direct_entry_banks`
  (active banks only, `{ bank_id, display_name }` shape). HRP / Vendor
  filtering from W07A-R1 and SECURITY DEFINER + service_role-only
  grants are unchanged. Data-agnostic self-check verifies the locked
  key literals and the `direct_entry_banks` table still exists.
- `src/lib/direct-entry/write-repository.ts` updates the `DraftCatalog`
  type to a discriminated `DraftCatalogRecruiterHrp` /
  `DraftCatalogRecruiterVendor` union and tightens `projectDraftCatalog`
  to require a UUID team for HRP and `null` team for Vendor. Vendor
  accepts `vendor_id = string | null` (legacy). Runtime stays
  exact-key and fail-closed.
- `scripts/p3-w07a-r2-catalog-contract-hotfix.test.mjs` (new, six
  PGlite end-to-end RPC → projector scenarios) registered as
  `test:p3-w07a-r2-contract-hotfix` and added to canonical `pnpm test`.
- Existing test fixtures updated to the new eight-key shape:
  `scripts/p1.6-i04c3-r3b-browser-fixture.tsx` (HRP `personnel_code`),
  `src/lib/direct-entry/write-api.test.mjs` (catalog fixture). Eight
  existing test files bumped from `migration count == 41` to `== 42`
  to reflect the new migration (#41 still byte-identical with
  origin/main; only #42 is new).
- `scripts/p3-w07a-r2-catalog-prod-readonly-verify.mjs` and
  `scripts/p3-w07a-r2-catalog-prod-ledger-evidence.mjs` (read-only
  Production verification + ledger evidence pull; both `select`-only).

## Production apply — boundary disclosure

The agent ran `node scripts/apply-migrations.mjs` once during
validation without `--offline` / `--dry-run`. The dev
`SUPABASE_CONFIG_FILE` on this machine points to Production, so the
script connected and applied migration #42 (one `create or replace
function` + the in-migration `do $$` self-check; no business data
INSERT/UPDATE/DELETE).

| Field | Value |
|---|---|
| Command | `node scripts/apply-migrations.mjs` (no flag) |
| Project ref | `kiam***` (Production) |
| Applied at (UTC) | `2026-10-06T06:22:24.186Z` |
| Local SHA-256 of file #42 | `b0faaae3cf09e5b76312e8a1245238abefe4cb5014391b3de8838e7cc5cd5b31` |
| Production `schema_migrations.checksum` | `b0faaae3cf09e5b76312e8a1245238abefe4cb5014391b3de8838e7cc5cd5b31` (identical) |
| Migration body scope | `create or replace function` + `revoke`/`grant` + in-migration `do $$` self-check only. No DML on catalog / business tables. |
| Business data | Untouched (7 teams, 52 HRP, 7 leaders, 45 staff, 0 vendor — all unchanged). |

T0 instructions (`Giữ nguyên migration #42 đã apply; tuyệt đối KHÔNG
xóa schema_migrations row, không rollback thủ công, không sửa bytes
migration #42`) are followed: no rollback, no manual revert, no local
edit to the committed file. The local file and the Production checksum
match; the agent only continues with read-only verification and
finishes the local code path.

## Read-only Production verification (12/12 PASS)

`node --conditions=react-server scripts/p3-w07a-r2-catalog-prod-readonly-verify.mjs`:

| # | Check | Result |
|---|---|---|
| 1 | `schema_migrations` has 2 W07A rows (R1 and R2) | PASS |
| 2 | RPC top-level keys locked to `{banks, effective_date, projects, recruiters}` | PASS |
| 3 | `banks` is an array (length 0 — no banks imported yet) | PASS |
| 4 | `recruiters` is an array (length 52) | PASS |
| 5 | 52 HRP rows surface with `vendor_id = null` and UUID `team_id` | PASS |
| 6 | 0 Vendor rows in Production (no Vendor catalog yet) | PASS |
| 7 | `projectDraftCatalog(raw, effectiveDate)` accepts the raw RPC payload | PASS |
| 8 | 7 active teams (unchanged) | PASS |
| 9 | 52 active HRP recruiters (unchanged) | PASS |
| 10 | 7 team leaders (unchanged) | PASS |
| 11 | 45 staff (unchanged) | PASS |
| 12 | `direct_entry_input_catalog` function exists in Production | PASS |

## Gates (local)

- `pnpm test:p3-w07a-r2-contract-hotfix` — 6/6.
- `pnpm test:p1.6-i04c2b` (production catalog bootstrap) — 16/16.
- `pnpm test:p1.6-w03` — 20/20.
- `pnpm test:p1.6-w04-s03cd` — 16/16.
- `pnpm test:p1.6-w04-s04a` — 40/40.
- `pnpm test:p1.6-w04-s03b` — 11/11.
- `pnpm test` (canonical) — 1285/1285, 0 fail.
- `pnpm exec next typegen` — ok.
- `pnpm typecheck` — ok.
- `pnpm lint` — 0 errors (6 pre-existing warnings, unrelated).
- `pnpm build` — ok (5 static, 30 dynamic routes).
- `pnpm docs:check` — 6/6.
- `pnpm secrets:check` — clean (840 files).
- `node scripts/apply-migrations.mjs --offline` — 42/42 valid.
- `git diff --check` — clean.
- `git diff origin/main -- supabase/migrations/2026.../*` for files
  #1..#41 — byte-identical.
- `node scripts/apply-migrations.mjs --dry-run` (read-only) —
  42 applied / 0 pending / 0 mismatch.

## Branch state

- `feature/p3-w07a-r2-catalog-contract-hotfix` pushed to
  `origin/feature/p3-w07a-r2-catalog-contract-hotfix`.
- Local HEAD = remote HEAD = `7d8f03d705c698372948e2f2aa9062ff36685d94`.
- Worktree `C:\CodeApp\BI-p3-w07a-r2-catalog-contract-hotfix` clean
  after the apply evidence commit (no further commits planned in this
  task; further code commits are deferred to T0 integration).

## Blocker / deferred

- Vendor write-side hidden reserved-team compatibility remains
  deferred (out of scope; not touched by this hotfix).
- T0 owns integration / release record / Owner UI UAT confirmation.
  Agent does not claim P3 PASS, Production-ready, or task complete at
  Production. Runtime code (write-repository.ts, draft-api.ts, route,
  regression suite) is local-pass and awaits T0 integration.

## Stop point

Hotfix code and migration #42 are both in the branch and on
Production (via accidental apply during validation). All gates are
green locally and the read-only Production verification is 12/12.
T0 owns the integration, apply, deploy, and combined release record.
