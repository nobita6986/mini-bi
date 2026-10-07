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

T0 finding: before #53, direct payment/status writes on SUBMITTED are still open, so create/propose-only gating is insufficient. Reuse the existing full kill-switch `DIRECT_ENTRY_API_ENABLED` (returns 404 before session/repository) — it already gates EVERY Direct Entry API route, so it is a full write-maintenance switch covering all five mutation paths:
- create: `batches`, `batches/full-profile`, `drafts`;
- propose: `change-requests` POST;
- payment: `entries/[entryId]/payment`;
- employment status: `submissions/[submissionId]/transition`, `full-profile`, `entries/[entryId]`;
- privileged edit: `entries/[entryId]` PUT/PATCH; approve/reject/withdraw: `change-requests/[requestId]/decision` + `/withdraw`.

Evidence: every `src/app/api/direct-entry/**/route.ts` checks `process.env.DIRECT_ENTRY_API_ENABLED !== "true"` first (change-requests/route.ts:24, entries/[entryId]/route.ts:16, entries/[entryId]/payment/route.ts:15, submissions/[submissionId]/transition/route.ts:22, batches/full-profile/route.ts:12). Service-role RPCs are revoked from anon/authenticated, so the HTTP gate is the only reachable write surface.

Procedure: set `DIRECT_ENTRY_API_ENABLED=false` and redeploy → apply #50..#53 sequentially → read-only acceptance (assignment-only proposer, protected fields, direct mutation denied, approval applies once) → set `DIRECT_ENTRY_API_ENABLED=true` and redeploy. Pre 49/3/0; post 53/0/0. Runner commits per-file, so the gate bounds the window.

## Migrations
#1-#52 byte-identical to `origin/main`; #53 appended. No Production apply, no deploy, no main merge.
