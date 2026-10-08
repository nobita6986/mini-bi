# P2.5-HF-R5B-R1 - operator import completion (partial)

Branch feature/p2-5-hf-r5b-t0-operator-import-rebaseline, preflight HEAD local = remote = 6c9559d09a8efea366706290c899c9570f0ff5da, worktree clean, fast-forward follow-up only, no migration added.

## Green now
- scripts/t0-import-workers.test.mjs: 8/8 pass (was 3/8). Root cause of BATCH_INVALID was FINDING 1: display_name was inside worker_details; it is now only a top-level contract row field and worker_details carries the 7 canonical keys.
- FINDING 5 (partially): the expired-assignment fixture now seeds a validly closed assignment (valid_to + revoked_at in one statement); the canonical OFF -> rehire regression still uses the create/status RPC path (no direct INSERT of status events).
- Gates: pnpm test 1701 tests / 1701 pass / 0 fail; build, lint 0 errors, docs:check 6/6, secrets:check, git diff --check, db:migrate --offline = 61 valid. Relevant #57-#61 DB suites 24/24.
- test:t0-import script registered once and wired once into the canonical pnpm test chain.

## Not done (no PASS claimed)
- FINDING 2 uploader: manifest still uses a single "uploader" hint that is not resolved to a business account, rows are not grouped per uploader, created_by is not the business uploader, and there is no operator batch audit row.
- FINDING 3 audit: no restricted-reason/operator-batch-audit pair per batch beyond what the canonical create RPC already writes; reason PII screening is limited to length.
- FINDING 4 deterministic keys: one batch UUID is still used for the create RPC and both submission transitions; per-uploader chunk and per-transition deterministic keys are not derived from the ccbfaad helper.
- Acceptance extras not written: exact worker_details key assertion, uploader != operator, operator audit count = 1, multi-uploader/multi-submission key separation, same batch + different fingerprint conflict, mutation-check for the BATCH_INVALID regression.

## Evidence
- Uploader/operator mapping today: one --operator login (resolved server-side by auth email / app_user_id / auth_subject) drives the whole batch; the manifest "uploader" field is not used.
- Audit evidence today: only the canonical create audit per entry; no single immutable batch audit.
- Typecheck was re-run after build to avoid the LayoutProps false negative.
- No Production import, no migration apply, no deploy, no main merge.