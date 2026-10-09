# P3.1-W01C-B/W01D-S0 — Team membership and leader authority security baseline

> Status: `P3_1_W01C_W01D_S0_SECURITY_BASELINE_PASS_AWAITING_T0`
> Base: `origin/main@51fb221027d48272cb968ee9d7d98fe9d713f07c` — ledger **68** migrations; #68 is P3.1-W01B personnel catalog (released). Branch `audit/p3-1-w01c-membership-leader-security`, worktree `C:\CodeApp\BI-p3-1-w01c-membership-leader-security`.
> Scope: read-only security/transaction baseline for (1) recruiter team membership assign/move/unassign, (2) team leader designate/replace/revoke, (3) the atomic `team` scope + `team_manager_assign` capability lifecycle. No source or migration is written here.
> T1B Team Master work is **not** used as evidence: T1B's branch is separate and unreleased, so no uncommitted change was read and **no migration slot is reserved** for W01C/W01D in this memo.
> Inputs: `docs/P3.1.md`, `docs/handoffs/p3-1-c01-catalog-policy-survey.md`, `docs/handoffs/p3-1-j00-security-regression-baseline.md`, `docs/handoffs/p3-1-w04-r0-admin-ui-reuse-survey.md`, `docs/handoffs/p3-1-w01a-capability-contract-foundation.md`, `docs/handoffs/p3-1-w01b-personnel-security-baseline.md`, `docs/handoffs/p3-1-w01b-personnel-catalog.md`, `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`, and a read-only PGlite load of all 68 migrations (evidence rows marked **probe**).

## A. Current truth

### A.1 Exact schema, checks, indexes, ACL (all rows **probe**-verified against a full 68-migration load)

