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
  // `set local role` only takes effect inside an open transaction. The
  // PGlite test harness runs each query outside a transaction, so we use
  // `set role` (session-scoped) and `reset role` to return to the owner.
  await db.exec(`set role ${role}`);
}

async function resetRole(db) {
  await db.exec("reset role");
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

test("W04A acceptance: legacy 2026-09-29 IS counted (business_date < cutoff)", async () => {
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    // Seed a legacy row on 2026-09-29 and a row on the cutoff day.
    await db.query("insert into public.data_sources (id, drive_file_id, file_name, sheet_name, active, is_test) values ($1, $2, $3, $4, $5, $6)",
      ["11111111-1111-4111-8111-111111111111", "W04A-LEGACY", "w04a-legacy.xlsx", "Sheet1", true, false]);
    await db.query("insert into public.sync_runs (run_id, source_id, trigger_type, status, started_at, finished_at) values ($1, $2, $3, $4, $5, $5)",
      ["21111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111", "manual", "succeeded", "2026-09-29T00:00:00Z"]);
    await db.query(
      "insert into public.daily_recruitment_breakdown" +
      " (source_id, business_date, project_key, project_display, recruiter_key, recruiter_display," +
      "  provider_type_key, provider_type_display, employment_type_key, employment_type_display," +
      "  recruited_count, sync_run_id, snapshot_at)" +
      " values ($1, '2026-09-29', 'w04a project', 'W04A Project', 'w04a recruiter', 'W04A Recruiter'," +
      " 'hrp', 'HRP', 'thời vụ', 'Thời vụ', 2, $2, '2026-09-29T00:00:00Z')," +
      "        ($1, '2026-09-30', 'w04a project', 'W04A Project', 'w04a recruiter', 'W04A Recruiter'," +
      " 'hrp', 'HRP', 'thời vụ', 'Thời vụ', 9, $2, '2026-09-29T00:00:00Z')",
      ["11111111-1111-4111-8111-111111111111", "21111111-1111-4111-8111-111111111111"],
    );

    await setRole(db, "service_role");
    const res = await db.query(
      "select * from public.direct_entry_reporting_reconciliation_totals()",
    );
    // Legacy 2026-09-29 contributes 2; 2026-09-30 is masked out.
    assert.equal(Number(res.rows[0].legacy_subtotal), 2);
    assert.equal(Number(res.rows[0].direct_entry_subtotal), 0);
    assert.equal(Number(res.rows[0].overlap_blocker), 0);
  } finally {
    await db.close();
  }
});

