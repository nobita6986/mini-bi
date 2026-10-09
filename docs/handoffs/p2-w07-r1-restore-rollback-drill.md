# P2-W07-R3 - local disposable restore/rollback drill: P2_W07_R3_LOCAL_PASS_AWAITING_T0_REVIEW

Branch feature/p2-w07-r1-restore-rollback-drill. Base 4c6df467a68cdb9f3bfd0de612f626e0f8d4fbde -> final (this commit). Fast-forward only; no Production DB, no browser/UAT, no deploy, no new migration, no dependency, no sub-agent.

## T0 fixes 1-5 landed in scripts/p2-w07-restore-rollback-drill.mjs
1. SEED: every uuid column written from a concatenation is cast ::uuid; auth.users.id seeds 101..103 so it matches auth_subject; app_user_id stays 201..203; canonical display_name kept.
2. Employment history is canonical: all 12 synthetic episodes open with ON v1 at effective_date = first_work_date, and a subset (6) appends OFF v2 with leave_date + a synthetic reason. Inserts only - no update, no trigger bypass.
3. The invariant probe now targets an episode whose LATEST status is ON (lateral order by version desc limit 1), and psql runs with -v VERBOSITY=verbose so the assertion needs the parsed SQLSTATE 23505 AND worker_active_episode_exists.
4. ok: true is now gated: migrations_applied = 65, ledger_count = 65, ledger_match, fingerprint_match, objects_match, invariant_enforced_on_target, rollback_fingerprint_match, cleanup_removed must all hold; otherwise exit 1 with code DRILL_ASSERTION_FAILED + failed_gates, never a raw DB message.
5. Diagnostics: step at the real catch (initdb|start|create-source|create-target|migration:<file>|seed|dump|restore|fingerprint|invariant|rollback|cleanup) plus parsed sqlstate; the port check now fails closed (PORT_IN_USE / PORT_CHECK_FAILED); finally stops through its own dataDir whenever PG_VERSION exists; no PID kill, port 5432 untouched.

## Evidence - local disposable drill, two consecutive runs
- Run 1 exit 0, all eight gates true: timing_ms dump 383 / restore 821 / rollback_drop_and_restore 1838 (wall 29.4s).
- Run 2 exit 0, all eight gates true: timing_ms dump 465 / restore 794 / rollback_drop_and_restore 1460 (wall 28.8s).
- After each run: port 55432 listeners = 0, p2-w07-drill-* dirs in %TEMP% = 0.
- Mutation-check: probe pinned to an OFF-latest episode -> invariant_enforced_on_target false, ok false, code DRILL_ASSERTION_FAILED, exit 1; dropping VERBOSITY=verbose -> same. Script restored byte-identical (sha256 unchanged) and the drill is green again.
- Gates all exit 0: pnpm test (47 runner invocations, 1810/1810 pass, 0 fail), next typegen, typecheck, lint (0 errors / 14 warnings), build, docs:check (6/6), secrets:check, db:migrate --offline (65 migrations, no DB access), git diff --check.

## Scope limit
This is a LOCAL disposable restore drill on a throwaway initdb instance. Production RPO is NOT measured, and these local wall-clock numbers are not a Production RTO.
