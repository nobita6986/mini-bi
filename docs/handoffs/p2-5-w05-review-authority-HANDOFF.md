# P2.5-W05 - Review authority backend (handoff)

Status: `P2.5-W05_LOCAL_PASS_AWAITING_T0_REVIEW`. Base `origin/main@17ec4b770776b78ef68f73bc59430e0c78192659` (W02 #51 + W03 #52 + W04 #53 + W06A #54). Branch `feature/p2-5-w05-review-authority`, worktree `C:\CodeApp\BI-p2-5-w05-review-authority`; final SHA = branch tip (quoted in the report). No Production apply, no deploy, no main merge.

## Delta (migration #55 = `20261008150000_p2_5_w05_review_authority.sql`)

- Review authority is capability `change_review` AND an effective `all` scope grant, for BOTH visibility (`direct_entry_change_request_audience`) and the decision path (`direct_entry_assert_change_request_capabilities`, evaluated before idempotency and before any mutation, so a denied review leaves no state). This replaces the C01-R2 own/team/all match: a team/own scope, a role, an email, a reporting audience and `created_by` never make an actor a reviewer.
- Read-only Production evidence: exactly 1 enabled account holds an effective `change_review` grant, and it already holds an effective `all` scope grant, so the lock removes no existing reviewer.
- The reviewer bundle is DECLARED and granted to nobody: `direct_entry_reviewer_bundle_capabilities()` = `{change_review, pii_view, payment_view}`. Asserted absent: `payment_edit`, `employment_status.apply`, `document_view`, `document_upload`, `entry_privileged_edit`, `pii_export`. No app_user row is created or granted here; Accounting/BoD seeding still needs T0-designated app_user_ids. A bundle-only reviewer can therefore review PII/payment proposals but cannot apply PAYMENT/WORK_STATUS/DOCUMENT items, which still require their own per-target capability.
- W03 directory: `allowed_actions.propose_change` now serves the W04 server authority (effective PM assignment on the SUBMITTED row) instead of `PROPOSE_PENDING_W04_POLICY`; when false the code is `NOT_PROJECT_MANAGER`. Migration #52 is not modified: the exact fragment is patched with the fail-closed matcher P2.5-W04 used, then the matcher is dropped.
- One new internal helper `direct_entry_has_scope(uuid,text)` (boolean twin of `direct_entry_has_capability`). No new capability token, no second workflow/RBAC, no new dependency.

## Tests

- `pnpm test:p2.5-w05` 5/5 (new, wired into canonical `pnpm test`): decision matrix (all-scope allow; team scope, own scope, no scope and all-scope-without-capability deny with zero residue and the request still PENDING); visibility matrix (team scope sees nothing incl. detail, all scope sees 6/6, proposer leg unchanged); direct-mutation audit on SUBMITTED by an actor holding `payment_edit` + `employment_status.apply` + `entry_privileged_edit` + `entry_admin@all` - update_payment, apply_employment_status, correct_latest_status, privileged_edit, transition_submission and create/update/delete_draft_row all denied with values/version/audit/revision unchanged, DRAFT edit still allowed, approval engine applies exactly once; bundle contents and ACL; directory propose_change.
- Updated for the lock: `p1.6-s04c-change-request-read-db.test.mjs` (team-scoped reviewer no longer sees queue or detail), `p2-5-w03-worker-directory-db.test.mjs` (propose_change), and the two non-canonical P1.6 acceptance scripts. Ledger rebaselined to 55 files; derived function inventory now `{114, 58, 56}` / `[114, 58, 56]`.

## Gates

- `test:p2.5-w05` 5/5; `test:p2.5-w02` 23/23; `test:p2.5-w03` 22/22; `test:p2.5-w06a` 4/4; `pnpm test` 1570/1570 (0 fail); typegen+typecheck exit 0; lint 0 errors (12 pre-existing warnings); build exit 0; `docs:check` 6/6; `secrets:check` ĐẠT; `git diff --check` clean; `db:migrate --offline` **55 valid**.

## Contract wording drift (flagged, policy NOT changed)

- `docs/P2.5.md` section 3 ("Kế toán ... Sửa trực tiếp", "direct correction") and section 5 W05 still describe a privileged direct-edit path as if Accounting could write canonical SUBMITTED data. The locked contract is: PM proposes, reviewer approves/rejects, canonical SUBMITTED changes ONLY through the approval engine, and privileged edit is DRAFT-only (W04 #53). W05 did not change that policy; T0 should correct the P2.5 wording.
- The W03-R1 handoff sentence about `PROPOSE_PENDING_W04_POLICY` is superseded by #55; that handoff is left as the historical lane record.

## Blockers / residue

- Production sequencing #50-#55 stays T0-owned: Production is still 49 applied, so #55 is pending and nothing was applied or deployed here.
- `scripts/p1.6-s04c-server-boundaries-dev-acceptance.mjs` aborts on its ledger-count assertion when run against a database that is not at the full ledger (it needs the DEV apply), so it is only meaningful after T0 applies #50-#55.
- W04 residue for the review lane: `direct_entry_create_change_request` still accepts an ENTRY_FIELD `worker_details` proposal that omits keys (the W04 allowlist checks membership, not completeness), but `direct_entries_worker_details_check` requires every key at apply time, so such a request can never be approved and stays PENDING. Closing it belongs to W04's validation; W05 did not touch it.
