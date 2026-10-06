#!/usr/bin/env node
/**
 * P2-W04B-R1 — read-only Production preflight as a fail-closed safety gate.
 *
 * This script is the executable guard before any apply of migration
 * #44 (`20261008030000_p2_w04b_post_purge_cutover_rebaseline.sql`).
 *
 * The script opens a Postgres session in
 *     BEGIN;
 *     SET TRANSACTION READ ONLY;
 *     SET LOCAL statement_timeout = '15s';
 *     ... read-only queries ...
 *     ROLLBACK;
 * and evaluates a small stop-condition table. It never logs PII, URLs,
 * UUID actors, emails or secrets. Only counts, date bands, and stable
 * error codes are emitted.
 *
 * Stop conditions (any one => exit 1, no apply):
 *   STALE_LOCAL_INVENTORY          local migration count != 44
 *   PRODUCTION_NOT_AT_43           production applied count != 43
 *   UNEXPECTED_PENDING             pending != exactly W04B filename
 *   CHECKSUM_MISMATCH              any local migration checksum != DB
 *   DB_MISSING_LOCAL               applied migration absent on disk
 *   CUTOVER_NOT_OLD                production cutoff != 2026-10-17
 *   LEGACY_NOT_ZERO                legacy aggregate still has rows
 *   DE_PRE_CUTOFF_BLOCKER          eligible DE with first_work_date < 2026-10-06
 *   ACTIVE_SOURCE_NOT_ZERO         data_sources active && !is_test > 0
 *
 * The DE band `2026-10-06 <= first_work_date < 2026-10-17` is NOT a
 * blocker under the new contract; its count is logged for visibility
 * but the evaluator accepts it.
 *
 * DB / config / unexpected failures => exit 2.
 *
 * The evaluator (`evaluatePreflight`) is a pure function that takes a
 * `PreflightDb` adapter and a `PreflightInput` so it can be unit-tested
 * without touching Production.
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

// Locked post-purge rebaseline target. Mirrors
// `public.direct_entry_reporting_cutoff()` in migration #44.
const NEW_CUTOVER = "2026-10-06";

// Migration #44 filename (must be the LAST one on disk).
const W04B_FILENAME =
  "20261008030000_p2_w04b_post_purge_cutover_rebaseline.sql";

// Old cutoff still present in Production (until W04B is applied).
const OLD_CUTOVER = "2026-10-17";

/**
 * @typedef {{ version: string; checksum: string }} AppliedRow
 */

/**
 * @typedef {{
 *   legacy_subtotal: number;
 *   direct_entry_subtotal: number;
 *   overlap_blocker: number;
 *   cutoff_date: string;
 * }} TotalsRow
 */

/**
 * Per-stop-condition classification. Used by the unit test.
 */
export const STOP_REASONS = Object.freeze({
  STALE_LOCAL_INVENTORY: "STALE_LOCAL_INVENTORY",
  PRODUCTION_NOT_AT_43: "PRODUCTION_NOT_AT_43",
  UNEXPECTED_PENDING: "UNEXPECTED_PENDING",
  CHECKSUM_MISMATCH: "CHECKSUM_MISMATCH",
  DB_MISSING_LOCAL: "DB_MISSING_LOCAL",
  CUTOVER_NOT_OLD: "CUTOVER_NOT_OLD",
  LEGACY_NOT_ZERO: "LEGACY_NOT_ZERO",
  DE_PRE_CUTOFF_BLOCKER: "DE_PRE_CUTOFF_BLOCKER",
  ACTIVE_SOURCE_NOT_ZERO: "ACTIVE_SOURCE_NOT_ZERO",
});

