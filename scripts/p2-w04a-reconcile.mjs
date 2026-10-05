#!/usr/bin/env node
/**
 * P2-W04A — read-only Production reconciliation dry-run.
 *
 * Opens a Postgres connection, runs the migration #40 reconciliation helper
 * (and a parallel projection read of the cutover-masked legacy aggregate) in
 * a READ ONLY transaction, and verifies that the live Production baseline
 * matches the locked fingerprint:
 *
 *   - legacy_rows         = 34
 *   - recruited_total     = 44
 *   - business_date range = 2026-10-01..2026-10-16
 *   - direct_entry eligible on legacy side of cutoff = 0
 *   - cutoff              = 2026-10-17
 *
 * The transaction is always rolled back so the database is never mutated.
 * Exit codes:
 *   0  baseline matches
 *   1  drift detected (one of the invariants above failed)
 *   2  database/config error
 */
import { createHash } from "node:crypto";
import { Client } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";
import { readMigrations } from "./lib/migration-validation.mjs";

const EXPECTED_CUTOVER = "2026-10-17";
const EXPECTED_LEGACY_ROWS = 34;
const EXPECTED_RECRUITED_TOTAL = 44;
const EXPECTED_BUSINESS_DATE_MIN = "2026-10-01";
const EXPECTED_BUSINESS_DATE_MAX = "2026-10-16";
const EXPECTED_DIRECT_ENTRY_ELIGIBLE = 0;
const EXPECTED_FINGERPRINT =
  "7abfbdab53b0f1b01bd119a02b5ebe5417f3a369d7a9ccdba26e425b2106b1bd";
const MIGRATION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../supabase/migrations",
);

function fail(code, detail) {
  const err = new Error(detail || code);
  err.code = code;
  err.detail = detail;
  throw err;
}

function row(client, sql, values) {
  return client.query(sql, values).then((r) => {
    if (r.rows.length !== 1) {
      fail("RECONCILE_INVARIANT_FAILED",
        `expected 1 row, got ${r.rows.length} from: ${sql.slice(0, 80)}...`);
    }
    return r.rows[0];
  });
}

