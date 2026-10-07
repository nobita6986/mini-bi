import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM_A = uuid(11), TEAM_B = uuid(12);
const REC_A1 = uuid(21), REC_A2 = uuid(22), REC_B1 = uuid(23);
const AUTH_ALL = uuid(31), AUTH_TEAMA = uuid(32), AUTH_OWNA1 = uuid(33),
  AUTH_OWNB1 = uuid(34), AUTH_NOLINK = uuid(35), AUTH_PM = uuid(36);
const APP_ALL = uuid(41), APP_TEAMA = uuid(42), APP_OWNA1 = uuid(43),
  APP_OWNB1 = uuid(44), APP_NOLINK = uuid(45), APP_PM = uuid(46);
const DS1 = uuid(61), RUN1 = uuid(62);

const OMITTED = { state: "omitted" };
function workerDetails(name) {
  return { display_name: name, date_of_birth: OMITTED, national_id: OMITTED, address: OMITTED, phone: OMITTED };
}

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
  for (const name of names) await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  return db;
}

async function seedBase(db) {
  for (const id of [AUTH_ALL, AUTH_TEAMA, AUTH_OWNA1, AUTH_OWNB1, AUTH_NOLINK, AUTH_PM]) {
    await db.query("insert into auth.users (id) values ($1)", [id]);
  }
  const apps = [
    [APP_ALL, AUTH_ALL], [APP_TEAMA, AUTH_TEAMA], [APP_OWNA1, AUTH_OWNA1],
    [APP_OWNB1, AUTH_OWNB1], [APP_NOLINK, AUTH_NOLINK], [APP_PM, AUTH_PM],
  ];
  for (const [app, auth] of apps) {
    await db.query("insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled) values ($1,$2,true)", [app, auth]);
  }
  await db.query("insert into public.teams (team_id, code, display_name) values ($1,'TEAM_A','Team A')", [TEAM_A]);
  await db.query("insert into public.teams (team_id, code, display_name) values ($1,'TEAM_B','Team B')", [TEAM_B]);
  await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter A1')", [REC_A1]);
  await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter A2')", [REC_A2]);
  await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter B1')", [REC_B1]);
  for (const [rec, team] of [[REC_A1, TEAM_A], [REC_A2, TEAM_A], [REC_B1, TEAM_B]]) {
    await db.query("insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from) values ($1,'hrp','2020-01-01')", [rec]);
    await db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from) values ($1,$2,'2020-01-01')", [rec, team]);
  }
  for (const [rec, key] of [[REC_A1, "rec a1"], [REC_A2, "rec a2"], [REC_B1, "rec b1"]]) {
    await db.query("insert into public.recruiter_aliases (recruiter_id, reporting_key, valid_from) values ($1,$2,'2020-01-01')", [rec, key]);
  }
  await db.query("insert into public.direct_entry_projects (project_id, display_name) values ('proj_a','Project A')");
  await db.query("insert into public.direct_entry_projects (project_id, display_name) values ('proj_b','Project B')");
  for (const [app, rec] of [[APP_TEAMA, REC_A1], [APP_OWNA1, REC_A1], [APP_OWNB1, REC_B1], [APP_PM, REC_A1]]) {
    await db.query("insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from) values ($1,$2,true,'2020-01-01')", [app, rec]);
  }
  await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from) values ($1,'all',null,'2020-01-01')", [APP_ALL]);
  await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from) values ($1,'team',$2,'2020-01-01')", [APP_TEAMA, TEAM_A]);
  // project-manager assignment for APP_PM (must NOT confer team scope).
  await db.query("insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id) values ('proj_a',$1)", [REC_A1]);
}

async function insertEntry(db, { entry, sub, cand, createdBy, project, date, code, recruiter, team, provider, labor }) {
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [cand]);
    await db.query("insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1,$2,'DRAFT')", [sub, createdBy]);
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id, project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type) " +
      "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [entry, sub, cand, createdBy, project, date, code, JSON.stringify(workerDetails("Worker " + code)), recruiter, team, provider, labor],
    );
    await db.query("update public.direct_entry_submissions set state='REVIEW', version=2 where submission_id=$1", [sub]);
    await db.query("update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1", [sub]);
    await db.exec("commit");
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}

