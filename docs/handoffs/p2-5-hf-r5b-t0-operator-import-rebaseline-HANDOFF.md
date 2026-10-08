# P2.5-HF-R5B importer - operator import rebaseline (status: P2.5-HF-R5B_LOCAL_PASS_AWAITING_T0_REVIEW)

Branch feature/p2-5-hf-r5b-t0-operator-import-rebaseline. Base cbe0de8d54e3d93196e753002f0983b9559ced56 -> final (this commit). Fast-forward only; no amend/rebase/force-push; no migration, RPC, capability, dependency, framework or new document. Local = remote, worktree clean.

## Scope delivered
Manifest .csv/.xlsx with the canonical column set from import_data_byT0.md (per-row target_state, text-only CCCD/phone/bank so leading zeros survive), canonical CMT/CCCD rule reused from src/lib/contracts/national-id.ts, offline reason screening before any connection, confirmation token bound to the full SHA-256 of the source file and checked before config load.
Technical operator (--operator) needs entry_admin + effective all scope and exists ONLY in the batch audit; each uploader_login resolves to one enabled app user and runs the canonical v2 create, so created_by is the business uploader; project authority comes from an effective assignment via direct_entry_actor_can_access_project plus direct_entry_create_authority, with distinct safe codes for the two failures.
Deterministic keys: one per uploader+target_state chunk and one per transition (batch + submission_id + target state); one create chunk = one submission; DRAFT->REVIEW uses the create projection version and REVIEW->SUBMITTED uses the version returned by REVIEW; all create results are validated strictly and fail closed.
Batch advisory lock + exactly one restricted reason + exactly one immutable t0_worker_import audit (actor = operator, scope all, APPLIED, resource_ref = batch id, reason carries batch id + full fingerprint); replay of the same batch/source adds nothing, a different source under the same batch id fails BATCH_ID_REUSED_WITH_DIFFERENT_SOURCE before mutation; --check runs the same plan then rolls back; postcheck proves status ON with exactly one status event, metadata, created_by = uploader and operator audit count/reference.

## Evidence
- pnpm test:t0-import: 6 tests / 6 pass / 0 fail (exit 0).
- Focused #57-#61 DB suites: 24 tests / 24 pass / 0 fail.
- R5 fixes: postcheck owner-map now reads item.chunk.uploader.app_user_id; the postcheck-failure case uses a dedicated never-reused batch UUID; the residue assertion snapshots the entry count instead of hard-coding it; the missing "test:t0-import" script definition was added (the lane was wired but undefined, which is what made the canonical chain exit 1).
- Full pnpm test: TESTS=1707 PASS=1707 FAIL=0 EXIT=0
- typecheck, lint (0 errors), build, docs:check 6/6, secrets:check, git diff --check, db:migrate --offline = 61 valid.
- No Production import, no migration apply, no deploy, no main push.