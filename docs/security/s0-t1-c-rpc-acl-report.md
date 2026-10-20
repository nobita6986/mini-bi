# S0-T1-C — RPC ACL inventory and allowlist

**Status:** S0-T1-C applied successfully to the Product Owner-designated TEST ref only; no production migration or application deployment was made.
**Baseline:** `c29adc58ea2b41d2ed66a908f6a66a545952986f`; S0-A is merged in `main` at `60cc1fe2968d6085679599139a951eb98f395e39`. S0-T1-C source was tested from PR #79, commit `8ff8b8a94db7e56c49417c13f87cc0f5afc7d23c`.
**Scope:** Mini BI-owned RPC EXECUTE ACLs in `public` on Supabase ref `oyykqfxkyqhxgrfntokl`, designated TEST by the Product Owner. The migration changes function ACLs and adds its ledger row. It does not change business tables or rows, function ownership, RLS policies, triggers, or default privileges. Its temporary `SET` membership is removed before transaction commit.

## Scope and authorization

- Authorized target: Supabase ref `oyykqfxkyqhxgrfntokl` (Vercel alias `bi2.hrpartner.vn`, labelled Production in Vercel but explicitly designated TEST by the Product Owner). No other ref was used.
- Allowed operations: catalog metadata reads and the single S0-T1-C migration/ledger insert in one guarded transaction. No worker/personnel rows, live RPC invocations, exploit tests, or production configuration changes were performed.
- Application actor resolution remains server-side; the S0-T1-C change only narrows database `EXECUTE` grants.

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
| Authorized TEST project after T1-C apply | 302 / 256 | 0 | 0 | 0 | 140 |

The one open source ACL before T1-C is the trigger-only `ai_report_audit_immutable()`. Before the successful apply, the authorized TEST project's three routines owned by `direct_entry_catalog_bootstrap_executor` also had EXECUTE ACL entries for `PUBLIC`, `anon`, `authenticated`, and `service_role`. The final migration revokes those entries as the owning role, then restores `service_role` only for the allowlisted `direct_entry_catalog_bootstrap_plan` and `direct_entry_apply_catalog_bootstrap`; the private `direct_entry_catalog_bootstrap_projection` remains owner-only. Function owner and role-membership metadata are unchanged. The verified TEST permission delta is `anon` 273→0 (-273), `authenticated` 273→0 (-273), `PUBLIC` 273→0 (-273), and `service_role` 294→140 (-154). In the clean source replay, OID comparison shows 31 service-role grants removed and zero allowlist grants added.

The initial guarded apply stopped and rolled back because those three owner-granted ACLs survived the first version's ordinary REVOKE. Catalog inspection found the grantor was `direct_entry_catalog_bootstrap_executor`; the migration login `postgres` had ADMIN membership but `SET FALSE`. The final migration adds a transaction-scoped, non-inheriting `SET TRUE` membership only when needed, uses it to revoke the owner's ACL rows, removes that exact temporary grant before commit, and leaves the original membership row unchanged. The native PostgreSQL regression exercises this path with a non-superuser runner.

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

No `pg_default_acl` row exists for `direct_entry_catalog_bootstrap_executor`. The three runtime grants attributed to that owner therefore are verified per-object ACL state; their historical creation path is unresolved. S0-T1-C does not change creator defaults. The final native regression and guarded TEST transaction both compare RLS policies, triggers, and all default-ACL metadata before and after.

S0-T1-C deliberately changes no default ACL. Do not change `postgres` or `supabase_admin` global defaults based on this one test-project snapshot: PostgreSQL global function defaults also affect functions created outside `public`, and a schema-local REVOKE cannot cancel the built-in global default PUBLIC EXECUTE. Keep S0-B separate. For each new Mini BI RPC, require an object-specific `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` and only the reviewed server `GRANT` in the same migration. The CI regression applies migrations in version order, inserts the broad-grant simulation immediately before T1-C, then applies later migrations before the final catalog checks; a later Mini BI RPC inheriting broad defaults fails the client/PUBLIC checks, while an unreviewed service grant fails the exact service allowlist comparison. T0 should decide separately whether a dedicated migration-owner role or a narrowly reviewed creator-default change is warranted.

