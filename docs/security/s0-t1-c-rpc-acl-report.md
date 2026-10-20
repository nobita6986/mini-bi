# S0-T1-C — RPC ACL inventory and allowlist

**Status:** implementation candidate for T0 review; no shared database change made.
**Baseline:** `c29adc58ea2b41d2ed66a908f6a66a545952986f` on `codex/s0-t1-c-rpc-acl`.
**Scope:** Mini BI-owned RPC EXECUTE ACLs in `public`. The migration does not alter tables, data, ownership, policies, triggers, or default privileges.

## Verified caller evidence

The current application invokes RPCs through server-side repositories. These use `createServiceSupabaseClient()` (`src/lib/supabase/server.ts:17`), which requires `SUPABASE_SECRET_KEY` (`:9-21`). The migration leaves that server-only service-role boundary intact and adds no client-role EXECUTE grants.

- Direct Entry resolves actor context in `src/lib/direct-entry/actor-context-repository.ts:13-19`; it passes `p_auth_subject: authSubject`. The actor is sourced from `input.session.auth_subject` in `src/lib/auth/direct-entry-v2.ts:355-377,430`.
- Reporting calls `direct_entry_reporting_scoped_facts` and `direct_entry_reporting_scoped_options` from server-only modules (`src/lib/reporting/p2-w04a-reporting-server.ts:65-75`, `src/lib/reporting/p2-w04a-options-server.ts:39-42`); team reporting calls `direct_entry_reporting_team_drill_down` (`src/lib/reporting/p2-w05b-team-reporting-server.ts:101-102`). Actor UUIDs come from the server-resolved actor object.
- AI report and provider configuration repositories call through the same service client (`src/lib/ai/gateway/server/repository.mjs:10,19`, `src/lib/ai/gateway/server/review.mjs:9,25`, `src/lib/ai-config/server/store.mjs:12,18`). Admin, worker directory/export, and portrait-stage repositories also use server-side `.rpc()` wrappers.
- The guarded production catalog bootstrap script directly invokes `direct_entry_catalog_bootstrap_plan` and `direct_entry_apply_catalog_bootstrap` (`scripts/p1.6-production-catalog-bootstrap.mjs:69-90`). Their separate bootstrap executor grant and owner are preserved.
- The DEV-only Daily Recruitment fixture script calls `replace_daily_recruitment_breakdown_snapshot_v02` and `record_recruitment_source_failure_v01` (`scripts/check-daily-recruitment-fixtures.mjs:155-159`). Their invoker-chain helper functions are included because the invoker path needs EXECUTE on those helpers.
- The worker portrait cleanup operator calls its service-role repository RPCs (`scripts/reap-w2-s1-portrait-stages.mjs:20,30`).

The explicit SQL list contains 140 signatures: 128 current application/server RPCs (including the two Daily Recruitment entry points), two guarded catalog-bootstrap operator RPCs, and ten Daily Recruitment invoker-chain helpers. The migration is the authoritative exact signature list. Every allowlisted signature resolved in PostgreSQL and already had service-role EXECUTE in the selected source migration chain; the change adds no service-role permissions beyond that source ACL set.

## ACL evidence and change

### Authorized test-project metadata

The following was collected with catalog-only SELECTs against the authorized test project ref `oyykqfxkyqhxgrfntokl`. No function was invoked and no business table rows were read. This is **not production evidence**.

The source replay and test-project inventory use the same per-routine ACL snapshot shape as the regression: matching `public` functions/procedures, `has_function_privilege` for `anon`, `authenticated`, and `service_role`, and an explicit `aclexplode` check for `PUBLIC`. Both use the migration's exact routine-name pattern. Counts are:

| Evidence state | Routines / `SECURITY DEFINER` | `anon` effective EXECUTE | `authenticated` effective EXECUTE | `PUBLIC` explicit EXECUTE | `service_role` effective EXECUTE |
| --- | ---: | ---: | ---: | ---: | ---: |
| Native source replay before T1-C | 302 / 256 | 1 | 1 | 1 | 171 |
| Authorized test project observed before T1-C | 302 / 256 | 273 | 273 | 273 | 294 |
| Native source replay after T1-C | 302 / 256 | 0 | 0 | 0 | 140 |
| Test project projected after T1-C (not applied) | 302 / 256 | 0 | 0 | 0 | 140 |

