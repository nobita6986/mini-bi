import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";
import pg from "pg";
const cfg = await loadSupabaseConfig();
const c = new pg.Client({ connectionString: cfg.databaseUrl, ssl: buildSslOptions() });
await c.connect();
console.log("1) BEGIN");
await c.query("BEGIN");
console.log("2) SET TRANSACTION READ ONLY");
try {
  await c.query("SET TRANSACTION READ ONLY");
  console.log("  -> OK");
} catch (e) {
  console.log("  -> FAIL", e.message);
}
console.log("3) SET LOCAL statement_timeout");
try {
  await c.query("SET LOCAL statement_timeout = '5s'");
  console.log("  -> OK");
} catch (e) {
  console.log("  -> FAIL", e.message);
}
console.log("4) ROLLBACK");
await c.query("ROLLBACK");
await c.end();