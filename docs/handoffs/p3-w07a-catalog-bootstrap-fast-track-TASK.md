# P3-W07A — Catalog bootstrap fast-track (T1A)

## Status

`P3-W07A_CATALOG_BOOTSTRAP_LOCAL_PASS_FAST_TRACK` (target).

## Base

- Branch: `feature/p3-w07a-catalog-bootstrap-fast-track`
- Worktree: `C:\CodeApp\BI-p3-w07a-catalog-bootstrap` (isolated from primary checkout)
- `origin/main`: `c4f3843686aaeb1c84a9790af5c8864394e84d92`
- Migration ledger: 40 applied / 0 pending / 0 mismatch

## Scope (booted from prompt)

- Owner XLSX bootstrap → Projects / Teams / HRP_Personnel / Vendors.
- Projects: flat text list, no manager/team/vendor/effective-date.
- HRP personnel: `personnel_code` / `display_name` / `position` (STAFF|TEAM_LEADER) / `team` / `active`.
- Trưởng nhóm = authenticated app user. Team dashboard deferred to W07B.
- HRP dropdown shows only HRP Sale records (label `Họ và tên · ID · Team`); stored value = canonical `recruiter_id`.
- Vendor dropdown shows only Vendor records (no team/leader/project restriction).
- Direct Entry dropdown regression: re-select same value, change to different, open-then-click-outside must all keep the value (no "pick another first").
- No Catalog Admin UI. No new admin API. No navigation entry. No CRUD UI. No generic import framework.

## Reuse-first boundary

| Need | Reuse |
|---|---|
| XLSX parsing | `exceljs` (already in deps; used by `worker-profile-xlsx.ts`) |
| DB access | `pg`, `loadSupabaseConfig`, `buildSslOptions`, `supabase-tls` |
| Catalog tables | `recruiters`, `teams`, `recruiter_aliases`, `recruiter_provider_memberships`, `recruiter_team_memberships`, `direct_entry_projects` |
| Vendor catalog | New minimal `vendors` table (one row = one vendor display text); recruiters reference HRP via existing `recruiters`/`recruiter_provider_memberships` |
| Personnel code | New column `personnel_code text` on `recruiters` (unique normalized) + `personnel_position text` |
| Input catalog projection | `public.direct_entry_input_catalog` extended (HRP label + ID + team; Vendor label; Projects unfiltered) |
| HRP/Vendor split | Existing `provider_type` filter on `recruiters`; `vendor` membership for vendor display |
| Dropdown editor | `SelectCellEditor` in `direct-entry-spreadsheet-grid.tsx`; P1.7-H07 text editor contract |

## Source-verified catalog delta (migration #41)

The surveyed `recruiters` table is missing the `personnel_code`/`personnel_position` columns and the `vendors` table does not exist. Smallest schema delta:

1. `public.recruiters`: add `personnel_code text` (unique, nullable for existing rows that are not personnel-driven), `personnel_position text` check `in ('STAFF','TEAM_LEADER')`.
2. `public.teams`: add `vendor_label text` is **NOT** needed — vendors go in their own table.
3. `public.vendors` (new): `vendor_id text primary key`, `display_name text`, `active boolean default true`. Mirrors `direct_entry_projects` shape.
4. `public.recruiter_provider_memberships`: already carries `provider_type` in `('hrp','vendor')` — vendor recruiter rows are linked to vendors via new `recruiter_provider_memberships.vendor_id text` (nullable, FK to `vendors`).

No write to the canonical `recruiter_id` storage. `recruiter_id` remains the value Direct Entry stores. Migration #41 is the smallest delta and adds only one table (`vendors`) and three columns on existing tables; it does NOT alter migrations #1–#40.

## Implementation files

- `supabase/migrations/20261008000000_p3_w07a_catalog_bootstrap_personnel.sql` (migration #41)
- `scripts/p3-w07a-catalog-bootstrap.mjs` (local operator importer: `--dry-run` default; `--apply` with explicit confirm token + workbook path + idempotency key)
- `src/lib/direct-entry/direct-entry-input-catalog.ts` (new projection module; consumed by new migration-defined RPC `direct_entry_input_catalog_v2`)
- `src/lib/direct-entry/direct-entry-input-catalog-v2.sql.ts` or directly in migration: replace `direct_entry_input_catalog` to (a) project HRP recruiters with `personnel_code` + team label, (b) project Vendor recruiters with vendor display name, (c) keep Projects unfiltered.
- `src/components/direct-entry/direct-entry-spreadsheet-grid.tsx` — `SelectCellEditor`: handle same-value re-select, ensure no clobber when value unchanged. Add explicit `onBlur`/`onKeyDown` Enter/Tab paths that commit current `value` via `onRowChange(row, true)`.
- `scripts/p3-w07a-catalog-bootstrap.test.mjs` (PGlite migration + dry-run + idempotent re-import + ambiguous-match + missing-record preservation)
- `src/components/direct-entry/direct-entry-spreadsheet-grid-dropdown-regression.test.mjs` (dropdown regression: same-value reselect, change, click-outside, currently-selected option, first option)

## Out of scope (deferred)

- Catalog Admin UI / CRUD. Team leader workflow. Leader assignment. Onboarding/offboarding.
- AI Settings / AI Report UI. Capability grants for non-Owner.
- Vendor / team / HRP business rules beyond the prompt's locked value list.
- Applying the workbook to Production.

## Stop point

`P3-W07A_CATALOG_BOOTSTRAP_LOCAL_PASS_FAST_TRACK` — local gates pass; no Production migration; no real workbook imported; no P3 PASS claimed.

## Owner-only confirmations (T0)

- Owner workbook is owned externally; never committed.
- `--apply` requires explicit `P3_W07A_CATALOG_APPLY` confirmation token + idempotency key (12+ chars) and is never auto-applied.