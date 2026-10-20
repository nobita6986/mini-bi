import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";

import { checkMigrationLedger, IMPORT_REQUIRED_MIGRATIONS } from "./lib/t0-operator-import.mjs";
import { migrationChecksum, readMigrations, runMigrationValidation } from "./lib/migration-validation.mjs";

const MIGRATION = "20261020150000_s0_a_schema_migrations_acl.sql";
const RUNTIME_ROLES = ["anon", "authenticated", "service_role"];
const POSTGRES_BIN_DIR = process.env.P3_1_W02A_PG_BIN
  ?? (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");

function postgresBinary(name) {
  const candidate = POSTGRES_BIN_DIR
    ? path.join(POSTGRES_BIN_DIR, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  return result.error ? null : candidate;
}

function runPostgres(file, args, { ignoreOutput = false } = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(ignoreOutput ? { stdio: "ignore" } : {}),
  });
  assert.equal(result.status, 0, `${path.basename(file)} failed:\n${result.stderr || result.stdout}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function connectPostgres(port, database, user = "postgres") {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user,
    database,
    application_name: "s0-a-acl-test",
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

test("S0-A keeps the migration ledger available to its owner only", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      alter default privileges in schema public
        grant all on tables to public, anon, authenticated, service_role;
      create table public.schema_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      );
      create function public.s0_test_service_rpc() returns integer
        language sql as $$ select 1 $$;
      grant execute on function public.s0_test_service_rpc() to service_role;
      insert into public.schema_migrations (version, checksum)
        values ('baseline.sql', 'synthetic-baseline');
    `);

    for (const role of RUNTIME_ROLES) {
      const { rows } = await db.query(
        "select has_table_privilege($1, 'public.schema_migrations', 'SELECT') as can_read",
        [role],
      );
      assert.equal(rows[0].can_read, true, `${role} fixture should start with broad default ACL`);
    }

    const sourceChecksums = new Map((await readMigrations(path.resolve("supabase", "migrations")))
      .map(({ name, checksum }) => [name, checksum]));
    for (const version of IMPORT_REQUIRED_MIGRATIONS) {
      const checksum = sourceChecksums.get(version) ?? "historical-checksum";
      await db.query(
        "insert into public.schema_migrations (version, checksum) values ($1, $2)",
        [version, checksum],
      );
    }

    const migration = await readFile(
      path.join(process.cwd(), "supabase", "migrations", MIGRATION),
      "utf8",
    );
    const checksum = migrationChecksum(migration);

    await db.exec("begin");
    try {
      await db.exec(migration);
      await db.query(
        "insert into public.schema_migrations (version, checksum) values ($1, $2)",
        [MIGRATION, checksum],
      );
      await db.exec("commit");
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }

    const { rows: ledgerRows } = await db.query(
      "select version, checksum from public.schema_migrations where version = $1",
      [MIGRATION],
    );
    assert.deepEqual(ledgerRows, [{ version: MIGRATION, checksum }]);

    const ledger = await checkMigrationLedger(db);
    assert.equal(ledger.required_pending, 0);
    assert.equal(ledger.pending_names.length, 0);
    assert.equal(ledger.applied, IMPORT_REQUIRED_MIGRATIONS.length + 2);

    const validationOutput = [];
    const validation = await runMigrationValidation({
      mode: "dry-run",
      directory: path.resolve("supabase", "migrations"),
      loadConfig: async () => ({ databaseUrl: "postgres://synthetic" }),
      createClient: () => ({
        async connect() {},
        query: db.query.bind(db),
        async end() {},
      }),
      log: (line) => validationOutput.push(line),
    });
    assert.deepEqual(validation.mismatches, []);
    assert.ok(validationOutput.includes(`APPLIED ${MIGRATION} (checksum matches)`));

    for (const role of RUNTIME_ROLES) {
      await db.exec(`set role ${role}`);
      for (const sql of [
        "select version from public.schema_migrations",
        "insert into public.schema_migrations (version, checksum) values ('denied', 'x')",
        "update public.schema_migrations set checksum = 'x' where version = 'baseline.sql'",
        "delete from public.schema_migrations where version = 'baseline.sql'",
      ]) {
        await assert.rejects(db.query(sql), (error) => error.code === "42501",
          `${role} should be denied: ${sql}`);
      }
      await db.exec("reset role");
    }

    await db.exec("set role service_role");
    const { rows: rpcRows } = await db.query("select public.s0_test_service_rpc() as result");
    assert.equal(rpcRows[0].result, 1);
    await db.exec("reset role");

    const { rows: preservedRows } = await db.query(
      "select count(*)::integer as count from public.schema_migrations",
    );
    assert.equal(preservedRows[0].count, IMPORT_REQUIRED_MIGRATIONS.length + 2);
  } finally {
    await db.close();
  }
});