test("W04A acceptance: eligible Direct Entry 2026-09-29 raises overlap_blocker", async () => {
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    const entryId = await createEntry(db, "2026-09-29", "hrp-2026-092901");
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

    // reconciliation_totals() is SECURITY DEFINER, so it runs as the
    // migration owner regardless of caller. We do NOT need to set role
    // service_role here — the verification query below intentionally
    // runs as the default owner (postgres) to prove the read-only
    // transaction path is independent of the service_role boundary.
    await db.query("begin");
    await db.query("set transaction read only");
    await db.query("set local statement_timeout = '5s'");
    const res = await db.query(
      "select direct_entry_subtotal::text as direct_entry_subtotal" +
      " from public.direct_entry_reporting_reconciliation_totals()",
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

test("W04A acceptance: fresh-DB reconciliation returns 0/0/0 with the locked cutoff", async () => {
  const { db } = await buildDb();
  try {
    await setRole(db, "service_role");
    // On a fresh migrated DB with no seeded business data, reconciliation
    // totals must be 0/0/0 and the cutoff must be the locked post-purge
    // rebaseline value 2026-09-30. Production data-plane verification
    // (real row count / subtotal) is performed by the data-agnostic
    // scripts/p2-w04a-reconcile.mjs in a read-only transaction.
    const res = await db.query(
      "select legacy_subtotal, direct_entry_subtotal, overlap_blocker," +
      " cutoff_date::text as cutoff_date from public.direct_entry_reporting_reconciliation_totals()",
    );
    assert.equal(Number(res.rows[0].legacy_subtotal), 0);
    assert.equal(Number(res.rows[0].direct_entry_subtotal), 0);
    assert.equal(Number(res.rows[0].overlap_blocker), 0);
    assert.equal(res.rows[0].cutoff_date, "2026-09-30");
  } finally {
    await db.close();
  }
});

// =============================================================================
// R1 — Runtime closure acceptance tests.
//
// R1 mandate: migration self-check is data-agnostic, runtime blocker is
// independent of the masked view, service-role ACL is explicit, dimension
// options cover DE-only values, and the W04A production-shape non-zero
// legacy baseline (34 rows / 44 total) survives #40 cleanly. P2-W04B
// rebaseline retires the 34/44 magnitude assertion in favour of
// structural invariants; only the #40 isolation test still relies on
// the historical magnitude and that test deliberately re-applies #40
// without #44, so the original cutoff (2026-10-17) is preserved.
// =============================================================================

async function seedProductionShapeLegacy(db) {
  // P2-W04B rebaseline: the post-purge legacy aggregate is empty
  // (0 rows / 0 total). The old "34 rows / 44 total / 2026-10-01..16"
  // baseline from p2-w01-r1 is intentionally NOT reproduced because the
  // cutover reads through direct_entry_reporting_cutoff() and the pre-purge
  // distribution is no longer canonical. This seed is only used by the
  // migration #40 isolation test (which applies only #40, with cutoff =
  // 2026-10-17). Under that cutoff all 34 rows are pre-cutoff, so the
  // legacy subtotal is preserved at 44.
  await db.query(
    "insert into public.data_sources (id, drive_file_id, file_name, sheet_name, active, is_test) values" +
    " ('11111111-1111-4111-8111-111111111111', 'W04A-LEGACY-1', 'w04a-legacy-1.xlsx', 'Sheet1', true, false)," +
    " ('11111111-1111-4111-8111-111111111112', 'W04A-LEGACY-2', 'w04a-legacy-2.xlsx', 'Sheet1', true, false)," +
    " ('11111111-1111-4111-8111-111111111113', 'W04A-LEGACY-3', 'w04a-legacy-3.xlsx', 'Sheet1', true, false)," +
    " ('11111111-1111-4111-8111-111111111114', 'W04A-LEGACY-4', 'w04a-legacy-4.xlsx', 'Sheet1', true, false)," +
    " ('11111111-1111-4111-8111-111111111115', 'W04A-LEGACY-5', 'w04a-legacy-5.xlsx', 'Sheet1', true, false)," +
    " ('11111111-1111-4111-8111-111111111116', 'W04A-LEGACY-6', 'w04a-legacy-6.xlsx', 'Sheet1', true, false)"
  );
  // 34 rows over days 2026-10-01..2026-10-07. With 6 sources and 7 days,
  // 6*7 = 42 distinct (source, day) pairs > 34 rows: the (source_id,
  // business_date, ...) primary key never collides. 24 rows have count
  // 1 and 10 rows have count 2: 24*1 + 10*2 = 44.
  const daySources = [];
  for (let i = 0; i < 34; i++) {
    const day = String(1 + (i % 7)).padStart(2, "0");
    const source = "11111111-1111-4111-8111-11111111111" + (1 + (i % 6));
    daySources.push({ source, day, count: i < 24 ? 1 : 2 });
  }
  for (let i = 0; i < daySources.length; i++) {
    const { source, day, count } = daySources[i];
    const runId = "21111111-1111-4111-8111-11111111111" + (1 + (i % 6));
    await db.query(
      "insert into public.sync_runs (run_id, source_id, trigger_type, status, started_at, finished_at) values ($1, $2, 'manual', 'succeeded', $3, $3)" +
      " on conflict do nothing",
      [runId, source, "2026-10-" + day + "T00:00:00Z"]
    );
    await db.query(
      "insert into public.daily_recruitment_breakdown" +
      " (source_id, business_date, project_key, project_display, recruiter_key, recruiter_display," +
      "  provider_type_key, provider_type_display, employment_type_key, employment_type_display," +
      "  recruited_count, sync_run_id, snapshot_at)" +
      " values ($1, $2::date, 'w04a project', 'W04A Project', 'w04a recruiter', 'W04A Recruiter'," +
      " 'hrp', 'HRP', 'thời vụ', 'Thời vụ', $3, $4, $5::timestamptz)",
      [source, "2026-10-" + day, count, runId, "2026-10-" + day + "T00:00:00Z"]
    );
  }
}

test("R1 acceptance: migration #40 applies cleanly on Production-shape DB (34/44, 6 sources)", async () => {
  // Blocker 1: data-agnostic self-check must let the migration run on a
  // Production-shaped DB that already carries 34 legacy rows / 44 total
  // / 6 sources. The migration must apply cleanly and the legacy subtotal
  // must be preserved by the reconciliation helper.
  //
  // This test focuses on migration #40 (the original W04A closure). It
  // deliberately skips both #40 and #44 in the apply loop, then re-applies
  // only #40 explicitly so the test isolates the #40 R1 self-check.
  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    const names = (await readdir(MIGRATION_DIR))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of names) {
      if (name.includes("p2_w04a_direct_entry_reporting_cutover")) continue;
      if (name.includes("p2_w04b_post_purge_cutover_rebaseline")) continue;
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }
    await seedProductionShapeLegacy(db);
    const migration40 = await readFile(
      path.join(MIGRATION_DIR, "20261007020000_p2_w04a_direct_entry_reporting_cutover.sql"),
      "utf8"
    );
    await db.exec(migration40);
    await db.exec("set role service_role");
    const res = await db.query(
      "select legacy_subtotal, direct_entry_subtotal, overlap_blocker, cutoff_date::text as cutoff_date" +
      " from public.direct_entry_reporting_reconciliation_totals()"
    );
    assert.equal(Number(res.rows[0].legacy_subtotal), 44, "legacy subtotal preserved");
    assert.equal(Number(res.rows[0].direct_entry_subtotal), 0);
    assert.equal(Number(res.rows[0].overlap_blocker), 0);
    assert.equal(res.rows[0].cutoff_date, "2026-10-17");
  } finally {
    await db.close();
  }
});

test("R1 acceptance: runtime blocker count is 1+ on a pre-cutoff eligible DE row", async () => {
  // Blocker 3: runtime blocker helper counts pre-cutoff eligible DE rows
  // directly, independent of the masked projection view.
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    const entryId = await createEntry(db, "2026-09-29", "hrp-2026-092901");
    const submissionRes = await db.query(
      "select submission_id from public.direct_entries where entry_id = $1",
      [entryId]
    );
    await submitSubmission(db, submissionRes.rows[0].submission_id);
    await setRole(db, "service_role");
    const res = await db.query(
      "select public.direct_entry_reporting_pre_cutover_blocker_count() as blocker"
    );
    assert.equal(Number(res.rows[0].blocker), 1, "runtime blocker helper returns 1");
    const view = await db.query(
      "select count(*)::bigint as n from public.direct_entry_reporting_facts_v01"
    );
    assert.equal(Number(view.rows[0].n), 0, "masked view is empty for pre-cutoff rows");
  } finally {
    await db.close();
  }
});

