#!/usr/bin/env node
/**
 * P2-W04B Phase 0 — read-only Production preflight.
 *
 * Opens BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '15s';
 * emits counts/date buckets only; never logs PII, URLs or secrets; always
 * rolls back. The script is the evidence collector for the rebaseline
 * decision: it MUST stop before any migration/apply if any of the stop
 * conditions listed in the task is violated.
 */
import { Client } from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";
import { readMigrations } from "./lib/migration-validation.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../supabase/migrations",
);

function logRow(label, value) {
  console.log(`${label}: ${value}`);
}

async function main() {
  const config = await loadSupabaseConfig();
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: buildSslOptions(),
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
  });
  await client.connect();

  let transactionOpen = false;
  try {
    await client.query("begin");
    await client.query("set transaction read only");
    await client.query("set local statement_timeout = '15s'");
    transactionOpen = true;

    // 1. Migration ledger.
    const applied = await client.query(
      "select version, checksum from public.schema_migrations",
    );
    logRow("MIGRATIONS_APPLIED", applied.rows.length);
    const migrations = await readMigrations(MIGRATION_DIR);
    logRow("MIGRATIONS_ON_DISK", migrations.length);
    const appliedIndex = new Map(applied.rows.map((r) => [r.version, r.checksum]));
    let pending = 0;
    let mismatched = 0;
    for (const m of migrations) {
      const recorded = appliedIndex.get(m.name);
      if (recorded === undefined) pending += 1;
      else if (recorded !== m.checksum) mismatched += 1;
    }
    logRow("MIGRATIONS_PENDING", pending);
    logRow("MIGRATIONS_CHECKSUM_MISMATCH", mismatched);

    // 2. Legacy aggregate subtotal (post-purge target = 0).
    const legacyAgg = await client.query(
      "select count(*)::bigint as n, coalesce(sum(recruited_count), 0)::bigint as total " +
      "from public.daily_recruitment_breakdown where business_date < '2026-10-06'",
    );
    logRow("LEGACY_ROWS_BEFORE_CUTOFF", Number(legacyAgg.rows[0].n));
    logRow("LEGACY_RECRUITED_TOTAL_BEFORE_CUTOFF", Number(legacyAgg.rows[0].total));

    const legacyAll = await client.query(
      "select count(*)::bigint as n from public.daily_recruitment_breakdown",
    );
    logRow("LEGACY_ROWS_ALL", Number(legacyAll.rows[0].n));

    // 3. Direct Entry eligible counts by date band.
    const deBands = await client.query(
      "select " +
      "  sum(case when e.first_work_date <  date '2026-10-06' then 1 else 0 end)::bigint as band_pre, " +
      "  sum(case when e.first_work_date >= date '2026-10-06' and e.first_work_date <  date '2026-10-17' then 1 else 0 end)::bigint as band_window, " +
      "  sum(case when e.first_work_date >= date '2026-10-17' then 1 else 0 end)::bigint as band_post " +
      "from public.direct_entries e " +
      "join public.direct_entry_submissions s on s.submission_id = e.submission_id " +
      "where s.state = 'SUBMITTED' and e.deleted_at is null",
    );
    logRow("DE_ELIGIBLE_PRE_NEW_CUTOFF", Number(deBands.rows[0].band_pre));
    logRow("DE_ELIGIBLE_06_TO_16", Number(deBands.rows[0].band_window));
    logRow("DE_ELIGIBLE_GE_20261017", Number(deBands.rows[0].band_post));

    // 3b. Any eligible Direct Entry in the OLD pre-cutoff band (2026-10-06..2026-10-16).
    //     Migration #40 hard-coded the old cutoff to 2026-10-17; if anything sits in the
    //     2026-10-06..2026-10-16 band (which the OLD cutover excluded), the rebaseline
    //     must count it but it is NOT a blocker because the new cutoff accepts it.
    const deOldWindow = await client.query(
      "select count(*)::bigint as n " +
      "from public.direct_entries e " +
      "join public.direct_entry_submissions s on s.submission_id = e.submission_id " +
      "where s.state = 'SUBMITTED' and e.deleted_at is null " +
      "  and e.first_work_date >= date '2026-10-06' and e.first_work_date < date '2026-10-17'",
    );
    logRow("DE_ELIGIBLE_IN_OLD_EXCLUDED_WINDOW", Number(deOldWindow.rows[0].n));

    // 4. Current overlap blocker + reconciliation totals (using the OLD helper).
    const totals = await client.query(
      "select legacy_subtotal, direct_entry_subtotal, overlap_blocker, " +
      "       cutoff_date::text as cutoff_date " +
      "from public.direct_entry_reporting_reconciliation_totals()",
    );
    logRow("RECON_LEGACY_SUBTOTAL", Number(totals.rows[0].legacy_subtotal));
    logRow("RECON_DIRECT_ENTRY_SUBTOTAL", Number(totals.rows[0].direct_entry_subtotal));
    logRow("RECON_OVERLAP_BLOCKER", Number(totals.rows[0].overlap_blocker));
    logRow("RECON_CUTOVER_DATE", totals.rows[0].cutoff_date);

    // 5. Source-registry inactive posture: no refill of legacy aggregate.
    const sources = await client.query(
      "select " +
      "  count(*)::bigint as total, " +
      "  sum(case when active then 1 else 0 end)::bigint as active_rows, " +
      "  sum(case when is_test then 1 else 0 end)::bigint as test_rows " +
      "from public.data_sources",
    );
    logRow("SOURCES_TOTAL", Number(sources.rows[0].total));
    logRow("SOURCES_ACTIVE", Number(sources.rows[0].active_rows));
    logRow("SOURCES_TEST", Number(sources.rows[0].test_rows));

    // 5b. Confirm no row is both active and non-test (would refill the aggregate).
    const refillRisk = await client.query(
      "select count(*)::bigint as n " +
      "from public.data_sources " +
      "where active = true and is_test = false",
    );
    logRow("SOURCES_ACTIVE_NON_TEST", Number(refillRisk.rows[0].n));

    await client.query("rollback");
    transactionOpen = false;
    logRow("ROLLBACK", "OK");
  } finally {
    if (transactionOpen) {
      try { await client.query("rollback"); } catch { /* best effort */ }
    }
    await client.end();
  }
}

main().catch((error) => {
  console.error(`PREFLIGHT_FAILED ${error?.message ?? "UNKNOWN"}`);
  process.exitCode = 2;
});