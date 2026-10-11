# P3-W07A-R01 — catalog/schema reuse review (read-only)

| Attribute | Value |
|---|---|
| Status | `P3-W07A-R01_CATALOG_SCHEMA_REUSE_REVIEW_READ_ONLY` |
| Branch / SHA | `main @ 4b9331321d9a6c5b9c71c6d562a710087175e1ec`; Production base `origin/main @ c4f3843` |
| Survey | `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md` (mandatory preflight, locked T0 decisions applied) |
| Policy matrix | `audit/p3-c01-rbac-policy-matrix @ 9520962` (21 capabilities) |
| Migration ledger | 40 applied / 0 pending / 0 mismatch at `c4f3843`; no migration #41 on `main` yet |
| DOC_BUDGET | `DELTA_ONLY` |

## Reuse map (no new code path needed)

| Need | Reuse | Note |
|---|---|---|
| Project catalog | `direct_entry_projects` (P1.6 foundation) | text + active flag; no manager/HRP/Vendor/team field — matches locked "flat text list" |
| HRP/Vendor/team person | `recruiters` + `recruiter_provider_memberships` + `recruiter_team_memberships` (P1.6 foundation) | effective-dated; already used by `direct_entry_input_catalog` and `direct_entry_catalog_bootstrap_*` |
| Teams | `teams` (P1.6 foundation) | unique `code`; placeholder `unassigned` (`Chưa phân nhóm`) reserved for Vendor/legacy |
| HRP team binding | `recruiter_team_memberships` (P1.6 foundation) | already enforced 1 active team at effective-date by `direct_entry_input_catalog` (HRP path filters `membership_count = 1`) |
| Vendor no-team | Existing `provider_type='vendor'` filter in `direct_entry_input_catalog` already excludes `team_memberships` from eligibility; `teams.unassigned` covers legacy rows |
| Reporting alias | `recruiter_aliases` (P1.6 foundation) | `reporting_key` unique per `(recruiter_id, valid_from)` |
| Catalog projection RPC | `direct_entry_input_catalog(auth_subject, app_user_id, effective_date)` | already returns `projects`, `recruiters` (HRP only), `provider_type`, `team_id`, `team_display_name`; secure-definer, force-RLS |
| Idempotent import ledger | `direct_entry_catalog_bootstrap_runs` + `direct_entry_apply_catalog_bootstrap` (migration #35, i04c2b) | `source_fingerprint` + `idempotency_key`; one ledger row per `(app_user_id, idempotency_key)`; replay = `ALREADY_APPLIED`; non-empty target = `23505`; service_role DML denied |
| Audit | `direct_entry_audit_events` (P1.6 foundation) | `catalog_bootstrap` event already emits a sanitized row |
| Actor resolution | `direct_entry_app_users` + `direct_entry_capability_grants` (admin=entry_admin ∧ recruiter_master_manage ∧ team_master_manage) | locked admin bundle, exact 3 capabilities required by `direct_entry_catalog_bootstrap_plan` |
| TLS/Supabase config | `scripts/lib/load-supabase-config.mjs` (`loadSupabaseConfig`), `scripts/lib/supabase-tls.mjs` (`buildSslOptions`) | already used by `apply-migrations.mjs` and the i04c2b operator script |
| Excel parsing | `exceljs 4.4.0` (already in `dependencies`); pattern modeled on `src/lib/direct-entry/worker-profile-xlsx.ts` and `excel-paste-import.ts` | no new package |
| DB client | `pg ^8.23.1` (devDependency, runtime reuse pattern from i04c2b operator script) | no new package |

## Minimum schema delta (proposed; not applied in this review)

| Column | Target | Why | Risk |
|---|---|---|---|
| `recruiters.personnel_code text` | `public.recruiters` | HRP dropdown label and unique business ID per survey ("`vinht.td`") | requires unique index + normalized (`lower(btrim(...))`) partial unique; backfill plan needed if catalog already populated |
| `recruiters.position text` check in (`STAFF`,`TEAM_LEADER`) | `public.recruiters` | locked "STAFF / TEAM_LEADER" enum; team leader still represented as a login-backed `direct_entry_app_users` row, not free text | backfill default `STAFF` for existing rows; verify no i04c2b bootstrap path depends on column absence |
| (none) | `direct_entry_projects` | survey locks project as "flat text list"; no HRP/Vendor/team column | confirms task does not overload projects |
| (none) | `teams` | already has `code`+`display_name`+`active`; HRP team is mapped via membership, not new column | reuse confirmed |
| (none) | `recruiter_team_memberships` | already 1-HRP-team at effective date; Vendor path already bypasses via `direct_entry_input_catalog` | reuse confirmed |

No Vendor-team/leader column is required: the locked decision is "Vendor has no business team, leader, project or other catalog restriction". The existing `direct_entry_input_catalog` HRP filter (`team_membership_count = 1`) is the natural enforcement point. Team-leader identity stays in `direct_entry_app_users` ∩ `direct_entry_app_user_recruiter_links` (P1.6 foundation), not in catalog.

## Risk register

| Risk | Detail | Mitigation |
|---|---|---|
| Migration #41 conflict | No migration #41 exists on `main`; T1A may add a parallel `recruiters` extension. Per survey, "W07A has one implementation owner end-to-end". | Do not start W07A code until T1A surface is locked or T0 arbitrates. |
| Idempotency vs existing bootstrap ledger | i04c2b ledger `direct_entry_catalog_bootstrap_runs` is keyed on `(app_user_id, idempotency_key)` and is APPLY-on-empty-only. The W07A XLSX importer is a *superset* path and may need a sibling `direct_entry_catalog_workbook_runs` ledger row with its own idempotency key, not a reuse of the source-derived ledger. | Decide before implementation: extend i04c2b plan RPC to read XLSX, or add parallel XLSX-only RPC. Survey says reuse — prefer the former. |
| `personnel_code` uniqueness on existing data | Existing `recruiters` rows in Production (10) may not have a `personnel_code`. A `NOT NULL` column without a backfill fails apply. | Migration #41 must add the column NULLABLE, backfill, then add the unique index. |
| `position` enum for Vendor | Vendor provider type must not carry a `position`. The enum is a column on `recruiters`, not on `provider_memberships`, so Vendor rows are unaffected as long as `position` is set independently. | Document: `position` is per-person; Vendor is per-period. No migration conflict. |
| Service-role table DML drift | The i04c2b migration enforces that no `service_role`/API role has DML on catalog tables. A W07A importer that adds direct `INSERT` into `recruiters` would violate the same contract. | W07A importer must go through a `SECURITY DEFINER` RPC, like `direct_entry_apply_catalog_bootstrap`. The XLSX variant is a sibling RPC, not raw DML. |
| RLS / no-delete-on-absent | Survey: "must never delete/deactivate records merely because they are absent from the workbook". Existing i04c2b apply already runs only when target is empty; W07A must explicitly support partial-merge mode for re-imports. | Plan: introduce `mode` (`APPLY` empty / `MERGE` non-empty) and prove absence-of-row in workbook leaves rows untouched via tests. |
| Ambiguous HRP→team | A workbook row with no `team` for an HRP is ambiguous. The existing `direct_entry_input_catalog` already filters HRP candidates to one active team. | W07A importer should fail closed on missing/duplicate `team` for HRP rows and emit sanitized row numbers. |
| Vendor implicit team | A Vendor recruiter with a leftover `recruiter_team_memberships` row would still be excluded by `direct_entry_input_catalog` (HRP-only). W07A must not create Vendor `recruiter_team_memberships` rows. | Importer rules: Vendor sheets never write team memberships; HRP sheets must write exactly one. |

## T1A must-haves before W07A code starts

1. Lock the `position` enum spelling (`STAFF` / `TEAM_LEADER`) in a T0 note; UI label "Trưởng nhóm" maps to `TEAM_LEADER`.
2. Confirm `personnel_code` is **case-insensitive unique** and **not the Supabase `auth_subject`**.
3. Lock the exact-key projection shape: dropdown label = `Họ và tên · personnel_code · team`, stored selection = `recruiter_id`. (Already implied by survey.)
4. Confirm the W07A importer is a sibling `SECURITY DEFINER` RPC reusing the i04c2b role/ledger pattern, not raw service-role DML.
5. Confirm "leader assignment" is deferred to `P3-W07B_ACCESS_ADMIN` and not a W07A deliverable.
6. Confirm team dashboard and leader-specific UX are deferred and do not block BoD go-live (survey-locked).

## Conclusion

- **No blocker for reuse review.** Every needed table, projection, helper and admin bundle is already in `main`; the only schema delta is two new columns on `recruiters` (`personnel_code`, `position`), both nullable-then-backfilled-then-unique.
- **Coordination risk is the only soft blocker.** T1A's surface (i04c3-r3a worker profile xlsx, i04c2b bootstrap) already lives in the same `recruiters` table. Per the survey, W07A is single-owner; the W07A prompt must explicitly forbid touching i04c2b ledger/RPC, and T1A's R2/R3 work must not consume `personnel_code`/`position`. A short T0 arbitration note is sufficient.
- **No new dependency, no new admin API, no new navigation, no new CRUD framework** is needed. `DOC_BUDGET=DELTA_ONLY` is sufficient.
- This review does not declare W07A or P3 ready. Implementation, gating and PASS are owned by the W07A implementation lane.
