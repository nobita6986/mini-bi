# P3.1-C01 — Catalog administration policy survey (decision memo)

> Status: `P3_1_C01_CATALOG_POLICY_SURVEY_COMPLETE_AWAITING_T0_LOCK`
> Base: `origin/main@1cdc97b4093dd08b3091609f4bd6c63288e7e720` (66 migrations). Read-only survey: no migration, RPC, API, UI, dependency or Production mutation in this task.
> Sources: `docs/P3.1.md` (locked plan), `docs/P3.md`, `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`, and the current migrations/RPC/grants on main. `docs/P2.5.md` is not tracked in the checkout; the P2.5 lane was read from its migrations/handoffs instead.

## 1. Evidence

| # | Evidence (file:symbol) | Fact |
|---|---|---|
| E1 | `src/lib/auth/direct-entry-v2.ts` `CAPABILITIES` | Exactly 21 tokens. **`catalog_master_manage` does not exist** — it appears only as a proposal inside `docs/P3.1.md`. |
| E2 | `src/lib/auth/direct-entry-v2.ts` | Full-Admin authority is the AND of `entry_admin` + `recruiter_master_manage` + `team_master_manage`; nothing named "catalog" or "leader". |
| E3 | `20261008110000_p2_5_w02_...sql:394` `direct_entry_assert_project_admin(uuid,uuid)` | Sole guard for project administration: `direct_entry_assert_actor(...,'entry_admin')` **plus** an effective `all` scope grant; revoked from every role. |
| E4 | same file, call sites `:573,669,824,967,1025,1103,1198` (+ W06A candidate list) | **All** P2.5 project RPCs — list assignments, assign, unassign, list/get projects, create, update, set-active — route through E3. One extension point. |
| E5 | `20261009020000`…`20261009010000` `direct_entry_actor_can_access_project`, `direct_entry_actor_is_assigned_project_manager` | Runtime project authority is assignment-based (`[valid_from, valid_to)`) with an `entry_admin+all` bypass; unassign closes `valid_to` and never deletes history. |
| E6 | `20261008110000` `direct_entry_assign_project_manager` / `_unassign_project_manager` | Already require reason, project row-lock + expected-version OCC, idempotency key, immutable audit and a project revision. Reusable as-is. |
| E7 | `20261008000000_p3_w07a_...sql:72` | `recruiters.personnel_position check (… in ('STAFF','TEAM_LEADER'))` — a display/catalog attribute, not authority. |
| E8 | `20261008080000_p3_w05a_...sql:649` `direct_entry_seed_team_scope_grants()` | Team scope is granted by a fail-closed seed over `TEAM_LEADER` recruiters (exactly one verified link + one effective team membership). There is **no runtime designate/revoke RPC** yet. |
| E9 | `20261002170000_p1_6_direct_entry_foundation.sql:220` | `labor_type text not null check (labor_type in ('TEMPORARY','PERMANENT'))` — **`OUTSOURCED` is rejected today**. |
| E10 | `src/lib/contracts/direct-entry-v1.ts:20,518` | `type LaborType = "TEMPORARY" \| "PERMANENT"` and `LABOR_TYPE_INVALID` validation repeat that closed set in TypeScript. |
| E11 | `20261008000000` `public.vendors` | The Vendor table exists (W07A) with no lifecycle RPC. |
| E12 | `20261008000000` `direct_entry_input_catalog` | Vendor recruiters already project `provider_type='vendor'`, `team_id=null`, `team_display_name=null`; labor type is not part of that catalog. |

## 2. Recommended contract

### 2.1 Capability tokens (C01 must lock the exact names)

- **`catalog_master_manage`** — narrow catalog-operator token, granted at `all` scope to **Admin and Accounting** only. It authorises personnel/team/leader catalog, project master, Vendor and labor-type mutations. It must **not** authorise account enable/disable, capability/scope grants or app-user↔recruiter links.
- **`team_manager_assign`** — narrow team-leader token for project-manager assign/unassign. Replaces the doc's informal wording; it is a *new* token (E1), so C01 must also amend the 21-token contract to 23 and record it in the C01 matrix.
- Rejected alternatives: reusing `entry_admin` (would hand leaders project-master and all-scope authority, banned by Owner decision 5), reusing `team_master_manage` (that token means team **catalog** administration plus the full-Admin triple), or any role-name/browser check.

