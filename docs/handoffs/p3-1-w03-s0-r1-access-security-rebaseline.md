# P3.1-W03-S0-R1 — Account, Grant, Scope, Link, Audit, Restore access/security rebaseline

> Status: `P3_1_W03_S0_R1_ACCESS_SECURITY_REBASELINE_PASS_AWAITING_T0`
> Base: `origin/main@1189c8a77decbecec0b402b72f428cb0525b460d`. Ledger 71 migrations; #71 = `20261009070000_p3_1_w01d_team_leader_lifecycle.sql` is last; #72 does not exist. Worktree `C:\CodeApp\BI-p3-1-w03-s0-r1-access-security-rebaseline`; branch `audit/p3-1-w03-s0-r1-access-security-rebaseline`.
> Lane: T1C read-only survey / security review. No source, migration, `package.json`, dependency, `docs/P3.1.md` or other code change. No Production query/apply/deploy, no browser/Playwright/CUA/UAT. Exactly one documentation file changed: this memo.

This R1 rebaseline replaces the assumptions made in the prior W03 survey (`4692f1f`, base `f9d77c6`, 70 migrations) with the post-#71 reality on `main` (`1189c8a`, 71 migrations). It carries forward every authority decision that the C01 catalog policy survey, J00 security regression baseline, W01A capability contract foundation, W01B personnel catalog, W01C-A team catalog, W01C-B team membership, W01C/W01D membership/leader security baseline, W01D team leader lifecycle, J01 readiness audit, and W08A session-revocation cache have already locked.

The four mandatory post-#71 corrections below are not new policy — they are restatements of the W01D migration contract. Every W03 plan must respect them, every W03 implementation must reuse the W01D primitives, and the W03 test matrix must prove them.

## A. Current truth and evidence (post-#71, source-anchored)

### A.1 Migration ledger and the four #71 primitives that bind W03

The 71st and last migration is `supabase/migrations/20261009070000_p3_1_w01d_team_leader_lifecycle.sql` (2366 lines, last verified at `1189c8a`). It defines four primitives that every W03 access/security decision must respect, and explicitly closes itself with a self-check (`#7`) that fails the migration if any of them drifts:

| # | #71 primitive | Location in `#71` | What W03 inherits |
|---|---|---|---|
| P1 | `direct_entry_capability_grants_check` widened to `valid_to >= valid_from`; the same widening on `direct_entry_scope_grants_check`. The `recruiter_team_memberships_check` keeps `valid_to > valid_from` (strict). The 23-token capability CHECK is unchanged. | #71 §1, lines 31–66; self-check #71 §7 lines 268–285. | Capability and scope intervals are half-open `[valid_from, valid_to)` with a *legal* zero-length cancellation marker; membership intervals remain strict. **A zero-length grant row is not a live authority — markers are inert on every date, kept, and never re-dated** (per the constraint comment at #71:35–36 and #71:46–47). |
| P2 | Partial marker-excluding uniqueness replaces the old marker-blocking unique key. | #71 §2, lines 69–87; self-check #71 §7 lines 287–313. | `direct_entry_capability_grants_open_start_uidx` and `direct_entry_scope_grants_start_uidx` are recreated as partial indexes with `WHERE valid_to is null or valid_to > valid_from`. They guarantee at most one *live* capability/scope interval per `(app_user_id, capability|scope_kind, …, valid_from)`; **markers never enter the live path**. |
| P3 | `direct_entry_team_leader_marker()` trigger function, installed on **all three** interval tables: `direct_entry_team_leader_assignments`, `direct_entry_scope_grants`, `direct_entry_capability_grants`. | #71 §4, lines 126–155; self-check #71 §7 lines 315–329. | The trigger rejects a `valid_to = valid_from` write with `23514 'team-leader cancellation marker requires the audited mutation path'` **unless** the transaction has set `current_setting('direct_entry.team_leader_marker', true) = 'on'`. That setting is turned on at #71:1384 by `set_config('direct_entry.team_leader_marker', 'on', true)` (the third argument is `true` = transaction-local), inside the leader mutation RPCs only. **No raw marker DML is possible from any other path** — including the W03 generic grant/scope/link RPCs. |
| P4 | `direct_entry_team_leader_assignments` table (PK `assignment_id`, NOT NULL `leader_app_user_id`, NOT NULL `leader_recruiter_id`, half-open `[valid_from, valid_to)`), with a team-open unique partial index `direct_entry_team_leader_assignments_team_open_uidx` and a leader-open unique partial index `direct_entry_team_leader_assignments_leader_open_uidx`. | #71 §3, lines 89–124. | The leader assignment is its own **first-class persisted row**, separate from the leader bundle. The W01D atomic designate/replace/revoke RPCs are the only writers. Markers on this table are inert and excluded from both partial indexes. |