function fingerprint(rows) {
  const canonical = rows
    .map((r) => [
      r.source_id,
      r.business_date,
      r.project_key,
      r.recruiter_key,
      r.provider_type_key,
      r.employment_type_key,
      Number(r.recruited_count),
    ].join("|"))
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

async function main() {
  const config = await loadSupabaseConfig();
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: buildSslOptions(),
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
  });
  await client.connect();

  let transactionOpen = false;
  try {
    // 1) Verify the migration set is exactly 40 and that #40 is present
    //    with the expected checksum (idempotent across runs).
    const migrations = await readMigrations(MIGRATION_DIR);
    if (migrations.length !== 40) {
      fail("MIGRATION_INVENTORY_DRIFT",
        `expected 40 migrations on disk, found ${migrations.length}`);
    }
    const cutover = migrations.find((m) => m.name.includes("p2_w04a_direct_entry_reporting_cutover"));
    if (!cutover) {
      fail("MIGRATION_W04A_MISSING", "migration #40 file not found in supabase/migrations");
    }

    // 2) Open a READ ONLY transaction. The database is NEVER mutated.
    await client.query("begin read only");
    transactionOpen = true;
    await client.query("set local statement_timeout = '30s'");

    // 3) Migration state: 40 applied / 0 pending / 0 mismatch.
    const applied = await client.query(
      "select version, checksum from public.schema_migrations"
    );
    if (applied.rows.length !== 40) {
      fail("MIGRATION_STATE_DRIFT",
        `expected 40 applied, got ${applied.rows.length}`);
    }
    const appliedIndex = new Map(applied.rows.map((r) => [r.version, r.checksum]));
    for (const m of migrations) {
      const recorded = appliedIndex.get(m.name);
      if (recorded === undefined) {
        fail("MIGRATION_PENDING", `pending: ${m.name}`);
      }
      if (recorded !== m.checksum) {
        fail("MIGRATION_CHECKSUM_MISMATCH", `${m.name} (recorded ${recorded} != ${m.checksum})`);
      }
    }

    // 4) Run the SQL reconciliation helper. This is the single source of
    //    truth for the locked contract.
    const totals = await row(
      client,
      "select * from public.direct_entry_reporting_reconciliation_totals()",
    );
    if (totals.cutoff_date.toISOString().slice(0, 10) !== EXPECTED_CUTOVER) {
      fail("CUTOVER_DRIFT",
        `expected cutoff ${EXPECTED_CUTOVER}, got ${totals.cutoff_date.toISOString().slice(0, 10)}`);
    }
    if (Number(totals.legacy_subtotal) !== EXPECTED_RECRUITED_TOTAL) {
      fail("BASELINE_RECRUITED_TOTAL_DRIFT",
        `expected legacy subtotal ${EXPECTED_RECRUITED_TOTAL}, ` +
        `got ${Number(totals.legacy_subtotal)}`);
    }
    if (Number(totals.overlap_blocker) !== EXPECTED_DIRECT_ENTRY_ELIGIBLE) {
      fail("BASELINE_OVERLAP_BLOCKER",
        `expected 0 pre-cutoff eligible DE rows, got ${Number(totals.overlap_blocker)}`);
    }

    // 5) Read the legacy aggregate that drives the baseline. The cutoff
    //    mask is also enforced here as a defence in depth.
    const rows = (await client.query(
      "select source_id, business_date::text, project_key, recruiter_key," +
      " provider_type_key, employment_type_key, recruited_count::int as recruited_count" +
      " from public.daily_recruitment_breakdown" +
      " where business_date < '2026-10-17'" +
      " order by business_date, source_id, project_key, recruiter_key," +
      " provider_type_key, employment_type_key"
    )).rows;

    if (rows.length !== EXPECTED_LEGACY_ROWS) {
      fail("BASELINE_ROW_COUNT_DRIFT",
        `expected ${EXPECTED_LEGACY_ROWS} legacy rows, got ${rows.length}`);
    }
    const total = rows.reduce((a, r) => a + Number(r.recruited_count), 0);
    if (total !== EXPECTED_RECRUITED_TOTAL) {
      fail("BASELINE_SUM_DRIFT",
        `expected sum ${EXPECTED_RECRUITED_TOTAL}, got ${total}`);
    }
    const minDate = rows[0]?.business_date;
    const maxDate = rows[rows.length - 1]?.business_date;
    if (minDate !== EXPECTED_BUSINESS_DATE_MIN) {
      fail("BASELINE_MIN_DATE_DRIFT",
        `expected min ${EXPECTED_BUSINESS_DATE_MIN}, got ${minDate}`);
    }
    if (maxDate !== EXPECTED_BUSINESS_DATE_MAX) {
      fail("BASELINE_MAX_DATE_DRIFT",
        `expected max ${EXPECTED_BUSINESS_DATE_MAX}, got ${maxDate}`);
    }
    const fp = fingerprint(rows);
    if (fp !== EXPECTED_FINGERPRINT) {
      fail("BASELINE_FINGERPRINT_DRIFT",
        `expected ${EXPECTED_FINGERPRINT}, got ${fp}`);
    }

    // 6) The Direct Entry projection must be empty (pre-cutover DE rows
    //    raise the overlap_blocker above, but on a clean baseline the
    //    projection is empty and there are no eligible DE rows yet).
    const deCount = await client.query(
      "select count(*)::bigint as n from public.direct_entry_reporting_facts_v01"
    );
    if (Number(deCount.rows[0].n) !== EXPECTED_DIRECT_ENTRY_ELIGIBLE) {
      fail("DIRECT_ENTRY_PROJECTION_NOT_EMPTY",
        `expected 0 projection rows on baseline, got ${Number(deCount.rows[0].n)}`);
    }

    // 7) ROLLBACK — never commit. The script is read-only by construction.
    await client.query("rollback");
    transactionOpen = false;

    const summary = {
      ok: true,
      mode: "read-only",
      cutoff: EXPECTED_CUTOVER,
      legacy_rows: rows.length,
      recruited_total: total,
      business_date_min: minDate,
      business_date_max: maxDate,
      fingerprint: fp,
      direct_entry_eligible_subtotal: Number(totals.direct_entry_subtotal),
      overlap_blocker: Number(totals.overlap_blocker),
      migrations_applied: applied.rows.length,
      migration_w04a_present: true,
      rolled_back: true,
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (transactionOpen) {
      try { await client.query("rollback"); } catch { /* best effort */ }
    }
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) {
  main().catch((error) => {
    const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code)
      ? error.code
      : "RECONCILE_DATABASE_ERROR";
    console.error(`P2_W04A_RECONCILE_FAILED ${code}${error.detail ? " " + error.detail : ""}`);
    process.exitCode = code === "RECONCILE_DATABASE_ERROR" ? 2 : 1;
  });
}
