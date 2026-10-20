# T1-B — S0-A schema migration ledger ACL

**Baseline:** `c29adc58ea2b41d2ed66a908f6a66a545952986f`  
**Branch/worktree:** `codex/s0-schema-migrations-acl` / `C:\Users\Admin\.codex\worktrees\s0-ledger-hotfix\BI`  
**Owned files:** `supabase/migrations/20261020150000_s0_a_schema_migrations_acl.sql`, `scripts/s0-a-schema-migrations-acl.test.mjs`, its package script, and `S0-A-ledger-hotfix.md`.

1. Independently review the existing S0-A SQL and tests. Confirm `PUBLIC`, `anon`, `authenticated`, and `service_role` lose ledger access while owner and verified migration operator/runner retain required access.
2. Keep the migration forward-only and minimal. Do not rewrite historical migrations, modify ledger rows/checksums, or touch RPC ACL/default-privilege files.
3. Run regression checks against ephemeral PostgreSQL, including actual runner/operator ledger read/write and role denial where supported.
4. Wait for T1-A's ledger-ready report before applying S0-A to the shared test DB. Then verify resulting ledger version/checksum and effective ACL via read-only metadata queries.
5. Report files/SQL diff, permission before/after, tests, shared test apply evidence and any remaining operator uncertainty. Do not apply RPC ACL changes.
