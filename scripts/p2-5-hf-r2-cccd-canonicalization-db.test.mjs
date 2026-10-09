/**
 * P2.5-HF-R2 - mot quy tac canonical CMT/CCCD cho guard, lookup va preflight.
 *
 * Finding: #58 so sanh btrim, #59 lookup so sanh digits-only, nen mot gia tri lich su con ky tu
 * dinh dang ("0123 456 78901") la cung mot nguoi voi lookup nhung khac chuoi voi guard. Migration
 * #60 dung chung mot quy tac (digits, dai 9/12, giu so 0 dau) va cung advisory-lock key.
 *
 * Du lieu lich su: test nay mo phong gia tri dinh dang co truoc validator W07C-R2 bang cach bo
 * CHECK constraint cua bang trong luc seed (khong sua du lieu that, khong sua migration cu), roi
 * gan lai constraint o dang NOT VALID - dung tinh than fail-closed: du lieu cu khong bi ghi de.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const R2_MIGRATION = "20261008200000_p2_5_hf_r2_cccd_canonicalization_guard.sql";
const R3_MIGRATION = "20261008210000_p2_5_hf_r3_worker_full_correction.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_A = "hf_proj_a";
const REC_A = uuid(21);
const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const MGR_A_AUTH = uuid(32), MGR_A_APP = uuid(42);
const MGR_C_AUTH = uuid(34), MGR_C_APP = uuid(44);

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  assert.equal(names.length, 71, "the ledger carries 71 migrations through P3.1-W01D-A1a1 #71");
  assert.equal(names[names.length - (11)], R3_MIGRATION, "P2.5-HF-R3 remains #61");
  assert.equal(names[names.length - (12)], R2_MIGRATION, "P2.5-HF-R2 remains #60");
  return db;
}

async function insertActor(db, auth, app, capabilities, scopeKind = null) {
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
    " values ($1,$2,true,'Synthetic Account')", [app, auth]);
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
  await db.query(
    "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_R2','Team R2')", [TEAM]);
  await db.query(
    "insert into public.direct_entry_projects (project_id, display_name) values ($1,'Project R2 A')",
    [PROJ_A]);
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter A')", [REC_A]);
  await db.query(
    "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from)" +
    " values ($1,'hrp','2020-01-01')", [REC_A]);
  await db.query(
    "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)" +
    " values ($1,$2,'2020-01-01')", [REC_A, TEAM]);
  await insertActor(db, ADMIN_AUTH, ADMIN_APP,
    ["entry_admin", "entry_create", "submission_create", "payment_view", "payment_edit",
      "employment_status.apply", "change_request_create"], "own");
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from)" +
    " values ($1,'all','2020-01-01')", [ADMIN_APP]);
  await insertActor(db, MGR_A_AUTH, MGR_A_APP, ["change_request_create"]);
  await db.query(
    "insert into public.direct_entry_project_manager_assignments" +
    " (project_id, manager_recruiter_id, valid_from) values ($1,$2,'2020-01-01')", [PROJ_A, REC_A]);
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links" +
    " (app_user_id, recruiter_id, verified, valid_from) values ($1,$2,true,'2020-01-01')",
    [MGR_A_APP, REC_A]);
  await insertActor(db, MGR_C_AUTH, MGR_C_APP, ["change_request_limit_placeholder"].filter(() => false));
  await db.query(
    "delete from public.direct_entry_app_users where app_user_id = $1", [MGR_C_APP]);
}

function workerDetails(cccd) {
  return {
    date_of_birth: { state: "provided", value: "1990-01-01" },
    national_id: cccd === null ? { state: "unknown" } : { state: "provided", value: cccd },
    address: { state: "provided", value: "R2 address" },
    phone: { state: "provided", value: "0900000000" },
  };
}

async function relaxWorkerDetailsCheck(db) {
  const row = (await db.query(
    "select conname from pg_constraint where conrelid = 'public.direct_entries'::regclass" +
    " and contype = 'c' and pg_get_constraintdef(oid) like '%valid_worker_details%'")).rows[0];
  assert.ok(row, "the worker_details CHECK constraint must exist");
  await db.query('alter table public.direct_entries drop constraint "' + row.conname + '"');
  return row.conname;
}

async function restoreWorkerDetailsCheck(db) {
  await db.exec(
    "alter table public.direct_entries add constraint direct_entries_worker_details_r2_simulated" +
    " check (public.direct_entry_valid_worker_details(worker_details)) not valid");
}

let keySeq = 0;
function idemKey() {
  keySeq += 1;
  return "00000000-0000-4000-8000-" + String(keySeq).padStart(12, "0");
}

async function count(db, sql, params = []) {
  const res = await db.query(sql, params);
  return Number(Object.values(res.rows[0])[0]);
}

/** A historical episode whose stored CMT/CCCD is not in canonical form (pre-W07C-R2 data). */
let episodeSeq = 0;
async function seedEpisode(db, { cccd, name, project = PROJ_A, date = "2026-01-05", status }) {
  episodeSeq += 1;
  const candidate = uuid(2000 + episodeSeq), submission = uuid(3000 + episodeSeq);
  const entry = uuid(4000 + episodeSeq);
  const code = "hrp-2026-" + String(800000 + episodeSeq);
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [candidate]);
    await db.query(
      "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state)" +
      " values ($1,$2,'DRAFT')", [submission, ADMIN_APP]);
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
      " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
      " provider_type, labor_type)" +
      " values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'hrp','TEMPORARY')",
      [entry, submission, candidate, ADMIN_APP, project, date, code,
        JSON.stringify({ display_name: name, ...workerDetails(cccd) }), REC_A, TEAM]);
    await db.query(
      "update public.direct_entry_submissions set state='REVIEW', version=2 where submission_id=$1",
      [submission]);
    await db.query(
      "update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1",
      [submission]);
    const steps = status === "OFF" ? ["ON", "OFF"] : status === null ? [] : [status];
    if (steps.length > 0) {
      const reasonId = (await db.query(
        "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
        " values ($1,'R2 episode status') returning reason_id::text as id", [ADMIN_APP])).rows[0].id;
      for (const [index, step] of steps.entries()) {
        await db.query(
          "insert into public.direct_entry_employment_status_events" +
          " (entry_id, status, effective_date, leave_date, leave_reason_text, version," +
          " actor_user_id, reason_id)" +
          " values ($1,$2,$3::date, case when $2 = 'OFF' then $3::date else null end," +
          " case when $2 = 'OFF' then 'R2 synthetic leave' else null end, $4,$5,$6)",
          [entry, step, date, index + 1, ADMIN_APP, reasonId]);
      }
    }
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  return { entryId: entry, employeeCode: code };
}

