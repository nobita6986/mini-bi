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

test("P2-W04A migration #40 applies cleanly after migrations #1-#39 (P2-W04B adds #44)", async () => {
  const { db, migrationNames } = await buildDb();
  try {
    // P2-W04B migration #44 rebaselines the cutoff to 2026-10-06.
    assert.equal(migrationNames.length, 44);
    // P2-W04B migration #44 is APPEND-ONLY: it must come AFTER the
    // last applied migration on origin/main (`20261008020000_p3_w07b_…`)
    // so a fresh PGlite apply and a Production apply share the same
    // ordering. W04B sits between W07B and any later migration.
    assert.equal(
      migrationNames[migrationNames.length - 1],
      "20261008030000_p2_w04b_post_purge_cutover_rebaseline.sql",
      "P2-W04B migration #44 must be the LAST migration on disk (append-only after W07B)",
    );
    // W07B must still be present and immediately precede W04B.
    const w07bIdx = migrationNames.indexOf(
      "20261008020000_p3_w07b_project_manager_scope.sql",
    );
    const w04bIdx = migrationNames.indexOf(
      "20261008030000_p2_w04b_post_purge_cutover_rebaseline.sql",
    );
    assert.ok(w07bIdx >= 0, "W07B migration must be present");
    assert.ok(w04bIdx >= 0, "W04B migration must be present");
    assert.equal(w04bIdx, w07bIdx + 1, "W04B must be ordered immediately after W07B");
    // The original W04A migration is still in the inventory.
    assert.ok(
      migrationNames.includes("20261007020000_p2_w04a_direct_entry_reporting_cutover.sql"),
      "P2-W04A migration #40 must be present in the inventory",
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

    // 3. Cutoff is locked to the P2-W04B rebaseline value.
    const cutoffRes = await db.query("select public.direct_entry_reporting_cutoff()::text as c");
    assert.equal(cutoffRes.rows[0].c, "2026-10-06");

    // 4. Reconciliation totals are zero on fresh DB.
    const totals = await db.query(
      "select legacy_subtotal, direct_entry_subtotal, overlap_blocker," +
      " cutoff_date::text as cutoff_date from public.direct_entry_reporting_reconciliation_totals()",
    );
    assert.equal(Number(totals.rows[0].legacy_subtotal), 0);
    assert.equal(Number(totals.rows[0].direct_entry_subtotal), 0);
    assert.equal(Number(totals.rows[0].overlap_blocker), 0);
    assert.equal(totals.rows[0].cutoff_date, "2026-10-06");
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

// -----------------------------------------------------------------------------
// R1 self-protection: migration #44 must raise + roll back the rebaseline
// when ANY of the 3 unsafe conditions hold at apply time:
//   (a) eligible DE with first_work_date < 2026-10-06
//   (b) legacy aggregate rows or subtotal != 0
//   (c) active non-test source
// The cutoff function MUST remain the old value (2026-10-17) because the
// create or replace statement is inside the do $$ block that raises on
// unsafe state — so the function rebaseline itself is part of the failed
// transaction. This is the SQL-level last line of defense behind the
// preflight safety gate.
// -----------------------------------------------------------------------------

// Minimal fixture mirroring the W04A acceptance test's seedFixture. Kept
// local to this file so the R1 self-protection tests do not depend on
// the acceptance file being loaded as a side-effect.
async function seedW04aFixture(db) {
  await db.query("insert into auth.users (id) values ($1)",
    ["10000000-0000-4000-8000-000000000001"]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject) values ($1, $2)",
    ["20000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000001"],
  );
  await db.query("insert into public.teams (team_id, code, display_name) values ($1, $2, $3)",
    ["94000000-0000-4000-8000-000000000001", "W04A-SYNTH", "W04A team"]);
  await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1, $2)",
    ["93000000-0000-4000-8000-000000000001", "W04A recruiter"]);
  await db.query(
    "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from) values ($1, $2, $3)",
    ["93000000-0000-4000-8000-000000000001", "hrp", "2020-01-01"],
  );
  await db.query(
    "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from) values ($1, $2, $3)",
    ["93000000-0000-4000-8000-000000000001", "94000000-0000-4000-8000-000000000001", "2020-01-01"],
  );
  await db.query(
    "insert into public.recruiter_aliases (recruiter_id, reporting_key, valid_from) values ($1, $2, $3)",
    ["93000000-0000-4000-8000-000000000001", "w04a recruiter", "2020-01-01"],
  );
  await db.query(
    "insert into public.direct_entry_projects (project_id, display_name) values ($1, $2)",
    ["w04a_project", "W04A Project"],
  );
  for (const cap of ["entry_create", "submission_create", "entry_own"]) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from) values ($1, $2, $3)",
      ["20000000-0000-4000-8000-000000000001", cap, "2020-01-01"],
    );
  }
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from) values ($1, $2, $3)",
    ["20000000-0000-4000-8000-000000000001", "own", "2020-01-01"],
  );
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links" +
    " (app_user_id, recruiter_id, verified, valid_from) values ($1, $2, true, $3)",
    ["20000000-0000-4000-8000-000000000001", "93000000-0000-4000-8000-000000000001", "2020-01-01"],
  );
}

async function applyBaseMigrations(db) {
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of names) {
    if (name.includes("p2_w04b_post_purge_cutover_rebaseline")) continue;
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return names;
}

async function applyW04bAndCapture(db) {
  // Apply W04B in a single transaction so the entire do $$ block is atomic.
  const w04bSql = await readFile(
    path.join(MIGRATION_DIR, "20261008030000_p2_w04b_post_purge_cutover_rebaseline.sql"),
    "utf8",
  );
  let raised = null;
  await db.exec("begin");
  try {
    await db.exec(w04bSql);
    await db.exec("commit");
  } catch (e) {
    raised = e;
    try { await db.exec("rollback"); } catch { /* noop */ }
  }
  const afterCutoff = await db.query("select public.direct_entry_reporting_cutoff()::text as c");
  return { raised, afterCutoff: afterCutoff.rows[0].c };
}

