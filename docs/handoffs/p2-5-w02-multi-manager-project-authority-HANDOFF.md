# P2.5-W02 - Multi-manager project authority foundation (handoff)

Status: `P2.5-W02_MULTI_MANAGER_PROJECT_AUTHORITY_LOCAL_PASS_AWAITING_T0_REVIEW`
Base: `origin/main@60075b17a2b470f0dae6b7ee188822bc72e9578b` (P3-J01B_RELEASE_A_PASS)
Branch: `feature/p2-5-w02-multi-manager-project-authority` - worktree
`C:\CodeApp\BI-p2-5-w02-multi-manager`. No Production apply, no deploy, no main push.

## Schema before -> after

| | before (P3-W07B #43) | after (W02 #51) |
|---|---|---|
| identity | `project_id text PRIMARY KEY` | `assignment_id uuid PRIMARY KEY` |
| interval | none | `valid_from date NOT NULL DEFAULT authorization_date`, `valid_to date` (half-open) |
| actors | none | `created_by_user_id`, `revoked_by_user_id`, `revoked_at` |
| reason | none | `reason_id`, `revoke_reason_id` -> `direct_entry_restricted_reasons` |
| concurrency | none | `version` (OCC), `updated_at` maintained by trigger |
| single-manager lock | PK on project_id | `UNIQUE (project_id, manager_recruiter_id) WHERE valid_to IS NULL` + overlap guard trigger (23P01) |

Backfill: existing rows keep project/manager and become OPEN intervals starting at the migration
date; `created_by_user_id`/`reason_id` stay NULL because the historical author is genuinely
unknown (no invented history). Rows are never deleted: revocation closes `valid_to`.

## ACL / security posture

- Table: forced RLS, `revoke all` from public/anon/authenticated/service_role (unchanged).
- Helpers (SECURITY DEFINER, fixed `search_path`, revoked from every role):
  `direct_entry_project_assignment_effective` (new single predicate), redefined
  `direct_entry_actor_is_assigned_project_manager`, `direct_entry_actor_has_project_assignment`,
  `direct_entry_actor_can_access_project`, `direct_entry_assert_project_admin`,
  `direct_entry_resolve_change_request_scope`, plus two trigger functions.
- Only three RPCs are granted to service_role: list/assign/unassign project-manager assignments.
  Each requires actor mapping + `entry_admin` + effective `all` scope + reason + idempotency key +
  OCC, and writes a restricted reason plus one immutable audit event.
- Reuse: W07B's `direct_entry_actor_can_access_project` keeps its signature and callers (filtered
  catalog, full-profile batch guard); only the predicate changed. No second authorization framework.

## Migration ordering and the P3-W07E #50 safety analysis

- Ledger: #47 W04C, #48 W05A, #49 W07C-R7, #50 W07E, **#51 = this migration**. Production today:
  49 applied / 1 pending / 0 mismatch, and `direct_entry_resolve_change_request_scope` is absent.
- #50 redefines the two assignment helpers WITHOUT an interval predicate and tries the
  creator/team/`first_work_date` fallback before the assignment check. #51 applies after #50 and
  supersedes all three: interval-aware helpers + assignment-only propose resolver.
- Reachability on Production (read-only `scripts/p2-5-w02-w07e50-safety-check.mjs`): W07E #50 not
  applied, scope resolver absent, **55 enabled accounts hold an effective `change_request_create`
  grant, 17 SUBMITTED entries** => applying #50 WITHOUT #51 would make the fallback reachable.
- `scripts/apply-migrations.mjs` commits ONE transaction per file, so a plain `--apply` would create
  that window. Required (T0 decision, not executed here): apply #50 and #51 in ONE transaction
  (`psql --single-transaction -f 20261008100000_....sql -f 20261008110000_....sql`), or approve a
  grouped-apply mode. Until then #50 stays unapplied and Production is safe by absence.

## Tests

- `scripts/p2-5-w02-multi-manager-authority-db.test.mjs` (12 PGlite cases over the 51-migration
  ledger): two concurrent managers; cross-project denial; expired/future/revoked inert; unassign
  keeps history+audit; created_by audit-only; recruiter attribution is not authority; past/future
  `first_work_date` irrelevant; duplicate active pair blocked while other managers stay allowed;
  admin RPC capability/all-scope/reason/OCC/idempotency/audit; expand/backfill invents nothing;
  ACL/SECURITY DEFINER/search_path/reuse assertions; closed #50 creator/team/date propose fallback.
- Fixture impact of the closure: the shared change-request fixture assigns its proposer as project
  manager (`scripts/lib/s04c-read-fixture.mjs`, guarded for historical ledgers); the DOCUMENT
  scope-lock test accepts the policy-level refusal (42501) or the table constraint (23514).
- Inventory rebaselined to 51 in 14 places; function inventory
  `{ total: 98, service_role: 48, internal: 50, exposed_internal: 0 }`.

## Gates

- W02 suite 12/12; `pnpm test` 1449/1449 (0 fail); `db:migrate --offline` 51 valid; `--dry-run`
  49 applied / 2 pending (W07E #50 + W02 #51) / 0 mismatch; typegen+typecheck, lint, build,
  docs:check 6/6, secrets:check ĐẠT, `git diff --check` clean.

## Out of scope / remaining

- W03 worker directory, W04 proposer/protected-field rebaseline, W05 Accounting/BoD bundles, W06
  operations UI, project CRUD RPCs (this task delivered assignment list/assign/unassign only).
- No Production apply, no deploy, no main merge/push.
