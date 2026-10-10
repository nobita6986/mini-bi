/**
 * P3.1-HF - mot CMT/CCCD canonical trung nhau duoc BAO CAO, khong bao gio bi CHAN.
 *
 * Finding: cohort P2.5-HF khien mot CMT/CCCD canonical chi giu duoc mot episode song. Import,
 * chinh sua hoac rehire mot episode thu hai hop le (khac project, khac episode cua cung mot
 * nguoi, dong lich su) that bai bang loi nghiep vu, trong khi khong co quy tac domain nao cam
 * dieu do - va khong man hinh nao cho biet profile nao dang trung.
 *
 * Lane nay khoa hai nua cua hotfix:
 *   1. moi raiser duplicate-CCCD o tang nghiep vu (in-batch, row guard, status-event guard,
 *      unique index) da bi go bo, trong khi format validation 9/12 chu so va quy tac canonical
 *      giu nguyen byte-for-byte;
 *   2. bao cao duplicate chi doc: masked (4 chu so cuoi), bounded, deterministic, khong tra ve
 *      UUID nao, va chi Full Admin / catalog_master_manage / entry_privileged_edit o all scope
 *      moi doc duoc.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const HOTFIX_MIGRATION = "20261009100000_p3_1_hf_duplicate_cccd_reporting.sql";
const PREVIOUS_MIGRATION = "20261009090000_p3_1_hf_recruiter_alias_backfill.sql";
const R3_MIGRATION = "20261008210000_p2_5_hf_r3_worker_full_correction.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_A = "hf_dup_proj_a";
const PROJ_B = "hf_dup_proj_b";
const REC_A = uuid(21);

// Full Admin (legacy triple) / Accounting-Admin / BoD / entry_admin-only / change_review /
// team leader / mapped without any capability.
const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const ACC_AUTH = uuid(32), ACC_APP = uuid(42);
const BOD_AUTH = uuid(33), BOD_APP = uuid(43);
const LONE_AUTH = uuid(34), LONE_APP = uuid(44);
const REVIEW_AUTH = uuid(35), REVIEW_APP = uuid(45);
const LEADER_AUTH = uuid(36), LEADER_APP = uuid(46);
const OUTSIDE_AUTH = uuid(37), OUTSIDE_APP = uuid(47);
// Full Admin triple, but only team scope: proves the reader needs an effective all scope.
const SCOPED_AUTH = uuid(38), SCOPED_APP = uuid(48);
// Never inserted into direct_entry_app_users: proves an unmapped actor is refused.
const UNMAPPED_AUTH = uuid(39), UNMAPPED_APP = uuid(49);

const REPORT_FUNCTION = "public.direct_entry_duplicate_cccd_report";
const REPORT_SIGNATURE = REPORT_FUNCTION + "(uuid,uuid,integer,integer)";
const READER_SIGNATURE = "public.direct_entry_assert_duplicate_cccd_reader(uuid,uuid)";

// The P3.1-W01B legacy "Full Admin" triple plus the capabilities the P2.5-HF per-row
// creation authority needs. The reader gate only looks at the triple.
const FULL_ADMIN_CAPABILITIES = [
  "entry_admin", "recruiter_master_manage", "team_master_manage", "entry_create",
  "submission_create", "employment_status.apply", "change_request_create",
];

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`migration ${name} failed to install: ${error.message}`, { cause: error });
    }
  }
  assert.equal(names.length, 74, "the ledger carries 74 migrations through P3.1-HF");
  assert.equal(names[names.length - 1], HOTFIX_MIGRATION, "P3.1-HF is the newest migration");
  assert.equal(names[names.length - 2], PREVIOUS_MIGRATION, "P3.1-HF stays append-only");
  assert.equal(names[names.length - 14], R3_MIGRATION, "P2.5-HF-R3 remains #61");
  return db;
}

async function insertActor(db, auth, app, capabilities, scopeKinds = []) {
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
    " values ($1,$2,true,'Hotfix Account')", [app, auth]);
  for (const capability of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)" +
      " values ($1,$2,'2020-01-01')", [app, capability]);
  }
  for (const scopeKind of scopeKinds) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from)" +
      " values ($1,$2,$3,'2020-01-01')",
      [app, scopeKind, scopeKind === "team" ? TEAM : null]);
  }
}

async function seed(db) {
  await db.query(
    "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_HF','Team HF')", [TEAM]);
  await db.query(
    "insert into public.direct_entry_projects (project_id, display_name) values ($1,'Project HF A')",
    [PROJ_A]);
  await db.query(
    "insert into public.direct_entry_projects (project_id, display_name) values ($1,'Project HF B')",
    [PROJ_B]);
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter HF')", [REC_A]);
  await db.query(
    "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from)" +
    " values ($1,'hrp','2020-01-01')", [REC_A]);
  await db.query(
    "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)" +
    " values ($1,$2,'2020-01-01')", [REC_A, TEAM]);

  // own scope as well: the v1 full-profile batch and the legacy batch keep their per-row
  // creation authority (P2.5-HF), which needs a live own grant at the work date.
  await insertActor(db, ADMIN_AUTH, ADMIN_APP, FULL_ADMIN_CAPABILITIES, ["all", "own"]);
  await insertActor(db, ACC_AUTH, ACC_APP, ["catalog_master_manage"], ["all"]);
  await insertActor(db, BOD_AUTH, BOD_APP, ["entry_privileged_edit"], ["all"]);
  await insertActor(db, LONE_AUTH, LONE_APP, ["entry_admin"], ["all"]);
  await insertActor(db, REVIEW_AUTH, REVIEW_APP, ["change_review"], ["all"]);
  await insertActor(db, LEADER_AUTH, LEADER_APP, ["team_manager_assign"], ["team"]);
  await insertActor(db, OUTSIDE_AUTH, OUTSIDE_APP, [], ["all"]);
  await insertActor(db, SCOPED_AUTH, SCOPED_APP, FULL_ADMIN_CAPABILITIES, ["team"]);
  // UNMAPPED_AUTH deliberately never appears in direct_entry_app_users.
}


function workerDetails(cccd, extra = {}) {
  return {
    date_of_birth: { state: "provided", value: "1990-01-01" },
    national_id: cccd === null ? { state: "unknown" } : { state: "provided", value: cccd },
    address: { state: "provided", value: "HF address" },
    phone: { state: "provided", value: "0900000000" },
    ...extra,
  };
}

// Every writer demands an RFC-4122 shaped key and the v2 wrapper derives a second key
// from it, so each call must be unique and well formed.
let keySeq = 0;
function idemKey() {
  keySeq += 1;
  return uuid(900000 + keySeq);
}

async function count(db, sql, params = []) {
  const res = await db.query(sql, params);
  return Number(Object.values(res.rows[0])[0]);
}

/** Mot episode lich su ghi truc tiep vao bang - khong di qua batch create. */
let episodeSeq = 0;
async function seedEpisode(db, {
  cccd, name, project = PROJ_A, date = "2026-01-05", status = "ON", deleted = false,
}) {
  episodeSeq += 1;
  const candidate = uuid(2000 + episodeSeq);
  const submission = uuid(3000 + episodeSeq);
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
      " provider_type, labor_type, deleted_at)" +
      " values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'hrp','TEMPORARY',null)",
      [entry, submission, candidate, ADMIN_APP, project, date, code,
        JSON.stringify({ display_name: name, ...workerDetails(cccd) }), REC_A, TEAM]);
    await db.query(
      "update public.direct_entry_submissions set state='REVIEW', version=2 where submission_id=$1",
      [submission]);
    await db.query(
      "update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1",
      [submission]);
    if (status !== null) {
      await appendStatus(db, entry, status, date, 1, null);
    }
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  if (deleted) {
    // Xoa mem SAU khi commit: submission da qua duoc kiem tra "nonempty" o thoi diem
    // commit, va khong con update state nao duoc xep hang lai.
    await softDeleteEntry(db, entry);
  }
  return { entryId: entry, employeeCode: code };
}

