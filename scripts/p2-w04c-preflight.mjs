#!/usr/bin/env node
/** P2-W04C read-only Production preflight for cutoff 2026-09-30. */
import path from "node:path";
import process from "node:process";

import { Client } from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { readMigrations } from "./lib/migration-validation.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const CANDIDATE = "2026-09-30";
const CURRENT = "2026-10-06";
const EXPECTED_APPLIED = 46;
const EXPECTED_LOCAL = 47;
const MIGRATION = "20261008070000_p2_w04c_cutoff_rebaseline_2026_09_30.sql";

function stop(code, detail) {
  const error = new Error(detail);
  error.code = code;
  throw error;
}

async function main() {
  const migrations = await readMigrations(path.resolve("supabase/migrations"));
  if (migrations.length !== EXPECTED_LOCAL || migrations.at(-1)?.name !== MIGRATION) {
    stop("LOCAL_MIGRATION_INVENTORY_DRIFT",
      `expected ${EXPECTED_LOCAL} migrations ending in ${MIGRATION}`);
  }

  const { databaseUrl } = await loadSupabaseConfig();
  const client = new Client({
    connectionString: databaseUrl,
    ssl: buildSslOptions(),
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
  });
  await client.connect();
  let open = false;
  try {
    await client.query("begin read only");
    open = true;
    await client.query("set local statement_timeout = '15s'");

    const applied = await client.query(
      "select version, checksum from public.schema_migrations order by version",
    );
    if (applied.rows.length !== EXPECTED_APPLIED) {
      stop("APPLIED_MIGRATION_COUNT_DRIFT",
        `expected ${EXPECTED_APPLIED} applied, got ${applied.rows.length}`);
    }
    const index = new Map(applied.rows.map((row) => [row.version, row.checksum]));
    for (const migration of migrations.slice(0, -1)) {
      const checksum = index.get(migration.name);
      if (checksum === undefined) stop("APPLIED_MIGRATION_MISSING", migration.name);
      if (checksum !== migration.checksum) stop("APPLIED_MIGRATION_MISMATCH", migration.name);
    }
    if (index.has(MIGRATION)) stop("W04C_ALREADY_APPLIED", MIGRATION);

    const result = await client.query(
      `select
         public.direct_entry_reporting_cutoff()::text as current_cutoff,
         (select count(*)::bigint from public.daily_recruitment_breakdown) as legacy_rows,
         (select coalesce(sum(recruited_count), 0)::bigint
            from public.daily_recruitment_breakdown) as legacy_subtotal,
         (select count(*)::bigint from public.data_sources
           where active = true and is_test = false) as active_non_test_sources,
         (select count(*)::bigint
            from public.direct_entries e
            join public.direct_entry_submissions s on s.submission_id = e.submission_id
           where s.state = 'SUBMITTED' and e.deleted_at is null
             and e.first_work_date < $1::date) as de_before_candidate,
         (select count(*)::bigint
            from public.direct_entries e
            join public.direct_entry_submissions s on s.submission_id = e.submission_id
           where s.state = 'SUBMITTED' and e.deleted_at is null
             and e.first_work_date >= $1::date) as de_at_after_candidate`,
      [CANDIDATE],
    );
    const row = result.rows[0];
    const checks = {
      current_cutoff: row.current_cutoff,
      legacy_rows: Number(row.legacy_rows),
      legacy_subtotal: Number(row.legacy_subtotal),
      active_non_test_sources: Number(row.active_non_test_sources),
      de_before_candidate: Number(row.de_before_candidate),
      de_at_after_candidate: Number(row.de_at_after_candidate),
    };
    if (checks.current_cutoff !== CURRENT) stop("CURRENT_CUTOFF_DRIFT", checks.current_cutoff);
    if (checks.legacy_rows !== 0 || checks.legacy_subtotal !== 0) {
      stop("LEGACY_NOT_EMPTY", JSON.stringify(checks));
    }
    if (checks.active_non_test_sources !== 0) {
      stop("ACTIVE_NON_TEST_SOURCE", JSON.stringify(checks));
    }
    if (checks.de_before_candidate !== 0) {
      stop("DE_BEFORE_CANDIDATE", JSON.stringify(checks));
    }

    console.log("P2_W04C_PREFLIGHT_OK", JSON.stringify({
      candidate: CANDIDATE,
      applied: EXPECTED_APPLIED,
      pending: 1,
      ...checks,
      rollback: true,
    }));
  } finally {
    if (open) await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.code || "P2_W04C_PREFLIGHT_FAILED", error.message);
  process.exitCode = 1;
});
