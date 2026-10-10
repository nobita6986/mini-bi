/**
 * P3.1-W02A - team-leader project-manager authority (focused PGlite lane).
 *
 * Applies the full append-only ledger, locks #1-#71 byte-for-byte to the
 * reviewed base, and covers the Admin / Accounting / own-team leader matrix.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const ROOT = process.cwd();
const MIGRATION_DIR = path.resolve("supabase/migrations");
const BASE_COMMIT = "1189c8a77decbecec0b402b72f428cb0525b460d";
const MIGRATION_71 = "20261009070000_p3_1_w01d_team_leader_lifecycle.sql";
const MIGRATION_72 =
  "20261009080000_p3_1_w02a_team_leader_project_manager_authority.sql";
const MIGRATION = (await readFile(path.join(MIGRATION_DIR, MIGRATION_72), "utf8"))
  .replaceAll("\r\n", "\n");
const MUTATION = process.env.P3_1_W02A_MUTATION;
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";
const TEAM_A = uuid(11), TEAM_B = uuid(12);
const PROJECT_ACTIVE = "w02a-active";
const PROJECT_INACTIVE = "w02a-inactive";
const PAST = "2020-01-01";

function uuid(n) {
  return "12000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, "mutation anchor must be unique");
  return source.replace(before, after);
}

function functionBody(source, name, mutate) {
  const start = source.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `function ${name} exists`);
  const bodyStart = source.indexOf("as $$", start) + "as $$".length;
  const bodyEnd = source.indexOf("\n$$;", bodyStart);
  assert.ok(bodyStart > "as $$".length && bodyEnd > bodyStart, `${name} has a body`);
  return source.slice(0, bodyStart) + mutate(source.slice(bodyStart, bodyEnd))
    + source.slice(bodyEnd);
}

function mutateMigration(source) {
  switch (MUTATION) {
    case undefined:
      return source;
    case "candidate-pii":
      return functionBody(source, "direct_entry_list_project_manager_candidates", (body) =>
        replaceOnce(body,
          "'personnel_position', r.personnel_position",
          "'personnel_position', r.personnel_position, 'app_user_id', r.recruiter_id"));
    case "candidate-cross-team":
      return functionBody(source, "direct_entry_list_project_manager_candidates", (body) =>
        body.replaceAll("v_authority <> 'team_manager_assign'", "true"));
    case "candidate-acl":
      return replaceOnce(source,
        "grant execute on function public.direct_entry_list_project_manager_candidates(uuid, uuid, text)\n"
          + "  to service_role;",
        "grant execute on function public.direct_entry_list_project_manager_candidates(uuid, uuid, text)\n"
          + "  to authenticated;");
    case "post-lock-recheck":
      return functionBody(source, "direct_entry_assign_project_manager", (body) =>
        replaceOnce(body,
          "  if not v_project.active then\n"
            + "    raise exception 'project is not active' using errcode = '22023';\n"
            + "  end if;\n"
            + "  if v_authority = 'team_manager_assign' then\n"
            + "    v_team_id := public.direct_entry_assert_team_leader_read_authority(\n"
            + "      p_auth_subject, p_app_user_id, null\n"
            + "    );",
          "  if not v_project.active then\n"
            + "    raise exception 'project is not active' using errcode = '22023';\n"
            + "  end if;\n"
            + "  if v_authority = 'team_manager_assign' then\n"
            + "    v_team_id := null;"));
    case "audit-label":
      return functionBody(source, "direct_entry_assign_project_manager", (body) =>
        replaceOnce(body, "v_authority, v_assignment_id::text,", "'entry_admin', v_assignment_id::text,"));
    case "project-read-flags":
      return replaceOnce(source,
        "'can_manage_project_master', v_authority <> 'team_manager_assign'",
        "'can_manage_project_master', true");
    case "legacy-entry-admin":
      return replaceOnce(source,
        "perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);",
        "perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'catalog_master_manage');");
    case "candidate-enabled-account":
      return functionBody(source, "direct_entry_list_project_manager_candidates", (body) =>
        replaceOnce(body, "and au.enabled", "and true"));
    case "candidate-provider-count":
      return functionBody(source, "direct_entry_list_project_manager_candidates", (body) =>
        replaceOnce(body,
          "select count(*)::int\n               from public.recruiter_provider_memberships m\n              where m.recruiter_id = r.recruiter_id\n                and m.valid_from <= public.direct_entry_authorization_date()",
          "select 1::int\n               from public.recruiter_provider_memberships m\n              where m.recruiter_id = r.recruiter_id\n                and m.valid_from <= public.direct_entry_authorization_date()"));
    default:
      throw new Error(`unknown W02A mutation: ${MUTATION}`);
  }
}

function sourceAssertions(source) {
  assert.match(source, /direct_entry_assert_team_leader_read_authority/);
  assert.match(source, /direct_entry_assert_project_operation_authority/);
  assert.match(source, /direct_entry_lock_project_team_manager_context/);
  assert.doesNotMatch(source,
    /create(?:\s+or\s+replace)?\s+function\s+public\.direct_entry_assert_project_admin\s*\(/i);
  assert.match(source, /'can_manage_project_master', v_authority <> 'team_manager_assign'/);
  assert.match(source, /'can_assign_managers', true/);
  assert.match(source, /perform public\.direct_entry_assert_project_admin\(p_auth_subject, p_app_user_id\)/);
  assert.doesNotMatch(source,
    /create(?:\s+or\s+replace)?\s+function\s+public\.direct_entry_assert_team_manager_assign\s*\(/i);
  assert.match(source,
    /v_authority,\s*v_assignment_id::text,[\s\S]*?scope_team_id,[\s\S]*?case when v_authority = 'team_manager_assign' then 'team' else 'all' end/);
  assert.match(source, /v_authority,\s*p_assignment_id::text,/);
  assert.match(source, /scope_team_id/);
  assert.match(source,
    /case when v_authority = 'team_manager_assign' then 'team' else 'all' end/);
  assert.match(source, /v_project := public\.direct_entry_lock_project/);
  assert.match(source, /select \* into v_assignment[\s\S]*?for update/);
  const candidate = functionBody(source, "direct_entry_list_project_manager_candidates", (body) => body);
  assert.doesNotMatch(candidate, /'auth_subject'\s*,|'app_user_id'\s*,|'email'\s*,/);
  assert.match(candidate, /recruiter_team_memberships/);
  assert.match(candidate, /direct_entry_assert_project_operation_authority/);
  assert.match(candidate, /count\(\*\).*verified/is);
  assert.match(candidate, /direct_entry_app_users/);
  assert.match(candidate, /recruiter_provider_memberships/);
  assert.match(candidate, /enabled/);
}

async function ledgerNames() {
  return (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

async function assertPriorMigrationsUnchanged(names) {
  const baseline = execFileSync("git", [
    "ls-tree", "-r", "--name-only", BASE_COMMIT, "--", "supabase/migrations",
  ], { cwd: ROOT, encoding: "utf8" }).trim().split(/\r?\n/)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => path.basename(name));
  assert.equal(baseline.length, 71, "reviewed base inventory is exactly #1-#71");
  assert.equal(names.length, 74, "working ledger carries W02-A #72, alias hotfix #73 and P3.1-HF #74");
  assert.deepEqual(names.slice(0, 71), baseline, "migrations #1-#71 remain the baseline");
  assert.equal(names.at(-4), MIGRATION_71);
  assert.equal(names.at(-3), MIGRATION_72);
  for (const name of baseline) {
    const relative = `supabase/migrations/${name}`;
    const tracked = execFileSync("git", ["show", `${BASE_COMMIT}:${relative}`], {
      cwd: ROOT,
      encoding: "buffer",
    });
    const local = await readFile(path.join(MIGRATION_DIR, name));
    assert.deepEqual(local, tracked, `${name} remains byte-identical to the base`);
  }
}

async function functionInventory(db) {
  const { rows } = await db.query(`
    select count(*)::int as total,
           count(*) filter (
             where has_function_privilege('service_role', p.oid, 'EXECUTE')
           )::int as service_role,
           count(*) filter (
             where not has_function_privilege('service_role', p.oid, 'EXECUTE')
           )::int as internal
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'direct_entry\\_%'
  `);
  return rows[0];
}

async function buildDb() {
  const names = await ledgerNames();
  await assertPriorMigrationsUnchanged(names);
  sourceAssertions(MIGRATION);
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  for (const name of names.slice(0, 71)) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  const before = await functionInventory(db);
  await db.exec(mutateMigration(MIGRATION));
  const after = await functionInventory(db);
  assert.equal(after.total, before.total + 2, "#72 adds only the internal authority and lock helpers");
  assert.equal(after.internal, before.internal + 2);
  assert.equal(after.service_role, before.service_role);
  return { db, names, inventory: after };
}

async function addActor(db, id, capabilities = [], teamScope = null, enabled = true) {
  const actor = { auth: uuid(100 + id), app: uuid(200 + id) };
  await db.query("insert into auth.users(id) values ($1::uuid)", [actor.auth]);
  await db.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name)"
      + " values ($1::uuid,$2::uuid,$3,'Synthetic Account')",
    [actor.app, actor.auth, enabled]);
  for (const capability of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)"
        + " values ($1::uuid,$2,$3::date)",
      [actor.app, capability, PAST]);
  }
  if (teamScope) {
    await db.query(
      "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from)"
        + " values ($1::uuid,'team',$2::uuid,$3::date)",
      [actor.app, teamScope, PAST]);
  } else if (capabilities.length) {
    await db.query(
      "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from)"
        + " values ($1::uuid,'all',$2::date)",
      [actor.app, PAST]);
  }
  return actor;
}

async function addManager(db, id, team, name, { active = true } = {}) {
  const actor = await addActor(db, id);
  const recruiter = uuid(300 + id);
  await db.query(
    "insert into public.recruiters"
      + "(recruiter_id,display_name,personnel_code,personnel_position,active)"
      + " values ($1::uuid,$2,$3,'STAFF',$4)",
    [recruiter, name, `staff-${id}`, active]);
  await db.query(
    "insert into public.recruiter_provider_memberships"
      + "(recruiter_id,provider_type,valid_from) values ($1::uuid,'hrp',$2::date)",
    [recruiter, PAST]);
  if (team) {
    await db.query(
      "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)"
        + " values ($1::uuid,$2::uuid,$3::date)",
      [recruiter, team, PAST]);
  }
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links"
      + "(app_user_id,recruiter_id,verified,valid_from) values ($1::uuid,$2::uuid,true,$3::date)",
    [actor.app, recruiter, PAST]);
  return { ...actor, recruiter, team };
}

async function withDisabledTriggers(db, table, callback) {
  await db.exec(`alter table public.${table} disable trigger user`);
  try {
    await callback();
  } finally {
    await db.exec(`alter table public.${table} enable trigger user`);
  }
}

async function seed(db) {
  await db.query(
    "insert into public.teams(team_id,code,display_name,active) values"
      + " ($1::uuid,'W02A_A','Team A',true),($2::uuid,'W02A_B','Team B',true)",
    [TEAM_A, TEAM_B]);
  const admin = await addActor(db, 1, [
    "entry_admin", "recruiter_master_manage", "team_master_manage",
  ]);
  const accounting = await addActor(db, 2, ["catalog_master_manage"]);
  const leader = await addActor(db, 3, ["team_manager_assign"], TEAM_A);
  const legacyAdmin = await addActor(db, 7, ["entry_admin"]);
  const staff = await addActor(db, 8, ["entry_create"]);
  const projectManager = await addActor(db, 9, ["change_request_create"]);
  const disabledActor = await addActor(db, 10, ["team_manager_assign"], TEAM_A, false);
  const ambiguousLeader = await addActor(db, 11, ["team_manager_assign"], TEAM_A);
  await withDisabledTriggers(db, "direct_entry_scope_grants", () => db.query(
    "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from)"
      + " values ($1::uuid,'team',$2::uuid,$3::date)",
    [ambiguousLeader.app, TEAM_B, PAST]));
  const managerA = await addManager(db, 4, TEAM_A, "Own Team Manager");
  const managerB = await addManager(db, 5, TEAM_B, "Other Team Manager");
  const managerC = await addManager(db, 6, TEAM_A, "Second Own Team Manager");
  const managerDisabledAccount = await addManager(db, 12, TEAM_A, "Disabled Linked Account");
  await db.query("update public.direct_entry_app_users set enabled=false where app_user_id=$1::uuid",
    [managerDisabledAccount.app]);
  const managerMultipleLinks = await addManager(db, 13, TEAM_A, "Multiple Verified Links");
  const secondLink = await addActor(db, 14);
  await withDisabledTriggers(db, "direct_entry_app_user_recruiter_links", () => db.query(
    "insert into public.direct_entry_app_user_recruiter_links"
      + "(app_user_id,recruiter_id,verified,valid_from) values ($1::uuid,$2::uuid,true,$3::date)",
    [secondLink.app, managerMultipleLinks.recruiter, "2020-01-02"]));
  const managerNoProvider = await addManager(db, 15, TEAM_A, "No Provider");
  await db.query("delete from public.recruiter_provider_memberships where recruiter_id=$1::uuid",
    [managerNoProvider.recruiter]);
  const managerWrongProvider = await addManager(db, 16, TEAM_A, "Non-HRP Provider");
  await db.query(
    "insert into public.vendors(vendor_id,display_name) values ('w02a-test-vendor','W02A test')",
  );
  await db.query(
    "update public.recruiter_provider_memberships set provider_type='vendor',vendor_id='w02a-test-vendor'"
      + " where recruiter_id=$1::uuid",
    [managerWrongProvider.recruiter]);
  const managerMultipleProviders = await addManager(db, 21, TEAM_A, "Multiple Providers");
  await withDisabledTriggers(db, "recruiter_provider_memberships", () => db.query(
    "insert into public.recruiter_provider_memberships"
      + "(recruiter_id,provider_type,valid_from) values ($1::uuid,'hrp',$2::date)",
    [managerMultipleProviders.recruiter, "2020-01-02"]));
  const managerNoMembership = await addManager(db, 17, null, "No Membership");
  const managerWrongMembership = await addManager(db, 18, TEAM_B, "Wrong Membership");
  const managerAmbiguousMembership = await addManager(db, 19, TEAM_A, "Multiple Memberships");
  await withDisabledTriggers(db, "recruiter_team_memberships", () => db.query(
    "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)"
      + " values ($1::uuid,$2::uuid,$3::date)",
    [managerAmbiguousMembership.recruiter, TEAM_B, "2020-01-02"]));
  const managerInactive = await addManager(
    db, 20, TEAM_A, "Inactive Recruiter", { active: false },
  );
  const leaderRecruiter = uuid(303);
  await db.query(
    "insert into public.recruiters"
      + "(recruiter_id,display_name,personnel_code,personnel_position,active)"
      + " values ($1::uuid,'Team Leader','leader-3','TEAM_LEADER',true)",
    [leaderRecruiter]);
  await db.query(
    "insert into public.recruiter_provider_memberships"
      + "(recruiter_id,provider_type,valid_from) values ($1::uuid,'hrp',$2::date)",
    [leaderRecruiter, PAST]);
  await db.query(
    "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)"
      + " values ($1::uuid,$2::uuid,$3::date)",
    [leaderRecruiter, TEAM_A, PAST]);
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links"
      + "(app_user_id,recruiter_id,verified,valid_from) values ($1::uuid,$2::uuid,true,$3::date)",
    [leader.app, leaderRecruiter, PAST]);
  await db.exec("begin");
  await db.query("select set_config('direct_entry.team_leader_marker','on',true)");
  await db.query(
    "insert into public.direct_entry_team_leader_assignments"
      + "(team_id,leader_app_user_id,leader_recruiter_id,valid_from)"
      + " values ($1::uuid,$2::uuid,$3::uuid,$4::date)",
    [TEAM_A, leader.app, leaderRecruiter, PAST]);
  await db.exec("commit");

  await db.query(
    "insert into public.direct_entry_projects(project_id,display_name,active,version)"
      + " values ($1,'Active Project',true,1),($2,'Inactive Project',false,1)",
    [PROJECT_ACTIVE, PROJECT_INACTIVE]);
  return {
    admin, accounting, leader, legacyAdmin, staff, projectManager, disabledActor,
    ambiguousLeader, managerA, managerB, managerC, secondLink,
    invalidManagers: [
      managerDisabledAccount, managerMultipleLinks, managerNoProvider, managerWrongProvider,
      managerMultipleProviders, managerNoMembership, managerWrongMembership,
      managerAmbiguousMembership, managerInactive,
    ],
  };
}

async function call(db, sql, values) {
  const { rows } = await db.query(sql, values);
  return rows[0].data;
}

const candidateList = (db, actor, search = null) => call(db,
  "select public.direct_entry_list_project_manager_candidates($1::uuid,$2::uuid,$3::text) as data",
  [actor.auth, actor.app, search]);
const assignmentList = (db, actor, project = null, history = true) => call(db,
  "select public.direct_entry_list_project_manager_assignments($1::uuid,$2::uuid,$3::text,$4::boolean) as data",
  [actor.auth, actor.app, project, history]);
const projectList = (db, actor, includeInactive) => call(db,
  "select public.direct_entry_list_projects_admin($1::uuid,$2::uuid,$3::boolean) as data",
  [actor.auth, actor.app, includeInactive]);
const projectGet = (db, actor, project) => call(db,
  "select public.direct_entry_get_project_admin($1::uuid,$2::uuid,$3::text) as data",
  [actor.auth, actor.app, project]);

async function projectVersion(db, project) {
  const { rows } = await db.query(
    "select version from public.direct_entry_projects where project_id = $1", [project]);
  return rows[0].version;
}

async function assign(db, actor, project, recruiter, version, key, validFrom = null) {
  return call(db,
    "select public.direct_entry_assign_project_manager($1::uuid,$2::uuid,$3::text,$4::uuid,$5::date,$6::integer,$7::text,$8::text) as data",
    [actor.auth, actor.app, project, recruiter, validFrom, version, "approved assignment", key]);
}

async function unassign(db, actor, assignment, assignmentVersion, version, key) {
  return call(db,
    "select public.direct_entry_unassign_project_manager($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::integer,$6::text,$7::text) as data",
    [actor.auth, actor.app, assignment, assignmentVersion, version, "approved revocation", key]);
}

async function createProject(db, actor, project, key) {
  return call(db,
    "select public.direct_entry_create_project($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::text) as data",
    [actor.auth, actor.app, project, "New Project", "approved project creation", key]);
}

async function updateProject(db, actor, project, version, name, key) {
  return call(db,
    "select public.direct_entry_update_project($1::uuid,$2::uuid,$3::text,$4::integer,$5::text,$6::text,$7::text) as data",
    [actor.auth, actor.app, project, version, name, "approved project update", key]);
}

async function setProjectActive(db, actor, project, active, version, key) {
  return call(db,
    "select public.direct_entry_set_project_active($1::uuid,$2::uuid,$3::text,$4::boolean,$5::integer,$6::text,$7::text) as data",
    [actor.auth, actor.app, project, active, version, "approved lifecycle change", key]);
}

async function auditFor(db, action, resource) {
  const { rows } = await db.query(
    "select capability,scope_kind,scope_team_id from public.direct_entry_audit_events"
      + " where action=$1 and resource_ref=$2 order by created_at desc limit 1",
    [action, resource]);
  assert.equal(rows.length, 1, `audit exists for ${action}/${resource}`);
  return rows[0];
}

async function mutationState(db, project) {
  const { rows } = await db.query(`
    select
      (select count(*)::int from public.direct_entry_project_manager_assignments) as assignments,
      (select version from public.direct_entry_projects where project_id=$1) as project_version,
      (select count(*)::int from public.direct_entry_project_revisions where project_id=$1) as revisions,
      (select count(*)::int from public.direct_entry_audit_events) as audits,
      (select count(*)::int from public.direct_entry_rpc_idempotency) as idempotency
  `, [project]);
  return rows[0];
}

async function denied(callback, code = "42501") {
  await assert.rejects(callback, (error) => error.code === code);
}

test("P3.1-W02A: append-only ledger, source and baseline identity guards", async () => {
  const names = await ledgerNames();
  await assertPriorMigrationsUnchanged(names);
  sourceAssertions(MIGRATION);
});

test("P3.1-W02A: PGlite authority matrix, scoped projections and audited mutations", async () => {
  const { db, names, inventory } = await buildDb();
  assert.equal(names.length, 74);
  assert.equal(names.at(-3), MIGRATION_72);
  assert.equal(names.at(-4), MIGRATION_71);
  assert.ok(inventory.total > 0);
  const actors = await seed(db);
  const {
    admin, accounting, leader, legacyAdmin, staff, projectManager, disabledActor,
    ambiguousLeader, managerA, managerB, managerC, invalidManagers,
  } = actors;
  const guardSource = (await db.query(
    "select pg_get_functiondef('public.direct_entry_assert_project_admin(uuid,uuid)'::regprocedure) as source",
  )).rows[0].source;
  assert.match(guardSource, /direct_entry_assert_actor/);
  assert.doesNotMatch(guardSource, /direct_entry_assert_catalog_operator/);

  const allCandidates = await candidateList(db, admin);
  const accountingCandidates = await candidateList(db, accounting);
  const legacyCandidates = await candidateList(db, legacyAdmin);
  const teamCandidates = await candidateList(db, leader);
  assert.deepEqual(accountingCandidates, allCandidates);
  await denied(() => call(db,
    "select public.direct_entry_lookup_worker_episodes($1::uuid,$2::uuid,$3::text,$4::text,$5::text) as data",
    [accounting.auth, accounting.app, PROJECT_ACTIVE, "Worker", "123456789012"]), "42501");
  assert.deepEqual(legacyCandidates, allCandidates);
  assert.deepEqual(
    teamCandidates.candidates.map((candidate) => candidate.recruiter_id).sort(),
    [managerA.recruiter, managerC.recruiter, uuid(303)].sort(),
  );
  assert.equal(invalidManagers.some((manager) =>
    teamCandidates.candidates.some((candidate) => candidate.recruiter_id === manager.recruiter)),
  false, "leader candidates exclude disabled, ambiguous or ineligible recruiters");
  for (const candidate of teamCandidates.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), [
      "display_name", "personnel_code", "personnel_position", "recruiter_id",
    ]);
    for (const key of ["app_user_id", "auth_subject", "email"]) {
      assert.equal(key in candidate, false, `candidate omits ${key}`);
    }
  }
  assert.equal((await candidateList(db, leader, "Other Team")).candidates.length, 0);
  await denied(() => candidateList(db, { auth: null, app: null }));
  const unmappedActor = { auth: uuid(9999), app: staff.app };
  for (const actor of [staff, projectManager, disabledActor, ambiguousLeader, unmappedActor]) {
    await denied(() => candidateList(db, actor));
    await denied(() => assignmentList(db, actor));
    await denied(() => projectList(db, actor, true));
    await denied(() => projectGet(db, actor, PROJECT_ACTIVE));
  }

  const listedAdmin = await projectList(db, admin, true);
  const listedAccounting = await projectList(db, accounting, true);
  const listedLegacyAdmin = await projectList(db, legacyAdmin, true);
  const listedLeader = await projectList(db, leader, true);
  assert.equal(listedAdmin.projects.length, 2);
  assert.deepEqual(listedAccounting.projects, listedAdmin.projects);
  assert.deepEqual(listedLegacyAdmin.projects, listedAdmin.projects);
  for (const project of listedAdmin.projects) {
    assert.equal(project.can_manage_project_master, true);
    assert.equal(project.can_assign_managers, true);
  }
  for (const project of listedAccounting.projects) {
    assert.equal(project.can_manage_project_master, true);
    assert.equal(project.can_assign_managers, true);
  }
  for (const project of listedLegacyAdmin.projects) {
    assert.equal(project.can_manage_project_master, true);
    assert.equal(project.can_assign_managers, true);
  }
  assert.deepEqual(listedLeader.projects.map((project) => project.project_id), [PROJECT_ACTIVE]);
  for (const project of listedLeader.projects) {
    assert.equal(project.can_manage_project_master, false);
    assert.equal(project.can_assign_managers, true);
  }
  const adminProject = await projectGet(db, admin, PROJECT_ACTIVE);
  const accountingProject = await projectGet(db, accounting, PROJECT_ACTIVE);
  const legacyProject = await projectGet(db, legacyAdmin, PROJECT_ACTIVE);
  const leaderProject = await projectGet(db, leader, PROJECT_ACTIVE);
  await denied(() => projectGet(db, leader, PROJECT_INACTIVE), "P0002");
  for (const project of [adminProject, accountingProject, legacyProject]) {
    assert.equal(project.can_manage_project_master, true);
    assert.equal(project.can_assign_managers, true);
  }
  for (const project of [leaderProject]) {
    assert.equal(project.can_manage_project_master, false);
    assert.equal(project.can_assign_managers, true);
  }

  const adminCreated = await createProject(db, admin, "w02a-admin-created", "admin-create");
  const accountingCreated = await createProject(
    db, accounting, "w02a-accounting-created", "accounting-create",
  );
  const legacyCreated = await createProject(
    db, legacyAdmin, "w02a-legacy-created", "legacy-create",
  );
  assert.equal(adminCreated.created, true);
  assert.equal(accountingCreated.created, true);
  assert.equal(legacyCreated.created, true);
  assert.equal((await auditFor(db, "project_create", "w02a-admin-created")).capability, "entry_admin");
  assert.equal((await auditFor(db, "project_create", "w02a-legacy-created")).capability, "entry_admin");
  assert.equal(
    (await auditFor(db, "project_create", "w02a-accounting-created")).capability,
    "catalog_master_manage",
  );
  await updateProject(db, accounting, "w02a-accounting-created", 1, "Accounting renamed", "accounting-update");
  assert.equal(
    (await auditFor(db, "project_update", "w02a-accounting-created")).capability,
    "catalog_master_manage",
  );
  await setProjectActive(
    db, accounting, "w02a-accounting-created", false, 2, "accounting-deactivate",
  );
  assert.equal(
    (await auditFor(db, "project_set_active", "w02a-accounting-created")).capability,
    "catalog_master_manage",
  );
  await denied(() => createProject(db, leader, "leader-forbidden-project", "leader-create"));
  await denied(() => updateProject(db, leader, PROJECT_ACTIVE, 1, "Leader rename", "leader-update"));
  await denied(() => setProjectActive(db, leader, PROJECT_ACTIVE, false, 1, "leader-set-active"));

  const first = await assign(
    db, admin, PROJECT_ACTIVE, managerA.recruiter, 1, "admin-assign-a",
  );
  const second = await assign(
    db, accounting, PROJECT_ACTIVE, managerB.recruiter, 2, "accounting-assign-b",
  );
  const legacyAssignment = await assign(
    db, legacyAdmin, "w02a-legacy-created", managerA.recruiter, 1, "legacy-assign",
  );
  assert.equal((await auditFor(db, "project_manager_assignment_assign", first.assignment_id)).capability, "entry_admin");
  assert.deepEqual(await auditFor(
    db, "project_manager_assignment_assign", legacyAssignment.assignment_id,
  ), { capability: "entry_admin", scope_kind: "all", scope_team_id: null });
  const accountingAssignAudit = await auditFor(
    db, "project_manager_assignment_assign", second.assignment_id,
  );
  assert.equal(accountingAssignAudit.capability, "catalog_master_manage");
  assert.equal(accountingAssignAudit.scope_kind, "all");
  const beforeConflict = await mutationState(db, PROJECT_ACTIVE);
  await denied(() => assign(
    db, admin, PROJECT_ACTIVE, managerC.recruiter, 1, "admin-assign-a",
  ), "22023");
  assert.deepEqual(await mutationState(db, PROJECT_ACTIVE), beforeConflict,
    "reused idempotency key with different input leaves no residue");

  const adminAssignments = await assignmentList(db, admin, PROJECT_ACTIVE);
  const accountingAssignments = await assignmentList(db, accounting, PROJECT_ACTIVE);
  const legacyAssignments = await assignmentList(db, legacyAdmin, PROJECT_ACTIVE);
  const leaderAssignments = await assignmentList(db, leader, PROJECT_ACTIVE);
  assert.equal(adminAssignments.assignments.length, 2);
  assert.deepEqual(accountingAssignments.assignments, adminAssignments.assignments);
  assert.deepEqual(legacyAssignments.assignments, adminAssignments.assignments);
  assert.deepEqual(
    leaderAssignments.assignments.map((assignment) => assignment.manager_recruiter_id),
    [managerA.recruiter],
  );
  for (const assignment of leaderAssignments.assignments) {
    assert.equal("auth_subject" in assignment, false);
    assert.equal("email" in assignment, false);
  }

  const versionAfterTwo = await projectVersion(db, PROJECT_ACTIVE);
  for (const invalid of invalidManagers) {
    const before = await mutationState(db, PROJECT_ACTIVE);
    await denied(() => assign(
      db, leader, PROJECT_ACTIVE, invalid.recruiter, versionAfterTwo,
      `leader-invalid-${invalid.recruiter}`,
    ));
    assert.deepEqual(await mutationState(db, PROJECT_ACTIVE), before,
      "rejected candidate leaves no assignment, revision, audit or idempotency residue");
  }
  for (const actor of [staff, projectManager, disabledActor, ambiguousLeader, unmappedActor]) {
    await denied(() => assign(
      db, actor, PROJECT_ACTIVE, managerA.recruiter, versionAfterTwo,
      `denied-actor-${actor.app}`,
    ));
    await denied(() => unassign(
      db, actor, first.assignment_id, first.version, versionAfterTwo,
      `denied-unassign-${actor.app}`,
    ));
  }
  const third = await assign(
    db, leader, PROJECT_ACTIVE, managerC.recruiter, versionAfterTwo, "leader-assign-c",
  );
  const leaderAssignAudit = await auditFor(
    db, "project_manager_assignment_assign", third.assignment_id,
  );
  assert.deepEqual(leaderAssignAudit, {
    capability: "team_manager_assign",
    scope_kind: "team",
    scope_team_id: TEAM_A,
  });
  await denied(async () => assign(
    db, leader, PROJECT_ACTIVE, managerB.recruiter,
    await projectVersion(db, PROJECT_ACTIVE), "leader-cross-team",
  ));
  await denied(async () => assign(
    db, leader, PROJECT_INACTIVE, managerA.recruiter,
    await projectVersion(db, PROJECT_INACTIVE), "leader-inactive-project",
  ), "22023");

  const currentVersion = await projectVersion(db, PROJECT_ACTIVE);
  await denied(async () => assign(
    db, leader, PROJECT_ACTIVE, uuid(303), currentVersion - 1, "leader-stale-project",
  ), "40001");
  await denied(
    () => unassign(db, leader, first.assignment_id, first.version + 1, currentVersion, "leader-stale-assignment"),
    "40001",
  );
  const revokedA = await unassign(
    db, leader, first.assignment_id, first.version, currentVersion, "leader-unassign-a",
  );
  assert.equal(revokedA.already_unassigned, false);
  assert.equal(revokedA.valid_to, (await db.query(
    "select public.direct_entry_authorization_date()::text as today",
  )).rows[0].today);
  const leaderUnassignAudit = await auditFor(
    db, "project_manager_assignment_unassign", first.assignment_id,
  );
  assert.deepEqual(leaderUnassignAudit, {
    capability: "team_manager_assign",
    scope_kind: "team",
    scope_team_id: TEAM_A,
  });
  assert.deepEqual(
    await unassign(db, leader, first.assignment_id, first.version, currentVersion, "leader-unassign-a"),
    revokedA,
    "same idempotency key replays the same result",
  );
  const closedReplay = await unassign(
    db, leader, first.assignment_id, first.version + 1,
    await projectVersion(db, PROJECT_ACTIVE), "leader-unassign-already-closed",
  );
  assert.equal(closedReplay.already_unassigned, true);

  const selfAssignment = await assign(
    db, leader, PROJECT_ACTIVE, uuid(303), await projectVersion(db, PROJECT_ACTIVE),
    "leader-self-assign",
  );
  assert.equal(selfAssignment.already_assigned, false);

  await setProjectActive(db, admin, PROJECT_INACTIVE, true, 1, "admin-activate-for-assignment");
  const inactiveAssignment = await assign(
    db, admin, PROJECT_INACTIVE, managerA.recruiter, 2, "admin-future-assignment", "2099-01-01",
  );
  await setProjectActive(
    db, accounting, PROJECT_INACTIVE, false, 3, "accounting-deactivate-inactive-project",
  );
  const inactiveProjectVersion = await projectVersion(db, PROJECT_INACTIVE);
  await denied(() => projectGet(db, leader, PROJECT_INACTIVE), "P0002");
  await denied(() => assignmentList(db, leader, PROJECT_INACTIVE), "P0002");
  assert.equal(
    (await assignmentList(db, leader, null)).assignments.some(
      (assignment) => assignment.project_id === PROJECT_INACTIVE,
    ),
    false,
    "leader-wide assignment reads omit inactive projects",
  );
  const canceledFuture = await unassign(
    db, leader, inactiveAssignment.assignment_id, inactiveAssignment.version,
    inactiveProjectVersion, "leader-cancel-future-inactive",
  );
  assert.equal(canceledFuture.valid_to, "2099-01-01");
  assert.equal(canceledFuture.already_unassigned, false);

  const thirdUnassignVersion = await projectVersion(db, PROJECT_ACTIVE);
  const thirdUnassigned = await unassign(
    db, leader, third.assignment_id, third.version, thirdUnassignVersion,
    "leader-unassign-c",
  );

  const today = (await db.query(
    "select public.direct_entry_authorization_date()::text as today",
  )).rows[0].today;
  await db.query(
    "update public.recruiter_team_memberships set valid_to=$1::date"
      + " where recruiter_id=$2::uuid and team_id=$3::uuid and valid_to is null",
    [today, managerC.recruiter, TEAM_A]);
  await db.query(
    "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)"
      + " values ($1::uuid,$2::uuid,$3::date)",
    [managerC.recruiter, TEAM_B, today]);
  assert.equal((await candidateList(db, leader)).candidates.some(
    (candidate) => candidate.recruiter_id === managerC.recruiter,
  ), false, "candidate follows the manager's current team");
  assert.equal((await assignmentList(db, leader, PROJECT_ACTIVE)).assignments.some(
    (assignment) => assignment.manager_recruiter_id === managerC.recruiter,
  ), false, "assignment history follows the manager's current team");
  assert.deepEqual(
    await assign(db, leader, PROJECT_ACTIVE, managerC.recruiter, versionAfterTwo, "leader-assign-c"),
    third,
    "an authorized exact replay returns the recorded result after target state drifts",
  );
  assert.deepEqual(
    await unassign(
      db, leader, third.assignment_id, third.version, thirdUnassignVersion,
      "leader-unassign-c",
    ),
    thirdUnassigned,
    "unassign exact replay is stable after target team changes",
  );
  await denied(async () => unassign(
    db, leader, third.assignment_id, third.version, await projectVersion(db, PROJECT_ACTIVE),
    "leader-unassign-after-team-move",
  ));

  await db.close();
});
