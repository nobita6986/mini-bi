# P2.5-W02 - Multi-manager project authority (handoff)

Status: `P2.5-W02-R1_LOCAL_PASS_AWAITING_T0_REVIEW`
Base: `origin/main@60075b17a2b470f0dae6b7ee188822bc72e9578b` (P3-J01B_RELEASE_A_PASS)
Branch: `feature/p2-5-w02-multi-manager-project-authority` - worktree
`C:\CodeApp\BI-p2-5-w02-multi-manager`. No Production apply, no deploy, no main push.
R1 continues on the same branch: W02 implementation `9ee168f`, R1 doc commit `25f2a01`,
R1 implementation in this commit. No amend, no rebase, no force-push.

## Finding 1 - real OCC (`direct_entry_projects.version`), anti-ABA

- `direct_entry_projects.version` ALREADY existed in the P1.6 foundation
  (`20261002170000_p1_6_direct_entry_foundation.sql` ~line 112:
  `version integer not null default 1 check (version >= 1)`). It was verified before
  editing, so R1 does NOT add the column; what was missing is that nothing ever
  maintained it. R1 makes it the single row-locked concurrency token.
- New append-only `direct_entry_project_revisions` + the audit link
  `direct_entry_audit_events.project_revision_id` (both in the schema table below).
  Nothing is backfilled: a project that predates W02 keeps an empty history, version 1.
- `direct_entry_lock_project(text, integer)` = `select ... for update` on the project
  row + fail-closed `40001`; `direct_entry_bump_project_version(...)` advances the
  version and appends the before/after project revision in the same transaction.
- RPC signature change (`p_expected_active_count` -> `p_expected_project_version`):
  - `direct_entry_assign_project_manager(uuid, uuid, text, uuid, date, integer, text, text)`
  - `direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, integer, text, text)`
    (tier 1 = project version, tier 2 = assignment version; both fail closed with `40001`).
  - `direct_entry_list_project_manager_assignments` now returns `project_version`,
    `project_active` and a per-assignment `project_version`.
- ABA is the reason: "A removed + B added" leaves the active count unchanged, so a
  request from the old snapshot passed the count check; the version cannot be fooled.

## Finding 2 - minimal project master RPCs (W02 scope, not the P3.1 generic admin)

- `direct_entry_list_projects_admin(uuid, uuid, boolean)`,
  `direct_entry_get_project_admin(uuid, uuid, text)`,
  `direct_entry_create_project(uuid, uuid, text, text, text, text)`,
  `direct_entry_update_project(uuid, uuid, text, integer, text, text, text)`,
  `direct_entry_set_project_active(uuid, uuid, text, boolean, integer, text, text)`.
  Each mutation: actor mapping + `entry_admin` + effective `all` scope + reason +
  idempotency key + expected project version, then version advance, before/after
  project revision and one immutable audit event (`project_create`,
  `project_update`, `project_set_active`).
- NO hard delete exists anywhere: no delete RPC, no table privilege for any role,
  and direct DML is stopped by the referencing worker rows and by the append-only
  revision history. Deactivation is the soft delete.
- Plan section 4.3 names `direct_entry_deactivate_project`; it is implemented as
  `direct_entry_set_project_active(..., p_active)` so activate and deactivate share
  one audited code path. A no-op edit/deactivate is refused with `22023` instead of
  writing a false revision.
- `direct_entry_projects` has no `created_at`/`updated_at` columns. The admin
  projection DERIVES `created_at`, `updated_at` and `revision_count` from the
  append-only revision history, so no legacy timestamp is invented (NULL until the
  first audited mutation).
- Deactivation does not revoke authority: it removes the project from the create-new
  catalog while existing assignments keep read access to history. Only `unassign`
  revokes authority, and only `unassign` closes the interval.

## Finding 3 - W07E #50 / #51 safety (unchanged rule, contradiction removed)

- Ledger: #47 W04C, #48 W05A, #49 W07C-R7, #50 W07E, **#51 = this migration**.
  Production stays at **49 applied**, and #50/#51 stay **PENDING**. #50 on main is
  not modified, and no custom migration-ledger runner is added in W02.
- Wording (unchanged): **"CREATE resolver fallback closed; audience/read/withdraw
  policy still pending W04."** #51 closes only the CREATE propose fallback
  (`direct_entry_resolve_change_request_scope`). `direct_entry_change_request_audience`
  (calls `direct_entry_assert_entry_access(..., created_by_user_id, team_id,
  first_work_date)`), the `project_scoped` submission-list branch, the submission
  read `created_by_user_id <> p_app_user_id` check and the withdraw path still carry
  creator/team/date semantics and belong to W04.
- The earlier proposal to run both files inside ONE psql transaction is INVALID and
  withdrawn: each file carries its own `BEGIN`/`COMMIT`, so the inner `COMMIT` ends
  the outer transaction and the pair is not atomic. That withdrawn sentence was still
  present in the previous handoff *after* the correction in the same file; it is
  removed here, and `scripts/p2-5-w02-r1-project-authority-occ-db.test.mjs` now fails
  if the string reappears in the handoff, the safety-check script or the apply script.
