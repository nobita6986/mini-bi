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

async function setRole(db, role) {
  await db.exec(`set local role ${role}`);
}

async function seedFixture(db) {
  // App user + project + recruiter + bank + team
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
  // Grants to call the lifecycle RPCs.
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

async function createEntry(db, firstWorkDate, employeeCode) {
  const result = await db.query(
    "select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as data",
    [
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001",
      JSON.stringify([{
        project_id: "w04a_project",
        first_work_date: firstWorkDate,
        employee_code: employeeCode,
        worker_details: {
          display_name: "W04A worker " + employeeCode,
          date_of_birth: { state: "omitted" },
          national_id: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "omitted" },
        },
        recruiter_id: "93000000-0000-4000-8000-000000000001",
        labor_type: "TEMPORARY",
      }]),
      "w04a-create-" + employeeCode,
    ],
  );
  return result.rows[0].data.entry_ids[0];
}

async function submitSubmission(db, submissionId) {
  const idemBase = "w04a-" + submissionId.slice(0, 8);
  await db.query("select public.direct_entry_transition_submission($1, $2, $3, $4, $5, $6) as data",
    ["10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000001",
      submissionId, 1, "REVIEW", idemBase + "-review"]);
  await db.query("select public.direct_entry_transition_submission($1, $2, $3, $4, $5, $6) as data",
    ["10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000001",
      submissionId, 2, "SUBMITTED", idemBase + "-submit"]);
}

test("W04A acceptance: legacy 2026-10-16 IS counted (business_date < cutoff)", async () => {
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    // Seed a legacy row on 2026-10-16 and a legacy row on 2026-10-17.
    await db.query("insert into public.data_sources (id, drive_file_id, file_name, sheet_name, active, is_test) values ($1, $2, $3, $4, $5, $6)",
      ["11111111-1111-4111-8111-111111111111", "W04A-LEGACY", "w04a-legacy.xlsx", "Sheet1", true, false]);
    await db.query("insert into public.sync_runs (run_id, source_id, trigger_type, status, started_at, finished_at) values ($1, $2, $3, $4, $5, $5)",
      ["21111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111", "manual", "succeeded", "2026-10-16T00:00:00Z"]);
    await db.query(
      "insert into public.daily_recruitment_breakdown" +
      " (source_id, business_date, project_key, project_display, recruiter_key, recruiter_display," +
      "  provider_type_key, provider_type_display, employment_type_key, employment_type_display," +
      "  recruited_count, sync_run_id, snapshot_at)" +
      " values ($1, '2026-10-16', 'w04a project', 'W04A Project', 'w04a recruiter', 'W04A Recruiter'," +
      " 'hrp', 'HRP', 'thời vụ', 'Thời vụ', 2, $2, '2026-10-16T00:00:00Z')," +
      "        ($1, '2026-10-17', 'w04a project', 'W04A Project', 'w04a recruiter', 'W04A Recruiter'," +
      " 'hrp', 'HRP', 'thời vụ', 'Thời vụ', 9, $2, '2026-10-16T00:00:00Z')",
      ["11111111-1111-4111-8111-111111111111", "21111111-1111-4111-8111-111111111111"],
    );

    await setRole(db, "service_role");
    const res = await db.query(
      "select * from public.direct_entry_reporting_reconciliation_totals()",
    );
    // Legacy 2026-10-16 contributes 2, legacy 2026-10-17 is masked out.
    assert.equal(Number(res.rows[0].legacy_subtotal), 2);
    assert.equal(Number(res.rows[0].direct_entry_subtotal), 0);
    assert.equal(Number(res.rows[0].overlap_blocker), 0);
  } finally {
    await db.close();
  }
});

