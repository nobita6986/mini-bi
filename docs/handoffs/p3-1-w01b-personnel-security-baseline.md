# P3.1-W01B-S0 — Personnel backend security and review baseline

> Status: `P3_1_W01B_S0_R1_SECURITY_REVIEW_BASELINE_PASS_AWAITING_T0`
> Base: `origin/main@6e8c5c61f4d62c5dacd5699a202dd09cb28b6aff` — ledger 67 migrations, #67 = P3.1-W01A capability contract. Branch `audit/p3-1-w01b-personnel-security-baseline`, worktree `C:\CodeApp\BI-p3-1-w01b-security-baseline`.
> Purpose: read-only security/review baseline so T0 can review T1B's W01B personnel-catalog backend. No implementation, migration, RPC, API, runtime test, package script or dependency is written here — only this memo.
> Review object: T1B branch `feature/p3-1-w01b-personnel-catalog` (same base SHA). Uncommitted working files are deliberately not audited here; this memo fixes the contract they are measured against.
> Inputs: `docs/P3.1.md`, `docs/handoffs/p3-1-c01-catalog-policy-survey.md`, `docs/handoffs/p3-1-j00-security-regression-baseline.md`, `docs/handoffs/p3-1-w01a-capability-contract-foundation.md`, `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`, and the migrations/RPC/tests at this base.

## 1. Evidence hiện tại

