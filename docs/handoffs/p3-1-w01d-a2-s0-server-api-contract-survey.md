# P3.1-W01D-A2-S0 — Team leader lifecycle server/API contract and gap review

> Status: `P3_1_W01D_A2_S0_SERVER_API_SURVEY_PASS_AWAITING_T0`
> Lane: T1C read-only survey/review. No implementation, no source or migration edit, no `package.json`/dependency, no `docs/P3.1.md` change, no Production query/apply/deploy, no browser/Playwright/CUA/UAT.
> Base: `5fad15fd47cf60379fb8a05e0d650923d741de08` on `origin/feature/p3-1-w01d-team-leader-lifecycle`.
> Worktree: `C:\CodeApp\BI-p3-1-w01d-a2-server-contract-survey`; branch `audit/p3-1-w01d-a2-server-contract-survey`.
> Ledger at base: **71** migrations; `#71` = `20261009070000_p3_1_w01d_team_leader_lifecycle.sql` is last; `#72` is not present. Migration `#71` was amended in place at A1a1, A1a2, A1b1, A1b2, R1 and R2 and is the canonical, byte-stable surface this survey reads.
> Inputs: `AGENTS.md` (workspace rules only — this is a TypeScript/Next.js project, follow the "not the Next.js you know" rule on any later code task); `docs/P3.1.md`; `docs/handoffs/p3-1-w01c-membership-leader-security-baseline.md`; the four W01D handoffs (`p3-1-w01d-a1a1-schema-foundation.md`, `p3-1-w01d-a1a2-schema-regression.md`, `p3-1-w01d-a1b1-leader-read.md`, `p3-1-w01d-a1b2-leader-write.md`) and the R1/R2 closure memos; the canonical 23-token capability contract locked by C01; the personnel/team/team-membership catalog contracts (`src/lib/direct-entry/personnel-catalog-{contract,api,repository}.ts`, `team-catalog-…`, `team-membership-…`); the project-admin candidate pattern (`direct_entry_list_project_manager_candidates` in `supabase/migrations/20261008140000_p2_5_w06a_manager_candidates.sql`, surfaced via `project-admin-repository.ts` → `projectAdminCandidates`).

## 1. Evidence and current truth