## Regression, integration notes, and recovery

Run the isolated native PostgreSQL test with:

```text
node --test scripts/s0-t1-c-rpc-acl.test.mjs
```

Latest local result: **1 passed, 0 failed**. The harness uses `initdb`/`pg_ctl` in a temporary PostgreSQL 18 cluster and a `pg` client. It applies source migrations in order, models bootstrap-owned broad grants, and runs T1-C as a non-superuser migration runner that has ADMIN but not SET on the executor role. It verifies temporary membership cleanup, exact owner and service allowlist permissions, no client/PUBLIC EXECUTE, unchanged policies/triggers/default ACLs, actor source boundary, and trigger behavior. CI run `39360000473` passed all six PGlite shards, real PostgreSQL, static quality/typecheck/lint/build, and Vercel preview; final report-commit run `39360983034` also passed all six shards, real PostgreSQL, static quality/typecheck/lint, migration validation, build, secret scan, docs checks, and aggregate Quality.

Existing legacy/dev acceptance scripts and database tests still call some removed legacy RPCs with `SET ROLE service_role`, including `scripts/p1.6-w03-db.test.mjs`, `scripts/p1.6-w03-g3-dev-acceptance.mjs`, and W2 portrait-stage tests. They are not current `src` runtime callers; if T0 includes these specific paths after T1-C in CI, update the tests to use their intended test owner path or explicitly decide to retain a tested RPC in the allowlist. Do not silently restore their grants.

The migration has no nested `BEGIN`/`COMMIT`; `scripts/apply-migrations.mjs` owns each migration transaction and inserts the ledger checksum before committing that same transaction. The authorized TEST apply used a guarded single transaction with preconditions for the exact 123-row S0-A ledger, checksum, role, ACL counts, bootstrap membership, and absence of RLS policy dependencies. Postconditions checked ledger checksum, exact 140-routine service allowlist, zero client/PUBLIC EXECUTE, preserved owners/membership, and unchanged policy/trigger/default-ACL snapshots. The committed TEST ledger now has 124 rows with S0-T1-C checksum `7382013e39521601ae1c08de22e7579dc289a8e113ea8c362f8be6ba66e3417f`. If a future ACL decision proves incorrect, use a new forward migration to restore only a reviewed signature/role permission; do not restore the broad snapshot wholesale. No production migration or application deployment was authorized or performed.

## Evidence, findings, and path

### Evidence

