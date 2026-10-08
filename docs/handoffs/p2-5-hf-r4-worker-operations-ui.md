# P2.5-HF-R4 — Worker Operations UI

- Base: `origin/main@66fbee3de51187f6c2b19183296fbb57d2aa12d5` (#61); branch `feature/p2-5-hf-r4-worker-operations-ui`.
- PM proposals preload the authorized worker baseline and submit only changed #61 `ENTRY_FIELD` values with reason, OCC version, idempotency key, and existing approval flow.
- Status remains `WORK_STATUS`; payment remains the existing bank-text proposal. Review queue stays above the directory.
- Directory filters use only #52 server filters (status/project/recruiter) and cursor pagination; no free-text PII search.
- Privileged correction visibility uses only session-projected `entry_admin`/`entry_privileged_edit` plus `all` scope. The #61 route remains authoritative.
- Contract gap: `/api/direct-entry/catalog` permits `entry_create` or `entry_own`, not `change_request_create` or `entry_privileged_edit`. Such PM/privileged actors may lack project/recruiter choices; UI fails closed and reports catalog unavailability. Add no parallel authorization model; server must expose a safe catalog read contract if those actors need choices.
- Validation: `pnpm test` passed; focused W03/W05/W06 and proposal/API lanes passed; typecheck passed; lint has 0 errors (12 existing warnings).
- `pnpm exec next build --webpack` passed. Default `pnpm build` hits Turbopack’s external `node_modules` symlink restriction in this isolated worktree.
- `pnpm db:migrate --offline` validated 61 migrations; docs/secrets checks and `git diff --check` passed.
- No production apply, deploy, or main push.