test("S0-A revokes ledger access in real PostgreSQL while the migration runner and operator retain it",
  async (t) => {
    const initdb = postgresBinary("initdb");
    const pgCtl = postgresBinary("pg_ctl");
    if (!initdb || !pgCtl) {
      t.skip("PostgreSQL initdb and pg_ctl are required for the real ACL regression");
      return;
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "s0-a-ledger-acl-"));
    const dataDir = path.join(tempDir, "data");
    const logFile = path.join(tempDir, "postgres.log");
    const databaseName = `s0_a_${process.pid}`;
    const port = await freePort();
    let serverStarted = false;
    let admin;
    let setup;
    let owner;
    try {
      runPostgres(initdb, [
        "--username=postgres",
        "--auth-local=trust",
        "--auth-host=trust",
        "--no-locale",
        "--encoding=UTF8",
        "--pgdata",
        dataDir,
      ]);
      runPostgres(pgCtl, [
        "-D", dataDir,
        "-l", logFile,
        "-o", `-h 127.0.0.1 -p ${port}`,
        "-w", "start",
      ], { ignoreOutput: process.platform === "win32" });
      serverStarted = true;

      admin = await connectPostgres(port, "postgres");
      await admin.query("create role anon login; create role authenticated login; create role service_role login");
      await admin.query(`create database ${databaseName}`);
      setup = await connectPostgres(port, databaseName);
      await setup.query(`
        grant usage on schema public to anon, authenticated, service_role;
        alter default privileges in schema public
          grant all on tables to public, anon, authenticated, service_role;
        create table public.schema_migrations (
          version text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        );
      `);
      for (const version of IMPORT_REQUIRED_MIGRATIONS) {
        await setup.query(
          "insert into public.schema_migrations (version, checksum) values ($1, $2)",
          [version, `fixture-${version}`],
        );
      }
      for (const role of RUNTIME_ROLES) {
        const { rows } = await setup.query(
          "select has_table_privilege($1, 'public.schema_migrations', 'SELECT') as can_read",
          [role],
        );
        assert.equal(rows[0].can_read, true, `${role} fixture should begin with broad table ACL`);
      }
      await setup.end();
      setup = undefined;

      const migrationsDir = path.join(tempDir, "supabase", "migrations");
      await mkdir(migrationsDir, { recursive: true });
      const migrationPath = path.join(process.cwd(), "supabase", "migrations", MIGRATION);
      const migration = await readFile(migrationPath, "utf8");
      await writeFile(path.join(migrationsDir, MIGRATION), migration);
      const configFile = path.join(tempDir, "supabase-test.config");
      await writeFile(configFile, [
        "NEXT_PUBLIC_SUPABASE_URL=https://s0test.supabase.co",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_test",
        "SUPABASE_SECRET_KEY=sb_secret_test",
        `SUPABASE_DB_URL=postgresql://postgres@127.0.0.1:${port}/${databaseName}?sslmode=disable`,
        "",
      ].join("\n"));
      const runnerEnv = { ...process.env,
        SUPABASE_CONFIG_FILE: configFile,
        SUPABASE_SECRET_KEY: "sb_secret_test",
      };
      delete runnerEnv.SUPABASE_DB_URL;
      delete runnerEnv.SUPABASE_POOLER_HOST;
      delete runnerEnv.SUPABASE_POOLER_PORT;
      const runner = spawnSync(process.execPath, [
        path.join(process.cwd(), "scripts", "apply-migrations.mjs"),
      ], {
        cwd: tempDir,
        env: runnerEnv,
        encoding: "utf8",
        windowsHide: true,
        timeout: 60000,
      });
      assert.equal(runner.status, 0, `migration runner failed:\n${runner.stderr || runner.stdout}`);
      assert.match(runner.stdout, new RegExp(`APPLY\\s+${MIGRATION.replaceAll(".", "\\.")}`));

      owner = await connectPostgres(port, databaseName);
      const expectedChecksum = migrationChecksum(migration);
      const { rows: appliedRows } = await owner.query(
        "select checksum from public.schema_migrations where version = $1",
        [MIGRATION],
      );
      assert.deepEqual(appliedRows, [{ checksum: expectedChecksum }]);
      const ledger = await checkMigrationLedger(owner);
      assert.equal(ledger.required_pending, 0);
      assert.deepEqual(ledger.pending_names, []);

      const { rows: [acl] } = await owner.query(`
        select current_user, session_user, owner.rolname as owner_name,
          coalesce((
            select bool_or(grantee = 0)
              from aclexplode(ledger.relacl)
          ), false) as public_has_acl
          from pg_class ledger
          join pg_roles owner on owner.oid = ledger.relowner
         where ledger.oid = 'public.schema_migrations'::regclass
      `);
      assert.deepEqual(acl, {
        current_user: "postgres",
        session_user: "postgres",
        owner_name: "postgres",
        public_has_acl: false,
      });

      for (const role of RUNTIME_ROLES) {
        const { rows } = await owner.query(
          "select has_table_privilege($1, 'public.schema_migrations', 'SELECT') as can_read",
          [role],
        );
        assert.equal(rows[0].can_read, false, `${role} should lose effective ledger privileges`);
        const runtime = await connectPostgres(port, databaseName, role);
        try {
          for (const sql of [
            "select version from public.schema_migrations",
            "insert into public.schema_migrations (version, checksum) values ('denied', 'x')",
            "update public.schema_migrations set checksum = 'x' where version = 'fixture'",
            "delete from public.schema_migrations where version = 'fixture'",
          ]) {
            await assert.rejects(runtime.query(sql), (error) => error.code === "42501",
              `${role} should be denied: ${sql}`);
          }
        } finally {
          await runtime.end();
        }
      }

      await owner.query(
        "insert into public.schema_migrations (version, checksum) values ('operator_probe', 'before')",
      );
      await owner.query(
        "update public.schema_migrations set checksum = 'after' where version = 'operator_probe'",
      );
      await owner.query("delete from public.schema_migrations where version = 'operator_probe'");
    } finally {
      await setup?.end().catch(() => {});
      await owner?.end().catch(() => {});
      if (admin) {
        await admin.query(`drop database if exists ${databaseName}`).catch(() => {});
        await admin.end().catch(() => {});
      }
      if (serverStarted) {
        spawnSync(pgCtl, ["-D", dataDir, "-m", "fast", "-w", "stop"], {
          encoding: "utf8",
          windowsHide: true,
        });
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
