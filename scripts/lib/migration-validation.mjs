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

function skipSqlTrivia(sql, offset) {
  while (offset < sql.length) {
    if (/\s/.test(sql[offset])) {
      offset += 1;
    } else if (sql.startsWith("--", offset)) {
      const newline = sql.indexOf("\n", offset + 2);
      offset = newline === -1 ? sql.length : newline + 1;
    } else if (sql.startsWith("/*", offset)) {
      let depth = 1;
      offset += 2;
      while (depth > 0 && offset < sql.length) {
        if (sql.startsWith("/*", offset)) {
          depth += 1;
          offset += 2;
        } else if (sql.startsWith("*/", offset)) {
          depth -= 1;
          offset += 2;
        } else {
          offset += 1;
        }
      }
      if (depth > 0) throw new Error("Unterminated SQL block comment");
    } else {
      break;
    }
  }
  return offset;
}

function sqlKeyword(statement, offset = 0) {
  const start = skipSqlTrivia(statement, offset);
  const match = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(statement.slice(start));
  return match ? { value: match[0].toUpperCase(), end: start + match[0].length } : null;
}

function isOnlySqlKeyword(statement, expected) {
  const first = sqlKeyword(statement);
  return first?.value === expected && skipSqlTrivia(statement, first.end) === statement.length;
}

function splitTopLevelSqlStatements(sql) {
  const statements = [];
  let start = 0;
  let offset = 0;

  while (offset < sql.length) {
    if (sql.startsWith("--", offset)) {
      const newline = sql.indexOf("\n", offset + 2);
      offset = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith("/*", offset)) {
      offset = skipSqlTrivia(sql, offset);
      continue;
    }
    if (sql[offset] === "'") {
      const prefix = sql.slice(0, offset);
      const escapeString = /[Ee]$/.test(prefix) && !/[A-Za-z_0-9$]$/.test(prefix.slice(0, -1));
      offset += 1;
      let closed = false;
      while (offset < sql.length) {
        if (escapeString && sql[offset] === "\\") {
          offset += 2;
        } else if (sql.startsWith("''", offset)) {
          offset += 2;
        } else if (sql[offset] === "'") {
          offset += 1;
          closed = true;
          break;
        } else {
          offset += 1;
        }
      }
      if (!closed) throw new Error("Unterminated SQL string literal");
      continue;
    }
    if (sql[offset] === '"') {
      offset += 1;
      let closed = false;
      while (offset < sql.length) {
        if (sql.startsWith('""', offset)) {
          offset += 2;
        } else if (sql[offset] === '"') {
          offset += 1;
          closed = true;
          break;
        } else {
          offset += 1;
        }
      }
      if (!closed) throw new Error("Unterminated SQL quoted identifier");
      continue;
    }
    if (sql[offset] === "$") {
      const delimiter = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(offset))?.[0];
      if (delimiter) {
        const close = sql.indexOf(delimiter, offset + delimiter.length);
        if (close === -1) throw new Error("Unterminated SQL dollar-quoted body");
        offset = close + delimiter.length;
        continue;
      }
    }
    if (sql[offset] === ";") {
      statements.push({ text: sql.slice(start, offset), start, end: offset, terminated: true });
      start = offset + 1;
    }
    offset += 1;
  }

  statements.push({ text: sql.slice(start), start, end: sql.length, terminated: false });
  return statements.filter(({ text }) => sqlKeyword(text) !== null);
}

function isTransactionControl(statement) {
  const first = sqlKeyword(statement);
  if (!first) return false;
  if (["BEGIN", "COMMIT", "END", "ROLLBACK", "ABORT", "SAVEPOINT", "RELEASE"].includes(first.value)) {
    return true;
  }
  const second = sqlKeyword(statement, first.end)?.value;
  return (first.value === "START" && second === "TRANSACTION")
    || (first.value === "PREPARE" && second === "TRANSACTION");
}

export function migrationSqlForTransaction(sql) {
  const statements = splitTopLevelSqlStatements(sql);
  const first = statements[0];
  const last = statements.at(-1);
  const hasBegin = first && isTransactionControl(first.text);
  const hasCommit = last && isTransactionControl(last.text);
  const wrapperShape = first && last && statements.length > 2
    && isOnlySqlKeyword(first.text, "BEGIN")
    && isOnlySqlKeyword(last.text, "COMMIT")
    && first.terminated && last.terminated;
  const wrapped = wrapperShape
    && !statements.slice(1, -1).some(({ text }) => isTransactionControl(text));

  if (statements.some(({ text }) => isTransactionControl(text)) && !wrapped) {
    throw new Error(hasBegin || hasCommit
      ? "Migration transaction wrapper must be exactly BEGIN; ... COMMIT;"
      : "Unsupported transaction control in migration SQL");
  }
  return wrapped
    ? sql.slice(first.end + 1, last.start + skipSqlTrivia(last.text, 0))
    : sql;
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
    try {
      migrationSqlForTransaction(sql);
    } catch (error) {
      throw new Error(`Invalid transaction wrapper in ${name}: ${error.message}`, { cause: error });
    }
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
