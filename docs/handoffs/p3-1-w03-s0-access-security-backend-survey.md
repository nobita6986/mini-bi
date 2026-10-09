# P3.1-W03-S0 — Existing user, grant, recruiter-link, audit and restore security/backend survey

> Status: `P3_1_W03_S0_ACCESS_SECURITY_SURVEY_PASS_AWAITING_T0`
> Evidence base: `origin/main@f9d77c690a8430c53248daf4b1ebd5216fdcd6bb`, 70 migrations; #70 is P3.1-W01C-B team membership.
> Read-only survey. No Production query/apply/deploy, browser/UAT, runtime implementation, migration-slot reservation, or evidence from another branch's uncommitted work.

## A. Current truth and evidence

| Surface | Current evidence and truth |
|---|---|
| Migration baseline | The isolated worktree is exactly the locked SHA above. The migration directory contains 70 SQL files; the last is `20261009060000_p3_1_w01c_b_team_membership.sql` (#70). W01D and all W03 behavior are absent from this base. |
| Existing application users | `20261002170000_p1_6_direct_entry_foundation.sql` creates `direct_entry_app_users(app_user_id, auth_subject, enabled, created_at)`. `auth_subject` is unique and FK-restricted to `auth.users`; `enabled` is boolean/default true. `20261008220000_p2_5_hf_session_identity_header.sql` adds canonical, non-null `display_name`. There is **no account `version`/OCC column**. |
| Enable/disable | No account-management RPC, API, or UI mutates `enabled`. The first-owner bootstrap script can insert the initial user and set an existing bootstrap user back to `enabled=true` while repairing its bootstrap bundle; it is a guarded operator script, not a general lifecycle endpoint. Its existing-user apply path does not write an account revision/audit event. No supported disable/offboarding mutation exists. Personnel `recruiters.active` is a separate catalog state and must not be confused with app-user `enabled`. |
| App-user ↔ recruiter links | The foundation table stores `app_user_id`, `recruiter_id`, `verified`, `[valid_from, valid_to)`, and `created_at`; FK deletes are restricted. It has `UNIQUE(app_user_id, recruiter_id, valid_from)`, strict `valid_to IS NULL OR valid_to > valid_from`, and a per-pair no-overlap trigger/advisory lock. It does **not** enforce one verified link per app user across different recruiters, nor one app user per recruiter. Session/leader consumers must fail closed on ambiguous effective verified links. No runtime link lifecycle RPC/API/UI exists. |
| Capability grants | The foundation has a 21-token closed CHECK; migration #67 (`20261009030000_p3_1_w01a_capability_contract_foundation.sql`) expands it to exactly 23, including `catalog_master_manage` and `team_manager_assign`. Capability intervals are strict (`valid_to > valid_from` when closed), unique by `(app_user_id, capability, valid_from)`, and guarded against overlap for that user/capability. No `version`, `updated_at`, or zero-length marker semantics exist for this table. |
| Scope grants | The foundation restricts `scope_kind` to `own/team/all`; exactly `team` scope has a non-null `team_id`. Intervals are strict and overlap-guarded per `(app_user_id, scope_kind, team_id)`; there is a start uniqueness index. Vendor-system-team scope is rejected by later triggers. Scope rows have no `version` and cannot be zero-length markers. |
| Marker distinction | #70 changes **only** recruiter team membership to allow `valid_to = valid_from` as an inert cancellation marker, excludes markers from effective membership and from the partial start-uniqueness index, and blocks raw marker DML outside the audited RPC path. Capability and scope CHECKs are explicitly still strict. Link intervals are also strict. Do not infer marker support for grants/scopes/links from membership behavior. |
| Current guards and writes | `direct_entry_assert_actor` checks the enabled `(auth_subject, app_user_id)` mapping and an effective capability; it does not check scope. `direct_entry_assert_catalog_operator` (#68) checks either the full-Admin triple or `catalog_master_manage`, plus effective `all` scope, and returns the authority used. Helpers are revoked from every role. W05A's `direct_entry_seed_team_scope_grants()` is the only existing SQL seed that writes scope grants; it is a migration/release seed, derives from `personnel_position='TEAM_LEADER'`, expects exactly seven qualifying leaders, and is executable by `service_role` only. It creates scope only, no capability. There is no runtime RPC to grant/revoke capability, scope, app-user status, or recruiter links. |
| Operational grant scripts | `scripts/p3-first-owner-bootstrap.mjs` is an explicit guarded bootstrap path: it validates the auth user, may create/enable the app-user row, grants the full capability registry and `own` + `all` scopes, and does not add an audit event. `scripts/p2-5-accounting-project-admin-provision.mjs` can directly add `entry_admin` to the existing Accounting reviewer bundle with an `all` scope prerequisite and a restricted reason/audit row in a transaction. That script has no runtime RPC/API semantics or general OCC/revision contract; its current `entry_admin@all` grant is a known transition/preflight concern, not proof of production state. |
| Role/ACL | Direct Entry tables, including the account/link/capability/scope/reason/audit/idempotency tables, have forced RLS and revoke table DML from `public`, `anon`, `authenticated`, and `service_role`. Narrow `SECURITY DEFINER` RPCs use fixed search paths and are granted to `service_role` only; internal authorization/idempotency helpers remain revoked from all. The same pattern is in W01B/W01C catalog RPCs. The W05A scope seed and `direct_entry_read_audit` also grant EXECUTE only to `service_role`. |
| Audit storage | Foundation `direct_entry_audit_events` includes event/actor/auth subject, action, capability, resource, scope/team, outcome/denial code, `reason_id`, changed fields, existing revision references, and timestamp. W02 and W01B/W01C add revision foreign keys for project/personnel/team/team-membership changes. `reason_text` is stored separately in restricted reasons; audit stores a reason reference, not reason text. Audit UPDATE/DELETE is rejected by an immutable trigger; the table is forced-RLS/revoked like other Direct Entry tables. |
| Existing audit read | `direct_entry_read_audit(auth_subject, app_user_id, entry_id, limit)` is a `SECURITY DEFINER` service-role RPC, limit 1–500, guarded by `audit_view` and entry/resource access. It returns `SETOF direct_entry_audit_events` for one Direct Entry entry. It is **not** an Admin security-event explorer, has no `full/catalog/none` mode, and returns the raw table row shape to its trusted caller. No route/API or UI consumes it as a W03 projection. |
| `entry_restore` | The token exists in the 23-token registry and migration CHECK. `direct-entry-v2.ts` requires reason and expected version for the `entry_restore` action, but does not assign it a `REQUIRED_SCOPE_KIND`; no restore RPC, API, restoreable-item projection, page, or UI exists. First-owner bootstrap seeds every capability, including this token, but that does not create a usable restore path or prove any current holder. |
| Account/grant/link UI/API | No W03 `/api/admin/access/{accounts,grants,links,audit,restore}` handler or UI exists. Existing `/api/admin/catalog/personnel`, teams, and membership routes are catalog operations, not application-account administration. `UserSessionControl` is session identity, not an account-management surface. |
| Actor/session projection | `direct_entry_resolve_actor_context(auth_subject)` is service-role only and reads the live enabled account, current capability intervals, links, and scope data; its internal JSON includes fields such as `auth_subject` that the client projection strips. `getDirectEntryActor` uses Supabase `auth.getUser()` and then calls the actor repository on every resolution. Auth responses are `private, no-store`; client authority fields are rejected; page decisions are request-time server decisions. |
| Freshness/revocation | W08A is present and tests that a disabled actor or removed mapping is denied on the **next resolve**, with no in-memory cross-request actor cache, and that concurrent sessions do not cross. Any React/request-pass deduplication is request-scoped, not a persistent capability TTL. W08A is not a grant/account mutation implementation and does not serialize an in-flight W03 mutation against disable/revoke. New W03 RPCs must recheck database authority themselves. |
| Navigation/page predicates | Existing nav maps Direct Entry, project operations, worker operations and the full-Admin triple. Unknown predicates fail closed. There is no W03 account/audit/restore navigation or page predicate. Hiding navigation is not authorization; direct route/API/RPC calls need server guards. |

Key source files: `supabase/migrations/20261002170000_p1_6_direct_entry_foundation.sql`, migrations #67–#70, `20261008220000_p2_5_hf_session_identity_header.sql`, `20261008080000_p3_w05a_actor_scoped_reporting.sql`, `src/lib/auth/direct-entry-v2.ts`, `src/lib/direct-entry/actor-context-repository.ts`, `src/lib/auth/direct-entry-session-core.ts`, `src/lib/auth/p3-w08a-session-revocation-cache.test.mjs`, and `docs/handoffs/p3-w08a-session-revocation-cache-hardening.md`.

Relevant existing regression lanes include `scripts/p1.6-w03-db.test.mjs` (foundation actor/grant/scope/audit ACL and integrity, including the `direct_entry_read_audit` ACL), `scripts/p1.6-w04-s03a-db.test.mjs`, `scripts/p1.6-w04-s03cd-db.test.mjs`, `scripts/p1.6-w04-s04a-db.test.mjs`, and `scripts/p2-5-hf-r5-session-identity-db.test.mjs` (actor projection/identity), `scripts/p3-w05a-team-scope-seed.test.mjs` (seed/link/scope cases), `scripts/p3-first-owner-bootstrap.test.mjs`, `scripts/p2-5-accounting-project-admin-provision.test.mjs`, and `scripts/p3-1-w01a-capability-contract.test.mjs`. `src/lib/auth/direct-entry-v2.test.mjs` exercises the TypeScript `audit_view` and `entry_restore` reason/version contract; it is not a DB restore test. `src/lib/auth/auth-session-core.test.mjs`, `direct-entry-session-retry.test.mjs`, page-access tests and `p3-w08a-session-revocation-cache.test.mjs` cover session/page freshness. These lanes do not supply W03 account/grant/link/audit-explorer/restore endpoints.

## B. Existing data model and ACL

| Object | Current constraints/history | W03 implication |
|---|---|---|
| `direct_entry_app_users` | Unique auth mapping, enabled flag, canonical display name; `ON DELETE RESTRICT`; forced RLS; no version or status history. | Add a security aggregate version rather than treating client/session capability arrays as OCC state. Never hard-delete accounts. |
| `direct_entry_app_user_recruiter_links` | Verified flag and half-open effective intervals; unique start per same user/recruiter pair; overlap lock per pair; strict positive interval. | Preserve verification and link history; validate effective verified-link cardinality after each mutation. Different recruiter pairs can currently overlap. |
| `direct_entry_capability_grants` | Closed 23-token vocabulary; strict half-open interval and per-token overlap guard; no marker/version. | Grant only canonical tokens; never accept a client token or raw arbitrary string as authority. |
| `direct_entry_scope_grants` | `own/team/all`, team iff team id non-null; strict interval and per-scope-key overlap guard; no marker/version. | An authorization requires the exact capability **and** its required effective scope, evaluated for one server authorization date. |
| `direct_entry_restricted_reasons` | Restricted reason text row referenced by actor; table access revoked. | Reuse reason creation/reference; do not echo raw reason in responses, snapshots, or audit projections. |
| `direct_entry_rpc_idempotency` | Unique `(app_user_id, action, idempotency_key)`, request hash and result; table access revoked. Existing helpers return same-hash stored result and reject different-hash reuse with `22023`. | Reuse existing helpers, bind action/key/hash server-side, and keep key/result write in the mutation transaction. |
| `direct_entry_audit_events` | Append-only immutable event row with actor/action/authority/scope/outcome/reason reference/revision links. | Reuse; add only the minimal revision FK needed for app-user security mutations. Do not expose `SETOF` row data directly to the browser. |

## C. Missing runtime mutations and projections

The following do not exist at this base:

- Admin-only bounded account list/detail and app-user enable/disable endpoints/RPCs.
- Runtime capability/scope grant, revoke, and effective-interval history operations.
- Verified recruiter-link create/verify/unverify/revoke operations.
- Mode-scoped global audit projection (`full`, `catalog`, `none`) and API route.
- Restoreable-item list and `entry_restore` mutation.
- Account/grant/link-specific revision history and app-user version/OCC anchor.
- W03 server-side API/page gates and account/audit/restore UI.

Do not mistake any of these for an implementation: first-owner/accounting scripts are operator tooling; W05A is a seed; W01B/W01C catalog APIs concern recruiters/teams; `direct_entry_read_audit` reads one entry's audit under `audit_view`.

## D. Locked authority matrix

Authorization is resolved in the backend from the authenticated session and current database rows. No role-name, email/domain, `personnel_position`, client actor, supplied capability, or supplied scope may grant authority. Every protected operation requires an enabled exact actor mapping. The full-Admin predicate is the effective `entry_admin` + `recruiter_master_manage` + `team_master_manage` triple at effective `all` scope.

| Actor | Account status | Capability/scope grants | Verified recruiter links | Audit | `entry_restore` |
|---|---|---|---|---|---|
| Full Admin (enabled exact mapping + full-Admin triple at `all`) | Allow | Allow | Allow | `full`, bounded | Allow only with effective `entry_restore` + required `all` scope |
| Accounting/catalog operator (`catalog_master_manage@all`, but not full Admin) | Deny | Deny | Deny | `catalog` only: policy-approved catalog/worker events; no security events | Deny |
| Team leader (`team_manager_assign` + effective team scope) | Deny | Deny | Deny | No global explorer; own manager-assignment events stay in project operations only | Deny |
| Project manager / PM / ordinary staff | Deny | Deny | Deny | `none` | Deny |
| Disabled, unmapped, mismatched, or ambiguous actor | Fail closed | Fail closed | Fail closed | `none` | Fail closed |

The server returns only the authorized audit mode and its corresponding rows; it must not return `full` data and rely on UI filtering. All scopes are required wherever this matrix names `@all`; `team`/`own` never substitutes. Accounting's historical `entry_admin@all` provisioning is a known legacy state to measure and transition under its separately reviewed guard/provisioning work; do not infer the live population or change it in this survey.

## E. Proposed backend packages

No generic RBAC or CRUD framework. Packages use existing `direct_entry_reason`, `direct_entry_payload_hash`, `direct_entry_rpc_idempotency`, immutable audit, server session resolution, and service-role RPC patterns.

| Package | Reuse / minimum new objects | Aggregate, reason, idempotency, revision/audit | API shape, ACL, rollback | Lane / dependency |
|---|---|---|---|---|
| **W03A — account bounded list/get + enable/disable** | Reuse `direct_entry_app_users`, actor resolver, reason/idempotency/audit. Add `direct_entry_app_users.version` and one append-only security-revision table plus audit FK. | App user is root; expected-version OCC on the locked row. Reason + idempotency on enable/disable; exactly one version bump/revision/audit per applied status change. No-op/replay semantics explicit. | Server-only bounded list/detail and narrow status mutation API. Projection excludes auth subject/email and grant rows. `SECURITY DEFINER`, fixed search path; only RPCs executable by service role. Same transaction means failed reason/revision/audit/idempotency leaves no status/version residue. | `p3-1-w03a-account-db.test.mjs` + API/projection tests. First package; establishes version/revision foundation. |
| **W03B — capability/scope interval grant/revoke** | Reuse closed 23-token vocabulary, scope checks, overlap lock, reason/idempotency/audit. Add only audited cancellation-marker guards/check/index changes needed to preserve same-day/future revocation history; current CHECKs remain strict until this reviewed package. | App-user security aggregate/version from W03A, locked before grant rows. Expected aggregate version, one bump/revision/audit per intent. Never hard-delete committed grants. | Bounded, separate capability and scope list/mutation RPCs; exact token/scope/date allowlists. Service-role-only RPC ACL; exact projected fields. Transaction rollback removes marker/interval/reason/revision/audit/key residue. | `p3-1-w03b-grants-db.test.mjs`. Depends on A. W03 marker support must be audited-only; raw zero-length DML denied. |
| **W03C — verified recruiter-link lifecycle** | Reuse link table, effective-link resolver, per-pair overlap trigger, reason/idempotency/audit. Add audited inert marker semantics for same-day/future cancellation if needed; do not add another link directory. | Target app-user security aggregate/version, with deterministic locking of app user and recruiter/link keys. Check the post-state has no ambiguous effective verified link; record link revision/audit. | Bounded link list and verify/revoke/link mutation contract; do not return auth subjects or email. Service-role-only RPCs. One transaction; no delete or history rewrite. | `p3-1-w03c-recruiter-link-db.test.mjs`. Depends on A; can follow B if using shared revision version. |
| **W03D — mode-scoped bounded audit projection** | Reuse append-only audit, existing action/capability/scope/revision fields and W04 audience-projection pattern. Minimal new function(s); explicit server-side action classification with unknown/unclassified actions denied from `catalog` mode. | Read-only projection; no aggregate bump, reason mutation, or audit-on-read. Cursor/time range and stable event ordering. | One API route resolves mode server-side: `full` for Admin, `catalog` for catalog operator, `none` otherwise. Exact allowlisted/redacted response, page-size cap, no raw row return. Service-role RPC only. Read failure is sanitized, never successful empty data. | `p3-1-w03d-audit-projection.test.mjs`. Integrates after A–C event actions/classification are known. |
| **W03E — restoreable-item projection + `entry_restore`** | Reuse `direct_entries`, existing entry revisions/OCC/reason/idempotency/audit. No parallel snapshot store. Add only a minimal restore RPC/projection if no existing entry revision read helper fits. | Entry row/version is the OCC root. Require full Admin plus `entry_restore@all`, reason, expected entry version, and idempotency. Restore writes a new revision/audit event; never rewrites old revision/audit or hard-deletes. | Bounded restoreable-item list and server mutation; no raw snapshot/auth identity in projection. Service-role-only fixed-search-path RPCs. Failure rolls back entry, revision, audit, reason and key together. | `p3-1-w03e-entry-restore.test.mjs`. Depends on A and existing entry-revision contract; D must classify restore events before exposing them. |
| **W03F — combined security regression/session revocation** | Reuse W08A resolver/session tests, P1.6 foundation DB harness, W01A token parity and W03A–E endpoints. Add no auth framework. | Verify account-row lock/recheck linearizes all security mutations and fresh session projections; history remains immutable. | Cross-package/API/RPC/ACL test only; no new authority surface. Failed race is denied/conflict with zero residue; no stale client grant is trusted. | `p3-1-w03f-security-regression.test.mjs`; final integration gate after A–E. |

**API contract for every mutation:** authenticated actor comes only from `getDirectEntryActor`/server session; reject authority-shaped body fields; accept only the target id, business fields, bounded reason, expected version, interval inputs, and idempotency key required for that action. Return a fixed typed result and sanitized error code, never SQL text. Every list/read is hard-bounded, deterministically ordered and strictly projected.

**Service-role boundary:** keep table DML revoked even from service role; revoke function EXECUTE from `public`, `anon`, `authenticated`, and `service_role`, then grant only reviewed public RPCs to `service_role`. Helpers remain inaccessible. Every definer function uses a fixed `search_path`; API keys never reach a client.

## F. Transaction, OCC, idempotency and audit contract

1. Validate bounded input and reject client-supplied actor/role/capability/scope fields before RPC invocation. Resolve authenticated subject via Supabase `getUser`; do not trust cookie claims alone.
2. In one DB transaction, lock the actor and target app-user aggregate rows in a deterministic id order, then re-read enabled state, Full-Admin triple, exact required capability/scope and effective intervals. Rechecking after the lock is required; a pre-lock session projection is not authorization.
3. Call idempotency begin with a canonical request hash after authorization/locking. Same actor/action/key/hash returns the original result with no second side effect. Same key with different input fails `22023` before mutation. Replays after authority revocation are denied before stored results are returned.
4. Enforce `expected_version` against the locked aggregate. Stale writes fail with `40001`; each successful mutation increments its root exactly once. Use the existing reason helper, payload hash, idempotency helpers, revision pattern and audit table.
5. Write status/interval/restore change, version, immutable revision, audit row and idempotency result in that same transaction. Any exception leaves zero residue across every affected data/reason/revision/audit/idempotency row.
6. Audit stores the actual authority path and scope (`entry_admin@all` for Full Admin account/grant/link operations; `entry_restore@all` for restore; never a fabricated role). Audit rows store reason references, not raw reason text. Snapshots/changed fields are fixed-shape, minimal and exclude auth subject, email, grants, secrets and raw reason.
7. Historical rows are closed, never hard-deleted or rewritten. Grant/link same-day cancellation must use a W03-specific, audited-only inert marker if the package supports cancellation on its start date; raw marker insert/update must fail. Do not silently relax scope/capability/link constraints before the consuming RPC, marker guard and tests ship together.
8. Mutation response and replay are exact allowlisted shapes. Sanitize database exceptions into repository-standard error codes; never return raw database errors.

## G. Stale-session and revocation contract

- **Next request:** disabling an app user or revoking a grant/link makes it ineffective on the next session resolution and next mutation request. W08A already provides fresh `getUser` + live actor-repository resolution per request and tests disabled/missing actors on the next resolve.
- **Server decides:** capability arrays/scopes returned to the browser are display/navigation projections only. Every W03 RPC reloads enabled state and effective grants/scopes from the database; no client capability cache is authoritative.
- **No stale mutation:** all W03 mutation RPCs serialize on the same app-user aggregate lock and recheck enabled + authority after acquiring it. A disable/revoke that commits first causes the competing operation to fail closed; an operation serialized before disable may commit before disable, but no operation authorized under the old state may commit after the disable transaction. OCC/serialization conflict returns a sanitized conflict and leaves zero residue.
- **History:** preserve disabled user rows, closed grants, links, revisions and audit. Never hard-delete to invalidate a session.
- **W08A status:** exists and covers request freshness, no shared actor cache, disabled/missing mapping, no-store and concurrent actor isolation. It does **not** implement W03 mutations, account OCC, mutation-vs-disable locking, or a persistent revocation counter. No separate freshness window/TTL is established; request-time resolution is the current contract.

## H. Allowed/denied test matrix

All rows must be tested at DB RPC and HTTP/API boundaries where applicable. A hidden UI control is not a deny test.

| Case | Expected |
|---|---|
| Full Admin with exact enabled mapping, triple and effective `all` scope uses account/grant/scope/link operations | Allow; actual authority label is `entry_admin@all`; reason/OCC/idempotency/revision/audit present. |
| Accounting with `catalog_master_manage@all` uses catalog/worker audit projection | Catalog/worker projection only; no account/grant/scope/link mutation, security audit, or restore. |
| `entry_admin@all` alone, missing one Full-Admin triple token, missing all scope, or wrong scope kind | Deny; no mutation/residue. |
| Team leader, PM, ordinary staff, disabled actor, unmapped/mismatched subject, ambiguous verified link | Deny W03 security administration and global audit/restore; no data leakage. |
| Client forges actor/auth subject/app-user id, role, capability, scope, team id, or nested authority fields | HTTP rejects before RPC; direct RPC ignores no caller-controlled authority and denies mismatched server actor. |
| Full Admin supplies scope other than required `all`; client requests all-scope by payload | Deny. The authoritative scope must be an effective DB row, not request input. |
| Capability/scope/link future interval | No authority before `valid_from`; projection labels it scheduled only where explicitly allowed. |
| Expired capability/scope/link | No current authority after `valid_to`; history remains readable only through authorized bounded projections. |
| Zero-length cancellation marker | Effective on no date; allowed only through the reviewed audited mutation path; raw direct insert/update is rejected. Existing grant/scope/link strict checks remain closed until their marker package ships. |
| Duplicate start, overlap, ambiguous verified-link post-state, malformed scope/team pair | DB constraint/guard rejects; transaction leaves zero residue. |
| Enable/disable with current version | Exactly one version bump/revision/audit. Stale version fails `40001`; no-op/replay does not double bump. |
| Disable/revoke then resolve session or invoke protected RPC on next request | Denied immediately using current DB state; old client projection/token alone cannot authorize. |
| Concurrent disable/revoke and mutation | Serialized on aggregate lock; if disable/revoke commits first, mutation denies. No stale-authority commit after revocation; loser conflict has zero residue. |
| Audit `full` vs `catalog` vs `none` | Admin receives bounded full; catalog operator receives only approved catalog/worker events; leader has no global explorer; PM/staff receive none. |
| Audit response redaction | Exact response keys only; no `auth_subject`, unnecessary email, PII, raw reason, grant rows, credential/token, storage key or raw DB error. |
| Restore without full Admin, `entry_restore`, effective `all`, reason, expected version or idempotency key | Deny; entry unchanged. Valid restore adds a new revision/audit event. |
| Failure injected after any write (including audit/revision/idempotency) | Full transaction rollback: no status/grant/scope/link/entry, version, marker, reason, revision, audit or idempotency residue. |
| Same idempotency key and same request | Return byte-equivalent stored result; exactly one mutation/revision/audit. |
| Same idempotency key and different request | `22023` before writes; prior state and all counts unchanged. |
| Direct anonymous/authenticated table DML or RPC EXECUTE; unsafe search path | Denied; table privileges remain revoked, RLS forced, only intended RPCs service-role executable, definer `search_path` fixed. |
| Direct URL/API/RPC call to an account/grant/link/audit/restore operation without authority | Server denial even if nav is hidden or a valid route/id is guessed. |

## I. Mutation-check plan

Each assertion below must have a deliberate mutation that makes its focused test fail, followed by restoring the source byte-identically. This is planned for implementation lanes; no mutations are run in this survey.

| Security assertion | Required red-making mutation |
|---|---|
| Full Admin is a three-capability AND plus all scope | Remove one capability predicate or all-scope predicate; the missing-token/wrong-scope deny case must turn red. |
| Accounting cannot access security actions | Route the account/grant/link/restore guard through `catalog_master_manage`; Accounting-deny test must turn red. |
| Server-derived actor only | Accept a body `app_user_id`/capability/scope or bypass session resolution; forged-authority HTTP test must turn red. |
| Enabled is checked in each mutator | Remove the `enabled` recheck from one RPC; disabled-direct-RPC test must turn red. |
| All-scope cannot be forged/substituted | Remove effective `all` scope join or accept client scope; all-scope-required case must turn red. |
| Half-open interval and overlap safety | Remove overlap trigger/key predicate or change interval boundary; duplicate/overlap and boundary-date tests must turn red. |
| Future/expired/zero marker semantics | Make authorization include a future/expired/zero interval, or allow raw marker DML; corresponding date and raw-write tests must turn red. |
| Link ambiguity fail-closed | Remove verified/effective-link cardinality validation; zero/expired/two-link actor tests must turn red. |
| OCC account aggregate | Remove version compare or increment; stale write or exact +1 assertion must turn red. |
| Immediate session revocation | Cache actor resolution across requests or skip repository refresh; W08A-style disabled/revoked next-resolve test must turn red. |
| Disable/mutation race is linearized | Remove shared target-account lock or post-lock authority recheck; controlled concurrent test must demonstrate a stale-authority commit and fail. |
| Atomic zero-residue failure | Move a reason/revision/audit/idempotency write outside the transaction or suppress a failure; affected-table before/after counts must turn red. |
| Idempotency exact replay/conflict | Skip request-hash comparison or mutate replay result; same-payload equality or reused-key conflict test must turn red. |
| Audit mode cannot leak security events | Widen catalog action allowlist or return the full row set before filtering; exact event-class and forbidden-field tests must turn red. |
| Projection is exact/redacted | Add one forbidden key or return raw RPC JSON; exact key-set and serialized forbidden-value tests must turn red. |
| Restore requires capability + scope | Remove either `entry_restore` or effective `all` check; direct RPC deny test must turn red. |
| ACL/search path is closed | Grant EXECUTE to `authenticated`/`public` or remove fixed `search_path`; ACL/catalog assertion must turn red. |
| Direct route is guarded | Remove route/page server gate while leaving nav hidden; direct URL/API call test must turn red. |

## J. Production preflight requirements

Design only; do not run these against Production in W03-S0. The future preflight should run read-only in a rollback-only transaction and emit **counts/booleans only**, never UUID, email, name, auth subject, credential, token or raw DB error.

1. Migration ledger: applied count, pending count/set summarized as a boolean, mismatch count; require expected ledger and zero mismatch.
2. Enabled/disabled app-user counts.
3. Auth mapping counts: unmapped auth subjects; app-user mappings lacking a valid auth user; duplicate/ambiguous mapping counts. Emit no subject values.
4. Count app users with more than one effective verified recruiter link; separately count links not verified/effective.
5. Unknown capability token count against the canonical 23-token list.
6. Invalid capability/scope/link intervals and overlapping intervals, grouped to counts only; verify constraints/triggers are present/enabled.
7. Scope-kind/team-id mismatch count, including any `team` row without a team and any `own/all` row with a team id.
8. Count non-full-Admin actors with security authority (`entry_admin`, recruiter/team master authority, `audit_view`, `entry_restore`, or relevant all-scope combinations); separately count catalog-only operators. Do not print actor identities. Measure legacy non-full-Admin `entry_admin@all` holders for controlled Accounting transition; do not assume zero.
9. Effective `entry_restore` holder count and count with required effective `all` scope; report only counts/booleans.
10. Orphan app-user links, capability grants and scope grants via anti-join counts; check FK constraints are validated.
11. Audit integrity: unvalidated/missing audit FKs, orphan actor/reason/revision references and immutable-trigger status; counts only.
12. Session-revocation prerequisites: W08A route/test/source gate present; actor resolver remains service-role-only and live; enabled/capability/scope data are resolved request-time; no shared cache directive or persistent TTL; required account lock/version/revision objects and RPC ACLs match the reviewed implementation.

No query output from Production is evidence in this document.

## K. Sequencing and migration-slot boundary

- This survey base ends at migration **#70**. W01D is in development on another branch and is not part of this evidence.
- Do **not** reserve, name, or assume migration **#71 or #72**. Allocate a slot only after W01D's reviewed merge state and each W03 package boundary are known.
- Recommended logical order: W03A account aggregate/version/revision foundation → W03B capability/scope interval lifecycle and W03C recruiter-link lifecycle → W03D audit projection and W03E restore (after their event/version dependencies are clear) → W03F combined security/session regression.
- Keep migrations append-only and cohesive; do not edit earlier migrations or use a speculative generic framework. Every new RPC must be recognized by migration-inventory tests and service-role ACL assertions.
- Restore and grant/link history semantics are independent from W01D leader work; do not reuse W05A's scope seed as a runtime mutation.

## L. Risks and deferred decisions

1. **No account OCC today.** `direct_entry_app_users` has no version/history. Concurrent status, grant and link work cannot safely share a stale client snapshot until W03A provides a locked aggregate anchor.
2. **Bootstrap is privileged operational code, not lifecycle API.** First-owner bootstrap can enable an existing user and grant the full registry without app-user revision/audit. Keep this path tightly gated and separate from W03; review its long-term post-bootstrap restriction before relying on it for ordinary account administration.
3. **Legacy Accounting grant.** The provisioning script still grants `entry_admin@all` to support existing project operations. W03 must deny its use for security administration without breaking catalog/project behavior; the authority transition belongs to a separately reviewed catalog/project guard and controlled migration/provisioning plan.
4. **W05A seed is not lifecycle.** It derives scope from display/catalog `personnel_position`, hard-codes seven leaders, and grants no `team_manager_assign`. It ran as a seed; do not rerun or treat it as runtime authority. W01D must own any scope/capability transition and postconditions.
5. **Audit RPC is too broad for a browser contract.** Existing entry audit returns a raw row set, whose storage includes actor/auth subject and other internal references. W03D must add an explicit bounded projection and server-side mode policy, not reuse that return value directly.
6. **Marker support is asymmetric.** Membership markers exist only through #70's audited path. Capability/scope/link intervals remain strict. Supporting same-day/future cancellation without hard delete requires an atomic marker schema/guard/RPC/test change for each relevant interval table.
7. **Link cardinality is not fully constrained by schema.** Overlap is per app-user/recruiter pair; multiple different verified links can exist. W03C must preserve history while preventing ambiguous current authority and proving it at session and RPC boundaries.
8. **PII/account identification remains bounded.** The exact account-list fields needed to let an Admin identify an existing login are not locked here. Do not solve by exposing email/auth subject; define the smallest Owner-approved identifier and test exact keys before UI work.
9. **No migration numbers or Production facts are assigned.** Current row counts, actual Accounting holders, `entry_restore` holders, mapping anomalies and audit integrity are unknown until the separately approved counts-only Production preflight.

**Survey conclusion:** W08A supplies next-request session freshness; the schema supplies immutable audit/reason/idempotency foundations and effective-dated grant/link tables; W05A supplies only a release-time team-scope seed. W03 account, grant, link, mode-scoped audit and restore server paths remain to be built under the locked authority matrix above. No implementation or migration slot is started by this handoff.