test("R1 acceptance: runtime blocker count is 0 on a clean post-cutoff-only DB", async () => {
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    const entryId = await createEntry(db, "2026-10-17", "hrp-2026-101701");
    const submissionRes = await db.query(
      "select submission_id from public.direct_entries where entry_id = $1",
      [entryId]
    );
    await submitSubmission(db, submissionRes.rows[0].submission_id);
    const res = await db.query(
      "select public.direct_entry_reporting_pre_cutover_blocker_count() as blocker"
    );
    assert.equal(Number(res.rows[0].blocker), 0, "runtime blocker helper returns 0 on clean DB");
  } finally {
    await db.close();
  }
});

test("R1 acceptance: service_role has EXECUTE on every runtime helper", async () => {
  // Blocker 6: explicit GRANT EXECUTE TO service_role for runtime helpers.
  // anon / authenticated remain denied.
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
        "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as svc," +
        " has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon," +
        " has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth",
        [sig]
      );
      assert.equal(res.rows[0].svc, true, sig + " must be EXECUTE-able by service_role");
      assert.equal(res.rows[0].anon, false, sig + " must be denied to anon");
      assert.equal(res.rows[0].auth, false, sig + " must be denied to authenticated");
    }
  } finally {
    await db.close();
  }
});

test("R1 acceptance: dimension options view emits DE-only dimensions (project/recruiter/provider/employment)", async () => {
  // Blocker 5: the new DE dimension options view must emit one row per
  // (dimension, key, display) grouping for DE-only dimensions.
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name) values ($1, $2) on conflict do nothing",
      ["w04a_de_only_project", "W04A DE-only Project"]
    );
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name) values ($1, $2) on conflict do nothing",
      ["93000000-0000-4000-8000-000000000002", "W04A DE-only Recruiter"]
    );
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from) values ($1, $2, $3) on conflict do nothing",
      ["93000000-0000-4000-8000-000000000002", "vendor", "2020-01-01"]
    );
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from) values ($1, $2, $3) on conflict do nothing",
      ["93000000-0000-4000-8000-000000000002", "94000000-0000-4000-8000-000000000001", "2020-01-01"]
    );
    await db.query(
      "insert into public.recruiter_aliases (recruiter_id, reporting_key, valid_from) values ($1, $2, $3) on conflict do nothing",
      ["93000000-0000-4000-8000-000000000002", "w04a de-only recruiter", "2020-01-01"]
    );
    // Use a different app_user_id to avoid overlap with the seedFixture's
    // recruiter link (the table guards "verified" links for the same
    // app_user_id against overlapping valid_from). The new app_user has
    // its own capability/scope grants seeded below.
    const deAppUserId = "20000000-0000-4000-8000-0000000000de";
    const deAuthSubject = "10000000-0000-4000-8000-0000000000de";
    await db.query("insert into auth.users (id) values ($1) on conflict do nothing", [deAuthSubject]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject) values ($1, $2) on conflict do nothing",
      [deAppUserId, deAuthSubject]
    );
    for (const cap of ["entry_create", "submission_create", "entry_own"]) {
      await db.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from) values ($1, $2, $3) on conflict do nothing",
        [deAppUserId, cap, "2020-01-01"]
      );
    }
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from) values ($1, $2, $3) on conflict do nothing",
      [deAppUserId, "own", "2020-01-01"]
    );
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links" +
      " (app_user_id, recruiter_id, verified, valid_from) values ($1, $2, true, $3) on conflict do nothing",
      [deAppUserId, "93000000-0000-4000-8000-000000000002", "2020-01-01"]
    );
    const entryId = await db.query(
      "select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as data",
      [
        deAuthSubject,
        deAppUserId,
        JSON.stringify([{
          project_id: "w04a_de_only_project",
          first_work_date: "2026-10-17",
          employee_code: "hrp-2026-101801",
          worker_details: {
            display_name: "W04A DE-only worker",
            date_of_birth: { state: "omitted" },
            national_id: { state: "omitted" },
            address: { state: "omitted" },
            phone: { state: "omitted" }
          },
          recruiter_id: "93000000-0000-4000-8000-000000000002",
          labor_type: "PERMANENT"
        }]),
        "w04a-r1-deopt-1"
      ]
    );
    const newEntryId = entryId.rows[0].data.entry_ids[0];
    const submissionRes = await db.query(
      "select submission_id from public.direct_entries where entry_id = $1",
      [newEntryId]
    );
    await db.query(
      "select public.direct_entry_transition_submission($1, $2, $3, $4, $5, $6) as data",
      [deAuthSubject, deAppUserId,
        submissionRes.rows[0].submission_id, 1, "REVIEW", "w04a-r1-deopt-1-review"]
    );
    await db.query(
      "select public.direct_entry_transition_submission($1, $2, $3, $4, $5, $6) as data",
      [deAuthSubject, deAppUserId,
        submissionRes.rows[0].submission_id, 2, "SUBMITTED", "w04a-r1-deopt-1-submit"]
    );
    await setRole(db, "service_role");
    const project = await db.query(
      "select key, display, recruited_count from public.direct_entry_reporting_dimension_options_v01" +
      " where dimension = 'project' and key = 'w04a de-only project'"
    );
    assert.equal(project.rows.length, 1, "DE-only project option emitted exactly once");
    assert.equal(project.rows[0].recruited_count, 1);
    const recruiter = await db.query(
      "select key, display, recruited_count from public.direct_entry_reporting_dimension_options_v01" +
      " where dimension = 'recruiter' and key = 'w04a de-only recruiter'"
    );
    assert.equal(recruiter.rows.length, 1, "DE-only recruiter option emitted exactly once");
    const provider = await db.query(
      "select key, display, recruited_count from public.direct_entry_reporting_dimension_options_v01" +
      " where dimension = 'provider' and key = 'vendor'"
    );
    assert.equal(provider.rows.length, 1, "DE-only provider (vendor) option emitted exactly once");
    const employment = await db.query(
      "select key, display, recruited_count from public.direct_entry_reporting_dimension_options_v01" +
      " where dimension = 'employment' and key = 'chính thức'"
    );
    assert.equal(employment.rows.length, 1, "DE-only employment (chính thức) option emitted exactly once");
  } finally {
    await db.close();
  }
});

