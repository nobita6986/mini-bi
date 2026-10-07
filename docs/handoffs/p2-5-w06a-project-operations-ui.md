# P2.5-W06A-R1 — Close runtime contract + usability findings

**Status:** `P2.5-W06A-R1_LOCAL_PASS`. Base `origin/main@dcf4a6a` (51 migrations). Branch `feature/p2-5-w06a-project-operations-ui`, parent `bce5b6c`. No Production apply, no deploy, no main push, no amend/rebase/force-push.

## Findings (before → after)

- **F1 list projection**: `projectAdminProject` now accepts the real 8-key master row from `direct_entry_list_projects_admin` (`created_at`/`updated_at` nullable, `revision_count`, `active_assignment_count`), no longer fail-closes real payloads to `unavailable`.
- **F2 detail RPC**: `getProject` → `direct_entry_get_project_admin` (master only); new `listAssignments` → `direct_entry_list_project_manager_assignments` (`include_history=true`); API detail = `getProjectDetail` composing both. Current + future-effective + revoked history all flow through; revoke of open assignments kept.
- **F3 multi-assign OCC**: UI now reads `project_version` (not `version` = assignment version) via `mutationProjectVersion`. Copy says assignments are processed sequentially; a failed step reloads and shows what actually applied.
- **F4 tests**: new `project-admin-contract.test.mjs` with migration-#51-faithful fixtures (8-key master, 11-key assignment, 8/6-key assign/unassign, 6-key create) + fail-closed; repository/API/model tests rewired to real payloads.
- **F5 authority**: single pure `projectAdminNavPredicate` = `entry_admin` ∧ effective `all` scope, shared by nav entry (`capability: "project_admin"`) and page decision `decideProjectOperationsPageAccess` (entry_own/team → ACCESS_DENIED, no API-403-only fallback).
- **F6 active nav**: `findEntryByPath` longest-prefix + `usePathname()` in DesktopNav/MobileNav/ActivePageLabel; `/direct-entry/projects` highlights "Dự án" on desktop + mobile.
- **F7 manager UX**: **BLOCKED** — no canonical server projection lists recruiters with a verified, effective account link for `entry_admin`+all (`direct_entry_input_catalog` requires `entry_own` and has no verified projection). Input stays raw `recruiter_id` UUID with a verified-link hint; no raw table read / migration / RPC added (slots #52/#53 reserved for W03/W04). Not claiming end-to-end manager selection until the projection gap is closed.

## Tests / gates

`test:p2.5-w02` 23 · `test:server` 199 (contract 8 · repository 12 · api 12 · model 13) · `test:app-nav-02a` 89 · `pnpm test` · typegen+typecheck · lint (0 errors) · build · `git diff --check` — all PASS.

Out of scope / untouched: worker directory, change requests, reviewer UI, capability/schema decisions, any new RPC or migration or dependency.
