# T1-B — Database Authorization and Forward-Only Migration

**Status:** Ready for implementation under the locked contract. S0-C1 is a TEST cutover gate, not a coding gate.  
**Baseline to use:** `302ae0ac12f4c7bf39b84e0928971b2e8520d6af`.

## Prompt

You are T1-B for Mini BI R1. Implement only the database authorization changes in `docs/renewal/R1-authorization-contract.md` and `docs/renewal/R1-migration-and-cutover-plan.md`. Start from the newly approved `main` commit in a dedicated branch. Do not touch TypeScript authorization, worker UI/API implementation, or the S0/hotfix checkout.

### Own

- New forward-only migration(s) under `supabase/migrations/`; do not edit historical migrations.
- SQL/PGlite/PostgreSQL regression tests and migration self-checks for your changes.
- `scripts/p3-1-w01a-capability-contract.test.mjs` because it verifies SQL/TypeScript capability vocabulary parity.
- A concise before/after privilege table for each changed function/table.

### Change

1. Remove the four field-specific capabilities from active SQL authorization and worker field projection. Reuse the existing worker `view` action and `worker_export` route/RPC/audit action; do not add new worker capability tokens.
2. Reuse and align existing `direct_entry_project_assignment_effective` / `direct_entry_actor_is_assigned_project_manager` and draft-scope helpers. Current-state helpers must read explicit current status only; never compare `valid_from`, `valid_to`, or a worker record business date in an authorization predicate. A currently assigned manager can read historic rows. Future, expired, closed, revoked, inactive, ambiguous, and wrong-scope grants remain denied.
3. Survey every auth predicate that currently relies on interval dates, including `direct_entry_team_leader_assignments` and its request-team/read guards. Reuse existing `enabled`, `active`, verified-link, and revocation state where sufficient. Add the smallest `is_current` marker only where a grant/assignment otherwise has no explicit current state. Backfill once from a fail-closed cutover snapshot: future, closed, revoked, expired, canceled, disabled, or ambiguous rows are non-current. Keep all rows/dates; never auto-promote future assignments. Existing audited grant flows explicitly create current state; revoke/disable clears it in the same transaction. Prove no active auth function compares `valid_from`/`valid_to` or a worker business date after cutover.
4. Stop `direct_entry_account_operation_finalize_create` from automatically provisioning retired PII/payment capabilities. Preserve existing grant rows; do not bulk delete or remap data.
5. Reuse current RPC names, argument lists, envelopes, and service-role grants if they are sufficient. Preserve S0 ACL allowlists. The worker-directory envelope must retain its current keys for mixed-version compatibility; any retained `view_pii`/`view_payment` values are inert echoes of `view`, not permission checks. Internal helpers stay revoked from `PUBLIC`, `anon`, `authenticated`, and `service_role` unless a reviewed server caller has a documented need.
   Preserve `direct_entry_resolve_actor_context` args, top-level envelope, and array keys. Filter its returned authority arrays using explicit current/active/verified/revocation state only, so TypeScript consumes them as current without date predicates.
6. Recheck actor mapping in SQL for every changed RPC. `p_auth_subject` and `p_app_user_id` must be bound to the verified server actor; do not make a client-callable identity/scope interface.
7. Keep SECURITY DEFINER functions on fixed search paths; keep RLS, service-role boundary, workflow/state, document/object guards, audit, reason checks, OCC/idempotency, and export limits.
8. Use the existing `allowed_actions.view`/row-audience decision and `worker_export` action; do not add `worker_view` or `worker_export` capabilities. Keep the existing all-scope + (`entry_admin` OR `change_review`) rule for company-wide view/export, with no default all-scope export.

### Do not change

- No migration history/checksum or schema migration ledger edits.
- No grants to `PUBLIC`, `anon`, or `authenticated`; no broadening of S0 RPC EXECUTE ACLs.
- No global/schema default-privilege changes.
- No production migration or personnel-record read/write. Use ephemeral PostgreSQL/PGlite; use TEST only if separately approved.
- No role manager, policy engine, role bundles, destructive cleanup, or broad SQL rewrite.

### Regression and handoff

Prove on an ephemeral PostgreSQL/PGlite harness: historic in-scope access for a current manager; future/expired/closed/revoked assignment denied; advancing the test clock does not promote non-current rows; revoke is effective on the next request; actor mismatch denied; no field-specific capability can block an in-scope profile; payment write still needs its enclosing action/workflow; export audit/reason/10,000-row limit remain; RPC ACL is service-role-only where exposed and zero for client roles; internal helper remains inaccessible; S0 tests pass; failed transaction leaves both migration and ledger uncommitted. Test any date-dependent logic only in the one-time cutover backfill, not as runtime authorization.

Report migration SQL, function owners and before/after grants, tests and results, any source/runtime assumption not verified, and the exact deploy order. Do not apply to production.

