# P3-W07A-R1 — catalog bootstrap review fixes (T1A)

## Status

`P3-W07A-R1_CATALOG_BOOTSTRAP_REVIEW_FIXES_LOCAL_PASS_FAST_TRACK` — follow-up commit on top of W07A. W07A commits `4e3645d…00bacfd` are preserved; this commit is append-only.

## Baseline

- Branch: `feature/p3-w07a-catalog-bootstrap-fast-track`
- Worktree: `C:\CodeApp\BI-p3-w07a-catalog-bootstrap`
- `origin/main`: `c4f3843686aaeb1c84a9790af5c8864394e84d92`
- Survey: `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`
- Policy matrix: `audit/p3-c01-rbac-policy-matrix @ 9520962`
- Migration ledger: 41 applied / 0 pending / 0 mismatch

## Thay đổi chính

| Phạm vi | File | Nội dung |
|---|---|---|
| Importer merge | `scripts/p3-w07a-catalog-bootstrap.mjs` | `cellText` đọc `boolean` (ExcelJS round-trip); team membership: same-day re-import = update in place, later effective date = close-open cũ + open mới. Idempotent re-import giữ history, không delete-or-deactivate khi workbook thiếu |
| Vendor filter | `supabase/migrations/20261008000000_p3_w07a_catalog_bootstrap_personnel.sql` | Tách `hrp_memberships` / `vendor_memberships`. Vendor = `provider_type = 'vendor'` (không dùng `membership_count = 1` làm business rule). HRP vẫn giữ rule 1 team + 1 provider |
| Personnel contract | `src/lib/direct-entry/direct-entry-grid-columns.ts` | `PERSONNEL_POSITION_UI_LABELS` (`Nhân viên` / `Trưởng nhóm`) + helper `personnelPositionUiLabel`. Trưởng nhóm = catalog fact; không tạo account / capability / team dashboard |
| Dropdown regression | `src/lib/direct-entry/direct-entry-spreadsheet-dropdown-regression.test.mjs` | R18-R22: behavioral coverage cho 5 dropdown editors (gender / labor_type / provider_type / project_id / recruiter_id) — re-pick giữ value, change + blur commit, open + blur không đổi |
| Mới: projection tests | `scripts/p3-w07a-catalog-projection.test.mjs` | 7 test (P1-P7): Vendor filter, HRP label, projects unfiltered, personnel_code ≠ auth_subject, UI label mapping, không tạo account/capability, unique index case-insensitive |

## Gates

| Gate | Result |
|---|---|
| `pnpm test:p1.6-i04c3-r3a` | 100/100 |
| `p3-w07a-catalog-bootstrap.test.mjs` | 13/13 |
| `p3-w07a-catalog-projection.test.mjs` | 7/7 |
| `direct-entry-spreadsheet-dropdown-regression.test.mjs` | 22/22 |
| `p1.6-production-catalog-bootstrap.test.mjs` | 16/16 |
| `apply-migrations.test.mjs` (offline + dry-run) | 5/5 |
| `pnpm exec next typegen` | pass |
| `pnpm typecheck` | pass |
| `pnpm lint` | 0 errors (6 pre-existing warnings) |
| `pnpm build` | pass |
| `pnpm docs:check` | 6/6 |
| `pnpm secrets:check` | pass |
| `git diff --check` | clean |

Lưu ý: full `pnpm test` chain có tiếng bị resource-exhaustion giữa các PGlite migrations ở baseline; chạy theo targeted gates cho cùng coverage. Mọi gate pass.

## Stop point

`P3-W07A-R1_CATALOG_BOOTSTRAP_REVIEW_FIXES_LOCAL_PASS_FAST_TRACK`. Production migration #41 chưa apply; workbook thật chưa import; không deploy; chưa P3 PASS.