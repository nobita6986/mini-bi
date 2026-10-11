# P3-W07A-R01 — catalog/schema reuse review (read-only)

| Field | Value |
|---|---|
| Status | `P3-W07A-R01_CATALOG_SCHEMA_REUSE_REVIEW_READ_ONLY` |
| Mode | Read-only review; no source/migration/package/lockfile/docs/DB write |
| Branch | `main @ 4b9331321d9a6c5b9c71c6d562a710087175e1ec` |
| Base requested | `origin/main @ c4f3843686aaeb1c84a9790af5c8864394e84d92` (Production) |
| Local divergence | `main` is at `4b93313`; Production `origin/main` is at `c4f3843`. W07A not yet branched from Production. |
| Migration ledger | 40 applied / 0 pending / 0 mismatch (per survey, against `c4f3843`); no migration #41 exists locally yet |
| Survey read | `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md` (mandatory preflight) |
| Policy matrix | `audit/p3-c01-rbac-policy-matrix @ 9520962bda9863aa8ad6ea6933ab46c94926a972` |
| DOC_BUDGET | `DELTA_ONLY` (per survey for W07A) |

## Out of scope

- No source/migration/package/lockfile/docs edit.
- No DB write or XLSX/workbook/fixture creation.
- No `P3-W07A` / `P3` PASS or release claim.
- No assumption that T1A finished; this is a `main`-state read.

## Review checklist

1. Reused tables, projections, helpers for HRP/Vendor/team/HRP-personnel fields.
2. Minimum schema delta for `personnel_code`, `position`, HRP→team rule, Vendor team-leader gap.
3. RLS, grants, service-role boundary, idempotent import, duplicate/ambiguous detection, no-delete-on-absent.
4. Reuse confirmation for `exceljs`, `pg`, `loadSupabaseConfig`, `buildSslOptions`.
5. Business boundary: project is text-only; HRP must bind provider+team; Vendor no team/leader; team leader is login-backed; team dashboard deferred.