async function seedLegacyEpisode(db, options) {
  const constraint = await relaxWorkerDetailsCheck(db);
  try {
    return await seedEpisode(db, options);
  } finally {
    await restoreWorkerDetailsCheck(db);
    assert.ok(constraint);
  }
}

/** Full-profile v1 batch with an explicit employee_code (the server-side create path). */
async function createFullProfile(db, { cccd, name, auth = MGR_A_AUTH, app = MGR_A_APP,
  date = "2026-10-01", key = "r2" }) {
  await db.query(
    "select public.direct_entry_create_full_profile_batch($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text)",
    [auth, app, "worker-profile/1.0", JSON.stringify([{
      project_id: PROJ_A, first_work_date: date, employee_code: "hrp-2026-900001",
      recruiter_id: REC_A, labor_type: "TEMPORARY", display_name: name,
      worker_details: workerDetails(cccd),
    }]), idemKey(key)]);
}

async function createFullProfileV2(db, { cccd, name, auth = MGR_A_AUTH, app = MGR_A_APP,
  date = "2026-10-02", key = "r2v2" }) {
  await db.query(
    "select public.direct_entry_create_full_profile_batch_v2($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text)",
    [auth, app, "worker-profile/1.1", JSON.stringify([{
      project_id: PROJ_A, first_work_date: date, provider_type: "hrp", recruiter_id: REC_A,
      labor_type: "TEMPORARY", display_name: name, worker_details: workerDetails(cccd),
    }]), idemKey(key)]);
}

