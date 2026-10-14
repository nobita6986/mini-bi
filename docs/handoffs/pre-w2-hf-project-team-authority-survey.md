# Pre-W2-HF Project ↔ Team authority — survey (docs-only)

> Status: `PRE_W2_HF_PROJECT_TEAM_AUTHORITY_SURVEY_PASS_AWAITING_T0_REVIEW`
> Base: `origin/main@aba3c58` (91 migrations). Isolated worktree: `…\.commandcode\worktrees\BI-05be35f5ca32\…\T1C-pre-W2`. Branch: `codex/pre-w2-hf-project-team-authority-survey` (off `origin/main`). Primary checkout untouched.
> Kind: read-only survey. No source/SQL/package/test change, no DB access/mutation, no migration apply, no merge, no Vercel/VPS deploy, no UAT. Only this handoff is written.
> Migration ledger verified on `origin/main`: **91** migrations (`…_p2_w04d_cutoff_2000_01_01` #89, `…_pre_w2_hf_e_worker_export_all_and_note` #90, `…_pre_w2_hf_f_employment_status_edit` #91). **Next append-only slot = #92; NOT reserved by this survey.**

## 1. Executive conclusion

1. The **DB already grants Team Leaders a working Project Operations path** (`#72`): a canonical leader may **view all active projects**, **assign/unassign project managers who are current members of the leader's own team**, and is **denied project master** (create/rename/activate/deactivate). See §3.
2. **There is NO Project ↔ Team scoping anywhere.** `#72` restricts the *manager target* to the leader's team, but **not the project**. A canonical leader can therefore act on **every active project**, not just "their" projects.
3. The **UI/nav/page gate is the stale P2.5 predicate** `projectAdminNavPredicate = entry_admin + effective all scope`. So Team Leaders **do not see the "Dự án" menu**, and the direct-URL page decision returns `ACCESS_DENIED`. But **hiding the menu is not a security boundary**: a valid leader's session still resolves, and the API delegates authority to the RPC (§2/§4). Direct API/RPC calls succeed for own-team assignment on any active project.
4. The server already projects `can_manage_project_master` and `can_assign_managers` per project (`#72`), and the client model parses them — **but the Project Operations UI component never reads them** (`src/components/direct-entry/project-operations.tsx` has zero references).
5. Owner's chosen model (Admin grants *which projects a Team may manage*; the leader then only assigns/unassigns own-team managers **on mapped projects**) is **not a UI-gate opening**. It needs a **new Project↔Team mapping**, plus coordinated DB authority + page gate + nav predicate + UI changes. Details and plan: §4–§10.

**Bottom line:** do **not** just open the gate. The authoritative fix is a new Project↔Team mapping enforced **server-side in the RPC** (the security boundary), with nav/page/UI only reflecting the server-declared reality.

## 2. Current-state call graph

```
Navigation
  registry.ts: NAV_ENTRIES["project-operations"] capability="project_admin"
    └─ resolveNavCapabilityPredicate("project_admin") = projectAdminNavPredicate
       └─ entry_admin && scopes.some(kind==="all")           [registry-capability.ts:80]

/direct-entry/projects page
  src/app/direct-entry/projects/page.tsx
    └─ decideProjectOperationsPageAccess({ uiEnabled, actor })      [direct-entry-page-access.ts:120]
         └─ projectAdminNavPredicate(actor)  → ALLOW | ACCESS_DENIED   (NOT_FOUND if flag off;
            REDIRECT_LOGIN / ACCOUNT_UNAVAILABLE / TEMPORARY_UNAVAILABLE for actor states)

Project Operations UI
  src/components/direct-entry/project-operations.tsx ("use client")
    ├─ GET  /api/direct-entry/projects?include_inactive=true
    ├─ GET  /api/direct-entry/projects/{id}
    ├─ POST /api/direct-entry/projects                        (create)
    ├─ PATCH /api/direct-entry/projects/{id}                  (rename)
    ├─ POST /api/direct-entry/projects/{id}/active            (set-active)
    ├─ POST /api/direct-entry/projects/{id}/managers          (assign)
    ├─ POST /api/direct-entry/projects/{id}/managers/{assignmentId} (unassign)
    └─ GET  /api/direct-entry/manager-candidates?search=…
    (UI renders create/rename/set-active/assign/unassign unconditionally; it never reads
     can_manage_project_master / can_assign_managers.)

API layer (NO authority evaluation)
  src/lib/direct-entry/project-admin-api.ts
    pipeline: DIRECT_ENTRY_API_ENABLED gate → same-origin/CSRF (mutations) → bounded JSON →
    validateClientBusinessPayload (reject client authority fields) → strict request shape →
    actor resolved ONLY from session (auth_subject + app_user_id) → repository/RPC →
    sanitized error taxonomy (PROJECT_DENIED/NOT_FOUND/CONFLICT/INVALID/UNAVAILABLE).
    Header comment: "Module nay KHONG danh gia quyen … capability/scope do RPC enforce."

Repository (service_role RPC only)
  src/lib/direct-entry/project-admin-repository.ts  → 9 RPCs:
    direct_entry_list_projects_admin(p_auth_subject,p_app_user_id,p_include_inactive)
    direct_entry_get_project_admin(p_auth_subject,p_app_user_id,p_project_id)
    direct_entry_list_project_manager_assignments(p_auth_subject,p_app_user_id,p_project_id,p_include_history)
    direct_entry_list_project_manager_candidates(p_auth_subject,p_app_user_id,p_search)
    direct_entry_create_project(...)
    direct_entry_update_project(...)
    direct_entry_set_project_active(...)
    direct_entry_assign_project_manager(...)
    direct_entry_unassign_project_manager(...)

DB authority (the real boundary)
  direct_entry_assert_project_operation_authority(auth,app) → (authority, team_id)   [#72]
    1) direct_entry_assert_catalog_operator        → authority='entry_admin'|'catalog_master_manage', team_id=null
    2) direct_entry_assert_project_admin           → authority='entry_admin', team_id=null   (entry_admin+all)
    3) direct_entry_assert_team_leader_read_authority(...,null) → authority='team_manager_assign', team_id=scope
```

## 3. Root cause and current security exposure

| # | Finding | Evidence |
|---|---|---|
| R1 | **Menu hidden by the stale P2.5 predicate.** `projectAdminNavPredicate = entry_admin + all`; a leader (`team_manager_assign` + `team`) fails it. Page gate reuses the same predicate, so direct URL = `ACCESS_DENIED`. | `registry-capability.ts:80-82`; `direct-entry-page-access.ts:120-135` |
| R2 | **No Project↔Team table exists.** No mapping gates *which* projects a leader may touch. | grep `project_team|team_project` over `supabase/migrations` → only the W02A helper name `direct_entry_lock_project_team_manager_context` |
| R3 | **RPC #72 scopes the target manager, not the project.** `direct_entry_list_projects_admin` returns **all active** projects to leaders; assign/unassign only require the *target* to be an unambiguous current member of the leader's team; project master (create/update/set-active) is denied. | `20261009080000_…w02a…sql` list/get/assign/unassign bodies |
| R4 | **API defers to the RPC.** No API-level project/team predicate; the actor comes only from the session. A valid leader can call the routes directly. | `project-admin-api.ts` header + `resolveTrustedActor` |
| R5 | **Server projects authority flags that the UI ignores.** `can_manage_project_master`, `can_assign_managers` are in the RPC payload and parsed by `project-operations-model.ts`, but the UI component never reads them. | `project-admin-contract.ts:26-27`; `project-operations-model.ts:24-25,51-52`; `project-operations.tsx` (0 matches) |
| R6 | **Leaders can assign own-team PMs to ANY active project** (assumption target-model violation). Because the project-side is unscoped, `#72` over-grants relative to Owner's chosen model. | `#72` assign RPC: membership check on `p_manager_recruiter_id`, no project-mapping check |

**Exposure (fail-closed gap):** the visibility control (menu) and the mutation control (RPC) are **out of sync**. Today a canonical leader can attach members of their team as project managers on **any** active project via a direct API call — the exact behavior Owner wants constrained to Admin-granted projects.

**Tests that lock the (now-incorrect) deny** — must be updated deliberately, not silently:

- `src/lib/auth/direct-entry-page-access.test.mjs:98` (leader → `ACCESS_DENIED` for catalog/admin pages; note: for `/direct-entry/projects` the leader must become ALLOW).
- `src/lib/navigation/registry-capability.test.mjs:80-90` (locks `projectAdminNavPredicate` semantics).
- `src/lib/navigation/registry-project-operations.test.mjs:20` (locks the entry capability = `project_admin`).
- `scripts/p3-1-w01a-capability-contract.test.mjs:344,353` (locks `projectAdminNavPredicate(projected)=false` + `decideProjectOperationsPageAccess(...)=ACCESS_DENIED`).
- `src/components/direct-entry/project-operations.test.mjs:244` (asserts the page uses `decideProjectOperationsPageAccess` — keep, but the decision's predicate changes).

## 4. Reuse / extend / new matrix

| Asset | Reuse as-is | Extend | New |
|---|---|---|---|
| `teams` table (code/display_name/active/version) | ✅ | | |
| `direct_entry_projects` (`project_id` text PK, display_name, active, version) | ✅ | | |
| `recruiter_team_memberships` (half-open, overlap-guarded) | ✅ | | |
| `direct_entry_project_manager_assignments` (assignment_id PK, project_id, manager_recruiter_id, valid_from/valid_to, created_by_user_id, revoked_by_user_id, reason_id, revoke_reason_id, revoked_at, version) | ✅ | | |
| Canonical Team Leader resolver `direct_entry_assert_team_leader_read_authority` (exact-one scope/link/provider/membership/leader-assignment) | ✅ | | |
| `team_manager_assign` capability (+ `REQUIRED_SCOPE_KIND` team) | ✅ | | |
| Project authority selector `direct_entry_assert_project_operation_authority` | ✅ delegate to | add mapping term on the leader path | |
| Project Operations API (`project-admin-api.ts`) | ✅ | (no authority here — stays) | |
| Project Operations repository/contracts | ✅ | add mapping RPCs + link flags | |
| Project revision / audit / idempotency / OCC chain (`direct_entry_lock_project`, `direct_entry_bump_project_version`, `direct_entry_project_revisions`, `direct_entry_rpc_idempotency`, `direct_entry_reason`) | ✅ | | |
| Admin Team catalog UI (`team-catalog-manager.tsx`, `team-catalog-model.ts`, `/admin/catalog/teams`) + `team-catalog-api/repository` | ✅ interaction pattern | add a "Team ↔ Projects" granting surface | |
| Project Operations UI (`project-operations.tsx`, `project-operations-model.ts`) | ✅ shell/table/dialog/OCC-conflict patterns | **consume `can_manage_project_master` / `can_assign_managers`; hide master actions for leaders; empty state** | |
| Navigation/page predicates (`registry-capability.ts`, `registry.ts`, `direct-entry-page-access.ts`) | ✅ skeleton | **new project-operations predicate admitting canonical leader shape; keep deny for everyone else** | |
| Test helpers + migration self-check patterns (`AUTH_PROLOGUE`, `migratedDb`, ledger-count/positional guards, service-role ACL + `search_path` self-checks) | ✅ | | |
| Worker change-request workflow (`change-request-contract.ts`, `direct_entry_*_change_request`) | ❌ **not reusable** | | |
| **Project ↔ Team mapping** | | | 🆕 table + guard term + grant/revoke RPCs |

**Do not reuse the worker change-request workflow — evidence.** `CHANGE_REQUEST_TARGET_KINDS = ["ENTRY_FIELD","PAYMENT","WORK_STATUS","DOCUMENT"]` and `PROPOSAL_KEYS.ENTRY_FIELD = ["project_id","first_work_date","employee_code","worker_details","recruiter_id","labor_type"]` with `WORKER_DETAILS_KEYS = ["display_name","date_of_birth","national_id","address","phone"]` (`src/lib/direct-entry/change-request-contract.ts:21-62`). Its items are keyed by `entry_id` against `direct_entries` (worker profiles) with `direct_entry_apply_change_item`. It has no concept of a project↔team scope. Reusing it would be an invented contract.

## 5. Proposed minimal contract

**New table — `public.direct_entry_project_team_scopes`** (append-only; mirrors the existing interval tables):

| Column | Type | Notes |
|---|---|---|
| `scope_id` | uuid PK (gen_random_uuid) | immutable identity (revoke target) |
| `project_id` | text FK → `direct_entry_projects(project_id)` ON DELETE RESTRICT | |
| `team_id` | uuid FK → `teams(team_id)` ON DELETE RESTRICT | |
| `valid_from` | date NOT NULL | explicit; never a DB default at runtime |
| `valid_to` | date NULL | half-open `[valid_from, valid_to)`; `check (valid_to is null or valid_to >= valid_from)` |
| `version` | integer NOT NULL default 1 `check (version >= 1)` | OCC for the mapping row |
| `created_by_user_id` / `revoked_by_user_id` | uuid FK → `direct_entry_app_users` | actor |
| `reason_id` / `revoke_reason_id` | uuid FK → `direct_entry_restricted_reasons` | never raw text |
| `created_at` / `revoked_at` | timestamptz | |

- Non-overlap guard per `(project_id, team_id)` reusing `direct_entry_guard_effective_interval()` (add a `direct_entry_scope_grants`-style branch), plus a unique open index like W01D.
- Forced RLS + `revoke all from public, anon, authenticated, service_role`; written only by service-role RPCs.
- **No per-project capability token** (Owner: "không tạo capability riêng cho từng project"). Scoping is data, not a grant.

**New RPCs (Admin-only):**
- `direct_entry_grant_project_team_scope(auth, app, project_id, team_id, valid_from, expected_?, reason, idempotency_key)`
- `direct_entry_revoke_project_team_scope(auth, app, scope_id, expected_version, reason, idempotency_key)`
- bounded `direct_entry_list_project_team_scopes(auth, app, project_id?, team_id?)`
- Both mutations require reason + OCC + idempotency + revision/audit (reuse the existing chain).

**Leader-path change:** `direct_entry_assert_project_operation_authority` (or a thin wrapper) must, on the `team_manager_assign` path, additionally require an **effective mapping** `(project_id, leader_team_id)` for the project being read/mutated. Project master (`create/update/set_active`) remains denied for leaders.

**Server-projected flags (already present; make them mapping-aware):**
- `can_manage_project_master` = `authority ≠ team_manager_assign`.
- `can_assign_managers` = `authority ≠ team_manager_assign` **OR** (leader **and** project is mapped to the leader's team).

## 6. Answers to the required design questions

1. **New table?** **Yes** — `direct_entry_project_team_scopes` (§5). No existing table expresses project↔team; `direct_entry_team_leader_assignments` is leader↔team, `recruiter_team_memberships` is personnel↔team.
2. **One team, or many, per project?** **Owner decision.** Current code has no evidence either way ("projects remain team-agnostic", P3.1). Recommendation: **many-to-many with intervals** (a project may be serviced by several teams; a team by several projects) — the mapping is a *grant*, and per-team isolation is enforced by the leader's own team term. Consequence of "exactly one team" is a simpler unique index plus an explicit transfer flow; consequence of "many" is a richer grant matrix. Mark **OPEN-D1**.
3. **Mapping fields:** §5 (`project_id`, `team_id`, `valid_from`/`valid_to`, `version` OCC, `reason_id`/`revoke_reason_id`, idempotency via `direct_entry_rpc_idempotency`, audit event, revision, `created_by_user_id`/`revoked_by_user_id`/timestamps).
4. **Which Admin may grant/revoke?** Recommend the **same guard that governs project master** — the non-leader path of `direct_entry_assert_project_operation_authority` (`entry_admin@all` **or** `catalog_master_manage@all`), server-resolved, never from email/role/client fields. Mark **OPEN-D2** (Owner/T0 confirm if BoD/Kế toán must be excluded).
5. **On mapping revocation:** never rewrite PM assignment history. Fail-closed recommendation: **after revocation the leader can neither assign nor unassign** for that project (the mapping term gates both); lingering open assignments become **Admin-only** to revoke. (Alternative, less safe: let the former leader unassign own-team open rows as cleanup until re-mapped.) Mark **OPEN-D3**.
6. **Team/Project inactive:** fail-closed. Inactive project → leader cannot see/act (already true for reads in `#72`; extend to assign/unassign by adding the "mapped + active" term). Inactive team → leader authority already denied (`direct_entry_assert_team_leader_read_authority` requires an active team).
7. **Mid-term leader / membership change:** the mapping is **project↔team**, independent of the acting leader's identity; the canonical leader resolver already handles leader replacement, and `#72` already handles membership drift for visibility/candidates. No mapping rewrite on leader change. Existing assignments untouched.
8. **Ambiguous actor (multi-team scope / multiple links):** already fail-closed — `direct_entry_assert_team_leader_read_authority` requires exactly one effective team scope, one verified link, one HRP provider membership, and one live leader assignment; `resolveActor` fail-closes `AMBIGUOUS_TEAM_MEMBERSHIP` / `AMBIGUOUS_RECRUITER_LINK`. Keep this; do not add a soft path.
9. **Backfill:** **no auto-grant** ("all projects to all teams" forbidden). Recommended default: **start empty** → leaders see nothing until Admin maps projects. Optionally, an explicit, audited Admin bulk-grant can be offered later (not in this hotfix). Mark **OPEN-D4**.
10. **Existing PM assignments:** preserve absolutely — no UPDATE/DELETE/TRUNCATE; the migration only adds a table + guard term + RPCs.

## 7. Authority matrix (target)

| Actor | See projects | See assignments | Assign / unassign | Project master |
|---|---|---|---|---|
| Full Admin (`entry_admin`+`recruiter_master_manage`+`team_master_manage` @all) | all | all | all eligible managers | allow |
| Catalog operator / BoD / Kế toán (`catalog_master_manage` @all) | all | all | all eligible managers | allow (verify current behavior is unchanged — §3 R3) |
| Legacy Project Admin (`entry_admin@all` alone) | all | all | all | allow (existing P2.5 path) |
| **Canonical Team Leader** (`team_manager_assign` + one effective `team` scope + W01D leader assignment) | **only active projects mapped to the leader's team** | assignments of mapped projects where manager is an unambiguous current member of the leader's team | assign/unassign own-team managers **only on mapped projects** | **deny** |
| PM / staff / recruiter | deny | deny | deny | deny |
| Disabled / revoked / unmapped / ambiguous | deny | deny | deny | deny |

## 8. Data / migration plan

- **Append-only** migration(s) only; never edit an applied migration. Suggest two cohesive slots (T0 allocates; **no reservation**): (a) mapping table + guard term + read RPC; (b) grant/revoke RPCs + `#72` authority-path extension + flag logic. Or one cohesive migration if T0 prefers.
- **No** `UPDATE`/`DELETE`/`TRUNCATE` of business data. **No** auto-created mappings. **No** PM assignment history rewrite.
- Follow the existing self-check style (service-role ACL, fixed `search_path`, has_function_privilege, exact projection keys) and the migration-ledger count/positional guard rebaseline convention (see `docs/handoffs/p3-1-w01b-personnel-security-baseline.md` E20).
- **Rollout order:** (1) mapping table + Admin grant/revoke + read; (2) extend `#72` authority path + flags to require the mapping; (3) page/nav predicate + UI consume the flags; (4) tests + regression.
- **Rollback/disable:** the leader-path mapping term is the only behavior change to `#72`; a safe disable is to make the mapping term permissive (or gate it behind the same feature flag as Project Operations) without dropping the table or data. Adding a table is additive and reversible by not using it.

## 9. Test / mutation plan

Regression (must pass):
- Leader sees **only mapped active** projects; unmapped project is invisible (list) and `P0002`/deny (get).
- Leader can assign/unassign own-team eligible managers **on mapped active projects**.
- Leader **cannot** assign/unassign on unmapped projects, nor create/rename/activate/deactivate.
- Cross-team target managers are excluded from candidates / rejected.
- **Direct API/RPC** call for an unmapped project fails (`42501`/`P0002`) even when the menu is bypassed.
- Revoked mapping → further assign/unassign denied.
- Inactive project/team fail-closed; disabled/unmapped/ambiguous actors denied.
- Admin/catalog operator/legacy project admin behavior unchanged; existing PM history unchanged.

Mutation probes (must turn a named assertion red, then revert byte-identical):
- Remove the page/nav gate → a leader without mapping reaches the page.
- Remove the project↔team DB predicate → leader passes on an unmapped project.
- Trust a client-supplied `team_id` → cross-team escalation.
- Let a leader call create/update/set-active → master mutation succeeds.
- Let an ambiguous (multi-team-scope) actor act → succeeds.
- Rewrite/delete an existing PM assignment during mapping changes → history assertion fails.
- Emit `can_assign_managers=true` for an unmapped project → flag assertion fails.

## 10. Owner UAT checklist (checklist only — T1 does not run UAT)

- [ ] As Admin: grant a Team a set of projects; verify the mapping is audited and visible in the admin surface.
- [ ] As the Team Leader of that Team: the "Dự án" menu is visible; the list shows **only** the mapped active projects; an unmapped project is not listed and its direct URL is denied.
- [ ] As that leader: no **Tạo dự án / Đổi tên / Ngừng / Kích hoạt** controls are shown.
- [ ] As that leader: assign/unassign a same-team manager works on a mapped project; the target picker lists only own-team members.
- [ ] As that leader: assigning a same-team member to an **unmapped** project is impossible (not listed / denied).
- [ ] As Admin: revoke the mapping; the leader's menu/projects disappear; existing assignments remain visible to Admin, history intact.
- [ ] As another Team's leader: cannot see or act on the first Team's projects.
- [ ] Deactivate the project and/or team: leader actions fail closed.
- [ ] Disabled/ambiguous actor: denied everywhere.

## 11. Open decisions (Owner / T0 must lock before implementation)

| ID | Decision | Options / consequence |
|---|---|---|
| **OPEN-D1** | Project↔Team cardinality | many-to-many (recommended) vs exactly-one-team-per-project (adds a transfer flow) |
| **OPEN-D2** | Who grants/revokes the mapping | reuse project-master guard (`entry_admin@all` OR `catalog_master_manage@all`) vs Full Admin triple only |
| **OPEN-D3** | Post-revocation unassign | fail-closed (Admin-only) recommended vs former-leader cleanup window |
| **OPEN-D4** | Backfill of existing projects | start empty (recommended) vs an explicit audited bulk-grant (later) |
| **OPEN-D5** | Grant/revoke signature & scope | confirm Admin-only, no `team`/`own` scope substitute, same reason/OCC/idempotency/audit discipline |
| **OPEN-D6** | Mapping "one open interval per (project,team)" | confirm the non-overlap index semantics |
| **OPEN-D7** | Flag semantics | confirm `can_assign_managers` becomes mapping-aware; `can_manage_project_master` stays false for leaders |

## 12. Proposed implementation split (NOT started in this task)

Suggested order (backend → API/UI → integration), pending T0 review of this survey:

- **T1B — Backend/migration (blocking):** add `direct_entry_project_team_scopes` + guard term + Admin grant/revoke/read RPCs; make `#72` leader path mapping-aware; make the flags mapping-aware; migration self-checks + focused PGlite/Postgres regressions + mutation probes. Append-only; no history rewrite.
- **T1A — API/UI:** add the admin "Team ↔ Projects" granting surface (reuse the Team catalog manager patterns); extend the project-operations page/nav predicate to admit the canonical leader shape; make the Project Operations UI consume `can_manage_project_master`/`can_assign_managers` and render the empty state; update the locked tests deliberately.
- **T1C — Integration/regression:** end-to-end allowed/denied matrix, direct-API bypass tests, cross-team denial, mapping revoke, inactive fail-closed, existing-history preservation, ledger/gates. **Owner runs UAT.**

## 13. Boundary

Read-only survey. No source/SQL/package/test change, no DB access/mutation, no migration apply, no merge, no Vercel/VPS deploy, no UAT, no account/membership change. Primary checkout untouched. Only this handoff is written.
