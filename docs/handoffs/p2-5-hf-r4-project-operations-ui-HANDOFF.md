# P2.5-HF-R4 — Project Operations UI hotfix

Status: `LOCAL_PASS`. Base `origin/main@66fbee3de51187f6c2b19183296fbb57d2aa12d5`.
Branch: `codex/p2-5-hf-r4-project-operations-ui`. No Production apply/deploy or main push.

## Delta

- Project detail remains backed by W02 assignment history; UI explicitly labels current, future, ended, and revoked states.
- Manager selection stays on the verified-candidate API, now supports listbox keyboard controls and accessible loading/error feedback.
- Create, rename, activate/deactivate, assign, and revoke retain existing reason/OCC requests; a 409 locks writes until authoritative detail/list reload succeeds.
- Dialogs use mobile safe-area sizing, focused fields, sticky actions, bounded inputs, and accessible errors. Project search/status filters now have client pagination.
- Confirmed `direct_entry_list_projects_admin` aggregates all projects without `LIMIT`/`OFFSET`; regression covers the SQL shape and a 150-row repository result.

## Verification

- `pnpm test:p2.5-w06a`: 4/4; `pnpm test:server`: 214/214; `pnpm test:app-nav-02a`: 92/92.
- `pnpm test`, `pnpm build`, post-build `pnpm typecheck`, and `git diff --check`: pass.
- `pnpm test:p2.5-hf-r4-browser`: 47/47 synthetic-fetch Chrome interactions pass against the production component.
- `pnpm lint`: pass with 12 pre-existing warnings, 0 errors.
- `pnpm db:migrate --offline`: 61 migrations valid; no database access.

## Contract note

- Assignment history returns `manager_recruiter_id`; candidates return names only for active verified managers and are bounded to 100. History for an ineligible/unlisted manager uses an abbreviated ID. A name lookup needs an authorized read-projection change, outside this UI-only scope.