| # | Evidence (file:symbol:line) | Fact that binds W01B |
|---|---|---|
| E1 | `20261002170000_p1_6_direct_entry_foundation.sql:12-18` `public.recruiters` | Identity row: `recruiter_id` uuid PK (server-generated), `display_name` 1-256 btrim, `active` default true, `version` int default 1 `check (version >= 1)`, `created_at`. **No `updated_at`, no version trigger** — OCC must be explicit in the RPC. |
| E2 | `20261008000000_p3_w07a_catalog_bootstrap_personnel.sql:69-77` | `personnel_code text` **nullable**, btrim 1-64; `personnel_position text` **nullable**, `in ('STAFF','TEAM_LEADER')`; partial unique index on `lower(recruitment_dimension_key(personnel_code)) where personnel_code is not null`. Legacy NULL rows stay valid; only one normalized code may exist. |
| E3 | `foundation.sql:40-49` + `W07A:84-85` | `recruiter_provider_memberships`: `provider_type in ('hrp','vendor')`, `valid_from`/`valid_to`, `unique (recruiter_id, valid_from)`, `check (valid_to is null or valid_to > valid_from)`, nullable `vendor_id` FK to `vendors`. |
| E4 | `foundation.sql:51-60` | `recruiter_team_memberships`: half-open interval, `unique (recruiter_id, valid_from)`. Zero memberships is a legal state; nothing in the table forces one team. |
| E5 | `foundation.sql:463-558` `direct_entry_guard_effective_interval()` + 5 triggers | Overlap on the same key is rejected (`'effective interval overlaps an existing grant or membership'`) under a per-key `pg_advisory_xact_lock` for provider memberships, team memberships, scope grants, capability grants and recruiter links. Interval safety is already enforced in the DB, not by the RPC. |
| E6 | `foundation.sql:62-72` `direct_entry_app_user_recruiter_links` | Account identity is a **separate** link row (`verified`, half-open interval). A personnel record does not imply an account, and link mutation is W03 — not W01B. |
| E7 | `20261009030000_p3_1_w01a_capability_contract_foundation.sql:22-51` | The single canonical capability CHECK is now **23 tokens** and includes `catalog_master_manage` and `team_manager_assign`; unknown tokens stay **23514**. #67 added **no** guard, no helper, no grant. `direct_entry_scope_grants` (`foundation.sql:91-106`) carries `scope_kind in ('own','team','all')` with `(scope_kind = 'team') = (team_id is not null)`. |
| E8 | `foundation.sql:784-815` `direct_entry_assert_actor(auth, app, capability)` | Denies with **42501** when (a) no enabled app user matches **both** `app_user_id` and `auth_subject` (`'actor mapping denied'`), or (b) no capability grant is effective on `direct_entry_authorization_date()` (`'capability denied'`). It evaluates **no scope**. A guard that only calls this is scope-blind. |
| E9 | `20261008110000_p2_5_w02_...sql:394-419` `direct_entry_assert_project_admin` | Today's only catalog-style guard: `assert_actor(...,'entry_admin')` **plus** an effective `all` scope. Revoked from every role. It has **12 call sites** across 4 migrations (W02:573,669,824,967,1025,1103,1198,1295; `W06A:25`; `HF-R5:400`; `HF-R1:151`; `HF-R2:265`) — repointing it is a cross-wave change, not a W01B one. |
| E10 | `20261005030000_...change_policy_closure.sql:39-62` `direct_entry_has_capability(app_user, capability)` | Read-only helper: enabled app user **and** effective capability. Still no scope. |
| E11 | `foundation.sql:1036-1056` `direct_entry_reason(app_user, reason)`; `:1183-1190` `direct_entry_payload_hash`; `:1192+` `direct_entry_contains_authority` | Every mutation stores reason text (btrim 1-4000) in `direct_entry_restricted_reasons`, hashes the canonical payload with sha256, and can detect authority-shaped keys inside a payload. |
| E12 | `foundation.sql:817-871` idempotency begin/finish | `unique (app_user_id, action, idempotency_key)`. Replay with the same key returns the **stored result**; the same key with a **different request hash raises 22023** before any mutation; `finish` raises 55000 if the record vanished. All of it runs inside the caller's transaction. |
| E13 | `foundation.sql:417-447` `direct_entry_audit_events` | Actor/time/action/capability/`resource_ref`/`scope_kind`/`scope_team_id`/outcome/`reason_id` (never reason text)/`changed_fields` (<=64)/revision FKs. `W02:154-156` added `project_revision_id`. Audit rows link to the revision they produced. |
| E14 | Revision tables: `foundation.sql:349,361,405` (entry/submission/change-request) + `W02:122-149` (project) | Every catalog-shaped entity has an append-only revision table with `unique (entity, version)`, an immutable-change trigger and **never-backfilled** history. `W02:116-120` fixes the one-shape snapshot rule. No personnel revision table exists. |
| E15 | `foundation.sql:3222-3248`; `:3250-3295`; `:3296-3312` | Every Direct Entry table is `enable` + **`force row level security`** and revoked from `public, anon, authenticated, service_role`; every internal helper is revoked from **all** four roles; only reviewed RPCs keep `grant execute ... to service_role`. |
| E16 | grep over `supabase/migrations`: no `direct_entry_*personnel*` / `*recruiter*` lifecycle RPC | **No personnel create/update/deactivate RPC exists today.** The only personnel write site is the P1.6 bootstrap boundary (`20261005050000_...:402-413`: insert recruiter, team membership, provider membership) — an importer path, not an administration contract. |
| E17 | `W07A:139-179` `direct_entry_input_catalog` | Direct Entry eligibility requires **exactly one** effective HRP provider membership **and exactly one** effective team membership **and an active team**. A personnel row with zero memberships is **excluded there by design** — that projection must not be reused as the admin personnel list. |
| E18 | `20261008080000_p3_w05a_...sql:649-720` `direct_entry_seed_team_scope_grants()` | Release-time, fail-closed seed that **derives** `team` scope from `personnel_position='TEAM_LEADER'` + exactly one verified link + exactly one membership, and refuses any leader count other than 7. It is a seed, not a runtime authority path, and W01B must neither call nor alter it. |
| E19 | `src/lib/direct-entry/project-admin-api.ts:67-127`; `src/app/api/direct-entry/projects/route.ts:14-34` | The reusable API pipeline: feature gate -> same-origin/CSRF -> bounded JSON -> `validateClientBusinessPayload` (client cannot send actor/capability/scope/role) -> strict projection -> **actor resolved from the server session only** (`:94-117`) -> RPC -> sanitized error taxonomy (never a raw DB message). |
| E20 | `scripts/lib/direct-entry-inventory.mjs:7-31`; **19** test files assert `names.length === 67` (`p2-5-w02-multi-manager-authority-db.test.mjs:81`, `p2-5-w02-r1-...:59`, `p2-5-hf-worker-create-rehire-...:58`, `p3-w07b-project-manager-scope.test.mjs:29`, ...) plus **33** positional guards (`names.length - N`, `names.at(-N)`) in **14** files | The inventory helper only recognises `create ... function public.direct_entry_*`, `drop function`, and `rename to direct_entry_*`. A function declared any other way is invisible to the parity test, and #68 forces a mechanical rebaseline of the ledger guards. |
| E21 | `scripts/p2-5-w02-multi-manager-authority-db.test.mjs:21-86` (PGlite harness, `AUTH_PROLOGUE`, `migratedDb`) and 89 denial assertions across 20 DB suites | The reuse path for W01B tests is the existing PGlite + migration-ledger harness; no new fixture framework is needed or allowed. |