/** Xoa mem mot episode da commit - the version guard doi version tang dung 1. */
async function softDeleteEntry(db, entryId) {
  await db.query(
    "update public.direct_entries set deleted_at = $2::timestamptz, version = version + 1" +
    " where entry_id = $1", [entryId, "2026-02-01T00:00:00Z"]);
}

let reasonSeq = 0;
async function appendStatus(db, entryId, status, date, version, supersedesEventId) {
  reasonSeq += 1;
  const reasonId = (await db.query(
    "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
    " values ($1,$2) returning reason_id::text as id", [ADMIN_APP, `HF reason ${reasonSeq}`])).rows[0].id;
  return (await db.query(
    "insert into public.direct_entry_employment_status_events" +
    " (entry_id, status, effective_date, leave_date, leave_reason_text, version," +
    " actor_user_id, reason_id, supersedes_event_id)" +
    " values ($1,$2,$3::date, case when $2 = 'OFF' then $3::date else null end," +
    " case when $2 = 'OFF' then 'HF synthetic leave' else null end, $4,$5,$6,$7)" +
    " returning event_id::text as id",
    [entryId, status, date, version, ADMIN_APP, reasonId, supersedesEventId])).rows[0].id;
}

/** Duong create that su: full-profile v1 batch (server-side). */
async function createFullProfile(db, { cccd, name, project = PROJ_A, date = "2026-10-01",
  code = "hrp-2026-900001", auth = ADMIN_AUTH, app = ADMIN_APP }) {
  return db.query(
    "select public.direct_entry_create_full_profile_batch($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text)",
    [auth, app, "worker-profile/1.0", JSON.stringify([{
      project_id: project, first_work_date: date, employee_code: code,
      recruiter_id: REC_A, labor_type: "TEMPORARY", display_name: name,
      worker_details: workerDetails(cccd),
    }]), idemKey("hf-v1")]);
}