async function applyBaseThenW04b(extraStatements) {
  const db = new PGlite();
  const names = await applyBaseMigrations(db);
  if (extraStatements) {
    for (const stmt of extraStatements) {
      await db.exec(stmt);
    }
  }
  const beforeCutoff = await db.query("select public.direct_entry_reporting_cutoff()::text as c");
  const { raised, afterCutoff } = await applyW04bAndCapture(db);
  return { db, beforeCutoff: beforeCutoff.rows[0].c, afterCutoff, raised, names };
}

test("R1 migration self-protection: legacy aggregate rows cause the rebaseline to roll back", async () => {
  const { db, beforeCutoff, afterCutoff, raised, names } = await applyBaseThenW04b([
    `insert into public.data_sources
       (id, drive_file_id, file_name, sheet_name, active, is_test)
     values
       ('11111111-1111-4111-8111-111111111111', 'W04A-R1-LEGACY', 'w04a-r1-legacy.xlsx', 'Sheet1', true, true)`,
    `insert into public.sync_runs (run_id, source_id, trigger_type, status, started_at, finished_at)
     values
       ('21111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'manual', 'succeeded', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z')`,
    `insert into public.daily_recruitment_breakdown
       (source_id, business_date, project_key, project_display, recruiter_key, recruiter_display,
        provider_type_key, provider_type_display, employment_type_key, employment_type_display,
        recruited_count, sync_run_id, snapshot_at)
     values
       ('11111111-1111-4111-8111-111111111111', '2026-10-05', 'p1', 'P1', 'r1', 'R1',
        'hrp', 'HRP', 'thời vụ', 'Thời vụ', 1,
        '21111111-1111-4111-8111-111111111111', '2026-10-05T00:00:00Z')`,
  ]);
  try {
    assert.equal(beforeCutoff, "2026-10-17", "baseline cutoff before W04B is the old rebaseline");
    assert.ok(raised, "W04B must raise when legacy aggregate has rows");
    assert.match(String(raised.message ?? raised), /legacy aggregate/i);
    assert.equal(afterCutoff, "2026-10-17", "W04B must ROLL BACK: cutoff stays at the old rebaseline");
  } finally {
    await db.close();
  }
  // Sanity: the base migrations were applied (count includes the W04B
  // filename even though we skipped applying it; that is the file
  // inventory assertion, not the applied set).
  assert.equal(names.length, 44);
});

test("R1 migration self-protection: eligible DE pre new-cutoff causes the rebaseline to roll back", async () => {
  // Reuse the W04A acceptance fixture to seed a real eligible DE row
  // with first_work_date = 2026-10-05 (BEFORE the new 2026-10-06
  // cutoff). The migration must reject and roll back.
  const db = new PGlite();
  await applyBaseMigrations(db);
  await seedW04aFixture(db);
  const createRes = await db.query(
    "select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as data",
    [
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001",
      JSON.stringify([{
        project_id: "w04a_project",
        first_work_date: "2026-10-05",
        employee_code: "hrp-2026-100500",
        worker_details: {
          display_name: "Blocker worker",
          date_of_birth: { state: "omitted" },
          national_id: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "omitted" },
        },
        recruiter_id: "93000000-0000-4000-8000-000000000001",
        labor_type: "TEMPORARY",
      }]),
      "w04a-r1-blocker-create",
    ],
  );
  const entryId = createRes.rows[0].data.entry_ids[0];
  const subRes = await db.query(
    "select submission_id from public.direct_entries where entry_id = $1",
    [entryId],
  );
  const submissionId = subRes.rows[0].submission_id;
  await db.query(
    "select public.direct_entry_transition_submission($1, $2, $3, $4, $5, $6) as data",
    ["10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001",
      submissionId, 1, "REVIEW", "w04a-r1-blocker-review"],
  );
  await db.query(
    "select public.direct_entry_transition_submission($1, $2, $3, $4, $5, $6) as data",
    ["10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001",
      submissionId, 2, "SUBMITTED", "w04a-r1-blocker-submit"],
  );

  const beforeCutoff = await db.query("select public.direct_entry_reporting_cutoff()::text as c");
  const { raised, afterCutoff } = await applyW04bAndCapture(db);
  try {
    assert.equal(beforeCutoff.rows[0].c, "2026-10-17");
    assert.ok(raised, "W04B must raise when eligible DE has first_work_date < 2026-10-06");
    assert.match(String(raised.message ?? raised), /first_work_date < 2026-10-06/);
    assert.equal(afterCutoff, "2026-10-17", "W04B must ROLL BACK: cutoff stays at the old rebaseline");
  } finally {
    await db.close();
  }
});

test("R1 migration self-protection: active non-test source causes the rebaseline to roll back", async () => {
  const { db, beforeCutoff, afterCutoff, raised } = await applyBaseThenW04b([
    `insert into public.data_sources
       (id, drive_file_id, file_name, sheet_name, active, is_test)
     values
       ('61111111-1111-4111-8111-111111111111', 'x', 'x.xlsx', 'Sheet1', true, false)`,
  ]);
  try {
    assert.equal(beforeCutoff, "2026-10-17");
    assert.ok(raised, "W04B must raise when an active non-test source exists");
    assert.match(String(raised.message ?? raised), /active non-test source/i);
    assert.equal(afterCutoff, "2026-10-17", "W04B must ROLL BACK: cutoff stays at the old rebaseline");
  } finally {
    await db.close();
  }
});
