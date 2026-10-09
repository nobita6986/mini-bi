# P3.1-W01D-A2-S0 — Team leader lifecycle server/API contract and gap review

> Status: `P3_1_W01D_A2_S0_R1_SERVER_API_SURVEY_PASS_AWAITING_T0`
> Lane: T1C read-only survey/review. No implementation, no source or migration edit, no `package.json`/dependency, no `docs/P3.1.md` change, no Production query/apply/deploy, no browser/Playwright/CUA/UAT.
> Base: `5fad15fd47cf60379fb8a05e0d650923d741de08` on `origin/feature/p3-1-w01d-team-leader-lifecycle`. The wave is on a **feature branch**, not `main`; nothing here is "shipped" in the Production sense, and `#71` is not yet accepted by T0.
> Worktree: `C:\CodeApp\BI-p3-1-w01d-a2-server-contract-survey`; branch `audit/p3-1-w01d-a2-server-contract-survey`.
> Ledger at base: **71** migrations; `#71` = `20261009070000_p3_1_w01d_team_leader_lifecycle.sql` is last; `#72` is not present. The migration was amended in place by A1a1, A1a2, A1b1, A1b2, R1 and R2 in the W01D feature branch and is the canonical, byte-stable surface this survey reads.
> Inputs: `AGENTS.md` (workspace rules only — this is a TypeScript/Next.js project, follow the "not the Next.js you know" rule on any later code task); `docs/P3.1.md`; `docs/handoffs/p3-1-w01c-membership-leader-security-baseline.md`; the W01D handoffs (`p3-1-w01d-a1a1-schema-foundation.md`, `p3-1-w01d-a1a2-schema-regression.md`, `p3-1-w01d-a1b1-leader-read.md`, `p3-1-w01d-a1b2-leader-write.md`) and the R1/R2 closure memos; the canonical 23-token capability contract locked by C01; the personnel/team/team-membership catalog contracts (`src/lib/direct-entry/personnel-catalog-{contract,api,repository}.ts`, `team-catalog-…`, `team-membership-…`); the project-admin candidate pattern (`direct_entry_list_project_manager_candidates` in `supabase/migrations/20261008140000_p2_5_w06a_manager_candidates.sql`, surfaced via `project-admin-repository.ts` → `projectAdminCandidates`).
> Authority model (re-stated so the rest of this memo can rely on it):
> - **Full Admin** = the canonical AND of `entry_admin` + `recruiter_master_manage` + `team_master_manage` at effective `all` scope (the catalog-operator guard at `#68` recognises this triple as `entry_admin@all`). **`entry_admin@all` alone is not Full Admin** and is denied.
> - **Accounting catalog operator** = the narrow `catalog_master_manage` capability at effective `all` scope (the same guard returns `'catalog_master_manage'`). Accounting is **not** a Full Admin and must never hold `entry_admin`.
> - **Team leader** = the team-scoped `team_manager_assign` capability, used by **W02** to assign/unassign project managers of that team. It is **not** an authority to list leader candidates, to designate, replace or revoke team leaders. A team leader has no path into the leader lifecycle surface.
> - DB is the final authority for every allow/deny decision. The API never re-implements an authorization engine — it only parses, gates, authenticates, sanitizes and projects.

## 1. Evidence and current truth

