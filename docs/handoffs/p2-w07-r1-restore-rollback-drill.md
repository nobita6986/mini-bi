# P2-W07-R2 - Windows restore drill lifecycle (fix landed, drill still red)

Branch feature/p2-w07-r1-restore-rollback-drill. Base a7fcfbb4203822826bcc24ad23e9306855210530 -> final (this commit). Fast-forward only; no Production DB, no browser/UAT, no deploy, no new migration, no dependency.

## Root cause before -> after
- Before: spawnSync(pg_ctl start) inherited the parent stdout/stderr pipe on Windows, so the drill hung after PostgreSQL was listening; the harness killed it and left a disposable instance on port 55432 plus a temp data dir.
- After: pg_ctl start/stop now run with stdio "ignore" (server log still goes to the temp -l file), every child command has a finite timeout (initdb 180s, others 300s, pg_ctl 60s), the script fails closed with PORT_IN_USE if port 55432 is already listening, and stop/remove run in finally for both the success and the failure path. Nothing outside the disposable dataDir is touched.

## Verified this round
- The drill no longer hangs: two consecutive runs returned a JSON result within the time budget instead of being killed.
- Cleanup is proven after both runs: port 55432 has no listener and no p2-w07-drill-* directory remains in %TEMP% (cleanup_removed: true).
- Fixture: synthetic app users now seed a canonical display_name (required by current migrations); no historical migration was touched.
- Invariant check no longer accepts "any exception": it now requires psql to fail with SQLSTATE 23505 AND worker_active_episode_exists.
- Lifecycle + fixture + invariant changes and step/sqlstate diagnostics are in scripts/p2-w07-restore-rollback-drill.mjs (syntax-checked with node --check).

## Still red - no PASS claimed (P2_W07_R2_LOCAL_PASS_AWAITING_T0_REVIEW not reached)
- Both runs ended in { ok: false, code: "psql_FAILED" } with no green JSON, so there is no restore/rollback evidence yet: migrations_applied, ledger_match, fingerprint_match, objects_match, invariant_enforced_on_target and timings are NOT measured.
- The failing psql step is still unidentified: the diagnostic patch that should surface "step" and "sqlstate" in the error report did not take effect (the report still shows only code + cleanup_removed), so the next action is to add that field at the exact catch site and re-run - one run should then name the failing migration file or seed step.
- No Production RPO/RTO is claimed or measured; local drill timings do not exist yet and must never be extrapolated to Production.