async function seedEntries(db) {
  await insertEntry(db, { entry: uuid(101), sub: uuid(201), cand: uuid(301), createdBy: APP_OWNB1, project: "proj_a", date: "2026-10-10", code: "hrp-2026-000001", recruiter: REC_A1, team: TEAM_A, provider: "hrp", labor: "TEMPORARY" });
  await insertEntry(db, { entry: uuid(102), sub: uuid(202), cand: uuid(302), createdBy: APP_OWNA1, project: "proj_a", date: "2026-10-11", code: "hrp-2026-000002", recruiter: REC_A2, team: TEAM_A, provider: "hrp", labor: "PERMANENT" });
  await insertEntry(db, { entry: uuid(103), sub: uuid(203), cand: uuid(303), createdBy: APP_OWNA1, project: "proj_b", date: "2026-10-10", code: "hrp-2026-000003", recruiter: REC_B1, team: TEAM_B, provider: "hrp", labor: "TEMPORARY" });
  await insertEntry(db, { entry: uuid(104), sub: uuid(204), cand: uuid(304), createdBy: APP_OWNA1, project: "proj_a", date: "2026-10-10", code: "hrp-2026-000004", recruiter: REC_A1, team: TEAM_A, provider: "hrp", labor: "TEMPORARY" });
}

async function seedLegacy(db) {
  await db.query("insert into public.data_sources (id, drive_file_id, file_name, sheet_name, active, is_test) values ($1,'legacy','legacy.xlsx','Sheet1',true,false)", [DS1]);
  await db.query("insert into public.sync_runs (run_id, source_id, trigger_type, status, started_at, finished_at) values ($1,$2,'manual','succeeded','2026-10-05T00:00:00Z','2026-10-05T00:00:00Z')", [RUN1, DS1]);
  await db.query(
    "insert into public.daily_recruitment_breakdown " +
    "(source_id, business_date, project_key, project_display, recruiter_key, recruiter_display, provider_type_key, provider_type_display, employment_type_key, employment_type_display, recruited_count, sync_run_id, snapshot_at) " +
    "values ($1,'2026-10-01','legacy_proj','Legacy Project','legacy_rec','Legacy Recruiter','hrp','HRP','thời vụ','Thời vụ',7,$2,'2026-10-05T00:00:00Z')",
    [DS1, RUN1],
  );
}

async function facts(db, app, auth, filters = {}) {
  const r = await db.query("select public.direct_entry_reporting_scoped_facts($1::uuid,$2::uuid,$3::jsonb) as data", [auth, app, JSON.stringify(filters)]);
  return r.rows[0].data;
}

async function audience(db, app, auth) {
  const r = await db.query("select public.direct_entry_reporting_resolve_audience($1::uuid,$2::uuid) as data", [auth, app]);
  return r.rows[0].data;
}

test("E1: all sees facts across multiple teams and legacy", async () => {
  const db = await buildDb();
  try {
    await seedBase(db); await seedEntries(db); await seedLegacy(db);
    const res = await facts(db, APP_ALL, AUTH_ALL);
    assert.equal(res.audience.audience, "all");
    const de = res.facts.filter((f) => f.entry_id !== null);
    const legacy = res.facts.filter((f) => f.entry_id === null);
    assert.equal(de.length, 4);
    assert.equal(legacy.reduce((a, f) => a + f.recruited_count, 0), 7);
    assert.equal(res.facts.reduce((a, f) => a + f.recruited_count, 0), 11);
  } finally { await db.close(); }
});

test("E2/E9: team A sees only team A facts; audience resolves to team", async () => {
  const db = await buildDb();
  try {
    await seedBase(db); await seedEntries(db); await seedLegacy(db);
    const res = await facts(db, APP_TEAMA, AUTH_TEAMA);
    assert.equal(res.audience.audience, "team");
    const ids = res.facts.map((f) => f.entry_id);
    assert.deepEqual(ids.sort(), [uuid(101), uuid(102), uuid(104)].sort());
    assert.equal(res.facts.some((f) => f.entry_id === null), false, "no legacy for team");
  } finally { await db.close(); }
});