test("R1 acceptance: dimension options view is denied to anon / authenticated and granted to service_role", async () => {
  // Blocker 6: the new view follows the same ACL contract.
  const { db } = await buildDb();
  try {
    const grants = await db.query(
      "select has_table_privilege('anon', 'public.direct_entry_reporting_dimension_options_v01', 'SELECT') as anon," +
      " has_table_privilege('authenticated', 'public.direct_entry_reporting_dimension_options_v01', 'SELECT') as auth," +
      " has_table_privilege('service_role', 'public.direct_entry_reporting_dimension_options_v01', 'SELECT') as svc"
    );
    assert.deepEqual(
      { anon: grants.rows[0].anon, auth: grants.rows[0].auth, svc: grants.rows[0].svc },
      { anon: false, auth: false, svc: true }
    );
  } finally {
    await db.close();
  }
});

test("R1 acceptance: source/status UI is NOT re-introduced by the cutover options loader", async () => {
  // Blocker 5: source-status UI is locked out. The cutover options loader
  // must not re-introduce a source-status / coverage surface.
  const { readFile } = await import("node:fs/promises");
  const optsPath = path.resolve("src/lib/reporting/p2-w04a-options-server.ts");
  const src = await readFile(optsPath, "utf8");
  assert.ok(!src.includes("source-status"), "cutover options loader must not re-introduce source-status UI");
  assert.ok(!src.includes("P2_W04A_DIRECT_ENTRY_SOURCE_ID"),
    "cutover options loader must not reference the DE source id (synthetic, not exposed)");
});

test("R1 acceptance: Dashboard page imports the cutover read path, not the legacy-only function", async () => {
  // Blocker 2: the Dashboard page must call the cutover function. The
  // R0 page called `fetchReporting` / `fetchReportingOptions` from
  // p1-reporting-server / p1-options-server.
  const { readFile } = await import("node:fs/promises");
  const pagePath = path.resolve("src/app/dashboard/page.tsx");
  const src = await readFile(pagePath, "utf8");
  assert.ok(src.includes("fetchCutoverReporting"),
    "Dashboard page must import and call fetchCutoverReporting");
  assert.ok(src.includes("fetchCutoverReportingOptions"),
    "Dashboard page must import and call fetchCutoverReportingOptions");
  assert.ok(!src.includes('from "@/lib/reporting/p1-reporting-server"'),
    "Dashboard page must NOT import the legacy-only fetchReporting from p1-reporting-server");
  assert.ok(!src.includes('from "@/lib/reporting/p1-options-server"'),
    "Dashboard page must NOT import the legacy-only fetchReportingOptions from p1-options-server");
  const viewPath = path.resolve("src/components/dashboard/dashboard-view.tsx");
  const view = await readFile(viewPath, "utf8");
  assert.ok(!view.includes("data.data"),
    "DashboardView must NOT introduce a data.data field; ReportingFetchResult shape preserved");
});

