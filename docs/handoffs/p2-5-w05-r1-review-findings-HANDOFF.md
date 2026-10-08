# P2.5-W05-R1 - Review findings closed (handoff)

Status: `P2.5-W05-R1_LOCAL_PASS_AWAITING_T0_REVIEW`. Base `feature/p2-5-w05-review-authority@f206639af031bb812d479ee12684a5f5d1c7af13` (origin/main still `17ec4b77`, unchanged). Plus one append-only commit; no amend/rebase/force-push, no edit of #53 or #55. Final SHA = branch tip (quoted in the report).

## Delta (migration #56 = `20261008160000_p2_5_w05_r1_review_capability_matrix.sql`)

- FINDING 1 - approval capability matrix is now the T0 lock, in BOTH layers (the per-request requirement list and the apply-side defense-in-depth inside `direct_entry_apply_change_item`): ENTRY_FIELD = `change_review`; ENTRY_FIELD with `worker_details` = + `pii_view`; PAYMENT = + `payment_view` (no `payment_edit`); WORK_STATUS = `change_review` only (no `employment_status.apply`); DOCUMENT unchanged and still closed to the W05 bundle (`document_view` + `document_upload`). The reviewer still needs an effective `all` scope grant, asserted by #55 before any mutation.
- No direct-write authority changed: `direct_entry_update_payment`, `direct_entry_apply_employment_status`, `correct_latest_status`, `privileged_edit` and the full-profile batch keep their own capabilities, and every W04 SUBMITTED guard stays closed.
- FINDING 2 - `direct_entry_w04_worker_details_allowed` now also applies the canonical validator the table check uses (`direct_entry_valid_worker_details`), so a partial, malformed or unknown-key `worker_details` is rejected 22023 inside the CREATE validation loop before the request, item, reason, idempotency or audit rows exist. The APPLY validator is unchanged and only strengthened.
- No new capability token, no new workflow/RBAC, no dependency; function inventory is unchanged at `{114, 58, 56}`.

## Tests

- `pnpm test:p2.5-w05` 7/7 (2 new): a reviewer holding exactly the W05 bundle (`change_review` + `pii_view` + `payment_view` + all scope) approves ENTRY_FIELD worker_details, PAYMENT and WORK_STATUS end to end, while an all-scope reviewer without `payment_view` and an all-scope reviewer without `pii_view` are denied, no-scope/no-capability are denied, every refusal leaves the request PENDING, and a DOCUMENT proposal is still refused by policy; plus the CREATE-time rejection of four unappliable `worker_details` shapes with zero residue (no request/item/reason/idempotency/audit) and one canonical proposal that is accepted and then applied.
- Updated for the lock: `p1.6-s04c-policy-closure-db.test.mjs` (PAYMENT denial now on missing `payment_view`; WORK_STATUS approved by the `change_review`-only actor; the successful PAYMENT decision is taken by the actor WITHOUT `payment_edit`), the non-canonical `p1.6-s04c-policy-closure-dev-acceptance.mjs` matrix, and the ledger rebaseline to 56 files.

## Gates

- `test:p2.5-w05` 7/7; `test:p2.5-w03` 22/22; `test:p2.5-w02` 23/23; `test:p2.5-w06a` 4/4; `pnpm test` 1572/1572 (0 fail); typegen+typecheck exit 0; lint 0 errors (12 pre-existing warnings); build exit 0; `git diff --check` clean; `db:migrate --offline` **56 valid**. Migrations #1-#55 byte-identical to `f206639`; #56 appended.

## Blockers / residue

- Production sequencing #50-#56 stays T0-owned: Production is still 49 applied, nothing was applied or deployed, and no account was granted the reviewer bundle (T0 must name the app_user_ids).
- W05 handoff wording on the reviewer bundle stays accurate, but the earlier line "a bundle-only reviewer cannot apply PAYMENT/WORK_STATUS items" is superseded by this lock: PAYMENT/WORK_STATUS are now reviewable with view capabilities only.
- Unchanged W04 residue (not touched here): a PAYMENT proposal with an out-of-enum `state` is still accepted at CREATE and fails only at APPLY (table CHECK), which leaves the same unappliable PENDING request class this R1 closes for `worker_details`.
