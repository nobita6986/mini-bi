# R1 — Authorization Contract

**Status:** Locked implementation contract derived from the Product Owner’s direction. No authorization code or database grants have changed.  
**Baseline:** `302ae0ac12f4c7bf39b84e0928971b2e8520d6af`

## 1. Decision sequence

For each request, use this order:

1. Verify the Supabase session with server-side `auth.getUser()`.
2. Resolve exactly one enabled application actor from the verified auth subject using the existing actor repository.
3. Derive the business action from the route/use case. Ignore or reject client-supplied actor IDs, capabilities, roles, and trusted scope.
4. Resolve the current resource scope from current ownership, verified recruiter link, current team membership, current project-manager assignment, or an explicitly granted all-scope.
5. Allow only if the actor has the action and the resource is inside that current scope.
6. For writes, apply existing workflow/state, document, revision/OCC, idempotency, and audit checks.

Authentication and actor mapping are inputs to authorization, not a substitute for the action and scope checks. A page or navigation predicate may hide UI, but cannot grant the action.

## 2. Actions and worker-action reuse audit

Keep existing business capabilities whose meaning remains clear, including entry create/ownership/team/admin actions, submit/change request/review, privileged edit, employment-status actions, document upload/view, audit, and restore.

Remove these from active authorization everywhere:

- `pii_view`
- `pii_export`
- `payment_view`
- `payment_edit`

Existing grant rows are retained, and the actor repository may continue to return those strings during the compatibility window. The TypeScript parser may accept them as legacy input until that boundary changes, but no authorization decision, UI predicate, API guard, or SQL projection may consume them. Do not remove them from the parser vocabulary without proving that actors with existing rows still resolve successfully.

Do not alias, rename, or silently reinterpret one of the retired tokens. The source audit finds reusable actions already in place, so R1 adds **no new `worker_view` or `worker_export` capability**:

- Worker view is the existing server-projected `allowed_actions.view` decision in `src/lib/direct-entry/worker-directory-contract.ts` and `public.direct_entry_worker_directory_audience`. The SQL action is returned only after row-audience authorization. Existing `entry_*` actions remain entry/workflow actions and are not repurposed.
- Worker export is the existing `worker_export` route/RPC/audit action (`direct_entry_export_workers`). Reuse its bounded request, current row audience, reason, audit and row limit. Remove the `pii_export`/`pii_view`/`payment_view` conjunction. For `scope=all`, retain the existing explicit all-scope grant plus `entry_admin` or `change_review`; do not seed an all-scope or export grant by default.

This keeps one view action and one export action across list/detail/export without adding a permission per screen, field, role or export scope. The active capability vocabulary is the existing vocabulary minus `pii_view`, `pii_export`, `payment_view` and `payment_edit`. Existing rows can remain for history and actor parsing, but no decision may consume them.

## 3. Scope and time

### Scope

Use the existing business sources of authority and their explicit current state:

- **Own:** the actor’s own resource/uploader ownership when the existing workflow defines that boundary.
- **Team:** a team the actor is currently assigned to manage or review under the existing team rules.
- **Project:** a project with a current project-manager assignment.
- **All:** an explicit current all-scope grant plus whatever existing business action is required for company-wide worker operations.

Do not infer scope from role names, email, UI visibility, labels, client filters, or historical assignment rows. Worker audience names such as `recruited`, `managed`, and `all` map to those existing authoritative recruiter/project/all checks; they are not new roles.

### Current state and dates

Authorization reads current state, never an interval comparison. Where an existing `enabled`, `active`, or verified-current relationship already expresses that state, reuse it. For authority rows whose current status exists only as `valid_from`/`valid_to`, add the smallest explicit `is_current` marker and make the existing grant/revoke RPCs maintain it. Keep the existing relationship tables and RPC names; do not add a policy engine or a parallel assignment store.

The forward migration may use the legacy interval once to initialize state: mark a row current only when it was already in force at cutover, has no close/revocation marker, and is not a future assignment. Closed, expired, canceled, revoked, future, disabled, or ambiguous rows remain non-current. Preserve their rows and all business dates. After cutover, `valid_from` and `valid_to` are metadata/history only and must not appear in any authorization predicate. Future-scheduled rows stay non-current; an operator must explicitly create/activate a current assignment through the existing audited grant flow. No clock or scheduler promotes them.