test("R1 acceptance: legacy 2026-09-30 row is masked out (cutoff day excluded from legacy)", async () => {
  // P2-W04C rebaseline: the legacy aggregate mask is `business_date <
  // direct_entry_reporting_cutoff()` = `business_date < 2026-09-30`. Rows
  // on 2026-09-30 itself must be masked out. The seed is data-agnostic
  // (no fixed 34/44 magnitude is asserted — the pre-purge baseline was
  // retired by the W04B rebaseline). The test proves the boundary: rows
  // on day 29 contribute, rows on day 30 are masked, the same
  // reconciliation helper agrees with the direct masked sum.
  const { db } = await buildDb();
  try {
    // Seed two legacy rows: one strictly before the new cutoff, one
    // exactly on the new cutoff day.
    await seedFixture(db);
    await db.query(
      "insert into public.data_sources (id, drive_file_id, file_name, sheet_name, active, is_test) values ($1, $2, $3, $4, $5, $6)",
      ["11111111-1111-4111-8111-111111111111", "W04B-LEGACY", "w04b-legacy.xlsx", "Sheet1", true, false]
    );
    await db.query(
      "insert into public.sync_runs (run_id, source_id, trigger_type, status, started_at, finished_at) values ($1, $2, $3, $4, $5, $5)",
      ["21111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111", "manual", "succeeded", "2026-09-29T00:00:00Z"]
    );
    await db.query(
      "insert into public.daily_recruitment_breakdown" +
      " (source_id, business_date, project_key, project_display, recruiter_key, recruiter_display," +
      "  provider_type_key, provider_type_display, employment_type_key, employment_type_display," +
      "  recruited_count, sync_run_id, snapshot_at)" +
      " values ($1, '2026-09-29', 'w04a project', 'W04A Project', 'w04a recruiter', 'W04A Recruiter'," +
      " 'hrp', 'HRP', 'thời vụ', 'Thời vụ', 4, $2, '2026-09-29T00:00:00Z')," +
      "        ($1, '2026-09-30', 'w04a project', 'W04A Project', 'w04a recruiter', 'W04A Recruiter'," +
      " 'hrp', 'HRP', 'thời vụ', 'Thời vụ', 7, $2, '2026-09-29T00:00:00Z')",
      ["11111111-1111-4111-8111-111111111111", "21111111-1111-4111-8111-111111111111"]
    );
    // Direct masked sum MUST equal the legacy subtotal returned by the
    // helper. Row on 2026-09-29 contributes 4, row on 2026-09-30 is
    // masked out.
    const masked = await db.query(
      "select coalesce(sum(recruited_count), 0)::bigint as subtotal" +
      " from public.daily_recruitment_breakdown where business_date < '2026-09-30'"
    );
    assert.equal(Number(masked.rows[0].subtotal), 4,
      "row on 2026-09-29 contributes 4, row on 2026-09-30 is masked out");
    await setRole(db, "service_role");
    const recon = await db.query(
      "select legacy_subtotal::text as legacy_subtotal" +
      " from public.direct_entry_reporting_reconciliation_totals()"
    );
    assert.equal(Number(recon.rows[0].legacy_subtotal), 4,
      "reconciliation helper agrees with the direct masked sum");
  } finally {
    await resetRole(db);
    await db.close();
  }
});

test("R1 acceptance: cutover reporting source id is locked and not in data_sources", async () => {
  // The DE source id MUST be the locked synthetic UUID and MUST NOT be
  // inserted as a data_sources row.
  const { db } = await buildDb();
  try {
    await setRole(db, "service_role");
    const src = await db.query(
      "select public.direct_entry_reporting_source_id()::text as id"
    );
    assert.equal(src.rows[0].id, "00000000-0000-4000-8000-0000de000001");
    const ds = await db.query(
      "select count(*)::bigint as n from public.data_sources where id = '00000000-0000-4000-8000-0000de000001'"
    );
    assert.equal(Number(ds.rows[0].n), 0, "DE source must NOT be a data_sources row");
  } finally {
    await db.close();
  }
});

test("R1 acceptance: source/status filter is not restored by cutover wiring", async () => {
  // The legacy source/status UI is removed. The cutover wiring must not
  // re-introduce it via dashboard view, options, or filter bar.
  const { readFile } = await import("node:fs/promises");
  const files = [
    "src/app/dashboard/page.tsx",
    "src/components/dashboard/dashboard-view.tsx",
    "src/components/dashboard/dashboard-filters.tsx",
    "src/lib/reporting/p2-w04a-reporting-server.ts",
    "src/lib/reporting/p2-w04a-options-server.ts"
  ];
  for (const rel of files) {
    const abs = path.resolve(rel);
    const src = await readFile(abs, "utf8");
    assert.ok(!src.includes("f-source"),
      rel + " must not re-introduce the source filter field");
  }
});

test("R1 acceptance: cutover options catalog merges legacy + DE dimensions (no double entry)", async () => {
  // Two same-key dimension rows (one from the legacy view, one from the
  // DE view) must collapse to one catalog entry. buildDimensionOptions
  // groups by (dimension, key) — the new options loader feeds the union
  // through it, so no double entry can leak.
  const { buildDimensionOptions } = await import("../src/lib/reporting/p1-reporting.ts");
  const merged = [
    { dimension: "project", key: "w04a project", display: "W04A Project", recruited_count: 5 },
    { dimension: "project", key: "w04a de-only project", display: "W04A DE-only Project", recruited_count: 1 },
    { dimension: "recruiter", key: "w04a recruiter", display: "W04A Recruiter", recruited_count: 5 },
    { dimension: "recruiter", key: "w04a de-only recruiter", display: "W04A DE-only Recruiter", recruited_count: 1 },
    { dimension: "provider", key: "hrp", display: "HRP", recruited_count: 5 },
    { dimension: "provider", key: "vendor", display: "Vendor", recruited_count: 1 },
    { dimension: "employment", key: "thời vụ", display: "Thời vụ", recruited_count: 5 },
    { dimension: "employment", key: "chính thức", display: "Chính thức", recruited_count: 1 },
  ];
  const catalog = buildDimensionOptions(merged);
  assert.equal(catalog.projects.length, 2);
  assert.ok(catalog.projects.some((o) => o.key === "w04a project"));
  assert.ok(catalog.projects.some((o) => o.key === "w04a de-only project"));
  assert.equal(catalog.recruiters.length, 2);
  assert.equal(catalog.providers.length, 2);
  assert.equal(catalog.employments.length, 2);
});