async function createFullProfileV2(db, { cccd, name, project = PROJ_A, date = "2026-10-02" }) {
  return db.query(
    "select public.direct_entry_create_full_profile_batch_v2($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text)",
    [ADMIN_AUTH, ADMIN_APP, "worker-profile/1.1", JSON.stringify([{
      project_id: project, first_work_date: date, provider_type: "hrp", recruiter_id: REC_A,
      labor_type: "TEMPORARY", display_name: name, worker_details: workerDetails(cccd),
    }]), idemKey("hf-v2")]);
}

async function createLegacyBatch(db, { cccd, name, date = "2026-10-03", code = "hrp-2026-900002" }) {
  return db.query(
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text)",
    [ADMIN_AUTH, ADMIN_APP, JSON.stringify([{
      project_id: PROJ_A, first_work_date: date, employee_code: code,
      labor_type: "TEMPORARY", recruiter_id: REC_A,
      worker_details: { display_name: name, ...workerDetails(cccd) },
    }]), idemKey("hf-legacy")]);
}

async function report(db, { auth = ADMIN_AUTH, app = ADMIN_APP, page = 1, pageSize = 25 } = {}) {
  return (await db.query(
    `select ${REPORT_FUNCTION}($1::uuid,$2::uuid,$3::int,$4::int) as data`,
    [auth, app, page, pageSize])).rows[0].data;
}

async function reportDenied(db, options, message) {
  await assert.rejects(
    () => report(db, options),
    (error) => {
      assert.equal(error.code, "42501", "the duplicate report must deny with 42501");
      if (message) {
        assert.match(error.message, message);
      }
      return true;
    });
}

/**
 * Go CHECK worker_details trong luc seed du lieu lich su (dinh dang CCCD cu), roi gan lai
 * o dang NOT VALID - khong ghi de du lieu that va khong sua migration cu.
 */
