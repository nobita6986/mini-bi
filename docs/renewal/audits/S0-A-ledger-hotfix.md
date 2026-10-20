# S0-A — migration ledger ACL hotfix

## Scope

Forward-only migration `supabase/migrations/20261020150000_s0_a_schema_migrations_acl.sql` revokes all table privileges on `public.schema_migrations` from `PUBLIC`, `anon`, `authenticated`, and `service_role`. It does not change owner, schema, rows, or historical migration files. The table owner retains implicit rights.

The guarded no-op only accommodates from-scratch test databases where the custom ledger has not yet been created. The supported runner creates the table before it begins applying migration files.

## Existing callers and compatibility

- `scripts/apply-migrations.mjs`: creates `public.schema_migrations`, reads applied versions/checksums, then applies each migration and inserts its checksum row in the same transaction. Its connection comes from `SUPABASE_DB_URL`; pooler URLs are built with `postgres.<ref>`.
- `scripts/lib/t0-operator-import.mjs`, `checkMigrationLedger(client)`: SELECTs applied versions before operator import. The operator uses the same database-config loader. The authorized test project's metadata connection and ledger owner are `postgres`; the actual local config file was not available, so do not assume a separate operator role has owner-equivalent rights.
- The S0-A test verifies an owner-role connection can read and insert the migration record after the REVOKE, the ledger checker sees the required applied set, and the migration validator reports the new migration as APPLIED with the exact source checksum. This exercises the same ledger operations as the runner but does not invoke `apply-migrations.mjs` itself.
- The test verifies a synthetic `service_role` RPC remains callable after the ledger privilege revocation. It does not claim a live production API smoke test.

## Regression test

Added `scripts/s0-a-schema-migrations-acl.test.mjs` and package command `test:s0-a-schema-migrations-acl`, included in the root `test` script and the real-PostgreSQL CI target. It starts with broad table defaults for all four runtime principals, applies the actual migration, writes the version/checksum as the owner, and checks:

1. `anon`, `authenticated`, and `service_role` receive SQLSTATE 42501 for SELECT, INSERT, UPDATE, and DELETE on the ledger.
2. The operator's ledger read/check path continues to work.
3. The migration runner's owner connection can append the correct checksum.
4. A service-role-only RPC still executes.
5. Existing synthetic ledger rows remain unchanged.

PGlite test success is not a substitute for the real-PostgreSQL CI job or approved staging validation.

## T1-B execution status

- `pnpm test:s0-a-schema-migrations-acl` passed on 2026-10-20 (2 tests, 2 passes, 0 failures): one isolated PGlite test and one native PostgreSQL 18 test using the repository's `initdb`/`pg_ctl` pattern. The native test gives runtime roles broad table defaults, runs the actual `apply-migrations.mjs` process against a temporary fixture containing only `public.schema_migrations` and S0-A, verifies the runner records the exact checksum, checks the real `checkMigrationLedger` operator read path, and confirms direct connections as `anon`, `authenticated`, and `service_role` receive SQLSTATE 42501 for SELECT/INSERT/UPDATE/DELETE. The owner retains read/write, and the ACL contains no `PUBLIC` grantee.
- The native test used a uniquely created local cluster and database (`s0_a_<test-process-id>`); the test stopped the cluster and removed its temporary directory. No existing Docker containers were used.
- The local Supabase config and `SUPABASE_DB_URL` are absent. The disposable runner config used only a local trust-authenticated PostgreSQL connection and fake Supabase identifiers. Source inspection confirms production `apply-migrations.mjs` connects through `loadSupabaseConfig()` and `checkMigrationLedger` performs a ledger SELECT, but the real configured operator credential/role has not been verified. Existing metadata evidence in `S0-baseline-runtime-acl.md` reports the ledger owner and metadata connection role as `postgres`.
- T0 scheduled the single S0-A apply after T1-A verified/reconciled the source/runtime ledger at 122/122. The apply used Supabase CLI 2.121.0 with an explicit project ref and succeeded on 2026-10-20; exact command and before/after metadata follow below.

### Authorized test-ref application evidence

- T0 designates `bi2.hrpartner.vn` and Supabase ref `oyykqfxkyqhxgrfntokl` as TEST for this workflow and explicitly authorizes S0 migration/application and testing on that exact target. Read-only Vercel `production` environment inspection confirmed that public `NEXT_PUBLIC_SUPABASE_URL` resolves to `oyykqfxkyqhxgrfntokl.supabase.co`; Vercel labels the deployment/environment `Production`, while the PO designates it TEST. The CLI reported that 11 secret values were not pulled, and the check emitted only the hostname. No other Supabase project or deployment was touched.
- Command: `supabase db query --linked --project-ref oyykqfxkyqhxgrfntokl --file C:\Users\Admin\AppData\Local\Temp\s0-a-apply-oyykqfxkyqhxgrfntokl-20261020.sql --output-format json`. The CLI returned exit code 0. It executed one explicit transaction containing the source migration, ledger insert, a preflight requiring the exact 122-row reconciled ledger and owner session, and a checksum assertion. It did not invoke `db push`, replay migration #122, call application RPCs, or access personnel data.
- Source checksum (the same LF-normalized SHA-256 used by `migrationChecksum()`): `f06317af919d572cc0fe816549d2741c5442c1e6d96371800a452bf4861fd2b4`.
- Before: current/session user and table owner `postgres`; 122 ledger rows; latest version `20261019130000_pre_w2_hf_draft_submission_delete.sql`; S0-A version absent. Raw ACL was `{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`. Effective SELECT and INSERT were true for all three runtime roles; the separate baseline catalog audit recorded effective UPDATE and DELETE as true as well. No direct `PUBLIC` ACL entry was present.
- After (read-only metadata query): current/session user and owner remain `postgres`; 123 ledger rows; latest version is S0-A; one S0-A row has the exact checksum above. Raw ACL is `{postgres=arwdDxtm/postgres}`; no `PUBLIC` ACL entry. Effective SELECT/INSERT/UPDATE/DELETE are all false for `anon`, `authenticated`, and `service_role`, and true for owner `postgres`.
- Permission delta: removed every table ACL privilege (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, and `TRIGGER`) from `anon`, `authenticated`, and `service_role`. No direct `PUBLIC` grant existed before or after. The owner ACL and owner rights remain intact.
- This confirms the operator session used for the apply and the ledger owner retain the required read/write rights. The local `SUPABASE_DB_URL` remains unavailable, so the configured direct connection role for a separate invocation of `scripts/apply-migrations.mjs` was not independently observed against this target; the native PostgreSQL regression did exercise that actual runner with owner credentials. No post-apply write probes were run against shared roles.

## Environment scope and future deployment gate

The migration was applied only after T0 explicitly designated the exact target ref as TEST and scheduled this step, following the 122/122 reconciliation. Vercel's `Production` label and the Product Owner's TEST designation are both retained as evidence rather than inferred from the project name. Do not treat this workflow authorization as permission to touch another ref or deployment. Any future production deployment still requires its own explicit approval and review.


## Exact migration SQL

    do $s0$
    begin
      if to_regclass('public.schema_migrations') is not null then
        execute 'revoke all privileges on table public.schema_migrations'
          || ' from public, anon, authenticated, service_role';
      end if;
    end;
    $s0$;

The source of truth is the migration file listed above; the PGlite test reads and applies that exact file, then records its computed checksum.