// =============================================================================
// T0 R1 — service-role execution evidence.
//
// Blocker 1: under `SET ROLE service_role`, every helper / view must run
// for real (count + full row payload), and anon / authenticated must still
// be denied. Not just a `has_*_privilege` smoke check.
// =============================================================================

test("R1 service-role execution: views and table-reading helpers succeed under SET ROLE service_role", async () => {
  const { db } = await buildDb();
  try {
    // Seed eligible post-cutoff DE row so views emit at least 1 row.
    await seedFixture(db);
    const entryId = await createEntry(db, "2026-10-17", "hrp-2026-101703");
    const submissionRes = await db.query(
      "select submission_id from public.direct_entries where entry_id = $1",
      [entryId]
    );
    await submitSubmission(db, submissionRes.rows[0].submission_id);

    await setRole(db, "service_role");

    // Projection view: count + full row.
    const viewCount = await db.query(
      "select count(*)::bigint as n from public.direct_entry_reporting_facts_v01"
    );
    assert.equal(Number(viewCount.rows[0].n), 1);

    const viewRow = await db.query(
      "select source_id, business_date::text, project_key, recruiter_key," +
      " provider_type_key, employment_type_key, recruited_count::int," +
      " first_work_date::text, entry_id::text, submission_id::text" +
      " from public.direct_entry_reporting_facts_v01 limit 1"
    );
    assert.equal(viewRow.rows.length, 1);
    assert.equal(viewRow.rows[0].source_id, "00000000-0000-4000-8000-0000de000001");
    assert.equal(viewRow.rows[0].recruited_count, 1);

    // Dimension options view: real execution.
    const dimCount = await db.query(
      "select count(*)::bigint as n from public.direct_entry_reporting_dimension_options_v01"
    );
    assert.equal(Number(dimCount.rows[0].n) >= 1, true);

    // Runtime blocker RPC (reads direct_entries / direct_entry_submissions).
    const blocker = await db.query(
      "select public.direct_entry_reporting_pre_cutover_blocker_count() as c"
    );
    assert.equal(Number(blocker.rows[0].c), 0);

    // Reconciliation RPC (reads direct_entries / daily_recruitment_breakdown).
    const recon = await db.query(
      "select legacy_subtotal::text as legacy_subtotal," +
      " direct_entry_subtotal::text as direct_entry_subtotal," +
      " overlap_blocker::text as overlap_blocker," +
      " cutoff_date::text as cutoff_date" +
      " from public.direct_entry_reporting_reconciliation_totals()"
    );
    assert.equal(Number(recon.rows[0].direct_entry_subtotal), 1);
    assert.equal(Number(recon.rows[0].overlap_blocker), 0);
    assert.equal(recon.rows[0].cutoff_date, "2026-09-30");

    // alias_key / provider_key helpers with a NON-EXISTENT recruiter_id =>
    // "__unknown__" sentinel (proves SECURITY DEFINER + table read works).
    const ghost = "9fffffff-ffff-4fff-8fff-ffffffffffff";
    const alias = await db.query(
      "select public.direct_entry_reporting_recruiter_alias_key($1::uuid, '2026-10-17'::date) as k",
      [ghost]
    );
    assert.equal(alias.rows[0].k, "__unknown__");
    const provider = await db.query(
      "select public.direct_entry_reporting_recruiter_provider_key($1::uuid, '2026-10-17'::date) as k",
      [ghost]
    );
    assert.equal(provider.rows[0].k, "__unknown__");

    // alias_key / provider_key with a REAL recruiter_id => resolves to the
    // seeded alias / membership values.
    const aliasR = await db.query(
      "select public.direct_entry_reporting_recruiter_alias_key($1::uuid, '2026-10-17'::date) as k",
      ["93000000-0000-4000-8000-000000000001"]
    );
    assert.equal(aliasR.rows[0].k, "w04a recruiter");
    const providerR = await db.query(
      "select public.direct_entry_reporting_recruiter_provider_key($1::uuid, '2026-10-17'::date) as k",
      ["93000000-0000-4000-8000-000000000001"]
    );
    assert.equal(providerR.rows[0].k, "hrp");
  } finally {
    await resetRole(db);
    await db.close();
  }
});

