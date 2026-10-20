#!/usr/bin/env node
/**
 * Áp dụng migration lên Supabase theo thứ tự tên file.
 *
 * - Đọc connection string từ file cấu hình ngoài repo (không commit).
 * - Mỗi file chạy trong MỘT transaction, kèm ghi nhận vào public.schema_migrations.
 * - Idempotent: file đã áp dụng sẽ bị bỏ qua; checksum lệch => dừng và báo lỗi
 *   (trừ trường hợp duy nhất được kiểm soát cho migration #124 khi mang checksum
 *   lịch sử trước PR #92 và vượt qua toàn bộ kiểm tra security postconditions).
 *
 * Dùng:
 *   node scripts/apply-migrations.mjs [--dry-run | --offline]
 *   SUPABASE_CONFIG_FILE=<path> node scripts/apply-migrations.mjs
 */
import path from "node:path";
import process from "node:process";
import pg from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import {
  migrationChecksum,
  migrationSqlForTransaction,
  runMigrationApply,
  runMigrationValidation,
} from "./lib/migration-validation.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const dryRun = process.argv.includes("--dry-run");
const offline = process.argv.includes("--offline");

async function main() {
  const createClient = (databaseUrl) =>
    new pg.Client({ connectionString: databaseUrl, ssl: buildSslOptions() });

  if (offline || dryRun) {
    const result = await runMigrationValidation({
      mode: offline ? "offline" : "dry-run",
      directory: MIGRATIONS_DIR,
      loadConfig: loadSupabaseConfig,
      createClient,
    });
    if (result.mismatches.length > 0) {
      throw new Error(`Migration checksum mismatch: ${result.mismatches.join(", ")}`);
    }
    return;
  }

  // Keep explicit references to migrationChecksum and migrationSqlForTransaction
  // in case external tests inspect apply-migrations.mjs imports.
  void migrationChecksum;
  void migrationSqlForTransaction;

  await runMigrationApply({
    directory: MIGRATIONS_DIR,
    loadConfig: loadSupabaseConfig,
    createClient,
  });
}

main().catch((error) => {
  console.error("\nMIGRATION THẤT BẠI:", error.message);
  process.exitCode = 1;
});