| # | Source | Truth |
|---|---|---|
| E1 | `#71` (schema) | `public.direct_entry_team_leader_assignments(assignment_id, team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to, created_at)` half-open, `valid_to = valid_from` is a cancellation marker, **forced RLS, no role privilege**. Marker-excluding partial uniques on `(team_id, valid_from)` and `(leader_app_user_id, valid_from)`, plus a `(team_id, valid_from desc)` history index. |
| E2 | `#71` (schema) | `public.direct_entry_team_leader_revisions(revision_id, team_id, version, actor_user_id, action, before_snapshot jsonb, after_snapshot jsonb, created_at)`, immutable via `direct_entry_reject_immutable_change()`, unique `(team_id, version)`, **forced RLS, no role privilege**. |
| E3 | `#71` (schema) | `direct_entry_audit_events` gained a nullable `leader_revision_id uuid REFERENCES public.direct_entry_team_leader_revisions(revision_id) ON DELETE RESTRICT`. |
| E4 | `#71` (helper) | `public.direct_entry_team_leader_snapshot(p_team_id, p_leader_app_user_id, p_leader_recruiter_id, p_valid_from, p_valid_to, p_previous_leader_recruiter_id, p_version, p_change)` returns **exactly** the eight fixed keys, immutable, SECURITY DEFINER, `search_path=pg_catalog, public`, revoked from every role. |
| E5 | `#71` (helper) | `public.direct_entry_team_leader_projection(assignment, team_display_name, leader_display_name)` returns **9 keys**: `assignment_id, team_id, team_display_name, leader_app_user_id, leader_recruiter_id, leader_display_name, valid_from, valid_to, state ∈ {CURRENT, SCHEDULED, HISTORY}`, stable, SECURITY DEFINER, `search_path=pg_catalog, public`, revoked from every role. **No** `auth_subject`, email, grant id, raw scope/capability row, reason or audit internals. |
| E6 | `#71` (read authority) | `public.direct_entry_assert_team_leader_read_authority(p_auth_subject, p_app_user_id, p_team_id)` — sole read resolver, SECURITY DEFINER, `search_path=pg_catalog, public`, revoked from every role. **Catalog operator path**: when the actor passes `direct_entry_assert_catalog_operator(auth, app)`, the resolver returns the supplied `p_team_id` unchanged; a stale, inactive or reserved team filter narrows to zero rows in the three reads but the call itself does not error. **Leader path**: requires, in one transaction, enabled account mapping, exactly one effective `team` scope, exactly one verified effective recruiter link, an active recruiter, exactly one effective HRP provider membership, exactly one effective membership in that same team, an active non-reserved team, and exactly one matching effective leader assignment. Any ambiguous/missing/expired/disabled/mismatched state, **or a `p_team_id` that differs from the leader's effective scoped team**, raises `42501`. The leader path exists to support leader self-team reads (current/scheduled/history for the leader's own team). It is **not** an authority to list leader candidates, designate, replace or revoke. |
| E7 | `#71` (read RPCs) | Three bounded service-role reads, all SECURITY DEFINER, `search_path=pg_catalog, public`, EXECUTE only to `service_role`, **reserved-team filter** `t.code <> '__system_vendor__'` enforced by both the WHERE and the closing self-check: `direct_entry_list_team_leaders_current(p_auth_subject, p_app_user_id, p_team_id, p_search, p_page, p_page_size)`, `…_scheduled(…)`, `…_history(…)`. Search bound 256, page 1..1000, page_size 1..100. Envelopes return `{authorization_date, page, page_size, total, leaders[]}` with the E5 projection only. |
| E8 | `#71` (write authority + helper) | `direct_entry_apply_team_leader_mutation(p_auth_subject, p_app_user_id, p_team_id, p_target_leader_app_user_id, p_effective_date, p_expected_version, p_reason, p_idempotency_key, p_operation, p_authority)` — sole internal mutator, SECURITY DEFINER, `search_path=pg_catalog, public`, revoked from every role. Two service-role wrappers: `direct_entry_designate_team_leader(auth, app, team_id, leader_app_user_id, effective_date, expected_version, reason, idempotency_key)` and `direct_entry_revoke_team_leader(auth, app, team_id, effective_date, expected_version, reason, idempotency_key)`. Each wrapper **must** call `direct_entry_assert_catalog_operator(auth, app)` first and pass that string as `p_authority` — the closing self-check requires the catalog guard call to **precede** the internal helper call. **The catalog-operator guard accepts the Full-Admin triple + all scope OR `catalog_master_manage` + all scope. `entry_admin@all` alone is not enough.** A team-leader actor (with `team_manager_assign@team`) is denied at the catalog-operator guard and therefore cannot designate, replace or revoke. |
| E9 | `#71` (lock + advisory order) | OCC root = `public.teams` row (`select … for update`, version compare inside the same transaction → `40001`). Then ordered `for update` on `direct_entry_app_users(app_user_id)`, on `direct_entry_scope_grants(…) where scope_kind='team'`, on `direct_entry_capability_grants(…) where capability='team_manager_assign'`. Then `pg_advisory_xact_lock(hashtextextended(...))` on a stable key list covering outgoing `capability:<u>:<cap>`, `scope:<u>:<kind>:<team>`, incoming ones, and `recruiter-link:<u>`, plus designate-only `provider:<recruiter>`, `team-membership:<recruiter>`. |
| E10 | `#71` (eligibility, designate only) | Exactly one verified effective link (otherwise `42501 target leader requires exactly one verified recruiter link`); active recruiter (`42501 target recruiter is not active`); exactly one effective HRP provider membership (`42501 target recruiter requires exactly one effective HRP provider`); exactly one effective membership in the target team (`42501 target recruiter must have exactly one effective membership in the target team`); no overlap with another team's effective/scheduled leader assignment (`42501 target leader is assigned or scheduled for another team`); no pre-existing effective `team` scope or `team_manager_assign` (`42501 target leader has pre-existing leader authority intervals`); enabled target account (`42501 target leader account is not enabled`). |
| E11 | `#71` (interval rule) | Designate inserts the new `team` scope, capability, and assignment at `p_effective_date`. If the same date is the outgoing assignment's `valid_from`, the helper sets `set_config('direct_entry.team_leader_marker', 'on', true)` before issuing the outgoing close so a same-day zero-length marker can be written; otherwise the trigger (`direct_entry_team_leader_marker` on assignments + the same trigger on scope/capability grants) raises `23514`. The marker is never effective for any date predicate. |
| E12 | `#71` (postconditions) | Designate/replace post-state (inside the same transaction, before team version bump / reason / revision / audit / idempotency finish): exactly one effective team-leader for the target team and it is the target app user; that user is effective leader of exactly one team (and that team is the target); exactly one effective target-team `team` scope; exactly one effective `team_manager_assign`; the new assignment/scope/capability all start at `p_effective_date` and have identical `valid_to`; outgoing leader is no longer effective; outgoing scope and capability are closed. Revoke post-state: no effective target-team leader, no effective target-team `team` scope, no effective `team_manager_assign`; the closed assignment/scope/capability each have `valid_to = p_effective_date`. Any mismatch raises generic `55000` with **no identity data**; the whole transaction rolls back. |
| E13 | `#71` (audit) | One `direct_entry_team_leader_revisions` row at the new `teams.version`; one `direct_entry_audit_events` row with `auth_subject, app_user_id, action='team_leader_<designate|replace|revoke>', capability=p_authority, resource_ref=p_team_id::text, scope_kind='all', outcome='APPLIED', reason_id, changed_fields=['team_leader_assignment','team_scope','team_manager_assign'], leader_revision_id`. The reason is recorded through the canonical `direct_entry_reason(actor, text)`; reason text 1..4000 chars after btrim. |
| E14 | `#71` (idempotency) | `direct_entry_rpc_idempotency` lookup before any mutation; same key + same `request_hash(jsonb{team_id, target_leader_app_user_id, effective_date, expected_version, reason})` returns the stored result; same key + different payload raises `22023 idempotency key reused with different input` **before** any write. `direct_entry_idempotency_begin` is called between the version compare and the DML; `direct_entry_idempotency_finish` is called after the postconditions and the audit insert. |
| E15 | `#71` (reserved team) | `if v_team.code = '__system_vendor__' then raise 23514 'reserved team cannot have a leader'` **before** any idempotency reservation, before any team version compare, before any DML — for both designate and revoke. The R1 closing self-check rejects any team-leader function that calls `direct_entry_system_vendor_team_id()`; the R2 closing self-check rejects the same reference in the mutation function definitions. The API must not hard-code or recognise the reserved team by UUID; it only validates UUID shape in the path. The DB code constant `__system_vendor__` (resolved at read time via `t.code`) is the single source of truth. |
| E16 | `#71` (SQLSTATE taxonomy actually raised) | `40001` OCC (team version stale); `42501` authority/identity (catalog-operator guard, all-scope, leader eligibility, target cross-team, pre-existing authority, ambiguous identity, target not enabled, target missing link/recruiter/HRP/membership); `23514` reserved team, target team inactive (designate only), `direct_entry_team_leader_marker` (zero-length outside audited path); `23505` idempotency unique; `23P01` overlap; `P0002` team not found; `22023` invalid input (`expected_version`, date, reason length, idempotency length, `p_operation`, target↔operation mismatch, idempotency key reused with different payload); `55000` postcondition defect or self-check failure. |
| E17 | `#71` (legitimate 23P01 path in mutation) | The `direct_entry_guard_effective_interval` family may still raise `23P01` on the very narrow race that two mutations both pass the post-state read but commit in serial; the OCC `for update` on the team row plus the advisory locks are the prevention; a runner-up sees `40001` on version compare or `23P01` on the guard. |
| E18 | C01 + W01D handoffs | Sole leader read resolver is E6; no second authority resolver is allowed — the closing self-check rejects `direct_entry_assert_team_leader_authority(uuid,uuid,uuid)` and any other name matching `direct_entry_assert_team_leader%`. |
| E19 | Existing catalog contracts | `team-membership-contract.ts` already uses the canonical `{authorization_date, page, page_size, total, memberships[]}` envelope, the 8-key item shape, and the `state ∈ {CURRENT, SCHEDULED, HISTORY}` discriminator. `personnel-catalog-contract.ts` and `team-catalog-contract.ts` use the same fail-closed `exactKeys` parser. This is the projection pattern A2 must mirror. |
| E20 | Existing pipeline (`team-membership-api.ts`, `team-catalog-api.ts`, `personnel-catalog-api.ts`) | Canonical request pipeline: `DIRECT_ENTRY_API_ENABLED` gate → same-origin/CSRF on mutation → content-type + bounded JSON (`MAX_BODY_BYTES = 64 KiB` in `src/lib/direct-entry/write-api.ts`) → `validateClientBusinessPayload` recursive authority-field rejection (`CLIENT_AUTHORITY_FIELD_FORBIDDEN`) → strict request projection (exact keys, bounded types, `parseIsoDate` calendar-valid date) → resolve session server-side → repository → response sanitized + `Cache-Control: private, no-store`. Mutation responses additionally compare the `idempotency-key` header to the body key (`IDEMPOTENCY_KEY_MISMATCH`). |
| E21 | Existing repository (`team-membership-repository.ts`) | Repository pattern: dependency-inject a `Rpc` (default `serviceRoleRpc()`), wrap each call in `call<T>(rpcName, args, project)` that classifies errors via `classifyTeamMembershipError({code, message})` and returns a strict `Outcome<T>` of `{ok:true,data:T} | {ok:false, kind: 'conflict'|'denied'|'invalid'|'not-found'|'unavailable'}`. Malformed projection → `unavailable`. **No direct table read/write**; only the 6 RPCs in `#70`. The repository is **not** an authorization engine; it only translates canonical RPCs to the strict projection and the sanitized kind taxonomy. |
| E22 | PM-candidate precedent | `direct_entry_list_project_manager_candidates` (W06A, `#54`) is a service-role RPC behind `direct_entry_assert_project_admin` (Full-Admin triple + all scope), returns active recruiters with one verified effective link, hard `limit 100`, search over `display_name` / `personnel_code` ILIKE without `%`/`_` escape, **no `auth_subject` / app-user UUID / email**. The P3.1 leader-candidate rule is materially different: it is **catalog-operator-only** (Full Admin or `catalog_master_manage@all`), team-scoped, with additional HRP-only, enabled-app-user, team-membership and no-leader-in-another-team predicates. The leader-candidate RPC is allowed to reuse the canonical `direct_entry_assert_catalog_operator` for authority; the project-admin guard is **not** an option. |
| E23 | C01 + W01D security baseline | The reserved Vendor team must be filtered out at the DB read path and rejected at the DB write path with `23514`. The API surfaces the read-side filter as "no rows" and the write-side rejection as `LEADER_INVALID` 400 — **not** as a reserved-team-specific code, and **not** as `LEADER_DENIED` (which would leak the team's existence). For the candidate route, the API must verify the team exists and is active before the call returns; a missing team, a reserved team, or an inactive team is `LEADER_NOT_FOUND` 404. |
| E24 | Personnel catalog contract | `personnelCatalogItem` carries `recruiter_id, display_name, personnel_code, personnel_position, active, version, hrp_valid_from, revision_count` — **no** `app_user_id`, **no** `auth_subject`, **no** link id. The personnel catalog therefore does **not** expose a leader candidate; it can only confirm a person is administrable. |
| E25 | Team membership contract | `teamMembershipItem` carries `membership_id, recruiter_id, team_id, team_display_name, valid_from, valid_to, recruiter_version, state` — enough to compute "this person is currently in team T" but it does not check the app user, the verified link, the HRP provider or the leader-in-another-team constraint. A2 cannot use it as the candidate source as-is. |
| E26 | App-user and recruiter display-name sources | `direct_entry_app_users.display_name` is the canonical "user-facing name" for the account (locked, NOT NULL, btrim 1..256, with a CHECK from W01B session-identity `#62`). `recruiters.display_name` is the canonical personnel display name (NOT NULL, btrim 1..256, from foundation). For the leader-candidate projection, the **app-user `display_name`** is the right choice: the UI needs the name of the **app account** it will designate, and the personnel name is a separate administrative attribute. The candidate RPC therefore selects `u.display_name` (app user) and joins `r.personnel_code` (recruiter) so the projection stays a 4-key bounded shape and does not double-render names. |
| E27 | `entry_admin@all` alone | The catalog-operator guard at `#68` denies `entry_admin@all` when `recruiter_master_manage` or `team_master_manage` is missing. A leader-lifecycle mutation that arrives from a `session` whose capabilities are only `entry_admin@all` (a legacy Project-Admin actor) is denied with `42501`; the API surfaces it as `LEADER_DENIED` 403. This protects the rule that Full Admin is the triple, not the single token. |

## 2. RPC matrix (locked truth at base `5fad15f`)

| RPC | Kind | Inputs | Authority | Returns / projects | Allowed SQLSTATEs the server is allowed to map to a sanitized code | Forbidden fields the server must never forward |
|---|---|---|---|---|---|---|
| `direct_entry_list_team_leaders_current` | read (list) | `(p_auth_subject, p_app_user_id, p_team_id=null, p_search<=256, p_page 1..1000, p_page_size 1..100)` | E6 read authority (catalog operator OR own-team leader) | `{authorization_date, page, page_size, total, leaders[]}` of E5 9-key projection (state = `CURRENT`) | `42501` (authority) → `LEADER_DENIED` 403; `22023` (bad page/size/search) → `LEADER_INVALID` 400; otherwise 200 with envelope | `auth_subject`, `email`, grant ids, raw scope/capability rows, reason text, audit internals |
| `direct_entry_list_team_leaders_scheduled` | read (list) | same | E6 | envelope, state = `SCHEDULED` | same | same |
| `direct_entry_list_team_leader_history` | read (list) | same | E6 | envelope, state = `HISTORY` (includes zero-length cancellation markers, which are never `CURRENT` or `SCHEDULED`) | same | same |
| `direct_entry_designate_team_leader` | write (RPC) | `(auth, app, team_id, leader_app_user_id, effective_date, expected_version>=1, reason btrim 1..4000, idempotency_key 1..128)` | `direct_entry_assert_catalog_operator` returns the exercised authority (`'entry_admin'` for Full-Admin triple, `'catalog_master_manage'` for Accounting). `entry_admin@all` alone is **not** enough. Never accepts client-supplied capability/scope/recruiter/team. | `{team_id, assignment_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to=null, version, revision_id, change ∈ {'designate','replace'}}` | `40001` → `LEADER_CONFLICT` 409; `42501` (authority/identity/eligibility/cross-team/pre-existing capability) → `LEADER_DENIED` 403; `23514` (target team inactive, reserved team, marker guard) → `LEADER_INVALID` 400; `23505` (idempotency unique) → `LEADER_CONFLICT` 409; `23P01` (overlap) → `LEADER_CONFLICT` 409; `P0002` → `LEADER_NOT_FOUND` 404; `22023` (bad input or key reuse with different payload) → `LEADER_INVALID` 400; `55000` (postcondition) → `LEADER_UNAVAILABLE` 500; any other → `LEADER_UNAVAILABLE` 500 | the eight-key snapshot internals beyond the canonical mutation envelope; `auth_subject` (already known server-side); the prior leader's email/auth_subject; raw exception text |
| `direct_entry_revoke_team_leader` | write (RPC) | `(auth, app, team_id, effective_date, expected_version>=1, reason, idempotency_key)`; no `leader_app_user_id` | same as designate | `{team_id, assignment_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to=p_effective_date, version, revision_id, change='revoke'}` | same map; revoke on the reserved team raises `23514` → `LEADER_INVALID` 400; revoke on an inactive business team is allowed (A1b2 handoff is explicit on this) | same |

`p_authority` for designate/revoke audit is the **literal returned by the catalog-operator guard** (`'entry_admin'` only when the Full-Admin triple is satisfied, or `'catalog_master_manage'`). The leader path is **not** allowed to write a leader designation — the wrappers reject by virtue of the catalog-operator guard raising `42501` first; the closing self-check forces that order. The leader read authority is a separate resolver that admits both catalog operators and one-team leaders (for **own-team reads only**; a non-catalog team leader that supplies a different `p_team_id` is denied with `42501`).

## 3. Candidate source finding (B)

**A canonical, catalog-operator-only, team-scoped leader-candidate RPC does not exist at base `5fad15f`.** This is the A2 blocker.

| Source | Has it now? | Why it is or is not enough |
|---|---|---|
| Personnel catalog `personnel_catalog_list` / `personnel_catalog_get` (`#68`) | Returns `personnel_position`, not `app_user_id` or any link id. | A2 must know whether the candidate has an enabled app user and one verified link; the personnel catalog is intentionally not allowed to expose that. E24. |
| Team membership `team_membership_list_current` (`#70`) | Returns `recruiter_id, team_id, team_display_name, valid_from, valid_to, state` for the membership in question. | A2 needs the **app user**, not the recruiter. It also needs the verified link, the HRP provider, the no-other-leader-team rule and the no-pre-existing-authority rule; the membership read covers none of these. E25. |
| Project manager candidates `direct_entry_list_project_manager_candidates` (`#54`, W06A-R2) | Returns `recruiter_id, display_name, personnel_code, personnel_position` for **active recruiters with one verified effective link**. | Wrong authority (project-admin = `entry_admin@all`; the leader-candidate route requires the canonical catalog-operator guard, which accepts Full-Admin triple OR `catalog_master_manage@all`), wrong scope (no team filter, no team-membership predicate, no HRP-only rule, no enabled-app-user rule, no leader-in-another-team exclusion, no `app_user_id` target identifier). The brief is explicit: it is reference only; the leader-candidate RPC may not reuse the project-admin guard. E22. |
| A purpose-built leader-candidate RPC | **Missing.** | See below. |

### Required minimum leader-candidate RPC (must be appended inside migration `#71` before A2 is implemented — do not reserve `#72`)

Signature (mirrors the read-RPC style, service-role only, `search_path=pg_catalog, public`, revoked from every role, EXECUTE only to `service_role`):

```text
direct_entry_list_team_leader_candidates(
  p_auth_subject        uuid,
  p_app_user_id         uuid,
  p_team_id             uuid,        -- REQUIRED, taken from URL path; not from body/header
  p_search              text default null,   -- btrim, len <= 256
  p_page                integer default 1,    -- 1..1000
  p_page_size           integer default 25    -- 1..100
) returns jsonb
```

Authority: the RPC **must** call `direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id)` and return its `42501`/`P0002` result on any non-catalog-operator actor — a team leader is not authorized to call this RPC. The leader read authority (E6) is **not** a substitute: the leader path admits only own-team reads, not candidate enumeration; the brief is explicit that team leaders have no leader-candidate path.

Team existence and reserved-status checks (in-DB, before the row enumeration): the RPC must `select … for update`-less read of `public.teams where team_id = p_team_id`; if the row is absent raise `P0002`, if `code = '__system_vendor__'` raise `P0002` (so the API surfaces it as `LEADER_NOT_FOUND` 404 without leaking the team's reserved status), and if `active = false` raise `P0002` as well (so the API surfaces the same 404 — the API does not distinguish "not found" / "reserved" / "inactive" for the candidate route, matching the leader-read E23 fail-closed posture). No UUID is hard-coded in the API path layer for the reserved team; the DB code constant is the only source of truth.

Predicates for the candidate rows (every row must satisfy **all** at the server's authorization date):

1. The candidate's app user is `enabled = true`.
2. The candidate has **exactly one** effective verified app-user/recruiter link (zero, two, expired, future, future-closing or unverified → exclude).
3. The linked recruiter is `active = true`.
4. The linked recruiter has **exactly one** effective HRP provider membership (`provider_type = 'hrp' AND vendor_id IS NULL`); any `vendor` provider → exclude.
5. The linked recruiter has **exactly one** effective membership in **this** team (`recruiter_team_memberships` half-open on the authorization date). A membership in another team is a hard exclude.
6. The candidate is **not** the current effective leader of **any** team (`direct_entry_team_leader_assignments` half-open) — this is the locked `one team per leader` cardinality.
7. The candidate holds **no** pre-existing effective `team` scope or `team_manager_assign` interval (so the designate transaction can open both without overlap).

Projection (bounded; `app_user_id` is **the opaque mutation target the designate body must echo back** and is allowed in this projection because the entire purpose of the route is to give the UI a target identifier; the brief explicitly permits it for the candidate projection only):

```text
{
  app_user_id,         -- opaque identifier, required as the designate body target
  recruiter_id,        -- opaque identifier (single verified link)
  display_name,        -- app-user display_name (E26)
  personnel_code       -- nullable, from recruiters
}
```

Plus the envelope the read-RPCs already use:

```text
{ authorization_date, page, page_size, total, candidates[] }
```

Search bound 256, page 1..1000, page_size 1..100; `candidates` ordered by `display_name, app_user_id`. The RPC is **not** allowed to call `direct_entry_system_vendor_team_id()`; the reserved-team filter is the explicit `t.code <> '__system_vendor__'` and the closing migration self-check must add this RPC to its loop, reject reserved-creator references, reject `personnel_position` reads, and verify search_path + definer + service-role-only ACL.

**Why this must be appended inside `#71` and not in `#72`:** A2 (the application surface) needs the candidate set for Admin/Accounting designate and replace. Without a bounded, team-scoped, catalog-operator-only candidate RPC, A2 would have to either (a) over-grant by reusing the W06A project-admin RPC (forbidden by C01: the project-admin guard is `entry_admin@all`, the leader lifecycle requires the catalog-operator guard, and `entry_admin@all` alone is not Full Admin — E27), or (b) under-fetch by stitching together personnel + membership + link reads in TypeScript, which leaks PII (`recruiter_id`, link counts, eligibility predicates) and reintroduces the N+1 the contract forbids. R0 (A2-S0) is therefore **a blocker** until the candidate RPC is appended to `#71` and the closing self-check confirms the same ACL/definer/search_path posture as the read and write RPCs already locked.

**The leader-candidate RPC is the only contract delta A2 depends on from #71.** Everything else in §4 uses surface that already exists at `5fad15f`.

## 4. Locked recommended API contract (C)

> One hierarchy, no parallel routes. All read routes are GET; designate-or-replace and revoke are POST. **Team id is always taken from the URL path; `leader_app_user_id` for designate/replace is always taken from the mutation body; revoke does not accept a target leader id at all.** All mutation bodies are exactly the business keys the locked C01 + W01D contracts allow.

### 4.1 Common contract (every route)

- Feature gate: `process.env.DIRECT_ENTRY_API_ENABLED === "true"`, otherwise the route returns `404 NOT_FOUND` with `Cache-Control: private, no-store`. The leader read routes share the same gate as the existing catalog admin routes.
- Cache: every response carries `Cache-Control: private, no-store`. The existing P3.1 admin routes also add `Pragma: no-cache`, `Expires: 0`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` via the shared helper; A2 reuses that helper, never a per-route ad-hoc header.
- Runtime: `export const runtime = "nodejs"; export const dynamic = "force-dynamic";`.
- Server session: the only actor source is `getDirectEntryActor(createDirectEntryActorRepository())`; `auth_subject` and `app_user_id` are read once from the session and passed to the repository — never taken from body, header, query or path.
- Recursive client-authority rejection: the body of every mutation is run through `validateClientBusinessPayload` before any other parser. `actor`, `role`, `capability`, `scope`, `auth_subject`, `app_user_id` (except for the designate target field, which is a business identifier and is allowed only in the designate body — see §6), `team_id` (where it must come from the path) and any other authority field reject the request with `CLIENT_AUTHORITY_FIELD_FORBIDDEN` 400. This is the same recursive walk the existing W01B/C-B/C-A APIs use. The designate body is allowed to carry `leader_app_user_id` because it is the **target** of the mutation, not an authority claim about the actor.
- Bounded JSON: `readBoundedJson(request)` with `MAX_BODY_BYTES = 64 KiB` (`src/lib/direct-entry/write-api.ts`). On overflow, content-type mismatch or malformed JSON: `BODY_INVALID` 400. This is the existing W01B/C-B/C-A bound.
- Idempotency: mutation bodies carry `idempotency_key` (UUID, 1..128). If the request has an `idempotency-key` header, it must equal the body key exactly; otherwise `IDEMPOTENCY_KEY_MISMATCH` 400. Same key + same payload hash → identical stored result; same key + different payload → `LEADER_INVALID` 400 (server-side classification of `22023` "idempotency key reused with different input" as invalid in the catalogue, **before** the lock is taken).
- Reserved team: the API **does not hard-code or recognise the reserved team UUID**; the path layer only validates UUID shape. The DB code constant `__system_vendor__` (resolved at SQL time) is the single source of truth. For **reads** the reserved team is filtered out by the DB WHERE clause and the API surfaces "no rows" inside the canonical envelope; for **mutations** the DB raises `23514` and the API maps it to `LEADER_INVALID` 400; for the **candidate** route the DB raises `P0002` for missing/reserved/inactive team and the API maps it to `LEADER_NOT_FOUND` 404. The API never returns a reserved-team-specific code, never returns `LEADER_DENIED` for a reserved team, and never distinguishes "reserved" from "not found" in a response body.
- Sanitized errors: the route handler never forwards raw `error.message`. Repository → `{ok:false, kind}`; API → `LEADER_<KIND>` per §5.
- No client actor authority: actor is **only** the session; the team id is **only** the URL path; the designate target `leader_app_user_id` is **only** the body; the revoke target is **not** in the body; the effective date, expected version, reason and idempotency key are **only** the body.

### 4.2 Read routes

#### `GET /api/admin/catalog/team-leaders?state=current|scheduled|history`

| Aspect | Value |
|---|---|
| Query keys (exact, order-free) | `state` (mandatory, `current` / `scheduled` / `history`), `team_id` (optional UUID), `search` (optional, ≤ 256), `page` (default 1, 1..1000), `page_size` (default 25, 1..100) |
| Body | none |
| Session order | gate → query parser → session → repository |
| Success | `200` with `{ ok: true, list: { authorization_date, page, page_size, total, leaders[] } }`, leaders are 9-key `state ∈ {CURRENT, SCHEDULED, HISTORY}` |
| Error → status | `LEADER_DENIED` 403 (authority, including a non-catalog team leader that supplied a different `team_id` — the E6 resolver raises `42501` and the API surfaces `LEADER_DENIED` 403, **not** an empty list), `LEADER_INVALID` 400, `LEADER_NOT_FOUND` 404, `LEADER_UNAVAILABLE` 500, `NOT_FOUND` 404 if gate closed, `UNAUTHENTICATED` 401, `ACTOR_NOT_AVAILABLE` 403 |
| Idempotency | n/a (read) |
| Recursive authority | the read routes do not call `validateClientBusinessPayload` because there is no body, but a separate defensive scan of `Object.keys` on the parsed query rejects any client attempt to send `auth_subject`, `app_user_id`, `capability`, `scope`, `role` as query keys (`LEADER_INVALID` 400). |

#### `GET /api/admin/catalog/team-leader-candidates?team_id=<uuid>&search=&page=&page_size=`

| Aspect | Value |
|---|---|
| Query keys (exact) | `team_id` (mandatory UUID; not allowed in the body), `search` (optional ≤ 256), `page` (default 1, 1..1000), `page_size` (default 25, 1..100) |
| Body | none |
| Session order | gate → query parser → session → RPC |
| Success | `200` with `{ ok: true, list: { authorization_date, page, page_size, total, candidates[] } }`, candidates are 4-key `{app_user_id, recruiter_id, display_name, personnel_code}` — `app_user_id` is the opaque mutation target and is **the only** identifier the UI needs; **no** `auth_subject`, **no** email, **no** link/grant/scope ids, **no** raw authority rows |
| Error → status | `LEADER_DENIED` 403 (non-catalog-operator actor, including a team leader — the candidate RPC requires the canonical catalog-operator guard), `LEADER_INVALID` 400, `LEADER_NOT_FOUND` 404 (team missing, reserved, or inactive — the API does not distinguish), `LEADER_UNAVAILABLE` 500, `NOT_FOUND` 404 if gate closed, `UNAUTHENTICATED` 401, `ACTOR_NOT_AVAILABLE` 403. `team_id` missing/malformed → `LEADER_INVALID` 400. |
| Notes | This route is the **single** candidate source for both Admin/Accounting designate and replace. There is no parallel `GET /api/admin/team-leader/.../candidates` route, and there is no leader-scoped candidate route; team leaders have no path into the candidate set. |

### 4.3 Mutation routes

#### `POST /api/admin/catalog/teams/:teamId/leaders` (designate or replace)

| Aspect | Value |
|---|---|
| Path | `:teamId` is a UUID; the path layer validates only UUID shape — the reserved-team decision is owned by the DB. The DB raises `23514` for a reserved team and the API surfaces it as `LEADER_INVALID` 400. A missing team surfaces as `LEADER_NOT_FOUND` 404. |
| Body keys (exact) | `leader_app_user_id` (UUID, **opaque mutation target — the path does not carry it**), `effective_date` (ISO `YYYY-MM-DD` regex, then `parseIsoDate` calendar-valid), `expected_version` (int >= 1), `reason` (btrim 1..4000), `idempotency_key` (UUID, 1..128) |
| Headers | `content-type: application/json`; `idempotency-key` must match the body key; `origin`/`sec-fetch-site`/`host` pass the existing same-origin guard |
| Session order | gate → same-origin → content-type + bounded JSON → recursive authority rejection → strict body projection → idempotency-key match → session → repository |
| Repository | `createTeamLeaderRepository()` (new, mirrors the W01C-B repository). `repository.designateLeader({auth_subject, app_user_id, team_id, leader_app_user_id, effective_date, expected_version, reason, idempotency_key})` |
| Success | `200` with `{ ok: true, leader: { team_id, assignment_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to: null, version, revision_id, change: 'designate' | 'replace' } }` |
| Error → status | per §5 taxonomy. Reserved team → `LEADER_INVALID` 400 (DB 23514). Missing team → `LEADER_NOT_FOUND` 404. Inactive business team → `LEADER_INVALID` 400 (DB 23514). |

#### `POST /api/admin/catalog/teams/:teamId/leaders/revoke`

| Aspect | Value |
|---|---|
| Path | `:teamId` UUID; the path layer validates only UUID shape. |
| Body keys (exact) | `effective_date`, `expected_version`, `reason`, `idempotency_key`. **No `leader_app_user_id`**: the target is the current effective leader at `effective_date`, which the server resolves inside the locked transaction. A body that contains `leader_app_user_id` is rejected as `LEADER_INVALID` 400 (extra key). |
| Headers / order | identical to designate |
| Repository | `repository.revokeLeader({auth_subject, app_user_id, team_id, effective_date, expected_version, reason, idempotency_key})` |
| Success | `200` with `{ ok: true, leader: { …, valid_to: effective_date, change: 'revoke' } }` |
| Error → status | per §5 taxonomy. Reserved team → `LEADER_INVALID` 400 (DB 23514). Missing team → `LEADER_NOT_FOUND` 404. Inactive business team → revoke is allowed (A1b2 handoff is explicit) and succeeds with a `valid_to = effective_date` close. |

### 4.4 Why one hierarchy

- The brief explicitly forbids parallel routes. A separate `/api/admin/team-leader/leaders` tree would re-implement the gate, the same-origin/CSRF check, the bounded JSON check, the recursive authority rejection, the strict projection, the session resolve and the no-store header — and it would create a second route map a future leader-UI consumer has to gate on. The team catalog at `/api/admin/catalog/teams` already owns `expected_version` on the team; a sibling `/api/admin/catalog/team-leaders/*` is the only consistent place for leader reads/mutations, and `/api/admin/catalog/teams/:teamId/leaders` is the only consistent place to express "this leader acts on this team". A `:leaderAppUserId` is **never** in the path for designate (the body owns it, exactly as the W01C-B membership body owns `valid_from` while the path owns the team), and it is **not** allowed in the revoke path or body at all.
- The candidate route is a sibling of the leader read route, not a child of the team route, so a catalog operator can fetch candidates without restating the team id in the path twice (the team is supplied once, as the required `team_id` query key).

## 5. Authority and error matrix (D)

| Actor / state | Read current/scheduled/history | Read candidates | Designate / replace | Revoke | Direct forged cross-team call |
|---|---|---|---|---|---|
| Full Admin (canonical triple `entry_admin + recruiter_master_manage + team_master_manage` at effective `all` scope) | allow (any team) | allow (any active non-reserved team) | allow | allow | allow |
| `entry_admin@all` alone (legacy Project-Admin actor, missing the other two tokens) | deny `LEADER_DENIED` 403 | deny `LEADER_DENIED` 403 | deny `LEADER_DENIED` 403 | deny `LEADER_DENIED` 403 | deny `LEADER_DENIED` 403 |
| Accounting catalog operator (`catalog_master_manage@all`) | allow | allow | allow | allow | allow |
| Team leader (`team_manager_assign@team` — the W02 project-manager-assign authority) | allow own team only; a different `team_id` is `LEADER_DENIED` 403, not an empty list | **deny** `LEADER_DENIED` 403 — the candidate RPC requires the catalog-operator guard | **deny** `LEADER_DENIED` 403 — the catalog-operator guard denies a `team_manager_assign`-only actor | **deny** `LEADER_DENIED` 403 — same reason | **deny** `LEADER_DENIED` 403 — the cross-team assertion in the read authority fails closed for non-catalog leaders |
| Project manager (assignment-derived) | deny | deny | deny | deny | deny |
| Ordinary staff | deny | deny | deny | deny | deny |
| Disabled actor with live grants | deny (`enabled` predicate in the session) | deny | deny | deny | deny |
| Unmapped or mismatched `auth_subject`/`app_user_id` | deny `LEADER_DENIED` 403 | deny | deny | deny | deny |
| Ambiguous actor (multiple verified links, multiple effective memberships, multiple team scopes) | deny `LEADER_DENIED` 403 | deny | deny | deny | deny |
| Inactive business team | reads filtered to zero rows (state `HISTORY` may still include it) | candidates: `LEADER_NOT_FOUND` 404 (the candidate RPC raises `P0002` for an inactive team) | deny `LEADER_INVALID` 400 (server raises 23514) | allow (the locked contract permits revoke on an inactive business team — A1b2 handoff) | deny |
| Reserved `__system_vendor__` team | always filtered out by the DB WHERE (zero rows in every state) | `LEADER_NOT_FOUND` 404 (the candidate RPC raises `P0002` for a reserved team — indistinguishable from a missing team) | `LEADER_INVALID` 400 (server raises 23514) | `LEADER_INVALID` 400 (server raises 23514) | deny, indistinguishable from "not found" |
| Future-dated designation or revoke | allow (RPC supports `effective_date > today`; authority and eligibility evaluated **at** `effective_date`) | n/a | allow | allow | n/a |
| Stale `expected_version` | n/a | n/a | `LEADER_CONFLICT` 409 (40001) | `LEADER_CONFLICT` 409 (40001) | n/a |
| Same `idempotency_key` + same payload | n/a | n/a | identical stored result (200, same body) | identical stored result (200, same body) | n/a |
| Same `idempotency_key` + different payload | n/a | n/a | `LEADER_INVALID` 400 (server raises 22023 "idempotency key reused with different input") | `LEADER_INVALID` 400 | n/a |
| No body / wrong content-type / oversize / malformed JSON | n/a | n/a | `CONTENT_TYPE_INVALID` 400 or `BODY_INVALID` 400 | same | n/a |
| Recursive client authority field | `LEADER_INVALID` 400 (`validateClientBusinessPayload`) | n/a (no body) | `CLIENT_AUTHORITY_FIELD_FORBIDDEN` 400 (the body may carry `leader_app_user_id` because it is the mutation target; any other authority field is rejected) | `CLIENT_AUTHORITY_FIELD_FORBIDDEN` 400 | n/a |
| Origin / CSRF | n/a (GET) | n/a (GET) | `CSRF_REJECTED` 403 | `CSRF_REJECTED` 403 | n/a |
| RPC raises an SQLSTATE not in the catalogue | `LEADER_UNAVAILABLE` 500 (and `console.error`) | `LEADER_UNAVAILABLE` 500 | `LEADER_UNAVAILABLE` 500 | `LEADER_UNAVAILABLE` 500 | `LEADER_UNAVAILABLE` 500 |
| Postcondition 55000 (locked transaction defect) | n/a | n/a | `LEADER_UNAVAILABLE` 500 | `LEADER_UNAVAILABLE` 500 | n/a |
| Read `current/scheduled/history` overlap (a zero-length marker) | marker appears **only** in `history`; never in `current` or `scheduled` | n/a | n/a | n/a | n/a |
| Audit labels | n/a | n/a | `action='team_leader_designate' | 'team_leader_replace'`, `capability=p_authority` (`entry_admin` only for the Full-Admin triple, or `catalog_master_manage`), `scope_kind='all'`, `resource_ref=p_team_id::text` | `action='team_leader_revoke'`, `capability=p_authority`, `scope_kind='all'`, `resource_ref=p_team_id::text` | n/a |

The leader path **never** writes `capability='team_manager_assign'` on a leader-designate audit row (C01: `team_manager_assign` is the W02 project-manager-assign capability, not a leader-lifecycle authority token). The leader **read** path does not write audit rows.

## 6. File/symbol implementation map (read-only; A2 must not start until §8 sequencing allows)

| Layer | File (mirror, not edit) | Symbol | Status at `5fad15f` |
|---|---|---|---|
| Contract (read items) | `src/lib/direct-entry/team-leader-contract.ts` (new, mirrors `team-membership-contract.ts`) | `teamLeaderItem(value)` 9-key, `teamLeaderList(value)` envelope, `teamLeaderMutation(value)` 9-key, `teamLeaderCandidate(value)` 4-key, `teamLeaderCandidateList(value)` envelope | **Missing.** A2 must add (no edit to existing files; the new contract is its own module). |
| Contract (read items) — projection keys | same | 9 keys (E5) and 4 keys (§3) | the canonical shape is the E5 projection; the candidate projection includes `app_user_id` because it is the opaque mutation target, and does **not** include `auth_subject`, email, link/grant/scope ids, or raw authority rows. The file/symbol map and the exact-key tests in §7 must both allow `app_user_id` in the candidate projection. |
| API | `src/lib/direct-entry/team-leader-api.ts` (new) | `listTeamLeader`, `listTeamLeaderCandidates`, `designateTeamLeader`, `revokeTeamLeader` | **Missing.** Mirrors `team-membership-api.ts` (gate → same-origin → bounded JSON → authority rejection → strict projection → session → repository). The API is **not** an authorization engine: it calls the canonical RPCs, surfaces the SQLSTATE taxonomy, and never re-implements the catalog-operator guard. |
| Repository | `src/lib/direct-entry/team-leader-repository.ts` (new) | `createTeamLeaderRepository(rpc?)` with `listLeaders`, `listCandidates`, `designateLeader`, `revokeLeader`; `classifyTeamLeaderError({code, message})` per §5 map | **Missing.** Calls the six RPCs in §2 (or seven, once the candidate RPC is appended to `#71`); never reads/writes tables directly. The repository is a thin RPC shim — the SQLSTATE → kind map is the only behavior the test can verify without the DB. |
| Route handlers | `src/app/api/admin/catalog/team-leaders/route.ts` (new, GET state) | feature-gated `GET` | **Missing.** |
| Route handlers | `src/app/api/admin/catalog/team-leader-candidates/route.ts` (new, GET) | feature-gated `GET` | **Missing.** |
| Route handlers | `src/app/api/admin/catalog/teams/[teamId]/leaders/route.ts` (new, POST designate/replace) | feature-gated `POST` | **Missing.** |
| Route handlers | `src/app/api/admin/catalog/teams/[teamId]/leaders/revoke/route.ts` (new, POST revoke) | feature-gated `POST` | **Missing.** |
| Route handlers (admin/team-leader) | (no second tree, no leader-scoped candidate route) | n/a | A2 must **not** create `/api/admin/team-leader/...`; the brief explicitly forbids parallel routes and team-leader candidate access. |
| DB (RPC) | `supabase/migrations/20261009070000_p3_1_w01d_team_leader_lifecycle.sql` (in the feature branch at `5fad15f`, not yet accepted by T0, not yet on `main`) | `direct_entry_list_team_leaders_current/scheduled/history`, `direct_entry_designate_team_leader`, `direct_entry_revoke_team_leader`, `direct_entry_apply_team_leader_mutation`, `direct_entry_assert_team_leader_read_authority`, `direct_entry_team_leader_snapshot`, `direct_entry_team_leader_projection` | present in the feature branch at `5fad15f`; not yet "shipped" in the Production/main sense. |
| DB (RPC) | same migration, **must be appended by A1b3 before A2** | `direct_entry_list_team_leader_candidates(auth, app, team_id, search, page, page_size)` per §3 | **Missing — A2 blocker.** A1b3 is the right owner: the candidate RPC is a DB-only addition that pairs naturally with the legacy transition (A1b3 also pairs a transition audit; both stay in the same migration). |
| Test lane (no browser) | `scripts/p3-1-w01d-a2-leader-server.test.mjs` (new) | per §7 | **Missing.** |
| Feature gate | `process.env.DIRECT_ENTRY_API_ENABLED` | shared with W01B/C-A/C-B | reused as-is |
| Session | `getDirectEntryActor(createDirectEntryActorRepository())` | already used by W01B/C-A/C-B | reused as-is |
| Same-origin | `checkSameOriginRequest` (`src/lib/ai/gateway/http-guards.mjs`) | reused | reused as-is |
| Authority guard | `validateClientBusinessPayload` (`src/lib/auth/direct-entry-v2.ts`) | reused | reused as-is |
| Bounded JSON | `readBoundedJson` (`src/lib/direct-entry/write-api.ts`, `MAX_BODY_BYTES = 64 KiB`) | reused | reused as-is |
| Date parser | `parseIsoDate` (`src/lib/direct-entry/direct-entry-date-format.ts`) | reused | reused as-is |
| `NO_STORE_HEADERS` | shared helper in the auth/w04-gateway stack | reused | reused as-is |

## 7. Regression / mutation plan (E, no browser)

A2 must add two distinct test layers, with a clear boundary between them. **The API/repository layer cannot prove behavioral authority from a stub that only returns SQLSTATEs.** The DB/PGlite focused lane is the only place where the authority/zero-residue/concurrency/postcondition evidence is produced; the API/repository lane produces parsing, projection, session, request order, taxonomy and single-RPC-call evidence.

### 7.1 API/repository lane (`scripts/p3-1-w01d-a2-leader-server.test.mjs`, injected `rpc`)

This lane injects an `rpc` stub. The stub's **only** contract is "return what the canonical RPC would have returned": a `data` value, an `error` value, or a thrown exception. The lane does **not** simulate authority — the stub is not allowed to make authority decisions; authority is always produced by the DB. Cases where the stub returns a value that contradicts the DB contract are equivalent to the DB returning a malformed projection and are surfaced as `LEADER_UNAVAILABLE` 500.

Required cases:

1. **Projection exact-key (read)** — every successful read response parses through `teamLeaderItem` and `teamLeaderList`; an extra key (`email`, `auth_subject`, `grant_id`, `scope`, `capability`, `reason`, `audit`) is rejected as a malformed projection (`unavailable`); a missing key is rejected the same way. For the candidate projection, `app_user_id` is **required and allowed**; `auth_subject`, email, link/grant/scope ids, and raw authority rows are forbidden. Same shape assertion for `teamLeaderCandidate` and `teamLeaderCandidateList`.
2. **Projection exact-key (write)** — the designate/revoke response parses through `teamLeaderMutation`; an extra key or a wrong type (`valid_to` is `null` for designate, the same date for revoke) is rejected; a `change` other than `'designate' | 'replace' | 'revoke'` is rejected.
3. **Query / body parser** — every required key missing/extra/`null`/wrong type on the read query or mutation body is rejected with `LEADER_INVALID` 400 before the session is touched. UUID regex enforces v1..v8; `parseIsoDate` rejects 2026-02-30, 2026-13-01, 2026-00-10.
4. **Invalid real calendar date** — even with the regex, `2026-02-30` is rejected with `LEADER_INVALID` 400.
5. **UUID / path validation** — `teamId` not a UUID, `leader_app_user_id` not a UUID → `LEADER_INVALID` 400. The path layer does **not** reject a UUID for being the reserved team; the DB owns that decision.
6. **Gate ordering** — when `DIRECT_ENTRY_API_ENABLED !== "true"`, every route returns `NOT_FOUND` 404 with `Cache-Control: private, no-store` and the session is **never** resolved.
7. **Same-origin (mutation)** — a request with `sec-fetch-site: cross-site` or no `origin`/host match is rejected with `CSRF_REJECTED` 403 before the body is read.
8. **Recursive client authority** — a mutation body containing `actor`, `role`, `capability`, `scope`, `auth_subject`, `app_user_id` (except for `leader_app_user_id` in the designate body, which is the mutation target), `team_id` (the path is the only source for the team id) — at any depth, including arrays — is rejected with `CLIENT_AUTHORITY_FIELD_FORBIDDEN` 400; the read query parser rejects the same keys at the top level.
9. **Session failure** — `UNAUTHENTICATED` 401 when the session returns no actor; `ACTOR_NOT_AVAILABLE` 403 when the actor mapping is corrupt; the body is **not** read until this check succeeds for the catalogue of operations that need an actor.
10. **Repository SQLSTATE taxonomy** — the matrix in §5 is exercised case-by-case through the injected `rpc` stub. The lane asserts that a code not in the catalogue returns `LEADER_UNAVAILABLE` 500, a 55000 postcondition code also returns `LEADER_UNAVAILABLE` 500, and that the API does **not** simulate zero-residue from the stub — zero-residue is a DB property (see §7.2).
11. **Current / scheduled / history separation** — disjoint projections: a row whose `valid_from` is in the future is never in `current`; a row whose `valid_to <= today` is never in `current`; a cancellation marker is in `history` and never in `current` or `scheduled`. Paging bound 1..1000; `page_size` 1..100; `search` bound 256.
12. **OCC conflict** — when the stub returns `40001` for a designate/revoke call, the API returns `LEADER_CONFLICT` 409. The lane asserts the SQLSTATE-to-kind mapping only; residue counts are a DB property.
13. **Idempotency replay** — when the stub returns the same stored result for a same-key + same-payload replay, the API returns the same body. When the stub returns `22023 "idempotency key reused with different input"`, the API returns `LEADER_INVALID` 400. The `idempotency-key` header mismatch returns `IDEMPOTENCY_KEY_MISMATCH` 400.
14. **Reserved team (mapping only)** — when the stub returns `23514 "reserved team cannot have a leader"` (designate or revoke), the API returns `LEADER_INVALID` 400 and **not** a reserved-team-specific code. When the stub returns `P0002` (team not found / reserved / inactive from the candidate RPC), the API returns `LEADER_NOT_FOUND` 404. The lane asserts the response body never distinguishes "reserved" from "not found" or "inactive" — that property is owned by the DB's `t.code <> '__system_vendor__'` filter and the `P0002` mapping.
15. **Malformed DB projection** — a synthetic `data` that fails the strict parser is surfaced as `LEADER_UNAVAILABLE` 500 (no success path, no echo of the DB payload).
16. **Candidate projection shape (after the §3 RPC lands in `#71`)** — the lane asserts the 4-key shape `{app_user_id, recruiter_id, display_name, personnel_code}` parses through `teamLeaderCandidate`. `app_user_id` is the only opaque target identifier; `auth_subject`/email/grant/authority fields are forbidden. The lane does **not** assert which rows the candidate RPC returns — that is a DB property (see §7.2).
17. **No N+1 / no direct table read** — the repository test injects an `rpc` stub; if the repository ever calls the stub more than the documented per-route count (read: 1, designate: 1, revoke: 1, candidate: 1), the test fails. The lane asserts the only SQL verb in the RPC stub is `rpc(name, args)` — no `.from(...)`, no raw `select`, no `serviceRoleRpc`-bypassing query.
18. **Source-stability of the migration (byte-grep)** — the lane asserts that the candidate RPC, after it is appended to `#71`, carries (a) the explicit `t.code <> '__system_vendor__'` filter, (b) the `search_path=pg_catalog, public` setting, (c) the `SECURITY DEFINER` marker, (d) the `direct_entry_assert_catalog_operator` call as the first authority step, and (e) no `personnel_position` reference. This is a byte-stability check on `#71` itself, not a behavioral test of the API.
19. **No browser tests** — the lane has zero `@playwright/test`, `@vitest/browser`, jsdom or happy-dom import. The lane script tag/dependency list is asserted in a grep guard.

### 7.2 DB / PGlite focused lane (authority, zero residue, concurrency, postconditions, rollback, reserved team)

This lane loads all 71 migrations (or the migration after A1b3, whichever is the current `5fad15f`+candidate-RPC HEAD) in PGlite and exercises the **real** RPCs. It owns the authority and zero-residue evidence that the API lane cannot produce. It reuses the A1b2 R1 fault-injection matrix as a base (it is not re-stated here — the R1 handoff is the source of truth for those cases).

The lane is added to the canonical `pnpm test` chain after the A1b2 lane and is responsible for:

- **Authority matrix (§5 rows)** — every actor/state combination is exercised against the real `direct_entry_assert_catalog_operator` and `direct_entry_assert_team_leader_read_authority`. A non-catalog team leader that calls the candidate RPC is denied by the catalog-operator guard; a non-catalog team leader that calls designate/revoke is denied by the same guard. `entry_admin@all`-only actors are denied.
- **Zero residue** — every failing mutation (postcondition `55000`, capacity/revoke/idempotency/reason failure injectors from A1b2 R1) leaves zero rows in the leader, scope, capability, revision, audit, reason, idempotency tables. The API lane cannot make this claim from a stub.
- **Concurrency** — two concurrent designates for the same team at the same effective date: the loser gets `40001` (OCC) or `23P01` (overlap). The row lock + advisory lock ordering is exercised end-to-end.
- **Postconditions** — the designate/replace/revoke post-state is asserted by direct table counts (this is the locked A1b2 postcondition; the API lane does not loosen or duplicate it).
- **Reserved team** — the trigger path (`23514`), the read-side `t.code <> '__system_vendor__'` filter, and the candidate RPC's reserved-team `P0002` are all exercised end-to-end. The lane asserts the API contract by checking that the corresponding API stub maps these SQLSTATEs to the right HTTP code (a small cross-lane assertion that the API mapper is correct).
- **Replacement rollback** — replay the A1b2 R1 fault-injection matrix exactly. A2's API lane does **not** replay the same matrix as fake evidence.

### 7.3 Mutation matrix (API/repository lane, stub only)

| # | What the stub returns | What the API/repository lane must observe |
|---|---|---|
| M1 | stub returns a 9-key leader item with an extra `email` key | `LEADER_UNAVAILABLE` 500 (projection failure) |
| M2 | stub returns a 9-key leader item missing `state` | `LEADER_UNAVAILABLE` 500 |
| M3 | stub returns a 4-key candidate item with `auth_subject` | `LEADER_UNAVAILABLE` 500 |
| M4 | stub returns 55000 on the postcondition step (designate) | `LEADER_UNAVAILABLE` 500 (the API surfaces it; **zero residue is asserted by the DB focused lane, not here**) |
| M5 | stub returns 40001 on the OCC compare (revoke) | `LEADER_CONFLICT` 409 |
| M6 | stub returns 23514 with `reserved team cannot have a leader` (designate) | `LEADER_INVALID` 400 (and a separate test asserts the API never returns a reserved-team-specific code) |
| M7 | stub returns 42501 with `target leader has pre-existing leader authority intervals` (designate) | `LEADER_DENIED` 403 |
| M8 | stub returns 22023 with `idempotency key reused with different input` (designate) | `LEADER_INVALID` 400 (per the catalogue — the *only* 22023 that maps to invalid) |
| M9 | stub returns 22023 with `expected team version required` | `LEADER_INVALID` 400 |
| M10 | stub returns 23P01 on overlap | `LEADER_CONFLICT` 409 |
| M11 | stub returns P0002 (team not found, or candidate RPC on missing/reserved/inactive team) | `LEADER_NOT_FOUND` 404 (the API does not distinguish) |
| M12 | stub returns an unknown SQLSTATE (`42P01`) | `LEADER_UNAVAILABLE` 500, no PII in the response, `console.error` is asserted (test mocks console) |
| M13 | the injected rpc is called **twice** for a single read | the lane fails (no N+1 / no double-call) |
| M14 | the injected rpc is called with `auth_subject` set to a non-UUID | the lane fails (the API must derive the actor from the session) |
| M15 | designate body has `actor` field | `CLIENT_AUTHORITY_FIELD_FORBIDDEN` 400 (before session, before RPC) |
| M16 | designate body has `team_id` (the path already owns it) | `CLIENT_AUTHORITY_FIELD_FORBIDDEN` 400 (the path is the only source for the team id) |
| M17 | the read query has `auth_subject` as a query key | `LEADER_INVALID` 400 |
| M18 | the `idempotency-key` header is a different UUID than the body key | `IDEMPOTENCY_KEY_MISMATCH` 400 |
| M19 | `effective_date = 2026-02-30` | `LEADER_INVALID` 400 (regex and `parseIsoDate`) |
| M20 | `expected_version = 0` | `LEADER_INVALID` 400 |
| M21 | `reason = ""` or reason = 4001 spaces | `LEADER_INVALID` 400 |
| M22 | `idempotency_key` is not a UUID | `LEADER_INVALID` 400 |
| M23 | `direct_entry_list_team_leader_candidates` returns a row with `auth_subject` in any field | `LEADER_UNAVAILABLE` 500 (projection must filter it out) |
| M24 | revoke body has `leader_app_user_id` | `LEADER_INVALID` 400 (revoke does not accept a target) |
| M25 | the designate body omits `leader_app_user_id` | `LEADER_INVALID` 400 (the body is the only source for the designate target) |

The API/repository lane does **not** assert "the API must reject a leader designate even when the stub returns success" — that authority is owned by the catalog-operator guard inside the RPC, and the DB focused lane proves it end-to-end. The API lane's job is to prove the pipeline and the projection.

## 8. Blockers and sequencing (F)

| Phase | Code-able from `5fad15f`? | Blocker | Action |
|---|---|---|---|
| §1, §2, §4.1, §5, §6, §7.1, §7.3 (read + designate + revoke handlers, repository, contract, projection parsers, error taxonomy, API/repository regression cases that use only the 6 RPCs already in the feature branch) | **Yes** — `5fad15f` is byte-stable, ledger is 71, and the six RPCs (read authority, three reads, apply helper, two wrappers) are present in the feature branch, ACL-locked, and self-checked. | none | A2 may build the application surface for read + designate + revoke from `5fad15f`, as long as A2 does not merge before the rest of this table resolves. |
| Candidate route (read `team-leader-candidates`) | **No** — the candidate RPC is **not** in `5fad15f` | missing `direct_entry_list_team_leader_candidates` in `#71`; A2 cannot ship the candidate route without it | append the candidate RPC inside `#71` (do **not** reserve `#72`), update the closing self-check loop to include it (definer, search_path, ACL, reserved-team-creator rejection, `personnel_position` rejection, source filter `t.code <> '__system_vendor__'`, page/page_size/search bounds, catalog-operator call as the first authority step), re-run A1a2, A1b1, A1b2, R1, R2 focused lanes; then A2 can import it. |
| Migration slot | n/a | the brief is explicit: **do not reserve `#72`**. The candidate RPC must be appended inside `#71`. | the A1b2-R2 closing self-check already enforces contract drift; A1b3 is the right owner for both the legacy transition and the candidate RPC, so the wave stays in one reviewed package. |
| A1b3 sequencing | n/a | the candidate RPC and the legacy transition must land in the same reviewed package; partial A1b3 is not acceptable. | A1b3 (a) reads the legacy team-scope inventory dynamically (no constant 7), (b) opens `team_manager_assign` for each legacy scope at the transition date, (c) appends the candidate RPC, (d) re-runs the focused lanes, (e) hands the wave to T0. |
| A2 integration / merge | blocked on A1b3 (legacy transition + candidate RPC) and on T0 acceptance of `#71` as final | A2 must not merge before all of: A1b3 completes, the candidate RPC is reviewed, and T0 locks `#71` final. | A2 stays on the `feature/p3-1-w01d-team-leader-lifecycle` branch; A2 does not push a merge PR. |
| T0 acceptance | n/a | only T0 declares the wave pass | A2 ships the server surface; A1a2/A1b1/A1b2/R1/R2 ship the DB surface so far; A1b3 ships the transition + candidate RPC; T0 closes the wave. |
| Production | n/a | none in this survey | explicitly out of scope: no Production query/apply/deploy, no browser/Playwright/CUA/UAT, no W02/W03/W04, no Personnel/Team/Vendor mutation surface, no team-scoped project-manager assignment. |
| Sequencing rule | A2 application code can be prepared from `5fad15f` (read + designate + revoke + API/repository tests). A2 must not be merged until A1b3 lands, the candidate RPC is reviewed, and T0 locks `#71` final. | | |

## 9. Boundary

Read-only survey. No source, migration, `package.json`, dependency, `docs/P3.1.md` or other code change. No Production query/apply/deploy, no browser/Playwright/CUA/UAT. Worktree is clean; the only tracked change for this survey is the single documentation file at `docs/handoffs/p3-1-w01d-a2-s0-server-api-contract-survey.md`. The candidate RPC and the legacy transition must be appended to `#71` by the **A1b3** lane — never in a new migration, never in a parallel branch, never as a `#72`. A2 is blocked on A1b3, the candidate RPC review and T0 acceptance of `#71` final.