async function relaxWorkerDetailsCheck(db) {
  const row = (await db.query(
    "select conname from pg_constraint where conrelid = 'public.direct_entries'::regclass" +
    " and contype = 'c' and pg_get_constraintdef(oid) like '%valid_worker_details%'")).rows[0];
  assert.ok(row, "the worker_details CHECK constraint must exist");
  await db.query('alter table public.direct_entries drop constraint "' + row.conname + '"');
}

async function restoreWorkerDetailsCheck(db) {
  await db.exec(
    "alter table public.direct_entries" +
    " add constraint direct_entries_worker_details_hf_simulated" +
    " check (public.direct_entry_valid_worker_details(worker_details)) not valid");
}

/** Hai episode song cua cung mot CCCD canonical, hai project, hai ngay lam viec. */
async function seedPair(db, options = {}) {
  const {
    cccd, first = "2026-01-05", second = "2026-02-10", statusFirst = "ON", statusSecond = "ON",
    firstProject = PROJ_A, secondProject = PROJ_B,
  } = options;
  const a = await seedEpisode(db, {
    cccd, name: "HF Pair A", project: firstProject, date: first, status: statusFirst,
  });
  const b = await seedEpisode(db, {
    cccd, name: "HF Pair B", project: secondProject, date: second, status: statusSecond,
  });
  return { a, b };
}