## 2. Exact authority matrix (A)

Personnel catalog = create / update / deactivate / read of `recruiters` plus its single HRP provider membership. Predicates are evaluated **inside the RPC** on server-resolved values only.

| Actor / predicate state | Read | Create / update / deactivate |
|---|---|---|
| Full Admin: `entry_admin` **AND** `recruiter_master_manage` **AND** `team_master_manage`, each effective at `all`, enabled mapping | allow | allow |
| Catalog operator (Accounting): `catalog_master_manage` effective at **`all`** | allow | allow |
| `entry_admin` at `all` **alone** (no `catalog_master_manage`) | **deny 42501** | **deny 42501** |
| `catalog_master_manage` holding only `own` or `team` scope (or no scope row) | **deny 42501** | **deny 42501** |
| `catalog_master_manage` at `team` scope for a specific team | **deny 42501** | **deny 42501** |
| Team leader (`team_manager_assign` + effective `team` scope) | deny (leader personnel read is W02/W04, own-team only) | **deny 42501** |
| Project manager (assignment-derived authority) | deny | deny |
| Ordinary staff (no catalog token) | deny | deny |
| Disabled app user **that still holds** the grants | deny (E8 checks `enabled`) | deny |
| Unmapped / mismatched `auth_subject` vs `app_user_id` | deny (`actor mapping denied`) | deny |
| Ambiguous identity (more than one verified effective link for the actor) | deny | deny |
| Client-supplied `actor`/`app_user_id`/`auth_subject`/`capability`/`scope`/`role` anywhere in the body | `400 CLIENT_AUTHORITY_FIELD_FORBIDDEN` (E19) | same |
| `personnel_position='TEAM_LEADER'` | **grants nothing** (E2 display attribute) | grants nothing |
| Role name / email / email suffix / environment fallback | must not be read — grep over `src/lib/auth` finds no role-based predicate | must not be read |

Ambiguity is already fail-closed in the session resolver: `src/lib/auth/direct-entry-v2.ts:309,323` returns `{ kind: "ambiguous" }` and `:370,380-381` reject with `AMBIGUOUS_TEAM_MEMBERSHIP` / `AMBIGUOUS_RECRUITER_LINK`, so no RPC-level ambiguity rule needs inventing — W01B only has to keep denying it.

Both deny rows above are non-negotiable: `entry_admin@all` alone is the **Accounting** state being retired, and a catalog token without effective `all` is a scope-escalation attempt. Neither may be satisfied by widening the other.

## 3. Data lifecycle / invariants (B)

