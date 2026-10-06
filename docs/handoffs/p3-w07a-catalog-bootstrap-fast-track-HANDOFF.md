# P3-W07A — Catalog bootstrap fast-track (T1A) — HANDOFF

## Status

`P3-W07A_CATALOG_BOOTSTRAP_LOCAL_PASS_FAST_TRACK` — local gates pass; Production untouched.

## Baseline

- Branch: `feature/p3-w07a-catalog-bootstrap-fast-track`
- Worktree: `C:\CodeApp\BI-p3-w07a-catalog-bootstrap` (isolated from `C:\CodeApp\BI`)
- `origin/main`: `c4f3843686aaeb1c84a9790af5c8864394e84d92`
- Migration ledger: **41 applied / 0 pending / 0 mismatch** (#41 = W07A)

## Schema delta (migration #41 — minimal)

| Object | Change |
|---|---|
| `public.vendors` | new flat text catalog (mirrors `direct_entry_projects`) |
| `recruiters.personnel_code` | nullable unique normalized (NFC + trim + collapse + lowercase) |
| `recruiters.personnel_position` | nullable, `STAFF` \| `TEAM_LEADER` |
| `recruiter_provider_memberships.vendor_id` | nullable FK to `vendors` |
| `direct_entry_input_catalog` | HRP `label = Họ và tên · personnel_code · Team`; Vendor `label = vendor display name`; Projects unchanged |

Bytes #1–#40 untouched. `recruiter_id` (UUID) remains the canonical stored value.

## Direct Entry dropdown regression fix

`SelectCellEditor` commits on every dropdown branch: `onChange` → `commit(value)` → `onRowChange(row, true)`; `onBlur` → `commitBlur` → `props.onClose(true, false)`. Removed fragile `option.label === row.cells.recruiter_id` fallback. Lookup-by-id only. Covers `gender`, `provider_type`, `recruiter_id`, `project_id`, `labor_type`, `initial_status`. Business contract unchanged.

## Operator importer (`scripts/p3-w07a-catalog-bootstrap.mjs`)

- `--dry-run` default. `--apply` requires `P3_W07A_CATALOG_APPLY` token + idempotency key (12–128 chars).
- Reuses `exceljs`, `pg`, `loadSupabaseConfig`, `buildSslOptions`.
- Single Postgres transaction; any error rolls back the whole batch.
- Idempotent re-import; ambiguous workbook duplicate fails BEFORE any write.
- Records absent from the workbook are NOT deactivated (lifecycle = W07B/P3.1).
- Logs sanitized: sheet names, byte count, fingerprint prefix, counts, idempotency-key prefix. No display names, vendor names, UUIDs, `personnel_code`.

## Evidence (local)

| Gate | Result |
|---|---|
| `pnpm test` | pass |
| `pnpm exec next typegen` + `pnpm typecheck` | pass |
| `pnpm lint` | 0 errors (6 pre-existing warnings) |
| `pnpm docs:check` | pass |
| `pnpm secrets:check` | pass |
| `pnpm test:p1.6-i04c2b` | 16/16 |
| `pnpm test:p1.6-w04-s03cd` | 16/16 |
| `pnpm test:p1.6-i04c3-r3a` | 100/100 |
| `direct-entry-spreadsheet-dropdown-regression.test.mjs` | 17/17 |
| `p3-w07a-catalog-bootstrap.test.mjs` | 9/9 |
| `git diff --check` | clean |

## Blockers / deferred

- Team dashboard, leader assignment, Catalog Admin UI → W07B/P3.1.
- Vendor / project rules beyond W07A prompt → deferred.
- Production migration #41 apply + real workbook import → not done.

## Stop point

`P3-W07A_CATALOG_BOOTSTRAP_LOCAL_PASS_FAST_TRACK`. No P3 PASS claimed. Production untouched. No `git push`.