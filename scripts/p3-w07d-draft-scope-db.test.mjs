/**
 * P3-W07D - draft scope precedence + historical draft edit (real DB).
 *
 * Reproduces the Production failure shape with a synthetic owner that holds an
 * own scope and an all scope starting after the imported rows' first_work_date,
 * then proves the deterministic precedence and the historical-edit decoupling.
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
const SCOPE_START = "2026-10-04";
const PRE_SCOPE_DATE = "2026-10-02";
const POST_SCOPE_DATE = "2026-10-05";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM_A = uuid(11), TEAM_B = uuid(12);
const REC_OWN = uuid(21), REC_VENDOR = uuid(22), REC_OTHER = uuid(23);
// A Vendor recruiter that does carry a business team, and an HRP recruiter whose
// team membership changes from TEAM_A to TEAM_B on 2026-10-04.
const REC_VENDOR_TEAMED = uuid(24), REC_MOVER = uuid(25);
const AUTH_OWNER = uuid(31), APP_OWNER = uuid(41);
const AUTH_DISABLED = uuid(32), APP_DISABLED = uuid(42);
const AUTH_FORGED = uuid(33);
const AUTH_NOCAP = uuid(34), APP_NOCAP = uuid(44);
const S0 = uuid(50), S1 = uuid(51), S2 = uuid(52), S3 = uuid(53), S4 = uuid(54), S5 = uuid(55), S6 = uuid(56);

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

const OWNER_CAPABILITIES = [
  "entry_create", "entry_own", "entry_team", "entry_admin", "entry_privileged_edit",
  "submission_create", "pii_view",
];

async function seedBase(db) {
  for (const [auth, app] of [[AUTH_OWNER, APP_OWNER], [AUTH_DISABLED, APP_DISABLED], [AUTH_NOCAP, APP_NOCAP]]) {
    await db.query("insert into auth.users (id) values ($1)", [auth]);
    await db.query("insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled) values ($1,$2,true)", [app, auth]);
  }
  for (const app of [S0, S1, S2, S3, S4, S5, S6]) {
    await db.query("insert into auth.users (id) values ($1)", [app]);
    await db.query("insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled) values ($1,$2,true)", [app, app]);
  }
  for (const [team, code, name] of [[TEAM_A, "TEAM_A", "Team Alpha"], [TEAM_B, "TEAM_B", "Team Beta"]]) {
    await db.query("insert into public.teams (team_id, code, display_name) values ($1,$2,$3)", [team, code, name]);
  }
  // HRP recruiter with one effective team; Vendor recruiter with no business team.
  await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter Own')", [REC_OWN]);
  await db.query("insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from) values ($1,'hrp','2020-01-01')", [REC_OWN]);
  await db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from) values ($1,$2,'2020-01-01')", [REC_OWN, TEAM_A]);
  await db.query("insert into public.recruiter_aliases (recruiter_id, reporting_key, valid_from) values ($1,'rec own','2020-01-01')", [REC_OWN]);
  await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter Other')", [REC_OTHER]);
  await db.query("insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from) values ($1,'hrp','2020-01-01')", [REC_OTHER]);
  await db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from) values ($1,$2,'2020-01-01')", [REC_OTHER, TEAM_B]);
  await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,'Vendor Recruiter')", [REC_VENDOR]);
  await db.query("insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from) values ($1,'vendor','2020-01-01')", [REC_VENDOR]);
  await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,'Vendor Recruiter Teamed')", [REC_VENDOR_TEAMED]);
  await db.query("insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from) values ($1,'vendor','2020-01-01')", [REC_VENDOR_TEAMED]);
  await db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from) values ($1,$2,'2020-01-01')", [REC_VENDOR_TEAMED, TEAM_B]);
  await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter Mover')", [REC_MOVER]);
  await db.query("insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from) values ($1,'hrp','2020-01-01')", [REC_MOVER]);
  await db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, valid_to) values ($1,$2,'2020-01-01',$3::date)", [REC_MOVER, TEAM_A, SCOPE_START]);
  await db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from) values ($1,$2,$3::date)", [REC_MOVER, TEAM_B, SCOPE_START]);
  for (const [project, name] of [["proj_a", "Project A"], ["proj_b", "Project B"]]) {
    await db.query("insert into public.direct_entry_projects (project_id, display_name) values ($1,$2)", [project, name]);
  }
  for (const capability of OWNER_CAPABILITIES) {
    await db.query("insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from) values ($1,$2,'2020-01-01')", [APP_OWNER, capability]);
  }
  // Production shape: own and all both start AFTER the imported rows' work date.
  await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from) values ($1,'own',null,$2::date)", [APP_OWNER, SCOPE_START]);
  await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from) values ($1,'all',null,$2::date)", [APP_OWNER, SCOPE_START]);
  // APP_NOCAP deliberately holds a scope but no capability at all.
  await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from) values ($1,'all',null,'2020-01-01')", [APP_NOCAP]);
}

async function seedScopeMatrix(db) {
  const combos = [
    [S0, []],
    [S1, ["own"]],
    [S2, ["team"]],
    [S3, ["all"]],
    [S4, ["own", "all"]],
    [S5, ["own", "team"]],
    [S6, ["own", "team", "all"]],
  ];
  for (const [app, kinds] of combos) {
    for (const capability of ["entry_own", "entry_team", "entry_admin"]) {
      await db.query("insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from) values ($1,$2,'2020-01-01')", [app, capability]);
    }
    for (const kind of kinds) {
      await db.query("insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from) values ($1,$2,$3,'2020-01-01')", [app, kind, kind === "team" ? TEAM_A : null]);
    }
  }
}

async function insertDraft(db, { entry, sub, cand, createdBy, project, date, code, recruiter, team, provider, labor }) {
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [cand]);
    await db.query("insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1,$2,'DRAFT')", [sub, createdBy]);
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id, project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type) " +
      "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [entry, sub, cand, createdBy, project, date, code, JSON.stringify(workerDetails("Worker " + code)), recruiter, team, provider, labor],
    );
    await db.exec("commit");
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}

async function seedImportedBatch(db) {
  for (let i = 0; i < 14; i += 1) {
    await insertDraft(db, {
      entry: uuid(1000 + i), sub: uuid(2000 + i), cand: uuid(3000 + i), createdBy: APP_OWNER,
      project: "proj_a", date: PRE_SCOPE_DATE, code: "hrp-2026-" + String(100000 + i),
      recruiter: REC_OWN, team: TEAM_A, provider: "hrp", labor: "TEMPORARY",
    });
  }
  for (let i = 0; i < 3; i += 1) {
    await insertDraft(db, {
      entry: uuid(1100 + i), sub: uuid(2100 + i), cand: uuid(3100 + i), createdBy: APP_OWNER,
      project: "proj_a", date: POST_SCOPE_DATE, code: "hrp-2026-" + String(200000 + i),
      recruiter: REC_OWN, team: TEAM_A, provider: "hrp", labor: "TEMPORARY",
    });
  }
}

async function extendHistoricalAllScope(db) {
  await db.query(
    "update public.direct_entry_scope_grants set valid_from = $2::date" +
    " where app_user_id = $1 and scope_kind = 'all'",
    [APP_OWNER, PRE_SCOPE_DATE],
  );
}

async function listDrafts(db, auth, app) {
  const res = await db.query("select public.direct_entry_list_own_drafts($1::uuid,$2::uuid) as data", [auth, app]);
  return res.rows[0].data;
}
async function scopeProbe(db, auth, app, owner, team, date) {
  const res = await db.query(
    "select public.direct_entry_assert_draft_access($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date) as scope",
    [auth, app, owner, team, date],
  );
  return res.rows[0].scope;
}
async function updateDraft(db, auth, app, entry, expectedVersion, patch, key) {
  const res = await db.query(
    "select public.direct_entry_update_draft_row($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::jsonb,$6::text) as data",
    [auth, app, entry, expectedVersion, JSON.stringify(patch), key],
  );
  return res.rows[0].data;
}
function fullPatch(overrides) {
  return {
    project_id: "proj_a",
    first_work_date: PRE_SCOPE_DATE,
    employee_code: "hrp-2026-100000",
    worker_details: { display_name: "Worker hrp-2026-100000" },
    recruiter_id: REC_OWN,
    labor_type: "TEMPORARY",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Deterministic scope precedence (all > team > own).
// ---------------------------------------------------------------------------
test("W07D scope precedence: zero/one/many effective scopes resolve deterministically", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedScopeMatrix(db);
    await assert.rejects(
      () => scopeProbe(db, S0, S0, S0, TEAM_A, SCOPE_START),
      (error) => error.code === "42501",
      "zero effective scope must fail closed",
    );
    assert.equal(await scopeProbe(db, S1, S1, S1, TEAM_A, SCOPE_START), "own");
    assert.equal(await scopeProbe(db, S2, S2, S2, TEAM_A, SCOPE_START), "team");
    assert.equal(await scopeProbe(db, S3, S3, S3, TEAM_A, SCOPE_START), "all");
    assert.equal(await scopeProbe(db, S4, S4, S4, TEAM_A, SCOPE_START), "all", "own + all must resolve to all");
    assert.equal(await scopeProbe(db, S5, S5, S5, TEAM_A, SCOPE_START), "team", "own + team must resolve to team");
    assert.equal(await scopeProbe(db, S6, S6, S6, TEAM_A, SCOPE_START), "all", "own + team + all must resolve to all");
    // A team grant for another team must not match this resource.
    await assert.rejects(
      () => scopeProbe(db, S2, S2, S2, TEAM_B, SCOPE_START),
      (error) => error.code === "42501",
    );
  } finally {
    await db.close();
  }
});

test("W07D scope precedence: the capability of the winning scope kind must still be effective", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    // APP_NOCAP holds an 'all' scope but no capability grant at all.
    await assert.rejects(
      () => scopeProbe(db, AUTH_NOCAP, APP_NOCAP, APP_NOCAP, TEAM_A, SCOPE_START),
      (error) => error.code === "42501",
    );
    // An own capability does not pay for the winning 'all' scope.
    await db.query("insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from) values ($1,'entry_own','2020-01-01')", [APP_NOCAP]);
    await assert.rejects(
      () => scopeProbe(db, AUTH_NOCAP, APP_NOCAP, APP_NOCAP, TEAM_A, SCOPE_START),
      (error) => error.code === "42501",
      "the winning kind's own capability must be required",
    );
    await db.query("insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from) values ($1,'entry_admin','2020-01-01')", [APP_NOCAP]);
    assert.equal(await scopeProbe(db, AUTH_NOCAP, APP_NOCAP, APP_NOCAP, TEAM_A, SCOPE_START), "all");
    // A capability that is not effective today does not count either.
    await db.query("update public.direct_entry_capability_grants set valid_to='2026-01-01' where app_user_id=$1 and capability='entry_admin'", [APP_NOCAP]);
    await assert.rejects(
      () => scopeProbe(db, AUTH_NOCAP, APP_NOCAP, APP_NOCAP, TEAM_A, SCOPE_START),
      (error) => error.code === "42501",
    );
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Draft listing over the imported historical batch.
// ---------------------------------------------------------------------------
test("W07D draft listing: the 14 + 3 import batch is fail-closed before the historical scope and complete after it", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedImportedBatch(db);
    // Production shape: the 3 rows inside the scope window match BOTH the own and
    // the all grant, which used to make the whole list raise 42501. They now
    // resolve to the strongest scope and the request succeeds.
    assert.equal(await scopeProbe(db, AUTH_OWNER, APP_OWNER, APP_OWNER, TEAM_A, POST_SCOPE_DATE), "all");
    const partial = await listDrafts(db, AUTH_OWNER, APP_OWNER);
    // Fail-closed: rows no effective grant covers are NOT returned (they are not
    // authorized), so the precedence fix never widens the projection.
    assert.equal(partial.drafts.length, 3, "rows outside every effective grant must not be listed");
    assert.equal(partial.drafts.every((d) => d.first_work_date === POST_SCOPE_DATE), true);
    assert.equal(partial.drafts.some((d) => d.first_work_date === PRE_SCOPE_DATE), false);
    // Extending the historical scope is what makes the import batch visible again.
    await extendHistoricalAllScope(db);
    const listed = await listDrafts(db, AUTH_OWNER, APP_OWNER);
    assert.equal(listed.drafts.length, 17, "all 17 persisted drafts must be visible");
    assert.equal(new Set(listed.drafts.map((d) => d.entry_id)).size, 17);
    assert.equal(listed.drafts.filter((d) => d.first_work_date === PRE_SCOPE_DATE).length, 14);
    assert.equal(listed.drafts.filter((d) => d.first_work_date === POST_SCOPE_DATE).length, 3);
    assert.equal(listed.drafts.every((d) => d.recruiter_id === REC_OWN), true);
    assert.equal(listed.drafts.every((d) => d.project_id === "proj_a"), true);
    assert.equal(listed.drafts.every((d) => d.team_id === TEAM_A), true);
  } finally {
    await db.close();
  }
});

test("W07D draft listing: PII follows pii_view and no raw provider wording leaks", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedImportedBatch(db);
    await extendHistoricalAllScope(db);
    const listed = await listDrafts(db, AUTH_OWNER, APP_OWNER);
    const first = listed.drafts[0];
    // The owner holds pii_view, so the display name is projected as provided.
    assert.equal(first.worker_display_name.length > 0, true);
    assert.equal(first.profile.worker_details.display_name.state, "provided");
    assert.equal(first.profile.worker_details.national_id.state, "omitted");
  } finally {
    await db.close();
  }
});

test("W07D draft listing: disabled and forged actors stay fail-closed", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedImportedBatch(db);
    await extendHistoricalAllScope(db);
    await db.query("update public.direct_entry_app_users set enabled=false where app_user_id=$1", [APP_DISABLED]);
    await assert.rejects(
      () => listDrafts(db, AUTH_DISABLED, APP_DISABLED),
      (error) => error.code === "42501",
    );
    await assert.rejects(
      () => listDrafts(db, AUTH_FORGED, APP_OWNER),
      (error) => error.code === "42501",
      "a forged auth subject must not borrow the owner app user",
    );
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Historical draft edit decoupling.
// ---------------------------------------------------------------------------
async function seedEditableDraft(db, overrides) {
  const entry = overrides.entry;
  await insertDraft(db, {
    entry,
    sub: overrides.sub,
    cand: overrides.cand,
    createdBy: APP_OWNER,
    project: overrides.project ?? "proj_a",
    date: overrides.date ?? PRE_SCOPE_DATE,
    code: overrides.code,
    recruiter: overrides.recruiter ?? REC_OWN,
    team: overrides.team ?? TEAM_A,
    provider: overrides.provider ?? "hrp",
    labor: overrides.labor ?? "TEMPORARY",
  });
  return entry;
}

test("W07D draft update: a historical row saves name and labor type without backdating memberships", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await extendHistoricalAllScope(db);
    const entry = await seedEditableDraft(db, { entry: uuid(1200), sub: uuid(2200), cand: uuid(3200), code: "hrp-2026-300000" });
    const result = await updateDraft(db, AUTH_OWNER, APP_OWNER, entry, 1, fullPatch({
      employee_code: "hrp-2026-300000",
      worker_details: { display_name: "Nguyen Van Approved Rename" },
      labor_type: "PERMANENT",
    }), "w07d-edit-historical");
    assert.equal(result.version, 2);
    const row = await db.query(
      "select e.recruiter_id, e.team_id, e.provider_type, e.project_id, e.first_work_date::text as d, e.labor_type, e.worker_details->>'display_name' as name" +
      " from public.direct_entries e where e.entry_id = $1",
      [entry],
    );
    assert.equal(row.rows[0].name, "Nguyen Van Approved Rename");
    assert.equal(row.rows[0].labor_type, "PERMANENT");
    assert.equal(row.rows[0].recruiter_id, REC_OWN, "recruiter must survive the edit");
    assert.equal(row.rows[0].team_id, TEAM_A, "team must survive the edit");
    assert.equal(row.rows[0].provider_type, "hrp");
    assert.equal(row.rows[0].project_id, "proj_a");
    assert.equal(row.rows[0].d, PRE_SCOPE_DATE);
  } finally {
    await db.close();
  }
});

test("W07D draft update: changing first_work_date keeps recruiter, project and provider", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await extendHistoricalAllScope(db);
    const entry = await seedEditableDraft(db, { entry: uuid(1201), sub: uuid(2201), cand: uuid(3201), code: "hrp-2026-300001" });
    await updateDraft(db, AUTH_OWNER, APP_OWNER, entry, 1, fullPatch({
      employee_code: "hrp-2026-300001",
      first_work_date: POST_SCOPE_DATE,
    }), "w07d-edit-date");
    const row = await db.query(
      "select recruiter_id, team_id, provider_type, project_id, first_work_date::text as d from public.direct_entries where entry_id = $1",
      [entry],
    );
    assert.equal(row.rows[0].d, POST_SCOPE_DATE);
    assert.equal(row.rows[0].recruiter_id, REC_OWN);
    assert.equal(row.rows[0].team_id, TEAM_A);
    assert.equal(row.rows[0].provider_type, "hrp");
    assert.equal(row.rows[0].project_id, "proj_a");
  } finally {
    await db.close();
  }
});

test("W07D draft update: forged project or recruiter is still denied actor-scoped", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await extendHistoricalAllScope(db);
    const forgedProject = await seedEditableDraft(db, { entry: uuid(1202), sub: uuid(2202), cand: uuid(3202), code: "hrp-2026-300002" });
    await assert.rejects(
      () => updateDraft(db, AUTH_OWNER, APP_OWNER, forgedProject, 1, fullPatch({
        employee_code: "hrp-2026-300002", project_id: "proj_missing",
      }), "w07d-forged-project"),
      (error) => error.code === "22023",
    );
  } finally {
    await db.close();
  }
});

test("W07D draft update: an unchanged Vendor recruiter keeps the stored team and provider", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await extendHistoricalAllScope(db);
    const entry = await seedEditableDraft(db, {
      entry: uuid(1203), sub: uuid(2203), cand: uuid(3203), code: "hrp-2026-300003",
      recruiter: REC_VENDOR_TEAMED, team: TEAM_B, provider: "vendor",
    });
    // The patch repeats recruiter_id and first_work_date unchanged, which used to
    // re-derive the identity from the patch shape alone.
    await updateDraft(db, AUTH_OWNER, APP_OWNER, entry, 1, fullPatch({
      employee_code: "hrp-2026-300003",
      recruiter_id: REC_VENDOR_TEAMED,
      worker_details: { display_name: "Vendor Row Renamed" },
    }), "w07d-vendor-unchanged");
    const row = await db.query(
      "select recruiter_id, team_id, provider_type, worker_details->>'display_name' as name from public.direct_entries where entry_id = $1",
      [entry],
    );
    assert.equal(row.rows[0].recruiter_id, REC_VENDOR_TEAMED);
    assert.equal(row.rows[0].team_id, TEAM_B, "the stored team must not be recomputed");
    assert.equal(row.rows[0].provider_type, "vendor");
    assert.equal(row.rows[0].name, "Vendor Row Renamed");
  } finally {
    await db.close();
  }
});

test("W07D draft update: a real work-date change re-derives the identity at the NEW date", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await extendHistoricalAllScope(db);
    // REC_MOVER belongs to TEAM_A until 2026-10-04 and to TEAM_B from then on.
    const entry = await seedEditableDraft(db, {
      entry: uuid(1205), sub: uuid(2205), cand: uuid(3205), code: "hrp-2026-300005",
      recruiter: REC_MOVER, team: TEAM_A, provider: "hrp",
    });
    // Repeating the unchanged work date must not rewrite anything.
    await updateDraft(db, AUTH_OWNER, APP_OWNER, entry, 1, fullPatch({
      employee_code: "hrp-2026-300005", recruiter_id: REC_MOVER,
      worker_details: { display_name: "Mover Row Renamed" },
    }), "w07d-mover-noop");
    const kept = await db.query("select team_id from public.direct_entries where entry_id = $1", [entry]);
    assert.equal(kept.rows[0].team_id, TEAM_A);
    // Moving the effective work date across the membership boundary must follow
    // the row's own date, exactly like direct_entry_validate_identity does.
    await updateDraft(db, AUTH_OWNER, APP_OWNER, entry, 2, fullPatch({
      employee_code: "hrp-2026-300005", recruiter_id: REC_MOVER,
      first_work_date: POST_SCOPE_DATE,
    }), "w07d-mover-date");
    const moved = await db.query(
      "select team_id, provider_type, recruiter_id from public.direct_entries where entry_id = $1",
      [entry],
    );
    assert.equal(moved.rows[0].team_id, TEAM_B, "the derived team must match the new work date");
    assert.equal(moved.rows[0].recruiter_id, REC_MOVER);
    assert.equal(moved.rows[0].provider_type, "hrp");
  } finally {
    await db.close();
  }
});

test("W07D draft update: a real Vendor recruiter change fails closed with a dedicated code", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await extendHistoricalAllScope(db);
    const entry = await seedEditableDraft(db, { entry: uuid(1204), sub: uuid(2204), cand: uuid(3204), code: "hrp-2026-300004" });
    await assert.rejects(
      () => updateDraft(db, AUTH_OWNER, APP_OWNER, entry, 1, fullPatch({
        employee_code: "hrp-2026-300004", recruiter_id: REC_VENDOR,
      }), "w07d-vendor-change"),
      (error) => error.code === "P0001" && /explicit team rule/.test(String(error.message)),
      "a Vendor recruiter change has no safe team rule and must fail closed",
    );
    const row = await db.query("select recruiter_id, team_id from public.direct_entries where entry_id = $1", [entry]);
    assert.equal(row.rows[0].recruiter_id, REC_OWN, "the denied change must not mutate the row");
    assert.equal(row.rows[0].team_id, TEAM_A);
    // A real HRP recruiter change resolves at the current date and succeeds.
    await updateDraft(db, AUTH_OWNER, APP_OWNER, entry, 1, fullPatch({
      employee_code: "hrp-2026-300004", recruiter_id: REC_OTHER,
    }), "w07d-hrp-change");
    const changed = await db.query("select recruiter_id, team_id, provider_type from public.direct_entries where entry_id = $1", [entry]);
    assert.equal(changed.rows[0].recruiter_id, REC_OTHER);
    assert.equal(changed.rows[0].team_id, TEAM_B, "a real change re-derives the current team");
    assert.equal(changed.rows[0].provider_type, "hrp");
  } finally {
    await db.close();
  }
});