// ---------------------------------------------------------------------------
// 1. Cai dat: migration #74 append-only, 74 migration, khong sua #58..#61.
// ---------------------------------------------------------------------------
test("P3.1-HF: the migration installs as #74 and leaves #58..#61 untouched", async () => {
  const db = await buildDb();
  try {
    assert.equal(await count(db,
      "select count(*) from pg_proc where proname = 'direct_entry_guard_active_episode'"), 0);
    assert.equal(await count(db,
      "select count(*) from pg_proc where proname = 'direct_entry_duplicate_cccd_report'"), 1);
    assert.equal(await count(db,
      "select count(*) from pg_proc where proname = 'direct_entry_assert_duplicate_cccd_reader'"), 1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Moi duong ghi nghiep vu chap nhan episode thu hai cua cung mot CCCD.
// ---------------------------------------------------------------------------
test("P3.1-HF: create, import v2 and the legacy batch all accept a second live episode", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createFullProfile(db, { cccd: "012345678901", name: "HF First" });
    await createFullProfile(db, { cccd: "012345678901", name: "HF Second", date: "2026-10-05",
      code: "hrp-2026-900011" });
    await createFullProfileV2(db, { cccd: "012345678901", name: "HF Third" });
    await createLegacyBatch(db, { cccd: "012345678901", name: "HF Fourth" });

    assert.equal(await count(db,
      "select count(*) from public.direct_entries" +
      " where worker_details->'national_id'->>'value' = '012345678901'"), 4,
    "four live episodes may share one canonical CCCD");
    assert.equal(await count(db, "select count(*) from public.direct_entries"), 4);
  } finally {
    await db.close();
  }
});

test("P3.1-HF: no duplicate-CCCD raiser and no unique CCCD index survive in public", async () => {
  const db = await buildDb();
  try {
    assert.equal(await count(db,
      "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
      " where n.nspname = 'public' and p.prokind = 'f'" +
      " and (p.prosrc like '%NATIONAL_ID_DUPLICATE%'" +
      "      or p.prosrc like '%worker_active_episode_exists%')"), 0,
    "no public function may still raise a duplicate-CCCD error");
    assert.equal(await count(db,
      "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
      " where n.nspname = 'public' and p.prokind = 'f'" +
      " and p.prosrc ~ 'direct_entry_guard_active_episode'"), 0);
    assert.equal(await count(db,
      "select count(*) from pg_index i where i.indrelid = 'public.direct_entries'::regclass" +
      " and i.indisunique and i.indexprs is not null" +
      " and pg_get_indexdef(i.indexrelid) like '%national_id%'"), 0,
    "a unique CCCD index would block a second episode at the storage layer");
    assert.equal(await count(db,
      "select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid" +
      " where t.tgrelid = 'public.direct_entries'::regclass and not t.tgisinternal" +
      " and (p.prosrc like '%NATIONAL_ID_DUPLICATE%'" +
      "      or p.prosrc like '%worker_active_episode_exists%')"), 0);
  } finally {
    await db.close();
  }
});

test("P3.1-HF: the raw write path accepts a second active episode for one canonical CCCD", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const first = await seedEpisode(db, { cccd: "098765432", name: "HF Raw First", status: "ON" });
    const second = await seedEpisode(db, { cccd: "098765432", name: "HF Raw Second", status: "ON",
      project: PROJ_B, date: "2026-03-01" });
    assert.notEqual(first.entryId, second.entryId);
    assert.equal(await count(db,
      "select count(*) from public.direct_entries where deleted_at is null"), 2,
    "the row guard must not refuse the second episode");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_employment_status_events"), 2,
    "the status-event guard must not refuse the second live episode either");

    // Du lieu lich su giu dinh dang cu (co khoang trang) van nap duoc: report chuan hoa,
    // con duong ghi khong tu y sua lai gia tri.
    await relaxWorkerDetailsCheck(db);
    const legacy = await seedEpisode(db, { cccd: "0987 65432", name: "HF Raw Legacy",
      status: "ON", project: PROJ_B, date: "2026-04-01" });
    await restoreWorkerDetailsCheck(db);
    assert.equal(await count(db,
      "select count(*) from public.direct_entries where deleted_at is null"), 3);
    assert.match(legacy.employeeCode, /^hrp-2026-[0-9]{6}$/);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Quyen doc: chi Full Admin / catalog_master_manage / entry_privileged_edit
//    voi all scope con hieu luc.
// ---------------------------------------------------------------------------
test("P3.1-HF: only the three all-scope authorities read the duplicate report", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createFullProfile(db, { cccd: "012345678901", name: "HF Gate First" });
    await createFullProfile(db, { cccd: "012345678901", name: "HF Gate Second",
      date: "2026-10-05", code: "hrp-2026-900011" });

    const admin = await report(db);
    assert.equal(admin.authority, "entry_admin");
    assert.equal(admin.total_groups, 1);
    assert.equal(admin.total_entries, 2);
    assert.equal(admin.groups.length, 1);
    assert.equal(admin.groups[0].profile_count, 2);

    const accounting = await report(db, { auth: ACC_AUTH, app: ACC_APP });
    assert.equal(accounting.authority, "catalog_master_manage");
    assert.equal(accounting.total_groups, 1);

    const board = await report(db, { auth: BOD_AUTH, app: BOD_APP });
    assert.equal(board.authority, "entry_privileged_edit");
    assert.equal(board.total_groups, 1);

    // entry_admin@all mot minh, change_review, team leader, actor khong co capability:
    // tat ca bi tu choi truoc khi doc bat cu dong nao.
    await reportDenied(db, { auth: LONE_AUTH, app: LONE_APP }, /duplicate cccd report denied/);
    await reportDenied(db, { auth: REVIEW_AUTH, app: REVIEW_APP }, /duplicate cccd report denied/);
    await reportDenied(db, { auth: LEADER_AUTH, app: LEADER_APP }, /duplicate cccd report denied/);
    await reportDenied(db, { auth: OUTSIDE_AUTH, app: OUTSIDE_APP }, /duplicate cccd report denied/);
    // Full Admin triple nhung chi team scope.
    await reportDenied(db, { auth: SCOPED_AUTH, app: SCOPED_APP },
      /duplicate cccd report requires all scope/);
    // Mapping: chu the nay khong duoc muon tai khoan khac, va cap chua map bi tu choi.
    await reportDenied(db, { auth: ADMIN_AUTH, app: ACC_APP }, /actor mapping denied/);
    await reportDenied(db, { auth: UNMAPPED_AUTH, app: UNMAPPED_APP }, /actor mapping denied/);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Noi dung bao cao: mask, chuan hoa dinh dang cu, khong lo UUID.
// ---------------------------------------------------------------------------
test("P3.1-HF: the report masks the CCCD, normalizes legacy formatting and emits no UUID", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await relaxWorkerDetailsCheck(db);
    // Mot cap trung: mot dong canonical + mot dong con giu dinh dang cu.
    await seedEpisode(db, { cccd: "012345678901", name: "HF Mask Canonical", project: PROJ_A,
      date: "2026-02-10", status: "ON" });
    // Dong dinh dang cu: ON khi vao (mac dinh hien hanh), roi nghi viec that su bang
    // su kien OFF thu hai - trang thai dau tien khong the la OFF.
    const legacy = await seedEpisode(db, { cccd: "0123 456 78901", name: "HF Mask Legacy",
      project: PROJ_B, date: "2026-01-05", status: "ON" });
    await appendStatus(db, legacy.entryId, "OFF", "2026-01-06", 2, null);
    // Cac truong hop KHONG phai trung: xuat hien mot lan, unknown, va da xoa mem.
    await seedEpisode(db, { cccd: "111222333", name: "HF Mask Single", project: PROJ_A,
      date: "2026-03-01", status: "ON" });
    await seedEpisode(db, { cccd: null, name: "HF Mask Unknown", project: PROJ_A,
      date: "2026-03-02", status: "ON" });
    await seedEpisode(db, { cccd: "555666777", name: "HF Mask Deleted", project: PROJ_A,
      date: "2026-03-03", status: "ON", deleted: true });
    await seedEpisode(db, { cccd: "555666777", name: "HF Mask Deleted Two", project: PROJ_B,
      date: "2026-03-04", status: "ON", deleted: true });
    await restoreWorkerDetailsCheck(db);

    const payload = await report(db);
    assert.equal(payload.page, 1);
    assert.equal(payload.page_size, 25);
    assert.equal(payload.has_more, false);
    assert.equal(payload.total_groups, 1, "chi CCCD xuat hien hai lan moi la trung");
    assert.equal(payload.total_entries, 2);

    const [group] = payload.groups;
    assert.deepEqual(Object.keys(group).sort(), [
      "active_profile_count", "cccd_last4", "cccd_length", "episodes", "first_work_date",
      "latest_first_work_date", "profile_count", "project_count",
    ]);
    assert.equal(group.cccd_last4, "8901");
    assert.equal(group.cccd_length, 12);
    assert.equal(group.profile_count, 2);
    assert.equal(group.project_count, 2);
    assert.equal(group.active_profile_count, 1);
    assert.equal(group.first_work_date, "2026-01-05");
    assert.equal(group.latest_first_work_date, "2026-02-10");

    // Episode xep theo first_work_date: dong dinh dang cu (som hon) dung truoc.
    assert.deepEqual(group.episodes.map((e) => e.first_work_date), ["2026-01-05", "2026-02-10"]);
    assert.deepEqual(group.episodes.map((e) => e.latest_status), ["OFF", "ON"]);
    assert.deepEqual(group.episodes.map((e) => e.active), [false, true]);
    assert.deepEqual(group.episodes.map((e) => e.project_id), [PROJ_B, PROJ_A]);
    assert.deepEqual(group.episodes.map((e) => e.project_display),
      ["Project HF B", "Project HF A"]);
    assert.deepEqual(Object.keys(group.episodes[0]).sort(), [
      "active", "display_name", "employee_code", "first_work_date", "latest_status",
      "project_display", "project_id",
    ]);

    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("012345678901"),
      "so CCCD canonical day du khong duoc roi khoi database");
    assert.ok(!serialized.includes("0123 456 78901"),
      "dinh dang luu tru cu cung khong duoc ro ri");
    assert.doesNotMatch(serialized,
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      "khong entry/submission/candidate/actor/reason UUID nao duoc tra ve");

    // Project bi thieu khong duoc lam mat ca nhom trung: join phai la left join.
    assert.equal(await count(db,
      "select count(*) from pg_proc where oid = $1::regprocedure" +
      " and prosrc like '%left join public.direct_entry_projects%'", [REPORT_SIGNATURE]), 1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Bien: page_size <= 100, page <= 1000, va kiem tra truoc khi doc du lieu.
// ---------------------------------------------------------------------------
test("P3.1-HF: the report is bounded and rejects out-of-range paging", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedPair(db, { cccd: "012345678901" });

    for (const [page, pageSize, message] of [
      [1, 101, /duplicate_report_page_size_invalid/],
      [1, 0, /duplicate_report_page_size_invalid/],
      [1, -5, /duplicate_report_page_size_invalid/],
      [1001, 25, /duplicate_report_page_invalid/],
      [0, 25, /duplicate_report_page_invalid/],
    ]) {
      await assert.rejects(() => report(db, { page, pageSize }), (error) => {
        assert.equal(error.code, "22023");
        assert.match(error.message, message);
        return true;
      });
    }

    // Bien duoc kiem tra TRUOC quyen doc: ke ca actor chua map cung khong do duoc
    // hinh dang cua report khi tham so sai.
    await assert.rejects(
      () => report(db, { auth: UNMAPPED_AUTH, app: UNMAPPED_APP, pageSize: 101 }),
      (error) => {
        assert.equal(error.code, "22023");
        assert.match(error.message, /duplicate_report_page_size_invalid/);
        return true;
      });
    await reportDenied(db, { auth: UNMAPPED_AUTH, app: UNMAPPED_APP });

    // Tham so null roi ve mac dinh 1 / 25 thay vi loi.
    const defaults = await report(db, { page: null, pageSize: null });
    assert.equal(defaults.page, 1);
    assert.equal(defaults.page_size, 25);
    assert.equal(defaults.total_groups, 1);
    // 100 la kich thuoc trang lon nhat duoc chap nhan.
    const widest = await report(db, { pageSize: 100 });
    assert.equal(widest.page_size, 100);
    assert.equal(widest.groups.length, 1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 8. Determinism: thu tu nhom, thu tu episode va cat trang.
// ---------------------------------------------------------------------------
test("P3.1-HF: group and episode ordering plus paging are deterministic", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedPair(db, { cccd: "111111111" });
    await seedPair(db, { cccd: "222222222", first: "2026-03-01", second: "2026-01-01" });
    await seedPair(db, { cccd: "333333333" });

    const first = await report(db, { pageSize: 2 });
    assert.equal(first.total_groups, 3);
    assert.equal(first.total_entries, 6);
    assert.equal(first.has_more, true);
    assert.deepEqual(first.groups.map((g) => g.cccd_last4), ["1111", "2222"]);
    assert.deepEqual(first.groups.map((g) => g.cccd_length), [9, 9]);
    // Episode trong mot nhom xep theo first_work_date, khong theo thu tu ghi.
    assert.deepEqual(first.groups[1].episodes.map((e) => e.first_work_date),
      ["2026-01-01", "2026-03-01"]);

    const second = await report(db, { page: 2, pageSize: 2 });
    assert.equal(second.has_more, false);
    assert.equal(second.total_groups, 3);
    assert.deepEqual(second.groups.map((g) => g.cccd_last4), ["3333"]);

    const beyond = await report(db, { page: 3, pageSize: 2 });
    assert.deepEqual(beyond.groups, []);
    assert.equal(beyond.has_more, false);
    assert.equal(beyond.total_groups, 3);
    assert.equal(beyond.total_entries, 6);

    // Hai lan goi y het phai tra ve JSON giong nhau tung byte.
    assert.deepEqual(await report(db, { pageSize: 2 }), first);
    assert.deepEqual(await report(db, { page: 2, pageSize: 2 }), second);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 9. Chi doc: khong ghi, khong lock, khong merge, khong "sua" profile nao.
// ---------------------------------------------------------------------------
test("P3.1-HF: reading the report never writes, locks, merges or repairs", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedPair(db, { cccd: "012345678901" });
    const snapshot = async () => [
      await count(db, "select count(*) from public.direct_entries"),
      await count(db, "select count(*) from public.direct_entry_candidates"),
      await count(db, "select count(*) from public.direct_entry_submissions"),
      await count(db, "select count(*) from public.direct_entry_submission_revisions"),
      await count(db, "select count(*) from public.direct_entry_employment_status_events"),
      await count(db, "select count(*) from public.direct_entry_audit_events"),
      await count(db, "select count(*) from public.direct_entry_revisions"),
      await count(db, "select count(*) from public.direct_entry_rpc_idempotency"),
      await count(db, "select count(*) from public.direct_entry_restricted_reasons"),
      await count(db, "select coalesce(sum(version),0) from public.direct_entries"),
      await count(db,
        "select count(*) from public.direct_entries where deleted_at is not null"),
    ];
    const before = await snapshot();
    for (let round = 0; round < 5; round += 1) {
      await report(db, { page: 1, pageSize: 2 });
    }
    assert.deepEqual(await snapshot(), before, "report khong duoc de lai bat cu dong nao");

    const reportSource = (await db.query(
      "select prosrc, provolatile, prosecdef," +
      " p.proconfig::text as proconfig" +
      " from pg_proc p where p.oid = $1::regprocedure", [REPORT_SIGNATURE])).rows[0];
    assert.equal(reportSource.provolatile, "s", "report phai la STABLE (khong ghi)");
    assert.equal(reportSource.prosecdef, true);
    assert.ok(String(reportSource.proconfig).includes("search_path=pg_catalog, public"),
      "search_path phai duoc ghim");
    const body = reportSource.prosrc.toLowerCase();
    for (const verb of ["insert into", "update ", "delete from", "pg_advisory", "for update",
      "truncate", "commit"]) {
      assert.equal(body.includes(verb), false, `than report khong duoc chua "${verb}"`);
    }
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 10. Bien gioi cai dat: report chi service_role goi duoc, guard noi bo bi thu hoi.
// ---------------------------------------------------------------------------
test("P3.1-HF: the report is service_role-only and the internal guard is revoked", async () => {
  const db = await buildDb();
  try {
    const acl = async (signature) => (await db.query(
      "select has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec," +
      " has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec," +
      " has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec," +
      " (select count(*)::int from" +
      " aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a" +
      " where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec" +
      " from pg_proc p where p.oid = '" + signature + "'::regprocedure")).rows[0];

    const report = await acl(REPORT_SIGNATURE);
    assert.equal(report.service_exec, true, "service_role goi report qua repository/route");
    assert.equal(report.anon_exec, false);
    assert.equal(report.auth_exec, false);
    assert.equal(report.public_exec, 0, "PUBLIC khong duoc goi report");

    const reader = await acl(READER_SIGNATURE);
    assert.equal(reader.service_exec, false, "guard noi bo khong duoc goi tu service_role");
    assert.equal(reader.anon_exec, false);
    assert.equal(reader.auth_exec, false);
    assert.equal(reader.public_exec, 0);

    // Guard tra ve quyen thuc te dang dung (de route ghi audit), khong ghi gi.
    assert.equal(await count(db,
      "select count(*) from pg_proc where oid = 'public.direct_entry_assert_duplicate_cccd_reader" +
      "(uuid,uuid)'::regprocedure and prorettype = 'text'::regtype and provolatile = 's'"), 1);

    // Report la ham doc duy nhat: khong co ban "sua trung" / "merge" nao duoc cai them.
    assert.equal(await count(db,
      "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
      " where n.nspname = 'public' and p.prokind = 'f'" +
      " and p.proname like '%duplicate%'"), 2,
    "chi report va guard noi bo duoc mang ten duplicate");
  } finally {
    await db.close();
  }
});
