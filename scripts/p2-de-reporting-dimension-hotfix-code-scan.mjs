#!/usr/bin/env node
/**
 * P2 DE reporting dimension hotfix - READ-ONLY scan for the recruiter reporting
 * codes. Prints ONLY (table.column, count) pairs and booleans; never a value.
 *
 * Usage: node scripts/p2-de-reporting-dimension-hotfix-code-scan.mjs
 */
import process from "node:process";

import { Client } from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const EXPECTED_CODES = ["tu.vd", "thinhvuong.vd", "anhhn.td", "dhr.vd", "hainq.td", "nhieunt.td", "hao.vd"];
const CODE_LIST = EXPECTED_CODES.map((code) => "'" + code + "'").join(",");

// Candidate columns: identifiers that could carry a reporting code.
const CANDIDATE_COLUMNS = `
  select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
   where c.table_schema = 'public'
     and t.table_type = 'BASE TABLE'
     and c.data_type in ('text', 'character varying')
   order by c.table_name, c.column_name`;

async function main() {
  const config = await loadSupabaseConfig();
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: buildSslOptions(),
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  const hits = [];
  const scanned = [];
  try {
    await client.query("begin read only");
    try {
      const columns = await client.query(CANDIDATE_COLUMNS);
      for (const column of columns.rows) {
        const tableRef = 'public."' + column.table_name + '"';
        const columnRef = '"' + column.column_name + '"';
        // Each probe runs inside its own savepoint: a failing column must not abort
        // the surrounding read-only transaction.
        await client.query("savepoint code_probe");
        try {
          const res = await client.query(
            "select count(*)::int as n from " + tableRef +
            " where lower(btrim(" + columnRef + "::text)) in (" + CODE_LIST + ")");
          await client.query("release savepoint code_probe");
          scanned.push(column.table_name + "." + column.column_name);
          if (res.rows[0].n > 0) {
            hits.push({ column: column.table_name + "." + column.column_name, rows: res.rows[0].n });
          }
        } catch {
          await client.query("rollback to savepoint code_probe");
        }
      }
      const caseShape = await client.query(
        "select count(*)::int as rows_total," +
        " count(*) filter (where btrim(display_name) ~* '^[a-z0-9][a-z0-9._-]*$')::int as code_shaped_rows," +
        " count(*) filter (where lower(btrim(display_name)) in (" + CODE_LIST + "))::int as expected_code_rows," +
        " count(*) filter (where lower(display_name) ~ '(^|[^a-z0-9])(tu\\.vd|thinhvuong\\.vd|anhhn\\.td|dhr\\.vd|hainq\\.td|nhieunt\\.td|hao\\.vd)([^a-z0-9]|$)')::int as code_token_rows" +
        " from public.recruiters");
      const aliasShape = await client.query(
        "select count(*)::int as alias_rows," +
        " count(distinct recruiter_id)::int as recruiters_with_alias," +
        " count(*) filter (where lower(btrim(reporting_key)) in (" + CODE_LIST + "))::int as expected_code_rows" +
        " from public.recruiter_aliases");
      // 1) The canonical code column on recruiters, per window entry.
      const personnel = await client.query(
        "select coalesce(nullif(btrim(r.personnel_code), ''), '(empty)') as code, count(*)::int as n" +
        " from public.direct_entries e" +
        " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
        " join public.recruiters r on r.recruiter_id = e.recruiter_id" +
        " where s.state = 'SUBMITTED' and e.deleted_at is null" +
        " and e.first_work_date >= public.direct_entry_reporting_cutoff()" +
        " group by 1 order by 2 desc, 1");
      const personnelOverall = await client.query(
        "select count(*)::int as recruiters_total," +
        " count(*) filter (where nullif(btrim(personnel_code), '') is not null)::int as with_personnel_code" +
        " from public.recruiters");
      // 2) Any json/jsonb payload that still carries one of the expected codes.
      const jsonColumns = await client.query(
        "select c.table_name, c.column_name" +
        " from information_schema.columns c" +
        " join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name" +
        " where c.table_schema = 'public' and t.table_type = 'BASE TABLE'" +
        " and c.data_type in ('json', 'jsonb') order by 1, 2");
      const jsonHits = [];
      for (const column of jsonColumns.rows) {
        const tableRef = 'public."' + column.table_name + '"';
        const columnRef = '"' + column.column_name + '"';
        await client.query("savepoint json_probe");
        try {
          const res = await client.query(
            "select count(*)::int as n from " + tableRef +
            " where " + columnRef + "::text ~* '(tu\\.vd|thinhvuong\\.vd|anhhn\\.td|dhr\\.vd|hainq\\.td|nhieunt\\.td|hao\\.vd)'");
          await client.query("release savepoint json_probe");
          if (res.rows[0].n > 0) {
            jsonHits.push({ column: column.table_name + "." + column.column_name, rows: res.rows[0].n });
          }
        } catch {
          await client.query("rollback to savepoint json_probe");
        }
      }
      const recruitersWithCode = await client.query(
        "select count(distinct r.recruiter_id)::int as recruiters_in_window," +
        " count(distinct r.recruiter_id) filter (where nullif(btrim(r.personnel_code), '') is not null)::int as with_code" +
        " from public.direct_entries e" +
        " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
        " join public.recruiters r on r.recruiter_id = e.recruiter_id" +
        " where s.state = 'SUBMITTED' and e.deleted_at is null" +
        " and e.first_work_date >= public.direct_entry_reporting_cutoff()");
      console.log(JSON.stringify({
        mode: "code-scan",
        expected_codes: EXPECTED_CODES.length,
        columns_scanned: scanned.length,
        code_columns_with_matches: hits,
        recruiters_display_name: caseShape.rows[0],
        recruiter_aliases: aliasShape.rows[0],
        personnel_code_per_entry: Object.fromEntries(personnel.rows.map((r) => [r.code, r.n])),
        personnel_code_coverage: { overall: personnelOverall.rows[0], window: recruitersWithCode.rows[0] },
        json_payload_columns_with_codes: jsonHits,
      }, null, 2));
    } finally {
      await client.query("rollback");
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("P2_DE_DIM_CODE_SCAN_FAILED " + (error && error.message ? error.message : "UNKNOWN"));
  process.exitCode = 1;
});
