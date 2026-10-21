import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const ANALYTICS_RPC_NAMES = [
  "work_report_analytics_overview",
  "work_report_analytics_breakdown",
  "work_report_analytics_contributions",
  "work_report_reconcile_metric_projection",
];

async function createDatabase() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  for (const name of (await readdir(MIGRATION_DIR)).filter((file) => file.endsWith(".sql")).sort()) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return db;
}

test("SEC-WR-12: client roles cannot read work-report tables or execute work-report RPCs", async () => {
  const db = await createDatabase();
  try {
    const { rows } = await db.query(`select c.relname,
        has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
        has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname like 'work_report_%' and c.relkind in ('r', 'p')`);
    assert.ok(rows.some((row) => row.relname === "work_report_metric_values"));
    for (const row of rows) {
      assert.equal(row.anon_select, false, `${row.relname} anon SELECT`);
      assert.equal(row.auth_select, false, `${row.relname} authenticated SELECT`);
    }
    const { rows: functions } = await db.query(`select p.proname,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'work_report_%'`);
    for (const row of functions) {
      assert.equal(row.anon_execute, false, `${row.proname} anon EXECUTE`);
      assert.equal(row.auth_execute, false, `${row.proname} authenticated EXECUTE`);
    }
  } finally {
    await db.close();
  }
});

test("SEC-WR-02/03/07/08 analytics RPC ACL regression (requires T1-A WP1 analytics migration)", async (t) => {
  const db = await createDatabase();
  try {
    const { rows } = await db.query(`select p.proname,
        bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) as anon_execute,
        bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')) as auth_execute,
        bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE')) as service_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1::text[]) group by p.proname`, [ANALYTICS_RPC_NAMES]);
    const found = new Set(rows.map((row) => row.proname));
    if (ANALYTICS_RPC_NAMES.some((name) => !found.has(name))) {
      t.skip("blocked: documented F1.5 analytics RPCs are not present on this baseline; rerun after T1-A WP1 merges");
      return;
    }
    assert.equal(rows.length, ANALYTICS_RPC_NAMES.length);
    for (const row of rows) {
      assert.equal(row.anon_execute, false, `${row.proname} anon EXECUTE`);
      assert.equal(row.auth_execute, false, `${row.proname} authenticated EXECUTE`);
      assert.equal(row.service_execute, true, `${row.proname} service_role EXECUTE`);
    }
  } finally {
    await db.close();
  }
});
