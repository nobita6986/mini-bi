# P3.1-W05-S0-R2 — Existing-user management UI reuse/readiness rebaseline

## Status and boundaries

`P3_1_W05_S0_R2_W03A_REBASELINE_ACCEPTED`

Docs-only readiness rebaseline for the post-W03 W05 UI. R2 opens only the Accounts UI slice against the landed W03A contract; it does not create source/API/schema/migration/package/dependency changes, reserve a migration slot, create stubs, or open later W05 slices.

- Base required and verified: `origin/main@64943cf5d4f47b1ea95b9d1233e117f12b07a3e7`.
- Worktree: `C:/CodeApp/BI-p3-1-w05-s0-existing-user-ui-reuse-survey`.
- Integration branch: `codex/p3-1-w05-s0-r2-rebaseline`.
- Primary checkout was dirty before this survey and was not modified.
- Current migration ledger: 84 files on this base. W03A lifecycle/read/API is present in #82-#84; W03B-E is not present. No migration slot is reserved by this survey.
- Only intended change: this handoff file.

## 1. Current truth

### Existing UI that can be reused

The Admin Catalog surface is implemented and is the reusable baseline:

| Surface | Current implementation | Reuse truth |
|---|---|---|
| Admin shell/navigation | `src/app/admin/layout.tsx`, `src/lib/admin/admin-navigation.ts`, `src/components/admin/admin-subnav.tsx` | One top-level `/admin` entry; internal server-projected subnav. Reuse unchanged for W05; add only the access-section entries after their page predicates exist. |
| Server page decision | `src/lib/auth/direct-entry-page-access.ts`, `src/lib/navigation/registry-capability.ts`, `src/lib/navigation/resolve-nav-actor.ts` | `DirectEntryPageDecision` and `decideCapabilityPageAccess` already provide redirect/account-unavailable/temporary/access-denied/allow states. W05 must add explicit access-section decisions only when W03 contracts are landed; do not infer permissions in client code. |
| Personnel | `src/components/admin/personnel-catalog-manager.tsx`, `src/lib/admin/personnel-catalog-model.ts` | Full list/detail-ish catalog lifecycle, inactive filter, reason/OCC/idempotency, strict projection, authoritative reload and conflict lock. Reuse interaction and model shape; do not use its business fields for accounts/grants. |
| Team | `src/components/admin/team-catalog-manager.tsx`, `src/lib/admin/team-catalog-model.ts` | Team lifecycle and versioned mutation pattern. Reuse table/dialog/status/paging patterns, not team authority as a proxy for security authority. |
| Team leader | `src/components/admin/team-leader-manager.tsx`, `src/lib/admin/team-leader-model.ts` | Current/scheduled/history interval views, candidate search, designate/replace/revoke, team-scoped locks and authoritative reload. Reuse interval-history and candidate projection discipline; do not reuse leader designation as a grant/link editor. |
| Vendor | `src/components/admin/vendor-catalog-manager.tsx`, `src/lib/admin/vendor-catalog-model.ts` | Latest compact list/create/update/set-active pattern with exact request bodies, sanitized outcomes, retry intent and reload-before-unlock. Reuse as the closest CRUD reference. |
| Labor type | `src/components/admin/labor-type-catalog-manager.tsx`, `src/lib/admin/labor-type-catalog-model.ts` | Same catalog interaction pattern; strict server projection and immutable-key handling. It proves the catalog lane is separate from W05 security administration. |
| Shared UI primitives | `Card`, `CardHeader`, `Alert`, `EmptyState`, `ErrorState`, Radix `Dialog` | Reuse as-is. There is no need for a new generic CRUD/form framework. |
| Validation/mutation conventions | `src/lib/direct-entry/project-operations-model.ts` and each `src/lib/admin/*-model.ts` | Reuse `validateReason`, `validateUuid`, `validateVersion`, `newIdempotencyKey`, exact body builders, sanitized status classification. W05 models must be security-surface-specific and mode/audience-specific. |

