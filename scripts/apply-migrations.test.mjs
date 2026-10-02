import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrationChecksum, runMigrationValidation } from "./lib/migration-validation.mjs";

async function withMigrations(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "migration-validation-"));
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "001_applied.sql"), "select 1;\n");
    await writeFile(path.join(directory, "002_pending.sql"), "select 2;\n");
    await writeFile(path.join(directory, "003_changed.sql"), "select 3;\n");
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("dry-run uses SELECT only and reports applied, pending, and checksum mismatch", async () => {
  await withMigrations(async (directory) => {
    const statements = [];
    const output = [];
    let closed = false;
    const client = {
      async connect() {},
      async query(sql) {
        statements.push(sql);
        if (sql.includes("to_regclass")) return { rows: [{ exists: true }] };
        if (sql === "select version, checksum from public.schema_migrations") {
          return {
            rows: [
              { version: "001_applied.sql", checksum: migrationChecksum("select 1;\n") },
              { version: "003_changed.sql", checksum: "old-checksum" },
            ],
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      async end() {
        closed = true;
      },
    };
    const result = await runMigrationValidation({
      mode: "dry-run",
      directory,
      loadConfig: async () => ({ databaseUrl: "postgres://synthetic" }),
      createClient: () => client,
      log: (line) => output.push(line),
    });

    assert.deepEqual(result.mismatches, ["003_changed.sql"]);
    assert.match(output.join("\n"), /APPLIED 001_applied\.sql/);
    assert.match(output.join("\n"), /PENDING 002_pending\.sql/);
    assert.match(output.join("\n"), /CHECKSUM MISMATCH 003_changed\.sql/);
    assert.equal(closed, true);
    assert.ok(statements.length > 0);
    assert.ok(statements.every((sql) => /^\s*select\b/i.test(sql)), statements.join("\n"));
  });
});

test("dry-run reports all migrations pending when schema_migrations is absent", async () => {
  await withMigrations(async (directory) => {
    const output = [];
    const result = await runMigrationValidation({
      mode: "dry-run",
      directory,
      loadConfig: async () => ({ databaseUrl: "postgres://synthetic" }),
      createClient: () => ({
        async connect() {},
        async query(sql) {
          assert.match(sql, /^\s*select\b/i);
          return { rows: [{ exists: false }] };
        },
        async end() {},
      }),
      log: (line) => output.push(line),
    });
    assert.deepEqual(result.mismatches, []);
    assert.equal(output.filter((line) => line.startsWith("PENDING ")).length, 3);
    assert.match(output.join("\n"), /no table was created/);
  });
});

test("offline validation reads all files without loading config or creating a DB client", async () => {
  await withMigrations(async (directory) => {
    const output = [];
    let clientsCreated = 0;
    const result = await runMigrationValidation({
      mode: "offline",
      directory,
      loadConfig: async () => {
        throw new Error("offline must not load database configuration");
      },
      createClient: () => {
        clientsCreated += 1;
        throw new Error("offline must not create a database client");
      },
      log: (line) => output.push(line),
    });
    assert.equal(result.migrations.length, 3);
    assert.equal(clientsCreated, 0);
    assert.match(output.join("\n"), /OFFLINE VALIDATION/);
    assert.match(output.join("\n"), /applied\/pending status was not checked/);
    assert.equal(output.some((line) => /^(APPLIED|PENDING|CHECKSUM MISMATCH)\b/.test(line)), false);
  });
});

test("dry-run surfaces database connection failures", async () => {
  await withMigrations(async (directory) => {
    await assert.rejects(runMigrationValidation({
      mode: "dry-run",
      directory,
      loadConfig: async () => ({ databaseUrl: "postgres://unreachable" }),
      createClient: () => ({
        async connect() {
          throw new Error("database unavailable");
        },
      }),
      log() {},
    }), /database unavailable/);
  });
});