| Invariant | Required behaviour | Anchor |
|---|---|---|
| `personnel_code` mandatory for new rows | Enforced by the create RPC (btrim 1-64, normalized-unique). The **column stays nullable** so legacy NULL rows remain readable — a table `NOT NULL` would fail against live data. | E2 |
| `personnel_code` uniqueness | Must reuse the same normalization as the partial unique index; a duplicate raises 23505 and leaves no residue. | E2 |
| Create contract | `expected_version = 0` for create (no OCC on a non-existent row); every update requires `expected_version >= 1` and the current version, mismatch -> **40001**. | task lock; E1 |
| Create writes exactly two **business/data rows** | One `recruiters` row **and** one `recruiter_provider_memberships` row with `provider_type='hrp'`, an **explicit** `valid_from` (never a DB default), `valid_to` NULL. The count is scoped to business/data rows only: the same transaction additionally writes the contract-mandated restricted-reason, idempotency, revision and audit rows, so the transaction's total row count is larger — that is expected and does not contradict this invariant. | E1/E3 |
| Zero account/team/grant residue | Create must not insert into `direct_entry_app_user_recruiter_links`, `recruiter_team_memberships`, `direct_entry_capability_grants` or `direct_entry_scope_grants`. | E4/E6/E7 |
| Unassigned personnel readable | Zero team memberships is valid and the row must appear in the admin catalog (the Direct Entry catalog excludes it — E17). | E4/E17 |
| `personnel_position` is display-only | Changing it to `TEAM_LEADER` creates no capability, no scope and no leader status; the W05A seed (E18) is not invoked. | E2/E18 |
| Update is field-scoped | `direct_entry_update_personnel` may change **only** `display_name`, `personnel_code` and `personnel_position`; `active` must never appear in its payload or its mutation surface. `recruiter_id` is immutable and the original HRP membership row is never updated, closed or re-dated by a personnel update. | E1/E3 |
| `active` has a dedicated mutation path | `active` changes **only** through `direct_entry_set_personnel_active` (API `/active`), which carries the same reason + `expected_version` + idempotency + revision + audit contract as every other mutation. No generic update may reach it. | E1/E3/E15 |
| Deactivation never deletes | Deactivate sets `active = false` through the dedicated set-active path only, and must not close or delete the HRP membership history. No hard delete exists or may be added: FKs are `on delete restrict` (5 references to `recruiters`, `foundation.sql:31,42,53,65,217`) and the tables are force-RLS with no DML grant (E15). | E1/E3/E15 |
| Membership intervals stay DB-guarded | Any membership row written by W01B remains subject to the non-overlap trigger; W01B must not disable or bypass it. | E5 |

## 4. Mutation atomicity and audit requirements (C)

| Requirement | Evidence / rule | Anchor |
|---|---|---|
| Reason + OCC + idempotency + revision + audit happen in **one** transaction | One `security definer` plpgsql function = one transaction; the reference implementation is `direct_entry_create_project` (`W02:1068-1153`): validate -> guard -> idempotency begin -> mutate -> revision -> audit -> idempotency finish. | E12/E14 |
| Reason is stored, not echoed | `direct_entry_reason()` (E11); audit carries `reason_id` only (E13). Reason text must never appear in a projection or an error message. | E11/E13 |
| Replay semantics | Same key + same payload hash -> return the stored result verbatim, no second mutation. Same key + different payload -> **22023 before any mutation**. | E12 |
| Failure residue = zero | A failure at reason, revision, audit or idempotency must roll back the entity row, the membership row, the reason row, the revision row, the audit row **and** the idempotency key row (all inside the same transaction). | E12 |
| Revision contract | Before/after snapshots are **bounded catalog snapshots** (identity, display name, personnel code, position, active, version) and version-stamped by the writer, following `direct_entry_project_snapshot` (`W02:464-483`) and `direct_entry_bump_project_version` (`W02:517+`); `unique (entity, version)`; immutable trigger; never backfilled. | E14 |
| Audit content — one row per mutation, bound to the acting path | Every personnel mutation writes exactly one audit row whose authority columns are determined by the path that authorised it: **Full Admin** -> `capability='entry_admin'`, `scope_kind='all'`, `scope_team_id IS NULL`; **catalog operator** -> `capability='catalog_master_manage'`, `scope_kind='all'`, `scope_team_id IS NULL`. Both paths also carry `action`, `outcome`, `reason_id`, `changed_fields` and the revision FK. A row carrying the other path's capability is a defect (mislabeled authority or swapped path), and no third label such as a scope-specific value may be invented. | E9/E13 |
| Snapshot must not leak | No `auth_subject`, no email, no `app_user_id`, no grant rows, no raw reason text, no raw DB error inside before/after snapshots or `changed_fields`. | E11/E13 |