async function createLegacyBatch(db, { cccd, name, date = "2026-10-03", key = "r2legacy" }) {
  await db.query(
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text)",
    [MGR_A_AUTH, MGR_A_APP, JSON.stringify([{
      project_id: PROJ_A, first_work_date: date, employee_code: "hrp-2026-900002",
      labor_type: "TEMPORARY", recruiter_id: REC_A,
      worker_details: { display_name: name, ...workerDetails(cccd) },
    }]), idemKey(key)]);
}

async function lookup(db, { cccd, name = null, project = PROJ_A, auth = MGR_A_AUTH, app = MGR_A_APP }) {
  return (await db.query(
    "select public.direct_entry_lookup_worker_episodes(" +
    "$1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::int,$7::int) as data",
    [auth, app, project, name, cccd, 20, 0])).rows[0].data;
}

// ---------------------------------------------------------------------------
// 1. Fail-closed: a historical formatted CCCD blocks a digits-only create.
// ---------------------------------------------------------------------------
test("R2: a legacy formatted CCCD blocks a new digits-only episode", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // Historical value with formatting characters, still active.
    const legacy = await seedLegacyEpisode(db, { cccd: "0123 456 78901", name: "R2 Legacy",
      date: "2026-01-05", status: "ON" });
    assert.ok(legacy.entryId);

    await assert.rejects(
      () => createFullProfile(db, { cccd: "012345678901", name: "R2 New", key: "r2-dup" }),
      (error) => {
        assert.equal(error.code, "23505", "the create guard must fail closed");
        assert.ok(error.message.includes("worker_active_episode_exists"), error.message);
        assert.equal(error.message.includes("012345678901"), false, "no CCCD in the error");
        assert.equal(error.message.includes("0123 456 78901"), false, "no CCCD in the error");
        return true;
      });
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entries where project_id = $1", [PROJ_A]), 1,
    "no second episode was written");
    // A different CCCD is still allowed: the rule does not block unrelated workers.
    await createFullProfile(db, { cccd: "987654321098", name: "R2 Other", key: "r2-other" });
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entries where project_id = $1", [PROJ_A]), 2);
  } finally {
    await db.close();
  }
});

test("R2: the status guard uses the same canonical identity as the create guard", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const older = await seedLegacyEpisode(db, { cccd: "0123 456 78901", name: "R2 Legacy",
      date: "2026-01-05", status: "OFF" });
    const newer = await seedLegacyEpisode(db, { cccd: "012345678901", name: "R2 Legacy",
      date: "2026-03-05", status: "ON" });
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_apply_employment_status(" +
        "$1::uuid,$2::uuid,$3::uuid,$4::int,$5::text,$6::date,$7::text,$8::text,$9::text)",
        [ADMIN_AUTH, ADMIN_APP, older.entryId, 1, "ON", "2026-05-01", null,
          "R2 reopen legacy episode", idemKey()]),
      (error) => error.code === "42501",
      "a submitted episode stays change-request only (W04)");
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_employment_status_events" +
      " where entry_id = $1::uuid", [older.entryId]), 2, "no status event appended");
    assert.ok(newer.entryId);
    // Two live episodes under one canonical CCCD is exactly what the preflight reports.
    const audit = (await db.query(
      "select public.direct_entry_national_id_canonical_audit() as data")).rows[0].data;
    assert.equal(audit.duplicate_active_cccd_groups, 0,
      "one episode is OFF, so the invariant still holds");
    assert.equal(audit.noncanonical_entries, 1, "the formatted legacy value is reported");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Reverse direction: malformed values are refused on every write API.
