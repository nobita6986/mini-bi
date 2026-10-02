#!/usr/bin/env node
/**
 * Áp dụng migration lên Supabase theo thứ tự tên file.
 *
 * - Đọc connection string từ file cấu hình ngoài repo (không commit).
 * - Mỗi file chạy trong MỘT transaction, kèm ghi nhận vào public.schema_migrations.
 * - Idempotent: file đã áp dụng sẽ bị bỏ qua; checksum lệch => dừng và báo lỗi.
 *
 * Dùng:
 *   node scripts/apply-migrations.mjs [--dry-run]
 *   SUPABASE_CONFIG_FILE=<path> node scripts/apply-migrations.mjs
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const dryRun = process.argv.includes("--dry-run");

function checksum(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function main() {
  const entries = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  if (entries.length === 0) {
    throw new Error(`Không tìm thấy file .sql trong ${MIGRATIONS_DIR}`);
  }

  if (dryRun) {
    for (const name of entries) {
      await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
      console.log(`DRY-RUN ${name} (database not contacted; applied status unchecked)`);
    }
    console.log(`\nDRY-RUN: ${entries.length} migration(s) listed; no database access or writes.`);
    return;
  }

  const { databaseUrl, projectRef, usesPooler } = await loadSupabaseConfig();
  const client = new pg.Client({ connectionString: databaseUrl, ssl: buildSslOptions() });
  await client.connect();
  console.log(`Kết nối DB thành công (project ref: ${projectRef.slice(0, 4)}***, pooler: ${usesPooler ? "có" : "không"})`);

  await client.query(`
    create table if not exists public.schema_migrations (
      version     text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )
  `);

  const { rows: applied } = await client.query("select version, checksum from public.schema_migrations");
  const appliedMap = new Map(applied.map((r) => [r.version, r.checksum]));

  let appliedCount = 0;
  let skippedCount = 0;

  for (const name of entries) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
    const sum = checksum(sql);
    const previous = appliedMap.get(name);

    if (previous !== undefined) {
      if (previous !== sum) {
        throw new Error(
          `Migration ${name} đã áp dụng nhưng nội dung đã thay đổi (checksum mismatch). ` +
            "Không sửa file migration đã áp dụng — hãy tạo file migration mới."
        );
      }
      console.log(`SKIP    ${name} (đã áp dụng)`);
      skippedCount += 1;
      continue;
    }

    try {
      await client.query("begin");
      await client.query(sql);
      await client.query(
        "insert into public.schema_migrations (version, checksum) values ($1, $2)",
        [name, sum]
      );
      await client.query("commit");
      console.log(`APPLY   ${name}`);
      appliedCount += 1;
    } catch (error) {
      await client.query("rollback");
      console.error(`FAILED  ${name}: ${error.message}`);
      throw error;
    }
  }

  console.log(`\nKết quả: ${appliedCount} áp dụng mới, ${skippedCount} bỏ qua, ${entries.length} tổng.`);

  const { rows: tables } = await client.query(`
    select table_name
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('data_sources', 'sync_runs', 'daily_recruitment_breakdown', 'sync_errors')
     order by table_name
  `);
  console.log("Bảng hiện có:", tables.map((r) => r.table_name).join(", ") || "(không có)");

  await client.end();
}

main().catch((error) => {
  console.error("\nMIGRATION THẤT BẠI:", error.message);
  process.exitCode = 1;
});