## 5. Required API / DB projections (D)

| Surface | Contract |
|---|---|
| DB list RPC | One service-role `security definer` function declared as `create or replace function public.direct_entry_...` (E20 naming), `set search_path = pg_catalog, public`, `revoke all ... from public, anon, authenticated, service_role` then `grant execute ... to service_role` only (E15). Bounded list: hard `limit` (existing precedents: `limit 100` in `W06A:51` and `p_limit not between 1 and 500` in `foundation.sql:3206`), deterministic `order by`, search over `display_name`/`personnel_code` with a length-bounded search string (<=256 as in `project-admin-api.ts:26`), filter by `active`, `personnel_position` and assigned/unassigned state. |
| DB detail RPC | Same guard; returns the bounded entity snapshot plus the effective HRP membership summary and team-assignment state. Read-only: no grants, no links, no audit internals. |
| Mutation surfaces | Personnel has two distinct mutation surfaces and neither may serve the other's fields: `direct_entry_update_personnel` (only `display_name`, `personnel_code`, `personnel_position`) and `direct_entry_set_personnel_active` (only `active`), exposed through the personnel route and the `/active` route respectively. Both require reason + `expected_version` + idempotency and both write revision + audit. |
| Mutation result | Entity id + new `version` + `revision_id` + created/updated discriminator, mirroring `W02:1141-1148`. |
| Forbidden in every projection | `auth_subject`, email, `app_user_id`, link ids, capability/scope grant rows, raw reason text, raw database message (E19 taxonomy: `..._DENIED` 403, `..._NOT_FOUND` 404, `..._CONFLICT` 409, `..._INVALID` 400, `..._UNAVAILABLE` 500). |
| Browser route | Feature-gated (`DIRECT_ENTRY_API_ENABLED`), same-origin for mutations, bounded JSON, authority scan, and the actor **only** from `getDirectEntryActor` — never from body or header (E19). |
| RLS/grants re-assertion | The migration must re-assert forced RLS, the revoke-all on new/related tables and the `service_role`-only execute grant, in the style already used by `W07A:335-356` (`prosecdef`, `proconfig`, `has_function_privilege`). |
| No second framework | Reuse `direct_entry_reason`, `direct_entry_rpc_idempotency`, `direct_entry_audit_events`, the revision pattern and the existing contract/Zod idioms. No new RBAC, CRUD generator, audit framework, ORM or dependency. |

## 6. Allowed / denied test matrix