### W05 current absence and source-backed contract state

- No `src/app/admin/access/{accounts,audit,restore}/page.tsx` exists on this base.
- No `src/components/admin/access/*` exists on this base.
- No `src/lib/admin/account-access-model.ts`, `audit-model.ts`, or `restore-model.ts` exists on this base.
- W03A account routes now exist on this base: `GET /api/admin/access/accounts`, `GET /api/admin/access/accounts/[accountRef]`, and `POST /api/admin/access/accounts/[accountRef]/{enable,disable}`.
- The existing `direct_entry_read_audit` foundation RPC is not a W05 browser contract: it is service-role-only, raw/broad, and does not implement `full`/`catalog`/`own_manager` mode projection. It must not be exposed directly to the browser.
- W03A implementation is present and accepted: #82 provides account lifecycle/OCC; #83/#84 provide the repaired strict list/detail projection and API contract. W03B-E remains contract/readiness work until each lane lands.
- W03 R3 locks the dependency graph: W03A first; W03B and W03C independently after W03A; W03D only after W03A+B+C and additionally W02A for its `own_manager` mode; W03E is code-wise independent from A-D but lands its `entry_restore: all` scope contract and `direct-entry-auth/1.4` bump together; W03F/J01 wait for all required W03 lanes.

## 2. Reuse map and minimum delta

| W05 need | Reuse unchanged | Minimum extension after W03 is available | Explicitly do not do |
|---|---|---|---|
| Access navigation | `ADMIN_SECTIONS`/`visibleAdminSections`, `AdminSubnav`, server-resolved actor projection | Add `accounts`, `audit`, `restore` only through server-projected section visibility and separate page gates. Accounts and grants/links require the Full Admin triple (`entry_admin` + `recruiter_master_manage` + `team_master_manage`) at effective `all`; Audit visibility is decided by W03D as `full` for that triple or `catalog` for `catalog_master_manage@all`; Restore requires the Full Admin triple plus `entry_restore@all`. | Do not add client capability checks, role-name checks, or one AppShell entry per access page. |
| Account list/status | Personnel/Vendor list states, strict query echo, row action rail, Radix dialog, applied/conflict lock | Reuse the landed W03A projection exactly: row keys `account_ref`, `display_name`, `enabled`, `version`; list keys `search`, `enabled`, `page`, `page_size`, `total`, `accounts`; mutation body `expected_version`, `reason`, `idempotency_key`; authoritative detail/list reload after `{ok:true}`. | Do not reuse Personnel catalog projection as an app-user projection; do not show raw `auth_subject`, email, UUID, reason text, or `version`; do not treat opaque `account_ref` as a display label. |
| Capability/scope intervals | Team membership/leader current-scheduled-history split, exact mutation model builders, reason/OCC/idempotency | W03B must provide separate capability and scope list/detail/mutation projections, immutable interval IDs for revoke, effective-date semantics and authoritative reload snapshot. | Do not merge capability and scope into one invented RPC/body; do not treat `team_manager_assign` or leader bundle as generic grant data. |
| Verified recruiter links | Team-leader candidate/verified-link display discipline, personnel provider projection pattern | W03C must provide bounded verified-link list/create/revoke projection and immutable `link_id` for revoke, including leader-bundle precheck outcomes. | Do not infer verified status from personnel position, email, provider labels, or current UI state. |
| Audit explorer | `Alert`, table, pagination, strict projection/model conventions; audience-scoped reporting pattern | W03D mode envelope (`full`, `catalog`, or no surface) and bounded action/resource/time projection. Client renders the returned mode and rows without deriving authority. | Do not call raw `direct_entry_read_audit`; do not return broad rows then hide security events in browser; do not render raw reason/audit payload or PII. |
| Entry restore | Existing Direct Entry row/detail/retry/OCC patterns and Radix confirmation dialog | W03E restoreable-item projection plus single-entry restore mutation with entry version, reason, idempotency, strict state taxonomy and authoritative detail reload. | Do not build a generic restore engine, restore submissions/documents/security rows, or use account/grant/link state as restore input. |
| Error/lock UX | Vendor/Labor Type `classify*Mutation`, `pendingIntent`, `conflictIntent`, reload-before-unlock | Extend per entity and per access surface only; preserve entity-scoped locks and same-intent retry. | Do not clear a lock after an applied response alone or after a malformed/non-authoritative reload. |