The resource’s business `effective_date` is never an authorization input. A current assignment covers all records in its current scope, including historical records. A revoke or account disable updates current state in the same existing mutation boundary and denies the next request. Keep business effective dates, employment periods, membership histories, audit timestamps, reports by period, and dates required by business rules.

## 4. View, edit, document, export

### View

After the existing worker `view` action and row-scope authorization, return the complete authorized worker profile, including national ID, birth date, banking/payment fields, and existing details. Remove field-by-field PII/payment redaction based only on retired capability tokens. Keep structural validation and strict projection contracts.

For mixed-version RPC compatibility, the existing `view_pii` and `view_payment` response keys may remain temporarily, but they must be inert and equal the already-authorized `view` result. Updated UI/API code must not consume either key as a permission.

### Edit

Remove `payment_edit` as an independent field permission. Payment fields follow the same action, current resource scope, ownership, workflow/state, validation, revision/OCC, and audit rules as their enclosing worker edit. Do not grant extra edit authority by deleting a field check if the enclosing write action is absent.

### Documents

Document view/upload remains separately guarded by the existing document action and object-context checks. Removing PII/payment gates does not permit guessing an object ID, accessing another resource’s document, bypassing storage controls, or weakening document grants.

### Export

Export must use the existing `worker_export` route/RPC action and the same current worker-row audience as view. For `scope=all`, keep the existing current all-scope grant plus `entry_admin` or `change_review`; there is no default company-wide export. Keep the required reason, immutable access audit, 10,000-row cap, strict response envelope, no-store headers, safe XLSX generation, and formula-injection protection. Client filters select within the authorized row set and never widen it. Keep RPC execution server-only under the S0 allowlist.

## 5. Authority by layer

### Frozen cross-layer interfaces

- Keep `direct_entry_resolve_actor_context` name, arguments, top-level JSON keys, and array keys. Its SQL implementation returns only current capability, recruiter-link, team-scope, and project-scope rows using explicit current/active/verified/revocation state. It never selects authority by comparing `valid_from`, `valid_to`, or a worker business date. Existing date fields may remain in returned rows as inert compatibility metadata; TypeScript treats each returned authority row as current and performs no date filtering.
- Keep worker directory/export RPC names, arguments, and response envelope. The SQL row-audience result remains authoritative for `allowed_actions.view`; legacy `view_pii`/`view_payment` values, if kept, echo the authorized `view` result and are ignored by consumers. Export keeps the existing `worker_export` action and envelope.
- T1-A owns the TypeScript evaluator, capability union, and page/navigation predicates. T1-B owns resolver SQL, current-state storage/mutation, worker authorization SQL, and the capability-parity test. T1-C owns worker API/projection/UI/export consumers. No two workstreams edit the same module; signature/envelope changes require a written interface proposal to T0 before implementation.

| Layer | Contract |
|---|---|
| Browser/UI | Presents actions the actor may attempt. It may use server-derived actor metadata but is never authoritative. |
| API | Resolves the verified session on the server; validates a strict body/query allowlist; constructs the action and input; rejects client actor/capability/scope authority. |
| Repository | Server-only service-role boundary; calls only allowlisted RPCs; passes the verified `auth_subject` and mapped `app_user_id`; projects a strict envelope; fails closed. Actor-context arrays returned by SQL are already current and are consumed without date checks. |
| SQL/RPC | Rechecks actor mapping, action, explicit current state, row audience, workflow/state, and audit in the same DB boundary. No authorization predicate reads a grant/assignment interval or record business date. SECURITY DEFINER functions keep fixed search paths; internal helpers remain non-executable by API roles. |
| RLS/ACL | Keep S0 least-privilege grants. No direct browser table access and no new `anon`/`authenticated` EXECUTE grant for internal worker RPCs. |

## 6. Revocation and failure behavior

- Session absent/invalid, actor mapping missing/disabled/ambiguous, missing action, out-of-scope row, invalid assignment, or RPC error: deny or fail closed using current API error conventions.
- Grant/scope revocation affects the next new request. Do not cache an allow beyond the established request/session model.
- Do not accept a client-provided actor UUID even if it matches a known account.
- Keep audit content non-PII where the existing contract requires it; do not log worker rows, export bodies, or raw database messages.

## 7. Required proof before cutover

The implementation PR must include a table proving (a) every old capability caller has been removed or justified as non-authorization business data, (b) no row access compares the record effective date to assignment dates, (c) current assignment/revoke behavior remains fail-closed, (d) all actor IDs originate from the server session, and (e) the DB ACL for each exposed/internal RPC still matches the S0 allowlist.

