#!/usr/bin/env node
/**
 * P2.5-W02 - READ-ONLY Production evidence for the W07E #50 safety analysis.
 *
 * Answers, with counts/booleans only (no email, UUID, name or secret):
 *   1. ledger state: applied / pending / mismatch;
 *   2. is the pending migration #50 (W07E) already defined in the database?
 *   3. how many actors currently hold an effective change_request_create grant;
 *   4. how many SUBMITTED Direct Entry rows exist.
 *
 * (3) and (4) bound the reachability of #50's creator/team/first_work_date
 * propose fallback during the window between applying #50 and #51.
 *
 * Usage: node scripts/p2-5-w02-w07e50-safety-check.mjs
 */
import process from "node:process";

import { Client } from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

async function scalar(client, sql, params = []) {
  const res = await client.query(sql, params);
  return res.rows[0];
}

async function main() {
  const config = await loadSupabaseConfig();
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: buildSslOptions(),
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  try {
    await client.query("begin read only");
    try {
      const ledger = await scalar(client,
        "select count(*)::int as applied from public.schema_migrations");
      const w07e = await scalar(client,
        "select count(*)::int as w07e_row from public.schema_migrations" +
        " where version like '20261008100000%'");
      const functions = await scalar(client,
        "select count(*) filter (where p.proname = 'direct_entry_resolve_change_request_scope')::int as scope_resolver," +
        " count(*) filter (where p.proname = 'direct_entry_create_full_profile_batch_v2')::int as batch_guard" +
        " from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
        " where n.nspname = 'public'");
      const capability = await scalar(client,
        "select count(distinct g.app_user_id)::int as actors_with_capability" +
        " from public.direct_entry_capability_grants g" +
        " join public.direct_entry_app_users u on u.app_user_id = g.app_user_id and u.enabled" +
        " where g.capability = 'change_request_create'" +
        " and g.valid_from <= public.direct_entry_authorization_date()" +
        " and (g.valid_to is null or public.direct_entry_authorization_date() < g.valid_to)");
      const submitted = await scalar(client,
        "select count(*)::int as submitted_entries" +
        " from public.direct_entries e" +
        " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
        " where s.state = 'SUBMITTED' and e.deleted_at is null");
      const assignments = await scalar(client,
        "select count(*)::int as assignment_rows" +
        " from public.direct_entry_project_manager_assignments");
      console.log(JSON.stringify({
        mode: "check",
        ledger: { applied: ledger.applied, w07e_50_applied: w07e.w07e_row > 0 },
        database_objects: functions,
        fallback_reachability: {
          actors_with_effective_change_request_create: capability.actors_with_capability,
          submitted_entries: submitted.submitted_entries,
          exploitable: capability.actors_with_capability > 0 && submitted.submitted_entries > 0,
        },
        project_manager_assignment_rows: assignments.assignment_rows,
      }, null, 2));
    } finally {
      await client.query("rollback");
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("P2_5_W02_SAFETY_CHECK_FAILED " + (error && error.message ? error.message : "UNKNOWN"));
  process.exitCode = 1;
});
