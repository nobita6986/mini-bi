# P3.1-W03-S0-R2 — Existing-user / grants / recruiter-links current-base security rebaseline (T1C docs-only)

> **Status:** `P3_1_W03_S0_R2_REBASELINE_PASS_AWAITING_T0_REVIEW`
> **Process:** docs-only rebaseline on top of the locked R1 memo. No source, test, migration, API, UI, `package.json` / dependency, `docs/P3.1.md` or other code change. No Production query/apply, no deploy, no browser/Playwright/CUA/UAT, no merge. The only tracked change for this rebaseline is the single documentation file at `docs/handoffs/p3-1-w03-s0-r2-access-security-rebaseline.md`. The working tree was clean at branch creation; only this file changes; the final commit is a fast-forward append on top of `origin/main@fc1c8b49`.
> **Base:** `origin/main@fc1c8b4958f0049631f62f37f57d34c0131cfba6` (81 migrations; `main` local is `4b93313` and is `0 ahead / 251 behind`).
> **Branch:** `audit/p3-1-w03-s0-r2-access-security-rebaseline`.
> **Worktree:** `C:\CodeApp\BI-p3-1-w03-s0-r2-access-security-rebaseline`.
> **Locked inheritance (R1):** R1 commit `244441ae...` is the source of truth for every authority, OCC, idempotency, marker, audit-vocabulary, lock-order, mutation-taxonomy and F-matrix row. R2 re-states nothing R1 already locked; R2 re-states only what the post-`1189c8a` reality on `main` (migrations #72–#81) requires. Where R1 said "R1 also corrects the R1-wrong claim that the schema permits multiple verified effective links per app user" and the like, R2 leaves the R1 wording in place because the underlying contract on `fc1c8b49` is unchanged.

This R2 rebaseline is a documentation pass only. It re-anchors the W03 design to the **current** `origin/main` tip (81 migrations, post-`1189c8a`) and answers the post-#71 factual changes one by one. It does **not** re-open R1, R2 of R1, R3, R4, R5, R6, R7 or any other R-round decision: those are locked and inherited verbatim. The R1 handoff remains the contract; this file is the **delta** between the R1 contract and the current `main`.

## 0. Why R2 is needed (and why it is docs-only)

The R1 handoff was based on `origin/main@1189c8a` (71 migrations, last `#71 = p3_1_w01d_team_leader_lifecycle`). The current `origin/main@fc1c8b49` has 81 migrations. Ten migrations (#72–#81) have landed since R1:

| Slot | Migration | Lane | R2 relevance |
|---|---|---|---|
| #72 | `20261009080000_p3_1_w02a_team_leader_project_manager_authority.sql` | **W02A** | W03D `own_manager` mode is now **directly satisfiable** by the W02A writer — see §1.1. |
| #73 | `20261009090000_p3_1_hf_recruiter_alias_backfill.sql` | hotfix | Recruiter-alias backfill trigger; W01B / W01C `recruiters` projection side-effect; no authority change. |
| #74 | `20261009100000_p3_1_hf_duplicate_cccd_reporting.sql` | hotfix | Reporting-side duplicate-CCCD surface; no authority contract change. |
| #75 | `20261009110000_p3_1_w02b_vendor_lifecycle.sql` | **W02B** | Vendor lifecycle. **Does not** touch W03 — vendor is independent of `direct_entry_app_users` / capabilities / scopes / links; see §1.2. |
| #76 | `20261009120000_p3_1_hf_legacy_team_leader_scope.sql` | hotfix | W01D `direct_entry_apply_team_leader_mutation` scope-only hotfix; preserved leader bundle contract. |
| #77 | `20261011100000_p3_1_hf_finite_membership_move.sql` | hotfix | W01C-B `direct_entry_move_team_membership` finite-membership hotfix; no W03 surface. |
| #78 | `20261011110000_p3_1_hf_membership_open_ended_successor.sql` | hotfix | W01C-B open-ended successor hotfix; no W03 surface. |
| #79 | `20261011120000_p3_1_w02c_labor_type_catalog.sql` | **W02C** | Labor-type catalog (`direct_entry_labor_types`); **does not** touch W03 — see §1.2. |
| #80 | `20261011130000_p3_1_w02c_r2_labor_type_display_projection.sql` | **W02C R2** | Labor-type display projection. |
| #81 | `20261011140000_p3_1_w02c_r3_own_draft_display_projection.sql` | **W02C R3** | Labor-type own-draft display projection. |

R1's W03 design already anticipated a future W02 `project_manager_assignment_*` audit verb pair and wrote the W03D `own_manager` filter to take them as an explicit action allowlist plus a "future scheduled-cancel verb joins by Owner decision" guard. R2 now confirms both verbs **exist** on `main` (`'project_manager_assignment_assign'`, `'project_manager_assignment_unassign'`, written by `direct_entry_assign_project_manager` / `direct_entry_unassign_project_manager` in #72), confirms W02A's audit row uses `scope_kind = 'team'` and `scope_team_id = <leader team>` on the `team_manager_assign@team` path (the `all` authority path keeps `scope_kind = 'all'`), and removes the R1 conditional "no separate cancel action exists in W02 source at `1189c8a`" wording as a forward-looking guard. W02B (#75), W02C (#79–#81) and W04-C vendor UI are independently verified to **not** change the W03 authority contract — see §1.2.

R1 reserved W03A's migration slot as "next available at the time of implementation; expected **#72** if no other migration has landed in the meantime". The reservation was permissive ("expected") and the R1 §9 "Locked in" block already said the W03 migrations start at "the next available number at the time of W03A implementation; no fixed second number is reserved" — i.e. R1 did **not** promise a fixed sequence `#72, #73, #74, #75, #76` for W03A–E. R2 **restates** that R1 rule, drops the R1 "expected #72" wording (it is now stale: the next available slot is **#82**), and **explicitly forbids** any pre-reservation of W03B / W03C / W03D / W03E slot numbers. See §2.

R2 also **does not re-open** R1's W03A–E lane contracts (§C.1–§C.5 of the R1 handoff) or the F-matrix / G.0 / G / H / I blocks. The R1 handoff is the contract; this file is the delta. If a future lane discovers a factual blocker, that is a future R3, not a silent scope change here.

## 1. Factual delta vs R1 (post-#71 → post-#81)

### 1.1 W02A (`#72`) directly satisfies the W03D `own_manager` allowlist contract

R1 §C.4 locked the W03D `own_manager` mode contract: the allowlist is exactly `('project_manager_assignment_assign','project_manager_assignment_unassign')` plus any W02 scheduled-cancel action "only if W02 actually writes one" (R1 called this a forward-looking guard because no such action existed in the W02 source at `1189c8a`). R1 also locked that the `own_manager` filter is `action = ANY(<allowlist>) AND scope_team_id = caller effective team`, and that W02 writers **must** record `scope_kind = 'team'` and `scope_team_id = <leader team>` whenever the exercised authority is `team_manager_assign@team`, with the `all` authority path keeping `scope_kind = 'all'`.

R2 verifies on `fc1c8b49` that the W02A migration `supabase/migrations/20261009080000_p3_1_w02a_team_leader_project_manager_authority.sql` already writes both verbs with the correct scope classification. The audit insert is:

```text
insert into public.direct_entry_audit_events
  (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
   scope_team_id, outcome, reason_id, changed_fields, project_revision_id)
values
  (p_auth_subject, p_app_user_id, 'project_manager_assignment_assign',
   v_authority, v_assignment_id::text,
   case when v_authority = 'team_manager_assign' then 'team' else 'all' end,
   case when v_authority = 'team_manager_assign' then v_team_id else null end,
   'APPLIED', v_reason_id,
   array['project_id', 'manager_recruiter_id', 'valid_from'], v_revision_id);
```

The unassign path writes `'project_manager_assignment_unassign'` with the same `case when v_authority = 'team_manager_assign' then 'team' else 'all' end` and `case when v_authority = 'team_manager_assign' then v_team_id else null end` shape. **Both verbs exist; both record the team classification on the `team_manager_assign@team` path; the `all` path keeps `scope_kind = 'all'`.** The W03D `own_manager` filter is therefore now implementable as a single SQL predicate; the W03D lane needs **no W02-side change** to assert the team-scoped manager-assignment explorer.

The R1 forward-looking guard "W02 scheduled-cancel action only if W02 actually writes one" is verified: no `'project_manager_assignment_cancel'` / `'project_manager_assignment_scheduled_cancel'` / similar verb exists in W02 source on `fc1c8b49` (the W02A action set is exactly `assign` + `unassign`; no `cancel` verb appears anywhere in `#72`). R2 **keeps the R1 forward-looking guard** ("a future scheduled-cancel verb joins this allowlist only after its writer lands and by Owner/T0 decision — it is never inferred") verbatim, so the W03D implementation still has a one-line allowance for a future scheduled-cancel verb but does not pre-reserve it.

**R2 finding:** the W03D `own_manager` allowlist is implementable today from the W02A writer; the W03D lane can run its regression against the W02A audit rows; no W02-side change is needed. The R1 wording "W03D's `own_manager` mode cannot be asserted as team-scoped until W02 records `scope_kind = 'team'` …" in §I.2 is now **retired**; the R2 wording is "W03D's `own_manager` mode is team-scoped because the W02A writer already records `scope_kind = 'team'` and `scope_team_id = <leader team>` on the `team_manager_assign@team` path, and the W02A writer keeps `scope_kind = 'all'` on the `entry_admin@all` path". The R1 §C.4 contract (the `own_manager` allowlist is exactly `('project_manager_assignment_assign','project_manager_assignment_unassign')` plus any future Owner-approved scheduled-cancel verb) is preserved.

### 1.2 W02B, W02C, W04-C do not change the W03 authority contract

R2 inspected every migration #72–#81 for a write to any of: `direct_entry_app_users` (the W03A OCC root), `direct_entry_app_user_revisions` (R3 schema delta), `direct_entry_capability_grants` (W03B), `direct_entry_scope_grants` (W03B), `direct_entry_app_user_recruiter_links` (W03C), `direct_entry_team_leader_assignments` (W01D / R5 FIX 5), `direct_entry_audit_events` W03A/B/C/E action vocabulary, and the `direct_entry.team_leader_marker` GUC. The findings are:

- **#72 W02A** writes `direct_entry_audit_events` with the two PM verbs (already covered by §1.1; the audit row uses the existing W01A column set; the action vocabulary does not overlap the W03 eight-verb set; `app_user_revision_id` is null on these rows; the `direct_entry.team_leader_marker` GUC is not set). No write to any W03A/B/C/E-managed table.
- **#73 hf_recruiter_alias_backfill** writes `recruiters.alias` only; the trigger is a per-row alias-derivation helper, no `direct_entry_app_users` / capability / scope / link write, no leader bundle write, no GUC.
- **#74 hf_duplicate_cccd_reporting** is a reporting-side patch; it touches `direct_entry_audit_events` read paths and a reporting projection, no capability / scope / link write, no `direct_entry_app_users` write, no leader bundle write. (The hotfix does reuse the W01A `entry_admin`-style authority chain for its own reporting view; that surface is independent of W03.)
- **#75 W02B** introduces `direct_entry_vendor_revisions` and Vendor lifecycle RPCs. Vendor is a `vendors` / `recruiters` (Vendor representation) / `recruiter_provider_memberships.vendor_id` surface that is **independent of `direct_entry_app_users`, `direct_entry_capability_grants`, `direct_entry_scope_grants`, `direct_entry_app_user_recruiter_links` and `direct_entry_team_leader_assignments`**. The migration does reference `__system_vendor__` for the W01C-A reserved system-team guard, which is the **same** reserved-code pattern W03B `direct_entry_grant_scope` already rejects (`23514`, R1 §C.2 grant-scope text). W02B does not change the W03B reserved-team guard; R1 §C.2 remains correct.
- **#76 hf_legacy_team_leader_scope** is a `direct_entry_apply_team_leader_mutation` source-patch that **preserves** the W01D leader-bundle contract; it tightens the legacy `team` scope guard inside the W01D RPC, it does not introduce a new capability, scope or app-user write, it does not change the `direct_entry.team_leader_marker` GUC semantics, and it does not touch the W03C link-revoke precheck. R1 §C.3 (FIX 5 leader-bundle protection; R7 FIX G current-or-scheduled predicate) and R1 §A.5 step 1 footnote (W03C does not lock the team aggregate row) remain correct.
- **#77 hf_finite_membership_move** patches `direct_entry_move_team_membership` for the W01C-B finite-membership case; no W03 surface touched.
- **#78 hf_membership_open_ended_successor** patches `direct_entry_move_team_membership` for the W01C-B open-ended-successor case; no W03 surface touched.
- **#79 W02C** introduces `direct_entry_labor_types` (`labor_type_key`, `display_name`, `reporting_key`, `sort_order`, `active`, audit columns), labor-type lifecycle RPCs and a labor-type options projection. Labor-type is a **catalog attribute of `direct_entries`** (the persisted `labor_type` column), not an app-user / capability / scope / link / leader attribute. W02C does not write `direct_entry_app_users`, `direct_entry_app_user_revisions`, `direct_entry_capability_grants`, `direct_entry_scope_grants`, `direct_entry_app_user_recruiter_links` or `direct_entry_team_leader_assignments`. The 23-token capability CHECK is not extended by W02C. R1 §A.2 (23-token contract) and R1 §A.3 (capability / scope / link tables) remain correct.
- **#80 W02C R2** patches `direct_entry_list_own_drafts` and the labor-type options projection; the W01A / W03A-E vocabulary is not touched.
- **#81 W02C R3** patches `direct_entry_list_own_drafts` and the labor-type options projection; the W01A / W03A-E vocabulary is not touched.
- **W04-C vendor UI** is a UI-only handoff (`docs/handoffs/p3-1-w04-c-vendor-catalog-ui.md`); it adds a `/admin/catalog/vendors` page reusing the W02-B Vendor Catalog projection (#75). It uses the existing `catalog_master_manage@all OR Full Admin` Admin-area decision (W01A vocabulary, not W03). It writes no capability, scope, link, leader or app-user row. R1 §D (reuse map) and the W03A-E lane contracts remain correct.

**R2 finding:** no factual blocker in #72–#81 or in W04-C requires a W03 authority-contract change. R1 §A, §B, §C, §D, §F, §G, §H, §I remain correct on `fc1c8b49`. The R1 forward-looking "W02 writers must record `scope_kind = 'team'` and `scope_team_id = <leader team>` …" wording in §C.4 is now **retired** because the W02A writer already does it (see §1.1); the R2 wording is the W02A-actual contract.

### 1.3 The `#67` → `#81` migration count is reflected in inventory / preflight

R1 §A.7 noted "71 migrations; #71 = `20261009070000_p3_1_w01d_team_leader_lifecycle.sql` is last; #72 does not exist". R2 updates the count to **81 migrations; #81 = `20261011140000_p3_1_w02c_r3_own_draft_display_projection.sql` is last; #82 is the next available slot for W03A**. The W03F / J01 preflight will measure against 81 (not 71); the `direct_entry_*` function inventory guard (e.g. the W01C-A `146/70/76` triple) has already been bumped by the lanes that landed #72–#81 (the W02B, W02C and hotfix lanes bumped the function-inventory guard as part of their own rebaseline). R2 does **not** restate those numbers — they are the W02B / W02C lanes' contract; W03 preflight measures the current count and asserts the expected W03 functions on top.

### 1.4 The R1 forward-looking "W02 scheduled-cancel" guard

R1 §C.4 wrote "plus the W02 scheduled-cancel action **only if W02 actually writes one** (no separate cancel action exists in W02 source at `1189c8a`; a future W02 cancel action joins the allowlist by Owner/T0 decision, never silently)." R2 keeps that guard: no `cancel` verb exists in W02 source on `fc1c8b49`; the W02A action set is exactly `assign` + `unassign`. The W03D `own_manager` allowlist therefore remains `('project_manager_assignment_assign','project_manager_assignment_unassign')` plus any future Owner-approved scheduled-cancel verb that may be added by an explicit W02 follow-up. R2 does **not** add the verb and does **not** infer a verb.

### 1.5 The R1 forward-looking "W03A expected #72" wording is retired

R1 §9 wrote "W03 migrations start at the next available number at the time of W03A implementation (expected **#72** if no other migration has landed in the meantime); no fixed second number is reserved". The "expected #72" parenthetical is now stale: ten migrations have landed in the meantime, the next available slot is **#82**, and R1 already said "no fixed second number is reserved" so the parenthetical was always a hint, never a reservation. R2 retires the "expected #72" hint; the next-available rule and the no-fixed-second-number rule remain locked. See §2 for the W03A-only-next-slot rule and the W03B-E no-reservation rule.

## 2. Migration-slot rule (locked for R2; W03A–E)

The migration-slot rule for the W03 lanes is locked as follows and is **the only place in P3.1 where migration numbers are mentioned for W03**:

- **W03A uses the next available migration number at the time of W03A implementation.** On `fc1c8b49` (the R2 base) the next available slot is **#82**. R2 records this as a current-base observation; it is not a reservation. If a different lane lands a migration between R2 review and W03A implementation, the next-available slot at W03A implementation time is the slot W03A takes. W03A **does not** reserve any other slot in advance.
- **W03B / W03C / W03D / W03E do not reserve a fixed slot number.** Their slot is the next available at their respective implementation time, independent of W03A's slot, independent of each other, and may interleave with non-W03 migrations. The R1 §E "Proposed W03 sequencing" is **logical order only**, not a migration-number contract.
- **W03A–E do not pre-create stub files or placeholders for future slots.** Each W03 migration is a cohesive, replay-safe, append-only work package (R1 §C.1 / §C.2 / §C.3 / §C.4 / §C.5 each have the schema-delta block for their own migration; the R1 §I.2 blockers list the per-lane prerequisites).
- **R2 retires every "expected #72" / "next available if no other migration has landed" / per-lane slot wording that is not this rule.** R1 §9 and the W03A row of R1 §E still have the "next available at implementation" wording; that wording is correct under this rule and is preserved.

## 3. W03A–E lane boundary (locked for R2; pointer to R1 for full contract)

The R1 handoff's §C.1–§C.5 are the contracts. R2 restates the lane boundary only, in one table, so the post-#71 reader can navigate. **No contract row in R1 is changed by R2.**

| Lane | Resource scope | W03A/B/C/E / W03D / W03F dependence | Migration slot | Implementation owner | Test lane (focused) |
|---|---|---|---|---|---|
| **W03A** | `direct_entry_app_users` only. Adds `version integer default 1 check (version >= 1)`, `updated_at timestamptz default now()`, the new `direct_entry_app_user_revisions` table (eight-verb `action` CHECK, four-key envelope, forced RLS, no role privilege, unique `(app_user_id, version)`), the new `direct_entry_audit_events.app_user_revision_id` FK. Two RPCs: `direct_entry_enable_app_user`, `direct_entry_disable_app_user`. W03A does **not** cascade to capability / scope / link / leader rows; the disabled state is enforced by the next actor resolution (W08A). | None upstream; W03B / W03C / W03D / W03E all depend on the W03A `version` OCC root, the eight-verb audit vocabulary and the `app_user_revision_id` FK. | next available at W03A implementation (currently #82) | T1B | `scripts/p3-1-w03a-app-user-lifecycle-db.test.mjs` |
| **W03B** | `direct_entry_capability_grants` (grant / revoke) and `direct_entry_scope_grants` (grant / revoke). Capability and scope are **separate RPCs**; capability RPCs do not take `scope_kind` / `team_id`; scope RPCs do. Reuses the §A.5 lock order and the W01D `direct_entry_team_leader_marker()` trigger; reuses the W01D partial marker-excluding indexes; reuses the W01D `direct_entry_assert_actor_app_user_admin` helper. Rejects `team_manager_assign` and leader-bundle `team` scope mutations with `42501 'security mutation is owned by the leader lifecycle RPC'`. Rejects the reserved `__system_vendor__` team with `23514`. | W03A (OCC root, eight-verb audit, post-lock actor-authority recheck); W01A (23-token capability CHECK + REQUIRED_SCOPE_KIND map); W01D (lock order, partial marker-excluding indexes, marker trigger function, leader-bundle exclusivity); W01C-A (reserved-team guard). | next available at W03B implementation; no W03A–W03B bundle | T1B | `scripts/p3-1-w03b-capability-scope-lifecycle-db.test.mjs` |
| **W03C** | `direct_entry_app_user_recruiter_links` (create verified / revoke). Minimal schema delta: widen link CHECK to `valid_to >= valid_from`; install the **existing** `direct_entry_team_leader_marker()` trigger on the link table; no partial verified-effective unique index (the foundation `direct_entry_recruiter_link_no_overlap` trigger is the cardinality guard; partial unique indexes cannot be conditioned on the current date). Revoke takes `p_link_id`; refuses to break a **current-or-scheduled** leader assignment (R1 R7 FIX G predicate; R1 §C.3 verbatim). | W03A (OCC root, eight-verb audit); W01A (REQUIRED_SCOPE_KIND); W01D (lock order, marker trigger function, leader bundle); W01C-A (reserved-team guard, indirect). | next available at W03C implementation; no W03A–W03C bundle | T1B | `scripts/p3-1-w03c-verified-link-lifecycle-db.test.mjs` |
| **W03D** | Bounded audit projection RPCs by mode (`full` / `catalog` / `own_manager`). `full` is Admin-only Full Admin triple at `all`; `catalog` is `catalog_master_manage@all` with an explicit exact `action` allowlist (no `LIKE` / wildcards) and the security slice excluded; `own_manager` is `team_manager_assign@team` and the allowlist is exactly `('project_manager_assignment_assign','project_manager_assignment_unassign')` plus any future Owner-approved scheduled-cancel verb (none today; see §1.1 and §1.4). The W03D lane must run its regression against the W02A audit rows because the W02A writer already records `scope_kind = 'team'` and `scope_team_id = <leader team>` on the `team_manager_assign@team` path. | W03A (eight-verb audit vocabulary; `app_user_revision_id` FK); W01A (REQUIRED_SCOPE_KIND; `audit_view` capability); W02A (the writer of the W03D `own_manager` allowlist verbs, verified in §1.1). | next available at W03D implementation; no W03A–W03D bundle | T1B | `scripts/p3-1-w03d-audit-projection-db.test.mjs` |
| **W03E** | Single Direct Entry row restore (soft-deleted, DRAFT parent submission). Adds `entry_restore: "all"` to `REQUIRED_SCOPE_KIND`. Bumps `direct-entry-auth` contract `1.3` → `1.4` (the W01A v1.3 compatibility fixture remains green). Single RPC `direct_entry_restore_entry(p_auth_subject, p_actor_app_user_id, p_entry_id, p_expected_entry_version integer, p_reason text, p_idempotency_key text)` — no `p_target_app_user_id` because the entry is the only target; restore sets `deleted_at = NULL`, bumps entry `version + 1`, appends one `direct_entry_revisions` row, one `direct_entry_audit_events` row (`revision_id` to the Direct Entry entry, not the `app_user_revision_id`), one idempotency row. W03E does **not** mutate capability / scope / link / leader rows; it does **not** revert a W01D revoke, a W03A disable, a W03B revoke or a W03C revoke. | W01A (REQUIRED_SCOPE_KIND bump; contract bump); the entry-level revision / OCC / idempotency foundation (already in `direct_entry_*` from #1–#66). | next available at W03E implementation; no W03A–W03E bundle | T1B | `scripts/p3-1-w03e-entry-restore-db.test.mjs` |
| **W03F** | Combined session-revocation regression. W08A `createDirectEntryActorRepository` is the only producer; the resolver is service-role-only; no in-memory cache; concurrent resolves of the same actor cannot return mixed stale/fresh state. W03F adds regression cases for: disable mid-resolve, capability revoke (normal close or audited marker) mid-resolve, verified-link revoke (normal close or audited marker) on enabled or disabled target mid-resolve, `getDirectEntryActor` denial parity. W03F does **not** introduce a parallel session framework. | W03A, W03B, W03C, W03E (every W03 mutation rechecked under W08A freshness); W08A (the existing lane, not a new contract). | next available at W03F implementation; W03F is a regression lane, may share migration with another W03 lane if there is no schema delta. | T1C (regression) | `src/lib/auth/p3-w08a-session-revocation-cache.test.mjs` + W03F-focused cases. |
| **J01** | Readiness audit. Asserts every W03 lane passed focused + integration; asserts the preflight counts (see R1 §H); signs off W03A–F together. | All of W03. | no migration (J01 is a verification artifact) | T1C | J01 readiness memo. |

**Closed scope for W03A–E (carried from R1 §I.3 verbatim, retested against #72–#81):**

- Invitation workflow (email, link, code, expiry) — **P3.2**.
- Initial password / forced reset / self-service password change — **P3.2**.
- MFA enrolment, challenge, recovery codes — **P3.2**.
- Account recovery (lost-password, locked-out, deleted-account re-creation) — **P3.2**.
- `auth.users.email` change workflow — Supabase Auth, not Direct Entry.
- A "default password" of any kind (no `hrp@123` or any other shared default) — **P3.2**, and W03 has no password surface at all.
- A new RBAC framework, a new ORM, a new generic CRUD engine, a parallel audit system — **none**.

R2 retests the closed-scope list against the migration history #72–#81: no new table, RPC, API route, capability token, scope kind, GUC, migration-inventory guard, handoff or `package.json` change in #72–#81 introduces a P3.2 surface or a parallel framework. The closed-scope list remains correct.

## 4. W03A–E dependency graph (locked for R2)

```
W01A  capability contract foundation (v1.3) ──> W03A ──> W03B
W01A  REQUIRED_SCOPE_KIND                      │        W03C
W01A  direct-entry-auth contract               │        W03D  (reads W02A audit rows)
                                               │        W03E  (bump v1.3 -> v1.4, REQUIRED_SCOPE_KIND += entry_restore = all)
W01D  leader bundle (designate / replace / revoke) ──┐
W01D  direct_entry_team_leader_marker() trigger ─────┤
W01D  partial marker-excluding indexes (capability, scope) ─┤
W01D  lock order (W01D §A.5) ──────────────────────────────┘
W01C-A reserved-team guard (__system_vendor__) ─────────────> W03B (rejects __system_vendor__ team)
W02A  project_manager_assignment_{assign,unassign} audit verb + scope_kind='team' / scope_team_id=<leader team> on team_manager_assign@team path ──> W03D own_manager
W08A  session-revocation contract (no in-memory cache, request-time resolve) ──> W03F
J00   security regression baseline ──> (information carrier only; no code dep)
P3.2  invitation / password / reset / recovery / MFA (OUT OF P3.1) ──> (boundary, no W03 deps)
```

**W03A–E inter-lane dependency** (this is the only "W03-internal" dependency that R2 locks):

- W03A is the **only** W03 lane that touches `direct_entry_app_users` and `direct_entry_app_user_revisions`. W03B, W03C, W03D, W03E all assume W03A has landed (they need the `version` OCC root, the eight-verb audit vocabulary, the `app_user_revision_id` FK and the `direct_entry_assert_actor_app_user_admin` helper).
- W03B and W03C are **independent** of each other (different tables, different RPCs) but each needs W03A. W03B does **not** need W03C and W03C does **not** need W03B.
- W03D needs W03A (audit vocabulary) and **W02A** (the writer of the `own_manager` allowlist verbs; see §1.1). W03D does **not** need W03B / W03C.
- W03E needs W01A (REQUIRED_SCOPE_KIND bump; contract bump `1.3` → `1.4`); W03E does **not** need W03A / W03B / W03C / W03D (the entry-level OCC / revision / idempotency foundation is already in `direct_entry_*` from #1–#66 and is unchanged by W03A–D).
- W03F needs W08A (already on `main`) and W03A / W03B / W03C / W03E (every W03 mutation rechecked under W08A freshness). W03F is a regression lane; it does **not** introduce a schema delta.
- J01 needs every W03 lane passed and the W08A freshness lane green; J01 is a verification artifact, not a migration.

**Hard ordering rules for R2:**

- W03A must land **before** W03B / W03C / W03D. W03E is **independent** of W03A in code (it is the entry-level restore) but the W03E contract bump **must** land in the same W03E migration (R1 §C.5: "the contract bump `1.3 → 1.4` is locked at R3 … lands the scope change and the contract bump together"). R2 confirms the W03E contract-bump rule.
- W03B / W03C may land in any order relative to each other (independent tables).
- W03F may land as soon as W03A, W03B, W03C and W03E have landed; W03F reuses W08A.
- J01 runs only after W03A, W03B, W03C, W03D, W03E, W03F have all landed and passed focused regression.
- **No W03 lane may land on a branch that has not first rebased onto the W01D `main` (or its post-#71 successor).** R1 locked this; R2 retests the rule on `fc1c8b49` and confirms it is still correct: the W01D `direct_entry_team_leader_marker()` trigger function, the partial marker-excluding indexes, the atomic leader-bundle RPC and the `direct_entry_assert_actor_app_user_admin` helper are all present on `fc1c8b49` (none of the post-#71 migrations removed them; #76 only tightens the W01D RPC's legacy `team` scope guard, preserving the trigger function and partial-index semantics).

## 5. Acceptance / mutation matrix (locked for R2; pointer to R1 §F)

R1 §F is the F-matrix (allowed / denied test matrix). R2 retests the F-matrix against `fc1c8b49` and the post-#71 reality and **does not change a single row**. The R1 §F matrix already says:

- The W03A rows (enable / disable allowed for Admin, denied for Accounting / leader / others) are unchanged; the W03A "actor and target distinct-row lock" semantics (R1 R6 FIX E) and the "W03A does not cascade to capability / scope / link / leader rows" rule remain correct.
- The W03B rows (capability / scope grant / revoke allowed for Admin, denied for Accounting / leader / others) are unchanged; the "grant into a disabled target is `42501`; revoke on a disabled target is allowed" (R1 R5 FIX 4) split remains correct; the "leader-bundle denial" rule remains correct; the "three-branch cancellation" rule (R1 R5 FIX 1) remains correct; the "backdate is `22023`, never a marker" rule remains correct.
- The W03C rows (link create / revoke allowed for Admin, denied for others) are unchanged; the "current-or-scheduled leader precheck" (R1 R7 FIX G predicate) remains correct; the "historical leader is not a basis" rule remains correct; the "marker leader is not a basis" rule remains correct; the "scheduled-leader-bundle-link-revoke-deny" test (R1 R7 addition) remains correct.
- The W03D rows (audit explorer by mode) are unchanged in semantics; the W03D `own_manager` allowlist is now exactly `('project_manager_assignment_assign','project_manager_assignment_unassign')` plus a future Owner-approved scheduled-cancel verb (§1.1, §1.4) — R1 §C.4 wording is preserved, the allowlist itself is unchanged because R1 already specified the two-verb allowlist.
- The W03E rows (`entry_restore` allowed only for Full Admin triple at `all`) are unchanged; the "restore sets `deleted_at = NULL` on a soft-deleted DRAFT Direct Entry row" contract remains correct; the "no `p_target_app_user_id`" signature remains correct; the "W03E does not revert W01D / W03A / W03B / W03C" rule remains correct.

**R2 retest summary:** the F-matrix is implementable as written on `fc1c8b49`. No row needs to be added, changed or removed. R2 confirms the R1 §F test plan and adds no new matrix row.

## 6. Allowed / denied matrix (locked for R2; pointer to R1 §B and P3.1 §2)

R1 §B and `docs/P3.1.md` §2 are the authority boundaries. R2 retests against `fc1c8b49`:

- The 23-token vocabulary is unchanged (R1 §A.2; W01A `#67` is still the source of truth on `fc1c8b49`; W02B, W02C, hotfix migrations do not add a token).
- The Full Admin triple (`entry_admin` AND `recruiter_master_manage` AND `team_master_manage` at `all`) is unchanged.
- The narrow `catalog_master_manage@all` is unchanged (it gates W04 catalog UI, not W03; W03A–E all require the Full Admin triple + `all`).
- The narrow `team_manager_assign@team` is unchanged (it gates W02A leader-scoped project-manager assignment; W03D `own_manager` reads the W02A audit rows filtered by this authority).
- The W03A row "Full Admin: allow; Accounting: deny; leader: deny; others: deny" is unchanged.
- The W03B / W03C / W03E row pattern is unchanged.
- The W03D `full` / `catalog` / `own_manager` mode authority requirements are unchanged (Full Admin triple at `all`; `catalog_master_manage@all`; `team_manager_assign@team` respectively).
- P3.2 surfaces (invitation, password, reset, recovery, MFA) are not in the W03 matrix — they are out of P3.1 entirely (P3.1 §1, R1 §I.3, this file §3 closed-scope list).

**R2 retest summary:** the allowed / denied matrix is unchanged. R1 §B and P3.1 §2 are the contract.

## 7. Authority, OCC, idempotency, effective-date / marker semantics, audit redaction, session freshness

R1 §A, §A.2, §A.3, §A.4, §A.5, §A.6, §C.1, §C.2, §C.2.1, §C.3, §C.4, §C.5, §F, §G, §G.0, §H and §I are the contracts. R2 retests each on `fc1c8b49`:

- **Authority** (§A.2, §A.3, §C.1, §C.2, §C.3, §C.5, §B). The `direct_entry_assert_actor_app_user_admin` helper is the Full Admin triple + `all` recheck under lock; the helper is unchanged. R1 §C.2.1 step 6 (post-lock actor-authority recheck) is the contract. R2 confirms no post-#71 migration changed the helper or its recheck order. The W03D `own_manager` mode is now a reader over the W02A audit rows (§1.1); the writer authority is W02A's existing `entry_admin@all` / `team_manager_assign@team` predicate, unchanged.
- **OCC** (§C.1, §C.2, §C.3, §C.5, §A.5, §F). The W03 OCC root is `direct_entry_app_users.version` with `expected_app_user_version`; the W03E OCC root is the entry's `version` with `expected_entry_version`. R1 §A.5 step 3 (OCC compare) and §F (OCC-loser returns `40001 version_conflict`) are unchanged. R2 confirms no post-#71 migration added an OCC substitute or removed the version compare.
- **Idempotency** (§C.1, §C.2, §C.3, §C.5, §A.5 step 2). `direct_entry_rpc_idempotency` is unchanged; every W03 RPC writes one idempotency row per (kind, key) and replays return the original result without bumping `version` twice. R2 confirms the table and the replay contract are unchanged on `fc1c8b49`.
- **Effective-date / marker semantics** (§A.1 P1–P4, §C.2 three-branch, §C.3 three-branch, §C.3 R5 FIX 5 + R7 FIX G). The `#71` marker trigger function (`direct_entry_team_leader_marker()`) is unchanged; the partial marker-excluding indexes are unchanged; the three-branch rule (`backdate → 22023`, `same-day → audited marker`, `normal close → valid_to = effective_date`) is unchanged. The R1 R7 FIX G current-or-scheduled predicate is unchanged. R2 confirms the marker trigger function is still installed on `direct_entry_team_leader_assignments`, `direct_entry_scope_grants` and `direct_entry_capability_grants` (R1 §A.1 P3) and that W03C will install it on the link table in its own migration.
- **Audit redaction** (§C.1, §C.4, §F). Audit `capability = 'entry_admin'` is the exercised authority; the target mutation data lives in the bounded revision snapshot with exactly four fixed keys (`target_app_user_id`, `changed`, `interval`, `actor_app_user_id`) — no `auth_subject`, no email, no PII. The W03D bounded projection strips `auth_subject`, the actor `app_user_id` (other than the caller), the reason text and any PII. R2 confirms the audit vocabulary (eight-verb for W03A/B/C, `entry_restore` for W03E) and the redaction rules are unchanged. R2 also confirms the W02A `direct_entry_audit_events` rows for `project_manager_assignment_*` do not carry the W03A/B/C/E action vocabulary (they are separate verbs in the same column; the W03D mode allowlists filter them out of the security slice and include them only in `own_manager`).
- **Session freshness** (§A.4, §C.6 / W03F). W08A invariants (no in-memory actor cache, concurrent resolves of the same actor cannot return mixed stale/fresh state, cookie refresh does not skip the live check, `createDirectEntryActorRepository` is the only producer, the resolver is service-role-only, page decisions are request-time) are unchanged. The W03F regression cases are unchanged.

**R2 retest summary:** every contract surface is unchanged on `fc1c8b49`. R1 is the contract; R2 retests it and confirms.

## 8. W02C / W04-C relationship to the W03 authority contract (factual verification)

R1 was written before W02C and W04-C landed. R2 re-asks the question on `fc1c8b49`: do W02C (`#79`–`#81`) or W04-C vendor UI (`docs/handoffs/p3-1-w04-c-vendor-catalog-ui.md`) change the W03 authority contract?

- **W02C** introduces `direct_entry_labor_types` (catalog attribute of `direct_entries.labor_type`) and labor-type lifecycle RPCs. The migration does not write `direct_entry_app_users`, `direct_entry_app_user_revisions`, `direct_entry_capability_grants`, `direct_entry_scope_grants`, `direct_entry_app_user_recruiter_links` or `direct_entry_team_leader_assignments`. The 23-token capability CHECK is not extended. The W02C audit action vocabulary (whatever W02C writes for the labor-type lifecycle) is a separate verb set; the W03D mode allowlists do not include W02C verbs (the W03D `catalog` mode allowlist is catalog and worker events; the W03D `own_manager` mode allowlist is exactly the W02A PM verbs). **W02C does not change the W03 authority contract.**
- **W04-C vendor UI** is a UI-only handoff. It reuses the W02B Vendor Catalog projection (#75) and the W01A `catalog_master_manage@all` / Full Admin authority. It writes no capability, scope, link, leader or app-user row. The W04-C navigator entry is a new "Nhà cung cấp" Admin item; it is gated by the same Admin-area decision as the other W04 catalog pages. **W04-C does not change the W03 authority contract.**

**R2 finding:** no W02C / W04-C factual blocker requires a W03 change. R1 §A, §B, §C, §D, §F, §G, §H, §I are correct on `fc1c8b49` for the W02C / W04-C relationship.

## 9. Gates and tooling

R1 §H preflight is the preflight. R2 retests the preflight on `fc1c8b49`:

- Migration count: **81** (was 71 at R1 base `1189c8a`); #81 is `20261011140000_p3_1_w02c_r3_own_draft_display_projection.sql`; the next available slot is **#82**.
- Direct Entry function inventory guard: bumped by the W02B / W02C / hotfix lanes that landed #72–#81. W03 preflight measures the current count.
- Authority holders: unchanged from R1. `entry_restore_full_admin_holder_count` is still at least `1` (the bootstrap script grants every `CAPABILITIES` token including the Full Admin triple plus `all`).
- W02A PM-assignment audit rows: now present; W03D `own_manager` regression can run against them.
- ACL integrity: `EXECUTE` on every W03 RPC is `service_role` only; every W03 table is forced RLS; no role privilege; `search_path = pg_catalog, public`. R2 confirms no post-#71 migration added a W03 surface that violates this.
- P3.2 boundary: no W03 surface exposes `auth.users.email`, no W03 surface exposes a default password, no W03 surface exposes an invitation token, no W03 surface exposes an MFA challenge. R2 confirms.

**R2 retest summary:** the preflight is implementable as written; the migration-count and W02A-audit-row facts are updated; no other row needs to change.

## 10. Risks and blockers (R2 update)

R1 §I.1 and §I.2 are the risk / blocker list. R2 retests on `fc1c8b49`:

- **R1 §I.1 risks** are unchanged: no app-user OCC today (still true; W03A brings it), bootstrap is privileged operational code (unchanged), legacy Accounting grant (unchanged), W05A seed revoked (unchanged — W01D #71 already revoked the seed `EXECUTE` from every role; no post-#71 migration re-granted it), audit RPC too broad (unchanged — W03D `direct_entry_read_security_audit` replaces the raw RPC), marker support asymmetric (unchanged — R1 R7 FIX G is the contract), link cardinality (unchanged — foundation trigger is still the cardinality guard), PII / account identification bounded (unchanged), no migration numbers / Production facts (still true; the next available is **#82**, not the R1 "expected #72" hint).
- **R1 §I.2 blockers** are updated only by retest, not by new content: T0 must accept the W01D #71 surface as final (it is on `fc1c8b49`); W03A cannot land before the W01A capability contract is at `direct-entry-auth/1.3` (it is); W03B cannot land before the W01D marker trigger is on `direct_entry_capability_grants` and `direct_entry_scope_grants` (it is); W03C cannot land before the W01D designate write is the only writer of leader-bundle rows (it is — #76 only tightens the legacy `team` scope guard, preserving the only-writer invariant) and before the W01D leader-read path is locked to the persisted-FK join (it is); W03D can now assert its `own_manager` mode as team-scoped against the W02A audit rows (the W02-side change is in place; see §1.1); W03E can land as soon as the W01A `REQUIRED_SCOPE_KIND` map is updated to include `entry_restore = all` and the contract is bumped from `direct-entry-auth/1.3` to `direct-entry-auth/1.4`; W03F / J01 is the combined regression and readiness audit, run after T0 accepts W03A–E.
- **R2 new factual notes (not new risks):**
    1. The W03A next slot is **#82** on `fc1c8b49`; R2 retires the R1 "expected #72" hint. No pre-reservation of W03B / W03C / W03D / W03E slots.
    2. The W03D `own_manager` regression is now exercisable against the W02A audit rows; R2 retires the R1 "W03D's `own_manager` mode cannot be asserted as team-scoped until W02 records …" wording.
    3. W02B / W02C / W04-C are independent of the W03 authority contract; R2 confirms this with a per-migration write-target inspection (see §1.2).
- **No new P3.2 surface** is introduced by #72–#81 or by W04-C. The R1 §I.3 P3.2 boundary list is unchanged.

## 11. Out of scope for R2 (locked)

R2 does **not**:

- Re-open R1, R2-of-R1, R3, R4, R5, R6 or R7 of the W03 handoff. R1 is the contract; R2 is the delta.
- Open any W03 implementation work (no source, no migration, no RPC, no API, no UI, no test lane, no `package.json` change).
- Reserve migration numbers for W03B / W03C / W03D / W03E.
- Add a capability, scope, link or app-user row.
- Touch `auth.users`, the Supabase Auth boundary, the invitation path, the password / reset / recovery path, or the MFA path.
- Modify `docs/P3.1.md` (R2 inherits the P3.1 master as the contract for the W03 lane scope and acceptance).
- Run a `pnpm test`, a `pnpm docs:check` or a `pnpm secrets:check` against Production or against a `pnpm install` — R2 is docs-only. The R2 working tree contains the single handoff file and nothing else.
- Force-push, amend, rebase, reset, clean, or rewrite history. R2 appends one commit on top of `fc1c8b49` and pushes fast-forward only.

## 12. Lane status (R2)

- `W03A`: not started; R1 contract locked; next migration slot #82; W1B owner.
- `W03B`: not started; R1 contract locked; no reserved slot; W1B owner.
- `W03C`: not started; R1 contract locked; no reserved slot; W1B owner.
- `W03D`: not started; R1 contract locked; no reserved slot; W1B owner; `own_manager` regression now exercisable against W02A audit rows (see §1.1).
- `W03E`: not started; R1 contract locked; no reserved slot; W1B owner; contract-bump `1.3 → 1.4` is part of the W03E migration.
- `W03F`: not started; R1 contract locked; regression-only; T1C owner.
- `J01`: not started; readiness audit; T1C owner.

## 13. Bàn giao (handoff)

- **Base SHA:** `fc1c8b4958f0049631f62f37f57d34c0131cfba6` (`origin/main@fc1c8b49`, 81 migrations).
- **Branch:** `audit/p3-1-w03-s0-r2-access-security-rebaseline`.
- **Worktree:** `C:\CodeApp\BI-p3-1-w03-s0-r2-access-security-rebaseline`; clean at branch creation; only this handoff file changes in this rebaseline.
- **R1 source-of-truth SHA:** `244441aec08cb7ad011bce6cd485b2658f5dbaaa` (the R1 rebaseline commit; unchanged; R1 handoff at `docs/handoffs/p3-1-w03-s0-r1-access-security-rebaseline.md` is the contract).
- **Factual delta (R1 → R2 base):** migrations #72–#81 have landed (W02A, three hotfixes, W02B, three W02C migrations, one W01D scope hotfix, two W01C-B membership hotfixes); W04-C vendor UI landed. No W03 contract change is required.
- **W03A–E dependency graph:** §4 of this file. W03A → W03B / W03C / W03D (W03A is the OCC root); W03E is independent of W03A in code (entry-level restore) but the contract bump `1.3 → 1.4` and the `entry_restore = all` `REQUIRED_SCOPE_KIND` row land in the same W03E migration. W03D reads the W02A audit rows; the W02A writer already records `scope_kind = 'team'` and `scope_team_id = <leader team>` on the `team_manager_assign@team` path. W03F reuses W08A. J01 verifies all of W03.
- **Migration-slot rule:** §2 of this file. W03A uses the next available slot at implementation time (currently **#82** on `fc1c8b49`); W03B–E do not reserve any slot; the logical sequencing is R1 §E and is not a migration-number contract.
- **Acceptance / mutation matrix:** R1 §F is the matrix. R2 retests and confirms no row change is required. W03D `own_manager` allowlist is exactly `('project_manager_assignment_assign','project_manager_assignment_unassign')` plus any future Owner-approved scheduled-cancel verb (none today; §1.4).
- **Gates:** §9 of this file. Migration count 81; next available slot 82; the W03 preflight measures the current count and asserts the expected W03 functions on top.
- **Local = remote / worktree clean:** the R2 branch is local-only; no `origin/audit/p3-1-w03-s0-r2-access-security-rebaseline` push (the rebaseline commit will be pushed fast-forward after the local commit lands; R2 does not push in this rebaseline round). Worktree clean at branch creation; the commit is the only change.

**Dừng tại:** `P3_1_W03_S0_R2_REBASELINE_PASS_AWAITING_T0_REVIEW`.
