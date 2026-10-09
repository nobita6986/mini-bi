# P2-W07-R1 - restore/rollback drill (script written, drill NOT yet executed)

Base origin/main@c0d72366212a587f949a56376f71284ed63d1099 (ledger 65) verified; branch feature/p2-w07-r1-restore-rollback-drill, worktree C:\CodeApp\BI-p2-w07-r1-restore-rollback-drill.

## Status: no PASS claimed (P2_W07_R1_LOCAL_PASS_AWAITING_T0_REVIEW not reached)
The drill script exists and is committed, but its first execution exceeded this session's wall-clock ceiling, so no restore/rollback evidence has been produced yet. Nothing about Production RPO/RTO is claimed or measured.

## Environment facts verified (read-only)
- pg_dump/pg_restore/psql/pg_ctl/initdb/createdb are NOT on PATH but DO exist at C:\Program Files\PostgreSQL\18\bin (pg_dump.exe confirmed on disk).
- Docker CLI exists but the daemon is not running (npipe dockerDesktopLinuxEngine missing), so containers are unavailable.
- The installed PostgreSQL 18 service listens on 5432 but has no credentials available to this session; the drill therefore uses a disposable instance instead of touching it.
- No Production database, dump, restore target, connection string or real data was touched or printed.

## What the script does (scripts/p2-w07-restore-rollback-drill.mjs, no dependency added)
1. initdb into a temp dir with trust auth + pg_ctl start on port 55432 (disposable, no credentials).
2. create drill_src/drill_tgt databases, apply the role/schema prologue, then apply all 65 migrations in filename order and record version+sha256 into public.schema_migrations.
3. Seed a purely synthetic, PII-free fixture (synthetic teams/projects/recruiters/app users, 12 entries, status events, one reason).
4. pg_dump -Fc from drill_src, pg_restore into drill_tgt; compare migration count + ledger checksum digest, schema object counts (tables/indexes/triggers/functions/constraints), and a synthetic table-fingerprint digest before/after.
5. Functional invariant on the target: inserting a second active episode for a CCCD whose episode is ON must be refused by the #58-#60 guard.
6. Rollback drill: drop drill_tgt, recreate, restore again, and measure the wall-clock milliseconds; then pg_ctl stop + remove the temp directory.
7. Output is JSON counts/timings/booleans only - no connection string, secret, PII, CCCD, email, user UUID or storage key.

## Next step for T0
Run: node scripts/p2-w07-restore-rollback-drill.mjs (needs a longer wall-clock budget; add & to run it as a background job). Capture the JSON, then add the measured dump/restore/rollback timings to this handoff as local drill evidence, explicitly separated from Production RPO/RTO.