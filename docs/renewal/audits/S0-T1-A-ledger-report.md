# S0 T1-A — migration ledger reconciliation report

**Status:** Database ledger reconciliation completed on the T0-authorized test project; read-only post-checks completed after S0-A. Runner transaction defect reproduced on an isolated PostgreSQL container. Runner code remains unchanged.

## Scope and baseline

- **Authorized environment designation:** Supabase **TEST**, project ref `oyykqfxkyqhxgrfntokl`. All remote queries in this report targeted only this ref. No personnel rows or row contents were read; the only data-derived check was the approved aggregate backfill verification.
- **Code baseline:** `c29adc58ea2b41d2ed66a908f6a66a545952986f`, branch `codex/s0-t1-a-ledger`.
- **Deployment identity:** The Vercel project `mini-bi` serving `bi2.hrpartner.vn` is labelled `target=production`, and its `production` environment's public `NEXT_PUBLIC_SUPABASE_URL` hostname is `oyykqfxkyqhxgrfntokl.supabase.co`, matching the PO-designated TEST ref. The read-only `vercel env run` check emitted only that hostname; Vercel reported that 11 secret values were not pulled. The TEST classification comes from the PO; the Vercel label remains a deployment-risk caveat.
- The T1-A checkout remains at the 122-file baseline and does not contain S0-A migration #123. T0 separately confirmed that the S0-A source worktree contains `20261020150000_s0_a_schema_migrations_acl.sql` and that `supabase migration list` there reports it local-only. No rebase, checkout, or branch change was made.

## Source and ledger state

| Snapshot | Source migrations | `public.schema_migrations` | `supabase_migrations.schema_migrations` |
|---|---:|---|---|
| Before T1-A reconciliation | 122; latest #122 `20261019130000_pre_w2_hf_draft_submission_delete.sql` | 121 rows through #121; #1–#121 checksums matched source, no extra rows; #122 missing | One row, version `20261019130000`, name `pre_w2_hf_draft_submission_delete`, with 35 stored statements |
| After T1-A reconciliation, before S0-A | 122 | 122/122; no missing, extra, or checksum-mismatch rows | Still one row for #122 |
| Read-only post-check after S0-A | T1-A checkout still has 122; T0’s S0-A source checkout has #123 | 123 rows; latest `20261020150000_s0_a_schema_migrations_acl.sql` | One row, still #122; no #123 row |

Source #122 normalized SHA-256, using the repository’s CRLF-normalizing checksum function in `scripts/lib/migration-validation.mjs:5-10`, is `2a4d37d591d8aa88d7ab00a9ad0696723e49a4577f430f237b86a619f5d2f15c`. The native Supabase row for #122 records 35 statements and statements MD5 `b1784fda8b43054f9184d663c37e3cce`.

After S0-A, the custom ledger records #123 with checksum `f06317af919d572cc0fe816549d2741c5442c1e6d96371800a452bf4861fd2b4`. The native Supabase ledger has no `20261020150000` row. The T1-A checkout’s `supabase migration list --linked --project-ref oyykqfxkyqhxgrfntokl` showed 122 local entries and one remote entry (#122); T0 confirmed that the S0-A source checkout shows #123 local-only. No repair or write to `supabase_migrations.schema_migrations` was attempted.

## #122 effect evidence

The migration source at `supabase/migrations/20261019130000_pre_w2_hf_draft_submission_delete.sql` is transaction-wrapped (`begin;` line 1, `commit;` line 572). Its two backfill statements are at lines 48 and 54. The approved aggregate-only checks found:

- `ATTACHED`: 7 eligible rows; 0 rows still mismatched after backfill.
- `CLAIMED`: 0 eligible rows; 0 rows still mismatched after backfill.

No row identifiers or contents were returned. The source and runtime catalog fingerprint also showed the `DELETED` state constraint, the submission FK/guard trigger (`:11-46`), cleanup table (`:64`), and delete/cleanup RPCs (`:242`, `:448`, `:492`). The four relevant SECURITY DEFINER RPCs are owned by `postgres`, pin `search_path`, and have execution restricted to `service_role` in #122. The list/read own-submission functions are changed to hide `DELETED` rows in the guarded rewrite block at `:515-548`.

The Supabase-native ledger’s #122 row, 35-statement record, exact resulting catalog fingerprint, and the aggregate backfill checks together support that #122 had already run. Replaying #122 was therefore not safe or necessary.

## Guarded custom-ledger insert and verification

T0 approved one narrowly scoped reconciliation after reviewing the evidence. On the authorized test ref only, a single transaction-scoped `DO` block:

1. Locked `public.schema_migrations` in `EXCLUSIVE` mode.
2. Aborted if the #122 version already existed, regardless of checksum, to avoid overwriting a conflicting row.
3. Asserted the ledger still had exactly 121 rows.
4. Inserted exactly one row for `20261019130000_pre_w2_hf_draft_submission_delete.sql` with checksum `2a4d37d591d8aa88d7ab00a9ad0696723e49a4577f430f237b86a619f5d2f15c`.

No migration DDL was replayed, no other ledger row was changed, and no migration history was edited. The subsequent read-only verification returned 122 source files, 122 ledger rows, no missing/extra/checksum-mismatch versions, owner `postgres`, `relrowsecurity=false`, and `relforcerowsecurity=false`. #122 was recorded at `2026-10-20 08:27:00.348069+07:00`.

## S0-A ACL and PostgREST metadata post-check

After T0 applied S0-A, read-only metadata checks on the same test ref returned:

- `public.schema_migrations` owner: `postgres`; ACL: `{postgres=arwdDxtm/postgres}`.
- Effective table privileges: `anon=false`, `authenticated=false`, `service_role=false`, current SQL role (`postgres`): `true`.
- `supabase_migrations.schema_migrations`: one row, latest #122; no #123 row.
- `pg_db_role_setting` contained no `pgrst.db_schemas` or `pgrst.db_extra_search_path` entries for any role/database. `pg_roles.rolconfig` for `authenticator` had no matching settings.

The PostgREST result is limited to PostgreSQL role/database metadata. It does not prove the effective PostgREST server configuration if that configuration is supplied outside PostgreSQL. No RPC was invoked.

## Which migration ledger is authoritative?

Repository paths use the custom public ledger:

- `package.json:11` maps `db:migrate` to `node scripts/apply-migrations.mjs`.
- `scripts/apply-migrations.mjs:54-63` creates and reads `public.schema_migrations`; `:86-96` applies each file and inserts its checksum into that ledger.
- `scripts/lib/migration-validation.mjs:48-75` performs read-only drift/checksum checks against `public.schema_migrations`.
- `scripts/lib/t0-operator-import.mjs:420-424` checks the same ledger for operator-import readiness.
- CI runs `pnpm db:migrate -- --offline` (`.github/workflows/ci.yml:48-49`). The production release wrapper uses the runner’s `--dry-run` to check the custom ledger before release (`deploy/vps/bi-release`); it does not apply SQL. The separate `deploy/vps/bi-migrate` invokes the custom runner to apply it.
- No repository deployment path found in this baseline invokes `supabase migration up`, `supabase db push`, or a native-ledger repair.

**Recommendation:** Treat `public.schema_migrations` as authoritative for this repository’s current deployment workflow. Do not add #123 to Supabase’s native ledger as an isolated repair: the native table already contains only #122 while the custom table contains all 123 migrations, so adding one row would not reconcile the histories and would falsely suggest that the native CLI is the deployment authority. If the project later adopts the Supabase CLI migration workflow, reconcile/import the full historical state through a separately reviewed procedure.

## Runner nested-transaction finding

`scripts/apply-migrations.mjs:86-96` starts a transaction, sends the complete SQL file, inserts the custom-ledger row, and commits. Migration #122 contains its own top-level `begin;` and final `commit;` (`:1`, `:572`). A nested `BEGIN` does not create a nested transaction in PostgreSQL; the file’s `COMMIT` closes the runner’s transaction before its ledger insert.

This was reproduced on a disposable `postgres:16-alpine` container with `--network none`, no published port, and no persistent volume. The one-session SQL sequence mirrored the runner: create an effect table and a `NOT NULL` ledger; runner `BEGIN`; migration `BEGIN; INSERT effect; COMMIT;`; force the subsequent ledger insert to fail with `NULL`; then execute the runner’s `ROLLBACK`. Observed output included:

```text
WARNING:  there is already a transaction in progress
INSERT 0 1
COMMIT
ERROR:  null value in column "checksum" ... violates not-null constraint
WARNING:  there is no transaction in progress
ROLLBACK
migration_effect_rows = 1
custom_ledger_rows = 0
```

The container was removed after the check. This proves the runner can leave a migration’s effect committed while the custom ledger write fails. It does not prove this caused the #122 ledger omission; the native Supabase #122 record and catalog evidence instead show that #122 was applied through a different path.

**Smallest safe follow-up:** add a regression test using ephemeral PostgreSQL that forces the ledger insert to fail and asserts the migration effect rolls back. Then, in a separate reviewed runner change, strip only a validated outer `BEGIN;` and final `COMMIT;` from the SQL sent to PostgreSQL, and keep the migration body plus custom-ledger insert within the runner transaction. Continue calculating the checksum over the original migration bytes. Reject any wrapper format that is not explicitly recognized. Do not edit historical migrations. No runner code was changed in T1-A because SQL-wrapper normalization needs a separate, tested review.

## Branch-local test changes and verification

The branch changes only migration-focused tests plus this report. Hard-coded total-count assertions now require the known #122 baseline filename; tail-relative position assertions now check the existing migration’s absolute index, which remains stable when new files append. Tests that apply a historical prefix stop at a named migration rather than using `slice(0, -N)`. No application code, migration source, RPC ACL, or schema source was changed.

The syntax/diff checks were:

```powershell
$files = @(git diff --name-only -- scripts | Where-Object { $_ -like '*.test.mjs' })
foreach ($file in $files) {
  node --check $file
  if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $file" }
}
git diff --check
```

Result: `node --check` passed for all 58 modified test files; `git diff --check` passed. The full Node/PGlite test suite and CI were not run because this worktree has no `node_modules`; those results remain unverified. The ephemeral PostgreSQL transaction reproduction passed as described above. No commit was created because the repository tests could not be run to completion.

## Remaining decisions and risks

1. Confirm the production-vs-test identity conflict for this project ref from deployment configuration before any production change. This T1-A run followed T0’s explicit TEST designation only.
2. Decide whether the project will continue using `public.schema_migrations` or intentionally move to the Supabase-native migration ledger; do not repair the latter ad hoc.
3. Review the runner transaction-boundary regression and mitigation in a separate change before the next migration application.
4. Run CI and the affected migration/database tests in a fully provisioned checkout before merging this branch.
5. Resolve effective PostgREST exposed schemas from the deployed PostgREST configuration source; PostgreSQL role metadata alone was inconclusive.

No other Supabase ref was queried. The PO-designated TEST ref matches the Vercel project's configured `NEXT_PUBLIC_SUPABASE_URL`, although the Vercel target/environment is labelled `production`; therefore the deployment’s real-world use follows the PO designation and remains an operational caveat. No personnel rows were read or changed. T1-A did not apply S0-A SQL; its only persistent write was the T0-approved single-row #122 custom-ledger reconciliation on the ref designated TEST.