### 2.2 Exact server predicates

| Actor | Predicate (server/DEFINER only) |
|---|---|
| **Admin** | current full-Admin triple AND `entry_admin@all` — unchanged. |
| **Accounting** | `direct_entry_assert_actor(auth, app, 'catalog_master_manage')` **+ effective `all` scope**; explicitly **not** `entry_admin`, not `recruiter_master_manage`, not `team_master_manage`. |
| **Team leader** (manager assignment only) | `team_manager_assign` capability **+ effective `team` scope for the leader's own team** + verified `direct_entry_app_user_recruiter_links` **+ effective `recruiter_team_memberships` in that same team**; target manager must satisfy the same effective-member test in that team; project must be `active`; projects stay team-agnostic. |

Recommended implementation shape: extend `direct_entry_assert_project_admin` into a two-path guard (catalog operator **or** legacy admin) and add a separate `direct_entry_assert_team_manager_assign(actor, project_id, manager_recruiter_id)` used only by the assign/unassign RPCs and the candidate projection. A leader must **not** pass the project-master guard.

### 2.3 Leader designation / revocation (atomic)

A single RPC `direct_entry_designate_team_leader` / `..._revoke_team_leader` performed in one transaction:
1. validates the target: enabled app user + exactly one verified effective recruiter link + exactly one effective active team membership;
2. creates/ends the `team` scope grant for that app user;
3. grants/revokes `team_manager_assign` with the same effective interval;
4. writes one reason + idempotency + immutable audit event recording the **real** capability and `team` scope;
5. never touches project-master authority, accounts, grants or links beyond (2)/(3).
Revocation closes the intervals; historical team-attribution and assignment history stay readable.

### 2.4 Leader cardinality

**Recommendation: at most one active primary team leader per team; additional leaders permitted only as explicitly designated co-leaders if T0 wants them.** Evidence: E8's seed enforces exactly one verified link and one effective membership per leader and refuses any baseline other than 7 leaders, and no schema expresses "primary vs secondary" (E7 is a single-valued display attribute). Trade-off: a single-leader rule is trivially expressible (unique effective leader per team) and matches the current dashboard semantics, but blocks a team with two rotating leaders; a many-leader rule needs no schema change (leader authority is a capability+scope, not a column) yet makes "who owns the roster" ambiguous and multiplies the revocation surface. **T0/Owner decision required.**

### 2.5 Projections that must be team-scoped

Must filter by the leader's effective team: manager-candidate list (`direct_entry_list_project_manager_candidates`, W06A), project-manager assignment list (`direct_entry_list_project_manager_assignments`), the leader's audit projection, and any leader-facing detail read. Cross-team ids must not appear, and a forged direct call for another team's candidate/assignment must fail closed. Unchanged: Admin/Accounting keep all-project reads.

### 2.6 Edge rules

- **Target manager changes team:** existing assignment rows are never rewritten; list/candidate eligibility and unassign authority follow the manager's *current* effective team at authorization time. A leader who loses the manager from their team loses the ability to unassign that assignment.
- **Leader revoked:** `team_manager_assign` and `team` scope intervals end together; the leader immediately loses list/assign/unassign and Team Dashboard scope; history stays.
- **Future-dated / expired assignment:** future rows are listable but not "effective" (no runtime authority until `valid_from`); expired rows are history. Neither grants authority, and unassign must target an *effective* assignment (as today, E5/E6).
- **Project inactive:** assign/unassign rejected (`project is not active`, E6); candidate listing still allowed for active projects only.
- **Self-assignment:** allowed only when the leader is also an eligible effective member of that team.

### 2.7 Audit

Every leader mutation writes the actor's **actual** capability (`team_manager_assign`) and the **effective `team` scope** (`scope_kind='team'`, `scope_team_id`), never `entry_admin@all`. Catalog-operator mutations write `catalog_master_manage@all`. Admin keeps `entry_admin@all`. No fabricated capability rows.

