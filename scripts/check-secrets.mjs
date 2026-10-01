#!/usr/bin/env node
/**
 * Kiểm tra secret không lọt vào client bundle hoặc vào file sẽ được commit.
 *
 * Chạy: pnpm secrets:check
 *
 * Script chỉ in kết quả ĐẠT/KHÔNG ĐẠT và đường dẫn file vi phạm — không bao giờ in
 * giá trị secret.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "coverage", ".turbo"]);

const SCAN_TARGETS = [
  path.join(ROOT, ".next", "static"),
  path.join(ROOT, ".next", "server", "app"),
  path.join(ROOT, "src"),
  path.join(ROOT, "docs"),
  path.join(ROOT, "supabase"),
  path.join(ROOT, "scripts"),
];

const SCAN_ROOT_FILES = [".env.example", "README.md", "package.json", "next.config.ts"];

async function collectFiles(target, out) {
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectFiles(path.join(target, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const full = path.join(target, entry.name);
    if (/^(a-initial|b-replay|c-correction|d-date-removed|e-empty|g-source-b|f-)/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

async function main() {
  const config = await loadSupabaseConfig();

  const secrets = [
    { label: "SUPABASE_SECRET_KEY", value: config.secretKey },
    { label: "SUPABASE_DB_URL", value: config.databaseUrl },
  ];
  const dbPassword = decodeURIComponent(new URL(config.databaseUrl).password);
  if (dbPassword) secrets.push({ label: "DB password", value: dbPassword });

  const files = [];
  for (const target of SCAN_TARGETS) await collectFiles(target, files);
  for (const name of SCAN_ROOT_FILES) {
    const full = path.join(ROOT, name);
    try {
      await stat(full);
      files.push(full);
    } catch {
      // file không tồn tại: bỏ qua
    }
  }

  let violations = 0;
  for (const file of files) {
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const secret of secrets) {
      if (secret.value && content.includes(secret.value)) {
        violations += 1;
        console.log("VI PHẠM: " + secret.label + " xuất hiện trong " + path.relative(ROOT, file));
      }
    }
  }

  console.log("Đã quét " + files.length + " file (client bundle + source + docs + scripts).");
  console.log(violations === 0 ? "KẾT QUẢ: ĐẠT — không tìm thấy secret." : "KẾT QUẢ: KHÔNG ĐẠT — " + violations + " vi phạm.");
  if (violations > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("SECRET CHECK THẤT BẠI:", error.message);
  process.exitCode = 1;
});