## 3. W03 → W05 UI dependency matrix

The following is a readiness matrix, not an implementation contract invented by this survey. “Allowed to open” means the named W05 slice has a landed, accepted, strict server contract and its focused backend evidence; otherwise it remains blocked.

| W03 lane | UI projection/API required by W05 | Server authority boundary | Required UI states | W05 implementation gate |
|---|---|---|---|---|
| **W03A — existing-user lifecycle / OCC root** | Landed list/detail projection and API: opaque `account_ref`, canonical `display_name`, `enabled`, authoritative `version`; bounded server search/filter/pagination; enable/disable with `expected_version`, reason and UUID idempotency key; mutation success exactly `{ok:true}` followed by authoritative reload. | Full Admin only: W03A actor/target lock and post-lock authority recheck. Accounting, leaders and ordinary users denied. Disable does not cascade child rows; next actor/session resolution enforces disabled state. | Loading, empty, denied, unavailable/error/retry, malformed projection, mutation retry, 409 conflict lock and successful authoritative reload; account-not-found handling. | **Ready.** W03A #82-#84 has landed and T0 accepted it; the W05 Accounts slice may open. This remains the OCC root for W03B/C. |
| **W03B — capability + scope grant lifecycle** | Separate capability and scope projections and mutation contracts; interval rows with immutable `grant_id`, current/scheduled/history semantics, exact capability/scope fields, effective date, expected app-user version, reason and idempotency; separate revoke routes and reload snapshots. | Full Admin triple at effective `all` only for generic capability/scope grant/revoke. `catalog_master_manage@all` is not a W03B grant-editor authority; team-leader bundle rows and `team_manager_assign` are not generic client-managed authority; leader bundle remains W01D-owned. Disabled-target grant denied; close/revoke may be allowed per W03 contract. | Per-account and per-interval loading/empty/denied/not-found/unavailable/error; current/scheduled/history; retry; stale OCC lock; duplicate/overlap/state/policy-denied distinction. | **Blocked until W03B lands.** W03A is satisfied; W03B may now be built independently of W03C, but W05 grant UI waits for its projection and mutation taxonomy to be accepted. |
| **W03C — verified recruiter-link lifecycle** | App-user link list/detail with bounded recruiter display fields, immutable `link_id`, verified/effective interval state; create/revoke contract with recruiter target as server-approved business input, expected app-user version, reason, idempotency, current-or-scheduled leader-bundle guard and reload. | Full Admin only. W03C must reject mutation that would break a current or scheduled leader bundle; historical/marker semantics remain server-owned. No team aggregate lock or client-side leader inference. | Loading/empty/denied/not-found/unavailable/error; current/scheduled/history; duplicate/overlap/state/policy conflict; retry and entity lock until authoritative reload. | **Blocked until W03C lands and its leader-bundle regression is accepted.** W03A is satisfied; W03B is not a code prerequisite. |
| **W03D — bounded audit projection** | Mode-scoped audit envelope: `full` for the Full Admin triple at effective `all`, `catalog` for `catalog_master_manage@all`, `own_manager` only inside existing Project Operations for leader assignment events; exact action allowlists, bounded actor/resource/time/display fields, pagination/filter echo and no unrestricted payload. | Mode and filtering enforced by W03D server projection. Full Admin triple at effective `all` receives `full`; `catalog_master_manage@all` receives `catalog`; leader has no global explorer and receives `own_manager` only inside Project Operations; ordinary users none. No browser filtering as security boundary. | Loading, empty, denied, unavailable/error/retry, malformed mode/payload, no mode/no route, bounded detail; no raw reason/PII. | **Blocked until W03A+B+C land and W03D lands.** R3 explicitly rejects weakening this to W03A+W02A; W02A is only the additional `own_manager` writer dependency. |
| **W03E — entry restore** | Restoreable soft-deleted DRAFT Direct Entry row projection; single-entry restore with `entry_id`, `expected_entry_version`, reason, idempotency; strict state conflict/not-found/version-conflict taxonomy; authoritative entry reload. | Full Admin only through `entry_restore` at effective `all`; no account/grant/link/leader rollback. W03E updates one Direct Entry row and its entry revision/audit chain only. | Loading/empty, denied, not-found/state-conflict/unavailable/error/retry, confirmation dialog, OCC lock until row reload. | **Blocked until W03E lands with `entry_restore: all` and `direct-entry-auth/1.4` contract bump accepted.** It is code-wise independent from W03A-D, but W05 restore must not use a pre-W03 fallback. |

