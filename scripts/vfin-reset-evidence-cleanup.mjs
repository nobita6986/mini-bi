import { fileURLToPath } from "node:url";
import pg from "pg";
import { createR2VendorFinanceEvidenceStorage } from "../src/lib/vendor-finance/r2-evidence-storage.ts";

/**
 * Controlled pre-migration R2 evidence cleanup for VFIN-04 transactional reset.
 *
 * Why this exists:
 * `20261107120000_vfin_04_shared_vendor_advance.sql` resets `public.vendor_finance_evidence`
 * and fails closed (`VENDOR_FINANCE_RESET_EVIDENCE_NOT_CLEANED`) if any row in
 * `public.vendor_finance_evidence` still has `cleaned_up_at IS NULL`.
 *
 * Usage:
 *   # Dry run (default — inspects rows, makes zero R2 or DB writes):
 *   node --conditions react-server scripts/vfin-reset-evidence-cleanup.mjs --dry-run
 *
 *   # Execute R2 object cleanup (staging + final) and stamp cleaned_up_at:
 *   node --conditions react-server scripts/vfin-reset-evidence-cleanup.mjs --execute --confirm-reset
 */
export async function cleanupVendorFinanceResetEvidence({
  dbClient,
  storage,
  execute = false,
  confirmReset = false,
}) {
  if (execute && !confirmReset) {
    throw new Error(
      "Refusing to execute R2 evidence reset cleanup without both --execute and --confirm-reset",
    );
  }

  const { rows } = await dbClient.query(
    `select evidence_id, entry_id, reconciliation_id, status, storage_key, cleaned_up_at
       from public.vendor_finance_evidence
      where cleaned_up_at is null
      order by reserved_at asc, evidence_id asc`,
  );

  if (!execute) {
    return {
      mode: "dry-run",
      pending_count: rows.length,
      cleaned_count: 0,
      items: rows.map((row) => ({
        evidence_id: row.evidence_id,
        entry_id: row.entry_id,
        reconciliation_id: row.reconciliation_id,
        status: row.status,
        storage_key: row.storage_key,
      })),
    };
  }

  if (rows.length > 0 && (!storage || !storage.available())) {
    throw new Error(
      "R2 storage is not configured/available while uncleaned vendor_finance_evidence rows exist",
    );
  }

  const cleanedIds = [];
  for (const row of rows) {
    await storage.deleteStaged(row.storage_key);
    await storage.deleteFinal(row.storage_key);
    await dbClient.query("begin");
    try {
      await dbClient.query(
        "alter table public.vendor_finance_evidence disable trigger vendor_finance_evidence_lifecycle_guard",
      );
      await dbClient.query(
        `update public.vendor_finance_evidence
            set status = case when status in ('RESERVED', 'READY') then 'EXPIRED' else status end,
                finalized_at = null,
                cleanup_after = coalesce(cleanup_after, timezone('utc', now())),
                cleaned_up_at = timezone('utc', now())
          where evidence_id = $1
            and cleaned_up_at is null`,
        [row.evidence_id],
      );
      await dbClient.query(
        "alter table public.vendor_finance_evidence enable trigger vendor_finance_evidence_lifecycle_guard",
      );
      await dbClient.query("commit");
    } catch (err) {
      await dbClient.query("rollback");
      throw err;
    }
    cleanedIds.push(row.evidence_id);
  }

  return {
    mode: "execute",
    pending_count: rows.length,
    cleaned_count: cleanedIds.length,
    cleaned_ids: cleanedIds,
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const execute = args.has("--execute");
  const confirmReset = args.has("--confirm-reset");
  const databaseUrl = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "";

  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or SUPABASE_DB_URL) is required");
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const storage = createR2VendorFinanceEvidenceStorage();
    const summary = await cleanupVendorFinanceResetEvidence({
      dbClient: client,
      storage,
      execute,
      confirmReset,
    });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
