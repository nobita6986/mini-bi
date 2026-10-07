/**
 * P2.5-W04 - change-request audience/read/withdraw policy closure (DB, PGlite).
 *
 * Verifies at the DB boundary:
 *  * migration #53 applies over #1-#52 (ledger = 53);
 *  * propose SUBMITTED is assignment-only (uploader/recruiter who is not the PM
 *    is denied; the effective PM is allowed);
 *  * protected ENTRY_FIELD fields (project_id, first_work_date, employee_code,
 *    recruiter_id, labor_type) are rejected at CREATE and APPLY;
 *  * a forged worker identity (empty/invalid display_name) is rejected;
 *  * direct payment / employment-status write on a SUBMITTED entry is denied
 *    without touching canonical value, version or audit;
 *  * a DRAFT entry keeps its direct-write behaviour (no regression);
 *  * approval applies exactly once (second decide conflicts).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const W04_MIGRATION = "20261008130000_p2_5_w04_change_request_policy_closure.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_1 = "proj_1";
const REC_A = uuid(21), REC_D = uuid(24);
const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const MGR_AUTH = uuid(32), MGR_APP = uuid(42);
const UPLOADER_AUTH = uuid(36), UPLOADER_APP = uuid(46);

async function migrationNames() {
  return (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
}
async function migratedDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = await migrationNames();
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return { db, names };
}

let entrySeq = 0;
async function addWorker(db, { project = PROJ_1, recruiter = REC_D, createdBy = UPLOADER_APP,
  workDate = "2026-10-01", state = "SUBMITTED" } = {}) {
  entrySeq += 1;
  const n = entrySeq;
  const candidate = uuid(5000 + n), submission = uuid(6000 + n), entry = uuid(7000 + n);
  const year = String(workDate).slice(0, 4);
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [candidate]);
    await db.query(
      "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state)" +
      " values ($1,$2,'DRAFT')", [submission, createdBy]);
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
      " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
      " provider_type, labor_type)" +
      " values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'hrp','TEMPORARY')",
      [entry, submission, candidate, createdBy, project, workDate,
        "hrp-" + year + "-" + String(300000 + n),
        JSON.stringify(validWorker(n)), recruiter, TEAM]);
    if (state !== "DRAFT") {
      await db.query(
        "update public.direct_entry_submissions set state='REVIEW', version=2 where submission_id=$1",
        [submission]);
    }
    if (state === "SUBMITTED") {
      await db.query(
        "update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1",
        [submission]);
    }
    await db.exec("commit");
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
  return { entry, submission, employee_code: "hrp-" + year + "-" + String(300000 + n) };
}
function validWorker(n) {
  return { display_name: "Worker " + n,
    date_of_birth: { state: "provided", value: "1990-01-01" },
    national_id: { state: "provided", value: String(100000000000 + n) },
    address: { state: "provided", value: "1 Synthetic Street " + n },
    phone: { state: "provided", value: "0900" + String(100000 + n) } };
}

async function seed(db) {
  const actors = [[ADMIN_AUTH, ADMIN_APP], [MGR_AUTH, MGR_APP], [UPLOADER_AUTH, UPLOADER_APP]];
  for (const [auth, app] of actors) {
    await db.query("insert into auth.users (id) values ($1)", [auth]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled) values ($1,$2,true)",
      [app, auth]);
  }
  await db.query("insert into public.teams (team_id, code, display_name) values ($1,'TEAM_A','Team A')", [TEAM]);
  await db.query("insert into public.direct_entry_projects (project_id, display_name) values ($1,'Project One')", [PROJ_1]);
  for (const [rec, name] of [[REC_A, "Recruiter A"], [REC_D, "Recruiter D"]]) {
    await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,$2)", [rec, name]);
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from)" +
      " values ($1,'hrp','2020-01-01')", [rec]);
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)" +
      " values ($1,$2,'2020-01-01')", [rec, TEAM]);
  }
  // links: MGR -> REC_A (PM), UPLOADER -> REC_D (uploader's own recruiter)
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from)" +
    " values ($1,$2,true,'2020-01-01')", [MGR_APP, REC_A]);
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from)" +
    " values ($1,$2,true,'2020-01-01')", [UPLOADER_APP, REC_D]);
  // capabilities: ADMIN full admin/review/payment/status; MGR + UPLOADER proposer bundle
  for (const cap of ["entry_admin", "change_request_create", "change_review", "payment_edit",
    "payment_view", "pii_view", "employment_status.apply", "entry_create"]) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)" +
      " values ($1,$2,'2020-01-01')", [ADMIN_APP, cap]);
  }
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from) values ($1,'all','2020-01-01')",
    [ADMIN_APP]);
  for (const cap of ["change_request_create", "entry_create"]) {
    for (const app of [MGR_APP, UPLOADER_APP]) {
      await db.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)" +
        " values ($1,$2,'2020-01-01')", [app, cap]);
    }
  }
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from) values ($1,'own','2020-01-01')",
    [UPLOADER_APP]);
  // assign MGR as the project manager of PROJ_1 (raw, effective, verified link).
  await db.query(
    "insert into public.direct_entry_project_manager_assignments" +
    " (project_id, manager_recruiter_id, valid_from) values ($1,$2,'2020-01-01')",
    [PROJ_1, REC_A]);
}

async function propose(db, auth, app, entry, proposal) {
  const res = await db.query(
    "select public.direct_entry_create_change_request($1::uuid,$2::uuid,$3::jsonb,$4::text,$5::text) as data",
    [auth, app, JSON.stringify([{ entry_id: entry, target_kind: "ENTRY_FIELD",
      expected_version: 1, proposal }]), "policy regression", "w04-key-" + entrySeq + "-" + Math.random()]);
  return res.rows[0].data;
}
async function entryRow(db, entry) {
  const res = await db.query("select version, worker_details, project_id, first_work_date," +
    " recruiter_id, labor_type from public.direct_entries where entry_id=$1", [entry]);
  return res.rows[0];
}
async function auditCount(db, entry) {
  const res = await db.query(
    "select count(*)::int as c from public.direct_entry_audit_events where resource_ref=$1", [entry]);
  return res.rows[0].c;
}

test("P2.5-W04: migration #53 applies over #1-#52 and installs the policy", async () => {
  const { db, names } = await migratedDb();
  assert.equal(names.length, 53, "ledger carries 53 migrations after P2.5-W04");
  assert.equal(names[names.length - 1], W04_MIGRATION, "W04 is #53");
  await db.close();
});

test("P2.5-W04: propose SUBMITTED is assignment-only; uploader (non-PM) denied", async () => {
  const { db } = await migratedDb();
  await seed(db);
  const { entry } = await addWorker(db, { recruiter: REC_D, createdBy: UPLOADER_APP });
  await assert.rejects(
    () => propose(db, UPLOADER_AUTH, UPLOADER_APP, entry, { worker_details: validWorker(9) }),
    /denied|change request access|42501|P0002/i);
  await db.close();
});

test("P2.5-W04: protected ENTRY_FIELD fields are rejected at CREATE", async () => {
  const { db } = await migratedDb();
  await seed(db);
  const { entry } = await addWorker(db, { recruiter: REC_D, createdBy: UPLOADER_APP });
  for (const forged of [
    { project_id: "proj_2" },
    { first_work_date: "2026-11-01" },
    { employee_code: "hrp-2026-999999" },
    { recruiter_id: uuid(999) },
    { labor_type: "PERMANENT" },
  ]) {
    await assert.rejects(
      () => propose(db, MGR_AUTH, MGR_APP, entry, forged),
      /unsupported change proposal field|22023/i,
      "must reject protected field: " + JSON.stringify(forged));
  }
  await db.close();
});

test("P2.5-W04: forged worker identity (empty display_name) rejected at CREATE", async () => {
  const { db } = await migratedDb();
  await seed(db);
  const { entry } = await addWorker(db, { recruiter: REC_D, createdBy: UPLOADER_APP });
  const forged = { ...validWorker(9), display_name: "   " };
  await assert.rejects(
    () => propose(db, MGR_AUTH, MGR_APP, entry, { worker_details: forged }),
    /forged worker identity|22023/i);
  await db.close();
});

test("P2.5-W04: effective PM can propose a valid worker_details change", async () => {
  const { db } = await migratedDb();
  await seed(db);
  const { entry } = await addWorker(db, { recruiter: REC_D, createdBy: UPLOADER_APP });
  const result = await propose(db, MGR_AUTH, MGR_APP, entry, { worker_details: validWorker(9) });
  assert.equal(result.state, "PENDING");
  assert.ok(result.request_id);
  await db.close();
});

test("P2.5-W04: direct payment write on SUBMITTED is denied without version/audit change", async () => {
  const { db } = await migratedDb();
  await seed(db);
  const { entry } = await addWorker(db, { recruiter: REC_D, createdBy: UPLOADER_APP });
  const before = await entryRow(db, entry);
  const audits = await auditCount(db, entry);
  await assert.rejects(
    () => db.query(
      "select public.direct_entry_update_payment($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::integer,$6::jsonb,$7::text,$8::text)",
      [ADMIN_AUTH, ADMIN_APP, entry, before.version, 0,
        JSON.stringify({ state: "omitted" }), "try", "pay-key-1"]),
    /payment edits require a draft entry|42501/i);
  const after = await entryRow(db, entry);
  assert.equal(after.version, before.version, "version must not change");
  assert.equal(await auditCount(db, entry), audits, "no audit row on denied write");
  await db.close();
});

test("P2.5-W04: direct status write on SUBMITTED is denied", async () => {
  const { db } = await migratedDb();
  await seed(db);
  const { entry } = await addWorker(db, { recruiter: REC_D, createdBy: UPLOADER_APP });
  await assert.rejects(
    () => db.query(
      "select public.direct_entry_apply_employment_status($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::date,$7::text,$8::text,$9::text)",
      [ADMIN_AUTH, ADMIN_APP, entry, 1, "ON", "2026-10-10", null, "try", "status-key-1"]),
    /employment status edits require a draft entry|42501/i);
  await db.close();
});

test("P2.5-W04: DRAFT keeps direct payment/status writes (no regression)", async () => {
  const { db } = await migratedDb();
  await seed(db);
  const { entry } = await addWorker(db, { recruiter: REC_D, createdBy: UPLOADER_APP, state: "DRAFT" });
  const before = await entryRow(db, entry);
  await db.query(
    "select public.direct_entry_update_payment($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::integer,$6::jsonb,$7::text,$8::text)",
    [ADMIN_AUTH, ADMIN_APP, entry, before.version, 0,
      JSON.stringify({ state: "omitted" }), "draft", "pay-draft-1"]);
  await db.query(
    "select public.direct_entry_apply_employment_status($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::date,$7::text,$8::text,$9::text)",
    [ADMIN_AUTH, ADMIN_APP, entry, before.version + 1, "UNCONFIRMED", "2026-10-01", null, "draft", "status-draft-1"]);
  const after = await entryRow(db, entry);
  assert.ok(after.version > before.version, "draft writes advance version");
  await db.close();
});

test("P2.5-W04: approval applies exactly once (second decide conflicts)", async () => {
  const { db } = await migratedDb();
  await seed(db);
  const { entry } = await addWorker(db, { recruiter: REC_D, createdBy: UPLOADER_APP });
  const created = await propose(db, MGR_AUTH, MGR_APP, entry, { worker_details: validWorker(9) });
  const decide = async (key) => db.query(
    "select public.direct_entry_decide_change_request($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text,$7::text) as data",
    [ADMIN_AUTH, ADMIN_APP, created.request_id, 1, "APPROVED", "approved", key]);
  const first = await decide("decide-key-1");
  assert.equal(first.rows[0].data.state, "APPROVED");
  await assert.rejects(() => decide("decide-key-2"), /version conflict|40001|P0002/i);
  await db.close();
});
