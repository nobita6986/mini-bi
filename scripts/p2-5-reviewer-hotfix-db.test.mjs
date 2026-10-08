/**
 * P2.5 reviewer/accounting hotfix - root cause regression (PGlite over #1-#56).
 *
 * FINDING 1 root cause: the minimal reviewer bundle (change_review + pii_view +
 * payment_view + effective all scope, NO entry_admin) CAN read the change-request
 * detail and CAN decide, but CANNOT read the SUBMITTED entry projection that the
 * reviewer drawer needs for the BEFORE values. The entry read is gated by
 * draft scope (entry_own/entry_team/entry_admin) or an effective PM assignment,
 * so a reviewer falls through to 42501 -> the drawer shows the generic
 * "Yeu cau nay can phien ban giao dien hoac quyen xem khac." message.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) { return "00000000-0000-4000-8000-" + String(n).padStart(12, "0"); }
const TEAM = uuid(11);
const PROJ_A = "proj_rv_a";
const REC_PM = uuid(21);
const UPLOADER_AUTH = uuid(31), UPLOADER_APP = uuid(41);
const PM_AUTH = uuid(32), PM_APP = uuid(42);
const ADMIN_AUTH = uuid(33), ADMIN_APP = uuid(43);
const REV_AUTH = uuid(39), REV_APP = uuid(49);

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
  for (const name of names) await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  return db;
}

async function insertActor(db, auth, app, capabilities, scopeKind = null) {
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name) values ($1,$2,true,'Synthetic Account')",
    [app, auth]);
  for (const capability of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)" +
      " values ($1,$2,'2020-01-01')", [app, capability]);
  }
  if (scopeKind !== null) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from)" +
      " values ($1,$2,'2020-01-01')", [app, scopeKind]);
  }
}

async function seed(db) {
  await db.query("insert into public.teams (team_id, code, display_name) values ($1,'TEAM_RV','Team RV')", [TEAM]);
  await db.query("insert into public.direct_entry_projects (project_id, display_name) values ($1,'Project RV')", [PROJ_A]);
  await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter PM')", [REC_PM]);
  await db.query("insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from) values ($1,'hrp','2020-01-01')", [REC_PM]);
  await db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from) values ($1,$2,'2020-01-01')", [REC_PM, TEAM]);
  await insertActor(db, UPLOADER_AUTH, UPLOADER_APP, ["entry_create", "submission_create", "entry_own", "change_request_create"], "own");
  await insertActor(db, PM_AUTH, PM_APP, ["entry_create", "change_request_create"], null);
  await insertActor(db, ADMIN_AUTH, ADMIN_APP, ["entry_admin", "change_review", "pii_view", "payment_view"], "all");
  // Exactly the reviewer bundle in Production (lienvu / ngattt): NO entry_admin.
  await insertActor(db, REV_AUTH, REV_APP, ["change_review", "pii_view", "payment_view"], "all");
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from)" +
    " values ($1,$2,true,'2020-01-01')", [PM_APP, REC_PM]);
  await db.query(
    "select public.direct_entry_assign_project_manager($1::uuid,$2::uuid,$3::text,$4::uuid,$5::date,$6::integer,$7::text,$8::text)",
    [ADMIN_AUTH, ADMIN_APP, PROJ_A, REC_PM, null, 1, "synthetic assignment", "rv-assign"]);
}

let seq = 0;
async function addSubmittedEntry(db) {
  seq += 1; const n = seq;
  const candidate = uuid(5000 + n), submission = uuid(6000 + n), entry = uuid(7000 + n);
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [candidate]);
    await db.query("insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1,$2,'DRAFT')", [submission, UPLOADER_APP]);
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
      " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
      " provider_type, labor_type) values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'hrp','TEMPORARY')",
      [entry, submission, candidate, UPLOADER_APP, PROJ_A, "2026-10-01",
        "hrp-2026-" + String(300000 + n),
        JSON.stringify({ display_name: "RV Worker " + n,
          date_of_birth: { state: "unknown" }, national_id: { state: "unknown" },
          address: { state: "provided", value: "RV address " + n }, phone: { state: "unknown" } }),
        REC_PM, TEAM]);
    await db.query("update public.direct_entry_submissions set state='REVIEW', version=2 where submission_id=$1", [submission]);
    await db.query("update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1", [submission]);
    // Initial employment status event (UNCONFIRMED at first_work_date).
    const reason = await db.query(
      "select public.direct_entry_reason($1::uuid,$2::text) as reason_id",
      [UPLOADER_APP, "synthetic initial status"]);
    await db.query(
      "insert into public.direct_entry_employment_status_events" +
      " (entry_id, status, effective_date, version, actor_user_id, reason_id)" +
      " values ($1,'UNCONFIRMED','2026-10-01',1,$2,$3)",
      [entry, UPLOADER_APP, reason.rows[0].reason_id]);
    await db.exec("commit");
  } catch (error) { await db.exec("rollback"); throw error; }
  return { entry, submission };
}

async function proposeWorkStatus(db, entry, key) {
  const res = await db.query(
    "select public.direct_entry_create_change_request($1::uuid,$2::uuid,$3::jsonb,$4::text,$5::text) as data",
    [PM_AUTH, PM_APP, JSON.stringify([{ entry_id: entry, target_kind: "WORK_STATUS",
      expected_version: 1, proposal: { status: "ON", effective_date: "2026-10-02" } }]),
      "synthetic status request", key]);
  return res.rows[0].data;
}

async function readProjection(db, auth, app, entry) {
  return db.query("select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as data",
    [auth, app, entry]);
}

test("reviewer bundle CAN read the change-request detail and the decision path", async () => {
  const db = await buildDb();
  await seed(db);
  const { entry } = await addSubmittedEntry(db);
  const request = await proposeWorkStatus(db, entry, "rv-status-1");
  assert.equal(request.state, "PENDING");
  const detail = await db.query(
    "select public.direct_entry_read_change_request($1::uuid,$2::uuid,$3::uuid) as data",
    [REV_AUTH, REV_APP, request.request_id]);
  assert.equal(detail.rows[0].data.state, "PENDING");
  assert.equal(detail.rows[0].data.can_decide, true, "reviewer bundle quyet dinh duoc");
  // WORK_STATUS needs change_review only (W05-R1) — no employment_status.apply.
  const decided = await db.query(
    "select public.direct_entry_decide_change_request($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text,$7::text) as data",
    [REV_AUTH, REV_APP, request.request_id, 1, "APPROVED", "synthetic approval", "rv-decide-1"]);
  assert.equal(decided.rows[0].data.state, "APPROVED");
  await db.close();
});

test("ROOT CAUSE: reviewer bundle CANNOT read the SUBMITTED entry projection (42501)", async () => {
  const db = await buildDb();
  await seed(db);
  const { entry } = await addSubmittedEntry(db);
  // The reviewer drawer reads this endpoint for the BEFORE values.
  await assert.rejects(
    () => readProjection(db, REV_AUTH, REV_APP, entry),
    /entry scope.capability denied/,
    // SQLSTATE 42501 -> "entry scope/capability denied"
    "reviewer thieu entry_admin bi tu choi doc SUBMITTED entry");
  // entry_admin + all IS the audience that unlocks the read today.
  const admin = await readProjection(db, ADMIN_AUTH, ADMIN_APP, entry);
  assert.ok(admin.rows[0].data, "entry_admin + all doc duoc");
  await db.close();
});

test("ROOT CAUSE: same denial for worker_details and PAYMENT review reads", async () => {
  const db = await buildDb();
  await seed(db);
  const { entry } = await addSubmittedEntry(db);
  await assert.rejects(() => readProjection(db, REV_AUTH, REV_APP, entry),
    /entry scope.capability denied/,
    "chi mot duong doc DUY NHAT bi chan cho moi target kind");
  await db.close();
});
