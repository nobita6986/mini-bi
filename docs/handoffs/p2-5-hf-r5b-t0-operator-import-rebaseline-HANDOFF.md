# P2.5-HF-R5B-R4 - final importer closure (RED, not accepted)

Base 992bba35d08998781b41aaaaf5631b82259419c6 -> final (this commit); fast-forward only, no amend/rebase/force-push, no migration/dependency/RPC/capability/doc added. Local = remote, worktree clean.

## Before -> after (this round)
- Root cause 1 (partially addressed): executeImportPlan no longer runs the ambiguous join query; it now consumes the create projection (entry_ids, employee_codes, submission_id, version, replayed) with strict validation, and treats ONE create chunk as ONE submission; transitions are DRAFT->REVIEW (expected_version = create version) then REVIEW->SUBMITTED (expected_version = the version returned by REVIEW), each with its own deterministic key derived from batch + submission_id + target state. Two SUBMITTED rows in one chunk therefore transition once, not twice.
- postcheck now maps each entry to the submission that owns it (owner map from execution.submissions).
- Fixture follows the real lifecycle contract: uploaders stay real PMs (verified link + effective assignment, no entry_admin, no all scope) and gain submission_create plus exactly ONE effective own scope; a new negative fixture is a PM of the right project WITHOUT the own scope; a separate STATUS_ADMIN actor (employment_status.apply + entry_admin + all) now performs the canonical OFF step, so the uploader never holds employment_status.apply.
- New regressions added: two SUBMITTED rows -> one submission and exactly two transitions; DRAFT chunk never transitions; PM without own scope -> AUTHORITY_DENIED with zero residue (entries, reason and operator audit unchanged); status fixture uses its own actor.
- Batch audit insert now passes changed_fields as a text[] literal (array-parameter hazard).

## Still red - do not use this branch
- pnpm test:t0-import is 3/6. The DRAFT-only path (no transition at all) now fails with IMPORT_FAILED (unknown SQLSTATE), so the remaining fault is NOT the transition contract: it is inside the create projection / batch-audit sequence in runImport. Next step is to surface the raw SQLSTATE once (one diagnostic run) and fix that single call, then re-run.
- Because this round changed the execution plan, the earlier R3 evidence is superseded; the focused #57-#61 DB suites, lint, git diff --check and db:migrate --offline were NOT run in this round.
- test:t0-import remains wired into pnpm test, so the branch is RED.
- No Production import, no migration apply, no deploy, no main push.