test("E4/E5/E6: own A1 sees only recruiter A1 entries regardless of creator", async () => {
  const db = await buildDb();
  try {
    await seedBase(db); await seedEntries(db); await seedLegacy(db);
    const res = await facts(db, APP_OWNA1, AUTH_OWNA1);
    assert.equal(res.audience.audience, "own");
    const ids = res.facts.map((f) => f.entry_id);
    // E1 (created by OWNB1, recruiter A1) + E4 (created by OWNA1, recruiter A1).
    assert.deepEqual(ids.sort(), [uuid(101), uuid(104)].sort());
    // E2 (recruiter A2, created by OWNA1) and E3 (recruiter B1) are excluded.
  } finally { await db.close(); }
});

test("E7: actor without verified recruiter link gets a valid empty dashboard", async () => {
  const db = await buildDb();
  try {
    await seedBase(db); await seedEntries(db); await seedLegacy(db);
    const res = await facts(db, APP_NOLINK, AUTH_NOLINK);
    assert.equal(res.audience.audience, "own");
    assert.equal(res.audience.recruiter_id, null);
    assert.deepEqual(res.facts, []);
  } finally { await db.close(); }
});

test("E8: project-manager assignment without team scope does not confer team", async () => {
  const db = await buildDb();
  try {
    await seedBase(db); await seedEntries(db); await seedLegacy(db);
    const aud = await audience(db, APP_PM, AUTH_PM);
    assert.equal(aud.audience, "own", "project manager must not resolve to team");
  } finally { await db.close(); }
});

test("E10: all beats team", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from) values ($1,'team',$2,'2020-01-01')", [APP_ALL, TEAM_A]);
    const aud = await audience(db, APP_ALL, AUTH_ALL);
    assert.equal(aud.audience, "all");
  } finally { await db.close(); }
});

test("E11: out-of-scope requested filter yields empty without error", async () => {
  const db = await buildDb();
  try {
    await seedBase(db); await seedEntries(db); await seedLegacy(db);
    const teamB = await facts(db, APP_TEAMA, AUTH_TEAMA, { project: "project b" });
    assert.deepEqual(teamB.facts, [], "team A must not see proj_b");
    const ownRecB = await facts(db, APP_OWNA1, AUTH_OWNA1, { recruiter: "rec b1" });
    assert.deepEqual(ownRecB.facts, [], "own A1 must not see recruiter b1");
  } finally { await db.close(); }
});

test("E3/E14: options and rankings use the same authorized row set as totals", async () => {
  const db = await buildDb();
  try {
    await seedBase(db); await seedEntries(db); await seedLegacy(db);
    const r = await db.query("select public.direct_entry_reporting_scoped_options($1::uuid,$2::uuid) as data", [AUTH_TEAMA, APP_TEAMA]);
    const opts = r.rows[0].data;
    const projects = opts.dimensions.filter((d) => d.dimension === "project").map((d) => d.key);
    const recruiters = opts.dimensions.filter((d) => d.dimension === "recruiter").map((d) => d.key);
    assert.deepEqual(projects.sort(), ["project a"]);
    assert.deepEqual(recruiters.sort(), ["rec a1", "rec a2"]);
    assert.equal(projects.includes("project b"), false, "no team B project in team A options");
    assert.equal(recruiters.includes("rec b1"), false, "no team B recruiter in team A options");
    assert.deepEqual(opts.sources, [], "team audience has no legacy source options");
  } finally { await db.close(); }
});

test("E15: cutoff 2026-10-06 and pre-cutoff Direct Entry is excluded (blocker)", async () => {
  const db = await buildDb();
  try {
    await seedBase(db); await seedEntries(db); await seedLegacy(db);
    const cutoff = await db.query("select public.direct_entry_reporting_cutoff()::text as c");
    assert.equal(cutoff.rows[0].c, "2026-10-06");
    await insertEntry(db, { entry: uuid(105), sub: uuid(205), cand: uuid(305), createdBy: APP_OWNA1, project: "proj_a", date: "2026-10-05", code: "hrp-2026-000005", recruiter: REC_A1, team: TEAM_A, provider: "hrp", labor: "TEMPORARY" });
    const blocker = await db.query("select public.direct_entry_reporting_pre_cutover_blocker_count() as c");
    assert.equal(Number(blocker.rows[0].c), 1, "pre-cutoff eligible row must trip the blocker");
    const res = await facts(db, APP_ALL, AUTH_ALL);
    assert.equal(res.facts.some((f) => f.entry_id === uuid(105)), false, "pre-cutoff entry excluded from facts");
  } finally { await db.close(); }
});

