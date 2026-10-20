import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const S0_T1_C_MIGRATION_NAME =
  "20261020180000_s0_t1_c_rpc_acl_allowlist.sql";
export const S0_T1_C_PRE_PR92_CHECKSUM =
  "7382013e39521601ae1c08de22e7579dc289a8e113ea8c362f8be6ba66e3417f";
export const S0_T1_C_CURRENT_CHECKSUM =
  "f4caf15770299af1b4527350b2f137ff805d35b01960a62a2442a24a87681126";
export const R1_2_MIGRATION_NAME =
  "20261021100000_r1_2_worker_management_uat_fixes.sql";
export const R1_2_SERVICE_RPC_SIGNATURE =
  "public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer, text)";
export const S0_T1_C_TARGET_ROUTINE_PATTERN =
  "^(direct_entry_|ai_report_|ai_provider_config_|recruitment_|(expand|replace|reject|upsert)_daily_recruitment|record_recruitment_source_failure_|set_updated_at$)";

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

export function extractS0T1CAllowlistSignatures(migrationSql) {
  return [...migrationSql.matchAll(/^\s+'(public\.[^']+)'[,]?$/gm)].map(
    (match) => match[1],
  );
}

/**
 * Read-only verification of S0-T1-C security postconditions when a database ledger
 * carries the verified pre-PR #92 checksum (`7382013e...`) for migration #124.
 *
 * Uses a single SELECT statement so it works identically in read-only `--dry-run`
 * and in the apply runner without mutating any table or ledger row.
 */
