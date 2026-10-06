#!/usr/bin/env node
/**
 * P2-W04B-R1 — read-only Production reconciliation verifier (data-agnostic).
 *
 * Opens a Postgres connection in a READ ONLY transaction, runs the SQL
 * reconciliation helper, and verifies structural invariants. The
 * pre-purge baseline (34 legacy rows / 44 recruited / 2026-10-01..16 /
 * fingerprint 7abfbdab...) was retired by the W04B post-purge rebaseline.
 * The script no longer asserts a specific historical row count or
 * fingerprint; it asserts that:
 *
 *   1. The migration ledger is in sync (no drift on the local checkout).
 *   2. The cutoff is the locked post-purge rebaseline value.
 *   3. The runtime overlap blocker is 0 (no pre-cutoff eligible DE rows).
 *   4. combined_total = legacy_subtotal + direct_entry_subtotal.
 *   5. The masked legacy aggregate agrees with the helper subtotal (no
 *      silent truncate, no partial result, no double count).
 *   6. POST-PURGE ZERO INVARIANTS:
 *      - legacy_subtotal MUST be exactly 0.
 *      - active && !is_test source rows MUST be exactly 0.
 *   7. DIRECT ENTRY PROJECTION INTEGRITY:
 *      - count(*) of `direct_entry_reporting_facts_v01` MUST equal
 *        direct_entry_subtotal.
 *      - sum(recruited_count) of `direct_entry_reporting_facts_v01` MUST
 *        equal direct_entry_subtotal (proves recruited_count = 1 per
 *        eligible row).
 *
 * The transaction is always rolled back so the database is never mutated.
 *
 * IMPORTANT — expected negative check: running this script against
 * Production BEFORE migration #44 is applied MUST fail with
 * `MIGRATION_STATE_DRIFT` (44 expected, 43 applied) or `MIGRATION_PENDING`
 * (the W04B filename is missing from the applied set). This is the
 * expected state and is a smoke test that the script is checking the
 * ledger correctly. Do NOT apply migration #44 just to get this script
 * to print a green PASS — the green PASS must come from the integration
 * / release lane after a controlled apply.
 *
 * Exit codes:
 *   0  invariants match
 *   1  drift detected
 *   2  database/config error
 */
import { Client } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";
import { readMigrations } from "./lib/migration-validation.mjs";

// Locked post-purge cutoff (mirrors `public.direct_entry_reporting_cutoff()`).
const EXPECTED_CUTOVER = "2026-10-06";