test("W04A acceptance: eligible Direct Entry 2026-10-16 raises overlap_blocker", async () => {
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    const entryId = await createEntry(db, "2026-10-16", "hrp-2026-101601");
    const submissionRes = await db.query(
      "select submission_id from public.direct_entries where entry_id = $1",
      [entryId],
    );
    await submitSubmission(db, submissionRes.rows[0].submission_id);

    await setRole(db, "service_role");
    const res = await db.query(
      "select * from public.direct_entry_reporting_reconciliation_totals()",
    );
    assert.equal(Number(res.rows[0].overlap_blocker), 1);
  } finally {
    await db.close();
  }
});

test("W04A acceptance: eligible Direct Entry 2026-10-17 contributes exactly 1", async () => {
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    const entryId = await createEntry(db, "2026-10-17", "hrp-2026-101701");
    const submissionRes = await db.query(
      "select submission_id from public.direct_entries where entry_id = $1",
      [entryId],
    );
    await submitSubmission(db, submissionRes.rows[0].submission_id);

    await setRole(db, "service_role");
    const view = await db.query(
      "select count(*) as n, sum(recruited_count)::bigint as total from public.direct_entry_reporting_facts_v01",
    );
    assert.equal(Number(view.rows[0].n), 1);
    assert.equal(Number(view.rows[0].total), 1);

    const totals = await db.query(
      "select * from public.direct_entry_reporting_reconciliation_totals()",
    );
    assert.equal(Number(totals.rows[0].direct_entry_subtotal), 1);
    assert.equal(Number(totals.rows[0].overlap_blocker), 0);
  } finally {
    await db.close();
  }
});

test("W04A acceptance: DRAFT entry is not counted", async () => {
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    // DRAFT — never transition to SUBMITTED. The view must not see it.
    await createEntry(db, "2026-10-17", "hrp-2026-101702");

    await setRole(db, "service_role");
    const view = await db.query("select count(*) as n from public.direct_entry_reporting_facts_v01");
    assert.equal(Number(view.rows[0].n), 0);
  } finally {
    await db.close();
  }
});

test("W04A acceptance: REVIEW entry is not counted", async () => {
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    const entryId = await createEntry(db, "2026-10-17", "hrp-2026-101703");
    const submissionRes = await db.query(
      "select submission_id from public.direct_entries where entry_id = $1",
      [entryId],
    );
    // Move to REVIEW only.
    await db.query("select public.direct_entry_transition_submission($1, $2, $3, $4, $5, $6) as data",
      ["10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000001",
        submissionRes.rows[0].submission_id, 1, "REVIEW", "w04a-review-only"]);

    await setRole(db, "service_role");
    const view = await db.query("select count(*) as n from public.direct_entry_reporting_facts_v01");
    assert.equal(Number(view.rows[0].n), 0);
  } finally {
    await db.close();
  }
});

test("W04A acceptance: deleted_at != null is not counted", async () => {
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    const entryId = await createEntry(db, "2026-10-17", "hrp-2026-101704");
    const submissionRes = await db.query(
      "select submission_id from public.direct_entries where entry_id = $1",
      [entryId],
    );
    await submitSubmission(db, submissionRes.rows[0].submission_id);
    // Soft delete the entry by bumping version (trigger guard). The view
    // must drop the row because deleted_at IS NOT NULL.
    await db.query(
      "update public.direct_entries set deleted_at = now(), version = version + 1 where entry_id = $1",
      [entryId],
    );

    await setRole(db, "service_role");
    const view = await db.query("select count(*) as n from public.direct_entry_reporting_facts_v01");
    assert.equal(Number(view.rows[0].n), 0);
  } finally {
    await db.close();
  }
});

