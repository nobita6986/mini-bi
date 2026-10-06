#!/usr/bin/env node
/**
 * P3-W07A-R2 ledger evidence pull.
 * Print the schema_migrations row for #42 + local file SHA-256 to prove
 * the applied function body matches the local source.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import pg from "pg";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const { databaseUrl, projectRef } = await loadSupabaseConfig();
const client = new pg.Client({ connectionString: databaseUrl, ssl: buildSslOptions() });
await client.connect();
try {
  const { rows } = await client.query(
    "select version, checksum, applied_at from public.schema_migrations" +
    " where version = '20261008010000_p3_w07a_r2_catalog_contract_hotfix.sql'",
  );
  const local = await readFile("supabase/migrations/20261008010000_p3_w07a_r2_catalog_contract_hotfix.sql", "utf8");
  const localHash = createHash("sha256").update(local).digest("hex");
  console.log(JSON.stringify({
    projectRef: projectRef.slice(0, 4) + "***",
    ledger: rows[0] || null,
    localFile: { path: "supabase/migrations/20261008010000_p3_w07a_r2_catalog_contract_hotfix.sql", sha256: localHash },
  }, null, 2));
} finally {
  await client.end();
}
