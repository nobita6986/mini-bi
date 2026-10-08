# P2.5 reviewer detail + accounting project admin hotfix

Status: `P2.5_REVIEWER_ACCOUNTING_HOTFIX_LOCAL_PASS_BLOCKED_ON_DB_DELTA`. Base `origin/main@6cbea9c68191addffb43459e8f3ac07cb16cb2fa`. Branch `feature/p2-5-reviewer-accounting-project-hotfix`. **No migration** (ledger stays 56), no Production mutation, no deploy, no main push.

## FINDING 1 - reviewer cannot open request detail

Root cause (proven, `scripts/p2-5-reviewer-hotfix-db.test.mjs`): the reviewer bundle reads the change-request detail and CAN decide a WORK_STATUS request with `change_review` alone, but the drawer also reads `GET /api/direct-entry/entries/[entryId]` for the BEFORE values, and `direct_entry_read_projection` is gated by draft scope (`entry_own|entry_team|entry_admin`) or an effective PM assignment. `change_review + all` has neither, so the read raises `entry scope/capability denied` (42501), the component skips the entry, the view model returns `unsupported`, and the drawer showed one vague message. The test also shows `entry_admin + all` is what unlocks the read today.

Fixed without a DB delta (error taxonomy): `reviewerUnsupportedMessage(reason)` now reports the accurate cause per reason (`ENTRY_DENIED`, `ENTRY_UNAVAILABLE`, `ENTRY`, `STATUS`, `WORKER`, `PAYMENT`, `CATALOG`, `PROPOSAL`, `TARGET_KIND`, `NOT_DECIDABLE`, `STATE`), and the component classifies the entry read (403/404 vs 5xx vs malformed) instead of collapsing everything into "cần phiên bản giao diện hoặc quyền xem khác".

**BLOCKER (needs T0):** the actual fix is a backend READ-authority delta so the reviewer audience can read the SUBMITTED entry projection (or an equivalent reviewer-scoped read). That is a migration, and slot #57 is reserved for initial-status ON, so it was NOT created. No table read, client authority or parallel endpoint was substituted.

## FINDING 2 - accounting project admin

Audit result: all 7 W02 project RPCs call `direct_entry_assert_project_admin` = `entry_admin + effective all scope`; the nav/page predicates and the manager-candidate RPC use the same rule. `entry_admin + all` is therefore sufficient — no UI/RPC change was made.

Added `scripts/p2-5-accounting-project-admin-provision.mjs`: idempotent operator provisioning that grants only `entry_admin` (reviewer bundle must already be complete, else `REVIEWER_BUNDLE_INCOMPLETE`), requires effective `all` scope, requires `--email`, `--actor` and `--reason` on `--apply`, checks `P2_5_ACCOUNTING_CONFIRM` **before** loading config/connecting, writes `direct_entry_audit_events` in the same transaction, defaults to read-only `--check`, and hardcodes no account. It never grants `payment_edit`, `employment_status.apply`, `entry_privileged_edit`, `document_view`, `document_upload` or `pii_export`.

**T1A did not run `--apply`.** T0 applies for `ngattt` after review; `lienvu` keeps the reviewer bundle only.

## Gates

`test:p2.5-reviewer-hotfix` 13/13 · `test:p2.5-w03` 22/22 · `test:p2.5-w05` 7/7 · `test:p2.5-w06` 44/44 · `test:p2.5-w06a` 4/4 · `test:server` 209/209 · `test:app-nav-02a` 92/92 · typegen+typecheck 0 · lint 0 errors (13 warnings) · build 0 · `db:migrate --offline` 56 valid · `git diff --check` clean.

## Capability / scope matrix (after hotfix)

| Account | reviewer bundle | entry_admin | all scope | Worker ops | Review queue | Project Operations |
| --- | --- | --- | --- | --- | --- | --- |
| lienvu (BoD) | yes | no | yes | yes | yes | **no** |
| ngattt (Kế toán) after T0 apply | yes | yes | yes | yes | yes | **yes** |
| all scope, no capability | no | no | yes | deny | deny | deny |