/**
 * Preflight DB adapter — the only Production-touching surface. The test
 * suite provides a fake that simulates every stop without opening a real
 * transaction.
 *
 * @typedef {{
 *   withReadOnly: <T>(fn: (q: PreflightQueries) => Promise<T>) => Promise<T>;
 * }} PreflightDb
 *
 * @typedef {{
 *   appliedMigrations: () => Promise<AppliedRow[]>;
 *   reconciliationTotals: () => Promise<TotalsRow>;
 *   legacyAll: () => Promise<number>;
 *   legacyMaskedSubtotal: () => Promise<number>;
 *   dePreNewCutoff: () => Promise<number>;
 *   deWindow: () => Promise<number>;
 *   dePostOldCutoff: () => Promise<number>;
 *   activeNonTestSources: () => Promise<number>;
 * }} PreflightQueries
 */

/**
 * Pure evaluator. Returns either `PreflightOk` or `PreflightStop`.
 * Performs no IO itself — the caller passes a `PreflightDb` adapter.
 */
export async function evaluatePreflight(
  input,
  db,
) {
  const localByName = new Map(
    input.localMigrations.map((m) => [m.name, m.checksum]),
  );
  const localCount = input.localMigrations.length;

  const baseSummary = {
    legacy_rows_total: 0,
    legacy_subtotal_masked: 0,
    de_pre_new_cutoff: 0,
    de_window_06_to_16: 0,
    de_post_old_cutoff: 0,
    active_non_test_sources: 0,
    local_migration_count: localCount,
    production_applied_count: 0,
    pending_count: 0,
    mismatch_count: 0,
  };

  if (localCount !== input.expectedLocalCount) {
    return {
      ok: false,
      reason: "STALE_LOCAL_INVENTORY",
      message: `local migration count ${localCount} != expected ${input.expectedLocalCount}`,
      summary: baseSummary,
    };
  }

  return await db.withReadOnly(async (q) => {
    const applied = await q.appliedMigrations();
    const appliedByName = new Map(applied.map((r) => [r.version, r.checksum]));

    let pending = 0;
    let mismatched = 0;
    let missingOnDisk = 0;
    let pendingNames = [];
    for (const m of input.localMigrations) {
      const recorded = appliedByName.get(m.name);
      if (recorded === undefined) {
        pending += 1;
        pendingNames.push(m.name);
      } else if (recorded !== m.checksum) {
        mismatched += 1;
      }
    }
    for (const name of appliedByName.keys()) {
      if (!localByName.has(name)) missingOnDisk += 1;
    }

    const summary = {
      ...baseSummary,
      production_applied_count: applied.length,
      pending_count: pending,
      mismatch_count: mismatched,
    };

    if (applied.length !== input.expectedProductionCount) {
      return {
        ok: false,
        reason: "PRODUCTION_NOT_AT_43",
        message: `production applied count ${applied.length} != expected ${input.expectedProductionCount}`,
        summary,
      };
    }
    if (pending !== 1 || pendingNames[0] !== input.expectedW04bFilename) {
      return {
        ok: false,
        reason: "UNEXPECTED_PENDING",
        message: `pending=${pending} names=${pendingNames.join(",")}; expected exactly 1: ${input.expectedW04bFilename}`,
        summary,
      };
    }
    if (mismatched !== 0) {
      return {
        ok: false,
        reason: "CHECKSUM_MISMATCH",
        message: `${mismatched} checksum mismatch(es)`,
        summary,
      };
    }
    if (missingOnDisk !== 0) {
      return {
        ok: false,
        reason: "DB_MISSING_LOCAL",
        message: `${missingOnDisk} applied migration(s) missing from local inventory`,
        summary,
      };
    }

    const totals = await q.reconciliationTotals();
    if (totals.cutoff_date !== input.oldCutover) {
      return {
        ok: false,
        reason: "CUTOVER_NOT_OLD",
        message: `production cutoff ${totals.cutoff_date} != expected pre-rebaseline ${input.oldCutover}`,
        summary,
      };
    }
    const legacyAll = await q.legacyAll();
    const legacyMasked = await q.legacyMaskedSubtotal();
    if (legacyAll !== 0 || legacyMasked !== 0) {
      return {
        ok: false,
        reason: "LEGACY_NOT_ZERO",
        message: `legacy rows=${legacyAll} subtotal=${legacyMasked}; post-purge must be 0`,
        summary: {
          ...summary,
          legacy_rows_total: legacyAll,
          legacy_subtotal_masked: legacyMasked,
        },
      };
    }
    const dePre = await q.dePreNewCutoff();
    if (dePre > 0) {
      return {
        ok: false,
        reason: "DE_PRE_CUTOFF_BLOCKER",
        message: `eligible DE with first_work_date < ${NEW_CUTOVER}: ${dePre}`,
        summary: { ...summary, de_pre_new_cutoff: dePre },
      };
    }
    const deWin = await q.deWindow();
    const dePost = await q.dePostOldCutoff();
    const activeNonTest = await q.activeNonTestSources();
    if (activeNonTest !== 0) {
      return {
        ok: false,
        reason: "ACTIVE_SOURCE_NOT_ZERO",
        message: `active non-test source count ${activeNonTest}; post-purge must be 0`,
        summary: { ...summary, active_non_test_sources: activeNonTest },
      };
    }

    return {
      ok: true,
      deWindowCount: deWin,
      reconciliation: totals,
      summary: {
        ...summary,
        legacy_rows_total: legacyAll,
        legacy_subtotal_masked: legacyMasked,
        de_pre_new_cutoff: dePre,
        de_window_06_to_16: deWin,
        de_post_old_cutoff: dePost,
        active_non_test_sources: activeNonTest,
      },
    };
  });
}