### Dependency summary

- Accounts UI prerequisite **W03A is satisfied**; this slice is open.
- Grants/scopes UI now waits on **W03B**.
- Verified recruiter-link UI now waits on **W03C**.
- Audit explorer waits on **W03A + W03B + W03C + W03D**; `own_manager` additionally relies on W02A’s already-landed audit verbs and team scope classification.
- Restore UI waits on **W03E** and its contract bump, even though W03E is independent of A-D in code.
- Combined W05 readiness and session-freshness acceptance must wait on **W03F/J01** after all W03 mutations/projections are accepted. W05 UI must not silently bypass this by using stale actor state or a broad raw audit RPC.

## 4. Proposed W05 UI slicing

Use the smallest slices that preserve the W03 dependency graph:

1. **Access shell and page gates after contract readiness**: add internal access subnav entries and server page decisions only after the server returns the allowed section/mode contract. Keep `/admin` as one top-level navigation entry.
2. **Accounts slice — open now**: account list/status page, enable/disable dialog, bounded detail, reason/OCC/idempotency, entity-scoped conflict lock and authoritative reload. Reuse Vendor/Labor Type manager structure and existing access-denied components; consume the landed #82-#84 contract without adding an API or schema fallback.
3. **Grant/scope slice after W03B**: account detail tabs/sections for capability and scope intervals. Reuse current/scheduled/history patterns from membership/leader UI, but keep capability and scope request contracts separate. No generic “permission editor” abstraction until a third exact, stable shape proves it is needed.
4. **Verified-link slice after W03C**: bounded recruiter-link editor inside account detail, using immutable `link_id` and server-projected recruiter display. Reuse reason dialog, retry intent and authoritative reload; show leader-bundle policy denial as sanitized server outcome.
5. **Audit slice after W03D**: one mode-aware audit explorer route. Server page decision/projection supplies mode; `audit-model.ts` validates exact mode-specific envelopes. Reuse tables/filters/pagination, not the raw foundation audit RPC or change-request reviewer UI.
6. **Restore slice after W03E**: restoreable-item list/detail plus one confirmation dialog and restore mutation. Reuse Direct Entry detail/OCC and Radix confirmation patterns; do not create a cross-entity restore framework.
7. **Combined W03F/J01 readiness**: run focused access/security regression, canonical gates and Owner-only browser UAT only after all slices are contract-complete. This survey does not open that work.

No new form library, grid, RBAC framework, audit framework, ORM, migration stub or API route shape is proposed here.

## 5. Allowed / denied UI matrix

The UI may reflect server-projected visibility, but these rows are server/API/RPC authority requirements; hidden navigation never replaces denial at the route or mutation boundary.

