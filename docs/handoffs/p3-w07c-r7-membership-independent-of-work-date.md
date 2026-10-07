# P3-W07C-R7 — Membership-Independent Historical Entry

**Status:** `P3-W07C-R7_LOCAL_PASS_AWAITING_T0_REVIEW`
**Branch:** `feature/p3-w07c-date-blur-recruiter-scope-hotfix`
**Base:** `a9010fd`
**Migration:** `20261008090000_p3_w07c_r7_membership_independent_of_work_date.sql` (#49)

## Outcome

- Recruiter provider/team membership is validated at the current HCM authorization date, not at the worker's `first_work_date`. Historical work dates no longer fail merely because the selected recruiter did not belong to that provider/team on that date.
- Date-only edits preserve the saved recruiter, provider, and team. A real recruiter change must resolve exactly one active provider and team membership today; current project authorization remains enforced.
- Active own/team/all grants are evaluated as of the current authorization date rather than the worker date.
- A currently assigned project manager can list, read, and update DRAFT rows in that assigned project, including rows created by former staff. The manager's access is project-scoped and audited as `project_manager`; moving the assignment removes this project-derived access. Existing own/team/all access remains unchanged.
- Project-manager access does not allow deleting DRAFT rows, changing rows outside the assigned project, or editing submitted records through the draft path. PII, payment, employment-status, and document fields remain capability-redacted. The current PM assignment does not override those capabilities.
- The date editor also commits a valid DD/MM draft on outside-click/blur by synchronizing it into the grid's active row; invalid drafts do not replace the saved value.

## Migration and boundary

The append-only migration patches the existing RPC/trigger source only after exact-source assertions. It adds one internal draft-scope resolver (not executable by `service_role`, `authenticated`, `anon`, or `PUBLIC`) and keeps existing function ACL/security-definer boundaries. Migration inventory is 49; the frozen production reconciliation expected-applied count remains 47.

No existing rows, scope grants, project assignments, dependencies, or production data are changed. No Production apply/query, deploy, main push, or commit was performed.

## Regression coverage and gates

- PGlite: a recruiter with no membership on the historical work date can create a row using current membership; date-only edits preserve its saved assignment after the recruiter is inactive.
- PGlite: a replacement project manager with no own/team/all grant can list/read/update the old manager's DRAFT row while assigned; after reassignment, list/read fail closed. Audit records `capability=project_manager` and a null legacy `scope_kind` rather than mislabeling project scope.
- API projection accepts the new `scope_kind=project` value; project authorization remains server-side.
- `pnpm test` — all constituent suites pass; `pnpm test:p1.6-i04c3-s01` — 39/39; `pnpm test:p1.6-w04-s03cd` — 16/16; `pnpm test:p3-w07b-project-scope` — 2/2; migration inventory — 8/8.
- `pnpm typecheck`, `pnpm lint` (0 errors; 10 existing warnings), `pnpm build`, `pnpm db:migrate --offline` (49 valid), and `git diff --check` — pass.

## T0 / integration note

Review the broadened **draft-only** authorization through current project-manager assignment. Submitted-entry and employment-status operations keep their existing capability and own/team/all matching; those grant intervals are now evaluated on the current authorization date, but project-manager assignment alone does not grant those submitted-record actions. UAT should include date edit followed by blur, historical draft create/edit, and reassignment away from a former manager.