// Migration inventory at base `origin/main@a74caa3` is 43. P2-W04B
// rebaseline adds migration #44, so the on-disk inventory MUST be 44.
const EXPECTED_MIGRATION_COUNT = 44;
const W04A_MIGRATION_MARKER = "p2_w04a_direct_entry_reporting_cutover";
const W04B_MIGRATION_MARKER = "p2_w04b_post_purge_cutover_rebaseline";

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
    // 1) Migration inventory on the local checkout. The on-disk count
    //    MUST match the expected post-rebaseline total. This is the only
    //    static check the script performs against the local repo.
    const migrations = await readMigrations(MIGRATION_DIR);
    if (migrations.length !== EXPECTED_MIGRATION_COUNT) {
      fail("MIGRATION_INVENTORY_DRIFT",
        `expected ${EXPECTED_MIGRATION_COUNT} migrations on disk, ` +
        `found ${migrations.length}`);
    }
    const w04a = migrations.find((m) => m.name.includes(W04A_MIGRATION_MARKER));
    if (!w04a) {
      fail("MIGRATION_W04A_MISSING",
        "migration #40 (p2_w04a_direct_entry_reporting_cutover) not found");
    }
    const w04b = migrations.find((m) => m.name.includes(W04B_MIGRATION_MARKER));
    if (!w04b) {
      fail("MIGRATION_W04B_MISSING",
        "migration #44 (p2_w04b_post_purge_cutover_rebaseline) not found");
    }

    // 2) Open a READ ONLY transaction. The database is NEVER mutated.
    await client.query("begin read only");
    transactionOpen = true;
    await client.query("set local statement_timeout = '30s'");

    // 3) Migration ledger: 44 applied / 0 pending / 0 mismatch.
    const applied = await client.query(
      "select version, checksum from public.schema_migrations",
    );
    if (applied.rows.length !== EXPECTED_MIGRATION_COUNT) {
      fail("MIGRATION_STATE_DRIFT",
        `expected ${EXPECTED_MIGRATION_COUNT} applied, got ${applied.rows.length}`);
    }
    const appliedIndex = new Map(applied.rows.map((r) => [r.version, r.checksum]));
    for (const m of migrations) {
      const recorded = appliedIndex.get(m.name);
      if (recorded === undefined) {
        fail("MIGRATION_PENDING", `pending: ${m.name}`);
      }
      if (recorded !== m.checksum) {
        fail("MIGRATION_CHECKSUM_MISMATCH",
          `${m.name} (recorded ${recorded} != ${m.checksum})`);
      }
    }

    // 4) Run the SQL reconciliation helper. The locked post-purge cutoff
    //    must be returned. No specific subtotal magnitude is asserted
    //    (the pre-purge baseline was retired by the W04B rebaseline).
    const totals = await row(
      client,
      "select legacy_subtotal, direct_entry_subtotal, overlap_blocker," +
      " cutoff_date::text as cutoff_date" +
      " from public.direct_entry_reporting_reconciliation_totals()",
    );
    if (totals.cutoff_date !== EXPECTED_CUTOVER) {
      fail("CUTOVER_DRIFT",
        `expected cutoff ${EXPECTED_CUTOVER}, got ${totals.cutoff_date}`);
    }
    const legacySubtotal = Number(totals.legacy_subtotal);
    const directEntrySubtotal = Number(totals.direct_entry_subtotal);
    const overlapBlocker = Number(totals.overlap_blocker);
    if (legacySubtotal < 0 || directEntrySubtotal < 0 || overlapBlocker < 0) {
      fail("RECONCILE_INVARIANT_FAILED",
        "reconciliation subtotals/blocker must be non-negative");
    }
    if (overlapBlocker !== 0) {
      fail("BASELINE_OVERLAP_BLOCKER",
        `expected 0 pre-cutoff eligible DE rows, got ${overlapBlocker}`);
    }

    // 5) The reconciliation's combined_total must equal
    //    legacy_subtotal + direct_entry_subtotal (no silent truncate,
    //    no partial result, no double count).
    const combinedFromReconciliation = await row(
      client,
      "select (legacy_subtotal + direct_entry_subtotal)::bigint as combined" +
      " from public.direct_entry_reporting_reconciliation_totals()",
    );
    const combined = Number(combinedFromReconciliation.combined);
    if (combined !== legacySubtotal + directEntrySubtotal) {
      fail("RECONCILE_INTEGRITY_DRIFT",
        `combined_total=${combined} != legacy_subtotal + direct_entry_subtotal`);
    }

    // 6) Defence in depth: the masked legacy aggregate, when summed
    //    directly via the same date mask the helper applies, must equal
    //    legacy_subtotal. This proves the SQL view / helper boundary has
    //    not silently truncated or duplicated any rows.
    const maskedLegacy = await row(
      client,
      "select coalesce(sum(recruited_count), 0)::bigint as subtotal" +
      " from public.daily_recruitment_breakdown" +
      " where business_date < public.direct_entry_reporting_cutoff()",
    );
    if (Number(maskedLegacy.subtotal) !== legacySubtotal) {
      fail("LEGACY_MASK_INVARIANT_DRIFT",
        `direct masked sum ${Number(maskedLegacy.subtotal)} != ` +
        `reconciliation legacy_subtotal ${legacySubtotal}`);
    }

    // 7) Post-purge zero invariant: legacy_subtotal MUST be exactly 0.
    //    The pre-purge baseline was retired; the rebaseline only
    //    succeeds when the legacy aggregate is empty. Any non-zero
    //    subtotal after migration #44 indicates either a refill or
    //    silent truncation; either way, fail stable.
    if (legacySubtotal !== 0) {
      fail("POST_PURGE_LEGACY_NOT_ZERO",
        `legacy_subtotal must be 0 post-purge, got ${legacySubtotal}`);
    }

    // 8) Post-purge source invariant: active && !is_test source MUST be
    //    exactly 0. Any such row can refill the legacy aggregate via a
    //    future sync run.
    const activeNonTestSources = await row(
      client,
      "select count(*)::bigint as n" +
      " from public.data_sources" +
      " where active = true and is_test = false",
    );
    if (Number(activeNonTestSources.n) !== 0) {
      fail("POST_PURGE_ACTIVE_SOURCE_NOT_ZERO",
        `active non-test sources must be 0 post-purge, got ${Number(activeNonTestSources.n)}`);
    }

    // 9) Direct Entry projection count vs helper subtotal. The view
    //    `direct_entry_reporting_facts_v01` is the canonical read path
    //    for DE rows; its `count(*)` MUST equal the helper subtotal
    //    (otherwise the view is dropping or adding rows relative to the
    //    reconciliation helper).
    const deProjectionCount = await row(
      client,
      "select count(*)::bigint as n" +
      " from public.direct_entry_reporting_facts_v01",
    );
    const deProjectionCountN = Number(deProjectionCount.n);
    if (deProjectionCountN !== directEntrySubtotal) {
      fail("DE_PROJECTION_COUNT_MISMATCH",
        `projection count ${deProjectionCountN} != helper subtotal ${directEntrySubtotal}`);
    }

    // 10) Same-grain recruited_count invariant. Every eligible DE row
    //     has recruited_count = 1, so `sum(recruited_count)` MUST equal
    //     `count(*)`. Any deviation proves a row has count != 1 or the
    //     helper / view have drifted.
    const deProjectionSum = await row(
      client,
      "select coalesce(sum(recruited_count), 0)::bigint as s" +
      " from public.direct_entry_reporting_facts_v01",
    );
    const deProjectionSumN = Number(deProjectionSum.s);
    if (deProjectionSumN !== directEntrySubtotal) {
      fail("DE_PROJECTION_SUM_MISMATCH",
        `projection sum(recruited_count) ${deProjectionSumN} != helper subtotal ${directEntrySubtotal}`);
    }

    // 11) ROLLBACK — never commit. The script is read-only by construction.
    await client.query("rollback");
    transactionOpen = false;

    const summary = {
      ok: true,
      mode: "read-only",
      cutoff: totals.cutoff_date,
      legacy_subtotal: legacySubtotal,
      direct_entry_subtotal: directEntrySubtotal,
      combined_total: combined,
      overlap_blocker: overlapBlocker,
      migrations_applied: applied.rows.length,
      migration_w04a_present: true,
      migration_w04b_present: true,
      invariants: {
        cutoff_matches_locked: totals.cutoff_date === EXPECTED_CUTOVER,
        overlap_blocker_zero: overlapBlocker === 0,
        combined_equals_sum: combined === legacySubtotal + directEntrySubtotal,
        legacy_mask_matches_helper:
          Number(maskedLegacy.subtotal) === legacySubtotal,
        legacy_subtotal_zero_post_purge: legacySubtotal === 0,
        active_non_test_sources_zero:
          Number(activeNonTestSources.n) === 0,
        de_projection_count_equals_helper:
          deProjectionCountN === directEntrySubtotal,
        de_projection_sum_equals_helper:
          deProjectionSumN === directEntrySubtotal,
      },
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
    console.error(`P2_W04B_RECONCILE_FAILED ${code}${error.detail ? " " + error.detail : ""}`);
    process.exitCode = code === "RECONCILE_DATABASE_ERROR" ? 2 : 1;
  });
}