test("W04A acceptance: view grain is per entry (not per revision/document/payment/event)", async () => {
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    const entryId = await createEntry(db, "2026-10-17", "hrp-2026-101705");
    const submissionRes = await db.query(
      "select submission_id from public.direct_entries where entry_id = $1",
      [entryId],
    );
    await submitSubmission(db, submissionRes.rows[0].submission_id);
    // Create a candidate and document lineage that WOULD multiply the
    // count if any of them were naively joined. The view must stay at 1.
    const entry = await db.query(
      "select candidate_id from public.direct_entries where entry_id = $1",
      [entryId],
    );
    const candidateId = entry.rows[0].candidate_id;
    // Add a document version (CCCD_FRONT).
    await db.query(
      "insert into public.direct_entry_document_versions" +
      " (document_id, candidate_id, document_type, version, idempotency_key, checksum_sha256," +
      "  size_bytes, mime_type, storage_key, upload_status, scan_status, attempts, created_by_user_id)" +
      " values (gen_random_uuid(), $1, 'CCCD_FRONT', 1, 'idem-w04a-front', $2, 1024," +
      "          'application/pdf', $3, 'READY', 'CLEAN', 0, $4)",
      [candidateId, "a".repeat(64),
        "p1.6/" + candidateId + "/CCCD_FRONT/1/" + crypto.randomUUID(),
        "20000000-0000-4000-8000-000000000001"],
    );
    // Add a payment (provided) — seed a valid active bank first so the
    // validator doesn't trip. The view itself MUST NOT join payments, so the
    // fact row count stays at 1 even with a payment present.
    await db.query(
      "insert into public.direct_entry_banks (bank_id, display_name, active) values ($1, $2, true)",
      ["w04a_bank_id", "W04A Bank"],
    );
    await db.query(
      "insert into public.direct_entry_payments" +
      " (entry_id, state, account_number, bank_id, account_holder_name)" +
      " values ($1, 'provided', '000012340056', $2, 'W04A Account Holder')",
      [entryId, "w04a_bank_id"],
    );

    await setRole(db, "service_role");
    const view = await db.query(
      "select count(*) as n, sum(recruited_count)::bigint as total from public.direct_entry_reporting_facts_v01",
    );
    assert.equal(Number(view.rows[0].n), 1);
    assert.equal(Number(view.rows[0].total), 1);
  } finally {
    await db.close();
  }
});

test("W04A acceptance: dimension mapping (project/recruiter/provider/employment)", async () => {
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    const entryId = await createEntry(db, "2026-10-17", "hrp-2026-101706");
    const submissionRes = await db.query(
      "select submission_id from public.direct_entries where entry_id = $1",
      [entryId],
    );
    await submitSubmission(db, submissionRes.rows[0].submission_id);

    await setRole(db, "service_role");
    const res = await db.query(
      "select project_key, project_display, recruiter_key, recruiter_display," +
      " provider_type_key, provider_type_display, employment_type_key, employment_type_display," +
      " recruited_count::int, first_work_date::text" +
      " from public.direct_entry_reporting_facts_v01",
    );
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].project_key, "w04a project");
    assert.equal(res.rows[0].project_display, "W04A Project");
    assert.equal(res.rows[0].recruiter_key, "w04a recruiter");
    assert.equal(res.rows[0].recruiter_display, "W04A recruiter");
    assert.equal(res.rows[0].provider_type_key, "hrp");
    assert.equal(res.rows[0].provider_type_display, "HRP");
    assert.equal(res.rows[0].employment_type_key, "thời vụ");
    assert.equal(res.rows[0].employment_type_display, "Thời vụ");
    assert.equal(res.rows[0].recruited_count, 1);
    assert.equal(res.rows[0].first_work_date, "2026-10-17");
  } finally {
    await db.close();
  }
});

test("W04A acceptance: query failure does not become empty (no rows => count=0, not error)", async () => {
  const { db } = await buildDb();
  try {
    await setRole(db, "service_role");
    // On an empty (no fixture) DB, the view must return 0 rows with
    // count=0, not throw. The reconciliation helper returns 0/0/0.
    const view = await db.query(
      "select count(*)::bigint as n from public.direct_entry_reporting_facts_v01",
    );
    assert.equal(Number(view.rows[0].n), 0);
    const totals = await db.query(
      "select * from public.direct_entry_reporting_reconciliation_totals()",
    );
    assert.equal(Number(totals.rows[0].legacy_subtotal), 0);
    assert.equal(Number(totals.rows[0].direct_entry_subtotal), 0);
    assert.equal(Number(totals.rows[0].overlap_blocker), 0);
  } finally {
    await db.close();
  }
});