**R1 correction 1 (mandatory after #71) — capability/scope interval semantics.** The CHECK now permits `valid_to = valid_from`; the raw write of a zero-length interval is still rejected with `23514` by the marker trigger; the marker can only be created by a transaction that has the `direct_entry.team_leader_marker` GUC turned on; partial indexes exclude markers from the live path; the comment on the constraint calls the marker "inert on every date, kept, never re-dated" (#71:36, #71:47). **The W03 design must not describe a zero-length grant row as a live authority; it must describe the marker as a closed historical event with no effect at any date, including the cancellation date itself.**

### A.2 Capability / scope vocabulary and the locked 23-token contract

| Surface | Source of truth | State at `1189c8a` |
|---|---|---|
| DB capability CHECK (23 tokens) | `supabase/migrations/20261009030000_p3_1_w01a_capability_contract_foundation.sql` (lines 21–47) | `entry_create, entry_own, entry_team, entry_admin, entry_restore, submission_create, change_request_create, change_review, entry_privileged_edit, employment_status.request, employment_status.review, employment_status.apply, document_upload, document_view, payment_view, payment_edit, recruiter_master_manage, team_master_manage, pii_view, pii_export, audit_view, catalog_master_manage, team_manager_assign` |
| TypeScript `CAPABILITIES` array (23 tokens) | `src/lib/auth/direct-entry-v2.ts:10` | identical 23-tuple, including the two new narrow tokens |
| `direct-entry-auth` contract version | `src/lib/auth/direct-entry-v2.ts:8` | `"direct-entry-auth/1.3"` (bumped by W01A; W01A focused lane asserted exact parity, see `docs/handoffs/p3-1-w01a-capability-contract-foundation.md`) |
| `RequiredScopeKind` map | `src/lib/auth/direct-entry-v2.ts:193` | `catalog_master_manage` → `all`; `team_manager_assign` → `team`. The all scope for `catalog_master_manage` and the team scope for `team_manager_assign` are both *non-substitutable*. |
| Capability grant/scope grant table | `supabase/migrations/20261002170000_p1_6_direct_entry_foundation.sql:74` (capability) and `:91` (scope) | strict 21-token CHECK (now 23 after W01A) + half-open interval CHECK (widened by W01D §1 to `valid_to >= valid_from`) + per-`(app_user_id, capability, valid_from)` unique key (now a partial marker-excluding index after W01D §2) |
| Reason / OCC / idempotency / audit | foundation `:417` (audit), `:…` (idempotency, restricted reasons, revisions, leader_revisions) | identical for all Direct Entry mutations; W01D does not introduce a parallel audit system |

### A.3 Account, link, capability, scope, audit, reason, idempotency, restore — current state

| Surface | Source | State at `1189c8a` |
|---|---|---|
| `direct_entry_app_users(app_user_id, auth_subject, enabled, created_at)` + `display_name` (NOT NULL, btrim 1..256 from `20261008220000_p2_5_hf_session_identity_header.sql`) | foundation `:5`; identity header | `enabled` is a boolean; **no `version`, no `updated_at`, no per-account revision, no per-account audit event**. The owner bootstrap (`scripts/p3-first-owner-bootstrap.mjs`) can create or re-enable a user but does not write an account revision/audit event. The W01D leader write RPCs read `enabled` and raise `42501 'target leader account is not not enabled'` if false (#71:1175–1180). |
| `direct_entry_app_user_recruiter_links(link_id, app_user_id, recruiter_id, verified, valid_from, valid_to)` | foundation `:62` | strict half-open interval; one verified effective link per app user is **not** schema-enforced (no cross-pair cardinality constraint); the W01D designate write requires `count = 1` verified effective link (`42501` on failure, #71:1217); the leader-read path joins `recruiters` on the persisted `a.leader_recruiter_id` FK, not on the link (per the W01D A2 server contract survey R4–R5). |
| `direct_entry_capability_grants` | foundation `:74`; W01A capability CHECK; W01D §1 widening + §2 partial index; W01D §4 marker trigger | effective-dated intervals; live path = `valid_to is null or valid_to > valid_from`; marker rows are inert; raw marker DML rejected with `23514`. |
| `direct_entry_scope_grants(scope_kind ∈ {own,team,all}, team_id null iff not team)` | foundation `:91`; W01D §1 + §2 + §4 | same effective-dated + partial-index + marker-trigger pattern as capability. |
| `direct_entry_restricted_reasons`, `direct_entry_rpc_idempotency`, `direct_entry_audit_events`, `direct_entry_revisions`, `direct_entry_submission_revisions`, `direct_entry_change_request_revisions`, `direct_entry_team_leader_revisions` | foundation `:…` and #71 §5 | shared by W01D leader writes and all prior mutations. **W03 must not introduce a parallel audit or revision table.** |
| `entry_restore` capability | foundation CHECK; W01A confirmation in the 23-token list; `src/lib/auth/direct-entry-v2.ts:31` and `:168` (REASON_REQUIRED_ACTIONS), `:181` (VERSION_REQUIRED_ACTIONS) | `entry_restore` requires reason + expected version; the `REQUIRED_SCOPE_KIND` map at `direct-entry-v2.ts:193` does **not** assign it a scope kind (the W01A lane asserted this), and no restore RPC, route, page or UI exists. `scripts/p3-first-owner-bootstrap.mjs` grants the token but the W01A lane notes the bootstrap is "not lifecycle API". |
| Existing audit read | `direct_entry_read_audit(auth_subject, app_user_id, entry_id, limit)` in `20261002170000` (foundation) | service-role-only RPC, limit 1–500, `SETOF direct_entry_audit_events`; **not** an Admin security-event explorer; no `full/catalog/none` mode; returns the raw row shape (which includes `auth_subject`, reason references, and change-request/submission revision FKs) — too broad for a browser W03 contract. |

### A.4 Actor / session / access repository and W08A freshness contract

| Source | Role | State at `1189c8a` |
|---|---|---|
| `src/lib/direct-entry/actor-context-repository.ts` | `createDirectEntryActorRepository(rpc?)` is the only producer of `ActorRepository` (per `src/lib/auth/direct-entry-v2.ts:94`). It calls service-role RPC `direct_entry_resolve_actor_context(p_auth_subject)` and returns either the live actor context or `INVALID_REPOSITORY_RECORD` on any error. | No cross-request cache. No persistent TTL. Every resolution is a fresh RPC. The W08A lane at `src/lib/auth/p3-w08a-session-revocation-cache.test.mjs` and the W08A closure memo `docs/handoffs/p3-w08a-session-revocation-cache-hardening.md` lock this contract. |
| `direct_entry_resolve_actor_context` | service-role RPC, reads live `direct_entry_app_users.enabled`, current capability intervals, links and scope data | W08A §6 concurrent-request invariant: parallel resolves of the same actor cannot return mixed stale/fresh state. W08A §7 cookie-refresh invariant: cookie rotation does not skip the live check. |
| `getDirectEntryActor` (in `src/lib/auth/direct-entry-session-core.ts`) | calls `auth.getUser()` and then the actor repository on **every** page decision | Auth responses are `private, no-store`; client authority fields are rejected by the v2 contract; page decisions are request-time server decisions. |
| Session boundary | W08A §9 "What was deliberately not changed" | W08A does **not** serialize an in-flight W03 mutation against a concurrent `disable`/`revoke`; the W03 RPCs must recheck database authority themselves inside the same transaction (same-row lock + post-lock recheck) — this is the W01D pattern. |
| Navigation / page predicates | `src/lib/navigation/registry-capability.ts:5,65` | comments still mention 21 tokens; the full-Admin triple, the catalog-operator guard, the `team_manager_assign` team scope and the new entry predicates will be added on top of the locked 23-token contract. |

### A.5 Lock/atomicity pattern that W03 must reuse

W01D's atomic mutation RPC (`direct_entry_apply_team_leader_mutation`, #71:1180–2080) is the canonical lock-order template. Any W03 grant/scope/link mutation that touches the same rows must follow the same order, with the same advisory keys, to avoid deadlocks with leader designate/revoke. The order is:

1. **Team aggregate OCC** — `for update` on the team row (leader case; W03 has no team aggregate, so W03 only locks the app user + grants).
2. **App-user row lock** — `perform u.app_user_id from direct_entry_app_users u where u.app_user_id = any(v_actor_ids) order by u.app_user_id for update` (#71:1170–1173). W03 must do the same in `app_user_id` order.
3. **Scope grant row locks** — `for update` on `direct_entry_scope_grants` in `(app_user_id, grant_id)` order (#71:1181–1185). W03 scope mutation must lock the same way.
4. **Capability grant row locks** — `for update` on `direct_entry_capability_grants` in `(app_user_id, grant_id)` order (#71:1186–1190). W03 capability mutation must lock the same way.
5. **Advisory locks** — `pg_advisory_xact_lock(hashtextextended(v_lock_key, 0))` for the same `capability:…`, `scope:…`, `recruiter-link:…` keys the canonical overlap trigger uses, in stable `order by key` (#71:1191–1210). W03 must use the same keys in the same order if it touches the same trigger-guarded intervals.
6. **Recruiter link + recruiter + provider membership** — leader-only path. W03 link lifecycle locks the same way when it reads or writes a link row.
7. **Reason, idempotency, revision, audit** — written last, in that order, with the W01D `set_config('direct_entry.team_leader_marker', 'on', true)` transaction-local flag set immediately before any zero-length marker write.

**R1 correction 2 (mandatory after #71) — W03 grant/scope/link mutations must reuse the same lock order and advisory keys, not introduce a parallel helper with a different order.** Deadlocks between the W01D leader designate/revoke RPC and a W03 generic grant RPC are the single largest correctness risk introduced by adding a new access surface; lock order is the only thing that prevents them.

### A.6 The leader-owned authority bundle

The atomic leader bundle is a tuple of three rows written in one transaction by the W01D `direct_entry_apply_team_leader_mutation` RPC:

1. `direct_entry_team_leader_assignments` row keyed by `team_id` (and the partial-open `team_open_uidx`).
2. `direct_entry_scope_grants` row: `app_user_id = leader, scope_kind = 'team', team_id = <team>`, coextensive on `(valid_from, valid_to)` with the assignment row.
3. `direct_entry_capability_grants` row: `app_user_id = leader, capability = 'team_manager_assign', valid_from = <valid_from>`, coextensive on `(valid_from, valid_to)` with the assignment row.

The bundle's invariants, all enforced by the W01D postcondition block at #71:1418–1490, are:

- Exactly one current leader per team (`v_post_team_assignment_count = 1`).
- Exactly one current team-scope row for the current leader in the team (`v_post_target_team_scope_count = 1`).
- Exactly one current `team_manager_assign` row for the current leader (`v_post_capability_count = 1`).
- The assignment's `(valid_from, valid_to)` is `IS NOT DISTINCT FROM` the scope's and capability's `(valid_from, valid_to)` (coextensivity). The postcondition queries assert `s.valid_from = a.valid_from and s.valid_to is not distinct from a.valid_to` (and the same for capability), so a leader-bundle row whose dates drift from the assignment row fails `55000`.
- Replace closes the outgoing bundle atomically (one `team_leader_assignment` close + one `team_manager_assign` close + one `team` scope close) and opens the incoming bundle in the same transaction; the W01D `55000 'team leader mutation postcondition failed'` postcondition is the only safety net if any of the three rows is mis-shaped.
- Revoke closes the bundle atomically (one close on each of the three rows) and creates a zero-length marker on each interval to record the closure; the transaction-local `direct_entry.team_leader_marker` GUC is on for the duration of the close write.

**R1 correction 3 (mandatory after #71) — leader bundle cannot be partially mutated by a generic W03 grant/scope/link RPC.** A W03 grant/scope/link mutation that:

- Inserts a `team_manager_assign` capability outside the W01D designate RPC, or
- Inserts/updates a `team` scope row whose `(valid_from, valid_to)` does not match an existing leader assignment row, or
- Closes only the capability row (or only the scope row) of an existing leader bundle,

must fail closed. The marker trigger's transaction-local flag is the W01D mechanism; W03 generic mutations must not set that flag. The legacy W05A seed `direct_entry_seed_team_scope_grants()` exists and is verified by the W01D self-check to still be present, but it has been **revoked from every role** (`public, anon, authenticated, service_role`) at #71:1969–1970 and is not a runtime grant path. The W03 design must treat the leader bundle as owned by the W01D RPCs; W03 generic mutations may grant/revoke other capabilities (`recruiter_master_manage`, `audit_view`, `entry_restore`, `pii_view`, `pii_export`, etc.) and other scopes (`own`, `all`) but must not touch the leader bundle except through the W01D RPC.

### A.7 Existing tests, scripts and migration-slot boundary

| Source | Reuse for W03 |
|---|---|
| `scripts/p1.6-w03-db.test.mjs` (foundation actor/grant/scope/audit ACL and integrity, including `direct_entry_read_audit` ACL) | canonical ACL and integrity fixture for the W03 grant/scope mutation lanes |
| `scripts/p1.6-w04-s03a-db.test.mjs`, `…-s03cd-db.test.mjs`, `…-s04a-db.test.mjs` | revision/OCC/audit fixtures |
| `scripts/p2-5-hf-r5-session-identity-db.test.mjs` | migration fail-closed + version/audit pattern |
| `scripts/p3-w05a-team-scope-seed.test.mjs` | W05A seed/link/scope cases (will need to assert the seed is no longer executable by any role) |
| `scripts/p3-first-owner-bootstrap.test.mjs` | bootstrap, "23 tokens exactly", display-name NOT NULL — locked by W01A |
| `scripts/p2-5-accounting-project-admin-provision.test.mjs` | Accounting bundle plan; the W03 lane will assert that this plan grants no security-admin capability |
| `scripts/p3-1-w01a-capability-contract.test.mjs` | exact 23-token DB/TS parity, contract 1.3, reason + version + scope kind enforced for both new tokens, all scope cannot substitute team scope for `team_manager_assign`, client-supplied actor/capability/scope still rejected, no page/nav surface opened |
| `scripts/p2-5-w06a-r2-manager-candidates-db.test.mjs` | candidate projection shape/scoping (different feature but the projection discipline is the same) |
| `src/lib/auth/direct-entry-v2.test.mjs` | capability registry, contract version, malformed-record fail-closed |
| `src/lib/auth/p3-w08a-session-revocation-cache.test.mjs` | the W08A freshness invariants the W03 RPCs must respect (no in-memory actor cache; concurrent resolves of the same actor cannot mix stale/fresh; cookie refresh does not skip the live check) |

**Migration-slot boundary.** The prior W03 survey's instruction "do not reserve #71 or #72" remains correct. W01D occupies #71. W03 will start at **#72**; W03 will not reserve a fixed second number, will not speculatively name a slot for a later wave, and will not edit earlier migrations. Append-only, cohesive per slice.

## B. Authority matrix (locked, post-#71)

The matrix below is the W03 read surface. **The mutation authority for any cell is the corresponding cell in §C and the corresponding RPC in §D**, not the matrix below — this matrix is a contract on what the route layer may show and what the page decision may allow, not a contract on what the SQL RPC must accept.

| Surface | Full Admin (3 tokens + all) | Accounting (`catalog_master_manage@all`) | Project Admin (`entry_admin@all`) | Team leader (`team_manager_assign@team`) | PM (assignment-derived) | Staff | Disabled / unmapped / ambiguous / no auth_subject / stale mapping |
|---|---|---|---|---|---|---|---|
| Account enable / disable (`direct_entry_app_users.enabled`) | allow | **deny** | **deny** | **deny** | **deny** | **deny** | **deny** |
| Capability grant / revoke (any of the 23 tokens) | allow | **deny** | **deny** | **deny** | **deny** | **deny** | **deny** |
| Scope grant / revoke (`own` / `team` / `all`) | allow | **deny** | **deny** | **deny** | **deny** | **deny** | **deny** |
| `team_manager_assign` + matching `team` scope leader bundle | allow (via the W01D designate/revoke RPC) | allow (via the W01D designate/revoke RPC) | **deny** | **deny** | **deny** | **deny** | **deny** |
| App-user ↔ recruiter verified link lifecycle | allow | **deny** | **deny** | **deny** | **deny** | **deny** | **deny** |
| `entry_restore` | allow (Admin-only) | **deny** | **deny** | **deny** | **deny** | **deny** | **deny** |
| Audit explorer (Admin bounded full) | allow | bounded: catalog + worker events per policy, no security-admin audit | **deny** | own manager-assignment event surfaced inside Project Operations | **deny** | **deny** | **deny** |
| Personnel / team / vendor / labor-type catalog mutate | allow | allow | allow (existing project path) | **deny** | **deny** | **deny** | **deny** |
| Direct Entry write / submit | per existing capability | unchanged | unchanged | assignment-scoped | own scope | own scope | **deny** |
| Reason / OCC / idempotency / audit / revision writes | as required by the corresponding mutation | as required by the corresponding mutation | as required by the corresponding mutation | as required by the corresponding mutation | as required by the corresponding mutation | as required by the corresponding mutation | **deny** (no mutation to even attach a reason to) |

**R1 correction 4 (mandatory after #71) — four distinct authority tiers, never derived from role / email / personnel_position.** The matrix above is enforced by the W01D/W01A/W01B/W01C guards and the W03A/B/C guards. No W03 code may infer authority from a display name, a role label, an `auth.users.email` value, or a `personnel_position` value. The C01 catalog policy survey and J00 security regression baseline lock this; the W01D designate write requires a verified link to a real recruiter, never a role string, and the W01A capability CHECK is the only source of truth for capability tokens.

## C. Locked mutation contracts

Every W03 mutation RPC must satisfy every row below, **simultaneously**. The W03 lanes in §F assert each row for each W03 slice.

### C.1 App-user aggregate (W03A — required schema delta)

**Contract.** `direct_entry_app_users` must carry enough state for concurrent account-status changes to use optimistic concurrency control and to be auditable.

Minimum schema delta (the W03A migration must add, append-only, and the W03A self-check must assert):

- `version integer not null default 1 check (version >= 1)` — same shape as `recruiters.version` and `teams.version`. Every enable/disable RPC reads, compares, increments and writes `version` in a single transaction.
- `updated_at timestamptz not null default now()` — bumped on every status change.
- A new `direct_entry_app_user_revisions` table mirroring `direct_entry_team_leader_revisions`: `(revision_id uuid pk, app_user_id uuid fk, version integer, actor_user_id uuid, action text check in ('create','enable','disable'), before_snapshot jsonb, after_snapshot jsonb, reason_id uuid fk, created_at timestamptz default now(), check (version >= 1), unique(app_user_id, version))`. Forced RLS, no privilege to any role, internal `SECURITY DEFINER` writer.
- One reason + one audit event per `version` increment. The audit event is the W01D `direct_entry_audit_events` row: `action in ('app_user_enable','app_user_disable')`, `capability = 'app_user_manage'`, `outcome = 'APPLIED'`, `changed_fields = array['enabled']`, `revision_id = <new revision>`.

**W03A mutation RPCs (service-role-only, `search_path = pg_catalog, public`, EXECUTE to `service_role` only):**

- `direct_entry_enable_app_user(auth_subject, app_user_id, expected_version, reason text, idempotency_key text)` — asserts `app_user_id.enabled = false`, `expected_version = current`, writes `enabled = true`, `version = current + 1`, `updated_at = now()`, appends a revision, writes one audit event, returns `{app_user_id, version, revision_id, change = 'enable'}`.
- `direct_entry_disable_app_user(...)` — symmetric. The disable path must also close every open `team_manager_assign` capability and every open `team` scope of this app user by writing zero-length markers (with the W01D `direct_entry.team_leader_marker` GUC on for that transaction). It must also close every open verified-effective link by writing zero-length markers (link CHECK is still strict, so a future migration may need a parallel W03C link marker; the W03A plan defers the link marker until W03C owns link lifecycle).

**W03A atomicity / authority.** Same lock order as W01D: `for update` on the app-user row, then on every open capability row and every open scope row of the app user, in `(app_user_id, grant_id)` order, then `pg_advisory_xact_lock` for the canonical trigger keys, then revision + reason + idempotency + audit. The Full Admin authority is required (`entry_admin + recruiter_master_manage + team_master_manage` triple + effective `all` scope), enforced by the existing `direct_entry_assert_actor` for capability and a new `direct_entry_assert_app_user_admin` helper for the full triple. **The transaction-local `direct_entry.team_leader_marker` GUC is set on only for the marker close write inside the same transaction; the W03A RPC is the only W03 RPC that sets the GUC.**

**W03A closed scope.** The W03A migration does **not** add an invitation/initial-password/forced-reset/MFA path; it does not add a `direct_entry_invite` table, a `direct_entry_password_reset` table or a `direct_entry_mfa` table; the `direct_entry_app_users.display_name` change is a separate `change_request` path; the PII / email / phone change is the `change_request` path; the `auth.users` row is owned by Supabase Auth and is out of scope. **P3.2 owns invitations, initial passwords, forced resets, MFA and account recovery.**

### C.2 Capability and scope interval mutations (W03B)

**Contract.** Capability and scope intervals are effective-dated, audited, reason-stamped, OCC-locked and idempotency-keyed. They are written by RPCs that follow the W01D lock order. They permit zero-length markers (per #71 §1, §2, §4) only when the transaction has the W01D `direct_entry.team_leader_marker` GUC on, and only the W01D leader mutation RPCs ever set the GUC. **Therefore a W03B grant/scope RPC must not create a zero-length capability or scope row — there is no W03B mutation that the GUC would authorise.**

**W03B mutation RPCs (service-role-only, `search_path = pg_catalog, public`, EXECUTE to `service_role` only):**

- `direct_entry_grant_capability(auth_subject, app_user_id, capability, scope_kind, team_id null, valid_from date, reason text, idempotency_key text)` — full Admin authority required; assert `capability in (23 tokens)` (CHECK will reject unknown with `23514`); assert the W01D canonical trigger keys; assert no overlap on a live interval; insert one row, one revision, one reason, one audit event, one idempotency record.
- `direct_entry_revoke_capability(auth_subject, app_user_id, capability, scope_kind, team_id null, effective_date date, reason text, idempotency_key text)` — same authority; writes a zero-length marker on the current live interval (sets the GUC for the marker close write), then writes a fresh row with the new `(valid_from, valid_to)`. The marker is inert.
- `direct_entry_grant_scope(...)` and `direct_entry_revoke_scope(...)` — same shape, same authority, same lock order, same marker semantics.
- A new helper `direct_entry_assert_app_user_admin(auth_subject, app_user_id)` enforces the full Admin triple and effective `all` scope; it returns the exercised authority (`'entry_admin'` for the full triple, or `'entry_admin'` only if some token is missing — which must not happen for the W03B RPCs).

**W03B explicitly does not write:** a zero-length capability for `team_manager_assign` (the W01D designate/revoke RPC owns the leader bundle); a `team` scope row whose `(valid_from, valid_to)` is not `IS NOT DISTINCT FROM` a live leader assignment row; any row on `direct_entry_app_user_recruiter_links` (W03C owns the link table). A W03B RPC that detects a leader-bundle violation raises `42501 'security mutation is owned by the leader lifecycle RPC'` and rolls back.

### C.3 Verified link lifecycle (W03C)

**Contract.** The link table is strict half-open (`valid_to > valid_from`, per foundation `:62` and the W01D re-assertion in the W01D self-check). A link row's `valid_to = valid_from` is currently a `23514` rejection by the foundation CHECK; **W03C does not widen the link CHECK.** The `verified` boolean is a label, not a capability, and is set at insert time. The schema does not enforce one verified effective link per app user across different recruiters; **W03C adds a cross-pair partial unique index** that excludes markers (after the W03C migration widens the link CHECK) and a per-`(app_user_id)` partial unique index that admits at most one verified effective link, with the marker exclusion predicate. The widening is identical in shape to the W01D §1 widening of capability/scope CHECKs; the trigger is the existing link overlap trigger; the W03C migration installs the same `direct_entry_team_leader_marker()` trigger on `direct_entry_app_user_recruiter_links` (or a sibling `direct_entry_link_marker()` with the same transaction-local GUC semantics) and reuses the W01D `direct_entry.team_leader_marker` GUC name.

**W03C mutation RPCs (service-role-only, EXECUTE to `service_role` only):**

- `direct_entry_create_verified_link(auth_subject, app_user_id, recruiter_id, valid_from date, reason text, idempotency_key text)` — full Admin authority required; assert the recruiter is active; assert the app user is enabled; assert no current verified effective link (the W03C partial index would reject, but the RPC precheck yields a clean `42501 'app user already has a verified link'`); insert one link row, one reason, one audit event, one idempotency record.
- `direct_entry_revoke_verified_link(auth_subject, app_user_id, recruiter_id, effective_date date, reason text, idempotency_key text)` — full Admin authority required; assert the link is currently verified-effective; write a zero-length marker (GUC on for the marker close write), then a fresh row with the new `(valid_from, valid_to)`. The W01D leader-read path is **not** affected because leader-read joins on the persisted `a.leader_recruiter_id` FK, not on the link (per the W01D A2 server contract survey R4–R5).

**W03C atomicity.** Same lock order as W01D. The W03C RPC must additionally `for update` the link row in `link_id` order, the recruiter row, and the recruiter_provider_memberships rows (leader designate path), because the W01D designate path locks the same rows in the same order. **Lock order is the single hardest contract to keep in sync between W03C and the W01D designate/revoke; the W03C self-check must assert the lock order via a deterministic error-injection test.**

### C.4 Bounded audit projection by mode (W03D)

**Contract.** `direct_entry_read_audit(...)` is too broad for a browser W03 contract (it returns the raw row including `auth_subject`, reason references, revision FKs and changed_fields). W03D adds a new service-role RPC `direct_entry_read_security_audit(auth_subject, app_user_id, mode, page, page_size)` where `mode ∈ {'full','catalog','own_manager'}`. The RPC returns a JSONB list of bounded event rows, exactly the fields the W03 UI needs:

- `event_id` (uuid), `created_at` (timestamptz), `action` (text), `capability` (text or null), `scope_kind` (text or null), `scope_team_id` (uuid or null), `outcome` (text), `changed_fields` (text[]), `team_id_or_resource_ref` (text, the bounded opaque reference — never the actor's `auth_subject`).
- The mode `full` is Admin-only (`entry_admin + recruiter_master_manage + team_master_manage` triple + effective `all`) and returns the full bounded set.
- The mode `catalog` is `catalog_master_manage@all` and returns only events whose `capability in ('catalog_master_manage','recruiter_master_manage','team_master_manage','employment_status.*','pii_view','pii_export','document_*')` and that are **not** in the security-admin allowlist (`entry_restore`, `app_user_enable`, `app_user_disable`, `direct_entry_grant_*`, `direct_entry_revoke_*`, `direct_entry_link_*`). The full Security slice is excluded for Accounting.
- The mode `own_manager` is a `team_manager_assign@team` actor and returns events whose `app_user_id = caller.app_user_id` AND `action in ('team_leader_designate','team_leader_replace','team_leader_revoke')` AND `scope_team_id = caller.team_id`. The leader must not see the actor's `auth_subject`, the reason text, or any other actor's events.

**Forbidden in the bounded projection (W03D RPC).** `auth_subject`, `app_user_id` (other than the caller's), `reason_id`, raw reason text, credential/token, storage key, raw DB error, any PII (email, phone, name, CCCD), any UUID that would identify a real person outside the W03 audit policy.

**W03D also adds** a new `direct_entry_read_security_audit_self_check()` (internal) that the W03D migration self-check runs to assert: every returned column is in the allowlist; no `auth_subject` is serialised; the SQLSTATE 42501 fires for any non-Full-Admin caller asking for `mode = 'full'`; the SQLSTATE 42501 fires for any non-`catalog_master_manage@all` caller asking for `mode = 'catalog'`; the SQLSTATE 42501 fires for any non-`team_manager_assign@team` actor asking for `mode = 'own_manager'` and not owning the team id.

**W03D does not** add a "fetch all then hide client-side" path. The bounded set is enforced server-side at the SQL level. The page is request-time and never cached.

### C.5 Admin-only restore (W03E)

**Contract.** `entry_restore` is a capability in the 23-token list; it requires reason + expected version in the W01A `direct-entry-v2.ts` action map; the `REQUIRED_SCOPE_KIND` map does **not** assign it a scope kind (the W01A lane asserted this and the J00 baseline reflects it). **W03E assigns `entry_restore` an effective `all` scope requirement** (W03E updates the `direct-entry-v2.ts` `REQUIRED_SCOPE_KIND` map and bumps the contract to `direct-entry-auth/1.4`) and adds a service-role-only RPC `direct_entry_restore_entry(auth_subject, app_user_id, entry_id, restore_kind, expected_version, reason text, idempotency_key text)`. The RPC is Full-Admin-only.

`restore_kind ∈ {'entry','submission','change_request','document','leader'}` — one bounded enumeration, no free-form text. The RPC restores from the corresponding revision table: it reads the latest revision's snapshot, increments the version, appends a new revision, writes one reason + one audit event. The response is the canonical entry/snapshot envelope, never a free-form JSON of the entire row.

**W03E closed scope.** Restore is a write that re-creates a historical state. It must not be used to bypass a W01D leader revoke, a W03A disable, a W03B capability revoke or a W03C link revoke. The W03E RPC must `for update` the target entry row + the current revision row + the current capability/scope/link rows of the affected app user in the W01D order, must assert the current `enabled` flag, must assert the current capability set, and must raise `55000 'restore would re-introduce a revoked security state'` if the restore would re-introduce a `team_manager_assign`, a `team` scope, a `catalog_master_manage`, a `recruiter_master_manage` or a `team_master_manage` capability that is not currently effective.

### C.6 Combined session-revocation regression (W03F / J01)

**Contract.** W03F is the lane that asserts the W08A invariants hold after W03A–E. The W08A closure memo and `src/lib/auth/p3-w08a-session-revocation-cache.test.mjs` already cover: no in-memory actor cache, concurrent resolves of the same actor cannot return mixed stale/fresh state, cookie refresh does not skip the live check, and the actor resolver is service-role-only. W03F adds: a mutation that disables an app user while a parallel resolve is in flight must make the second resolve see `enabled = false`; a mutation that revokes a capability while a parallel resolve is in flight must make the second resolve not see the capability; a mutation that revokes a verified link while a parallel resolve is in flight must make the second resolve not see the link; the `getDirectEntryActor` call site returns the same denial for the disabled/revoked actor as it would for an actor that was disabled/revoked before the page request started.

W03F does not introduce a parallel session framework; it adds regression cases to the W08A lane. J01 is the readiness audit that signs off W03A–F together.

## D. Reuse map (W03 imports from existing code; W03 does not introduce a new framework)

| Concern | Existing primitive that W03 reuses | W03 does not introduce |
|---|---|---|
| Capability / scope token vocabulary | `CAPABILITIES` in `src/lib/auth/direct-entry-v2.ts:10` (23 tokens) | a new capability registry, a new RBAC framework, a new ORM |
| Action / reason / version / scope-kind map | `REASON_REQUIRED_ACTIONS`, `VERSION_REQUIRED_ACTIONS`, `REQUIRED_SCOPE_KIND` in `direct-entry-v2.ts:168, :181, :193` | a new action map |
| Contract version | `DIRECT_ENTRY_AUTH_CONTRACT_VERSION = "direct-entry-auth/1.3"`; W03E bumps to `1.4` if it adds the `entry_restore` all-scope kind | a new contract id |
| Actor context | `createDirectEntryActorRepository` in `src/lib/direct-entry/actor-context-repository.ts` | a new actor store |
| Session boundary | `getDirectEntryActor` in `src/lib/auth/direct-entry-session-core.ts`; W08A freshness invariants | a new auth framework, an in-memory actor cache |
| Reason table | `direct_entry_restricted_reasons` (foundation) | a parallel reason system |
| Idempotency | `direct_entry_rpc_idempotency` (foundation) | a parallel idempotency store |
| Audit | `direct_entry_audit_events` (foundation) + W01D leader revisions (W01D §5) | a parallel audit system |
| Lock-order template | W01D `direct_entry_apply_team_leader_mutation` (#71:1180–2080) | a parallel lock helper with a different order |
| Marker trigger + transaction-local GUC | W01D `direct_entry_team_leader_marker()` and `direct_entry.team_leader_marker` GUC (#71:130–155, #71:1384) | a parallel marker mechanism |
| Catalog contract / API / repository shape | `src/lib/direct-entry/{personnel,team,membership,…}-catalog-{contract,api,repository}.ts` | a new contract pattern |
| Strict TypeScript projector pattern | `…-contract.ts` `xxxItem(value)` / `xxxList(value)` envelope parsers | a new contract pattern |
| Reason / version / idempotency enforcement | `direct-entry-v2.ts:132` `AuditEnvelope` + `AuthorizationInput` | a parallel envelope |
| Navigation registry | `src/lib/navigation/registry-capability.ts` (comments still mention 21 tokens; W03 updates after the W03E contract bump) | a new navigation framework |
| AppShell / Admin shell | the existing app shell (used by W04-A1/A2 in the W01D feature branch) | a new admin shell |
| SQLSTATE → API HTTP code map | the W01D `direct_entry_leader_*` → `LEADER_*` map in the W01D A2 server contract survey; W03 reuses the same convention (`SECURITY_DENIED`, `SECURITY_INVALID`, `SECURITY_CONFLICT`, `SECURITY_NOT_FOUND`, `SECURITY_UNAVAILABLE`) | a parallel taxonomy |

## E. Proposed W03 sequencing (logical order, no reserved migration slot)

The numbers are logical waves, not migration numbers. Migrations are append-only and start at **#72** for W03A. The W03A–F numbering below is the same as the prior W03 survey (R1 confirms it).

| Wave | Slice | Migration (appended) | API (new) | Tests (new) | Self-check |
|---|---|---|---|---|---|
| W03A | App-user aggregate (version / OCC / reason / revision / audit) + `direct_entry_enable_app_user` + `direct_entry_disable_app_user`. Add `direct_entry_app_user_revisions`; bump `direct_entry_app_users` with `version`, `updated_at`. | #72 | none in this slice; W03F/J01 will add the bounded admin route | `scripts/p3-1-w03a-app-user-lifecycle-db.test.mjs` (registered as `test:p3-1-w03a` in `package.json` and in the `pnpm test` chain exactly once) | asserting the 23-token CHECK, the partial marker-excluding indexes (no drift), the `version >= 1` CHECK, the `direct_entry_app_user_revisions` shape, forced RLS, no role privilege, marker trigger, audit `action in ('app_user_enable','app_user_disable')`, idempotency, and the W01D lock order |
| W03B | Capability and scope grant / revoke RPCs (full Admin authority), reusing the W01D lock order and the W01D marker trigger. | #73 | `direct_entry_grant_capability`, `direct_entry_revoke_capability`, `direct_entry_grant_scope`, `direct_entry_revoke_scope` | `scripts/p3-1-w03b-capability-scope-lifecycle-db.test.mjs` | asserting the 23-token CHECK, the partial indexes, the marker trigger, audit, idempotency, reason, OCC, and the leader-bundle denial (a W03B RPC that tries to mutate a leader bundle row raises `42501 'security mutation is owned by the leader lifecycle RPC'`) |
| W03C | Verified link lifecycle (create / revoke) with link CHECK widening and partial unique verified-effective index. | #74 | `direct_entry_create_verified_link`, `direct_entry_revoke_verified_link` | `scripts/p3-1-w03c-link-lifecycle-db.test.mjs` | asserting the link CHECK widening, the partial verified-effective index, the marker trigger, the W01D lock order (link_id then recruiter then provider), the leader-read historical invariant (re-running the W01D A2 server contract R4–R5 lane on a recruiter whose link was revoked) |
| W03D | Bounded audit projection RPCs by mode (`full` / `catalog` / `own_manager`). | #75 | `direct_entry_read_security_audit` | `scripts/p3-1-w03d-audit-projection-db.test.mjs` | asserting the bounded columns, the no-`auth_subject` rule, the per-mode authority (Admin-only `full`, `catalog_master_manage@all` `catalog`, `team_manager_assign@team` own-team `own_manager`), the page/page_size bounds, the leader-read historical invariant still holds |
| W03E | Admin-only `entry_restore` RPC, with `REQUIRED_SCOPE_KIND` updated to `all` (and `DIRECT_ENTRY_AUTH_CONTRACT_VERSION` bumped to `1.4`). | #76 | `direct_entry_restore_entry` | `scripts/p3-1-w03e-restore-db.test.mjs` | asserting the authority (`entry_admin + recruiter_master_manage + team_master_manage` triple + effective `all`), the `restore_kind` enumeration, the no-revoked-state-re-introduction rule, audit, idempotency, the contract version bump, the test assertion that the v1.3 lane still passes |
| W03F / J01 | Combined session-revocation regression + readiness audit. | (no migration; the lane is `pnpm test`) | none | `scripts/p3-1-w03f-session-revocation-regression-db.test.mjs` (adds cases to the W08A lane without removing or duplicating any) | asserting the W08A invariants hold for the W03 mutations, the actor resolver stays service-role-only, the W01D lock order is unchanged by the W03 additions, all 11 listed tests above pass when the corresponding mutation is broken, and the W08A lane still passes |

The sequencing is logical, not a single large migration. W03A must land first because the app-user aggregate is the W03A foundation; W03B and W03C may land in either order, but each must be reviewed in isolation; W03D depends on the audit-event vocabulary that W03A–C introduce; W03E depends on the W01A contract being at `1.3` (so the bump to `1.4` is its own small delta) and on the canonical 23-token list; W03F / J01 is the combined regression and readiness audit.

## F. Allowed / denied test matrix

The matrix below is the **assertion** matrix. The §B matrix is the contract; this matrix is how the W03 lanes prove the contract. Every row must have a red-making mutation in §G.

| Surface / scenario | Full Admin | Accounting | Project Admin | Team leader | PM | Staff | Disabled / unmapped / ambiguous / no auth_subject / stale mapping |
|---|---|---|---|---|---|---|---|
| Enable a disabled app user | allow (W03A RPC) | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` |
| Disable an enabled app user | allow (W03A RPC) | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` |
| Grant a non-leader capability (`pii_view`) | allow (W03B RPC) | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` |
| Revoke a non-leader capability | allow (W03B RPC) | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` |
| Grant a `team` scope on a non-leader team | allow (W03B RPC, with the leader-bundle denial) | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` |
| Grant a `team_manager_assign` capability directly via W03B | deny `42501 'security mutation is owned by the leader lifecycle RPC'` (must come from the W01D designate RPC) | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` |
| Create a verified link for a disabled app user | deny `42501 'app user is not enabled'` (W03A) / `42501` (W03C) | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` |
| Create a second verified effective link for the same app user | deny `23514` (W03C partial unique index) | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` |
| Revoke a verified link that is the basis of a current leader bundle | allow (W03C), but the W01D designate/revoke RPC will reject the next leader mutation with `42501 'target leader requires exactly one verified recruiter link'` (no change to the historical assignment row, which is keyed on the persisted `a.leader_recruiter_id` FK) | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` |
| Read `mode = 'full'` audit | allow | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` |
| Read `mode = 'catalog'` audit | allow | allow (catalog + worker events, no security-admin audit) | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` |
| Read `mode = 'own_manager'` audit | allow | deny `42501` | deny `42501` | allow only for own team (cross-team = `42501`) | deny `42501` | deny `42501` | deny `42501` |
| `direct_entry_restore_entry` | allow (W03E RPC) | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` |
| `direct_entry_restore_entry` that would re-introduce a revoked leader bundle | deny `55000 'restore would re-introduce a revoked security state'` | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` | deny `42501` |
| Raw `INSERT INTO direct_entry_capability_grants VALUES(..., 'unknown', ...)` | `23514` (capability CHECK) | n/a | n/a | n/a | n/a | n/a | n/a |
| Raw `INSERT INTO direct_entry_capability_grants VALUES(..., valid_to = valid_from, ...)` outside a leader RPC | `23514 'team-leader cancellation marker requires the audited mutation path'` (W01D §4 marker trigger) | n/a | n/a | n/a | n/a | n/a | n/a |
| W03B grant RPC that touches a row locked by a parallel W01D designate RPC | the W03B RPC waits on the W01D lock and proceeds after the W01D RPC commits; the W01D RPC waits on the W03B lock and proceeds after the W03B RPC commits; lock order is identical, so the wait is FIFO and deadlocks are impossible | n/a | n/a | n/a | n/a | n/a | n/a |
| Two parallel W03B grants of the same capability for the same app user | one wins; the loser gets `23P01 'exclusion constraint violation'` (the partial unique index) and rolls back; no partial state | n/a | n/a | n/a | n/a | n/a | n/a |
| Two parallel W03A enable / disable of the same app user | the loser gets `40001` (OCC), no partial state | n/a | n/a | n/a | n/a | n/a | n/a |
| Two parallel W03C create / revoke of the same verified link | the loser gets `23514` (partial unique verified-effective index) or `23P01`, no partial state | n/a | n/a | n/a | n/a | n/a | n/a |
| Same-day revoke + grant with zero-length marker | the marker is inert, the fresh row is effective at the next instant, the audit event is written, the postcondition `55000` fires if the new row is not live | n/a | n/a | n/a | n/a | n/a | n/a |
| Stale actor (cookie present but `enabled = false`) making any W03 request | deny `42501` on the next actor resolve (W08A) | n/a | n/a | n/a | n/a | n/a | n/a |
| Direct URL / API / RPC call to a W03 surface without authority | server denial (the route is request-time, not nav-hidden) | n/a | n/a | n/a | n/a | n/a | n/a |
| Direct anonymous / authenticated table DML or RPC EXECUTE | denied (RLS forced, table privileges revoked, RPC EXECUTE only `service_role`) | n/a | n/a | n/a | n/a | n/a | n/a |
| `auth.users.email` change attempt via a W03 RPC | denied (the W03 RPCs do not touch `auth.users`; P3.2 owns invitations / passwords / MFA / recovery) | n/a | n/a | n/a | n/a | n/a | n/a |
| `entry_restore` attempt without reason / version / idempotency key | deny `42501` (W01A `direct-entry-v2.ts:168, :181`) | n/a | n/a | n/a | n/a | n/a | n/a |
| Audit projection that contains `auth_subject` | deny `55000 'security audit projection leaked auth_subject'` (W03D self-check) | n/a | n/a | n/a | n/a | n/a | n/a |
| Leader-bundle mutation by a generic W03B / W03C RPC | deny `42501 'security mutation is owned by the leader lifecycle RPC'` | n/a | n/a | n/a | n/a | n/a | n/a |

## G. Mutation-check plan

Each assertion below must have a deliberate mutation that makes the focused test fail, followed by restoring the source byte-identically. This is planned for the implementation lanes; no mutations are run in this R1 survey.

| Security assertion | Required red-making mutation |
|---|---|
| App-user OCC is one compare-and-increment | Remove the `version` compare or the `version + 1` write; the stale write or the duplicate-version test must turn red. |
| Disable writes a zero-length marker on every open leader bundle | Remove the GUC `set_config('direct_entry.team_leader_marker', 'on', true)` from the disable RPC; the marker-write test must turn red. |
| Disable rolls back on any reason / revision / audit / idempotency failure | Move one of those writes outside the transaction; the residue-counts test must turn red. |
| W03B grant RPC follows the W01D lock order | Reorder the `for update` to a different key order or skip the `pg_advisory_xact_lock`; the lock-order parity test must turn red. |
| W03B grant RPC rejects leader-bundle mutation | Remove the leader-bundle denial from the W03B RPC; the direct `team_manager_assign` test or the coextensive `team` scope test must turn red. |
| W03C link lifecycle widens the link CHECK and installs the marker trigger | Skip the `alter table … drop constraint / add constraint` or the trigger; the link marker test must turn red. |
| W03C link lifecycle installs the partial verified-effective unique index | Skip the partial unique index; the second-link test must turn red. |
| W03C link lifecycle joins on the persisted `a.leader_recruiter_id` FK on the leader-read path | (already proved by the W01D A2 server contract R4–R5 lane) re-run after W03C lands and the lane must still pass; if it turns red, W03C introduced a regression. |
| W03D audit projection has no `auth_subject` column | Add a `jsonb_build_object('auth_subject', e.auth_subject)` to the projection; the column-allowlist test must turn red. |
| W03D `mode = 'full'` requires the full Admin triple | Drop one of the three capability predicates or the effective `all` scope; the Admin-only test must turn red. |
| W03D `mode = 'catalog'` excludes security-admin events | Widen the action allowlist to include `entry_restore` / `app_user_enable` / `app_user_disable` / `direct_entry_grant_*` / `direct_entry_revoke_*` / `direct_entry_link_*`; the Accounting-bounded-events test must turn red. |
| W03D `mode = 'own_manager'` is per-team | Drop the `scope_team_id = caller.team_id` predicate; the cross-team-deny test must turn red. |
| W03E `entry_restore` requires effective `all` scope | Drop the `all`-scope predicate; the restore-deny test must turn red. |
| W03E `entry_restore` rejects re-introducing a revoked security state | Remove the no-revoked-state check; the restore-leader-bundle test must turn red. |
| Full Admin is a three-capability AND plus all scope | Remove one capability predicate or the all-scope predicate; the missing-token / wrong-scope deny case must turn red. |
| Accounting cannot access security actions | Route the W03 guards through `catalog_master_manage`; the Accounting-deny test must turn red. |
| Project Admin / leader / PM / staff cannot access security actions | Route the W03 guards through `team_manager_assign`; the project-admin / leader / PM / staff deny test must turn red. |
| Enabled is checked in every mutator | Remove the `enabled` recheck from one W03 RPC; the disabled-direct-RPC test must turn red. |
| All-scope cannot be forged / substituted | Remove the effective `all` scope join or accept a client scope; the all-scope-required case must turn red. |
| Half-open interval and overlap safety | Remove the overlap trigger key predicate or change an interval boundary; the duplicate / overlap and boundary-date tests must turn red. |
| Future / expired / zero marker semantics | Make the W03 grant include a future / expired / zero interval, or allow raw marker DML; the corresponding date and raw-write tests must turn red. |
| Link ambiguity fail-closed | Remove the verified-effective cardinality validation; the zero / expired / two-link actor tests must turn red. |
| Concurrent grant / revoke and account disable | Remove the shared target-account lock or the post-lock authority recheck; the controlled concurrent test must demonstrate a stale-authority commit and fail. |
| Atomic zero-residue failure | Move a reason / revision / audit / idempotency write outside the transaction or suppress a failure; the affected-table before/after counts must turn red. |
| Idempotency exact replay / conflict | Skip the request-hash comparison or mutate the replay result; the same-payload equality or reused-key conflict test must turn red. |
| Audit mode cannot leak security events | Widen the catalog action allowlist or return the full row set before filtering; the exact event-class and forbidden-field tests must turn red. |
| Projection is exact / redacted | Add one forbidden key or return raw RPC JSON; the exact key-set and serialised forbidden-value tests must turn red. |
| `entry_restore` requires capability + scope | Remove either `entry_restore` or the effective `all` check; the direct RPC deny test must turn red. |
| ACL / search path is closed | Grant EXECUTE to `authenticated` / `public` or remove the fixed `search_path`; the ACL / catalog assertion must turn red. |
| Direct route is guarded | Remove the route / page server gate while leaving nav hidden; the direct URL / API call test must turn red. |
| The W01D lock order is preserved by every W03 mutation | Reorder a `for update` or a `pg_advisory_xact_lock` in a W03 RPC; the FIFO-wait / deadlock-impossible test must turn red. |
| The marker trigger rejects raw zero-length writes | Drop the trigger or short-circuit the GUC check; the raw-marker-DML test must turn red. |
| The legacy W05A seed is revoked from every role | Re-grant `EXECUTE` to `service_role`; the legacy-seed-revocation test must turn red. |
| The leader bundle is coextensive | Drop the `s.valid_from = a.valid_from and s.valid_to is not distinct from a.valid_to` postcondition; the coextensivity test must turn red. |
| The W08A actor resolver is service-role-only and re-resolves on every request | Add an in-memory actor cache; the disabled-on-next-resolve test must turn red. |
| The contract version bump (1.3 → 1.4) keeps the v1.3 lane green | Bump the version without updating the v1.3 fixture; the v1.3-fixture-must-still-pass test must turn red. |

## H. Production preflight (counts / booleans only; never UUIDs, names, emails, credentials, raw DB error)

The preflight runs read-only in a rollback-only transaction. It emits **counts and booleans**; it never returns a UUID that would identify a real account, never returns an email, name, `auth_subject`, credential, token, or raw DB error. The preflight is the W03F / J01 readiness step. It is **not** part of this R1 survey; it is the design that W03F / J01 must implement and run after T0 accepts the W03A–E package.

1. Migration ledger: applied count, pending count, mismatch count. Boolean: `pending_count = 0`; `mismatch_count = 0`. Required: `migration_count >= 72` (W03A must be at #72; the W01D R5 lane asserted the pre-#72 ledger is byte-stable).
2. Enabled / disabled app-user counts.
3. App-user version distribution. Boolean: `every_app_user_has_version >= 1`. Count: app users whose `version > 1` (the W03A mutations incremented).
4. Auth mapping integrity: app-user rows without an `auth.users` row; `auth.users` rows without a `direct_entry_app_users` row; duplicate or ambiguous `auth_subject` values. Booleans only.
5. Capability grant / scope grant integrity: capability token must be in the 23-token list (count only); scope kind must be in `{own, team, all}`; team scope rows must have a non-null `team_id`; non-team scope rows must have a null `team_id`; intervals must satisfy `valid_to is null or valid_to >= valid_from`; live intervals must satisfy the partial unique indexes (count violations). Booleans only.
6. Capability / scope overlap on live intervals. Count violations; boolean: `overlap_count = 0`.
7. Verified link integrity: app users with more than one effective verified link (count); verified links whose recruiter is inactive (count); orphan links. Booleans only.
8. Non-Full-Admin actors holding a security-admin capability (`entry_admin`, `recruiter_master_manage`, `team_master_manage`, `audit_view`, `entry_restore`, `app_user_manage` if W03A adds it). Boolean: `non_full_admin_security_holder_count = 0`. Count: legacy `entry_admin@all` holders (the Accounting transition concern, separate from W03). The preflight must not print actor identities.
9. Leader-bundle coextensivity: count of leader rows whose `team` scope or `team_manager_assign` capability is not coextensive. Boolean: `coextensivity_violation_count = 0`.
10. Marker audit: count of `direct_entry_capability_grants` / `direct_entry_scope_grants` / `direct_entry_app_user_recruiter_links` / `direct_entry_team_leader_assignments` zero-length rows whose transaction-local GUC was not set. Boolean: `unintended_marker_count = 0`. (Implementation note: the W03A–C self-checks assert this; the preflight is the production read-only mirror.)
11. Audit-event immutability: count of `direct_entry_audit_events` UPDATE / DELETE attempts (always zero because the trigger blocks). Booleans only.
12. `entry_restore` holder count. Count of `entry_restore@all` holders. Booleans only. Required: `entry_restore_all_holder_count <= full_admin_count`.
13. Session-revocation prerequisites: W08A lane present in `pnpm test`; `createDirectEntryActorRepository` is the only producer; the resolver is service-role-only; the actor context RPC has no in-memory cache; the page decision is request-time. Booleans only.
14. ACL integrity: `EXECUTE` on every W03 RPC is granted to `service_role` only; every W03 table is forced RLS and has no privilege to any role; every W03 RPC pins `search_path = pg_catalog, public`; every W03 internal helper is revoked from every role. Booleans only.
15. P3.2 boundary: no W03 surface exposes `auth.users.email`, no W03 surface exposes a default password, no W03 surface exposes an invitation token, no W03 surface exposes an MFA challenge. Booleans only.

The preflight does not run against Production in this survey.

## I. Risks, blockers and the P3.2 boundary

### I.1 Risks (R1-confirmed; carries forward the prior survey's risk list, updated for #71)

1. **No app-user OCC today.** `direct_entry_app_users` has no `version`, no `updated_at`, no per-account revision, no per-account audit. Concurrent status, grant and link work cannot safely share a stale client snapshot until W03A lands. **W03A schema delta is the minimum required.**
2. **Bootstrap is privileged operational code, not lifecycle API.** `scripts/p3-first-owner-bootstrap.mjs` and `scripts/p2-5-accounting-project-admin-provision.mjs` are operator scripts, not runtime lifecycle endpoints. The W01A lane notes the bootstrap is "not lifecycle API"; W03A–E will not turn these scripts into a general lifecycle path. Their post-bootstrap restriction is a separate, explicitly-reviewed decision; W03 does not assume one.
3. **Legacy Accounting grant.** The provisioning script still grants `entry_admin@all` to support existing project operations. W03 must deny its use for security administration without breaking catalog / project behavior; the Accounting transition (grant `catalog_master_manage@all`, verify, revoke legacy `entry_admin@all`) belongs to the controlled W02 transition, not to W03.
4. **W05A seed is not lifecycle.** It derives scope from `personnel_position`, hard-codes seven leaders and grants no `team_manager_assign`. It ran as a one-time seed. W01D has **revoked its `EXECUTE` from every role**; the W01D self-check asserts the revoke; W03A–E will not rerun the seed. W03D's audit-projection lane must assert the seed is revoked.
5. **Audit RPC is too broad for a browser contract.** Existing `direct_entry_read_audit` returns a raw row set that includes `auth_subject` and other internal references. W03D's `direct_entry_read_security_audit` is the bounded, mode-aware replacement; the raw RPC remains a service-role internal helper.
6. **Marker support is asymmetric and the GUC is the only on-ramp.** Membership markers were introduced by #70 for cancellation; capability / scope markers were widened by #71 §1; link markers will be widened by W03C. The transaction-local `direct_entry.team_leader_marker` GUC is the only mechanism that turns the marker trigger off. W03 must not introduce a second mechanism.
7. **Link cardinality is not fully constrained today.** Overlap is per `app_user_id / recruiter_id / valid_from`; multiple verified links can exist. W03C must add the per-`(app_user_id)` partial verified-effective unique index; until W03C lands, the W01D designate write still uses `count(*) = 1` as a runtime check, but the schema is permissive.
8. **PII / account identification remains bounded.** The exact account-list fields needed to let an Admin identify an existing login are not locked here. The W03 design will not expose `auth.users.email`; the smallest Owner-approved identifier (e.g., the app user `display_name` + `app_user_id`) is the only identification surface, and the W03D audit projection strips `auth_subject`.
9. **No migration numbers or Production facts are assigned here.** Migration-slot boundary is "start at #72, do not reserve a fixed second number". Row counts, actual Accounting holders, `entry_restore` holders, mapping anomalies and audit integrity are unknown until the W03F / J01 preflight runs.

### I.2 Blockers (R1 restated)

- T0 must accept the W01D #71 surface as final (it is on `main` at `1189c8a`).
- W03A cannot land before the W01A capability contract is at `direct-entry-auth/1.3` (it is) and before the W01D marker trigger is in place (it is).
- W03B cannot land before the W01D `direct_entry_team_leader_marker()` trigger is installed on `direct_entry_capability_grants` and `direct_entry_scope_grants` (it is).
- W03C cannot land before the W01D designate write is the only writer of leader-bundle rows (it is) and before the W01D leader-read path is locked to the persisted-FK join (it is, per the W01D A2 server contract survey R4–R5).
- W03D cannot land before the W03A–C audit vocabulary is stable.
- W03E cannot land before the W01A `REQUIRED_SCOPE_KIND` map is at `entry_restore = undefined` and the contract is at `1.3`; W03E bumps to `1.4` and updates the map.
- W03F / J01 is the combined regression and readiness audit, run after T0 accepts W03A–E.

### I.3 P3.2 boundary (explicit, locked)

The following are **out of P3.1** and **out of W03**:

- Invitation workflow (email, link, code, expiry).
- Initial password / forced reset / self-service password change.
- MFA enrolment, challenge, recovery codes.
- Account recovery (lost-password, locked-out, deleted-account re-creation).
- The `auth.users.email` change workflow (it lives in Supabase Auth, not in Direct Entry).
- A "default password" of any kind (no `hrp@123` or any other shared default; W03 has no password surface at all).
- A new RBAC framework, a new ORM, a new generic CRUD engine, a parallel audit system.

The W03 design is a **read-only rebaseline** of the access/security surface that already exists on `main` at `1189c8a`. It does not invent a new auth system; it does not open a new invitation path; it does not change the Supabase Auth boundary; it does not add a PII export beyond the W01A `pii_view` / `pii_export` capabilities.

## 9. Boundary

Read-only survey. No source, migration, `package.json`, dependency, `docs/P3.1.md` or other code change. No Production query/apply/deploy, no browser/Playwright/CUA/UAT. Worktree is clean; the only tracked change for this survey is the single documentation file at `docs/handoffs/p3-1-w03-s0-r1-access-security-rebaseline.md`. Migrations start at **#72** for W03A; no fixed second migration number is reserved. The W01D #71 surface is final on `main` at `1189c8a`; W03A–E reuse the W01D primitives (marker trigger, transaction-local GUC, partial marker-excluding indexes, atomic leader bundle, lock order) and do not introduce a parallel mechanism. The four mandatory post-#71 corrections (marker semantics, lock/atomicity, leader-bundle ownership, authority distinctions) are locked and are the contract every W03 implementation must respect. P3.2 owns invitations, initial passwords, forced resets, MFA and account recovery; W03 has no password surface.