| # | Case | Expected |
|---|---|---|
| T1 | Full Admin (triple + `all`) creates personnel | APPLIED; version 1; one recruiter + one HRP membership; revision + audit rows |
| T2 | Catalog operator (`catalog_master_manage@all`) creates personnel | APPLIED, identical shape to T1 |
| T3 | `entry_admin@all` only | 42501, zero residue |
| T4 | `catalog_master_manage` with `own` / `team` scope only | 42501, zero residue |
| T5 | Disabled app user still holding `catalog_master_manage@all` | 42501 |
| T6 | Unmapped `auth_subject`/`app_user_id` pair | 42501 `actor mapping denied` |
| T7 | Leader / PM / staff / ambiguous identity | 42501 |
| T8 | Client body contains actor/capability/scope/role (any depth) | 400 `CLIENT_AUTHORITY_FIELD_FORBIDDEN`, no RPC call |
| T9 | Missing/empty/oversized reason | 22023, zero residue |
| T10 | Stale `expected_version` on update or on set-active | 40001, row unchanged |
| T11 | Create with `expected_version <> 0` | rejected before mutation |
| T12 | Same key + same payload replay | identical stored result, no second entity/revision/audit row |
| T13 | Same key + different payload | 22023 **before** mutation; entity count unchanged |
| T14 | Failure after the entity insert (reason/revision/audit path) | full rollback: entity, membership, reason, revision, audit, idempotency rows all absent |
| T15 | Duplicate normalized `personnel_code` | 23505, zero residue |
| T16 | Update `display_name` / `personnel_code` / `personnel_position` | version +1 per mutation; `active` unchanged; HRP membership `valid_from`/`valid_to` unchanged; identity unchanged |
| T17 | Position changed to `TEAM_LEADER` | no capability grant, no scope grant, no link, no leader status |
| T18 | Deactivate through `direct_entry_set_personnel_active` (API `/active`) | `active=false`; version +1; membership history intact; row still readable in the admin catalog; no delete |
| T19 | Unassigned personnel (zero team memberships) | present in the admin catalog list; absent from `direct_entry_input_catalog` (E17) |
| T20 | Legacy row with `personnel_code IS NULL` | readable and updatable-to-canonical without violating the partial index |
| T21 | Anonymous / authenticated role calls the RPC directly | permission denied (`anon`/`authenticated` never hold EXECUTE) |
| T22 | Any projection response | contains none of: `auth_subject`, email, `app_user_id`, grant rows, reason text, raw DB message |
| T23 | Generic update payload carries `active`, or the update RPC is asked to change it | rejected before mutation (400 / 22023); `active` and `version` unchanged |

## 7. Mutation-check matrix (making green assertions go red)

Each row must be demonstrated by temporarily breaking the source, observing the named assertion turn red, and reverting byte-identical (the W01A convention).

