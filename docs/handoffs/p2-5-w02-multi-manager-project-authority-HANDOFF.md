# P2.5-W02 - Multi-manager project authority (handoff)

Status: `P2.5-W02-R2_LOCAL_PASS_AWAITING_T0_REVIEW`. Base: `origin/main@60075b17a2b470f0dae6b7ee188822bc72e9578b`; R2 parent = R1 tip `6fbcdba4d18edf74005a6ca2f5cd406fda9b5b38`; final SHA = branch tip (`git log -1`, local = remote, quoted in the R2 report).
Branch `feature/p2-5-w02-multi-manager-project-authority`, worktree `C:\CodeApp\BI-p2-5-w02-multi-manager`; no Production apply, no deploy, no main merge/push, no amend/rebase/force-push.

## Delta (W02 -> R1 -> R2)

- W02 (#51): multi-manager assignment history with half-open intervals (revocation closes `valid_to`, never deletes), interval-aware authority helpers, assignment-only propose resolver, three assignment RPCs (list/assign/unassign) with actor mapping + `entry_admin` + `all` scope + reason + idempotency + immutable audit.
- R1: row-locked anti-ABA OCC on `direct_entry_projects.version` (a row count cannot see "A removed + B added"), append-only `direct_entry_project_revisions` + `direct_entry_audit_events.project_revision_id`, two-tier OCC on unassign, five project master RPCs (list/get/create/update/set-active; soft delete only, no hard delete anywhere); function inventory 107/53/54.
- R2-1: every revision (create/update/set-active/assign/unassign) stores a full PROJECT snapshot - `project_id`, `display_name`, `active`, `version` - in both before and after; the assignment delta moved to the `assignment_change` key and no longer replaces the snapshot. The #51 self-check predicate enforces that shape, and a new R2 regression re-runs it after real assign/unassign/update/deactivate calls.
- R2-2: `pnpm test:p2.5-w02` (23 tests) added and wired into canonical `pnpm test`.
- R2-3: `scripts/p3-w07a-catalog-bootstrap.mjs` `--apply` with project rows now fails closed (`PROJECT_BOOTSTRAP_RETIRED_USE_PROJECT_RPCS`) before any write once `public.direct_entry_project_revisions` exists; dry-run and a project-free apply are unaffected, and project master mutations must use the W02 project RPCs.

## Gates

- `pnpm test:p2.5-w02` 23/23; `pnpm test` 1472/1472, 0 fail; typegen+typecheck, lint, build, `docs:check` 6/6, `secrets:check` ĐẠT, `git diff --check` clean; W07A importer suite 14/14 (legacy apply path exercised on the pre-#51 ledger).
- `db:migrate --offline` 51 valid; Production read-only dry-run **49 applied / 2 pending (#50 + #51) / 0 mismatch**.

## Migration and Production status

- #50 (W07E) and #51 (W02) stay PENDING and unapplied; #50 on main is untouched; no new ledger runner. Wording: **CREATE resolver fallback already closed; audience/read/withdraw policy still pending W04.**
- Read-only Production evidence: #50 not applied, scope resolver absent, 55 accounts holding an effective `change_request_create` grant, 17 SUBMITTED entries, 66 assignment rows - so #50 without #51 would make the fallback reachable.

## Blocker

- W04 must finish the audience/read/withdraw policy and prove an apply procedure that creates no intermediate insecure state before #50/#51 ship.
