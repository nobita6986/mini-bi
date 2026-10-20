# T1-A — migration integrity and ledger reconciliation

**Baseline:** `c29adc58ea2b41d2ed66a908f6a66a545952986f`  
**Branch/worktree:** `codex/s0-t1-a-ledger` / `C:\Users\Admin\.codex\worktrees\s0-t1-a\BI`  
**Database scope:** only Product Owner-authorized test project `oyykqfxkyqhxgrfntokl`.

1. Compare all 122 source migrations with the test DB ledger by version/name and checksum; inspect only relevant catalog metadata to confirm #122 effects.
2. If 122/122 match, close the prior ledger finding and make no DB change. If not, identify the exact discrepancy and its effects; reconcile only with evidence that prevents duplicate/non-idempotent DDL. Do not invent checksums or alter historical migration files.
3. Verify `scripts/apply-migrations.mjs`, `checkMigrationLedger`, `SUPABASE_DB_URL` connection expectations, and the documented operator/runner roles. Never print credentials or read personnel rows.
4. Review tests relying on positional migration indexes. Make only narrow test fixes that identify migrations by filename/version; avoid touching S0-A or RPC ACL files.
5. Return exact before/after ledger metadata, #122 evidence, test results, any DB reconciliation performed, and readiness for T1-B.

Do not apply S0-A or RPC migrations; T0 schedules those after this report.