| ID | Evidence | Source and reproduction |
|---|---|---|
| E-001 | Source and actor-boundary regression: 302 routines, 256 SECURITY DEFINER; native replay after migration has zero `anon`/`authenticated`/PUBLIC EXECUTE and exactly 140 `service_role` routines. | `scripts/s0-t1-c-rpc-acl.test.mjs`; run `node --test scripts/s0-t1-c-rpc-acl.test.mjs`. |
| E-002 | Full CI run `39360000473` passed six PGlite shards, real PostgreSQL, static quality, typecheck, lint, build, and Vercel preview. | [GitHub Actions run](https://github.com/nobita6986/mini-bi/actions/runs/39360000473). |
| E-003 | Before apply, ref `oyykqfxkyqhxgrfntokl` had 123 ledger rows, latest S0-A checksum `f06317af…`, 302 matching routines, 273 EXECUTE-enabled routines for each client/PUBLIC, 294 for `service_role`, and three executor-owned routines. | Supabase CLI catalog-only query; no RPC invocation or business-row SELECT. |
| E-004 | After apply, ledger is 124 rows, latest migration is `20261020180000_s0_t1_c_rpc_acl_allowlist.sql`, checksum `7382013e…`; ACL counts are `anon=0`, `authenticated=0`, `PUBLIC=0`, `service_role=140`. The three routines remain owned by the executor; plan/apply retain service EXECUTE and projection does not. Original membership remains `postgres → executor`, grantor `supabase_admin`, `ADMIN=true`, `INHERIT=false`, `SET=false`. | Read-only post-apply catalog queries on the same TEST ref; the guarded apply compared policy, trigger, and default-ACL snapshots in-transaction. |
| E-005 | Server actor binding remains `actor-context-repository.ts:13-19` → `p_auth_subject: authSubject`, sourced from `direct-entry-v2.ts:355-377,430`; secret-key service client is `supabase/server.ts:17-21`. | Source inspection and static assertions in `scripts/s0-t1-c-rpc-acl.test.mjs:419-422`. |

### Findings

#### F-001 — Broad RPC EXECUTE ACLs on the TEST database

- severity: high (exposure), status: validated, confidence: high for database grants; PostgREST reachability remains unverified
- evidence_ids: E-003, E-004
- location: `public` Mini BI function/procedure name families; migration `supabase/migrations/20261020180000_s0_t1_c_rpc_acl_allowlist.sql`
- impact: before the migration, `anon`, `authenticated`, and PUBLIC had EXECUTE on 273 of 302 matching routines, including 256 SECURITY DEFINER routines in the family. The migration now limits database EXECUTE to the explicit service-role allowlist. This confirms privilege exposure, not successful data extraction or an exploitable path; no live RPC or personnel data was accessed.
- remediation: keep the 140-signature allowlist reviewed, enforce per-object grants for future routines, and resolve PostgREST schema exposure under separate read-only metadata review.

#### F-002 — Three executor-owned ACLs required grantor-aware repair

- severity: high, status: validated, confidence: high
- evidence_ids: E-003, E-004
- location: `direct_entry_catalog_bootstrap_projection()`, `direct_entry_catalog_bootstrap_plan(uuid,uuid)`, `direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)`
- impact: ordinary REVOKE under the migration login left three owner-granted ACLs in place and caused the first guarded apply to fail; that transaction rolled back. The final migration temporarily obtains `SET` only inside the same transaction and removes its own membership before commit. The existing membership grant and function ownership remain unchanged.
- remediation: retain the non-superuser native regression and require transactional migration execution; do not broaden the persistent role membership.

#### F-003 — Future default-grant cause remains unresolved

- severity: medium, status: accepted risk for separate S0-B review, confidence: high that no executor `pg_default_acl` row exists; historical cause of its ACL entries unresolved
- evidence_ids: E-004
- location: `pg_default_acl` and the executor-owned routine ACLs
- impact: global/schema defaults for `postgres` and `supabase_admin` remain broad for future objects; S0-T1-C changed no defaults. A future Mini BI function still needs a same-migration REVOKE and narrow GRANT, with CI enforcement.
- remediation: keep S0-B separate and decide on creator-specific policy after independent production metadata and creator attribution; no global default was changed in S0.

### Path

#### P-001 — Server-side API call path protected by the database allowlist

- path_type: callflow
- start: authenticated UI request to a Mini BI server API
- goal: invoke an approved Mini BI database routine under the existing server authorization checks
- steps:
  1. The API resolves the actor from the authenticated server session; evidence E-005.
  2. The repository uses `createServiceSupabaseClient()` and passes session-derived actor values to the RPC; evidence E-005.
  3. `service_role` can execute only the 140 allowlisted routines; direct `anon`, `authenticated`, and PUBLIC EXECUTE is zero after S0-T1-C; evidence E-001 and E-004.
  4. Whether PostgREST exposes `public` at runtime was not confirmed; no live RPC invocation was made. This remains a reachability limit, not an inferred pass.
- residual_risks: broad creator defaults remain; PostgREST exposure and application-level workflow smoke tests were not verified in this task.

### Timeline

- 2026-10-20: S0-A merged and applied to the authorized TEST ref; ledger reached 123 rows.
- 2026-10-20: first T1-C guarded transaction failed its ACL postcondition and rolled back; metadata identified three bootstrap-owner grants.
- 2026-10-20: migration and regression were updated; native test and CI run `39360000473` passed.
- 2026-10-20: T1-C applied in a guarded transaction to the same TEST ref; ledger reached 124 and metadata postconditions passed.