| Actor / state | Accounts enable/disable | Capability/scope grants | Verified recruiter links | Audit explorer | Entry restore |
|---|---:|---:|---:|---:|---:|
| Full Admin: `entry_admin` + `recruiter_master_manage` + `team_master_manage` at effective `all`, enabled | Allow | Allow, except W01D-owned leader bundle rules | Allow, subject to W03C leader-bundle guard | `full` mode | Allow with `entry_restore@all` |
| Accounting: `catalog_master_manage@all` | Deny | Deny | Deny | `catalog` mode only | Deny |
| Project Admin: `entry_admin@all` without Full Admin triple | Deny | Deny | Deny | Deny | Deny |
| Team leader: `team_manager_assign@team` | Deny | Deny | Deny | No global explorer; own assignment events stay in Project Operations per W03D | Deny |
| PM/ordinary staff | Deny | Deny | Deny | Deny | Deny |
| Disabled, unmapped, ambiguous, missing session actor or stale resolution | Deny / page unavailable according to existing server decision taxonomy | Same | Same | Same | Same |

Never derive any row from role name, email, personnel position, display label, client actor fields, or client capability/scope fields. The W03 server predicate is the authority.

## 6. Mandatory invariants

- UI never self-authorizes and never accepts actor/capability/scope as business authority from client input.
- No UI projection renders raw UUIDs, `auth_subject`, email, unrestricted app-user identifiers, raw reason text, raw audit payload or raw database errors. Opaque IDs may remain internal route/request keys only when the W03 contract requires them.
- Every mutation uses the exact server contract: reason, authoritative expected version, one idempotency key per intent, same-key retry, sanitized outcome mapping and no optimistic success.
- Applied and OCC-conflict results lock the correct entity/surface until strict authoritative reload succeeds. Transport errors, malformed projections, denied reloads and non-authoritative responses keep the lock and expose retry.
- Missing or malformed projections fail closed; they never become an empty list, a guessed label, a role-derived mode or a raw-key fallback.
- Account disable does not cause the UI to invent a cascade. W03A’s server contract says child capability/scope/link/leader rows remain unchanged and freshness enforcement occurs on the next actor resolution.
- Audit mode/filtering is a security boundary. The client renders the server-provided mode and bounded rows; it never loads a broad dataset and filters security rows locally.
- Restore is entry-only and DRAFT/soft-deleted according to W03E; it never reactivates account access or restores security state.
- Existing history remains readable; no hard delete and no historical interval rewrite.
- No migration slot, API/schema shape, generic abstraction or dependency is reserved by this survey.

## 7. Contract-level acceptance plan

This is a contract plan only. No tests or source are created in W05-S0.

### Accounts / W03A acceptance

- Full Admin can list bounded existing accounts and see only permitted display/status/version fields.
- Accounting, Project Admin, Team leader, staff, disabled and unresolved actors are denied server-side.
- Enable/disable uses route-only `account_ref` plus the exact body `expected_version`, `reason`, `idempotency_key`; replay returns the stored result without a second version/revision/audit increment.
- Stale OCC returns sanitized 409 and leaves zero residue; applied or conflict remains locked until strict detail reload.
- Disable does not rewrite capability/scope/link/leader child rows; a subsequent fresh actor resolution denies the disabled actor.
- Mutation probe must make the focused lane red if OCC, reason, idempotency replay, server authority or reload-before-unlock is removed.

### Grants/scopes / W03B acceptance

- Capability and scope are separate projections and separate request bodies/routes.
- Current, scheduled and history are disjoint; immutable grant IDs identify revoke targets.
- Full Admin-only generic grants/scopes enforce W03B policy; leader-bundle rows cannot be edited through generic W03B UI.
- Disabled target grant denial, disabled target close/revoke behavior, stale OCC, duplicate/overlap/state conflict, invalid backdate and same-key replay each map to the locked taxonomy.
- Mutation probe must fail if scope fields are accepted by capability mutation, revoke selects by label/position, marker/leader-bundle ownership is bypassed, or reload is skipped.

### Verified links / W03C acceptance