### 2.8 Reuse vs replace (no parallel workflow)

Reuse unchanged: `direct_entry_assign_project_manager`, `_unassign_project_manager`, `_list_project_manager_assignments`, `_list/_get/_create/_update_project`, `_set_project_active`, the project revision/audit/idempotency chain, `direct_entry_restricted_reasons`, `direct_entry_audit_events`, `direct_entry_rpc_idempotency`. Only the guard inside them changes (E3/E4). Add: leader designate/revoke, Vendor lifecycle RPCs (E11: none exist), labor-type catalog + projection. Do **not** build a second RBAC, catalog framework or approval engine.

### 2.9 Labor-type lifecycle

Persist the stable keys `TEMPORARY`, `PERMANENT`, `OUTSOURCED` (display `Thời vụ`, `Chính thức`, `Gia công`). Required changes: widen the DB check (E9) and `direct_entry_reporting_employment_key` mapping; extend the TS `LaborType` union and `LABOR_TYPE_INVALID` validator (E10); add one catalog row source + active-value projection; switch Direct Entry input, Excel/CSV import+template and filters to consume that projection; unknown/inactive values fail closed on write while historical rows stay readable. `Gia công` must not imply Vendor, provider membership or team.

## 3. Migration sequencing from slot #67 (planned, not created)

1. `#67` — CAPABILITY CONTRACT BUMP: add `catalog_master_manage` + `team_manager_assign` to the TS registry and the DB/FE parity test; no behaviour change.
2. `#68` — CATALOG GUARD SPLIT: two-path project guard + `direct_entry_assert_team_manager_assign`; no RPC semantics change yet.
3. `#69` — LEADER DESIGNATE/REVOKE + team-scoped candidate/assignment projections (W01/W02).
4. `#70` — VENDOR LIFECYCLE RPCs (W02).
5. `#71` — LABOR-TYPE CATALOG + active-value projection + consumer switch (W02).
6. `#72` — ACCOUNT/GRANT/LINK admin backend, Admin-only (W03).
Each migration append-only after #66; no #1–#66 edit.

## 4. Minimum allowed/denied matrix for W01/W02/W03/W04/J01

| Case | Admin | Accounting | Team leader | Expected |
|---|---|---|---|---|
| Personnel/team/leader catalog mutation | allow | allow | deny | W01 |
| Project create/update/set-active | allow | allow | **deny** | W02 |
| Assign/unassign own-team effective member, any active project | allow | allow | allow | W02 |
| Assign/unassign cross-team or non-member manager | allow | allow | **deny** | W02/J01 |
| Candidate list | all | all | own team only | W02/W04 |
| Vendor create/rename/set-active | allow | allow | deny | W02 |
| Labor-type add/rename/order/deactivate | allow | allow | deny | W02 |
| Account enable/disable, grants/scopes, recruiter links | allow | **deny** | deny | W03/W05 |
| `entry_restore` | allow | deny by default | deny | W03 |
| Audit projection | all | catalog/worker events | own mutations | W03/W04 |
| Browser direct RPC call for another team | — | — | **deny server-side** | W04/J01 |
| Any mutation without reason/OCC/idempotency | deny | deny | deny | W01–W03 |

## 5. Remaining decisions for T0/Owner

1. **Token names** — accept `catalog_master_manage` + `team_manager_assign` (and the resulting 23-token contract) or choose different exact strings.
2. **Leader cardinality** — one active leader per team, or many (§2.4).
3. **Accounting + `entry_restore`** — the P3.1 plan leaves this conditional; default in this memo is **deny**.
4. **`OUTSOURCED` ordering/labels** — confirm stable keys and Vietnamese display strings, and whether Admin/Accounting may rename the *label* of `TEMPORARY`/`PERMANENT` (keys stay immutable).
5. **Vendor lifecycle data contract** — which fields are editable at go-live (display name only vs code/vendor_id).
6. **Migration split** — accept the six-step sequence in §3, or merge steps 1–2.

## 6. Boundary

No source change, no migration, no dependency, no Production mutation, no deploy, no browser/UAT. No PII, user UUID, email, credential or raw database error was read or printed; no Production query was needed for this survey. Only this memo is written.
