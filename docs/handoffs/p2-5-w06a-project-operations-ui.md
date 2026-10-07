# P2.5-W06A — Project Operations UI (server foundation)

**Status:** `P2.5-W06A_PROJECT_ADMIN_SERVER_FOUNDATION_LOCAL_PASS_UI_PENDING`

Base `origin/main@dcf4a6ac56deb6e236ced3184639d77c75eef8d0` (51 migrations, W02-R2 `6b5a833` integrated).
Branch `feature/p2-5-w06a-project-operations-ui`. No Production apply, deploy or push to main.

## Delivered (verified)

| File | Role |
| --- | --- |
| `src/lib/direct-entry/project-admin-contract.ts` | Strict fail-closed projections for all 7 admin RPC responses |
| `src/lib/direct-entry/project-admin-repository.ts` | RPC boundary for the 7 canonical RPCs + SQLSTATE→kind mapping |
| `src/lib/direct-entry/project-admin-repository.test.mjs` | 9 tests (lane registered in `test:server`) |

Contract captured directly from `20261008110000_p2_5_w02_multi_manager_project_authority.sql`:
project `{project_id,display_name,active,version}`; assignment
`{assignment_id,project_id,project_version,manager_recruiter_id,valid_from,valid_to,effective,version,revoked_at,created_at,updated_at}`;
list `{authorization_date,include_inactive,projects[]}`; detail
`{authorization_date,project_id,project_version,project_active,active_assignment_count,assignments[]}`;
mutations `{project_id,display_name,active,version,revision_id}`; assign/unassign
`{assignment_id,project_id,version,project_version,valid_to,already_*}`.

Established properties: actor identity is always server-passed (`p_auth_subject`/`p_app_user_id`,
never client); **deactivate uses `direct_entry_set_project_active(..., false)`** with no extra RPC;
OCC carried on `p_expected_version` (assignment) *and* `p_expected_project_version` (project);
missing/extra key, wrong type or blank string ⇒ `unavailable`, never a partial success; every RPC
error maps to `conflict|denied|invalid|not-found|unavailable` from SQLSTATE only, and the raw DB
message is never surfaced.

## Gates

Targeted 9/9 · `pnpm test:server` lane 152/152 · `pnpm typecheck` PASS · targeted ESLint 0
problems · `pnpm build` PASS · `git diff --check` PASS.

## NOT delivered (blocked on budget, not on contract)

The W02 RPCs had **no server glue at all** before this task — no repository, no API route, no page.
This lane builds bottom-up, so the remaining work is a full vertical slice:

1. API routes under `src/app/api/direct-entry/projects/**` using the existing session guard +
   `allowed_actions`-style server authority (no client-inferred permission).
2. `src/app/...` Project Operations page: list/create/rename/activate/**deactivate**,
   assign/unassign multi-manager with mandatory reason + OCC, assignment history (no hard delete),
   desktop/mobile/a11y parity.
3. UI tests + the mobile/keyboard acceptance cases.

Reuse targets already confirmed present: `direct-entry-spreadsheet-grid.tsx` patterns,
`access-denied.tsx`, `temporary-unavailable.tsx`, `getDirectEntryActor`, the repository pattern
mirrored from `submission-transition-repository.ts`. No CRUD/form/grid framework, no new dependency,
no new RPC, no migration.

Owner/worker-directory/change-request/reviewer UI was explicitly out of scope and is untouched.
