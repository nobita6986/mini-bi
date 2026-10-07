# P2.5-W04-R1 - Change-request policy closure (#53)

Status: `P2.5-W04-R1_LOCAL_PASS_DEPLOY_BLOCKED`. Base `origin/main@af72b43` (W03-R1, #50/#51/#52 present, no #53). Branch `feature/p2-5-w04-change-request-policy`. No Production apply, no deploy, no main push, no rebase/amend/force-push.

## Delta (migration #53 only; #1-#52 byte-identical)

`20261008130000_p2_5_w04_change_request_policy_closure.sql` closes the 4 policies via self-verifying source patches (same contract as the #50 helper, dropped after use):

- **P1 propose authority** — already closed by #51 (`direct_entry_resolve_change_request_scope` assignment-only); #53 re-affirms via self-check.
- **P2 protected fields** — ENTRY_FIELD change requests now allow ONLY `worker_details` at CREATE and APPLY (`project_id`, `employee_code`, `first_work_date`, `recruiter_id`, `labor_type` removed from the allowlist); a `worker_details` with a forged identity (invalid/empty `display_name`) is rejected at both CREATE and APPLY via `direct_entry_valid_worker_details`.
- **P3 direct-write denial** — `direct_entry_update_payment` and `direct_entry_apply_employment_status` are DRAFT-only: on SUBMITTED they raise 42501 before any write, leaving canonical value / version / audit untouched. SUBMITTED changes only via the approval engine.
- **P4 invariants** — reason/OCC/idempotency/no-self-review/immutable audit/all-or-nothing/DOCUMENT-CCCD limits unchanged.

No new table/capability/RPC; no EXECUTE for helpers; self-check fails the migration if the policy is not installed.

## Tests / gates

`test:p2.5-w04` 9/9 (PGlite over #1-#53): apply + ledger 53; uploader(non-PM) denied, PM allowed; protected fields + forged display_name rejected; direct payment/status on SUBMITTED denied without version/audit change; DRAFT no regression; approval applies exactly once. `test:p2.5-w02` 23, `test:p2.5-w03` 22 (ledger rebaselined 52→53). `db:migrate --offline` 53 valid; typegen+typecheck 0; lint 0 errors (12 warnings); build 0; `git diff --check` clean; #1-#52 byte-identical to main.

## Deployment limitation (blocker)

The Production apply procedure for #50–#53 is NOT proven here. Repo-side evidence (byte-identical #1-#52, offline 53 valid, self-checks, PGlite apply) is green, but the no-intermediate-insecure-state proof needs the Production read-only dry-run (49 applied / 4 pending) and a T0-approved runner. I did not propose a runner. W06A-R2 (manager selector) remains separate and is NOT closed by #53.
