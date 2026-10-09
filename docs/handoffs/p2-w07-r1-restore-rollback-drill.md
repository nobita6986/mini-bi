# P2-W07-R4 - restore drill gate reads the live migration inventory: P2_W07_R4_LOCAL_PASS_AWAITING_T0_REVIEW

Branch feature/p2-w07-r1-restore-rollback-drill. Base 56b06a6502893c758262345ff77f77f9a1eaba1e -> final (this commit). Fast-forward only; no Production DB, no browser/UAT, no deploy, no new migration kept, no dependency, no sub-agent.

## Delta
- The runtime gate no longer pins a migration count: EXPECTED_MIGRATIONS = 65 is gone and was NOT replaced by 66. ledgerInput() stays the inventory source and the run records source_migration_count from the inventory it actually read.
- PASS now requires source_migration_count > 0, migrations_applied === source_migration_count, ledger_count === source_migration_count, plus the remaining R3 gates (ledger_match, fingerprint_match, objects_match, invariant_enforced_on_target, rollback_fingerprint_match, cleanup_removed) all true.
- JSON adds source_migration_count only - still no path, connection string, secret, PII or raw DB message. The header comment now says "ap dung toan bo migration hien hanh" with no fixed count.
- No historical migration was edited and no migration/dependency/framework was added; the R4 commit touches the drill script and this handoff only.

## Evidence
- Normal run on the current tree: exit 0, source_migration_count 65, migrations_applied 65, ledger_count 65, all eight R3 gates true, ok true (timing_ms dump 370 / restore 788 / rollback_drop_and_restore 1522, wall 27.3s). Port 55432 listeners = 0, p2-w07-drill-* in %TEMP% = 0.
- Inventory mutation-check: a temporary no-op migration (creates and drops its own scratch table in one transaction, never committed) made the drill exit 0 with source_migration_count 66, migrations_applied 66, ledger_count 66 and object counts unchanged (43/104/32/163/621). The probe was deleted afterwards: supabase/migrations is back to 65 files and the worktree shows only the R4 delta.
- Regression gates all exit 0: pnpm test (47 runner invocations, 1810/1810 pass, 0 fail), next typegen, typecheck, lint (0 errors / 14 warnings), build, docs:check (6/6), secrets:check, db:migrate -- --offline (65 migrations, no DB access), git diff --check.

## History and scope
- R3 stays on record as the round measured against the 65-migration baseline; that figure is historical evidence, not a runtime expectation.
- LOCAL disposable restore drill only. Production RPO is NOT measured, and local wall-clock numbers are not a Production RTO.