/**
 * Build a real Postgres-backed PreflightDb. The transaction is always
 * rolled back; no commit ever happens.
 */
function buildPgPreflightDb(client) {
  return {
    withReadOnly: async (fn) => {
      await client.query("begin");
      try {
        await client.query("set transaction read only");
        await client.query("set local statement_timeout = '15s'");
      } catch (error) {
        try { await client.query("rollback"); } catch { /* noop */ }
        throw error;
      }
      try {
        const out = await fn({
          appliedMigrations: () =>
            client
              .query("select version, checksum from public.schema_migrations")
              .then((r) => r.rows),
          reconciliationTotals: async () => {
            const r = await client.query(
              "select legacy_subtotal, direct_entry_subtotal, overlap_blocker, " +
              "       cutoff_date::text as cutoff_date " +
              "from public.direct_entry_reporting_reconciliation_totals()",
            );
            const row = r.rows[0] ?? {};
            return {
              legacy_subtotal: Number(row.legacy_subtotal ?? 0),
              direct_entry_subtotal: Number(row.direct_entry_subtotal ?? 0),
              overlap_blocker: Number(row.overlap_blocker ?? 0),
              cutoff_date: String(row.cutoff_date ?? ""),
            };
          },
          legacyAll: async () =>
            Number(
              (await client.query(
                "select count(*)::bigint as n from public.daily_recruitment_breakdown",
              )).rows[0]?.n ?? 0,
            ),
          legacyMaskedSubtotal: async () =>
            Number(
              (await client.query(
                "select coalesce(sum(recruited_count), 0)::bigint as s " +
                "from public.daily_recruitment_breakdown " +
                "where business_date < public.direct_entry_reporting_cutoff()",
              )).rows[0]?.s ?? 0,
            ),
          dePreNewCutoff: async () =>
            Number(
              (await client.query(
                "select count(*)::bigint as n " +
                "from public.direct_entries e " +
                "join public.direct_entry_submissions s on s.submission_id = e.submission_id " +
                "where s.state = 'SUBMITTED' and e.deleted_at is null " +
                "  and e.first_work_date < date '2026-10-06'",
              )).rows[0]?.n ?? 0,
            ),
          deWindow: async () =>
            Number(
              (await client.query(
                "select count(*)::bigint as n " +
                "from public.direct_entries e " +
                "join public.direct_entry_submissions s on s.submission_id = e.submission_id " +
                "where s.state = 'SUBMITTED' and e.deleted_at is null " +
                "  and e.first_work_date >= date '2026-10-06' and e.first_work_date < date '2026-10-17'",
              )).rows[0]?.n ?? 0,
            ),
          dePostOldCutoff: async () =>
            Number(
              (await client.query(
                "select count(*)::bigint as n " +
                "from public.direct_entries e " +
                "join public.direct_entry_submissions s on s.submission_id = e.submission_id " +
                "where s.state = 'SUBMITTED' and e.deleted_at is null " +
                "  and e.first_work_date >= date '2026-10-17'",
              )).rows[0]?.n ?? 0,
            ),
          activeNonTestSources: async () =>
            Number(
              (await client.query(
                "select count(*)::bigint as n " +
                "from public.data_sources " +
                "where active = true and is_test = false",
              )).rows[0]?.n ?? 0,
            ),
        });
        return out;
      } finally {
        try { await client.query("rollback"); } catch { /* noop */ }
      }
    },
  };
}

