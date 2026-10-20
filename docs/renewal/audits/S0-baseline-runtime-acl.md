# S0 baseline and runtime ACL findings

Collected 2026-10-20 for S0. Repository work is isolated on branch `codex/s0-schema-migrations-acl` at the selected main baseline.

## Baseline and deployment identity

- Verified: `origin/main` and the requested baseline both resolve to `c29adc58ea2b41d2ed66a908f6a66a545952986f`. The user checkout at `C:\\CodeApp\\BI` was not changed; its local `main` had unrelated uncommitted work.
- Verified: Vercel production project `mini-bi` serves `https://bi2.hrpartner.vn`. Its configured `NEXT_PUBLIC_SUPABASE_URL` identifies ref `oyykqfxkyqhxgrfntokl`, whose Supabase project name is `bi-vercel-test`.
- Verified: this is the same ref previously used as the R0.5 staging snapshot. The separately named Supabase project `mini-bi` (ref `kiamyvfymxdattohfwmt`) is not configured for this Vercel project. The Product Owner explicitly designates `oyykqfxkyqhxgrfntokl` and `bi2.hrpartner.vn` as TEST; the Vercel `Production` label describes deployment configuration only.
- Verified: no secret values were printed or written to these reports. Vercel reported that secret environment values were not pulled.
- Limitation: there is no separately identified staging ref available in the current configuration. No staging migration or write was attempted.

## Migration source versus ledger (baseline snapshot before reconciliation)