The one open source ACL is the trigger-only `ai_report_audit_immutable()`. The authorized test project's direct ACL inventory also has three EXECUTE entries for `direct_entry_catalog_bootstrap_executor`, which this migration preserves. The post-migration test-project row is a projection from the verified current snapshot and migration semantics; no shared database was changed. Exact test-project permission delta if reviewed and applied: `anon` 273→0 (-273), `authenticated` 273→0 (-273), `PUBLIC` 273→0 (-273), and `service_role` 294→140 (-154). Owner and bootstrap-executor permissions are preserved. In the clean source replay, OID comparison shows 31 service-role grants removed and zero allowlist grants added.

The 31 removed source service-role signatures are:

```text
ai_provider_config_audit_immutable()
ai_provider_config_public_json(ai_provider_configs)
ai_report_audit_immutable()
direct_entry_append_document_event(uuid,integer,text,text,integer,text)
direct_entry_apply_employment_status(uuid,uuid,uuid,integer,text,date,text,text,text)
direct_entry_complete_worker_portrait_stage(uuid,uuid,uuid,text,uuid,uuid)
direct_entry_correct_latest_status(uuid,uuid,uuid,integer,integer,text,date,text,text,text)
direct_entry_create_document_metadata(uuid,uuid,uuid,integer,text,text,text,bigint,text,text)
direct_entry_create_draft_row(uuid,uuid,uuid,integer,jsonb,text)
direct_entry_create_worker_portrait_stage_idempotent(uuid,uuid,uuid,text,bigint,text,text)
direct_entry_grant_project_team_scope(uuid,uuid,text,uuid,integer,date,text,text)
direct_entry_national_id_canonical_audit()
direct_entry_read_audit(uuid,uuid,uuid,integer)
direct_entry_reporting_authorized_entries(uuid,uuid)
direct_entry_reporting_cutoff()
direct_entry_reporting_de_options_scoped(uuid,uuid)
direct_entry_reporting_dim_key(text)
direct_entry_reporting_employment_display(text)
direct_entry_reporting_employment_key(text)
direct_entry_reporting_pre_cutover_blocker_count()
direct_entry_reporting_reconciliation_totals()
direct_entry_reporting_recruiter_alias_key(uuid,date)
direct_entry_reporting_recruiter_provider_key(uuid,date)
direct_entry_reporting_resolve_audience(uuid,uuid)
direct_entry_reporting_source_id()
direct_entry_reviewer_bundle_capabilities()
direct_entry_revoke_project_team_scope(uuid,uuid,uuid,integer,date,text,text)
direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)
direct_entry_w04_assert_display_name_unchanged(jsonb,jsonb)
direct_entry_w04_worker_details_allowed(jsonb)
set_updated_at()
```

**Classification:** the four audit/update functions (`ai_provider_config_audit_immutable`, `ai_report_audit_immutable`, `direct_entry_national_id_canonical_audit`, `set_updated_at`) are trigger functions; PostgreSQL does not check their EXECUTE ACL when an existing trigger fires. The report helper functions are called inside database reporting code or by owner-authenticated maintenance scripts; no current application `.rpc()` caller was found for them. The unused reporting blocker helper is only a constant/reader helper with no runtime caller. The old `direct_entry_*` endpoints and single-scope/7-argument revoke overload appear in legacy or development acceptance/database tests, but not in current `src` server repositories. See the regression caveat below before wiring those old acceptance paths into CI.

The migration uses a dynamic REVOKE only for Mini BI-owned name families in `public`, then grants EXECUTE to the explicit 140-signature allowlist. It retains owners, the catalog-bootstrap executor, unrelated public-schema functions, and all table/schema ACLs. The target name families are `direct_entry_*`, `ai_report_*`, `ai_provider_config_*`, the named Daily Recruitment routines, and `set_updated_at`.

## RLS, triggers, actor binding, and exposure

- The native test checks `pg_depend` and finds no RLS policy directly depends on a matching routine whose client EXECUTE grant is removed. It compares policy definitions/roles and trigger bindings immediately before and after the migration.
- The regression updates a scratch-only row as `service_role` to verify the existing `set_updated_at` trigger still fires without direct EXECUTE on its trigger function. A second scratch-only trigger verifies the append-only audit guard still rejects mutation. No application row is used.
- The regression statically checks the server actor binding: the actor-context repository sends the authenticated server-session subject, and the session resolver binds the `auth_subject` from its session input. This ACL change makes those RPCs server-only; it does not move actor identity to client input.
- PostgREST exposure is **unverified**. In the test project, `current_setting('pgrst.db_schemas', true)` and `current_setting('pgrst.db_extra_search_path', true)` return `NULL`; the `authenticator` database role settings expose no `pgrst.db_schemas` entry, and this checkout has no `supabase/config.toml`. The externally managed API schema setting cannot be inferred from those catalog values. Since the allowlisted routines are in `public`, they are reachable through PostgREST only if the project exposes `public`; no live RPC call was made.

