import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export function migrationChecksum(text) {
  // Git may materialize SQL files as CRLF on Windows even though the same
  // committed migration was applied from an LF checkout. A migration's
  // identity must not change solely because of the checkout platform.
  const normalized = text.replace(/\r\n?/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export async function readMigrations(directory) {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (names.length === 0) {
    throw new Error(`No .sql migrations found in ${directory}`);
  }
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(path.join(directory, name), "utf8");
    if (sql.trim() === "") throw new Error(`Migration is empty: ${name}`);
    return { name, sql, checksum: migrationChecksum(sql) };
  }));
}

export async function runMigrationValidation({
  mode,
  directory,
  loadConfig,
  createClient,
  log = console.log,
}) {
  const migrations = await readMigrations(directory);
  if (mode === "offline") {
    log("OFFLINE VALIDATION (applied/pending status was not checked)");
    for (const migration of migrations) log(`VALID  ${migration.name}`);
    log(`\nOffline validation complete: ${migrations.length} migration(s); no database access.`);
    return { migrations, mismatches: [] };
  }

  if (mode !== "dry-run") throw new Error(`Unsupported validation mode: ${mode}`);

  const { databaseUrl } = await loadConfig();
  const client = createClient(databaseUrl);
  await client.connect();
  try {
    const { rows: tables } = await client.query(
      "select to_regclass('public.schema_migrations') is not null as exists"
    );

    let applied = new Map();
    if (tables[0]?.exists === true) {
      const { rows } = await client.query(
        "select version, checksum from public.schema_migrations"
      );
      applied = new Map(rows.map((row) => [row.version, row.checksum]));
    } else {
      log("schema_migrations table does not exist; no table was created.");
    }

    const mismatches = [];
    for (const migration of migrations) {
      const previous = applied.get(migration.name);
      if (previous === undefined) {
        log(`PENDING ${migration.name}`);
      } else if (previous !== migration.checksum) {
        log(`CHECKSUM MISMATCH ${migration.name}`);
        mismatches.push(migration.name);
      } else {
        log(`APPLIED ${migration.name} (checksum matches)`);
      }
    }
    log(`\nDB-aware dry-run: ${migrations.length} migration(s); read-only.`);
    return { migrations, mismatches };
  } finally {
    await client.end();
  }
}