test("E16/E17: no-double-count, same-grain distinct employees, deterministic order", async () => {
  const db = await buildDb();
  try {
    await seedBase(db); await seedEntries(db); await seedLegacy(db);
    const res1 = await facts(db, APP_ALL, AUTH_ALL);
    const res2 = await facts(db, APP_ALL, AUTH_ALL);
    const de1 = res1.facts.filter((f) => f.entry_id !== null);
    // E1 and E4 share the exact ReportingFact grain but remain two rows.
    assert.equal(de1.length, 4, "same-grain employees must not collapse");
    assert.equal(de1.every((f) => f.recruited_count === 1), true);
    const grain = (f) => [f.source_id, f.business_date, f.project_key, f.recruiter_key, f.provider_type_key, f.employment_type_key].join("|");
    const a = de1.filter((f) => f.entry_id === uuid(101));
    const b = de1.filter((f) => f.entry_id === uuid(104));
    assert.equal(a.length, 1); assert.equal(b.length, 1);
    assert.equal(grain(a[0]), grain(b[0]), "same grain");
    assert.deepEqual(res1.facts, res2.facts, "deterministic ordering");
  } finally { await db.close(); }
});

test("E13: disabled actor, forged pair, and expired grant fail closed", async () => {
  const db = await buildDb();
  try {
    await seedBase(db); await seedEntries(db); await seedLegacy(db);
    // disabled actor
    await db.query("update public.direct_entry_app_users set enabled=false where app_user_id=$1", [APP_TEAMA]);
    await assert.rejects(() => audience(db, APP_TEAMA, AUTH_TEAMA), /reporting actor unavailable/);
    // forged pair
    await assert.rejects(() => audience(db, APP_ALL, AUTH_TEAMA), /reporting actor unavailable/);
    // expired team grant resolves away from team (empty for a no-link actor) -> own
    await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, valid_to) values ($1,'team',$2,'2020-01-01','2021-01-01')", [APP_NOLINK, TEAM_A]);
    const aud = await audience(db, APP_NOLINK, AUTH_NOLINK);
    assert.equal(aud.audience, "own", "expired team grant must not resolve to team");
  } finally { await db.close(); }
});

test("E18: scoped RPC/view ACL is service-role-only and raw tables stay denied", async () => {
  const db = await buildDb();
  try {
    for (const sig of [
      "public.direct_entry_reporting_resolve_audience(uuid,uuid)",
      "public.direct_entry_reporting_scoped_facts(uuid,uuid,jsonb)",
      "public.direct_entry_reporting_scoped_options(uuid,uuid)",
      "public.direct_entry_reporting_authorized_entries(uuid,uuid)",
    ]) {
      const r = await db.query("select has_function_privilege('anon',$1::regprocedure,'EXECUTE') as anon, has_function_privilege('authenticated',$1::regprocedure,'EXECUTE') as auth, has_function_privilege('service_role',$1::regprocedure,'EXECUTE') as svc", [sig]);
      assert.deepEqual({ anon: r.rows[0].anon, auth: r.rows[0].auth, svc: r.rows[0].svc }, { anon: false, auth: false, svc: true }, sig);
    }
    const raw = await db.query("select has_table_privilege('service_role','public.direct_entries','SELECT') as sel");
    assert.equal(raw.rows[0].sel, false, "raw direct_entries must stay denied to service_role");
  } finally { await db.close(); }
});

