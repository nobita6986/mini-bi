# P2.5-HF-R5B-R5 - importer defects closed (targeted green, canonical chain still failing)

Base cbe0de8d54e3d93196e753002f0983b9559ced56 -> final (this commit); fast-forward only, no amend/rebase/force-push; no migration, RPC, capability, dependency, framework or new document. Local = remote, worktree clean.

## Fixes applied (T0's three)
1. postcheckImport now reads the owner-map shape correctly: item.chunk.uploader.app_user_id (was item.uploader.app_user_id) - this was the IMPORT_FAILED / TypeError root cause.
2. The postcheck-failure case uses a brand new batch UUID (BATCH_C) that never appears elsewhere in the suite, so fingerprint/batch-reuse protection is untouched.
3. The residue assertion no longer hard-codes an entry count: it snapshots entriesBeforePostcheck and asserts the count is unchanged after POSTCHECK_FAILED.

## Evidence
- pnpm test:t0-import / node --test scripts/t0-import-workers.test.mjs: 6/6 PASS (0 fail).
- Kept regressions: same batch + same source replays without duplicating rows/submissions/reason/operator audit; same batch + different fingerprint -> BATCH_ID_REUSED_WITH_DIFFERENT_SOURCE before any mutation; check-mode rollback and apply commit; one submission per create chunk with exactly two transitions for SUBMITTED; uploader is created_by while the technical operator owns only the batch audit/reason; authority negative matrix (no assignment, future, expired, missing own scope) and OFF->rehire via the canonical status actor; postcheck rollback; no PII/UUID/email/CCCD/raw reason/raw DB message in output.
- Focused DB suites #57-#61: 24 tests / 24 pass / 0 fail.
- typecheck, lint (0 errors), build, docs:check 6/6, secrets:check, git diff --check, db:migrate --offline = 61 valid: all green.

## Blocker (why PASS is not claimed)
- Full pnpm test exits 1 while every reported test passes (446 tests / 446 pass / 0 fail), i.e. a lane in the canonical chain fails as a command, not as a test - the importer lane's pnpm script emits no test summary either. Next step: run the lane command once with unfiltered output to capture its stderr/exit path, then fix the script wiring (or the lane ordering) and re-run pnpm test.
- Until then test:t0-import stays wired in pnpm test and the branch is not fully green: do not import with it yet.
- No Production import, no migration apply, no deploy, no main push.