| # | Object | Exact state |
|---|---|---|
| E1 | `public.recruiters` | `recruiter_id uuid PK`, `display_name text NOT NULL` (btrim 1-256), `active boolean NOT NULL default true`, **`version integer NOT NULL default 1 check >= 1`**, `created_at`, plus nullable `personnel_code` (btrim 1-64) and `personnel_position` (STAFF/TEAM_LEADER) from W07A. Unique partial index on `lower(recruitment_dimension_key(personnel_code)) where personnel_code is not null`. Forced RLS; SELECT/INSERT/UPDATE/DELETE all **false** for `anon`, `authenticated` and `service_role`. |
| E2 | `public.teams` | `team_id uuid PK`, `code text NOT NULL unique` (btrim 1-128), `display_name text NOT NULL`, `active boolean NOT NULL default true`, **`version integer NOT NULL default 1 check >= 1`**, `created_at`. Forced RLS; all four privileges **false** for all three roles. **No ALTER has ever touched this table** since #1 — there is no lifecycle RPC. |
| E3 | `public.recruiter_team_memberships` | `membership_id uuid PK`, `recruiter_id FK restrict`, `team_id FK restrict`, `valid_from date NOT NULL`, `valid_to date`, `created_at`. Constraints: `recruiter_team_memberships_check CHECK (valid_to IS NULL OR valid_to > valid_from)`, `UNIQUE (recruiter_id, valid_from)`. **No `version`, no `updated_at`, no actor/reason columns.** Triggers: `direct_entry_team_membership_no_overlap` (interval guard) and `direct_entry_no_vendor_recruiter_team_membership` (reserved-team rejection). Forced RLS; all privileges false for all three roles. |
| E4 | `public.direct_entry_app_users` | `app_user_id uuid PK`, `auth_subject uuid NOT NULL unique FK auth.users restrict`, `enabled boolean NOT NULL default true`, `created_at`, `display_name NOT NULL` with canonical CHECK (`display_name = btrim(display_name)`, 1-256, from W01B session-identity #62). **No `version`.** Forced RLS; all privileges false for all three roles. |
| E5 | `public.direct_entry_app_user_recruiter_links` | `link_id uuid PK`, `app_user_id`/`recruiter_id` FKs restrict, `verified boolean NOT NULL`, half-open `valid_from`/`valid_to`, `UNIQUE (app_user_id, recruiter_id, valid_from)`, `CHECK (valid_to IS NULL OR valid_to > valid_from)`, overlap trigger `direct_entry_recruiter_link_no_overlap`. **No `version`.** Forced RLS; all privileges false. |
| E6 | `public.direct_entry_scope_grants` | `grant_id uuid PK`, `app_user_id FK`, `scope_kind text` in (own, team, all), `team_id uuid` (nullable), half-open interval, `CHECK (valid_to IS NULL OR valid_to > valid_from)`, `CHECK ((scope_kind = 'team') = (team_id IS NOT NULL))`, `UNIQUE (app_user_id, scope_kind, coalesce(team_id, zero-uuid), valid_from)`. Triggers: overlap guard + `direct_entry_no_vendor_team_scope`. **No `version`.** Forced RLS; all privileges false. |
| E7 | `public.direct_entry_capability_grants` | `grant_id uuid PK`, `app_user_id FK`, `capability text NOT NULL` with the **23-token CHECK** (#67), half-open interval, `CHECK (valid_to IS NULL OR valid_to > valid_from)`, `UNIQUE (app_user_id, capability, valid_from)`, overlap trigger. **No `team_id` column and no `version`.** Forced RLS; all privileges false. |
| E8 | Overlap mechanism | `direct_entry_guard_effective_interval()` (foundation, 5 triggers) takes a per-key `pg_advisory_xact_lock` then rejects any `daterange(...,'[)')` overlap. Observed SQLSTATE for an overlapping second open interval: **`23P01`**, message `effective interval overlaps an existing grant or membership`. Keys: provider `provider:<recruiter>`, team membership `team-membership:<recruiter>`, scope `scope:<app_user>:<kind>:<team or user>`, capability `capability:<app_user>:<capability>`, link `link:<app_user>:<recruiter>`. |
| E9 | Half-open vs zero-length asymmetry | Every #1-#46 interval table uses **`valid_to > valid_from`** (strict); observed: a zero-length membership row is rejected **23514** on `recruiter_team_memberships_check`, a zero-length scope grant on `direct_entry_scope_grants_check`, a zero-length capability grant on `direct_entry_capability_grants_check`. Only #51 `direct_entry_project_manager_assignments` uses `valid_to >= valid_from`, which is exactly how "cancel a future assignment" collapses. **Zero-length intervals are impossible on membership/scope/capability today.** |
| E10 | W05A team-scope seed | `direct_entry_seed_team_scope_grants()` (#46, `20261008080000:649-794`) derives `team` scope from **`personnel_position='TEAM_LEADER'`** (lines 668, 694), demands exactly one verified effective link, exactly one effective membership in an **active** team, refuses any leader count other than **7**, refuses a second different-team effective grant for the same app user, and skips idempotently when the same-team grant exists. It inserts into `direct_entry_scope_grants` — the **only** in-migration writer of scope grants — and is executed **inside migration #46** (line 851). It is revoked from anon/authenticated and **granted to `service_role`**. |
| E11 | Every place deriving leader from `personnel_position` | Exactly two SQL sites: `20261008080000:668` and `:694`, both inside the seed above. Outside SQL, `personnel_position` appears only as a catalog/display attribute (W07A projection, W06A candidate projection, W01B catalog) or in tests. There is **no** runtime RPC, page decision or nav predicate that reads it. |
| E12 | Project-manager guards today | `direct_entry_assert_project_admin(auth, app)` (`20261008110000:394-419`) = `assert_actor(...,'entry_admin')` + effective `all` scope, revoked from every role, with **12 call sites** across 4 migrations (W02:573,669,824,967,1025,1103,1198,1295; `20261008140000:25`; `20261008180000:400`; `20261008190000:151`; `20261008200000:265`). Assignment RPCs lock the project row first and enforce project-version OCC (40001), reason, idempotency key, an appended project revision and one audit row labeled `entry_admin`/`all` (W02:751-757). |
| E13 | Candidate/assignment projections today | `direct_entry_list_project_manager_candidates` (W06A, `20261008140000:12-63`) returns active recruiters with a verified effective account link, hard `limit 100`, search over `display_name`/`personnel_code` concatenated into `ILIKE` **without escaping `%`/`_`**, and requires the project-admin guard (global, not team-scoped). |
| E14 | Hidden Vendor team isolation | `direct_entry_system_vendor_team_id()` (#65, lazy create of code `__system_vendor__` / display `Vendor` / active) and `direct_entry_reject_system_vendor_business_team()` with triggers on `recruiter_team_memberships.team_id` and `direct_entry_scope_grants.team_id`. **Probe:** inserting a membership or a team scope for that team id is rejected **23514** `reserved Vendor team is not a business team`. #66 backfilled every Vendor-provider row off business teams and asserts the reserved team emits no team dimension option. |
| E15 | Team resolution at Direct-Entry write time | At least six RPCs resolve the entry team from the recruiter's membership effective at a business date, requiring **exactly one** membership: `create_batch`, `create_draft_row`, `update_draft_row`, `create_full_profile_batch`, `apply_change_item`, `privileged_edit` (guard text `count(*) <> 1` then `denied`; #65 lines 208-358 rewrite each of them so a **vendor** provider uses the reserved team instead). `direct_entries.team_id` is a stored NOT NULL column, so already-written rows keep their team. |
| E16 | Runtime team audience | `direct_entry_reporting_resolve_audience` (#46, `:81-140`) returns `all` on an effective all scope, otherwise **`team`** built with `jsonb_agg` over **all** effective team scopes of the actor, then falls back to `own` via exactly one verified effective link (ambiguity raises). Audience therefore comes from **scope grants**, never from `personnel_position`. |
| E17 | W01B catalog guard (reusable) | `direct_entry_assert_catalog_operator(auth, app)` (#68 `:69-118`) = actor mapping + (Full-Admin triple **OR** `catalog_master_manage`) + effective `all` scope, and **returns the authority actually used** (`'entry_admin'` or `'catalog_master_manage'`); `entry_admin@all` alone is denied; revoked from every role. |
| E18 | Leader state in schema | **Probe:** `information_schema` contains **no** leader-shaped table or column, and the only team/leader functions in `public` are `direct_entry_reject_system_vendor_business_team`, `direct_entry_seed_team_scope_grants` and `direct_entry_system_vendor_team_id`. Leader authority today exists **only** as intervals in `direct_entry_scope_grants` (closed by the seed) — there is no leader column, no leader interval table, and no cardinality constraint. |
| E19 | Version / OCC ownership today | `version` exists on `recruiters`, `teams`, `direct_entry_projects`, `direct_entries`, submissions, payments, status events, change requests, assignments and revisions. **No `version` at all** on `recruiter_team_memberships`, `recruiter_provider_memberships`, `direct_entry_app_user_recruiter_links`, `direct_entry_scope_grants`, `direct_entry_capability_grants`, `direct_entry_app_users`. `teams.version` is currently **written by nobody**. |
| E20 | ACL/execute posture (**probe**) | `direct_entry_assert_catalog_operator`, `direct_entry_has_capability`, `direct_entry_assert_actor_mapping`, `direct_entry_guard_effective_interval`, `direct_entry_reject_system_vendor_business_team` and `direct_entry_system_vendor_team_id` are **not** executable by `service_role` or `anon`; only `direct_entry_seed_team_scope_grants` is granted to `service_role`. Every Direct-Entry table is force-RLS and revoked from all four roles. |
| E21 | Guardrails that will move when W01C lands | **19** test files assert `names.length === 68` (W02 pair, W03, W05, W06A, HF R1/R2/R3/R5, worker-create-rehire, initial-employment-status, P2-de-dim, P2-W04A pair, P3-W05A-I01, W07A-R3/R4, W07B, production-catalog-bootstrap), plus positional guards `names.length - N` / `names.at(-N)` in 14 files. `scripts/lib/direct-entry-inventory.mjs` only recognises `create ... function public.direct_entry_*`, `drop function` and `rename to direct_entry_*.` |
| E22 | Structural facts that decide the contract (**probe**) | (a) one app user **can** hold two effective `team` scopes at once (scope key includes `team_id`) — the audit-2 sample inserted T1 and T2 grants for the same actor, both accepted; (b) the same actor can hold only **one** open `team_manager_assign` interval (second open interval rejected **23P01**) — the capability has no team dimension; (c) a recruiter carrying a **vendor** provider membership **can** be given a business-team membership (accepted) — only the reserved team is structurally blocked. |

### A.2 Findings

- **F1 — Leader has no storage of its own (E18).** "One active leader per team" cannot be expressed today by any column, unique index or FK; it must be enforced by the mutation package itself (guard + lock + postcondition), which is what P3.1 §4 requires anyway ("no behaviourless guard").
- **F2 — Scope and capability cannot share an interval shape (E7, E22b).** `team` scope is per-team and multi-valued; `team_manager_assign` is per-user, single, and has no team id. A leader of two teams (structurally allowed, E22a) shares **one** capability interval across both teams, so "close capability when revoking a team" would silently strip the other team's authority. Any lifecycle rule must therefore be defined over the actor's **whole** team-scope set, not over one team.
- **F3 — Same-day reversal is unrepresentable (E9).** `valid_to > valid_from` means assign-then-unassign, assign-then-move, designate-then-revoke on the **same calendar day** cannot be recorded as a closed interval, and hard-deleting the row would rewrite history. This is a schema-enforced edge case, not a policy choice, and W01C cannot invent its way around it.
- **F4 — "HRP-only business membership" is not schema-enforced (E22c).** The DB blocks the reserved team (E14) but happily accepts a business-team membership for a recruiter whose provider membership is `vendor`. W01B's catalog only lists HRP recruiters, so the gap is only reachable through a raw RPC or a forged id — which is exactly what a security review must close.
- **F5 — Historical attribution is date-derived at write time (E15).** Because six write paths resolve the team from the membership effective **at a business date** and demand exactly one, a membership edit with a back-dated `valid_from` or a truncated `valid_to` changes which team a *later* write resolves for a *past* date. `direct_entries.team_id` already stored is safe, but re-derivation paths are not — the membership contract must constrain back-dated writes explicitly.
- **F6 — Capability/scope intervals currently have no OCC at all (E19).** All grant/membership tables are versionless, so any "expected version" on the API must be owned by an aggregate that does have a version, or the mutation is check-then-write.
- **F7 — The seed is a live accelerator with a hard-coded 7 (E10).** It ran inside migration #46 and is still granted to `service_role` while deriving authority from `personnel_position`. W01C must supersede it, never re-run it, and never let it become a second authority path.

## B. Membership contract (locked)

Subject of a business-team membership = an **active recruiter that holds a canonical effective HRP provider membership** (`provider_type='hrp'`, `vendor_id IS NULL`, effective on the authorization date) — the same predicate W01B uses for the personnel catalog.

| Rule | Locked behaviour |
|---|---|
| Eligible subject | HRP personnel only, canonical + effective. **Rejected:** any recruiter whose effective provider membership is `vendor` (F4 — must be enforced in the mutation path, and a defense-in-depth trigger is the minimum delta because the schema does not block it today), any recruiter with no effective provider membership, and any inactive recruiter. |
| Reserved Vendor team | Rejected for membership **and** scope; already structural via `direct_entry_no_vendor_recruiter_team_membership` / `direct_entry_no_vendor_team_scope` (23514, E14). W01C must not add a path that bypasses the trigger (no `session_replication_role`, no trigger disable, no direct DML). |
| Cardinality | Zero effective memberships is a **valid** state (unassigned personnel stay administrable). At most **one effective** membership per recruiter. Overlap is already impossible (E8); sequential history is the normal shape, so the invariant is "no date ever resolves to two teams", enforced structurally, plus "the consumer's `count(*) <> 1` rule must never be broken by a mutation that leaves a gap where the actor still writes entries". |
| Intervals | Half-open `[valid_from, valid_to)`. Move = close the outgoing interval and open the incoming one **in one transaction** at the same date, so no calendar day is double-covered and none is a gap. Historical rows are never re-dated, re-inserted or deleted. |
| Same-day move / same-day unassign | **BLOCKED by schema (F3).** `valid_to = valid_from` is rejected 23514 (E9 probe). Two acceptable resolutions, T0 must pick one: **(a) minimum schema delta** — relax the three strict checks (`recruiter_team_memberships_check`, `direct_entry_scope_grants_check`, `direct_entry_capability_grants_check`) to `valid_to >= valid_from`, mirroring #51 exactly, in a new append-only slot; or **(b) policy** — reject any same-day move/unassign of an interval that opens today with an explicit, audited error instead of normalizing it silently. **Silent normalization (dropping/merging the row) is forbidden.** |
| Future assignment | Allowed: open interval with `valid_from > today`. It grants no runtime authority until that date (every consumer compares the effective date), is fully reversible while it has not started, and is visible in the "scheduled" projection. |
| Future move | Closing a future interval **before** it starts yields `valid_to = valid_from` — same blocker as above when the close date equals the open date; otherwise the close date must remain strictly later. |
| Cancel future membership | Closing a not-yet-effective interval: if the resulting interval would be zero-length, apply the chosen same-day resolution; otherwise close it normally. Cancelling must never delete the row. |
| Unassign date | `valid_to` is explicit and client-visible; it must be **>= valid_from + 1 day** under today's constraints (or equal under delta (a)); an unassign date in the past is allowed only as a correction the actor explicitly dates, and it must be recorded in the audit `changed_fields`. |
| Inactive team | Rejected as a **target** for assign/move (a team that is not `active` may not receive a new membership). Existing memberships in a team that later becomes inactive stay readable and may still be closed. |
| Inactive personnel | Rejected as a subject for assign/move (deactivation is handled by W01B's set-active path; W01C must not re-activate a person as a side effect). |
| Overlapping interval | Rejected 23P01 by the guard (E8). W01C must not pre-check and then write: the guard IS the check, and the row lock must be taken before it. |
| Idempotent replay | Same key + same payload hash returns the stored result with no second interval, revision, audit or reason row; same key + different payload raises 22023 **before** any write (E12 pattern). |
| OCC strategy | **Real OCC, not check-then-write:** the mutation takes a row lock (`select ... for update`) on the aggregate root and compares the client's expected version inside the same transaction, raising 40001 on mismatch. Because the interval tables are versionless (E19/F6) the version must be owned by an aggregate that has one — see §E. |
| Bounded projections | Exactly three bounded reads, all team/actor scoped and service-role only: **current** (effective today), **scheduled** (future `valid_from`), **history** (closed, paged). Each returns membership id, recruiter id, team id + display name, `valid_from`, `valid_to` and the version; no `auth_subject`, no email, no app-user UUID, no grant rows, no reason text. A closed interval is never rendered as "current". |
| Reason / revision / audit / residue | Every mutation: non-empty reason stored via `direct_entry_reason`, one immutable revision row with a fixed bounded snapshot, one audit row, and one idempotency row — all in the same transaction. Any failure anywhere rolls back the interval change, the reason, the revision, the audit row and the idempotency key: **zero residue**. |

## C. Leader contract (locked)

| Rule | Locked behaviour |
|---|---|
| Cardinality | At most **one effective leader per team**. No schema expresses this (F1), so it is a postcondition of the mutation package and must be exercised by it. |
| Leader eligibility | Enabled app user + **exactly one** verified **effective** recruiter link + that recruiter is HRP + that recruiter has an **effective membership in the same team**. Zero or ambiguous links, a mismatched team, an inactive team or a disabled actor all fail closed with 42501/P0002 — never a partial write. |
| `personnel_position` | Display/catalog only. It never authorises, never blocks, and is never read by the leader path. Changing it in W01B grants nothing. The W05A seed is the only place it ever drove authority and must be superseded, not re-run (F7). |
| Designate (replacement) | When the team already has an effective leader, designation is **one atomic replacement in one transaction**: close the outgoing leader's `team` scope **and** `team_manager_assign` interval, then open the incoming leader's `team` scope **and** `team_manager_assign` interval, with one reason, one OCC check, one idempotency key, one revision and one immutable audit trail. The post-state never has two effective leaders and never has a gap where the team is unintentionally leaderless. Any failure at any step (scope, capability, revision, audit, idempotency, expiry check) rolls back everything with zero residue — no half-closed outgoing interval and no half-open incoming one. |
| Revoke | A **separate, explicitly invoked** operation that closes the leader's intervals and leaves the team temporarily leaderless. Revoke must never create a replacement and must never close a `"team+"` pair belonging to another team (F2). |
| Scope/capability lifecycle | The two intervals must be **co-extensive in authority**: opened together with the same `valid_from`, and closed together according to the actor's **whole** team-scope set — the capability may be closed only when the actor no longer has **any** effective leader team scope (F2, E22a/E22b). A state with an effective `team` scope and no `team_manager_assign`, or with `team_manager_assign` and no team scope, is a defect and must be detectable. |
| Two-team leadership | Structurally possible (E22a) but **not locked by this memo**. T0 must either (i) forbid it — designate rejects an actor who already leads another team — or (ii) allow it and apply the whole-set closure rule above. Until T0 decides, the implementation must not silently create such a state. |
| Revocation latency | Revoke is effective for the **next** request: the very next RPC/page decision must deny, with no cached authority. Existing revisions, facts and audit history stay readable. |
| No fake authority | Audit must record the **real** capability (`team_manager_assign`) and the real `team` scope with the correct `scope_team_id` — never `entry_admin`, never `@all'`. |
| Self-designation | Allowed only if the actor is an enabled app user with exactly one verified link and an effective membership in that same team; self-designation grants nothing extra and is audited like any other. |
| Concurrent disable | If the actor or the target is disabled while the transaction is in flight, the transaction fails closed (42501) and leaves zero residue; the lock order must be fixed and documented so two concurrent designations cannot both pass. |
| Team inactive | Designation is denied for an inactive team; a team deactivated later does not silently keep leader authority — revocation must remain possible, and the leader's own-team reads must follow the team's active state. |
| Expired link / membership, or a team move | The leader loses authority at the effective date of the expiry or the move: the next authorisation check denies. The move must not silently rewrite the leader's history (the outgoing interval is closed, the incoming one opened). |
| Future designate / revoke | Future-dated designation is allowed only if the whole replacement is future-dated consistently (both scope and capability `valid_from` identical); it grants no authority before that date. Future-dated revoke closes at the given date and keeps authority until then. |
| Never granted | Leader authority never implies project-master, catalog-master, account/grant/link administration, `entry_restore`, cross-team candidates or cross-team unassign. Each of those stays behind its own guard. |

## D. Authority and audit matrix (minimum)

| Actor | Membership assign/move/unassign | Leader designate/replace/revoke | Leader read | Cross-team direct RPC | Reserved Vendor team | Vendor-provider recruiter |
|---|---|---|---|---|---|---|
| Full Admin (triple + effective `all`) | allow | allow | allow | allow | **deny** 23514 | deny on the membership path |
| Accounting catalog operator (`catalog_master_manage` + effective `all`) | allow | allow | allow | allow | deny 23514 | deny |
| Team leader (`team_manager_assign` + effective `team`) | deny | deny | own team only | **deny 42501** | deny | deny |
| Project manager (assignment-derived) | deny | deny | deny | deny | deny | deny |
| Ordinary staff | deny | deny | deny | deny | deny | deny |
| Disabled actor with live grants | deny (mapping/`enabled`) | deny | deny | deny | deny | deny |
| Unmapped or mismatched `auth_subject`/`app_user_id` | deny 42501 | deny 42501 | deny | deny | deny | deny |
| Ambiguous actor (multiple verified links/teams) | deny 42501 | deny 42501 | deny | deny | deny | deny |
| Inactive / future / expired interval state | assign into an inactive team denied; a future interval grants nothing; an expired interval grants nothing | same, both for scope and capability | reads still show history | — | — | — |

Audit labels, exactly:

| Acting path | `capability` | `scope_kind` | `scope_team_id` |
|---|---|---|---|
| Full Admin | `entry_admin` | `@all'` | NULL |
| Accounting catalog operator | `catalog_master_manage` | `@all'` | NULL |
| Team leader (own team) | `team_manager_assign` | `@team'` | the acting team id |

Authority must never be derived from a role name, an email or email suffix, `personnel_position`, or any client-supplied actor/capability/scope field (`validateClientBusinessPayload` already rejects those; E17/E12 keep the server-side decision). Menu/nav visibility is never the boundary — every RPC keeps its own guard.

## E. Revision / OCC recommendation

| Concern | Recommendation |
|---|---|
| Aggregate boundary — membership | Root the membership aggregate on the **recruiter** (`recruiters.version`, already present, already versioned by W01B, and the same stream that already carries personnel revisions). A move touches **two** teams, so `teams.version` cannot be the membership root without either two version bumps or an ambiguous owner; the person is the single subject of the invariant "at most one effective team". |
| Aggregate boundary — leader | Root the leader aggregate on the **team** (`teams.version`, currently written by nobody, E19). "One leader per team" is a property of the team, and the team is the row that must be locked to serialise two concurrent designations. |
| Version ownership rule | One mutation = one version bump on exactly one root, with the interval rows carrying no version of their own. Reads return the root version so a client can send it back. `recruiters` and `teams` versions are the only ones this lane may bump. |
| Fixed snapshot shape — membership | `{recruiter_id, team_id, valid_from, valid_to, version, change}` — fixed keys for every membership action, comparable key-by-key across create/move/unassign, mirroring the W01B decision to drop conditional keys. Business fields only: no actor mapping, no email, no grant rows, no reason text. |
| Fixed snapshot shape — leader | `{team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to, previous_leader_recruiter_id, version, change}` — one shape for designate, replace and revoke, so the outgoing and incoming sides are always both recorded in a single row. |
| Anti-ABA | The snapshot carries both the version **and** the identity it describes (leader recruiter id / team id), and OCC compares the version on the **locked** row. A version-only check that ignores identity is exactly how an A→B→A sequence passes unnoticed; the revision row plus the identity field makes the ABA visible. |
| Concurrent replace / revoke | Fixed lock order — **team row first, then the app users' grant rows** — plus the existing per-key advisory lock when writing interval rows. Two concurrent designations for the same team must serialise on `teams` `for update`; the loser then sees the new version and fails 40001, not a silent double-leader. |
| Unique / effective cardinality | A partial unique index cannot express "at most one effective leader" without a leader table (F1), and adding one is a schema decision, not an implementation detail. Enforce it as a locked postcondition (count of effective leaders per team = 1 after designate, 0 after revoke) **and** require the same reviewed package to exercise it — a guard nobody calls is forbidden by P3.1 §4. |
| Rollback of reason / idempotency / revision / audit | Keep the existing single-transaction pattern: validate → guard → idempotency begin → lock → mutate intervals → revision → audit → idempotency finish. Any raise unwinds every one of those rows, which is the only reason the "zero residue" tests are meaningful. |
| No new framework | Reuse `direct_entry_reason`, `direct_entry_rpc_idempotency`, `direct_entry_audit_events`, the immutable-revision trigger and the existing bounded-projection idiom. No new audit store, no approval engine, no generic RBAC. |

## F. Regression inventory

**Reusable lanes (no new fixture framework needed — PGlite + the migration ledger already cover every case):**

| Lane / file | Reuse for |
|---|---|
| `scripts/p3-w05a-team-scope-seed.test.mjs` (169) | Seed behaviour to **supersede**: ambiguous link, multiple membership, inactive team, overlap refusal, idempotent re-run |
| `scripts/p3-w05a-actor-scoped-reporting.test.mjs` (375) | Team-scope-driven audience resolution and revocation effect |
| `scripts/p3-w05a-i01-multi-team-regression.test.mjs` (310) | Multi-team isolation and audience boundaries |
| `scripts/p2-5-w02-multi-manager-authority-db.test.mjs` + `p2-5-w02-r1-project-authority-occ-db.test.mjs` | Interval/OCC/idempotency/revision/audit patterns to copy (one lane, both files) |
| `scripts/p2-5-w06a-r2-manager-candidates-db.test.mjs` (127) | Candidate projection shape/scoping |
| `scripts/p3-w07b-project-manager-scope.test.mjs` (148) | Assignment-derived authority and verified-link eligibility |
| `scripts/p3-w07a-r4-vendor-historical-team-backfill-db.test.mjs` (333) + `p3-w07a-r3-vendor-doc-upload-db.test.mjs` | Reserved-team isolation and the atomic-abort pattern |
| `scripts/p1.6-w03-db.test.mjs` (1588) | Foundation grants/links/scope matrices and fail-closed actor cases |
| `scripts/p3-1-w01a-capability-contract.test.mjs` (371) | 23-token parity, contract version, scope-kind rules for both new tokens |
| `scripts/p3-1-w01b-personnel-catalog-db.test.mjs` (941) | HRP eligibility predicate, revision snapshot shape, zero-residue assertions |
| `scripts/p1.6-s04c-document-scope-lock-db.test.mjs` (184) | Scope-lock and no-leak assertions |

**Machine-verifiable cases required for W01C/W01D (38).** Every case must be assertable in a DB/structural test; none may require a browser.

*Membership (M)*
1. Assign an eligible HRP person to an active team → one open interval, version +1, one revision, one audit row.
2. Assign with zero effective provider membership → denied, zero residue.
3. Assign a recruiter whose effective provider membership is `vendor` → denied (F4), zero residue.
4. Assign to the reserved Vendor team → 23514 from the trigger, zero residue.
5. Assign to an inactive team → denied.
6. Assign an inactive person → denied.
7. Assign a second **effective** membership to the same recruiter → 23P01.
8. Move on a later date → outgoing closed, incoming opened, same transaction, one revision.
9. Move on the **same** date → the locked same-day resolution (schema delta or explicit rejection); never a silent merge.
10. Unassign with an explicit future date → interval closed, history readable.
11. Unassign on the same date the interval opened → same-day resolution applies.
12. Cancel a **future** membership before it starts → no authority was ever granted, row preserved.
13. Replay the same key + same payload → identical stored result, no second interval/revision/audit/reason.
14. Same key + different payload → 22023 with the entity unchanged.
15. Stale expected version → 40001, intervals unchanged.
16. Zero-length interval is impossible today → the test asserts the chosen resolution rather than silently accepting 23514 (F3).
17. Back-dated write that would change the team resolved for an already-used business date → denied or explicitly audited (F5).
18. After any failed membership mutation → interval, reason, revision, audit and idempotency rows are all absent.

*Leader (L)*
19. Designate on a leaderless team → leader + `team` scope + `team_manager_assign` created together, one audit row labeled `team_manager_assign`/`team`/team id.
20. Designate when a leader already exists → atomic replacement; post-state has exactly one effective leader; outgoing intervals closed, incoming open.
21. Replacement fails mid-way (forced failure at the capability step) → zero residue, outgoing leader still effective, no second leader.
22. Revoke → both intervals closed, team temporarily leaderless, history intact, next request denied.
23. Revoke one of two teams the same person leads → the other team's authority survives (F2).
24. Designate an actor with zero verified links → denied.
25. Designate an actor with **two** verified effective links → denied (ambiguous).
26. Designate an actor whose single link is on an expired interval → denied.
27. Designate an actor whose recruiter has no membership in the target team → denied.
28. Designate an actor whose recruiter membership is in a **different** team → denied, and the other team's id is never echoed.
29. `personnel_position='TEAM_LEADER'` alone → grants nothing (no scope, no capability, no nav).
30. Disabled actor or disabled target mid-transaction → fail closed, zero residue.
31. Inactive team → designation denied; a deactivated team does not retain leader authority silently.
32. Two concurrent designations for the same team → at most one succeeds; the loser gets 40001 (lock order assertion).
33. Future-dated designation → no authority before the date; consistently dated scope + capability.
34. Effective `team` scope without `team_manager_assign` (and the reverse) is detected as a defect state by the lane.

*Authorisation, audit, projection (A/P)*
35. Full Admin vs Accounting vs leader vs PM vs staff vs disabled/unmapped/ambiguous across all membership and leader mutations → the §D matrix, including direct cross-team RPC denial.
36. Audit label assertions: Admin → `entry_admin`/`all`/NULL team, Accounting → `catalog_master_manage`/`all`/NULL team, leader → `team_manager_assign`/`team`/team id; a swapped or invented label fails.
37. Bounded projections: current/scheduled/history separation, paging bound, exact key set, and no `auth_subject`/email/app-user UUID/grant rows/reason text in any response.
38. Ledger and inventory guards: the 19 exact-count assertions move to the new ledger size and the positional guards still point at the intended migrations; every new function is declared as `create or replace function public.direct_entry_*` so the inventory parity lane can see it (E21).

### Mutation-check matrix (each must be demonstrated red-then-reverted byte-identical)

| # | Assertion that can be falsely green | Why it can pass anyway | Mutation that must turn it red |
|---|---|---|---|
| 1 | "Vendor recruiter cannot get a membership" | Suite that never seeds a vendor provider membership passes even with no vendor check (F4). | Add a vendor-provider recruiter fixture; remove the provider check → case 3 must fail. |
| 2 | "Reserved team cannot appear" | The rejection is a trigger, so a suite that only calls the RPC can pass while the RPC special-cases the reserved team. | Assert the 23514 trigger path directly (raw insert) **and** through the RPC; disable/rename the trigger → both must fail. |
| 3 | "`personnel_position` is not authority" | A suite that always sets position correctly never proves it is ignored. | Give an actor position `STAFF` with a valid link/membership (must still be designatable) and position `TEAM_LEADER` with no link (must still be denied); make the guard read the position → one of the two must fail. |
| 4 | "Verified link required" | A single happy-path fixture with a link never exercises absence/expiry/ambiguity. | Add zero-link, expired-link and two-link actors (cases 24-26); delete the link predicate → 3 cases red. |
| 5 | "Scope and capability share one lifecycle" | Both being created in the happy path passes even if the closure rule ignores the actor's other teams. | Two-team leader (case 23): revoke team A and assert team B still works; make the code close the capability unconditionally → red. |
| 6 | "No two effective leaders" | A post-state assertion on one team passes if the test only ever designates one actor. | Designate B while A is effective, then assert exactly one effective leader and that A is closed; skip the outgoing close → red. |
| 7 | "Replacement is atomic" | Asserting only the final state passes when the outgoing close commits in a separate statement that survived a later failure. | Force a failure after the incoming open (or at the revision step) and assert the outgoing leader is still effective with **zero** new rows; split the transaction → red. |
| 8 | "Revoke closes the capability too" | A test asserting only the team scope is gone passes while `team_manager_assign` survives (E22b). | Assert the capability interval is closed **and** that the actor's next RPC denies; delete the capability close → red. |
| 9 | "Cross-team candidate/assignment cannot leak" | Fixtures that only ever have one team never produce a cross-team id. | Two teams with distinct rosters; assert the other team's ids never appear and that a forged direct call denies; drop the team filter → red. |
| 10 | "Stale version cannot write" | A no-op or self-refreshing version passes once. | Assert version +1 per mutation and that the immediately repeated same-version call fails 40001; remove the version comparison → red. |
| 11 | "Failure leaves no partial grants" | Asserting only the raised SQLSTATE passes while a scope grant persisted. | Count scope/capability/interval/revision/audit/reason/idempotency rows before and after a forced mid-transaction failure (cases 18, 21); move one write outside the transaction → red. |
| 12 | "Audit authority is truthful" | A single-actor test cannot see a swap (both Admin paths are `all` scope). | Run the same mutation as Admin and as Accounting and assert each row's own token; swap the two literals in the guard/audit write → red. Also assert the leader path never writes `entry_admin`. |

## G. Sequencing

1. **Team Master (T1B) first**, as currently owned. This memo reads nothing from it and reserves **no** migration slot; W01C/W01D take the next slot(s) T0 allocates, one reviewed work package at a time, append-only after #68.
2. **Membership before leader.** Membership must be stable (including the same-day resolution from §B) before leader designation is built on top of it, because designation validates "effective member of that team".
3. **Leader before W02's team-scoped project-manager assignment.** W02's leader path consumes `team_manager_assign` + the leader's effective `team` scope; building it before the leader lifecycle exists would create the second authority path C01 forbids.
4. **Supersede the W05A seed; never re-run it.** Once designation/revocation exists, the seed's `personnel_position` derivation and its hard-coded 7 are legacy. Migration #46 already ran it; no W01C package may invoke it, and no backfill may invent leader history that the seed did not record.
5. **Production read-only preflight** (inside a transaction that always rolls back, printing **counts/booleans only**): applied count + pending set; recruiters with more than one effective team membership (expect 0); active teams with more than one effective leader (expect 0); app users holding an effective `team` scope **without** `team_manager_assign`, and the reverse (expect 0 both ways); memberships and team scopes on the reserved Vendor team (expect 0); vendor-provider recruiters holding a business-team membership (expect 0 — any non-zero value is a blocker F4 must handle before apply); leaders whose verified effective link count is not exactly 1 (expect 0); teams with zero effective leader; and the count of accounts that would newly match the leader predicate. No email, user UUID, recruiter UUID, worker name, CCCD, storage key or raw database error may be printed.
6. **Rollback / forward-fix boundaries.** Every package is append-only: a defect is corrected by a new migration that redefines the function or constraint, never by editing an applied file and never by rewriting interval history. Interval rows are closed, never deleted; a bad interval is corrected by an explicitly reasoned, audited mutation. The same-day blocker (F3) must be resolved **before** apply, because the resolution changes a constraint that Production data already satisfies.
7. **No Production query/apply/deploy, no browser/Playwright/CUA/UAT** in this task; Owner-only browser UAT remains with the Owner, and only T0 declares the wave pass.

## Boundary

Read-only survey: no source, migration, API, package, dependency or Production change; no Production query/apply/deploy; no browser, Playwright, CUA or UAT. #1-#68 untouched. T1B's unreleased Team Master work was not read and no slot was reserved for it or for W01C/W01D. Every probe ran against a throwaway local PGlite instance loaded from the 68 migrations with synthetic fixtures; the temporary probe files were deleted and the worktree is clean. No PII, email, real user UUID, credential or raw database error is printed in this memo — only constraint names, SQLSTATEs and counts.
