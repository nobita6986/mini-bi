#!/usr/bin/env node
/**
 * P2-W07-R1 - restore/rollback drill tren PostgreSQL dung mot lan (disposable).
 *
 * Khong cham Production: khoi tao mot instance PostgreSQL tam thoi trong thu muc temp
 * (initdb + trust auth + port rieng), ap du 65 migration, seed fixture TONG HOP, dump bang
 * pg_dump -Fc, restore sang database thu hai, so sanh ledger/checksum, schema objects,
 * fingerprint du lieu va invariant episode, roi do thoi gian rollback (drop + restore lai).
 * Khong in connection string, secret, PII, CCCD, email hay UUID nguoi dung.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.P2_W07_PORT ?? 55432);
const BIN_CANDIDATES = [
  process.env.PG_BIN,
  "C:\\Program Files\\PostgreSQL\\18\\bin",
  "C:\\Program Files\\PostgreSQL\\17\\bin",
  "/usr/lib/postgresql/16/bin",
  "/usr/bin",
].filter((value) => typeof value === "string" && value !== "");
const USER = "postgres";

function findBin() {
  for (const dir of BIN_CANDIDATES) {
    if (existsSync(path.join(dir, process.platform === "win32" ? "pg_dump.exe" : "pg_dump"))) {
      return dir;
    }
  }
  return null;
}

const BIN = findBin();
if (BIN === null) {
  console.log(JSON.stringify({ ok: false, code: "POSTGRES_TOOLS_MISSING" }));
  process.exit(1);
}
const exe = (name) => path.join(BIN, process.platform === "win32" ? name + ".exe" : name);

function run(name, args, options = {}) {
  const result = spawnSync(exe(name), args, { encoding: "utf8", timeout: 300000, ...options });
  if (result.status !== 0 && options.allowFailure !== true) {
    const failure = new Error(name + "_FAILED");
    failure.stderr = result.stderr;
    throw failure;
  }
  return result;
}

const SAFE_CODES = new Set(["initdb", "pg_ctl", "createdb", "dropdb", "pg_dump", "pg_restore", "psql"]
  .map((name) => name + "_FAILED")
  .concat(["PORT_IN_USE", "PORT_CHECK_FAILED", "DRILL_FAILED", "POSTGRES_TOOLS_MISSING"]));

function safeCode(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  return SAFE_CODES.has(message) ? message : "DRILL_FAILED";
}

function sqlState(error) {
  const text = typeof error?.stderr === "string" ? error.stderr : "";
  const match = /ERROR:\s+([0-9A-Z]{5})\b/.exec(text) ?? /SQLSTATE[:=]\s*([0-9A-Z]{5})\b/.exec(text);
  return match === null ? null : match[1];
}

const work = mkdtempSync(path.join(os.tmpdir(), "p2-w07-drill-"));
const dataDir = path.join(work, "data");
const dumpFile = path.join(work, "drill.dump");
const logFile = path.join(work, "server.log");
const psqlBase = ["-h", "127.0.0.1", "-p", String(PORT), "-U", USER,
  "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
const psql = (db, args) => run("psql", [...psqlBase, "-d", db, ...args]);
let step = "start";
let failure = null;
let report = { ok: false, code: "DRILL_NOT_STARTED" };

const PROLOGUE = [
  "create role anon;", "create role authenticated;", "create role service_role;",
  "create schema if not exists auth;",
  "create table if not exists auth.users (id uuid primary key, email text);",
].join("\n");

const SEED = [
  "insert into public.teams (team_id, code, display_name) values" +
  " ('00000000-0000-4000-8000-000000000101','SYNTH','Synthetic Team');",
  "insert into public.direct_entry_projects (project_id, display_name) values" +
  " ('synthetic_proj_a','Synthetic Project A'), ('synthetic_proj_b','Synthetic Project B');",
  "insert into public.recruiters (recruiter_id, display_name) select gen_random_uuid()," +
  " 'Synthetic Recruiter ' || n from generate_series(1,3) as n;",
  "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from)" +
  " select recruiter_id,'hrp','2020-01-01' from public.recruiters;",
  "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)" +
  " select recruiter_id,'00000000-0000-4000-8000-000000000101','2020-01-01' from public.recruiters;",
  "insert into auth.users (id, email) select ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,"
  + " 'synthetic' || n || '@example.invalid' from generate_series(101,103) as n;",
  "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)" +
  " select ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid," +
  " ('00000000-0000-4000-8000-' || lpad((n - 100)::text,12,'0'))::uuid, 'Synthetic Operator ' || n, true" +
  " from generate_series(201,203) as n;",
  "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)" +
  " select app_user_id,'entry_admin','2020-01-01' from public.direct_entry_app_users;",
  "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from)" +
  " select app_user_id,'all','2020-01-01' from public.direct_entry_app_users;",
  "with gen as (select n, ('00000000-0000-4000-8000-' || lpad((300 + n)::text,12,'0'))::uuid as cid," +
  " ('00000000-0000-4000-8000-' || lpad((400 + n)::text,12,'0'))::uuid as sid," +
  " ('00000000-0000-4000-8000-' || lpad((500 + n)::text,12,'0'))::uuid as eid," +
  " 'hrp-2026-' || lpad((900000 + n)::text,6,'0') as code" +
  " from generate_series(1,12) as n)" +
  " insert into public.direct_entry_candidates (candidate_id) select cid from gen;",
  "with gen as (select n, ('00000000-0000-4000-8000-' || lpad((400 + n)::text,12,'0'))::uuid as sid" +
  " from generate_series(1,12) as n)" +
  " insert into public.direct_entry_submissions (submission_id, created_by_user_id, state)" +
  " select sid,'00000000-0000-4000-8000-000000000201','DRAFT' from gen;",
  "with gen as (select n, ('00000000-0000-4000-8000-' || lpad((300 + n)::text,12,'0'))::uuid as cid," +
  " ('00000000-0000-4000-8000-' || lpad((400 + n)::text,12,'0'))::uuid as sid," +
  " ('00000000-0000-4000-8000-' || lpad((500 + n)::text,12,'0'))::uuid as eid," +
  " 'hrp-2026-' || lpad((900000 + n)::text,6,'0') as code" +
  " from generate_series(1,12) as n)" +
  " insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
  " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
  " provider_type, labor_type)" +
  " select eid, sid, cid, '00000000-0000-4000-8000-000000000201'," +
  " case when n % 2 = 0 then 'synthetic_proj_a' else 'synthetic_proj_b' end," +
  " '2026-10-01'::date, code," +
  " jsonb_build_object('display_name','Synthetic Worker ' || n," +
  "   'date_of_birth', jsonb_build_object('state','omitted')," +
  "   'national_id', jsonb_build_object('state','provided'," +
  "     'value', lpad((100000000000 + n)::text, 12, '0'))," +
  "   'address', jsonb_build_object('state','omitted')," +
  "   'phone', jsonb_build_object('state','omitted'))," +
  " (select recruiter_id from public.recruiters order by display_name limit 1)," +
  " '00000000-0000-4000-8000-000000000101','hrp','TEMPORARY' from gen;",
  "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
  " values ('00000000-0000-4000-8000-000000000201','Synthetic drill reason');",
  "insert into public.direct_entry_employment_status_events (entry_id, status, effective_date," +
  " leave_date, leave_reason_text, version, actor_user_id, reason_id)" +
  " select e.entry_id, 'ON', e.first_work_date, null, null, 1," +
  " '00000000-0000-4000-8000-000000000201'," +
  " (select reason_id from public.direct_entry_restricted_reasons limit 1)" +
  " from public.direct_entries e;",
  "insert into public.direct_entry_employment_status_events (entry_id, status, effective_date," +
  " leave_date, leave_reason_text, version, actor_user_id, reason_id)" +
  " select e.entry_id, 'OFF', least(e.first_work_date + 4, public.direct_entry_authorization_date())," +
  " least(e.first_work_date + 4, public.direct_entry_authorization_date()), 'Synthetic drill leave', 2," +
  " '00000000-0000-4000-8000-000000000201'," +
  " (select reason_id from public.direct_entry_restricted_reasons limit 1)" +
  " from (select entry_id, first_work_date, row_number() over (order by entry_id) as rn" +
  "   from public.direct_entries) e where e.rn % 2 = 0;",
].join("\n");

const TABLES = ["direct_entries", "direct_entry_submissions", "direct_entry_candidates",
  "direct_entry_projects", "recruiters", "teams", "direct_entry_employment_status_events",
  "direct_entry_restricted_reasons", "direct_entry_app_users", "direct_entry_capability_grants",
  "direct_entry_scope_grants", "schema_migrations"];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function ledgerInput() {
  const dir = path.resolve("supabase/migrations");
  return readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()
    .map((name) => ({ name, sql: readFileSync(path.join(dir, name), "utf8") }));
}

function applyMigrations(db, migrations) {
  psql(db, ["-c", "create table if not exists public.schema_migrations (version text primary key," +
    " checksum text, applied_at timestamptz default now())"]);
  psql(db, ["-c", PROLOGUE]);
  for (const migration of migrations) {
    step = "migration:" + migration.name;
    const file = path.join(work, migration.name + ".sql");
    writeFileSync(file, migration.sql, "utf8");
    psql(db, ["-f", file]);
    psql(db, ["-c", "insert into public.schema_migrations (version, checksum) values ('"
      + migration.name + "','" + sha256(migration.sql) + "')"]);
  }
}

function fingerprint(db) {
  const parts = [];
  for (const table of TABLES) {
    const result = psql(db, ["-t", "-A", "-c",
      "select count(*) || ':' || coalesce(md5(string_agg(t::text, '|' order by t::text)), '')" +
      " from (select * from public." + table + " limit 500) t"]);
    parts.push(table + "=" + result.stdout.trim());
  }
  return { digest: sha256(parts.join(";")), tables: parts.length };
}

function objectCounts(db) {
  const result = psql(db, ["-t", "-A", "-c",
    "select (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace" +
    " where n.nspname='public' and c.relkind='r')," +
    " (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace" +
    " where n.nspname='public' and c.relkind='i')," +
    " (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid" +
    " join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal)," +
    " (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace" +
    " where n.nspname='public')," +
    " (select count(*) from pg_constraint k join pg_namespace n on n.oid=k.connamespace" +
    " where n.nspname='public')"]);
  const [tables, indexes, triggers, functions, constraints] = result.stdout.trim().split("|")
    .map((value) => Number(value));
  return { tables, indexes, triggers, functions, constraints };
}

function invariantHeld(db) {
  // Invariant #58-#60: episode active thu hai cho cung CCCD phai bi tu choi dung ma loi.
  const sql = [
    'insert into public.direct_entries (entry_id, submission_id, candidate_id,'
    , ' created_by_user_id, project_id, first_work_date, employee_code, worker_details,'
    , ' recruiter_id, team_id, provider_type, labor_type)'
    , ' select gen_random_uuid(), s.submission_id, s.candidate_id, s.created_by_user_id,'
    , " s.project_id, '2026-10-02'::date, 'hrp-2026-999999', s.worker_details,"
    , ' s.recruiter_id, s.team_id, s.provider_type, s.labor_type'
    , ' from public.direct_entries s'
    , ' join lateral (select st.status from public.direct_entry_employment_status_events st'
    , '   where st.entry_id = s.entry_id order by st.version desc limit 1) latest on true'
    , " where latest.status = 'ON' limit 1"
  ].join('');
  const result = run('psql', [...psqlBase, '-d', db, '-c', sql], { allowFailure: true });
  const stderr = String(result.stderr ?? '');
  return result.status !== 0 && sqlState({ stderr }) === '23505' &&
    stderr.includes('worker_active_episode_exists');
}

try {
  const portCheck = spawnSync("powershell", ["-NoProfile", "-Command",
    "if ((Get-NetTCPConnection -LocalPort " + PORT + " -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0) { 'BUSY' } else { 'FREE' }"],
    { encoding: "utf8", timeout: 30000 });
  const portOutput = String(portCheck.stdout ?? "").trim();
  if (portCheck.status !== 0 || portOutput === "") {
    throw new Error("PORT_CHECK_FAILED");
  }
  if (portOutput.includes("BUSY")) {
    throw new Error("PORT_IN_USE");
  }
  if (!portOutput.includes("FREE")) {
    throw new Error("PORT_CHECK_FAILED");
  }
  step = "initdb";
  run("initdb", ["-D", dataDir, "-U", USER, "-A", "trust", "-E", "UTF8", "--no-sync"],
    { timeout: 180000 });
  step = "start";
  run("pg_ctl", ["-D", dataDir, "-l", logFile, "-o",
    "-p " + PORT + " -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off", "-w",
    "start"], { stdio: "ignore", timeout: 60000 });
  step = "create-source";
  run("createdb", ["-h", "127.0.0.1", "-p", String(PORT), "-U", USER, "drill_src"]);
  step = "create-target";
  run("createdb", ["-h", "127.0.0.1", "-p", String(PORT), "-U", USER, "drill_tgt"]);

  const migrations = ledgerInput();
  applyMigrations("drill_src", migrations);
  step = "seed";
  psql("drill_src", ["-c", SEED]);

  step = "fingerprint";
  const sourceFingerprint = fingerprint("drill_src");
  const sourceObjects = objectCounts("drill_src");

  step = "dump";
  const dumpStart = Date.now();
  run("pg_dump", ["-h", "127.0.0.1", "-p", String(PORT), "-U", USER, "-Fc", "-f", dumpFile,
    "drill_src"]);
  const dumpMs = Date.now() - dumpStart;

  step = "restore";
  const restoreStart = Date.now();
  run("pg_restore", ["-h", "127.0.0.1", "-p", String(PORT), "-U", USER, "-d", "drill_tgt",
    dumpFile]);
  const restoreMs = Date.now() - restoreStart;

  step = "fingerprint";
  const targetFingerprint = fingerprint("drill_tgt");
  const targetObjects = objectCounts("drill_tgt");
  const ledger = psql("drill_src", ["-t", "-A", "-c",
    "select count(*) || ':' || coalesce(md5(string_agg(version || ':' || checksum, '|'" +
    " order by version)), '') from public.schema_migrations"]);
  const ledgerTarget = psql("drill_tgt", ["-t", "-A", "-c",
    "select count(*) || ':' || coalesce(md5(string_agg(version || ':' || checksum, '|'" +
    " order by version)), '') from public.schema_migrations"]);

  step = "invariant";
  const invariantEnforced = invariantHeld("drill_tgt");

  step = "rollback";
  const rollbackStart = Date.now();
  run("dropdb", ["-h", "127.0.0.1", "-p", String(PORT), "-U", USER, "drill_tgt"]);
  run("createdb", ["-h", "127.0.0.1", "-p", String(PORT), "-U", USER, "drill_tgt"]);
  run("pg_restore", ["-h", "127.0.0.1", "-p", String(PORT), "-U", USER, "-d", "drill_tgt",
    dumpFile]);
  const rollbackMs = Date.now() - rollbackStart;

  step = "fingerprint";
  const rollbackFingerprint = fingerprint("drill_tgt");

  report = {
    migrations_applied: migrations.length,
    ledger_count: Number(ledger.stdout.trim().split(":")[0]),
    ledger_match: ledger.stdout.trim() === ledgerTarget.stdout.trim(),
    fingerprint_match: sourceFingerprint.digest === targetFingerprint.digest,
    fingerprint_tables: sourceFingerprint.tables,
    objects_match: JSON.stringify(sourceObjects) === JSON.stringify(targetObjects),
    objects: sourceObjects,
    invariant_enforced_on_target: invariantEnforced,
    rollback_fingerprint_match: rollbackFingerprint.digest === sourceFingerprint.digest,
    timing_ms: { dump: dumpMs, restore: restoreMs, rollback_drop_and_restore: rollbackMs },
  };
} catch (error) {
  failure = error;
  report = { ok: false, step, code: safeCode(error) };
  const state = sqlState(error);
  if (state !== null) {
    report.sqlstate = state;
  }
} finally {
  step = "cleanup";
  // Instance disposable: chi stop bang chinh dataDir cua minh, ke ca khi start chua xong.
  if (existsSync(path.join(dataDir, "PG_VERSION"))) {
    try {
      run("pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"], { stdio: "ignore", timeout: 60000 });
    } catch {
      // instance tam thoi: bo qua loi stop
    }
  }
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // cleanup best effort
  }
  report.cleanup_removed = !existsSync(work);
}

// Mot gate do luong sai thi drill KHONG duoc phep bao ok: true.
const EXPECTED_MIGRATIONS = 65;
const GATES = ["migrations_applied", "ledger_count", "ledger_match", "fingerprint_match",
  "objects_match", "invariant_enforced_on_target", "rollback_fingerprint_match", "cleanup_removed"];
const gatePassed = (name) => name === "migrations_applied" || name === "ledger_count"
  ? report[name] === EXPECTED_MIGRATIONS
  : report[name] === true;

if (failure === null) {
  const failedGates = GATES.filter((name) => !gatePassed(name));
  report.ok = failedGates.length === 0;
  if (!report.ok) {
    report.code = "DRILL_ASSERTION_FAILED";
    report.failed_gates = failedGates;
  }
} else {
  report.ok = false;
}
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok === true ? 0 : 1;
