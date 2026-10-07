# P2.5-W06A — Project Operations UI (vertical slice)

**Status:** `P2.5-W06A_LOCAL_PASS` (API + UI complete). Base `origin/main@dcf4a6ac56deb6e236ced3184639d77c75eef8d0` (51 migrations, W02-R2 `6b5a833`). Branch `feature/p2-5-w06a-project-operations-ui`. No Production apply, no deploy, no push to main.

## Delivered

| File | Role |
| --- | --- |
| `src/lib/direct-entry/project-admin-contract.ts` | Strict fail-closed projections for the 7 admin RPC responses |
| `src/lib/direct-entry/project-admin-repository.ts` | RPC boundary (7 canonical RPCs) + SQLSTATE→kind mapping |
| `src/lib/direct-entry/project-admin-api.ts` | API boundary: gate → CSRF → bounded JSON → authority scan → strict projection → session actor → repository → sanitized response |
| `src/app/api/direct-entry/projects/**` | 5 routes: list/create, detail/patch, set-active, managers assign, managers/[id] unassign |
| `src/lib/direct-entry/project-operations-model.ts` | Pure client model: validators, request builders, sanitized taxonomy, OCC reload-required |
| `src/components/direct-entry/project-operations.tsx` | UI: list, create/rename/activate/deactivate, managers + history, multi-assign, revoke |
| `src/app/direct-entry/projects/page.tsx` | Boundary: same flag, actor resolver and access decision as `/direct-entry` |
| `src/lib/navigation/registry.ts` | Entry `project-operations` (`capability: owner`); every `/direct-entry*` route gated by the same flag |

## Properties

Authority comes only from the server response/RPC — never inferred from role, email, recruiter, team or
`created_by`; UI hide/disable is UX only. The client never sends actor/capability/scope/role and the API
rejects such fields before touching session or repository. Deactivate is `direct_entry_set_project_active(..., false)`
— no separate RPC. Every project/assignment mutation carries OCC (`expected_version` + `expected_project_version`)
and a **mandatory reason**; 409 maps to reload-required (no optimistic overwrite). Errors use a fixed sanitized
taxonomy (`PROJECT_DENIED`/`PROJECT_NOT_FOUND`/`PROJECT_CONFLICT`/`PROJECT_INVALID`/`PROJECT_UNAVAILABLE`);
raw DB messages are never forwarded; path ids are checked against the DB `project_id` shape before any RPC call.

## Tests

`project-admin-repository` 9 · `project-admin-api` 12 (gate/CSRF before body+repository, actor only from session,
sanitized errors) · `project-operations-model` 12 (create/rename/deactivate/reactivate, assign/unassign, mandatory
reason, stale project + assignment version) · `project-operations` 11 source/a11y/mobile/keyboard assertions ·
`registry-project-operations` 3. Lanes: `test:server`, `test:app-nav-02a`, `pnpm test`, `pnpm typecheck`,
ESLint, `pnpm build`, `git diff --check` — all PASS.

Out of scope and untouched: worker directory, change requests, reviewer UI, capability/DB-schema decisions,
any new RPC, migration or dependency.
