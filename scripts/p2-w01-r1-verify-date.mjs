#!/usr/bin/env node
/**
 * P2-W01-R1 verify — kiểm tra cách Postgres trả business_date
 * (là date hay timestamptz?). In ra stdout để debug.
 */
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";
import pg from "pg";

const cfg = await loadSupabaseConfig();
const client = new pg.Client({ connectionString: cfg.databaseUrl, ssl: buildSslOptions() });
await client.connect();
await client.query("SET TRANSACTION READ ONLY");
await client.query("SET LOCAL statement_timeout = '5s'");
const r = await client.query(`
  select
    max(business_date) as d_date,
    to_char(max(business_date), 'YYYY-MM-DD') as d_text,
    to_char((now() at time zone 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD') as today_hcm_text,
    to_char(now(), 'YYYY-MM-DD') as today_utc_text,
    current_setting('TIMEZONE') as server_tz
  from public.daily_recruitment_breakdown
`);
console.log(JSON.stringify(r.rows, null, 2));
await client.query("ROLLBACK");
await client.end();