function logRow(label, value) {
  console.log(`${label}: ${value}`);
}

async function main() {
  let client;
  let transactionRollbackOk = false;
  try {
    const config = await loadSupabaseConfig();
    client = new Client({
      connectionString: config.databaseUrl,
      ssl: buildSslOptions(),
      connectionTimeoutMillis: 10000,
      statement_timeout: 15000,
    });
    await client.connect();

    const localMigrations = (await readMigrations(MIGRATION_DIR)).map((m) => ({
      name: m.name,
      checksum: m.checksum,
    }));

    const db = buildPgPreflightDb(client);
    const result = await evaluatePreflight(
      {
        localMigrations,
        expectedLocalCount: 44,
        expectedProductionCount: 43,
        expectedW04bFilename: W04B_FILENAME,
        oldCutover: OLD_CUTOVER,
      },
      db,
    );
    transactionRollbackOk = true;

    if (result.ok) {
      logRow("PREFLIGHT", "OK");
      logRow("ROLLBACK", "OK");
      logRow("LEGACY_ROWS_TOTAL", result.summary.legacy_rows_total);
      logRow("LEGACY_SUBTOTAL_MASKED", result.summary.legacy_subtotal_masked);
      logRow("DE_PRE_NEW_CUTOFF", result.summary.de_pre_new_cutoff);
      logRow("DE_WINDOW_06_TO_16", result.summary.de_window_06_to_16);
      logRow("DE_POST_OLD_CUTOFF", result.summary.de_post_old_cutoff);
      logRow("ACTIVE_NON_TEST_SOURCES", result.summary.active_non_test_sources);
      logRow("PRODUCTION_APPLIED", result.summary.production_applied_count);
      logRow("PENDING", result.summary.pending_count);
      logRow("MISMATCH", result.summary.mismatch_count);
      logRow("LOCAL_MIGRATIONS", result.summary.local_migration_count);
      process.exit(0);
    }
    logRow("PREFLIGHT", `STOP ${result.reason}`);
    logRow("MESSAGE", result.message);
    process.exitCode = 1;
  } catch (error) {
    logRow("PREFLIGHT", `ERROR ${error?.message ?? "UNKNOWN"}`);
    process.exitCode = 2;
  } finally {
    // Belt-and-suspenders: ensure no transaction is left open even on
    // catastrophic failures (e.g. an exception before evaluatePreflight's
    // adapter could rollback).
    if (client) {
      try { await client.query("rollback"); } catch { /* noop */ }
      await client.end();
    } else {
      transactionRollbackOk = transactionRollbackOk; // noop for linter
    }
  }
  // Suppress an unused-binding lint while keeping the variable for clarity.
  void transactionRollbackOk;
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) {
  main();
}
