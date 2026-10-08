# P2.5-HF-R3 — worker full-field correction + Admin/BoD direct correction

Base verified: `origin/main@1b7fc983d974b6706ce9c14b526d039fc2addf87` (ledger 60). New worktree/branch `feature/p2-5-hf-r3-worker-correction` from that exact SHA; historical migrations untouched.
Code commit: `2521340460eaea1dc24bc54bf48c5211ffb9b10c`. Migration: `supabase/migrations/20261008210000_p2_5_hf_r3_worker_full_correction.sql` (#61, the T1B slot).
Gates: `pnpm test` exit 0 — 1668 tests / 1668 pass / 0 fail; build, typecheck, lint 0 errors (12 pre-existing warnings), docs:check 6/6, secrets:check, `db:migrate --offline` = 61 valid, `git diff --check`.

## Policy 1 — a project manager may propose every business field
- #61 re-widens the ENTRY_FIELD proposal set to `project_id, first_work_date, employee_code, worker_details, recruiter_id, labor_type` and removes the #53 `display_name` protection, on both the create path and the apply path, so an effective manager can propose name, employee code, project, start date, recruiter/team, labor type and profile data.
- `display_name` is now a normal business field, and the `worker_details` key allowlist is unchanged. `team_id`/`provider_type` remain derived: apply re-derives them from the (new) recruiter plus memberships, exactly like the privileged path.
- Nothing became a direct write for a manager: request + reason + OCC + idempotency + approval, no-self-review, all-or-nothing apply and immutable audit are untouched. The TS contract already accepted this key set, so no client contract change was needed.

## Policy 2 — Admin and BoD/Accounting correct submitted data directly
- #61 re-creates `direct_entry_privileged_edit` with its own state gate: `DRAFT` and `SUBMITTED` are editable, a submission under `REVIEW` is still refused (42501), and the shared `direct_entry_assert_not_review` is untouched for every other RPC.
- Authority is unchanged and capability-based: `entry_admin` + effective all scope, or the BoD/Accounting bundle `entry_privileged_edit` + effective all scope. No name/email/role inference, no hardcoded account, no new grant.
- reason + OCC (`40001`) + idempotency + revision + immutable audit + all-or-nothing are preserved and asserted.
- New server boundary: `POST /api/direct-entry/entries/[entryId]/privileged-edit` → `privileged-edit-api` (gate, CSRF/origin, content type, idempotency key, strict patch projection, session actor) → `privileged-edit-repository` (service-role RPC only, strict result projection, safe error codes incl. `WORKER_ACTIVE_EPISODE_EXISTS`). The browser never touches a table and never supplies identity.

## Policy 3 — invariants kept
- Identity keys (`entry_id`/`candidate_id`/`submission_id`) stay stable and nothing is deleted or soft-deleted (asserted); an unsupported status key in a privileged patch is refused, and the direct status RPC stays DRAFT-only, so a status change still travels through a reasoned status event.
- The CMT/CCCD rule (ASCII digits, 9 or 12, leading zero) and the #58–#60 episode invariant hold on the direct path: a CCCD that collides with a still active episode is refused `23505`, a malformed value `23514`, with zero residue.

## Policy 4
- Bank/STK stay lookup text; no payment integration and no document upload/view/delete right is opened in the generic edit (`update_payment` stays DRAFT-only, DOCUMENT stays closed to the W05 matrix).

## Blocker (not built on purpose)
- **Team-leader management has no canonical model or RPC anywhere in the repo** (0 hits for any team-leader token/table; `direct_entry_project_manager_assignments` covers project managers only, and survey line 410 assigns the personnel/team/leader backend to P3.1 W01). Building one here would duplicate P3.1 and add schema/RBAC outside this lane, so it is reported instead of implemented.
- Project CRUD and project-manager assignment do exist (#51/#51-R1: `direct_entry_create_project`, `direct_entry_assign_project_manager`, `direct_entry_set_project_active`, …) and already require `entry_admin` + effective all scope with reason/OCC/idempotency/audit; the BoD/Accounting bundle carries `entry_admin` at all scope (survey line 385), so those paths are reachable without any change.

## Regression
- New `scripts/p2-5-hf-r3-worker-full-correction-db.test.mjs` (4/4): admin happy path with revision/audit/idempotent replay, BoD correction, actor matrix (reviewer/manager/recruiter/uploader denied 42501 with zero residue), stale OCC 40001, REVIEW lock, unsupported keys, status RPC still DRAFT-only, manager full-field proposal + approval applied (new project/date/code/name/recruiter with team re-derived) + no-self-review, CCCD duplicate/malformed/free cases.
- New `src/lib/direct-entry/privileged-edit.test.mjs` (5/5): patch projection, CSRF/content-type/idempotency/gate, session failure modes, error-code mapping with no raw DB message, strict result projection.
- `scripts/p2-5-w05-review-authority-db.test.mjs` updated to the new policy (the privileged path left the "denied on SUBMITTED" list) plus a dedicated R3 test proving the exception and that the other paths stay closed (8/8).
- Ledger/inventory rebaselined 60 → 61 across the canonical suites; function inventory unchanged (the #61 helper is dropped after use).

## Scope note
- Survey lines 379/381 ("protected keys / non-protected fields only") are superseded for the project-manager case by this task's T0 lock; everything else in the survey still holds. No Production apply, deploy, merge or push to `main`.