test("R1 service-role execution: service_role cannot SELECT raw Direct Entry tables", async () => {
  // Direct Entry tables intentionally have no SELECT grant to service_role
  // — the SECURITY DEFINER view/helper path is the only access path. If
  // service_role can read raw direct_entries, the boundary drifted.
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    await setRole(db, "service_role");
    let rawSelectDenied = false;
    try {
      await db.query("select count(*)::bigint as n from public.direct_entries");
    } catch (err) {
      rawSelectDenied = true;
      assert.match(String(err && err.message), /permission denied/i);
    }
    assert.equal(rawSelectDenied, true,
      "service_role must NOT SELECT raw public.direct_entries");

    let rawSubSelectDenied = false;
    try {
      await db.query("select count(*)::bigint as n from public.direct_entry_submissions");
    } catch (err) {
      rawSubSelectDenied = true;
      assert.match(String(err && err.message), /permission denied/i);
    }
    assert.equal(rawSubSelectDenied, true,
      "service_role must NOT SELECT raw public.direct_entry_submissions");

    // Sanity: legacy aggregate table stays readable by service_role.
    const legacy = await db.query(
      "select count(*)::bigint as n from public.daily_recruitment_breakdown"
    );
    assert.equal(Number.isFinite(Number(legacy.rows[0].n)), true);
  } finally {
    await resetRole(db);
    await db.close();
  }
});

test("R1 service-role execution: anon / authenticated cannot SELECT views or EXECUTE helpers", async () => {
  // Service-role-only contract: anon / authenticated get DENIED at the
  // actual query/function boundary (not just has_*_privilege).
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    const entryId = await createEntry(db, "2026-10-17", "hrp-2026-101704");
    const submissionRes = await db.query(
      "select submission_id from public.direct_entries where entry_id = $1",
      [entryId]
    );
    await submitSubmission(db, submissionRes.rows[0].submission_id);

    for (const role of ["anon", "authenticated"]) {
      await setRole(db, role);

      // SELECT view must throw.
      let viewDenied = false;
      try {
        await db.query(
          "select count(*)::bigint as n from public.direct_entry_reporting_facts_v01"
        );
      } catch (err) {
        viewDenied = true;
        assert.match(String(err && err.message), /permission denied/i);
      }
      assert.equal(viewDenied, true, role + " must NOT SELECT direct_entry_reporting_facts_v01");

      let dimDenied = false;
      try {
        await db.query(
          "select count(*)::bigint as n from public.direct_entry_reporting_dimension_options_v01"
        );
      } catch (err) {
        dimDenied = true;
        assert.match(String(err && err.message), /permission denied/i);
      }
      assert.equal(dimDenied, true, role + " must NOT SELECT direct_entry_reporting_dimension_options_v01");

      // EXECUTE table-reading helper must throw.
      let rpcDenied = false;
      try {
        await db.query(
          "select public.direct_entry_reporting_pre_cutover_blocker_count() as c"
        );
      } catch (err) {
        rpcDenied = true;
        assert.match(String(err && err.message), /permission denied/i);
      }
      assert.equal(rpcDenied, true, role + " must NOT EXECUTE pre_cutover_blocker_count");

      let reconDenied = false;
      try {
        await db.query(
          "select * from public.direct_entry_reporting_reconciliation_totals()"
        );
      } catch (err) {
        reconDenied = true;
        assert.match(String(err && err.message), /permission denied/i);
      }
      assert.equal(reconDenied, true, role + " must NOT EXECUTE reconciliation_totals");

      // EXECUTE alias_key helper must throw.
      let aliasDenied = false;
      try {
        await db.query(
          "select public.direct_entry_reporting_recruiter_alias_key(" +
            "'93000000-0000-4000-8000-000000000001'::uuid, '2026-10-17'::date) as k"
        );
      } catch (err) {
        aliasDenied = true;
        assert.match(String(err && err.message), /permission denied/i);
      }
      assert.equal(aliasDenied, true, role + " must NOT EXECUTE recruiter_alias_key");
    }
  } finally {
    await resetRole(db);
    await db.close();
  }
});

// =============================================================================
// T0 R1 — Direct Entry pagination tie-breaker regression.
//
// Two eligible DE entries sharing the full ReportingFact grain (same
// business_date / project_key / recruiter_key / provider_type_key /
// employment_type_key, distinct entry_id) MUST paginate deterministically.
// Without an entry_id tie-breaker, ORDER BY REPORTING_FACT_ORDER alone
// lets PostgreSQL return same-grain rows in arbitrary order; page
// boundaries could collapse / duplicate rows.
// =============================================================================