## Default-privilege finding and recommendation (separate S0-B)

Catalog metadata on the authorized test project shows schema-specific `pg_default_acl` entries in `public` (`defaclnamespace = public`) for **both** `postgres` and `supabase_admin` (`defaclrole`):

```text
postgres functions:      {postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres}
postgres tables:         {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
supabase_admin functions:{postgres=X/supabase_admin, anon=X/supabase_admin, authenticated=X/supabase_admin, service_role=X/supabase_admin}
supabase_admin tables:   {postgres=arwdDxtm/supabase_admin, anon=arwdDxtm/supabase_admin, authenticated=arwdDxtm/supabase_admin, service_role=arwdDxtm/supabase_admin}
```

The creator-role evidence is the `pg_default_acl.defaclrole` value: the `public` function/table default rows are defined for `postgres` and separately for `supabase_admin` (not a global row). Of the 302 matching routines, 299 are owned by `postgres` and the three catalog-bootstrap routines are owned by `direct_entry_catalog_bootstrap_executor`. `scripts/apply-migrations.mjs` applies each migration over its configured PostgreSQL connection (`scripts/apply-migrations.mjs:86-92`) without issuing `SET ROLE`; when a pooler host is configured, `scripts/lib/load-supabase-config.mjs:98-100` builds the connection as `postgres.<project-ref>`. Together, the default-ACL role, routine ownership distribution, and migration connection configuration are evidence that ordinary Mini BI migrations create routines as `postgres` in the observed test project. They do not show that Mini BI uses the `supabase_admin` defaults, nor prove production has matching defaults.

S0-T1-C deliberately changes no default ACL. Do not change `postgres` or `supabase_admin` global defaults based on this one test-project snapshot: PostgreSQL global function defaults also affect functions created outside `public`, and a schema-local REVOKE cannot cancel the built-in global default PUBLIC EXECUTE. Keep S0-B separate. For each new Mini BI RPC, require an object-specific `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` and only the reviewed server `GRANT` in the same migration. The CI regression applies migrations in version order, inserts the broad-grant simulation immediately before T1-C, then applies later migrations before the final catalog checks; a later Mini BI RPC inheriting broad defaults fails the client/PUBLIC checks, while an unreviewed service grant fails the exact service allowlist comparison. T0 should decide separately whether a dedicated migration-owner role or a narrowly reviewed creator-default change is warranted.

## Regression, integration notes, and recovery

Run the isolated native PostgreSQL test with:

```text
node --test scripts/s0-t1-c-rpc-acl.test.mjs
```

Latest result: **1 passed, 0 failed**. The harness uses `initdb`/`pg_ctl` in a temporary cluster and a `pg` client. It creates the migration runner's `public.schema_migrations` table first, applies prior migrations in version order (including S0-A when that migration is integrated before T1-C), applies T1-C in a runner-owned transaction, then applies any later migrations before final ACL checks. It verifies allowlist resolution, no additions beyond source service grants, exact effective service permissions, client/PUBLIC denial, unchanged RLS/trigger/default metadata around T1-C, and the scratch trigger behavior. CI wiring is intentionally left to T0.

Existing legacy/dev acceptance scripts and database tests still call some removed legacy RPCs with `SET ROLE service_role`, including `scripts/p1.6-w03-db.test.mjs`, `scripts/p1.6-w03-g3-dev-acceptance.mjs`, and W2 portrait-stage tests. They are not current `src` runtime callers; if T0 includes these specific paths after T1-C in CI, update the tests to use their intended test owner path or explicitly decide to retain a tested RPC in the allowlist. Do not silently restore their grants.

The migration has no nested `BEGIN`/`COMMIT`; `scripts/apply-migrations.mjs` owns each migration transaction and inserts the ledger checksum before committing that same transaction. This keeps the ACL change and its migration-ledger record atomic. If an isolated/staging apply fails, that transaction rolls back. If a deployed ACL decision proves incorrect, use a new forward migration to restore only the reviewed signature/role permission, then rerun the native regression; do not restore the broad ACL snapshot wholesale. Production is not authorized for this change, and no migration was applied to any shared or production database.