| Assertion that can be falsely green | Why it passes without the property | Mutation that must turn it red |
|---|---|---|
| "Denied for the wrong actor" | A suite that only grants the **correct** token never exercises the deny path; a guard with no scope check still passes T1/T2. | Add an `entry_admin@all`-only actor (T3) and a `catalog_master_manage@team`-scope actor (T4); remove the scope clause from the guard -> T4 must fail. |
| "Reason required" | Reason can be validated at the API layer while the RPC accepts NULL/blank. | Call the RPC directly with a blank reason (bypassing the API) and require 22023. |
| "Idempotent replay" | Asserting only "no second row" passes even when the replay returns a different payload or re-runs side effects. | Assert byte-equality with the first result; mutate the stored result once and require the equality assertion to fail. |
| "Conflict before mutation" | Asserting only that 22023 is raised passes even if the mutation already ran. | Assert entity/revision/audit counts are unchanged after T13. |
| "Zero residue on failure" | Asserting only the raised SQLSTATE passes when rows persist. | Count every affected table before/after a forced mid-transaction failure (T14). |
| "Audit authority recorded" | Asserting `outcome='APPLIED'` passes while `capability`/`scope_kind` are wrong, and a single-actor test cannot detect a **swap** between the two authority paths (both are `all` scope, so a swapped label still looks plausible). | Run the **same** mutation once as Full Admin and once as the catalog operator; assert row A has `capability='entry_admin'` and row B has `capability='catalog_master_manage'`, both with `scope_kind='all'` and `scope_team_id IS NULL`. Then swap the two literals in the RPC (or write one path's capability for the other) -> the assertion must fail for exactly one of the two rows. |
| "OCC enforced" | A no-op update returns success without incrementing the version, so a stale-version test can still pass once. | Assert version increments by exactly 1 per mutation and that the immediately repeated same-version call fails 40001 (T10/T16). |
| "Unassigned personnel listed" | A suite that always seeds a team membership never covers the unassigned case. | Call the admin list with the membership removed (T19); if the list reuses `direct_entry_input_catalog`, the row disappears and the test must fail. |
| "No PII leak" | A projection test asserting a few expected keys passes while extra keys ride along. | Assert the **exact** key set of the response (no superset) and scan the serialized response for `auth_subject`/`app_user_id`/`reason_text`. |
| "Function declared / inventory parity" | `expectedDirectEntryFunctions` (E20) only sees `create ... function public.direct_entry_*`; a function created via dynamic `execute format(...)` or another prefix is invisible, so a parity test stays green while an undeclared service-role function exists. | Assert the live catalog matches `expectedDirectEntryFunctions` **and** that each new name matches `direct_entry_[a-z0-9_]+`; rename one function to a non-matching prefix -> the parity assertion must fail. |
| "Search bounded" | `W06A:45-51` concatenates `p_search` into an `ILIKE` pattern without escaping the `%` and `_` wildcards; "search finds the row" passes regardless and a bare `%` matches everything (the hard `limit 100` is the only blast-radius cap). | Search for a literal `%` and require the escaped semantics the implementation claims; if W01B copies the pattern, record it as an inherited limitation rather than a new regression. |
| "Ledger guard" | After #68 any suite still asserting `names.length === 67` fails loudly — but a suite "fixed" by loosening the count to `>= 67` proves nothing. | Keep exact counts (`=== 68`) and verify the positional guards (`names.length - N`, `names.at(-N)`) still point at the intended migrations. |

## 8. T0 review checklist

- [ ] **#68 only**: the new migration is append-only, numbered #68, and contains **only** W01B personnel-catalog scope. #1-#67 byte-identical.
- [ ] **Boundary**: no team-membership mutation, no leader designate/revoke, no project/Vendor/labor-type change, no account/grant/link change, no UI, no Production grant transition, no `entry_restore`.
- [ ] **Guard**: W01B owns a **separate** catalog-operator predicate requiring `catalog_master_manage` **and** an effective `all` scope, revoked from every role (L2). #68 must not modify, extend or repoint `direct_entry_assert_project_admin` (E9, 12 call sites) — any change to that shared guard inside #68 is out of W01B scope and must be rejected.
- [ ] **Contract**: the 23-token capability CHECK untouched; both tokens already exist (E7); no token added or removed; contract version unchanged from `direct-entry-auth/1.3`.
- [ ] **Create**: `expected_version = 0`, exactly two business/data rows (one recruiter + one HRP membership with explicit `valid_from`) plus the contract-mandated reason/idempotency/revision/audit rows, and zero residue in links/team-memberships/capability-grants/scope-grants.
- [ ] **Update (field-scoped)**: `direct_entry_update_personnel` touches only `display_name`, `personnel_code` and `personnel_position`; `active` is absent from its payload and surface; identity and provider history immutable; `version` +1 per mutation with fail-closed OCC.
- [ ] **Set-active (separate path)**: `active` changes only through `direct_entry_set_personnel_active` / API `/active` with the same reason + `expected_version` + idempotency + revision + audit contract; no delete path added.
- [ ] **Integrity**: reason, OCC, idempotency (same-hash replay / different-hash 22023), revision and audit inside one transaction; failure leaves zero residue; snapshots bounded and free of auth/email/grant/reason data.
- [ ] **Projections**: service-role only, fixed `search_path`, forced RLS re-asserted, bounded list/search/paging, no PII, no raw DB message, response key set exact.
- [ ] **API**: route gated, same-origin for mutations, client authority fields rejected, actor from the server session only.
- [ ] **Tests**: the allowed/denied matrix (section 6) is present, the mutation checks (section 7) were demonstrated red-then-reverted, and the ledger-count/positional-guard sweep is exact (E20) — no lane removed, duplicated or silently unregistered.
- [ ] **Gates**: `git diff --check`, `pnpm docs:check`, `pnpm secrets:check`, focused lane green, and no new dependency.
- [ ] **Environment**: no Production query/apply, no deploy, no browser/Playwright/CUA/UAT (Owner-only). Status only after T0 review.

## 9. Risks / locked checkpoints

**Pre-existing limitations — not W01B defects, but they change what its tests can prove**

- P1: `recruiters` has no `updated_at` and no version trigger (E1) — OCC is entirely the RPC's responsibility, so a missing explicit increment is invisible to the schema.
- P2: `direct_entry_input_catalog` excludes unassigned personnel by design (E4/E17); reusing it as the admin list is the most likely silent functional regression in W01B.
- P3: the W05A team-scope seed derives authority from `personnel_position='TEAM_LEADER'` at release time and hard-codes seven leaders (E18); it is a seed, not runtime authority, and must not be re-run or re-purposed by W01B.
- P4: the W06A candidate search does not escape `%`/`_` (section 7) — if the personnel search copies that pattern, the limitation is inherited, bounded only by the hard `limit`.
- P5: 19 ledger-count assertions and 33 positional guards (E20) fail the moment #68 lands; the rebaseline is mechanical but must stay exact.

**Locked implementation checkpoints / review risks**

These six decisions are **locked**; they are not open questions. T0 uses them as the review criteria for T1B's W01B implementation.

- L1 — **Create contract is locked**: `expected_version = 0` is mandatory on create. This has no precedent in the existing migrations (`direct_entry_lock_project` requires `>= 1`, `W02:439-441`), so the checkpoint is that W01B implements it explicitly and rejects any other value (T11), not that the value is re-decided.
- L2 — **Guard placement is locked**: W01B creates its **own** catalog-operator guard (canonical predicate `catalog_master_manage` + effective `all` scope, revoked from every role). #68 must **not** modify, extend or repoint `direct_entry_assert_project_admin` (E9, 12 call sites across 4 migrations); the shared project guard stays untouched.
- L3 — **Personnel revision history is locked**: W01B has a dedicated, immutable personnel revision history with a bounded snapshot, `unique (entity, version)`, an immutable-change trigger and never-backfilled semantics (E14, `W02:116-120`). The checkpoint is that the implemented table and snapshot match that shape.
- L4 — **`personnel_code` nullability is locked**: the column stays **nullable** in the schema so legacy rows with NULL codes keep reading (E2 and the W07A bootstrap path), while the create contract makes it **mandatory for every new row**. No `NOT NULL` enforcement may be added.
- L5 — **Admin list/get projection is locked as a separate bounded contract**: it must read **unassigned** personnel and must **not** reuse `direct_entry_input_catalog` (E17), which is eligibility-shaped. Bounded search/paging/filter per section 5.
- L6 — **Scope boundary is locked**: W01B contains **no** team-membership mutation, **no** leader lifecycle, **no** project, Vendor or labor-type change, and **no** Accounting Production grant transition.

**Conclusion:** within the scope of this memo there is **no open blocker and no open decision**. Every item above is a locked criterion for reviewing T1B's implementation; the risks that remain are the pre-existing limitations P1-P5, which are properties of the current schema and harness rather than unresolved W01B questions. No separate T0 decision is required before the review.

## Boundary

Read-only survey: no implementation, migration, RPC, API, runtime test, package script, dependency, Production query/apply or deploy. No Production mutation, no grant transition, no browser/Playwright/CUA/UAT (Owner-only). #1-#67 untouched. No PII, email, user UUID, credential or raw database error was read or printed in this memo. Only this file is written.