test("R1 DE pagination tie-breaker: same-grain entries do not collapse under ORDER BY grain + entry_id", async () => {
  const { db } = await buildDb();
  try {
    await seedFixture(db);
    // Three DE entries: 2 same-grain on 2026-10-17 (distinct entry_ids) +
    // 1 different-grain on 2026-10-18.
    const e1 = await createEntry(db, "2026-10-17", "hrp-2026-101705");
    const e2 = await createEntry(db, "2026-10-17", "hrp-2026-101706");
    const e3 = await createEntry(db, "2026-10-18", "hrp-2026-101707");

    const submissionRes = await db.query(
      "select submission_id, entry_id from public.direct_entries where entry_id = any($1::uuid[])",
      [[e1, e2, e3]]
    );
    for (const row of submissionRes.rows) {
      await submitSubmission(db, row.submission_id);
    }

    await setRole(db, "service_role");

    // Total row count is 3 (2 same-grain + 1 different grain).
    const countRes = await db.query(
      "select count(*)::bigint as n from public.direct_entry_reporting_facts_v01"
    );
    assert.equal(Number(countRes.rows[0].n), 3);

    // ORDER BY grain + entry_id MUST return all 3 rows with deterministic
    // entry_id order at page boundaries. Use OFFSET 0 LIMIT 1 to simulate
    // a single-row page (worst-case boundary).
    const page1 = await db.query(
      "select entry_id::text from public.direct_entry_reporting_facts_v01" +
      " order by business_date, project_key, recruiter_key, provider_type_key," +
      " employment_type_key, entry_id offset 0 limit 1"
    );
    const page2 = await db.query(
      "select entry_id::text from public.direct_entry_reporting_facts_v01" +
      " order by business_date, project_key, recruiter_key, provider_type_key," +
      " employment_type_key, entry_id offset 1 limit 1"
    );
    const page3 = await db.query(
      "select entry_id::text from public.direct_entry_reporting_facts_v01" +
      " order by business_date, project_key, recruiter_key, provider_type_key," +
      " employment_type_key, entry_id offset 2 limit 1"
    );
    const entryIds = [page1.rows[0].entry_id, page2.rows[0].entry_id, page3.rows[0].entry_id];
    // All three must be distinct (no collapse).
    assert.equal(new Set(entryIds).size, 3, "same-grain DE entries must not collapse");

    // The first 2 rows share business_date=2026-10-17 + same grain; their
    // entry_ids MUST be in ascending order (entry_id tie-breaker is
    // deterministic).
    const sameGrain = entryIds.slice(0, 2).sort();
    assert.deepEqual(entryIds.slice(0, 2), sameGrain,
      "entry_id tie-breaker must sort deterministically for same-grain rows");

    // The third row is a different business_date; verify it lands at
    // offset 2 (i.e. the grain + entry_id ORDER BY does not lose it).
    assert.notEqual(page3.rows[0].entry_id, page1.rows[0].entry_id);
    assert.notEqual(page3.rows[0].entry_id, page2.rows[0].entry_id);
  } finally {
    await db.close();
  }
});

test("R1 DE pagination tie-breaker: view ORDER BY includes entry_id as the last key", async () => {
  // Pin the view's ORDER BY clause to grain + entry_id so a future
  // migration cannot regress it silently. The view references columns
  // by their table-qualified names (e.first_work_date, e.entry_id) so
  // pg_get_viewdef preserves them verbatim — match against those names
  // instead of SELECT aliases.
  const { db } = await buildDb();
  try {
    const res = await db.query(
      "select pg_get_viewdef('public.direct_entry_reporting_facts_v01'::regclass, true) as v"
    );
    const def = String(res.rows[0].v);
    assert.match(def, /entry_id/i,
      "view definition must reference entry_id in its ORDER BY clause");
    const grainMatch = def.match(/order by[\s\S]+/i);
    assert.ok(grainMatch, "view must have an ORDER BY clause");
    const orderClause = grainMatch[0].toLowerCase();
    // View ORDER BY uses table-qualified names: e.first_work_date, e.entry_id.
    const businessDatePos = orderClause.indexOf("e.first_work_date");
    const entryIdPos = orderClause.indexOf("e.entry_id");
    assert.ok(businessDatePos >= 0 && entryIdPos >= 0,
      "view ORDER BY must include e.first_work_date and e.entry_id");
    assert.ok(entryIdPos > businessDatePos,
      "e.entry_id tie-breaker must come AFTER e.first_work_date in ORDER BY");
    // The view must NOT use `with (security_invoker = true)` — default false.
    assert.equal(/security_invoker\s*=\s*true/.test(def), false,
      "view must run as owner (security_invoker must NOT be true)");
  } finally {
    await db.close();
  }
});

test("R1 reconcile reads cutoff as date text without host-timezone conversion", async () => {
  const source = await readFile("scripts/p2-w04a-reconcile.mjs", "utf8");
  assert.match(source, /cutoff_date::text as cutoff_date/,
    "reconcile must preserve the PostgreSQL date wire value as YYYY-MM-DD text");
  assert.doesNotMatch(source, /totals\.cutoff_date\.toISOString/,
    "reconcile must not convert the cutoff through a host-local JavaScript Date");
  // P2-W04B rebaseline removed the locked W01-R1 fingerprint contract
  // (the pre-purge baseline was retired). The new reconcile script must
  // still read the legacy aggregate via the SQL cutoff function, must
  // assert the locked 2026-09-30 cutoff, and must run inside a read-only
  // transaction that is always rolled back.
  assert.match(source, /2026-09-30/,
    "reconcile must reference the locked P2-W04C cutoff 2026-09-30");
  assert.match(source, /begin read only/,
    "reconcile must open a read-only transaction");
  assert.match(source, /rollback/,
    "reconcile must roll back the transaction");
  assert.match(source, /public\.direct_entry_reporting_cutoff\(\)/,
    "reconcile must rely on the SQL cutoff function for the legacy mask");
  assert.doesNotMatch(source, /EXPECTED_FINGERPRINT/,
    "reconcile must no longer hard-code a historical fingerprint");
  assert.doesNotMatch(source, /EXPECTED_LEGACY_ROWS/,
    "reconcile must no longer hard-code a historical legacy row count");
});
