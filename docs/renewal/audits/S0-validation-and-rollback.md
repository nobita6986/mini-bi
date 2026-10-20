# S0 validation status and recovery plan

## Validation

- Initial S0 baseline: `c29adc58ea2b41d2ed66a908f6a66a545952986f`; main after PR #78: `60cc1fe2968d6085679599139a951eb98f395e39`; PR #79 is ready for T0-authorized merge after full CI run `39360983034` passed on commit `17c7198`.
- PR #78 S0-A is merged. CI run `39357744549` passed all six PGlite shards, the real-PostgreSQL job, static quality/build, and Vercel.
- Local S0-A regression passed 2/2 against PGlite and native PostgreSQL 18. The GitHub PostgreSQL test now uses a temporary Unix-socket directory; CI verified this fix.
- Local T1-C native PostgreSQL ACL regression passed 1/1; i04c 18/18; S04C inventory 3/3; W05 reporting 16/16; W05 review authority 8/8.
- PR #79 CI run `39360000473` passed all code checks. Final report-commit run `39360983034` also passed six PGlite shards, native PostgreSQL, static quality, typecheck, lint, migration validation, build, secret scan, docs checks, and aggregate Quality.
- Authorized TEST preflight found 123 rows/latest S0-A. The guarded T1-C transaction committed; read-only postflight found 124 rows/latest T1-C, checksum `7382013e39521601ae1c08de22e7579dc289a8e113ea8c362f8be6ba66e3417f`, zero client/PUBLIC EXECUTE and service-role allowlist 140.
- Vercel test alias `https://bi2.hrpartner.vn` loaded the login page. No test-authenticated account/session was available, so authenticated workflow smoke remains outstanding. No direct RPC calls or personnel/business-row reads were made.

## Rollback / recovery

S0-A only removes unnecessary ACL entries on the ledger; it does not modify business data or ownership. If a confirmed runner/operator failure occurs, or if a T1-C allowlist omission breaks an approved server call:

1. Stop subsequent migrations and preserve the migration ledger and metadata snapshot.
2. Verify the actual connecting role and owner from session/catalog metadata. The observed owner is `postgres`; a separate operator role would need a deliberate least-privilege grant.
3. For a ledger issue, use a reviewed forward repair granting only required verbs to the verified migration/operator role; never restore ledger grants to `PUBLIC`, `anon`, `authenticated`, or `service_role`. For an RPC allowlist issue, add only the specific reviewed signature/role grant in a new forward migration; do not restore a broad ACL snapshot.
4. Re-run the native PostgreSQL regression, metadata-only ACL checks, and migration runner on an approved non-production database before retrying any deployment.

Do not manually delete, rewrite, or fabricate ledger rows. Do not mark #122 applied until its migration effects, source, and checksum are reconciled under a separately approved recovery plan. Application rollback alone cannot undo an applied database migration; preserve the narrow ledger ACL and migration ledger state while application rollout is assessed.


The local Supabase CLI left generated `supabase/.temp/` metadata in the worktree. It is untracked workspace state and excluded from commits.