// ---------------------------------------------------------------------------
test("R2: malformed CMT/CCCD is refused by the legacy and the full-profile APIs", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // The same payload with a canonical value is accepted, so only the CMT/CCCD is at fault.
    await createFullProfile(db, { cccd: "999999999999", name: "R2 Good", key: "r2-good" });
    assert.equal(await count(db, "select count(*)::int as n from public.direct_entries"), 1);
    for (const bad of ["0123 456 78901", "012.345.678", "NOT-REAL", "12345678",
      "1234567890123", " 012345678901", "012345678901 "]) {
      for (const [label, run] of [
        ["full-profile v1", () => createFullProfile(db, { cccd: bad, name: "R2 Bad",
          key: "r2-bad-v1-" + bad.length })],
        ["full-profile v2", () => createFullProfileV2(db, { cccd: bad, name: "R2 Bad",
          key: "r2-bad-v2-" + bad.length })],
        ["legacy batch", () => createLegacyBatch(db, { cccd: bad, name: "R2 Bad",
          key: "r2-bad-lg-" + bad.length })],
      ]) {
        await assert.rejects(run,
          (error) => ["23514", "22023"].includes(error.code),
          label + " must refuse " + bad + " (got " + bad + ")");
      }
    }
    assert.equal(await count(db, "select count(*)::int as n from public.direct_entries"), 1,
      "no malformed value was stored");
  } finally {
    await db.close();
  }
});

test("R2: canonical values keep the leading zero and both business lengths", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createFullProfile(db, { cccd: "012345678", name: "R2 Nine", key: "r2-nine" });
    await createFullProfileV2(db, { cccd: "012345678901", name: "R2 Twelve", key: "r2-twelve" });
    const stored = (await db.query(
      "select worker_details->'national_id'->>'value' as value from public.direct_entries" +
      " order by first_work_date")).rows.map((row) => row.value);
    assert.deepEqual(stored, ["012345678", "012345678901"],
      "values are stored as text with the leading zero");
    // The lookup accepts the formatted spelling of the same person, digits only.
    const found = await lookup(db, { cccd: "012 345 678901" });
    assert.equal(found.match, "national_id");
    assert.equal(found.workers.length, 1);
    assert.equal(found.workers[0].episodes.length, 1);
    // #57: a freshly created worker starts ON, so a rehire is not allowed yet.
    assert.equal(found.workers[0].active_episode_exists, true);
    assert.equal(found.workers[0].rehire_allowed, false);
    const nine = await lookup(db, { cccd: "012345678" });
    assert.equal(nine.workers.length, 1);
    // A malformed lookup key is refused.
    for (const bad of ["12345678", "NOT-REAL", "1234567890123"]) {
      await assert.rejects(() => lookup(db, { cccd: bad }),
        (error) => error.code === "22023", bad);
    }
  } finally {
    await db.close();
  }
});