export async function verifyS0T1CHistoricalCompatibility(
  client,
  migrationSql,
  { r1_2Applied = false } = {},
) {
  const baseAllowlist = extractS0T1CAllowlistSignatures(migrationSql);
  if (baseAllowlist.length === 0) {
    return {
      ok: false,
      reason: "S0-T1-C source allowlist could not be parsed",
    };
  }
  const expectedAllowlist = r1_2Applied
    ? [...baseAllowlist, R1_2_SERVICE_RPC_SIGNATURE]
    : baseAllowlist;

  const { rows } = await client.query(
    `select
       (select count(*)::integer
          from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prokind in ('f', 'p')
           and p.proname ~ $1
           and (
             pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
             or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
             or exists (
               select 1
                 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE'
             )
           )
       ) as exposed_client_or_public_count,
       (select coalesce(
                 array_agg(p.oid::pg_catalog.regprocedure::text order by p.oid::pg_catalog.regprocedure::text),
                 array[]::text[]
               )
          from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prokind in ('f', 'p')
           and p.proname ~ $1
           and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
       ) as actual_service_signatures,
       (select coalesce(
                 array_agg(
                   pg_catalog.to_regprocedure(u.sig)::pg_catalog.regprocedure::text
                   order by pg_catalog.to_regprocedure(u.sig)::pg_catalog.regprocedure::text
                 ),
                 array[]::text[]
               )
          from unnest($2::text[]) as u(sig)
         where pg_catalog.to_regprocedure(u.sig) is not null
       ) as expected_service_signatures,
       (select count(*)::integer
          from unnest($2::text[]) as u(sig)
         where pg_catalog.to_regprocedure(u.sig) is null
       ) as missing_allowlist_count,
       (select count(*)::integer
          from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prokind in ('f', 'p')
           and p.proname ~ $1
           and not pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE')
       ) as missing_owner_exec_count,
       (select count(*)::integer
          from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prokind in ('f', 'p')
           and p.proname ~ '^direct_entry_'
           and p.prosecdef
           and not coalesce(
             'search_path=pg_catalog, public' = any(p.proconfig)
             or 'search_path=pg_catalog' = any(p.proconfig),
             false
           )
       ) as unsafe_secdef_search_path_count,
       (select coalesce(
                 bool_and(
                   r.rolname = 'direct_entry_catalog_bootstrap_executor'
                   and p.prosecdef
                   and coalesce('search_path=pg_catalog, public' = any(p.proconfig), false)
                   and pg_catalog.has_function_privilege('direct_entry_catalog_bootstrap_executor', p.oid, 'EXECUTE')
                 ),
                 false
               )
               and count(*) = 3
               and pg_catalog.has_function_privilege(
                 'service_role',
                 'public.direct_entry_catalog_bootstrap_plan(uuid, uuid)'::pg_catalog.regprocedure,
                 'EXECUTE'
               )
               and pg_catalog.has_function_privilege(
                 'service_role',
                 'public.direct_entry_apply_catalog_bootstrap(uuid, uuid, text, text, text)'::pg_catalog.regprocedure,
                 'EXECUTE'
               )
               and not pg_catalog.has_function_privilege(
                 'service_role',
                 'public.direct_entry_catalog_bootstrap_projection()'::pg_catalog.regprocedure,
                 'EXECUTE'
               )
          from pg_catalog.pg_proc p
          join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          join pg_catalog.pg_roles r on r.oid = p.proowner
         where n.nspname = 'public'
           and p.oid in (
             'public.direct_entry_catalog_bootstrap_plan(uuid, uuid)'::pg_catalog.regprocedure,
             'public.direct_entry_apply_catalog_bootstrap(uuid, uuid, text, text, text)'::pg_catalog.regprocedure,
             'public.direct_entry_catalog_bootstrap_projection()'::pg_catalog.regprocedure
           )
       ) as bootstrap_executor_intact`,
    [S0_T1_C_TARGET_ROUTINE_PATTERN, expectedAllowlist],
  );

  const row = rows[0];
  if (!row) {
    return { ok: false, reason: "S0-T1-C postcondition query returned no row" };
  }
  if (row.exposed_client_or_public_count !== 0) {
    return {
      ok: false,
      reason: `S0-T1-C postcondition failed: ${row.exposed_client_or_public_count} routine(s) exposed to anon/authenticated/PUBLIC`,
    };
  }
  if (row.missing_allowlist_count !== 0) {
    return {
      ok: false,
      reason: `S0-T1-C postcondition failed: ${row.missing_allowlist_count} allowlisted signature(s) missing`,
    };
  }
  const actualService = Array.isArray(row.actual_service_signatures)
    ? row.actual_service_signatures
    : [];
  const expectedService = Array.isArray(row.expected_service_signatures)
    ? row.expected_service_signatures
    : [];
  if (
    actualService.length !== expectedService.length ||
    actualService.some((sig, idx) => sig !== expectedService[idx])
  ) {
    return {
      ok: false,
      reason: "S0-T1-C postcondition failed: service_role EXECUTE set does not match allowlist",
    };
  }
  if (row.missing_owner_exec_count !== 0) {
    return {
      ok: false,
      reason: `S0-T1-C postcondition failed: ${row.missing_owner_exec_count} routine(s) missing owner EXECUTE`,
    };
  }
  if (row.unsafe_secdef_search_path_count !== 0) {
    return {
      ok: false,
      reason: `S0-T1-C postcondition failed: ${row.unsafe_secdef_search_path_count} SECURITY DEFINER routine(s) missing locked search_path`,
    };
  }
  if (row.bootstrap_executor_intact !== true) {
    return {
      ok: false,
      reason: "S0-T1-C postcondition failed: catalog bootstrap executor ownership/ACL/SECURITY DEFINER mismatch",
    };
  }
  return { ok: true };
}

/**
 * Shared checksum verification used identically by `--dry-run` validation and
 * the migration apply runner.
 *
 * Returns:
 *   - `{ status: "match" }` when `appliedChecksum === migration.checksum`
 *   - `{ status: "compatible_historical" }` ONLY when `migration.name` is `#124`
 *     (`20261020180000_s0_t1_c_rpc_acl_allowlist.sql`), `migration.checksum` is
 *     `S0_T1_C_CURRENT_CHECKSUM`, `appliedChecksum` is `S0_T1_C_PRE_PR92_CHECKSUM`,
 *     and all S0-T1-C security postconditions pass in the database
 *   - `{ status: "mismatch", reason }` for any other mismatch (fail-closed)
 */
