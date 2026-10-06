import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return { db, migrationNames: names };
}

test("P2-W04A migration #40 applies cleanly after migrations #1-#39", async () => {
  const { db, migrationNames } = await buildDb();
  try {
    // P3-W07A migration #41 added the W07A catalog bootstrap. P3-W07A-R2
    // migration #42 added the catalog runtime contract hotfix (banks
    // restoration + Vendor null team + HRP null vendor_id). Total now 42.
    assert.equal(migrationNames.length, 42);
    assert.equal(
      migrationNames[migrationNames.length - 2],
      "20261007020000_p2_w04a_direct_entry_reporting_cutover.sql",
    );

    // 1. Projection view exists.
    const viewRes = await db.query(
      "select c.relname from pg_class c" +
      " join pg_namespace n on n.oid = c.relnamespace" +
      " where n.nspname = 'public' and c.relname = 'direct_entry_reporting_facts_v01'",
    );
    assert.equal(viewRes.rows.length, 1);

    // 2. Projection view columns match ReportingFact grain + delivery line fields.
    const cols = await db.query(
      "select array_agg(attname order by attnum) as cols" +
      " from pg_attribute" +
      " where attrelid = 'public.direct_entry_reporting_facts_v01'::regclass" +
      " and attnum > 0 and not attisdropped",
    );
    assert.deepEqual(cols.rows[0].cols, [
      "source_id",
      "business_date",
      "project_key",
      "project_display",
      "recruiter_key",
      "recruiter_display",
      "provider_type_key",
      "provider_type_display",
      "employment_type_key",
      "employment_type_display",
      "recruited_count",
      "first_work_date",
      "entry_id",
      "submission_id",
      "cutoff_date",
    ]);

    // 2b. Dimension options view exists with the canonical 4-column shape.
    const dimCols = await db.query(
      "select array_agg(attname order by attnum) as cols" +
      " from pg_attribute" +
      " where attrelid = 'public.direct_entry_reporting_dimension_options_v01'::regclass" +
      " and attnum > 0 and not attisdropped",
    );
    assert.deepEqual(dimCols.rows[0].cols, ["dimension", "key", "display", "recruited_count"]);

    // 3. Cutoff is locked.
    const cutoffRes = await db.query("select public.direct_entry_reporting_cutoff()::text as c");
    assert.equal(cutoffRes.rows[0].c, "2026-10-17");

    // 4. Reconciliation totals are zero on fresh DB.
    const totals = await db.query(
      "select legacy_subtotal, direct_entry_subtotal, overlap_blocker," +
      " cutoff_date::text as cutoff_date from public.direct_entry_reporting_reconciliation_totals()",
    );
    assert.equal(Number(totals.rows[0].legacy_subtotal), 0);
    assert.equal(Number(totals.rows[0].direct_entry_subtotal), 0);
    assert.equal(Number(totals.rows[0].overlap_blocker), 0);
    assert.equal(totals.rows[0].cutoff_date, "2026-10-17");
  } finally {
    await db.close();
  }
});

test("R1 migration test: service_role has EXECUTE on every runtime helper", async () => {
  const { db } = await buildDb();
  try {
    const helpers = [
      "public.direct_entry_reporting_cutoff()",
      "public.direct_entry_reporting_source_id()",
      "public.direct_entry_reporting_dim_key(text)",
      "public.direct_entry_reporting_recruiter_alias_key(uuid, date)",
      "public.direct_entry_reporting_recruiter_provider_key(uuid, date)",
      "public.direct_entry_reporting_employment_key(text)",
      "public.direct_entry_reporting_pre_cutover_blocker_count()",
      "public.direct_entry_reporting_reconciliation_totals()"
    ];
    for (const sig of helpers) {
      const res = await db.query(
        "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as svc",
        [sig],
      );
      assert.equal(res.rows[0].svc, true, sig + " must be EXECUTE-able by service_role");
    }
  } finally {
    await db.close();
  }
});

test("Direct Entry source id is stable and registered only in TS scope", async () => {
  const { db } = await buildDb();
  try {
    const res = await db.query("select public.direct_entry_reporting_source_id() as id");
    assert.equal(res.rows[0].id, "00000000-0000-4000-8000-0000de000001");
  } finally {
    await db.close();
  }
});

test("View grants: only service_role can SELECT", async () => {
  const { db } = await buildDb();
  try {
    const grants = await db.query(
      "select has_table_privilege('anon', 'public.direct_entry_reporting_facts_v01', 'SELECT') as anon," +
      " has_table_privilege('authenticated', 'public.direct_entry_reporting_facts_v01', 'SELECT') as auth," +
      " has_table_privilege('public', 'public.direct_entry_reporting_facts_v01', 'SELECT') as pub," +
      " has_table_privilege('service_role', 'public.direct_entry_reporting_facts_v01', 'SELECT') as svc",
    );
    assert.deepEqual(
      {
        anon: grants.rows[0].anon,
        auth: grants.rows[0].auth,
        pub: grants.rows[0].pub,
        svc: grants.rows[0].svc,
      },
      { anon: false, auth: false, pub: false, svc: true },
    );
  } finally {
    await db.close();
  }
});

test("Helpers are not executable by anon / authenticated", async () => {
  const { db } = await buildDb();
  try {
    const signatures = [
      "public.direct_entry_reporting_cutoff()",
      "public.direct_entry_reporting_source_id()",
      "public.direct_entry_reporting_dim_key(text)",
      "public.direct_entry_reporting_recruiter_alias_key(uuid, date)",
      "public.direct_entry_reporting_recruiter_provider_key(uuid, date)",
      "public.direct_entry_reporting_employment_key(text)",
      "public.direct_entry_reporting_pre_cutover_blocker_count()",
      "public.direct_entry_reporting_reconciliation_totals()",
    ];
    for (const sig of signatures) {
      const res = await db.query(
        "select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon," +
        " has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth",
        [sig],
      );
      assert.equal(res.rows[0].anon, false, sig + " anon");
      assert.equal(res.rows[0].auth, false, sig + " auth");
    }
  } finally {
    await db.close();
  }
});