| # | Source | Truth |
|---|---|---|
| E1 | `#71` (schema) | `public.direct_entry_team_leader_assignments(assignment_id, team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to, created_at)` half-open, `valid_to = valid_from` is a cancellation marker, **forced RLS, no role privilege**. Marker-excluding partial uniques on `(team_id, valid_from)` and `(leader_app_user_id, valid_from)`, plus a `(team_id, valid_from desc)` history index. |
| E2 | `#71` (schema) | `public.direct_entry_team_leader_revisions(revision_id, team_id, version, actor_user_id, action, before_snapshot, jsonb, after_snapshot, created_at)`, immutable via `direct_entry_reject_immutable_change()`, unique `(team_id, version)`, **forced RLS, no role privilege**. |
| E3 | `#71` (schema) | `direct_entry_audit_events` gained a nullable `leader_revision_id uuid REFERENCES public.direct_entry_team_leader_revisions(revision_id) ON DELETE RESTRICT`. |
| E4 | `#71` (helper) | `public.direct_entry_team_leader_snapshot(p_team_id, p_leader_app_user_id, p_leader_recruiter_id, p_valid_from, p_valid_to, p_previous_leader_recruiter_id, p_version, p_change)` returns **exactly** the eight fixed keys, immutable, SECURITY DEFINER, `search_path=pg_catalog, public`, revoked from every role. |
| E5 | `#71` (helper) | `public.direct_entry_team_leader_projection(assignment, team_display_name, leader_display_name)` returns **9 keys**: `assignment_id, team_id, team_display_name, leader_app_user_id, leader_recruiter_id, leader_display_name, valid_from, valid_to, state ∈ {CURRENT, SCHEDULED, HISTORY}`, stable, SECURITY DEFINER, `search_path=pg_catalog, public`, revoked from every role. **No** `auth_subject`, email, grant id, raw scope/capability row, reason or audit internals. |
| E6 | `#71` (read authority) | `public.direct_entry_assert_team_leader_read_authority(p_auth_subject, p_app_user_id, p_team_id)` — sole resolver, SECURITY DEFINER, `search_path=pg_catalog, public`, revoked from every role. Catalog operator path returns the supplied filter unchanged (so a stale/inactive/reserved filter narrows to zero rows). Leader path requires, in one transaction: enabled account mapping; one effective `team` scope; one verified effective recruiter link; active recruiter; exactly one effective HRP provider membership; exactly one effective membership in that same team; active non-reserved team; and exactly one matching effective leader assignment. Any ambiguous/missing/expired/disabled/mismatched state raises `42501`. |
| E7 | `#71` (read RPCs) | Three bounded service-role reads, all SECURITY DEFINER, `search_path=pg_catalog, public`, EXECUTE only to `service_role`, **reserved-team filter** `t.code <> '__system_vendor__'` enforced by both the WHERE and the closing self-check: `direct_entry_list_team_leaders_current(p_auth_subject, p_app_user_id, p_team_id, p_search, p_page, p_page_size)`, `…_scheduled(…)`, `…_history(…)`. Search bound 256, page 1..1000, page_size 1..100. Envelopes return `{authorization_date, page, page_size, total, leaders[]}` with the E5 projection only. |
| E8 | `#71` (write authority + helper) | `direct_entry_apply_team_leader_mutation(p_auth_subject, p_app_user_id, p_team_id, p_target_leader_app_user_id, p_effective_date, p_expected_version, p_reason, p_idempotency_key, p_operation, p_authority)` — sole internal mutator, SECURITY DEFINER, `search_path=pg_catalog, public`, revoked from every role. Two service-role wrappers: `direct_entry_designate_team_leader(auth, app, team_id, leader_app_user_id, effective_date, expected_version, reason, idempotency_key)` and `direct_entry_revoke_team_leader(auth, app, team_id, effective_date, expected_version, reason, idempotency_key)`. Each wrapper **must** call `direct_entry_assert_catalog_operator(auth, app)` first and pass that string as `p_authority` — the closing self-check requires the catalog guard call to **precede** the internal helper call. |
| E9 | `#71` (lock + advisory order) | OCC root = `public.teams` row (`select … for update`, version compare inside the same transaction → `40001`). Then ordered `for update` on `direct_entry_app_users(app_user_id)`, on `direct_entry_scope_grants(…) where scope_kind='team'`, on `direct_entry_capability_grants(…) where capability='team_manager_assign'`. Then `pg_advisory_xact_lock(hashtextextended(...))` on a stable key list covering outgoing `capability:<u>:<cap>`, `scope:<u>:<kind>:<team>`, incoming ones, and `recruiter-link:<u>`, plus designate-only `provider:<recruiter>`, `team-membership:<recruiter>`. |
| E10 | `#71` (eligibility, designate only) | Exactly one verified effective link (otherwise `42501 target leader requires exactly one verified recruiter link`); active recruiter (`42501 target recruiter is not active`); exactly one effective HRP provider membership (`42501 target recruiter requires exactly one effective HRP provider`); exactly one effective membership in the target team (`42501 target recruiter must have exactly one effective membership in the target team`); no overlap with another team’s effective/scheduled leader assignment (`42501 target leader is assigned or scheduled for another team`); no pre-existing effective `team` scope or `team_manager_assign` (`42501 target leader has pre-existing leader authority intervals`); enabled target account (`42501 target leader account is not enabled`). |
| E11 | `#71` (interval rule) | Designate inserts the new `team` scope, capability, and assignment at `p_effective_date`. If the same date is the outgoing assignment's `valid_from`, the helper sets `set_config('direct_entry.team_leader_marker', 'on', true)` before issuing the outgoing close so a same-day zero-length marker can be written; otherwise the trigger (`direct_entry_team_leader_marker` on assignments + the same trigger on scope/capability grants) raises `23514`. The marker is never effective for any date predicate. |
| E12 | `#71` (postconditions) | Designate/replace post-state (inside the same transaction, before team version bump / reason / revision / audit / idempotency finish): exactly one effective team-leader for the target team and it is the target app user; that user is effective leader of exactly one team (and that team is the target); exactly one effective target-team `team` scope; exactly one effective `team_manager_assign`; the new assignment/scope/capability all start at `p_effective_date` and have identical `valid_to`; outgoing leader is no longer effective; outgoing scope and capability are closed. Revoke post-state: no effective target-team leader, no effective target-team `team` scope, no effective `team_manager_assign`; the closed assignment/scope/capability each have `valid_to = p_effective_date`. Any mismatch raises generic `55000` with **no identity data**; the whole transaction rolls back. |
| E13 | `#71` (audit) | One `direct_entry_team_leader_revisions` row at the new `teams.version`; one `direct_entry_audit_events` row with `auth_subject, app_user_id, action='team_leader_<designate|replace|revoke>', capability=p_authority, resource_ref=p_team_id::text, scope_kind='all', outcome='APPLIED', reason_id, changed_fields=['team_leader_assignment','team_scope','team_manager_assign'], leader_revision_id`. The reason is recorded through the canonical `direct_entry_reason(actor, text)`; reason text 1..4000 chars after btrim. |
| E14 | `#71` (idempotency) | `direct_entry_rpc_idempotency` lookup before any mutation; same key + same `request_hash(jsonb{team_id, target_leader_app_user_id, effective_date, expected_version, reason})` returns the stored result; same key + different payload raises `22023 idempotency key reused with different input` **before** any write. `direct_entry_idempotency_begin` is called between the version compare and the DML; `direct_entry_idempotency_finish` is called after the postconditions and the audit insert. |
| E15 | `#71` (reserved team) | `if v_team.code = '__system_vendor__' then raise 23514 'reserved team cannot have a leader'` **before** any idempotency reservation, before any team version compare, before any DML — for both designate and revoke. The R1 closing self-check rejects any team-leader function that calls `direct_entry_system_vendor_team_id()`; the R2 closing self-check rejects the same reference in the mutation function definitions. |
| E16 | `#71` (SQLSTATE taxonomy actually raised) | `40001` OCC (team version stale); `42501` authority/identity (catalog operator, all-scope, leader eligibility, target cross-team, pre-existing authority, ambiguous identity, reserved-target **before** any state change but here as 23514, target not enabled, target missing link/recruiter/HRP/membership); `23514` reserved team, target team inactive (designate only), `direct_entry_team_leader_marker` (zero-length outside audited path), 7-allow SQLSTATE in mutation; `23505` idempotency unique; `23P01` overlap (E22b below); `P0002` team not found; `22023` invalid input (`expected_version`, date, reason length, idempotency length, `p_operation`, target↔operation mismatch); `55000` postcondition defect or self-check failure. |
| E17 | `#71` (legitimate 23P01 path in mutation) | The `direct_entry_guard_effective_interval` family may still raise `23P01` on the very narrow race that two mutations both pass the post-state read but commit in serial; the OCC `for update` on the team row plus the advisory locks are the prevention; a runner-up sees `40001` on version compare or `23P01` on the guard. |
| E18 | C01 + W01D handoffs | Sole leader read resolver is E6; no second authority resolver is allowed — the closing self-check rejects `direct_entry_assert_team_leader_authority(uuid,uuid,uuid)` and any other name matching `direct_entry_assert_team_leader%`. |
| E19 | Existing catalog contracts | `team-membership-contract.ts` already uses the canonical `{authorization_date, page, page_size, total, memberships[]}` envelope, the 8-key item shape, and the `state ∈ {CURRENT, SCHEDULED, HISTORY}` discriminator. `personnel-catalog-contract.ts` and `team-catalog-contract.ts` use the same fail-closed `exactKeys` parser. This is the projection pattern A2 must mirror. |
| E20 | Existing pipeline (`team-membership-api.ts`, `team-catalog-api.ts`, `personnel-catalog-api.ts`) | Canonical request pipeline: `DIRECT_ENTRY_API_ENABLED` gate → same-origin/CSRF on mutation → content-type + bounded JSON (`MAX_BODY_BYTES = 64 KiB` in `src/lib/direct-entry/write-api.ts`) → `validateClientBusinessPayload` recursive authority-field rejection (`CLIENT_AUTHORITY_FIELD_FORBIDDEN`) → strict request projection (exact keys, bounded types, `parseIsoDate` calendar-valid date) → resolve session server-side → repository → response sanitized + `Cache-Control: private, no-store`. Mutation responses additionally compare the `idempotency-key` header to the body key (`IDEMPOTENCY_KEY_MISMATCH`). |
| E21 | Existing repository (`team-membership-repository.ts`) | Repository pattern: dependency-inject a `Rpc` (default `serviceRoleRpc()`), wrap each call in `call<T>(rpcName, args, project)` that classifies errors via `classifyTeamMembershipError({code, message})` and returns a strict `Outcome<T>` of `{ok:true,data:T} | {ok:false, kind: 'conflict'|'denied'|'invalid'|'not-found'|'unavailable'}`. Malformed projection → `unavailable`. **No direct table read/write**; only the 6 RPCs in `#70`. |
| E22 | PM-candidate precedent | `direct_entry_list_project_manager_candidates` (W06A, `#54`) is a service-role RPC behind `direct_entry_assert_project_admin` (Full-Admin triple + all scope), returns active recruiters with one verified effective link, hard `limit 100`, search over `display_name` / `personnel_code` ILIKE without `%`/`_` escape, **no `auth_subject` / app-user UUID / email**. The P3.1 leader rule is materially different (team-scoped, additional HRP provider and team-membership predicates, only enabled app users, the leader-cannot-leader-two-teams rule) — see §3. |
| E23 | C01 + W01D security baseline | The reserved Vendor team must be indistinguishable from "unavailable" at the API surface; the only safe response to a direct request for the reserved team is the same `LEADER_NOT_FOUND` (404) the not-found path returns, never `LEADER_DENIED` or a reserved-specific code. |
| E24 | Personnel catalog contract | `personnelCatalogItem` carries `recruiter_id, display_name, personnel_code, personnel_position, active, version, hrp_valid_from, revision_count` — **no** `app_user_id`, **no** `auth_subject`, **no** link id. The personnel catalog therefore does **not** expose a leader candidate; it can only confirm a person is administrable. |
| E25 | Team membership contract | `teamMembershipItem` carries `membership_id, recruiter_id, team_id, team_display_name, valid_from, valid_to, recruiter_version, state` — enough to compute "this person is currently in team T" but it does not check the app user, the verified link, the HRP provider or the leader-in-another-team constraint. A2 cannot use it as the candidate source as-is. |