- `scripts/apply-migrations.mjs` commits ONE transaction PER FILE, so a plain apply
  would expose the #50 window. Deployment rule (T0): keep Production at 49 applied;
  #50 and #51 stay pending until W04 produces the final policy AND an operator
  procedure is proven not to create an intermediate insecure state. A grouped apply
  is acceptable only with a test proving: no inner COMMIT breaks the transaction, the
  #50/#51 ledger rows are written atomically, and rollback restores both schema and
  ledger.
- Read-only Production reachability (counts/booleans only,
  `scripts/p2-5-w02-w07e50-safety-check.mjs`): #50 not applied, scope resolver absent,
  55 enabled accounts hold an effective `change_request_create` grant, 17 SUBMITTED
  entries => applying #50 WITHOUT #51 would make the fallback reachable.

## Schema before -> after

| | before (P3-W07B #43) | after (W02-R1 #51) |
|---|---|---|
| assignment identity | `project_id text PRIMARY KEY` | `assignment_id uuid PRIMARY KEY` |
| assignment interval | none | `valid_from` / `valid_to` (half-open) |
| assignment actors/reason | none | `created_by_user_id`, `revoked_by_user_id`, `revoked_at`, `reason_id`, `revoke_reason_id` |
| assignment concurrency | none | `version` + `UNIQUE (project_id, manager_recruiter_id) WHERE valid_to IS NULL` + overlap guard (23P01) |
| project master | `project_id`, `display_name`, `active`, `version` (version unused) | same columns, `version` now maintained by every project AND assignment mutation |
| project history | none | `direct_entry_project_revisions` (append-only before/after + actor + reason + version) |
| audit link | revision/submission/change-request ids only | + `direct_entry_audit_events.project_revision_id` |

Backfill: existing assignment rows keep their pair and become OPEN intervals from the
migration date with NULL actor/reason (no invented history). Rows are never deleted.

## ACL / security posture

- Both tables: forced RLS, `revoke all` from public/anon/authenticated/service_role.
- Internal helpers (SECURITY DEFINER, fixed `search_path`, revoked from every role):
  the four interval/authority helpers, `direct_entry_assert_project_admin`, the closed
  propose resolver, the four new project helpers, plus the two trigger functions.
- Eight RPCs are granted to `service_role` and nothing else: list/assign/unassign
  assignments + list/get/create/update/set-active project master.
- Reuse unchanged: W07B's `direct_entry_actor_can_access_project` keeps its signature
  and callers (filtered catalog, full-profile batch guard); no second authorization
  framework, no generic catalog admin, no new dependency.

## Tests

- `scripts/p2-5-w02-multi-manager-authority-db.test.mjs` - 12/12 (updated to the new
  signatures; OCC case now asserts the project version, and the list projection is
  asserted to hand back the token the caller must return).
- `scripts/p2-5-w02-r1-project-authority-occ-db.test.mjs` - 10/10: project
  create/update/deactivate; no hard delete (inactive and worker-referenced); ABA with
  an unchanged active count; every assignment mutation bumping the project version and
  appending a revision; stale project AND stale assignment version with zero residue
  (no audit/revision/reason/assignment/version change); reason + idempotency + audit +
  revision completeness (replay = same result, no extra rows; same key + other payload
  = `22023`); inactive project refuses a new assignment and leaves the catalog while
  keeping history; ACL/SECURITY DEFINER/search_path for every new function and the
  locked-down revision table; and the #50/#51 non-atomicity guard.
- Inventory rebaselined: `{ total: 107, service_role: 53, internal: 54,
  exposed_internal: 0 }` in `scripts/p1.6-i04c3-s01-db.test.mjs` and `[107, 53, 54]`
  in `scripts/p1.6-s04c-document-scope-lock-db.test.mjs`. Migration count stays 51 with
  #51 last (`scripts/p2-w04a-reconcile-verify.test.mjs`).

## Gates

- W02 suite `node --test scripts/p2-5-w02-*.test.mjs` 12/12 + 10/10 (22 pass, 0 fail);
  canonical `pnpm test` 1449/1449 over 68 suite runs, 0 fail (the W02/R1 DB suites are the
  lane gates defined for W02 and are not registered in the canonical script).
- `pnpm exec next typegen && pnpm typecheck` exit 0; `pnpm lint` exit 0 (0 errors, 12
  pre-existing warnings); `pnpm build` exit 0 (compiled successfully).
- `pnpm docs:check` 6/6 ví dụ JSON; `pnpm secrets:check` ĐẠT (1283 files);
  `git diff --check` clean.
- `pnpm db:migrate --offline` => 51 valid, no database access;
  `pnpm db:migrate --dry-run` => **49 applied / 2 pending (#50 + #51) / 0 mismatch**.

## Still open / known residue

- W04 must rebaseline the #50 audience/read/withdraw policy (protected-field allowlist
  + assignment re-check on apply) before #50/#51 can be deployed.
- `scripts/p3-w07a-catalog-bootstrap.mjs` (W07A seed lane) still upserts projects with
  direct DML and bumps `version` without appending a revision. That predates W02 and is
  outside this contract; the RPC path can never do it. A grouped/operator apply in W04
  should close it if T0 wants the invariant to hold for every writer.
- Out of scope / remaining: W03 worker directory, W04 proposer rebaseline, W05
  Accounting/BoD bundles, W06 operations UI (which consumes these RPCs). No Production
  apply, no deploy, no main merge/push.