test("W04A acceptance: P1 filters apply via SQL on the projection view", async () => {
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    // Two entries: 2026-10-17 and 2026-10-18.
    const a = await createEntry(db, "2026-10-17", "hrp-2026-101801");
    const b = await createEntry(db, "2026-10-18", "hrp-2026-101802");
    // create_batch mints a fresh submission per call, so each entry is in
    // its own submission. Submit BOTH so the view surfaces both rows.
    const submissionRes = await db.query(
      "select submission_id from public.direct_entries where entry_id = any($1::uuid[])",
      [[a, b]],
    );
    for (const row of submissionRes.rows) {
      await submitSubmission(db, row.submission_id);
    }

    await setRole(db, "service_role");
    // Filter: business_date between 2026-10-17 and 2026-10-17 => only 1 row.
    const res = await db.query(
      "select count(*)::bigint as n from public.direct_entry_reporting_facts_v01" +
      " where business_date between '2026-10-17' and '2026-10-17'",
    );
    assert.equal(Number(res.rows[0].n), 1);
    // Filter: project_key = 'w04a project' => all rows.
    const res2 = await db.query(
      "select count(*)::bigint as n from public.direct_entry_reporting_facts_v01" +
      " where project_key = 'w04a project'",
    );
    assert.equal(Number(res2.rows[0].n), 2);
  } finally {
    await db.close();
  }
});

test("W04A acceptance: read-only transaction does not mutate DB (reconciliation dry-run)", async () => {
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    const entryId = await createEntry(db, "2026-10-17", "hrp-2026-101901");
    const submissionRes = await db.query(
      "select submission_id from public.direct_entries where entry_id = $1",
      [entryId],
    );
    await submitSubmission(db, submissionRes.rows[0].submission_id);

    await setRole(db, "service_role");
    // Open a READ ONLY transaction. Reconciliation must succeed and the
    // ROLLBACK must not have touched anything.
    await db.query("begin");
    await db.query("set transaction read only");
    await db.query("set local statement_timeout = '5s'");
    const res = await db.query(
      "select * from public.direct_entry_reporting_reconciliation_totals()",
    );
    await db.query("rollback");
    assert.equal(Number(res.rows[0].direct_entry_subtotal), 1);
    // After rollback, the entry must still be SUBMITTED (not affected by
    // any pseudo-write).
    const check = await db.query(
      "select s.state from public.direct_entry_submissions s" +
      " join public.direct_entries e on e.submission_id = s.submission_id" +
      " where e.entry_id = $1",
      [entryId],
    );
    assert.equal(check.rows[0].state, "SUBMITTED");
  } finally {
    await db.close();
  }
});

test("W04A acceptance: baseline 34/44 invariants match the production baseline (table-empty check)", async () => {
  const { db } = await buildDb();
  try {
    await setRole(db, "service_role");
    // On a fresh migrated DB with no seeded business data, reconciliation
    // totals must be 0/0/0. The production baseline (34 rows / 44 total /
    // fingerprint 7abfbdab...) is verified by a separate read-only
    // transaction in scripts/p2-w04a-reconcile.mjs against Production.
    const res = await db.query(
      "select * from public.direct_entry_reporting_reconciliation_totals()",
    );
    assert.equal(Number(res.rows[0].legacy_subtotal), 0);
    assert.equal(Number(res.rows[0].direct_entry_subtotal), 0);
    assert.equal(Number(res.rows[0].overlap_blocker), 0);
  } finally {
    await db.close();
  }
});