## 2. RPC matrix (locked truth at base `5fad15f`)

| RPC | Kind | Inputs | Authority | Returns / projects | Allowed SQLSTATEs the server is allowed to map to a sanitized code | Forbidden fields the server must never forward |
|---|---|---|---|---|---|---|
| `direct_entry_list_team_leaders_current` | read (list) | `(p_auth_subject, p_app_user_id, p_team_id=null, p_search<=256, p_page 1..1000, p_page_size 1..100)` | E6 read authority | `{authorization_date, page, page_size, total, leaders[]}` of E5 9-key projection (state = `CURRENT`) | `42501` (authority) → `LEADER_DENIED` 403; `22023` (bad page/size/search) → `LEADER_INVALID` 400; otherwise 200 with envelope | `auth_subject`, `app_user_id`, `email`, grant ids, raw scope/capability rows, reason text, audit internals |
| `direct_entry_list_team_leaders_scheduled` | read (list) | same | E6 | envelope, state = `SCHEDULED` | same | same |
| `direct_entry_list_team_leader_history` | read (list) | same | E6 | envelope, state = `HISTORY` (includes zero-length cancellation markers, which are never `CURRENT` or `SCHEDULED`) | same | same |
| `direct_entry_designate_team_leader` | write (RPC) | `(auth, app, team_id, leader_app_user_id, effective_date, expected_version>=1, reason btrim 1..4000, idempotency_key 1..128)` | `direct_entry_assert_catalog_operator` returns the exercised authority; never accepts client-supplied capability/scope/recruiter/team | `{team_id, assignment_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to=null, version, revision_id, change ∈ {'designate','replace'}}` | `40001` → `LEADER_CONFLICT` 409; `42501` (authority/identity/eligibility/cross-team/pre-existing capability) → `LEADER_DENIED` 403; `23514` (target team inactive, reserved team, marker guard) → `LEADER_INVALID` 400; `23505` (idempotency unique) → `LEADER_CONFLICT` 409; `23P01` (overlap) → `LEADER_CONFLICT` 409; `P0002` → `LEADER_NOT_FOUND` 404; `22023` (bad input or key reuse with different payload) → `LEADER_INVALID` 400; `55000` (postcondition) → `LEADER_UNAVAILABLE` 500; any other → `LEADER_UNAVAILABLE` 500 | the eight-key snapshot internals beyond the canonical mutation envelope; `auth_subject` (already known server-side); the prior leader’s email/auth_subject; raw exception text |
| `direct_entry_revoke_team_leader` | write (RPC) | `(auth, app, team_id, effective_date, expected_version>=1, reason, idempotency_key)`; no `leader_app_user_id` | same as designate | `{team_id, assignment_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to=p_effective_date, version, revision_id, change='revoke'}` | same map; revoked-team path is **not** a 4xx for `__system_vendor__` (returns 23514 → `LEADER_INVALID` 400) nor for an inactive business team (allowed; A1b2 handoff is explicit on this) | same |

`p_authority` for designate/revoke audit is the **literal returned by the catalog-operator guard** (`'entry_admin'` or `'catalog_master_manage'`). The leader path is **not** allowed to write a leader designation — the wrappers reject by virtue of the catalog-operator guard raising `42501` first; the closing self-check forces that order. The leader read authority is a separate resolver that admits both catalog operators and one-team leaders.

## 3. Candidate source finding (B)

**A canonical, team-scoped, leader-eligibility candidate RPC does not exist at base `5fad15f`.** This is the A2 blocker.

| Source | Has it now? | Why it is or is not enough |
|---|---|---|
| Personnel catalog `personnel_catalog_list` / `personnel_catalog_get` (`#68`) | Returns `personnel_position`, not `app_user_id` or any link id. | A2 must know whether the candidate has an enabled app user and one verified link; the personnel catalog is intentionally not allowed to expose that. E24. |
| Team membership `team_membership_list_current` (`#70`) | Returns `recruiter_id, team_id, team_display_name, valid_from, valid_to, state` for the membership in question. | A2 needs the **app user**, not the recruiter. It also needs the verified link, the HRP provider, the no-other-leader-team rule and the no-pre-existing-authority rule; the membership read covers only the last of these indirectly. E25. |
| Project manager candidates `direct_entry_list_project_manager_candidates` (`#54`, W06A-R2) | Returns `recruiter_id, display_name, personnel_code, personnel_position` for **active recruiters with one verified effective link**. | Wrong authority (project-admin = `entry_admin@all`, **not** `team_manager_assign@team`), wrong scope (no team filter, no team-membership predicate, no HRP-only rule, no enabled-app-user rule, no leader-in-another-team exclusion). The brief is explicit: it is reference only; the leader-candidate RPC may not reuse the project-admin guard. E22. |
| A purpose-built leader-candidate RPC | **Missing.** | See below. |

### Required minimum leader-candidate RPC (must be added inside migration `#71` before A2 is implemented — do not reserve `#72`)

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

Predicates (every row must satisfy **all** at the server’s authorization date):