- At baseline `c29adc58ea2b41d2ed66a908f6a66a545952986f`, source contains 122 migration files. The read-only ledger snapshot contains 121 rows through `20261019120000_hf_worker_directory_filtered_summary.sql`; all 121 recorded checksums matched source, with no ledger-only or checksum-mismatch entries.
- The only source migration absent from the ledger is `20261019130000_pre_w2_hf_draft_submission_delete.sql` (#122).
- Verified catalog drift: that migration's effects are already present on ref `oyyk...`: the new `submission_id` column, `direct_entry_submission_object_cleanup` table, four RPCs, and trigger guard. The source migration uses non-idempotent `ALTER TABLE ... ADD COLUMN` and `CREATE TABLE` statements. We did not run it. A normal migration-runner pass would attempt it because its ledger row is absent and is expected to fail on the already-present objects.
- At the baseline snapshot this was an unresolved deployment blocker. T1-A later reconciled it on the authorized TEST ref as documented below; #122 DDL was not replayed.

## Read-only ACL snapshot before S0-A

Catalog queries ran in an explicit read-only transaction with `current_user = session_user = postgres`. No employee, Direct Entry, or business rows were read.

| Object | Snapshot |
|---|---|
| `public.schema_migrations` | Owner `postgres`; RLS and FORCE RLS off; 121 rows. `PUBLIC` has no direct ACL entry, but effective SELECT/INSERT/UPDATE/DELETE are true for `anon`, `authenticated`, and `service_role` through explicit grants. |
| Migration owner/operator | The metadata connection was `postgres`. The checked-in runner reads `SUPABASE_DB_URL`; with a Supabase pooler it builds the username as `postgres.<ref>`. The local deployment config file was unavailable, so the exact runtime credential used by the operator has not been independently verified. |
| Schema defaults | No database-wide `pg_default_acl` rows were present. Schema-specific defaults exist for creators `postgres` and `supabase_admin`, including direct runtime-role grants for functions, tables, and sequences. These do not by themselves explain PUBLIC's built-in function EXECUTE default. |
| Direct Entry functions | 264 functions in the inspected schema; 234 are SECURITY DEFINER. Effective EXECUTE was true for 235 functions as `anon`, 235 as `authenticated`, 256 as `service_role`, and 235 through `PUBLIC`. This broad existing posture is S0-B scope, not changed by S0-A. |
| #122 routines | Four RPCs are SECURITY DEFINER, owned by `postgres`, with pinned `search_path = pg_catalog, public` and EXECUTE only for `service_role`. The trigger guard has no runtime-role EXECUTE. The cleanup table has RLS and FORCE RLS enabled and no effective runtime SELECT/INSERT grant. |

The 13:00 migration's ACLs were already narrow; the ledger ACL was the confirmed S0-A issue.

## PostgREST endpoint check

A GET-only request to the production ref's REST root using the configured public publishable key returned `401 Invalid API key`; no schema document or data was read. Cause is unconfirmed (the inspected configuration/build may differ from the active runtime). This does not prove that PostgREST is unreachable or that exposed RPCs are safe. A fresh metadata-only check after configuration is corrected is required; do not use worker data or exploitation probes.

## Evidence paths

- `scripts/apply-migrations.mjs`: creates the ledger before reading it and inserts checksum rows after each migration.
- `scripts/lib/load-supabase-config.mjs`: resolves the database URL and pooler username.
- `scripts/lib/t0-operator-import.mjs`, `checkMigrationLedger`: reads the ledger before operator import checks.
- `supabase/migrations/20261019130000_pre_w2_hf_draft_submission_delete.sql`: source for the unledgered #122 objects and non-idempotent DDL.
- `supabase/migrations/20261020150000_s0_a_schema_migrations_acl.sql`: S0-A grant change.

## Finding classification

- Verified: baseline/ref identity, source/ledger count and checksums, catalog ACLs, object ownership, RLS state, and #122 catalog effects described above.
- Unresolved: why #122 objects exist without its migration ledger row; which exact credential the active operator uses; whether the active Vercel build currently has the same Supabase URL/key pairing as the inspected environment.
- Not tested: production writes, RPC invocation, employee data access, or active exploitability.


## Reconciliation with the R0.5 record

The original checkout at `C:\CodeApp\BI` retains `docs/renewal/audits/R0.5-baseline-delta.md` and `R0.5-staging-metadata.json`; I read those existing reports without copying or modifying them. They identify the same ref `oyykqfxkyqhxgrfntokl` as staging and record 121/121 migrations at the earlier `593774e` baseline. The current Vercel production environment resolves to that same ref. The prior snapshot therefore was not an independent production/staging comparison; it is a historical snapshot of the project now configured for production. At `c29adc58`, source has one additional migration while the live ledger remains at 121.

The four #122 RPCs whose ACL was inspected are `direct_entry_claim_submission_object_cleanup(uuid, integer)`, `direct_entry_complete_submission_object_cleanup(uuid, uuid)`, `direct_entry_create_full_profile_batch_with_portrait_stages(uuid, uuid, text, jsonb, text, uuid[])`, and `direct_entry_delete_draft_submission(uuid, uuid, uuid, integer, text)`. Each is owned by `postgres`, SECURITY DEFINER, pinned to `pg_catalog, public`, and executable by `service_role` only.

## Default-ACL causality

Verified: broad schema-specific defaults and broad effective per-object ACLs coexist. Hypothesis: these defaults contributed to permissive ACLs on functions created by those roles. PostgreSQL catalog ACL state does not identify whether each individual grant came from a default ACL or an explicit migration GRANT, so the cause of each existing grant is not attributed. Compare migration source, grantor/ACL metadata, and deployment history before changing defaults.

## S0 execution update (2026-10-20)

- T1-A compared the #122 source checksum and catalog effects, then recorded the verified checksum in the custom ledger without replaying DDL. The reconciled ledger was 122/122 before S0-A.
- S0-A was applied only to the PO-authorized TEST ref. The custom ledger is now 123 rows; migration `20261020150000_s0_a_schema_migrations_acl.sql` has checksum `f06317af919d572cc0fe816549d2741c5442c1e6d96371800a452bf4861fd2b4`.
- After S0-A, `public.schema_migrations` remains owned by `postgres` with raw ACL `{postgres=arwdDxtm/postgres}`. Effective SELECT/INSERT/UPDATE/DELETE are false for `anon`, `authenticated`, and `service_role`; owner rights remain. No ledger rows were deleted or rewritten.
- S0-T1-C is prepared in PR #79 but was not yet applied at the time of this snapshot. Therefore the RPC ACL numbers above remain the pre-C runtime state; no direct live RPC was invoked.
- Main advanced to `81358b7243747c0c6b02f0c9a87fe126fdf1943a` when T1-A PR #77 merged. PRs #78/#79 and CI status are recorded in `S0-T0-acceptance.md`.

## Final S0-T1-C TEST metadata (2026-10-20)

The earlier sections retain their timestamped baseline snapshots. After S0-T1-C was applied to the same PO-designated TEST ref, read-only catalog verification found 302 matching routines (256 `SECURITY DEFINER`), with effective `anon=0`, `authenticated=0`, explicit PUBLIC EXECUTE `=0`, and effective `service_role=140`. The 140 grants equal the migration's reviewed allowlist. The ledger is at 124 rows, latest version `20261020180000_s0_t1_c_rpc_acl_allowlist.sql`, checksum `7382013e39521601ae1c08de22e7579dc289a8e113ea8c362f8be6ba66e3417f`. S0-A checksum remains `f06317af919d572cc0fe816549d2741c5442c1e6d96371800a452bf4861fd2b4`.

The final migration removed the three broad grants on routines owned by `direct_entry_catalog_bootstrap_executor`. The owner-only projection remains private; plan/apply have only executor-owner and `service_role` EXECUTE. The original postgres-to-executor membership remains unchanged, and no `pg_default_acl` row exists for the executor. Post-apply policies, triggers, and default ACL metadata matched their in-transaction snapshots. The reason those per-object grants originally existed remains unresolved.

The initial attempt failed its guard and rolled back without changing the ledger or ACLs. After the migration was fixed and regression-tested, a single guarded TEST transaction applied it successfully. No production metadata or PostgREST reachability was verified.
