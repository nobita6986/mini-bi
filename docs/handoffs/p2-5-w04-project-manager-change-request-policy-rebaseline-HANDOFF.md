# P2.5-W04-R1 — change-request policy rebaseline + T0 findings closed (#53)

Status: `P2.5-W04-R1_LOCAL_PASS_AWAITING_T0_REVIEW`. Base `origin/main@af72b43` (post W02 #51 + W03 #52 + W03-R1). Branch `feature/p2-5-w04-project-manager-change-request-policy`.

## Delta (migration #53 = 20261008130000_p2_5_w04_project_manager_change_request_policy.sql)

- Proposer audience assignment-only (current effective PM on a SUBMITTED entry); created_by / team / recruiter / first_work_date grant no propose authority.
- Protected ENTRY_FIELD: only `worker_details`; employee_code / project_id / first_work_date / recruiter_id / labor_type rejected 22023.
- FINDING 2: forged/changed `display_name` rejected 22023 at CREATE and APPLY (never silently reverted).
- Apply no longer re-derives recruiter/team/provider from `first_work_date` (W07C-R7).
- FINDING 1: direct mutation is DRAFT-only. `direct_entry_assert_not_review` now rejects non-DRAFT (covers `apply_employment_status`, `correct_latest_status`, `privileged_edit`), and `direct_entry_update_payment` rejects non-DRAFT. SUBMITTED direct mutation denied even for payment_edit / employment_status.apply / entry_admin / all scope. Approval engine is the only apply path.
- DOCUMENT/CCCD out of scope; reason / OCC / idempotency / no-self-review / immutable audit / all-or-nothing unchanged. No second workflow/RBAC.

## Reuse
Existing change-request engine, reason, OCC, idempotency, audit, capability registry; #50/#51 helpers (`actor_is_assigned_project_manager`, `resolve_change_request_scope`). No new dependency.

## Gates
`pnpm test` 0 fail; typegen + typecheck clean; lint 0 errors; build ok; `docs:check` 6/6; `secrets:check` ĐẠT; `git diff --check` clean; `db:migrate --offline` 53 valid. Production dry-run (read-only): 49 applied / 4 pending (#50/#51/#52/#53) / 0 mismatch.

## Deployment safety (#50 -> #51 -> #52 -> #53)
#50 alone re-adds the creator/team/first_work_date propose fallback (Production holds 55 change_request_create accounts + 17 SUBMITTED entries). Apply all four back-to-back in one maintenance window: disable the create/propose path, apply #50..#53 sequentially, run acceptance, reopen only after #53 + acceptance pass. Pre 49/3/0; post 53/0/0. The runner commits each file separately, so the window is bounded by the procedure, not one transaction.

## Migrations
#1-#52 byte-identical to `origin/main`; #53 appended. No Production apply, no deploy, no main merge.