1. The actor passes `direct_entry_assert_team_leader_read_authority(p_auth_subject, p_app_user_id, p_team_id)` — i.e. a catalog operator (full-Admin triple **or** `catalog_master_manage`) **or** the team’s own leader with `team_manager_assign` + effective `team` scope. A leader who supplies a different `p_team_id` fails closed (`42501` → `LEADER_DENIED`).
2. The candidate’s app user is `enabled = true`.
3. The candidate has **exactly one** effective verified app-user/recruiter link (zero, two, expired, future, future-closing or unverified → exclude).
4. The linked recruiter is `active = true`.
5. The linked recruiter has **exactly one** effective HRP provider membership (`provider_type = 'hrp' AND vendor_id IS NULL`); any `vendor` provider → exclude.
6. The linked recruiter has **exactly one** effective membership in **this** team (`recruiter_team_memberships` half-open on the authorization date). A membership in another team is a hard exclude.
7. The candidate is **not** the current effective leader of **any** team (`direct_entry_team_leader_assignments` half-open) — this is the locked `one team per leader` cardinality.
8. The candidate holds **no** pre-existing effective `team` scope or `team_manager_assign` interval (so the designate transaction can open both without overlap).

Projection (bounded; **no** `auth_subject`, no email, no display name that is not the canonical app-user `display_name`, no grant rows, no reason, no raw DB text):

```text
{
  app_user_id,         -- opaque identifier for the designate target
  recruiter_id,        -- opaque identifier (single verified link)
  display_name,        -- app-user display_name; the only label the UI renders
  personnel_code       -- nullable, from recruiters
}
```

Plus the envelope the read-RPCs already use:

```text
{ authorization_date, page, page_size, total, candidates[] }
```

Search bound 256, page 1..1000, page_size 1..100; `candidates` ordered by `display_name, app_user_id`. The RPC is **not** allowed to call `direct_entry_system_vendor_team_id()`; the reserved-team guard is `t.code <> '__system_vendor__'` and the closing migration self-check must add this RPC to its loop, reject reserved-creator references, reject `personnel_position` reads, and verify search_path + definer + service-role-only ACL.

**Why this must be appended inside `#71` and not in `#72`:** A2 (the application surface) reads the same candidate set both for Admin/Accounting designate and for the team leader’s self-team replace. Without a bounded, team-scoped, server-authority candidate RPC, A2 would have to either (a) over-grant by reusing the W06A project-admin RPC (forbidden by C01: Accounting/Project-Admin and Team Leader use disjoint authority paths), or (b) under-fetch by stitching together personnel + membership + link reads in TypeScript, which leaks PII (`recruiter_id`, link counts, eligibility predicates) and reintroduces the N+1 the contract forbids. A2 cannot ship the locked Admin/Accounting and the locked team-leader self-team replace paths without this RPC. R0 (A2-S0) is therefore **a blocker** until the candidate RPC is appended to `#71` and the closing self-check confirms the same ACL/definer/search_path posture as the read and write RPCs already locked.

**The leader-candidate RPC is the only contract delta A2 depends on from #71.** Everything else in §4 uses surface that already exists at `5fad15f`.

## 4. Locked recommended API contract (C)

> One hierarchy, no parallel routes. All read routes are GET; designate-or-replace and revoke are POST. Team id and leader app-user id (where applicable) are **always** taken from the URL path, never from body/header. All mutation bodies are exactly the four business keys the locked C01 + W01D contracts allow.

### 4.1 Common contract (every route)

