# P2.5-HF-R5B-R2 - operator import completion (RED, not accepted)

Base 9379f67567766ae9544ee18506a0ca5ee3c961a7 -> final (this commit); branch feature/p2-5-hf-r5b-t0-operator-import-rebaseline; fast-forward, no amend/rebase/force-push, no migration, no new doc.

## Implemented this round (code)
- scripts/lib/t0-operator-import.mjs: manifest .csv/.xlsx (exceljs lazy import, text cells keep leading zeros), canonical column set per import_data_byT0.md, per-row target_state, canonical CMT/CCCD rejection (no silent normalization), reason screening (8..400, control chars, email, UUID, 9/12-digit like) before any connection, deterministicUuid per uploader+target_state chunk and per transition, uploader resolution (enabled app user) + reference resolution (project/recruiter by projection), canonical create-authority preflight, batch advisory lock + one restricted reason + one immutable t0_worker_import audit (actor = technical operator, scope all, APPLIED), fingerprint conflict -> BATCH_ID_REUSED_WITH_DIFFERENT_SOURCE, postcheck (status ON, single status event, metadata, created_by = uploader, operator audit count/reference).
- scripts/t0-import-workers.mjs: --check/--apply/--input/--batch-id/--operator/--reason/--confirm, token = PREFIX + full SHA-256 of the source file checked before config load, one outer transaction, check mode runs the same plan then rolls back.

## Test state (NOT green - no PASS claimed)
- scripts/t0-import-workers.test.mjs rewritten for CSV: 2/6 pass.
- Failing: (a) exact-key assertion is too strict - optional national_id_issued_at/place are absent when blank (keys are a subset of the canonical set, display_name never present); (b) AUTHORITY_DENIED from direct_entry_create_authority for a legacy-bundle uploader holding entry_create+submission_create with own+all scope - the canonical helper rejects that combination; the remaining two tests fail on the same preflight.

## Blockers for T0
- Need the exact ownership rule of direct_entry_create_authority for a legacy create actor (which scope-grant combination it accepts) before the uploader fixture can pass; then re-run and finish the red assertions.
- Until then: pnpm test:t0-import is RED on this branch and test:t0-import remains wired into pnpm test (from R1). Do not treat this branch as importable.
- No Production import, no migration apply, no deploy, no main merge. R1 evidence (8/8 on the old JSON manifest, #57-#61 DB suites 24/24, full pnpm test 1701/1701) is superseded by this round's payload change.