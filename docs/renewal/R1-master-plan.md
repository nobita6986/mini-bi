# R1 — Authorization Simplification Master Plan

**Status:** Corrected contract and ownership are locked for parallel R1 implementation; no R1 code, SQL, or access-control changes have been made.  
**Repository:** `nobita6986/mini-bi`  
**Baseline:** `302ae0ac12f4c7bf39b84e0928971b2e8520d6af` (S0-C2 merge commit; PR #80)  
**Planning branch:** `codex/r1-planning-from-s0`

## 1. Baseline and evidence

S0-C2 PR #80 is merged; `main` is pinned to `302ae0ac12f4c7bf39b84e0928971b2e8520d6af` for R1 branches. The shared local `main` ref points to a divergent owner-preference checkout and is not the implementation baseline; do not switch, reset, or rebase it. The source migration tree contains 124 migrations at the pre-C2 planning baseline; C2 changes only runner code/tests. The approved TEST Supabase ref is `oyykqfxkyqhxgrfntokl`. Existing Vercel metadata resolves `bi2.hrpartner.vn` to a deployment labelled `target=production` and maps that environment’s public Supabase URL to the TEST ref. Treat this as a deployment-target mismatch: no TEST cutover or authenticated smoke may use that alias until a separately approved TEST-targeted deployment mapping is confirmed.

S0 has materially narrowed RPC ACLs. Keep `supabase/migrations/20261020180000_s0_t1_c_rpc_acl_allowlist.sql` and `scripts/s0-t1-c-rpc-acl.test.mjs` in the regression set. S0-C2 PR #80 fixes the migration runner transaction boundary and adds a PostgreSQL rollback-on-ledger-failure regression; it merged after review and all Node 22 CI checks passed. S0-C1 authenticated smoke remains unverified because no designated test session/account and cleanup procedure are available. C1 is only a TEST cutover acceptance gate, not a coding gate.

The source confirms the work is removal and consolidation, not a new authorization framework:

- `src/lib/auth/direct-entry-v2.ts` declares the field capabilities; its `authorizeDirectEntry` helper currently matches scopes using `effective_date`. T1-A will remove that authorization comparison; SQL/RPC remains the live data boundary.
- `src/lib/auth/direct-entry-session-core.ts::resolveDirectEntrySession` verifies the Supabase user with `auth.getUser()` and passes that subject into the actor resolver.
- `src/lib/direct-entry/actor-context-repository.ts` calls the server-only `direct_entry_resolve_actor_context` RPC; its SQL aggregates stored capability rows. Because retained legacy grant rows can still reach `resolveActor`, keep parser compatibility until that data boundary is deliberately changed.
- `src/lib/auth/direct-entry-page-access.ts` and `src/lib/navigation/registry-capability.ts` already centralize page and navigation predicates.
- Worker directory and export already use server-only repositories and bounded RPCs: `direct_entry_list_workers` and `direct_entry_export_workers`.
- SQL already has reusable scope helpers: `direct_entry_project_assignment_effective`, `direct_entry_actor_is_assigned_project_manager`, and draft-scope helpers. Preserve their names/callers where possible and change only their current-state source; do not create a second policy layer.
- `supabase/migrations/20261015150000_pre_w2_worker_data_capabilities_default.sql` provisions retired PII/payment tokens, and directory/detail/export SQL consumes them. R1 stops that provisioning and removes all active checks while preserving historical grant rows.
- `direct_entry_read_projection`, workflow transitions, document/object checks, audit events, revision/OCC, and export safeguards are established mechanisms to retain.

## 2. Target

Use one readable authorization path:

> Authenticated user → server-resolved actor → business action → current resource scope → allow/deny → existing workflow and state checks for writes.

The user’s *current* assignment determines which resources are in scope. A currently assigned team or project manager can see historical records in that scope, regardless of each record’s business effective date. A future, expired, or revoked assignment grants nothing; revocation applies on the next request. Business dates and history remain available for business rules, reporting, and audit.

Viewing an authorized worker profile includes its profile fields, including identity and payment details; there is no separate PII/payment viewing gate. Editing payment fields continues to require the same relevant edit action, ownership/scope, and workflow/state validation as the enclosing worker action. Export remains an explicit, audited action with a reason, row cap, safe XLSX generation, and the same row scope as view.

Action reuse is locked: the SQL row audience’s `allowed_actions.view` is the existing shared view decision; `worker_export` already names the bounded route/RPC/audit action. Neither needs a new capability token. Retired `pii_*` and `payment_*` tokens are not aliases. Company-wide export continues to require a current all-scope grant plus `entry_admin` or `change_review`, and no all-scope export is defaulted.

Current scope is an explicit status on the existing grant/assignment relation. Reuse existing enabled/active/verified/revocation fields where they already express current state; add the smallest `is_current` marker only for interval-only rows. A one-time fail-closed migration backfill preserves valid current rows and leaves future, closed, revoked, expired, disabled, canceled, and ambiguous rows non-current. Every request thereafter reads state only; dates remain business/history metadata. Revocation or disable clears current state within the existing mutation and denies the next request. Future assignments do not auto-promote; an operator must explicitly grant current state through the existing audited flow.

### Ten architecture acceptance answers

1. Active capabilities are the existing business/action capabilities minus `pii_view`, `pii_export`, `payment_view`, and `payment_edit`. Worker `view` and `worker_export` remain existing actions; no worker capabilities are added.
2. Current scope becomes one explicit status check on existing scope/assignment rows plus the row-scope match. This removes request-time interval intersections.
3. A project manager must have a current verified app-user/recruiter link and an explicitly current project assignment for that project; then `view` covers all records in that project regardless of their dates.
4. The existing audited revoke mutation clears current state in its transaction. The next request resolves fresh actor/scope state and denies access.
5. No date comparison remains in authorization. Legacy dates can classify state once during cutover; business dates remain for business rules, reporting, and history.
6. No active PII/payment permission gate remains. Authorized profile view includes those fields; editing still uses its enclosing write action/workflow.
7. UI predicates are hints, APIs resolve the actor from verified Supabase `getUser()`, and the server-only RPC rechecks actor binding, action, and current row scope.
8. Remove `isEffectiveAt`/resource-date scope matching in TypeScript, date predicates from live SQL auth helpers, field-capability redaction branches, and capability triples. Reuse the existing actor repository, assignment helpers, row-audience RPC, and export RPC.
9. Reuse existing session code, repositories, RPC names/envelopes, UI components, PGlite/PostgreSQL harnesses, audits, OCC, idempotency, and document guards.
10. R1 adds no policy engine, role manager, bundle, generic helper layer, or second assignment source. It adds only the smallest explicit current marker where the existing authority row lacks one.

## 3. Scope boundaries

### KEEP

- Supabase Auth, `getUser()` verification, and the existing auth-subject-to-app-user mapping.
- Business actions such as entry creation, submission, review, privileged edit, document upload/view, audit, and restore where they still have clear meaning.
- Own/team/project/all resource scope; current recruiter links, team membership, and project-manager assignments.
- Server-side session guards, server-only service-role repositories, actor identity binding, SECURITY DEFINER fixed search paths, RLS, and S0 RPC allowlists.
- Draft/submission/change-request workflow, document/object-context guards, audit/revision, optimistic concurrency, idempotency, input validation, and reporting business-time logic.
- Existing worker list/detail/export APIs, repository interfaces, projections, SQL RPCs, and PGlite/PostgreSQL harnesses where their contract still fits.

### SIMPLIFY

- Make the same current-scope rule drive UI hints, API decisions, and database row access. UI remains presentation only; API session and SQL/RPC remain authoritative.
- Use the request-time/current assignment to authorize historical resources; stop passing a record’s `effective_date` into authorization matching.
- Let one action-and-scope decision govern all fields in an authorized worker projection.
- Stop default provisioning of the retired field capabilities. Preserve existing rows during R1; make the old tokens inert and avoid a data cleanup migration.
- Keep RPC names/signatures and response envelopes where practical to minimize mixed-version risk.

### REMOVE FROM ACTIVE AUTHORIZATION

- `pii_view`, `pii_export`, `payment_view`, and `payment_edit` checks, projections, nav predicates, defaults, and RPC preconditions.
- Any request-time comparison of `valid_from`/`valid_to`, grant dates, assignment dates, or worker business dates to decide authorization.

### BUILD ONLY IF NEEDED

- Forward-only migration(s) for explicit current state and regression tests for the final action/scope contract. No new worker capability, role manager, policy engine, role bundles, field-specific tokens, or per-screen view action.

## 4. Workstreams and ownership

| Workstream | Owns | Does not own |
|---|---|---|
| T1-A — TS authorization contract | `src/lib/auth/direct-entry-v2.ts`, `src/lib/contracts/direct-entry-v1.ts` capability union only, page/navigation predicates and their tests; actor/capability/scope types | SQL migrations; worker projections and export implementation |
| T1-B — DB authorization | New forward-only SQL migration(s), SQL helpers/RPC bodies/ACL self-checks, DB regression tests, `scripts/p3-1-w01a-capability-contract.test.mjs` | TS auth contract or React/API implementation |
| T1-C — API, worker views, export | Worker detail/list/export API, repositories, projections, UI predicates, redaction and export tests | Central auth contract and migration files; coordinate needed signature changes with T1-B |

T1-A/B/C share this contract but must not concurrently edit the same modules. T1-B owns all `supabase/migrations/**`; T1-A owns the central authorization contract; T1-C owns worker projections and routes. Cross-workstream changes are proposed as small follow-up commits after interface agreement.

The shared interface is frozen: `direct_entry_resolve_actor_context` keeps its RPC name, arguments, JSON envelope, and array keys; SQL returns only explicitly current authority rows, and T1-A consumes those arrays as current without date filtering. Worker list/export RPC names, arguments, and response envelopes remain stable. T1-B may retain inert date fields and legacy view echoes for compatibility; T1-A/T1-C must not consume them as authorization gates.

## 5. Order and rollout gates

1. **Close S0-C2:** completed by merging PR #80 after manual review and all Node 22 CI checks passed; all R1 branches use the resulting `main` SHA above.
2. **Lock the corrected R1 contract:** completed; reuse existing `view`/`worker_export` actions, explicit-current model, profile visibility rule, and export semantics before coding.
3. **Implement in isolated PRs:** T1-A auth contract, T1-B DB migration/tests, T1-C projections/API/UI. Preserve RPC envelopes where safe and keep each owner’s files separate.
4. **Run ephemeral validation and full CI:** this is a development gate and does not require S0-C1 credentials or TEST writes.
5. **TEST cutover acceptance:** only when a separately approved TEST-targeted deployment, TEST project mapping, test-only account, synthetic data, and cleanup path are confirmed may the sequential TEST migration/deploy and authenticated smoke run.
6. **Review before production:** production deployment requires explicit PO approval after review, CI, and TEST smoke. Do not automate production migration as part of this plan.

For mixed-version safety, prefer unchanged RPC names, argument lists, response shapes, and service-role ACLs. If that cannot preserve both old and new app behavior, use a small versioned cutover only for the affected boundary, with a test proving both old-app/new-DB and new-app/new-DB behavior. Do not add a generic compatibility framework. The rollback is app rollback to the last compatible build plus, only if needed and separately reviewed, a forward-only compensating migration; never delete ledger rows or edit old migrations.

## 6. Acceptance criteria

- No active authorization decision uses the four retired field-specific capabilities.
- No worker-record business date is used to decide whether a current user may see that historical worker.
- Explicit current assignments still gate scope; future/non-current, closed, revoked, ambiguous, or disabled assignments fail closed. Revocation is effective on the next request, and a scheduled row never auto-promotes.
- UI, API, and SQL/RPC agree for own/team/project/all and recruited/managed/all worker audiences.
- API bodies cannot set actor identity or trusted scope; the server supplies actor IDs from `getUser()` plus the existing mapping.
- Profile view and export apply the approved shared action/scope semantics. Export reason, audit, row limit, output validation, and formula-injection protection remain.
- Write workflows, document guards, RLS, SECURITY DEFINER safety, S0 ACL allowlists, audits, revisions, OCC, and idempotency remain intact.
- No profile/workflow/audit history is deleted or rewritten. R1 is simpler by removing gates, not by adding policy layers.
- CI and approved TEST smoke pass before production review.

## 7. Open risks and decision gates

1. **Action reuse:** `allowed_actions.view` and the worker row-audience helper already express view; `worker_export` already exists as route/RPC/audit action. `entry_*` remains workflow/business action. No new worker capability is required.
2. **Historical grant data:** the default provisioning function currently creates PII/payment rows. R1 should stop creating them and stop consuming them, but retain existing rows in place. If later data deletion is desired, handle it separately with retention review.
3. **Authentication proof:** service-role RPCs accept explicit actor UUID arguments by design. Their trusted callers must remain server-only and derive those arguments exclusively from the verified session/mapping; do not expose a client-callable RPC.
4. **Current-state backfill:** inspect every relevant grant/assignment table and use a conservative one-time classification. No later request may use an authorization clock or valid-date predicate.
5. **TEST deployment mismatch:** Vercel currently reports the custom-domain deployment as `target=production`, although existing mapping evidence points its public Supabase URL to the PO-designated TEST ref. Do not smoke or migrate this alias until a separately approved TEST-targeted deployment is mapped and verified.
6. **Cross-layer parity:** TS actor projection, API current audience, and SQL/RPC must agree on current scope. Keep the existing server session and service-role boundary; no client-provided actor or scope.