- Feature gate: `process.env.DIRECT_ENTRY_API_ENABLED === "true"`, otherwise the route returns `404 NOT_FOUND` with `Cache-Control: private, no-store`. The leader read routes share the same gate as the existing catalog admin routes.
- Cache: every response carries `Cache-Control: private, no-store`. The existing P3.1 admin routes also add `Pragma: no-cache`, `Expires: 0`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` via the shared helper; A2 reuses that helper, never a per-route ad-hoc header.
- Runtime: `export const runtime = "nodejs"; export const dynamic = "force-dynamic";`.
- Server session: the only actor source is `getDirectEntryActor(createDirectEntryActorRepository())`; `auth_subject` and `app_user_id` are read once from the session and passed to the repository — never taken from body, header, query or path.
- Recursive client-authority rejection: the body of every mutation is run through `validateClientBusinessPayload` before any other parser. `actor`, `role`, `capability`, `scope`, `auth_subject`, `app_user_id`, `team_id` (where it must come from the path) and any other authority field reject the request with `CLIENT_AUTHORITY_FIELD_FORBIDDEN` 400. This is the same recursive walk the existing W01B/C-B/C-A APIs use.
- Bounded JSON: `readBoundedJson(request)` with `MAX_BODY_BYTES = 64 KiB` (`src/lib/direct-entry/write-api.ts`). On overflow, content-type mismatch or malformed JSON: `BODY_INVALID` 400. This is the existing W01B/C-B/C-A bound.
- Idempotency: mutation bodies carry `idempotency_key` (UUID, 1..128). If the request has an `idempotency-key` header, it must equal the body key exactly; otherwise `IDEMPOTENCY_KEY_MISMATCH` 400. Same key + same payload hash → identical stored result; same key + different payload → `LEADER_INVALID` 400 (server-side classification of `22023` "idempotency key reused with different input" as conflict in the catalogue of allowed errors, **before** the lock is taken).
- Reserved team: the reserved `__system_vendor__` team is filtered at every read query and rejected at every mutation with the same `LEADER_NOT_FOUND` 404 the not-found path returns; the server never returns a reserved-team-specific code. (Mutation returns 23514; the API surfaces it as `LEADER_INVALID` 400 because the body is the trigger, the read API surfaces it as `LEADER_NOT_FOUND` 404 because the row was filtered out and the actor never asked for a row it could have seen.)
- Sanitized errors: the route handler never forwards raw `error.message`. Repository → `{ok:false, kind}`; API → `LEADER_<KIND>` per §5.
- No client actor authority: actor is **only** the session; the team id is **only** the URL path; the leader app-user id (designate) is **only** the URL path; the effective date, expected version, reason and idempotency key are **only** the body.

### 4.2 Read routes

#### `GET /api/admin/catalog/team-leaders?state=current|scheduled|history`

| Aspect | Value |
|---|---|
| Query keys (exact, order-free) | `state` (mandatory, `current` / `scheduled` / `history`), `team_id` (optional UUID), `search` (optional, ≤ 256), `page` (default 1, 1..1000), `page_size` (default 25, 1..100) |
| Body | none |
| Session order | gate → query parser → session → repository |
| Success | `200` with `{ ok: true, list: { authorization_date, page, page_size, total, leaders[] } }`, leaders are 9-key `state ∈ {CURRENT, SCHEDULED, HISTORY}` |
| Error → status | `LEADER_DENIED` 403, `LEADER_INVALID` 400, `LEADER_NOT_FOUND` 404, `LEADER_UNAVAILABLE` 500, `NOT_FOUND` 404 if gate closed, `UNAUTHENTICATED` 401, `ACTOR_NOT_AVAILABLE` 403 |
| Idempotency | n/a (read) |
| Recursive authority | query parser is the only authority-source check; the read routes do not call `validateClientBusinessPayload` because there is no body, but a separate defensive scan of `Object.keys` on the parsed query rejects any client attempt to send `auth_subject`, `app_user_id`, `capability`, `scope`, `role` as query keys (`LEADER_INVALID` 400). |

#### `GET /api/admin/catalog/team-leader-candidates?team_id=<uuid>&search=&page=&page_size=`

| Aspect | Value |
|---|---|
| Query keys (exact) | `team_id` (mandatory UUID; not allowed in the body), `search` (optional ≤ 256), `page` (default 1, 1..1000), `page_size` (default 25, 1..100) |
| Body | none |
| Session order | gate → query parser → session → RPC |
| Success | `200` with `{ ok: true, list: { authorization_date, page, page_size, total, candidates[] } }`, candidates are 4-key `{app_user_id, recruiter_id, display_name, personnel_code}` — **no** `auth_subject`, **no** email, **no** grant rows |
| Error → status | same map as the read route. `team_id` missing/malformed → `LEADER_INVALID` 400. Team not found / reserved / inactive → `LEADER_NOT_FOUND` 404. Cross-team leader call → `LEADER_DENIED` 403. |
| Notes | This route is the *single* candidate source for both Admin/Accounting designate and team-leader self-team replace. There is no parallel `GET /api/admin/team-leader/.../candidates` route — that would split the authority story. |

### 4.3 Mutation routes

#### `POST /api/admin/catalog/teams/:teamId/leaders` (designate or replace)

| Aspect | Value |
|---|---|
| Path | `:teamId` is a UUID, validated before the body is read; reserved team id → `LEADER_INVALID` 400 (the mutation server-side would also reject with 23514, the API surfaces the same 400 the W01C-B team API uses for reserved-code bodies). |
| Body keys (exact) | `leader_app_user_id` (UUID), `effective_date` (ISO `YYYY-MM-DD` regex, then `parseIsoDate` calendar-valid), `expected_version` (int >= 1), `reason` (btrim 1..4000), `idempotency_key` (UUID, 1..128) |
| Headers | `content-type: application/json`; `idempotency-key` must match the body key; `origin`/`sec-fetch-site`/`host` pass the existing same-origin guard |
| Session order | gate → same-origin → content-type + bounded JSON → recursive authority rejection → strict body projection → idempotency-key match → session → repository |
| Repository | `createTeamLeaderRepository()` (new, mirrors the W01C-B repository). `repository.designateLeader({auth_subject, app_user_id, team_id, leader_app_user_id, effective_date, expected_version, reason, idempotency_key})` |
| Success | `200` with `{ ok: true, leader: { team_id, assignment_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to: null, version, revision_id, change: 'designate' | 'replace' } }` |
| Error → status | per §5 taxonomy |

#### `POST /api/admin/catalog/teams/:teamId/leaders/revoke`

| Aspect | Value |
|---|---|
| Path | `:teamId` UUID. Reserved team id → `LEADER_INVALID` 400. (Server-side the mutation also rejects with 23514; the API contract is the same.) |
| Body keys (exact) | `effective_date`, `expected_version`, `reason`, `idempotency_key` (no `leader_app_user_id`; the target is the current effective leader at `effective_date`, which the server resolves inside the locked transaction) |
| Headers / order | identical to designate |
| Repository | `repository.revokeLeader({auth_subject, app_user_id, team_id, effective_date, expected_version, reason, idempotency_key})` |
| Success | `200` with `{ ok: true, leader: { …, valid_to: effective_date, change: 'revoke' } }` |
| Error → status | per §5 taxonomy; note the API does **not** surface a special "team is inactive" code — it is `LEADER_INVALID` 400 only when the body is the trigger; if the team does not exist, `LEADER_NOT_FOUND` 404. |

### 4.4 Why one hierarchy

- The brief explicitly forbids parallel routes. A separate `/api/admin/team-leader/leaders` tree would re-implement the gate, the same-origin/CSRF check, the bounded JSON check, the recursive authority rejection, the strict projection, the session resolve and the no-store header — and it would create a second route map a future leader-UI consumer has to gate on. The team catalog at `/api/admin/catalog/teams` already owns `expected_version` on the team; a sibling `/api/admin/catalog/team-leaders/*` is the only consistent place for leader reads/mutations, and `/api/admin/catalog/teams/:teamId/leaders` is the only consistent place to express "this leader acts on this team". A `:leaderAppUserId` is **never** in the path for designate (the body owns it, exactly as the W01C-B membership body owns `valid_from` while the path owns the team), and it is **not** allowed in the revoke path at all.
- The candidate route is a sibling of the leader read route, not a child of the team route, so a leader can fetch candidates for *their own* team without restating the team id in the path twice.

## 5. Authority and error matrix (D)

| Actor / state | Read current/scheduled/history | Read candidates | Designate / replace | Revoke | Direct forged cross-team call |
|---|---|---|---|---|---|
| Full Admin (`entry_admin@all` or `catalog_master_manage@all`) | allow (any team) | allow (any active non-reserved team) | allow | allow | allow |
| Accounting catalog operator (`catalog_master_manage@all`) | allow | allow | allow | allow | allow |
| Team leader (`team_manager_assign@team` + verified link + active HRP provider + effective own-team membership + exactly one effective own-team leader assignment) | allow own team only (other team ids filtered to zero rows) | allow own team only (other team ids → `LEADER_DENIED` 403) | **deny** `LEADER_DENIED` 403 (catalog operator guard denies; the closing migration self-check forces the wrapper to call that guard first) | **deny** `LEADER_DENIED` 403 (same reason) | **deny** 42501 / `LEADER_DENIED` 403 — the cross-team assertion in the read authority fails closed |
| Project manager (assignment-derived) | deny | deny | deny | deny | deny |
| Ordinary staff | deny | deny | deny | deny | deny |
| Disabled actor with live grants | deny (`enabled` predicate in the session) | deny | deny | deny | deny |
| Unmapped or mismatched `auth_subject`/`app_user_id` | deny `LEADER_DENIED` 403 | deny | deny | deny | deny |
| Ambiguous actor (multiple verified links, multiple effective memberships, multiple team scopes) | deny `LEADER_DENIED` 403 | deny | deny | deny | deny |
| Inactive business team | reads filtered to zero rows (state `HISTORY` may still include it) | candidates: `LEADER_NOT_FOUND` 404 (team inactive → 23514 from `#71`'s read RPC path is the inner error; A2 must map that to NOT_FOUND, not DENIED, to avoid leaking team state) | deny `LEADER_INVALID` 400 (server raises 23514) | allow (the locked contract permits revoke on an inactive business team — E14/A1b2 handoff) | deny |
| Reserved `__system_vendor__` team | always filtered out (zero rows in every state) | `LEADER_NOT_FOUND` 404 | `LEADER_INVALID` 400 (server raises 23514) | `LEADER_INVALID` 400 (server raises 23514) | deny, indistinguishable from "not found" |
| Future-dated designation or revoke | allow (RPC supports `effective_date > today`; authority and eligibility evaluated **at** `effective_date`) | n/a | allow | allow | n/a |
| Stale `expected_version` | n/a | n/a | `LEADER_CONFLICT` 409 (40001) | `LEADER_CONFLICT` 409 (40001) | n/a |
| Same `idempotency_key` + same payload | n/a | n/a | identical stored result (200, same body) | identical stored result (200, same body) | n/a |
| Same `idempotency_key` + different payload | n/a | n/a | `LEADER_INVALID` 400 (server raises 22023 "idempotency key reused with different input") | `LEADER_INVALID` 400 | n/a |
| No body / wrong content-type / oversize / malformed JSON | n/a | n/a | `CONTENT_TYPE_INVALID` 400 or `BODY_INVALID` 400 | same | n/a |
| Recursive client authority field | `LEADER_INVALID` 400 (`validateClientBusinessPayload`) | n/a (no body) | `CLIENT_AUTHORITY_FIELD_FORBIDDEN` 400 | `CLIENT_AUTHORITY_FIELD_FORBIDDEN` 400 | n/a |
| Origin / CSRF | n/a (GET) | n/a (GET) | `CSRF_REJECTED` 403 | `CSRF_REJECTED` 403 | n/a |
| RPC raises an SQLSTATE not in the catalogue | `LEADER_UNAVAILABLE` 500 (and `console.error`) | `LEADER_UNAVAILABLE` 500 | `LEADER_UNAVAILABLE` 500 | `LEADER_UNAVAILABLE` 500 | `LEADER_UNAVAILABLE` 500 |
| Postcondition 55000 (locked transaction defect) | n/a | n/a | `LEADER_UNAVAILABLE` 500 (zero residue) | `LEADER_UNAVAILABLE` 500 (zero residue) | n/a |
| Read `current/scheduled/history` overlap (a zero-length marker) | marker appears **only** in `history`; never in `current` or `scheduled` | n/a | n/a | n/a | n/a |
| Audit labels | n/a | n/a | `action='team_leader_designate' | 'team_leader_replace'`, `capability=p_authority` (`entry_admin` or `catalog_master_manage`), `scope_kind='all'`, `resource_ref=p_team_id::text` | `action='team_leader_revoke'`, `capability=p_authority`, `scope_kind='all'`, `resource_ref=p_team_id::text` | n/a |

The leader path **never** writes `capability='entry_admin'` or `capability='team_manager_assign'` on a leader-designate audit row (C01: those are the existing Project-Admin and the team-leader authority tokens respectively; neither is the right label for a leader read or a leader mutation by Admin/Accounting). The leader **read** path does not write audit rows.

## 6. File/symbol implementation map (read-only; A2 must not start until §7 sequencing allows)

| Layer | File (mirror, not edit) | Symbol | Status at `5fad15f` |
|---|---|---|---|
| Contract (read items) | `src/lib/direct-entry/team-leader-contract.ts` (new, mirrors `team-membership-contract.ts`) | `teamLeaderItem(value)` 9-key, `teamLeaderList(value)` envelope, `teamLeaderMutation(value)` 9-key, `teamLeaderCandidate(value)` 4-key, `teamLeaderCandidateList(value)` envelope | **Missing.** A2 must add (no edit to existing files; the new contract is its own module). |
| Contract (read items) — projection keys | same | 9 keys (E5) and 4 keys (§3) | the canonical shape is the E5 projection; A2 must not add `auth_subject`/`app_user_id` (the latter is OK for designate target only) or email to the candidate projection. |
| API | `src/lib/direct-entry/team-leader-api.ts` (new) | `listTeamLeader`, `listTeamLeaderCandidates`, `designateTeamLeader`, `revokeTeamLeader` | **Missing.** Mirrors `team-membership-api.ts` (gate → same-origin → bounded JSON → authority rejection → strict projection → session → repository). |
| Repository | `src/lib/direct-entry/team-leader-repository.ts` (new) | `createTeamLeaderRepository(rpc?)` with `listLeaders`, `listCandidates`, `designateLeader`, `revokeLeader`; `classifyTeamLeaderError({code, message})` per §5 map | **Missing.** Calls the six RPCs in §2 (or seven, once the candidate RPC is appended to `#71`); never reads/writes tables directly. |
| Route handlers | `src/app/api/admin/catalog/team-leaders/route.ts` (new, GET state) | feature-gated `GET` | **Missing.** |
| Route handlers | `src/app/api/admin/catalog/team-leader-candidates/route.ts` (new, GET) | feature-gated `GET` | **Missing.** |
| Route handlers | `src/app/api/admin/catalog/teams/[teamId]/leaders/route.ts` (new, POST designate/replace) | feature-gated `POST` | **Missing.** |
| Route handlers | `src/app/api/admin/catalog/teams/[teamId]/leaders/revoke/route.ts` (new, POST revoke) | feature-gated `POST` | **Missing.** |
| Route handlers (admin/team-leader) | (no second tree) | n/a | A2 must **not** create `/api/admin/team-leader/...`; the brief explicitly forbids parallel routes. |
| DB (RPC) | `supabase/migrations/20261009070000_p3_1_w01d_team_leader_lifecycle.sql` (already shipped) | `direct_entry_list_team_leaders_current/scheduled/history`, `direct_entry_designate_team_leader`, `direct_entry_revoke_team_leader`, `direct_entry_apply_team_leader_mutation`, `direct_entry_assert_team_leader_read_authority`, `direct_entry_team_leader_snapshot`, `direct_entry_team_leader_projection` | Already in `#71` at `5fad15f`. |
| DB (RPC) | same migration, **must be appended before A2** | `direct_entry_list_team_leader_candidates(auth, app, team_id, search, page, page_size)` per §3 | **Missing — A2 blocker.** |
| Test lane (no browser) | `scripts/p3-1-w01d-a2-leader-server.test.mjs` (new) | per §7 | **Missing.** |
| Feature gate | `process.env.DIRECT_ENTRY_API_ENABLED` | shared with W01B/C-A/C-B | reused as-is |
| Session | `getDirectEntryActor(createDirectEntryActorRepository())` | already used by W01B/C-A/C-B | reused as-is |
| Same-origin | `checkSameOriginRequest` (`src/lib/ai/gateway/http-guards.mjs`) | reused | reused as-is |
| Authority guard | `validateClientBusinessPayload` (`src/lib/auth/direct-entry-v2.ts`) | reused | reused as-is |
| Bounded JSON | `readBoundedJson` (`src/lib/direct-entry/write-api.ts`, `MAX_BODY_BYTES = 64 KiB`) | reused | reused as-is |
| Date parser | `parseIsoDate` (`src/lib/direct-entry/direct-entry-date-format.ts`) | reused | reused as-is |
| `NO_STORE_HEADERS` | shared helper in the auth/w04-gateway stack | reused | reused as-is |

## 7. Regression / mutation plan (E, no browser)

A2 must add a new PGlite-only lane (no Supabase local, no real DB, no Next.js route execution, no HTTP). It reuses the 71-migration load already proven by A1a2, A1b1, A1b2, R1, R2. The lane must exercise the API handlers by **directly importing the new `team-leader-api.ts` module** with an injected `rpc` (mirroring the W01B / W01C repository test surface), so the route handler files are exercised through the same pipeline without a Next.js runtime.

### 7.1 Required regression cases (machine-verifiable, no browser)

1. **Projection exact-key (read)** — every successful read response parses through `teamLeaderItem` and `teamLeaderList`; an extra key (`email`, `auth_subject`, `app_user_id`, `grant_id`, `scope`, `capability`, `reason`, `audit`) is rejected as a malformed projection (`unavailable`); a missing key is rejected the same way. Same for `teamLeaderCandidate` and `teamLeaderCandidateList`.
2. **Projection exact-key (write)** — the designate/revoke response parses through `teamLeaderMutation`; an extra key or a wrong type (`valid_to` is `null` for designate, the same date for revoke) is rejected; a `change` other than `'designate' | 'replace' | 'revoke'` is rejected.
3. **Query / body parser** — every required key missing/extra/`null`/wrong type on the read query or mutation body is rejected with `LEADER_INVALID` 400 before the session is touched. UUID regex enforces v1..v8; `parseIsoDate` rejects 2026-02-30, 2026-13-01, 2026-00-10.
4. **Invalid real calendar date** — even with the regex, `2026-02-30` is rejected with `LEADER_INVALID` 400.
5. **UUID / path validation** — `teamId` not a UUID, `teamId` is the reserved team id, `leader_app_user_id` not a UUID → `LEADER_INVALID` 400.
6. **Gate ordering** — when `DIRECT_ENTRY_API_ENABLED !== "true"`, every route returns `NOT_FOUND` 404 with `Cache-Control: private, no-store` and the session is **never** resolved.
7. **Same-origin (mutation)** — a request with `sec-fetch-site: cross-site` or no `origin`/host match is rejected with `CSRF_REJECTED` 403 before the body is read.
8. **Recursive client authority** — a mutation body containing `actor`, `role`, `capability`, `scope`, `auth_subject`, `app_user_id`, `team_id` (when the path is the team) — at any depth, including arrays — is rejected with `CLIENT_AUTHORITY_FIELD_FORBIDDEN` 400; the read query parser rejects the same keys at the top level.
9. **Session failure** — `UNAUTHENTICATED` 401 when the session returns no actor; `ACTOR_NOT_AVAILABLE` 403 when the actor mapping is corrupt; the body is **not** read until this check succeeds for the catalogue of operations that need an actor.
10. **Repository SQLSTATE taxonomy** — the matrix in §5 is exercised case-by-case through the injected `rpc`; the lane asserts that a code not in the catalogue returns `LEADER_UNAVAILABLE` 500 and a 55000 postcondition failure also returns `LEADER_UNAVAILABLE` 500 with zero residue (asserted by counting rows in the leader, scope, capability, revision, audit, reason, idempotency tables before and after).
11. **Current / scheduled / history separation** — disjoint projections: a row whose `valid_from` is in the future is never in `current`; a row whose `valid_to <= today` is never in `current`; a cancellation marker is in `history` and never in `current` or `scheduled`. Paging bound 1..1000; `page_size` 1..100; `search` bound 256.
12. **OCC conflict** — second mutation with stale `expected_version` returns `LEADER_CONFLICT` 409 (40001) and writes **no** row in any of the seven tables.
13. **Idempotency replay** — same key + same payload returns the same response body; same key + different payload returns `LEADER_INVALID` 400 (22023) before any lock; `idempotency-key` header mismatch returns `IDEMPOTENCY_KEY_MISMATCH` 400.
14. **Reserved team** — designate, replace, revoke, and the read/candidate routes never expose or accept the `__system_vendor__` team id; the response code is `LEADER_INVALID` 400 (mutation) or `LEADER_NOT_FOUND` 404 (read) — never a reserved-team-specific code.
15. **Malformed DB projection** — a synthetic `data` that fails the strict parser is surfaced as `LEADER_UNAVAILABLE` 500 (no success path, no echo of the DB payload).
16. **Candidate exclusions (after the §3 RPC lands in `#71`)** — a candidate with a disabled app user, two verified links, no HRP provider, an expired link, a future link, a vendor provider, a membership in another team, an open leader assignment in another team, or a pre-existing `team` scope or `team_manager_assign` is **not** in the list. The list is bounded to 100 rows and uses the 4-key projection. A leader who supplies a `team_id` other than their own returns `LEADER_DENIED` 403.
17. **No N+1 / no direct table read** — the repository test injects an `rpc` stub; if the repository ever calls `serviceRoleRpc` more than the documented per-route count (read: 1, designate: 1, revoke: 1, candidate: 1), the test fails. The lane asserts the only SQL verb in the RPC stub is `rpc(name, args)` — no `.from(...)`, no raw `select`, no `serviceRoleRpc`-bypassing query.
18. **Self-designation audit (catalog operator only)** — a self-designation by an Admin/Accounting actor is allowed only if the actor is an enabled app user with exactly one verified link and an effective membership in that same team (E10); the audit row records the actor’s own `app_user_id` and the locked `capability` from the catalog-operator guard; the leader path is **not** authorized.
19. **Replacement rollback** — replay the A1b2 R1 fault-injection matrix at the API layer: inject failures at the capability update, revision insert, audit insert, and idempotency finish steps; each case returns `LEADER_UNAVAILABLE` 500 with zero residue; the outgoing leader’s authority survives; the next retry succeeds with the **same** `idempotency_key` (returning the stored result) and once with a **new** `idempotency_key`.
20. **Concurrent same-team designations** — two concurrent designates for the same team at the same effective date; the second one (after the first commits) returns `LEADER_CONFLICT` 409 (40001) on the OCC compare; the row lock ordering is documented in the RPC and the API test asserts the second response body never contains the first response’s `revision_id` or `version`.
21. **Outgoing authority is never effective after replacement** — after a successful replacement, the outgoing leader’s next read returns zero rows for the target team, the outgoing app user’s next leader read RPC call (if the user is mapped and re-asserted) raises `42501`, and the outgoing capability is gone from `current`; the post-state is asserted by direct table counts (this is the locked A1b2 postcondition; A2 must not loosen it).
22. **Bypass / mutation sensitivity (no source edit; the locked-in SQL at `5fad15f` is the oracle)** — a synthetic helper that wraps the injected `rpc` to skip the catalog-operator call is rejected by the API (a leader cannot self-designate even if the RPC mock lets it through; the API enforces this only by **not** having a leader authorize the mutation, and the lane must assert that the only callers of `direct_entry_designate_team_leader` are the two wrappers, and that both wrappers call `direct_entry_assert_catalog_operator` first). For the candidate RPC, the same pattern: a candidate RPC that ignores the `team_id` filter is rejected by an additional test that asserts the filter is present in the source of the RPC at `5fad15f` (byte-stability of `#71` is the gate).
23. **No browser tests** — the lane has zero `@playwright/test`, `@vitest/browser`, jsdom or happy-dom import. The lane script tag/dependency list is asserted in a grep guard.

### 7.2 Mutation matrix (no source edit; the closed-in SQL is the source of truth)

Every mutation below must be demonstrated by stubbing the injected `rpc` (not by editing `#71`). The lane must turn **red** when the stub returns a value the locked contract would not allow (e.g. a `42501` for a target app user the contract says is eligible, or a `200` for a request the contract says is `LEADER_INVALID`).

| # | What the stub returns | What the lane must observe |
|---|---|---|
| M1 | stub returns a 9-key leader item with an extra `email` key | `LEADER_UNAVAILABLE` 500 (projection failure) |
| M2 | stub returns a 9-key leader item missing `state` | `LEADER_UNAVAILABLE` 500 |
| M3 | stub returns a 4-key candidate item with `auth_subject` | `LEADER_UNAVAILABLE` 500 |
| M4 | stub returns 55000 on the postcondition step (designate) | `LEADER_UNAVAILABLE` 500, zero residue in all 7 tables |
| M5 | stub returns 40001 on the OCC compare (revoke) | `LEADER_CONFLICT` 409, zero residue |
| M6 | stub returns 23514 with `reserved team cannot have a leader` (designate) | `LEADER_INVALID` 400 (and a separate test asserts the API never returns a reserved-team-specific code) |
| M7 | stub returns 42501 with `target leader has pre-existing leader authority intervals` (designate) | `LEADER_DENIED` 403 |
| M8 | stub returns 22023 with `idempotency key reused with different input` (designate) | `LEADER_INVALID` 400 (per the catalogue — the *only* 22023 that maps to invalid) |
| M9 | stub returns 22023 with `expected team version required` | `LEADER_INVALID` 400 |
| M10 | stub returns 23P01 on overlap | `LEADER_CONFLICT` 409 (the A1b2 mutation-proof matrix already covers this; A2 keeps it) |
| M11 | stub returns P0002 | `LEADER_NOT_FOUND` 404 |
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
| M23 | `direct_entry_list_team_leader_candidates` returns a row with the target’s `auth_subject` in any field | `LEADER_UNAVAILABLE` 500 (projection must filter it out) |
| M24 | revoke body has `leader_app_user_id` | `LEADER_INVALID` 400 (revoke does not accept a target) |
| M25 | direct cross-team candidate call (leader supplies a different team id) | `LEADER_DENIED` 403, candidate list is empty |

## 8. Blockers and sequencing (F)

| Phase | Code-able from `5fad15f`? | Blocker | Action |
|---|---|---|---|
| §1, §2, §4.1, §5, §6, §7 (read + designate/revoke handlers, repository, contract, projection parsers, error taxonomy, regression cases that use only the already-shipped 6 RPCs) | **Yes** — `5fad15f` is byte-stable, ledger is 71, and the six RPCs (read authority, three reads, apply helper, two wrappers) are present, ACL-locked, and self-checked. | none | A2 may build the application surface for read + designate + revoke from `5fad15f`. |
| Candidate route (read `team-leader-candidates`) | **No** — the candidate RPC is **not** in `5fad15f` | missing `direct_entry_list_team_leader_candidates` in `#71`; A2 cannot ship the candidate route without it | append the candidate RPC inside `#71` (do **not** reserve `#72`), update the closing self-check loop to include it (definer, search_path, ACL, reserved-team-creator rejection, `personnel_position` rejection, source filter `t.code <> '__system_vendor__'`, page/page_size/search bounds), re-run A1a2, A1b1, A1b2, R1, R2 focused lanes; then A2 can import it. |
| Migration slot | n/a | the brief is explicit: **do not reserve `#72`**. The candidate RPC must be appended inside `#71`. | the A1b2-R2 closing self-check already enforces the contract drift; A1b2 (or a new A1b3 if the work needs its own lane) is the place to append, not a new migration. |
| A2 integration | blocked on the candidate RPC landing in `#71` and T0 acceptance of `#71` as final | n/a | A2 may not merge before T0 accepts `#71` final. The branch is `feature/p3-1-w01d-team-leader-lifecycle`; A2 lives on it. |
| T0 acceptance | n/a | the handoff says "T0 closes" the wave | A2 ships the server surface, A1a2/A1b1/A1b2/R1/R2 already ship the DB surface; only T0 declares the wave pass. |
| Production | n/a | none in this survey | explicitly out of scope: no Production query/apply/deploy, no browser/Playwright/CUA/UAT, no W02/W03/W04, no Personnel/Team/Vendor mutation surface, no team-scoped project-manager assignment. |
| Sequencing rule | A2 reads go first (read RPCs + projection parsers), then designate/revoke repository + API + tests, then candidate route after the candidate RPC is appended, then final A2 lane covers all four routes. | | |

## 9. Boundary

Read-only survey. No source, migration, `package.json`, dependency, `docs/P3.1.md` or other code change. No Production query/apply/deploy, no browser/Playwright/CUA/UAT. Worktree is clean; the only tracked change for this survey is the single documentation file at `docs/handoffs/p3-1-w01d-a2-s0-server-api-contract-survey.md`. The candidate RPC must be appended to `#71` by the **A1b** lane (or a new A1b3 lane) — never in a new migration, never in a parallel branch. A2 is blocked on that RPC and on T0 acceptance of `#71` final.