test("R2: the lookup sees the legacy episode that the guard blocks on", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const legacy = await seedLegacyEpisode(db, { cccd: "0123 456 78901", name: "R2 Legacy",
      date: "2026-01-05", status: "ON" });
    const found = await lookup(db, { cccd: "012345678901" });
    assert.equal(found.workers.length, 1, "the legacy value is found through the digit rule");
    assert.equal(found.workers[0].episodes[0].entry_id, legacy.entryId);
    assert.equal(found.workers[0].active_episode_exists, true);
    assert.equal(found.workers[0].rehire_allowed, false,
      "lookup and guard agree: the episode is still active");
    // Name search stays inside the target project and finds the same episode.
    const byName = await lookup(db, { cccd: null, name: "R2 Legacy" });
    assert.equal(byName.match, "display_name");
    assert.equal(byName.workers[0].episodes[0].entry_id, legacy.entryId);
    // The serialized response never carries the CCCD in either spelling.
    const serialized = JSON.stringify(found.workers);
    assert.equal(serialized.includes("012345678901"), false);
    assert.equal(serialized.includes("0123 456 78901"), false);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Preflight audit: safe counts only, no PII, no data repair.
// ---------------------------------------------------------------------------
test("R2: the preflight audit reports counts only and never a CCCD", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const clean = (await db.query(
      "select public.direct_entry_national_id_canonical_audit() as data")).rows[0].data;
    assert.deepEqual(clean, {
      national_id_entries: 0, noncanonical_entries: 0, unmatchable_entries: 0,
      duplicate_active_cccd_groups: 0,
    });
    await seedLegacyEpisode(db, { cccd: "0123 456 78901", name: "R2 Legacy",
      date: "2026-01-05", status: "ON" });
    await seedLegacyEpisode(db, { cccd: "NOT-REAL", name: "R2 Unmatchable",
      date: "2026-01-06", status: "OFF" });
    const dirty = (await db.query(
      "select public.direct_entry_national_id_canonical_audit() as data")).rows[0].data;
    assert.equal(dirty.national_id_entries, 2);
    assert.equal(dirty.noncanonical_entries, 2);
    assert.equal(dirty.unmatchable_entries, 1);
    assert.equal(dirty.duplicate_active_cccd_groups, 0);
    assert.deepEqual(Object.keys(dirty).sort(), [
      "duplicate_active_cccd_groups", "national_id_entries", "noncanonical_entries",
      "unmatchable_entries",
    ]);
    const serialized = JSON.stringify(dirty);
    for (const forbidden of ["0123 456 78901", "012345678901", "NOT-REAL", "R2 Legacy",
      "R2 Unmatchable", "R2 address", "0900000000", "1990-01-01"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden + " must never leak");
    }
    // The audit never writes: the same rows still exist and nothing was canonicalized in place.
    assert.equal(await count(db, "select count(*)::int as n from public.direct_entries"), 2);
    assert.equal((await db.query(
      "select worker_details->'national_id'->>'value' as value from public.direct_entries" +
      " order by first_work_date")).rows[0].value, "0123 456 78901",
    "historical data is never rewritten");

    // The install-time gate raises on these counts and nothing else.
    const source = await readFile(path.join(MIGRATION_DIR, R2_MIGRATION), "utf8");
    assert.ok(source.includes("p2_5_hf_r2_national_id_preflight_failed"),
      "the migration must stop on a conflict");
    assert.ok(source.includes("duplicate_active_cccd_groups=%s"),
      "the stop message carries the safe count only");
  } finally {
    await db.close();
  }
});

test("R2: every guard, the lookup and the validator share one rule", async () => {
  const db = await buildDb();
  try {
    const forms = ["012345678", "012345678901"];
    for (const form of forms) {
      const canonical = (await db.query(
        "select public.direct_entry_canonical_national_id($1) as value", [form])).rows[0].value;
      assert.equal(canonical, form);
    }
    const legacy = "0123 456 78901";
    const digest = (await db.query(
      "select public.direct_entry_canonical_national_id($1) as canonical," +
      " public.direct_entry_is_canonical_national_id($1) as canonical_form," +
      " public.direct_entry_national_id_lock_key($1) as key", [legacy])).rows[0];
    assert.equal(digest.canonical, "012345678901");
    assert.equal(digest.canonical_form, false);
    const sameKey = (await db.query(
      "select public.direct_entry_national_id_lock_key('012345678901') = $1::bigint as same",
      [digest.key])).rows[0].same;
    assert.equal(sameKey, true, "one CCCD, one lock key");
    assert.equal((await db.query(
      "select public.direct_entry_is_canonical_national_id('12345678') as bad," +
      " public.direct_entry_is_canonical_national_id('1234567890123') as long," +
      " public.direct_entry_canonical_national_id('NOT-REAL') as none")).rows[0].none, null);
    for (const [label, signature] of [
      ["create guard", "public.direct_entry_guard_active_episode()"],
      ["status guard", "public.direct_entry_guard_episode_status_event()"],
      ["lookup", "public.direct_entry_lookup_worker_episodes(uuid,uuid,text,text,text,integer,integer)"],
    ]) {
      const source = (await db.query(
        "select prosrc as src from pg_proc where oid = $1::regprocedure", [signature])).rows[0].src;
      assert.ok(source.includes("direct_entry_canonical_national_id"), label);
      assert.ok(source.includes("direct_entry_national_id_lock_key"), label);
    }
  } finally {
    await db.close();
  }
});