test("R1: DB gates source metadata by the resolved audience (no global metadata for team/own)", async () => {
  const db = await buildDb();
  try {
    await seedBase(db); await seedEntries(db); await seedLegacy(db);

    const allRes = await facts(db, APP_ALL, AUTH_ALL);
    assert.equal(allRes.audience.audience, "all");
    assert.equal(allRes.sources.length, 1, "all receives the global source registry");
    assert.equal(allRes.sources[0].id, DS1);
    assert.equal(allRes.sources[0].file_name, "legacy.xlsx");
    assert.equal(allRes.sources[0].drive_file_id, "legacy");
    assert.deepEqual(allRes.latest_runs, [{ source_id: DS1, status: "succeeded" }]);
    assert.deepEqual(allRes.presence, [DS1]);

    const teamRes = await facts(db, APP_TEAMA, AUTH_TEAMA);
    assert.equal(teamRes.audience.audience, "team");
    assert.deepEqual(teamRes.sources, [], "team must not receive the source registry");
    assert.deepEqual(teamRes.latest_runs, [], "team must not receive sync status");
    assert.deepEqual(teamRes.presence, [], "team must not receive source presence");

    const ownRes = await facts(db, APP_OWNA1, AUTH_OWNA1);
    assert.equal(ownRes.audience.audience, "own");
    assert.deepEqual(ownRes.sources, [], "own must not receive the source registry");
    assert.deepEqual(ownRes.latest_runs, []);
    assert.deepEqual(ownRes.presence, []);
  } finally { await db.close(); }
});

test("R1: scope effectiveness follows the HCM authorization date (not UTC)", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    const auth = uuid(91); const app = uuid(92);
    await db.query("insert into auth.users (id) values ($1)", [auth]);
    await db.query("insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled) values ($1,$2,true)", [app, auth]);

    // grant valid from HCM tomorrow => not yet effective => own (empty)
    await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from) values ($1,'team',$2,(select public.direct_entry_authorization_date() + 1))", [app, TEAM_A]);
    assert.equal((await audience(db, app, auth)).audience, "own", "future-dated team grant is not effective at HCM today");

    // grant valid from HCM today => effective => team
    await db.query("delete from public.direct_entry_scope_grants where app_user_id=$1 and scope_kind='team'", [app]);
    await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from) values ($1,'team',$2,(select public.direct_entry_authorization_date()))", [app, TEAM_A]);
    assert.equal((await audience(db, app, auth)).audience, "team", "today-dated team grant is effective at HCM today");
  } finally { await db.close(); }
});

test("R2: own/team ignore a legacy source filter (DE facts unchanged, metadata still empty)", async () => {
  const db = await buildDb();
  try {
    await seedBase(db); await seedEntries(db); await seedLegacy(db);

    const teamNoSource = await facts(db, APP_TEAMA, AUTH_TEAMA);
    const teamWithSource = await facts(db, APP_TEAMA, AUTH_TEAMA, { source: DS1 });
    assert.deepEqual(
      teamWithSource.facts.map((f) => f.entry_id).sort(),
      teamNoSource.facts.map((f) => f.entry_id).sort(),
      "team DE facts must be unchanged by a legacy source filter",
    );
    assert.deepEqual(teamWithSource.sources, [], "team metadata still empty");
    assert.deepEqual(teamWithSource.latest_runs, []);
    assert.deepEqual(teamWithSource.presence, []);

    const ownNoSource = await facts(db, APP_OWNA1, AUTH_OWNA1);
    const ownWithSource = await facts(db, APP_OWNA1, AUTH_OWNA1, { source: DS1 });
    assert.deepEqual(
      ownWithSource.facts.map((f) => f.entry_id).sort(),
      ownNoSource.facts.map((f) => f.entry_id).sort(),
      "own DE facts must be unchanged by a legacy source filter",
    );
    assert.deepEqual(ownWithSource.sources, []);
    assert.deepEqual(ownWithSource.latest_runs, []);
    assert.deepEqual(ownWithSource.presence, []);
  } finally { await db.close(); }
});

test("R2: all keeps the legacy source filter (legacy-only, no DE facts)", async () => {
  const db = await buildDb();
  try {
    await seedBase(db); await seedEntries(db); await seedLegacy(db);
    const res = await facts(db, APP_ALL, AUTH_ALL, { source: DS1 });
    assert.equal(res.audience.audience, "all");
    const de = res.facts.filter((f) => f.entry_id !== null);
    const legacy = res.facts.filter((f) => f.entry_id === null);
    assert.equal(de.length, 0, "all + source excludes DE facts (legacy-only filter)");
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].source_id, DS1);
    assert.equal(legacy[0].recruited_count, 7);
    assert.equal(res.sources.length, 1, "all still receives the source registry");
    assert.deepEqual(res.presence, [DS1]);
  } finally { await db.close(); }
});