export async function verifyAppliedMigrationChecksum(
  client,
  migration,
  appliedChecksum,
  appliedMap,
) {
  if (appliedChecksum === migration.checksum) {
    return { status: "match" };
  }
  if (
    migration.name === S0_T1_C_MIGRATION_NAME &&
    migration.checksum === S0_T1_C_CURRENT_CHECKSUM &&
    appliedChecksum === S0_T1_C_PRE_PR92_CHECKSUM
  ) {
    const postconditions = await verifyS0T1CHistoricalCompatibility(
      client,
      migration.sql,
      { r1_2Applied: appliedMap.has(R1_2_MIGRATION_NAME) },
    );
    if (postconditions.ok) {
      return { status: "compatible_historical" };
    }
    return {
      status: "mismatch",
      reason: postconditions.reason,
    };
  }
  return {
    status: "mismatch",
    reason: "unrecognized checksum mismatch",
  };
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
        continue;
      }
      const check = await verifyAppliedMigrationChecksum(
        client,
        migration,
        previous,
        applied,
      );
      if (check.status === "match") {
        log(`APPLIED ${migration.name} (checksum matches)`);
      } else if (check.status === "compatible_historical") {
        log(
          `APPLIED ${migration.name} (verified pre-PR #92 historical checksum compatibility)`,
        );
      } else {
        log(
          `CHECKSUM MISMATCH ${migration.name}${check.reason ? ` (${check.reason})` : ""}`,
        );
        mismatches.push(migration.name);
      }
    }
    log(`\nDB-aware dry-run: ${migrations.length} migration(s); read-only.`);
    return { migrations, mismatches };
  } finally {
    await client.end();
  }
}

export async function runMigrationApply({
  directory,
  loadConfig,
  createClient,
  log = console.log,
  errorLog = console.error,
}) {
  const migrations = await readMigrations(directory);
  const { databaseUrl, projectRef = "local", usesPooler = false } = await loadConfig();
  const client = createClient(databaseUrl);
  await client.connect();
  log(
    `Kết nối DB thành công (project ref: ${String(projectRef).slice(0, 4)}***, pooler: ${usesPooler ? "có" : "không"})`,
  );

  await client.query(`
    create table if not exists public.schema_migrations (
      version     text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )
  `);

  const { rows: applied } = await client.query(
    "select version, checksum from public.schema_migrations",
  );
  const appliedMap = new Map(applied.map((r) => [r.version, r.checksum]));

  let appliedCount = 0;
  let skippedCount = 0;

  for (const migration of migrations) {
    const previous = appliedMap.get(migration.name);

    if (previous !== undefined) {
      const check = await verifyAppliedMigrationChecksum(
        client,
        migration,
        previous,
        appliedMap,
      );
      if (check.status === "mismatch") {
        await client.end();
        throw new Error(
          `Migration ${migration.name} đã áp dụng nhưng nội dung đã thay đổi (checksum mismatch${check.reason ? `: ${check.reason}` : ""}). ` +
            "Không sửa file migration đã áp dụng — hãy tạo file migration mới.",
        );
      }
      if (check.status === "compatible_historical") {
        log(
          `SKIP    ${migration.name} (đã áp dụng — tương thích checksum lịch sử trước PR #92 đã xác minh postconditions)`,
        );
      } else {
        log(`SKIP    ${migration.name} (đã áp dụng)`);
      }
      skippedCount += 1;
      continue;
    }

    try {
      await client.query("begin");
      await client.query(migrationSqlForTransaction(migration.sql));
      await client.query(
        "insert into public.schema_migrations (version, checksum) values ($1, $2)",
        [migration.name, migration.checksum],
      );
      await client.query("commit");
      appliedMap.set(migration.name, migration.checksum);
      log(`APPLY   ${migration.name}`);
      appliedCount += 1;
    } catch (error) {
      try {
        await client.query("rollback");
      } finally {
        await client.end();
      }
      errorLog(`FAILED  ${migration.name}: ${error.message}`);
      throw error;
    }
  }

  log(
    `\nKết quả: ${appliedCount} áp dụng mới, ${skippedCount} bỏ qua, ${migrations.length} tổng.`,
  );

  const { rows: tables } = await client.query(`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('data_sources', 'sync_runs', 'daily_recruitment_breakdown', 'sync_errors')
     order by table_name
  `);
  log(
    "Bảng hiện có: " +
      (tables.map((r) => r.table_name).join(", ") || "(không có)"),
  );

  await client.end();
  return { appliedCount, skippedCount, totalCount: migrations.length };
}
