# P2.5-HF-R5B-R3 - canonical authority preflight + PM uploader fixture (partially green)

Base b3d193f377a28c12964af6d694e4274bf542985c -> final (this commit); fast-forward, no amend/rebase/force-push, no migration, no new doc, no dependency. Local = remote, worktree clean.

## Before -> after (this round)
- FIX 1 done: preflightAuthority now proves BOTH guards the real v2 wrapper uses - direct_entry_actor_can_access_project first, then direct_entry_create_authority - and returns distinct safe codes UPLOADER_PROJECT_ACCESS_DENIED / UPLOADER_CREATE_AUTHORITY_DENIED (CLI surfaces the distinct code; no raw message, no identity).
- FIX 2 done in the fixture: uploaders A/B are project managers (verified app-user/recruiter link + effective assignment on project A/B), lifecycle capabilities only and NO scope grant and no entry_admin, so the legacy path cannot authorise them; technical operator stays entry_admin + all. Negative fixtures: legacy-bundle actor with own scope but no assignment, PM with future assignment (own project), PM with expired assignment (valid_to + revoked_at seeded in one statement, own project). Each negative fixture lives on its own project because the canonical guard forbids overlapping intervals.
- FIX 3 done: worker_details assertion is a canonical-subset rule - every key must be in IMPORT_WORKER_DETAIL_KEYS, display_name is never inside, national_id/date_of_birth/address/phone always present, blank optional stays absent, a full optional row equals the allowlist exactly, and injecting display_name or an unknown key fails the regression (mutation check).
- Importer suite: 3/6 -> 4/6 (the uploader != operator / created_by = uploader / single reason + single operator audit test now passes, which is the core evidence for FINDINGS 2 and 3).

## Still red (no PASS claimed)
- check/apply/SUBMITTED test: IMPORT_FAILED (unexpected SQLSTATE) - the DRAFT->REVIEW->SUBMITTED transition path for a PM uploader without scope grants still fails; expected version/key handling or the required lifecycle capability needs one more pass.
- authority test: raw "capability denied" escapes from the canonical status RPC used to close the episode (the uploader actor lacks employment_status.apply); the fixture must either run that step as the technical operator or hold the lifecycle capability.
- pnpm test:t0-import is therefore RED on this branch and remains wired into pnpm test; do not use this branch to import data.
- Not run this round (blast radius limited by budget): focused #57-#61 DB suites, lint, git diff --check, db:migrate --offline - R2 evidence for those still holds.
- No Production import, no migration apply, no deploy, no main push.