- Projection exposes only bounded recruiter display/business fields and immutable link ID; no auth/email/raw identifiers.
- Full Admin can create/revoke under exact W03C contract; `catalog_master_manage@all`, Project Admin, Team leader and all other actors are denied.
- Current and scheduled leader-bundle links are protected by the server policy; historical/marker cases follow W03C’s locked semantics.
- Duplicate, overlap, wrong-owner/not-found, closed/state-conflict, stale OCC and idempotent replay are distinguishable and sanitized.
- Mutation probe must fail if link revoke ignores immutable ID, leader-bundle precheck, OCC, same-key replay or authoritative reload.

### Audit / W03D acceptance

- Full Admin receives only the bounded `full` envelope; `catalog_master_manage@all` receives only bounded `catalog`; leaders receive no global explorer and see `own_manager` only inside Project Operations.
- Exact action allowlists are server-enforced; security-admin events never arrive in the catalog payload.
- Audit mode is server-selected only: `full` requires the Full Admin triple at effective `all`; `catalog` requires `catalog_master_manage@all`; `own_manager` is confined to Project Operations assignment history/detail and is never a global access page.
- Mode, filters, pagination and row projections fail closed on malformed/wider payloads; raw reason, auth subject, email, unrestricted IDs and DB messages are absent.
- Mutation/read probe must fail if a wildcard action filter, broad raw audit RPC, browser-only filtering or client-derived mode is introduced.

### Restore / W03E acceptance

- Full Admin with effective `entry_restore@all` sees only restoreable soft-deleted DRAFT entries.
- Restore carries entry ID, authoritative entry version, reason and idempotency; no target app-user/security parameters.
- Applied restore sets only `deleted_at = NULL`, entry version/revision/audit/idempotency according to W03E; already-active/not-DRAFT is state conflict, missing target is not-found, stale version is OCC conflict.
- Applied/conflict remains locked until strict entry reload; no account, grant, scope, link or leader row changes.
- Mutation probe must fail if restore broadens to submissions/documents/security state, omits entry OCC, accepts raw reason response, or unlocks before reload.

## 8. Blockers and deferred items

### Blockers before the remaining W05 slices

1. **W03B not landed**: no separate capability/scope lifecycle contracts, immutable grant-ID projections or accepted mutation taxonomy.
2. **W03C not landed**: no verified recruiter-link lifecycle API/projection or current-or-scheduled leader-bundle protection implementation.
3. **W03D not landed**: no bounded mode-scoped audit projection. Existing raw foundation audit read is not usable by browser UI.
4. **W03E not landed**: no restoreable-item projection, restore RPC/API or `entry_restore: all` + `direct-entry-auth/1.4` accepted contract.
5. **W03F/J01 readiness not complete**: session freshness and combined W03 regression must be green before claiming the complete W05 security UI ready. This does not block the already-unblocked Accounts slice.

If any W03 lane changes the locked projection shape, authority matrix, action vocabulary, error taxonomy or dependency order, T0 must issue a reviewed contract/rebaseline update. W05 must not silently adapt by adding a fallback or weakening a dependency.

### Deferred / out of scope

- Invitation, account creation, password/reset/recovery and MFA remain P3.2.
- `pii_export` remains hidden unless Owner explicitly activates it.
- No global audit for leaders; their own assignment events remain in Project Operations.
- No generic CRUD/access-control framework, no generic restore framework, no new audit system, no migration reservation.
- No Production query/apply, deploy, browser/UAT, source implementation or test implementation in W05-S0.

## 9. Handoff recommendation

T0 accepts the rebaseline and opens only the Accounts UI slice against the landed W03A #82-#84 contract. Grants/Scopes, Verified Links, Audit and Restore remain closed until their corresponding W03 lane has landed, passed focused/security gates and been accepted. After Accounts, proceed with Grants/Scopes and Verified Links after W03B/C, then Audit after W03D and Restore after W03E; run W03F/J01 before declaring the complete W05 surface ready.

**Dừng tại:** `P3_1_W05_S0_R2_W03A_REBASELINE_ACCEPTED`
