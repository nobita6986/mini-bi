import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";
import { expectedDirectEntryFunctions } from "./lib/direct-entry-inventory.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.resolve("supabase/migrations");
const MIGRATION_71 = "20261009070000_p3_1_w01d_team_leader_lifecycle.sql";
const TEAM_A = "94000000-0000-4000-8000-0000000000a1";
const TEAM_B = "94000000-0000-4000-8000-0000000000a2";
const TEAM_INACTIVE = "94000000-0000-4000-8000-0000000000a3";
const UNKNOWN_TEAM = "94000000-0000-4000-8000-0000000000ff";
const VENDOR_ID = "vendor.a1b1";
const PAST = "2020-01-01";
const FUTURE = "2099-01-01";
const RPC_NAMES = [
  "direct_entry_list_team_leaders_current",
  "direct_entry_list_team_leaders_scheduled",
  "direct_entry_list_team_leader_history",
];
const PROJECTION_KEYS = [
  "assignment_id", "team_id", "team_display_name", "leader_app_user_id",
  "leader_recruiter_id", "leader_display_name", "valid_from", "valid_to", "state",
].sort();
const RESERVED = "__system_vendor__";
const MUTATION = process.env.LEADER_READ_MUTATION;

function uuid(value) {
  return "10000000-0000-4000-8000-" + String(value).padStart(12, "0");
}

function mutation(sql) {
  if (!MUTATION) return sql;
  const once = (source, before, after) => {
    assert.equal(source.split(before).length - 1, 1, "mutation target exists once");
    return source.replace(before, after);
  };
  const current = sql.indexOf("create or replace function public.direct_entry_list_team_leaders_current");
  const scheduled = sql.indexOf("create or replace function public.direct_entry_list_team_leaders_scheduled");
  const history = sql.indexOf("create or replace function public.direct_entry_list_team_leader_history");
  const reads = sql.slice(current);
  switch (MUTATION) {
    case "same-team":
      return once(sql, "if v_membership_count <> 1 or v_matching_membership_count <> 1 then",
        "if v_membership_count <> 1 then");
    case "leader-assignment":
      return once(sql, "if v_assignment_count <> 1 then", "if false then");
    case "active-team":
      return once(sql,
        "if not exists (\n    select 1 from public.teams t\n     where t.team_id = v_scope_team_id\n       and t.active\n       and t.code <> '__system_vendor__'\n  ) then",
        "if false then");
    case "current-marker": {
      const currentSql = sql.slice(current, scheduled);
      let altered = currentSql.replaceAll(
        "public.direct_entry_authorization_date() < a.valid_to",
        "public.direct_entry_authorization_date() <= a.valid_to",
      );
      const withMarkerPredicate = altered;
      altered = altered.replaceAll("and (a.valid_to is null or a.valid_to > a.valid_from)\n", "");
      assert.notEqual(altered, currentSql);
      assert.notEqual(withMarkerPredicate, currentSql);
      return sql.slice(0, current) + altered + sql.slice(scheduled);
    }
    case "reserved-team": {
      const altered = reads.slice(0, history - current).replaceAll("t.code <> '__system_vendor__'\n", "");
      assert.notEqual(altered, reads.slice(0, history - current));
      return sql.slice(0, current) + altered + reads.slice(history - current);
    }
    case "authenticated-execute":
      return once(sql, "\ncommit;", `
grant execute on function public.direct_entry_list_team_leaders_current(uuid,uuid,uuid,text,integer,integer)
  to authenticated;

commit;`);
    case "position-authority":
      return once(sql, "begin\n  if p_auth_subject is null or p_app_user_id is null then",
        "begin\n  -- personnel_position\n  if p_auth_subject is null or p_app_user_id is null then");
    case "cross-team-empty":
      return once(sql,
        "if p_team_id is not null and p_team_id <> v_scope_team_id then\n    raise exception 'team leader read authority denied' using errcode = '42501';\n  end if;",
        "if p_team_id is not null and p_team_id <> v_scope_team_id then\n    return null;\n  end if;");
    default:
      throw new Error("unknown leader-read mutation");
  }
}

async function inventory(db) {
  const { rows } = await db.query(`
    select count(*)::int as total,
           count(*) filter (where has_function_privilege('service_role', p.oid, 'EXECUTE'))::int as service,
           count(*) filter (where not has_function_privilege('service_role', p.oid, 'EXECUTE'))::int as internal
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'direct_entry\\_%'
  `);
  return rows[0];
}

async function createDatabase() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.equal(names.length, 72);
  assert.equal(names.at(-2), MIGRATION_71);
  const migrations = await Promise.all(names.map(async (name) => ({
    name,
    sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
  })));
  for (const name of names.slice(0, -2)) {
    const file = path.join(MIGRATION_DIR, name);
    const local = await readFile(file);
    const trackedPath = path.relative(ROOT, file).replaceAll("\\", "/");
    const base = execFileSync("git", ["show", "HEAD:" + trackedPath], { encoding: "buffer" });
    assert.deepEqual(local, base, "migration before #71 remains byte-identical");
    await db.exec(local.toString("utf8"));
  }
  const baseline = await inventory(db);
  await db.exec(mutation(migrations.at(-2).sql));
  return { db, names, baseline, migrations };
}

let db;
let migrationNames;
let inventoryBefore;
let allMigrationsForNames;

async function addActor(id, { enabled = true, capabilities = [], scopes = [] } = {}) {
  const actor = { auth: uuid(1000 + id), app: uuid(2000 + id) };
  await db.query("insert into auth.users(id) values ($1::uuid)", [actor.auth]);
  await db.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name)"
      + " values ($1::uuid,$2::uuid,$3,'Synthetic account')",
    [actor.app, actor.auth, enabled]);
  for (const capability of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)"
        + " values ($1::uuid,$2,$3::date)",
      [actor.app, capability, PAST]);
  }
  for (const { team = null } of scopes) {
    await db.query(
      "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from)"
        + " values ($1::uuid,$2,$3::uuid,$4::date)",
      [actor.app, team === null ? "all" : "team", team, PAST]);
  }
  return actor;
}

async function addRecruiter(id, { active = true, provider = "hrp", vendor = null, team = TEAM_A } = {}) {
  const recruiter = uuid(3000 + id);
  await db.query(
    "insert into public.recruiters(recruiter_id,display_name,active) values ($1::uuid,'Synthetic recruiter',$2)",
    [recruiter, active]);
  if (provider !== null) {
    await db.query(
      "insert into public.recruiter_provider_memberships"
        + "(recruiter_id,provider_type,vendor_id,valid_from) values ($1::uuid,$2,$3,$4::date)",
      [recruiter, provider, vendor, PAST]);
  }
  if (team !== null) {
    await db.query(
      "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)"
        + " values ($1::uuid,$2::uuid,$3::date)",
      [recruiter, team, PAST]);
  }
  return recruiter;
}

async function addLeader(id, {
  team = TEAM_A,
  membershipTeam = team,
  enabled = true,
  capability = true,
  scope = true,
  link = true,
  provider = "hrp",
  activeRecruiter = true,
  assignment = true,
} = {}) {
  const actor = await addActor(id, {
    enabled,
    capabilities: capability ? ["team_manager_assign"] : [],
    scopes: scope ? [{ team }] : [],
  });
  const recruiter = await addRecruiter(id, {
    active: activeRecruiter, provider, vendor: provider === "vendor" ? VENDOR_ID : null,
    team: membershipTeam,
  });
  if (link) {
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links"
        + "(app_user_id,recruiter_id,verified,valid_from) values ($1::uuid,$2::uuid,true,$3::date)",
      [actor.app, recruiter, PAST]);
  }
  if (assignment) {
    await db.query(
      "insert into public.direct_entry_team_leader_assignments"
        + "(team_id,leader_app_user_id,leader_recruiter_id,valid_from)"
        + " values ($1::uuid,$2::uuid,$3::uuid,$4::date)",
      [team, actor.app, recruiter, `2020-01-${String(id).padStart(2, "0")}`]);
  }
  return { ...actor, recruiter, team };
}

async function rpc(name, actor, { team = null, search = null, page = 1, pageSize = 100 } = {}) {
  const { rows } = await db.query(
    `select public.${name}($1::uuid,$2::uuid,$3::uuid,$4::text,$5::integer,$6::integer) as payload`,
    [actor?.auth ?? null, actor?.app ?? null, team, search, page, pageSize]);
  return rows[0].payload;
}

const candidateList = (actor, options = {}) =>
  rpc("direct_entry_list_team_leader_candidates", actor, options);

async function denial(name, actor, options = {}, expected = "42501") {
  try {
    await rpc(name, actor, options);
  } catch (error) {
    assert.equal(error.code, expected);
    return;
  }
  assert.fail("expected denied leader read");
}

async function withRole(role, callback) {
  await db.exec(`set role ${role}`);
  try {
    return await callback();
  } finally {
    await db.exec("reset role");
  }
}

async function addAssignment(team, actor, recruiter, from, to = null) {
  await db.query(
    "insert into public.direct_entry_team_leader_assignments"
      + "(team_id,leader_app_user_id,leader_recruiter_id,valid_from,valid_to)"
      + " values ($1::uuid,$2::uuid,$3::uuid,$4::date,$5::date)",
    [team, actor.app, recruiter, from, to]);
}

const current = (actor, options) => rpc("direct_entry_list_team_leaders_current", actor, options);
const scheduled = (actor, options) => rpc("direct_entry_list_team_leaders_scheduled", actor, options);
const history = (actor, options) => rpc("direct_entry_list_team_leader_history", actor, options);

test("P3.1-W01D-A1b1 read authority, interval contract, ACL and inventory", async () => {
  const state = await createDatabase();
  db = state.db;
  migrationNames = state.names;
  inventoryBefore = state.baseline;
  allMigrationsForNames = state.migrations.slice(0, -1);
  assert.equal(migrationNames.length, 72);
  assert.equal(migrationNames.at(-2), MIGRATION_71);
  assert.equal(migrationNames.some((name) => name.startsWith("202610100")), false);

  await db.query(
    "insert into public.teams(team_id,code,display_name,active) values"
      + " ($1::uuid,'TEAM_A','Team A',true),($2::uuid,'TEAM_B','Team B',true),"
      + " ($3::uuid,'TEAM_INACTIVE','Team Inactive',false)",
    [TEAM_A, TEAM_B, TEAM_INACTIVE]);
  await db.query("insert into public.vendors(vendor_id,display_name) values ($1,'Synthetic vendor')", [VENDOR_ID]);

  const { rows: reservedRows } = await db.query(
    "select public.direct_entry_system_vendor_team_id() as team_id");
  const reservedTeam = reservedRows[0].team_id;
  const admin = await addActor(1, {
    capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    scopes: [{ team: null }],
  });
  const catalog = await addActor(2, { capabilities: ["catalog_master_manage"], scopes: [{ team: null }] });
  const entryAdminOnly = await addActor(3, { capabilities: ["entry_admin"], scopes: [{ team: null }] });
  const leaderA = await addLeader(4);
  const leaderB = await addLeader(5, { team: TEAM_B });
  const staff = await addActor(6, { capabilities: ["entry_create"], scopes: [{ team: TEAM_A }] });
  const projectManager = await addLeader(7, { assignment: false });
  const disabled = await addLeader(8, { enabled: false });

  await db.exec("begin");
  await db.query("select set_config('direct_entry.team_leader_marker','on',true)");
  await db.query(
    "insert into public.direct_entry_team_leader_assignments"
      + "(team_id,leader_app_user_id,leader_recruiter_id,valid_from,valid_to) values"
      + " ($1::uuid,$2::uuid,$3::uuid,'2024-01-01','2025-01-01'),"
      + " ($1::uuid,$2::uuid,$3::uuid,'2099-01-01',null),"
      + " ($1::uuid,$2::uuid,$3::uuid,'2100-01-01','2100-01-01')",
    [TEAM_A, leaderA.app, leaderA.recruiter]);
  await db.exec("commit");
  const { rows: todayRows } = await db.query(
    "select public.direct_entry_authorization_date()::text as today");
  const today = todayRows[0].today;
  await db.exec("begin");
  await db.query("select set_config('direct_entry.team_leader_marker','on',true)");
  await addAssignment(TEAM_A, leaderA, leaderA.recruiter, today, today);
  await db.exec("commit");
  const inactiveLeader = await addLeader(9, { team: TEAM_INACTIVE });
  await addAssignment(TEAM_INACTIVE, inactiveLeader, inactiveLeader.recruiter,
    "2024-01-01", "2025-01-01");
  await db.query(
    "update public.direct_entry_app_users set display_name = 'Changed Account History' where app_user_id = $1::uuid",
    [inactiveLeader.app]);
  await db.query(
    "update public.recruiters set display_name = 'Persisted Recruiter History' where recruiter_id = $1::uuid",
    [inactiveLeader.recruiter]);
  await db.query(
    "update public.direct_entry_app_user_recruiter_links set valid_to = '2025-01-01'"
      + " where app_user_id = $1::uuid and recruiter_id = $2::uuid",
    [inactiveLeader.app, inactiveLeader.recruiter]);
  const vendorActor = await addActor(10);
  const vendorRecruiter = await addRecruiter(10, { provider: "hrp", team: null });
  await addAssignment(reservedTeam, vendorActor, vendorRecruiter, PAST);

  const currentAdmin = await current(admin);
  const currentCatalog = await current(catalog);
  assert.equal(currentAdmin.total, currentCatalog.total);
  assert.deepEqual(currentAdmin.leaders, currentCatalog.leaders);
  assert.ok(currentAdmin.leaders.some((row) => row.team_id === TEAM_A));
  assert.ok(currentAdmin.leaders.some((row) => row.team_id === TEAM_B));
  for (const read of [scheduled, history]) {
    assert.deepEqual(await read(admin), await read(catalog));
  }
  await denial("direct_entry_list_team_leaders_current", entryAdminOnly);

  assert.equal((await current(catalog, { team: UNKNOWN_TEAM })).total, 0);
  const reservedFilter = await current(catalog, { team: reservedTeam });
  assert.equal(reservedFilter.total, 0);
  assert.deepEqual(reservedFilter.leaders, []);
  assert.ok(!JSON.stringify(currentCatalog).includes(RESERVED));
  assert.equal((await history(catalog, { team: TEAM_INACTIVE })).total, 1);
  const persistedHistory = await history(catalog, {
    team: TEAM_INACTIVE, search: "Persisted Recruiter History",
  });
  assert.equal(persistedHistory.total, 1);
  assert.equal(persistedHistory.leaders[0].leader_display_name, "Persisted Recruiter History");
  assert.equal((await history(catalog, {
    team: TEAM_INACTIVE, search: "Changed Account History",
  })).total, 0);

  const own = await current(leaderA);
  assert.ok(own.leaders.length > 0);
  assert.ok(own.leaders.every((row) => row.team_id === TEAM_A));
  for (const name of RPC_NAMES) {
    assert.ok((await rpc(name, leaderA)).leaders.every((row) => row.team_id === TEAM_A));
    await denial(name, leaderA, { team: TEAM_B });
  }
  await denial("direct_entry_list_team_leaders_current", leaderA, { team: TEAM_B, page: 0 });
  await denial("direct_entry_list_team_leaders_current", projectManager);
  await denial("direct_entry_list_team_leaders_current", staff);
  await denial("direct_entry_list_team_leaders_current", disabled);
  await denial("direct_entry_list_team_leaders_current", { auth: uuid(9999), app: uuid(9998) });
  await denial("direct_entry_list_team_leaders_current",
    { auth: leaderA.auth, app: leaderB.app });

  const noCapability = await addLeader(11, { capability: false });
  const noScope = await addLeader(12, { scope: false });
  const noLink = await addLeader(13, { link: false });
  const noProvider = await addLeader(14, { provider: null });
  const vendorProvider = await addLeader(15, { provider: "vendor", membershipTeam: null });
  const inactiveRecruiter = await addLeader(16, { activeRecruiter: false });
  const noMembership = await addLeader(17, { membershipTeam: null });
  const mismatchedMembership = await addLeader(18, { membershipTeam: TEAM_B });
  const inactiveTeam = await addLeader(19, { team: TEAM_INACTIVE });
  const noAssignment = await addLeader(25, { assignment: false });
  for (const actor of [noCapability, noScope, noLink, noProvider, vendorProvider,
    inactiveRecruiter, noMembership, mismatchedMembership, inactiveTeam]) {
    await denial("direct_entry_list_team_leaders_current", actor);
  }
  await denial("direct_entry_list_team_leaders_current", noAssignment);

  const expiredVariants = [
    ["direct_entry_capability_grants", leaderA.app, "team_manager_assign"],
    ["direct_entry_scope_grants", leaderA.app, "team"],
    ["direct_entry_app_user_recruiter_links", leaderA.app, leaderA.recruiter],
    ["recruiter_provider_memberships", leaderA.recruiter, "hrp"],
    ["recruiter_team_memberships", leaderA.recruiter, TEAM_A],
  ];
  const predicates = [
    "app_user_id = $1::uuid and capability = $2",
    "app_user_id = $1::uuid and scope_kind = $2 and team_id = $3::uuid",
    "app_user_id = $1::uuid and recruiter_id = $2::uuid and verified",
    "recruiter_id = $1::uuid and provider_type = $2",
    "recruiter_id = $1::uuid and team_id = $2::uuid",
  ];
  for (let index = 0; index < expiredVariants.length; index += 1) {
    const [table, first, second] = expiredVariants[index];
    const where = predicates[index];
    const values = index === 1 ? [first, second, TEAM_A] : [first, second];
    const setFuture = index === 1
      ? `update public.${table} set valid_from = $4::date, valid_to = null where ${where}`
      : `update public.${table} set valid_from = $3::date, valid_to = null where ${where}`;
    await db.query(setFuture, [...values, FUTURE]);
    await denial("direct_entry_list_team_leaders_current", leaderA);
    const expire = `update public.${table} set valid_from = '2019-01-01', valid_to = '2020-01-01' where ${where}`;
    await db.query(expire, values);
    await denial("direct_entry_list_team_leaders_current", leaderA);
    await db.query(setFuture, [...values, PAST]);
  }

  const multiLink = await addLeader(20);
  await db.exec("alter table public.direct_entry_app_user_recruiter_links disable trigger direct_entry_recruiter_link_no_overlap");
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links"
      + "(app_user_id,recruiter_id,verified,valid_from) values ($1::uuid,$2::uuid,true,'2021-01-01')",
    [multiLink.app, leaderB.recruiter]);
  await db.exec("alter table public.direct_entry_app_user_recruiter_links enable trigger direct_entry_recruiter_link_no_overlap");
  await denial("direct_entry_list_team_leaders_current", multiLink);

  const multiScope = await addLeader(21);
  await db.query(
    "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from)"
      + " values ($1::uuid,'team',$2::uuid,'2021-01-01')",
    [multiScope.app, TEAM_B]);
  await denial("direct_entry_list_team_leaders_current", multiScope);

  const multiProvider = await addLeader(22);
  await db.exec("alter table public.recruiter_provider_memberships disable trigger direct_entry_provider_membership_no_overlap");
  await db.query(
    "insert into public.recruiter_provider_memberships"
      + "(recruiter_id,provider_type,vendor_id,valid_from) values ($1::uuid,'vendor',$2,'2021-01-01')",
    [multiProvider.recruiter, VENDOR_ID]);
  await db.exec("alter table public.recruiter_provider_memberships enable trigger direct_entry_provider_membership_no_overlap");
  await denial("direct_entry_list_team_leaders_current", multiProvider);

  const multiMembership = await addLeader(23);
  await db.exec("alter table public.recruiter_team_memberships disable trigger direct_entry_team_membership_no_overlap");
  await db.query(
    "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)"
      + " values ($1::uuid,$2::uuid,'2021-01-01')",
    [multiMembership.recruiter, TEAM_B]);
  await db.exec("alter table public.recruiter_team_memberships enable trigger direct_entry_team_membership_no_overlap");
  await denial("direct_entry_list_team_leaders_current", multiMembership);

  const multiAssignment = await addLeader(24);
  await addAssignment(TEAM_A, multiAssignment, multiAssignment.recruiter, "2021-01-01");
  await denial("direct_entry_list_team_leaders_current", multiAssignment);

  const candidateA = await addLeader(30, {
    capability: false, scope: false, assignment: false,
  });
  const candidateB = await addLeader(31, {
    capability: false, scope: false, assignment: false,
  });
  const candidateC = await addLeader(32, {
    capability: false, scope: false, assignment: false,
  });
  await db.query(
    "update public.recruiters set display_name = case recruiter_id"
      + " when $1::uuid then 'Alpha Candidate' when $2::uuid then 'Bravo Candidate'"
      + " when $3::uuid then 'Charlie Candidate' end,"
      + " personnel_code = case recruiter_id when $1::uuid then 'C-001'"
      + " when $2::uuid then 'C-002' when $3::uuid then 'C-003' end"
      + " where recruiter_id = any($4::uuid[])",
    [candidateA.recruiter, candidateB.recruiter, candidateC.recruiter,
      [candidateA.recruiter, candidateB.recruiter, candidateC.recruiter]]);
  await db.query(
    "update public.direct_entry_app_users set display_name = 'Unrelated Account Name'"
      + " where app_user_id = any($1::uuid[])",
    [[candidateA.app, candidateB.app, candidateC.app]]);

  const disabledCandidate = await addLeader(33, {
    enabled: false, capability: false, scope: false, assignment: false,
  });
  const unlinkedCandidate = await addLeader(34, {
    link: false, capability: false, scope: false, assignment: false,
  });
  const inactiveCandidate = await addLeader(35, {
    activeRecruiter: false, capability: false, scope: false, assignment: false,
  });
  const vendorCandidate = await addLeader(36, {
    provider: "vendor", membershipTeam: null,
    capability: false, scope: false, assignment: false,
  });
  const mismatchedCandidate = await addLeader(37, {
    membershipTeam: TEAM_B, capability: false, scope: false, assignment: false,
  });
  const multipleLinkCandidate = await addLeader(38, {
    capability: false, scope: false, assignment: false,
  });
  await db.exec("alter table public.direct_entry_app_user_recruiter_links disable trigger direct_entry_recruiter_link_no_overlap");
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links"
      + "(app_user_id,recruiter_id,verified,valid_from) values ($1::uuid,$2::uuid,true,$3::date)",
    [multipleLinkCandidate.app, candidateA.recruiter, PAST]);
  await db.exec("alter table public.direct_entry_app_user_recruiter_links enable trigger direct_entry_recruiter_link_no_overlap");
  const multipleProviderCandidate = await addLeader(39, {
    capability: false, scope: false, assignment: false,
  });
  await db.exec("alter table public.recruiter_provider_memberships disable trigger direct_entry_provider_membership_no_overlap");
  await db.query(
    "insert into public.recruiter_provider_memberships"
      + "(recruiter_id,provider_type,vendor_id,valid_from) values ($1::uuid,'vendor',$2,$3::date)",
    [multipleProviderCandidate.recruiter, VENDOR_ID, "2021-01-01"]);
  await db.exec("alter table public.recruiter_provider_memberships enable trigger direct_entry_provider_membership_no_overlap");
  const multipleMembershipCandidate = await addLeader(40, {
    capability: false, scope: false, assignment: false,
  });
  await db.exec("alter table public.recruiter_team_memberships disable trigger direct_entry_team_membership_no_overlap");
  await db.query(
    "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)"
      + " values ($1::uuid,$2::uuid,'2021-01-01')",
    [multipleMembershipCandidate.recruiter, TEAM_B]);
  await db.exec("alter table public.recruiter_team_memberships enable trigger direct_entry_team_membership_no_overlap");
  const capabilityCandidate = await addLeader(41, {
    scope: false, assignment: false,
  });
  const scheduledScopeCandidate = await addLeader(42, {
    capability: false, scope: false, assignment: false,
  });
  await db.query(
    "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from)"
      + " values ($1::uuid,'team',$2::uuid,$3::date)",
    [scheduledScopeCandidate.app, TEAM_A, FUTURE]);
  const scheduledCapabilityCandidate = await addLeader(43, {
    capability: false, scope: false, assignment: false,
  });
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)"
      + " values ($1::uuid,'team_manager_assign',$2::date)",
    [scheduledCapabilityCandidate.app, FUTURE]);
  const scheduledAssignmentCandidate = await addLeader(44, {
    capability: false, scope: false, assignment: false,
  });
  await addAssignment(TEAM_B, scheduledAssignmentCandidate, scheduledAssignmentCandidate.recruiter, FUTURE);

  const candidateEnvelope = await candidateList(catalog, { team: TEAM_A, pageSize: 2 });
  assert.equal(candidateEnvelope.total, 3);
  assert.equal(candidateEnvelope.page, 1);
  assert.equal(candidateEnvelope.page_size, 2);
  const candidateKeys = ["app_user_id", "display_name", "personnel_code"].sort();
  assert.ok(candidateEnvelope.candidates.every((row) =>
    Object.keys(row).sort().join(",") === candidateKeys.join(",")));
  assert.deepEqual(candidateEnvelope.candidates.map((row) => row.display_name),
    ["Alpha Candidate", "Bravo Candidate"]);
  assert.deepEqual((await candidateList(admin, { team: TEAM_A })).candidates,
    (await candidateList(catalog, { team: TEAM_A, pageSize: 25 })).candidates);
  assert.deepEqual((await candidateList(catalog, {
    team: TEAM_A, page: 2, pageSize: 2,
  })).candidates.map((row) => row.display_name), ["Charlie Candidate"]);
  assert.equal((await candidateList(catalog, {
    team: TEAM_A, search: "C-002",
  })).total, 1);
  assert.equal((await candidateList(catalog, {
    team: TEAM_A, search: "C-002",
  })).candidates[0].app_user_id, candidateB.app);
  assert.equal((await candidateList(catalog, {
    team: TEAM_A, search: "Alpha Candidate",
  })).candidates[0].app_user_id, candidateA.app);
  assert.equal((await candidateList(catalog, {
    team: TEAM_A, search: "Unrelated Account Name",
  })).total, 0);
  for (const actor of [
    leaderA, leaderB, disabledCandidate, unlinkedCandidate, inactiveCandidate,
    vendorCandidate, mismatchedCandidate, multipleLinkCandidate,
    multipleProviderCandidate, multipleMembershipCandidate, capabilityCandidate,
    scheduledScopeCandidate, scheduledCapabilityCandidate, scheduledAssignmentCandidate,
  ]) {
    assert.equal((await candidateList(catalog, { team: TEAM_A })).candidates
      .some((row) => row.app_user_id === actor.app), false);
  }
  await assert.rejects(candidateList(entryAdminOnly, {
    team: TEAM_A, page: 0,
  }), (error) => error.code === "42501");
  await assert.rejects(candidateList(leaderA, { team: TEAM_A }),
    (error) => error.code === "42501");
  await assert.rejects(candidateList(catalog, { team: TEAM_INACTIVE }),
    (error) => error.code === "P0002");
  await assert.rejects(candidateList(catalog, { team: reservedTeam }),
    (error) => error.code === "P0002");
  await assert.rejects(candidateList(catalog, { team: UNKNOWN_TEAM }),
    (error) => error.code === "P0002");
  await assert.rejects(candidateList(catalog, { team: TEAM_A, pageSize: 101 }),
    (error) => error.code === "22023");
  await withRole("authenticated", async () => {
    await assert.rejects(candidateList(catalog, { team: TEAM_A }),
      (error) => error.code === "42501");
  });
  await withRole("service_role", async () => {
    assert.equal((await candidateList(catalog, { team: TEAM_A })).total, 3);
  });

  const allCurrent = await current(catalog);
  const allScheduled = await scheduled(catalog);
  const allHistory = await history(catalog);
  const currentIds = new Set(allCurrent.leaders.map((row) => row.assignment_id));
  const scheduledIds = new Set(allScheduled.leaders.map((row) => row.assignment_id));
  const historyIds = new Set(allHistory.leaders.map((row) => row.assignment_id));
  assert.equal([...currentIds].some((id) => scheduledIds.has(id) || historyIds.has(id)), false);
  assert.equal([...scheduledIds].some((id) => historyIds.has(id)), false);
  const markerRows = allHistory.leaders.filter((row) =>
    row.valid_from === row.valid_to && [today, "2100-01-01"].includes(row.valid_from));
  assert.equal(markerRows.length, 2);
  assert.ok(markerRows.every((row) => row.state === "HISTORY"));
  assert.ok(!allCurrent.leaders.some((row) => row.valid_from === today && row.valid_to === today));
  assert.ok(!allScheduled.leaders.some((row) => row.valid_from === "2100-01-01"));
  assert.ok(allHistory.leaders.some((row) => row.team_id === TEAM_INACTIVE));
  assert.ok(allCurrent.leaders.every((row) => row.team_id !== reservedTeam));
  assert.ok(allScheduled.leaders.every((row) => row.team_id !== reservedTeam));
  assert.ok(allHistory.leaders.every((row) => row.team_id !== reservedTeam));

  for (const pageSize of [1, 2]) {
    const first = await current(catalog, { page: 1, pageSize });
    const firstRepeat = await current(catalog, { page: 1, pageSize });
    assert.deepEqual(first, firstRepeat);
    const second = await current(catalog, { page: 2, pageSize });
    assert.equal(first.leaders.some((row) =>
      second.leaders.some((other) => row.assignment_id === other.assignment_id)), false);
  }
  assert.ok((await current(catalog, { search: "Team A" })).leaders.length > 0);
  await assert.rejects(current(catalog, { search: "x".repeat(257) }), { code: "22023" });
  for (const page of [0, 1001]) {
    await assert.rejects(current(catalog, { page }), { code: "22023" });
  }
  for (const pageSize of [0, 101]) {
    await assert.rejects(current(catalog, { pageSize }), { code: "22023" });
  }
  await assert.rejects(current(catalog, { page: 0 }), { code: "22023" });
  await denial("direct_entry_list_team_leaders_current", staff, { search: "x".repeat(257) });
  const payload = await current(catalog);
  assert.deepEqual(Object.keys(payload).sort(),
    ["authorization_date", "leaders", "page", "page_size", "total"].sort());
  assert.ok(payload.leaders.every((row) => Object.keys(row).sort().join(",") === PROJECTION_KEYS.join(",")));
  for (const forbidden of ["auth_subject", "email", "grant_id", "scope_kind", "reason", "audit"]) {
    assert.ok(payload.leaders.every((row) => !(forbidden in row)));
  }

  const oldInventoryNames = expectedDirectEntryFunctions(allMigrationsForNames.slice(0, -1));
  const allInventoryNames = expectedDirectEntryFunctions(allMigrationsForNames);
  const functionRows = (await db.query(`
    select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as config,
           has_function_privilege('public',p.oid,'EXECUTE') as public_exec,
           has_function_privilege('anon',p.oid,'EXECUTE') as anon_exec,
           has_function_privilege('authenticated',p.oid,'EXECUTE') as auth_exec,
           has_function_privilege('service_role',p.oid,'EXECUTE') as service_exec,
           pg_get_functiondef(p.oid) as source
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname like 'direct_entry\\_%'
  `)).rows;
  const actualInventoryNames = [...new Set(functionRows.map((row) => row.proname))].sort();
  assert.deepEqual(actualInventoryNames, [...allInventoryNames].sort());
  const resolverRows = functionRows.filter((row) => row.proname === "direct_entry_assert_team_leader_read_authority");
  assert.equal(resolverRows.length, 1);
  assert.equal(resolverRows[0].prosecdef, true);
  assert.equal(resolverRows[0].config, "search_path=pg_catalog, public");
  assert.equal(resolverRows[0].public_exec || resolverRows[0].anon_exec
    || resolverRows[0].auth_exec || resolverRows[0].service_exec, false);
  assert.ok(resolverRows[0].source.includes("direct_entry_assert_catalog_operator"));
  assert.equal(resolverRows[0].source.includes("personnel_position"), false);
  assert.equal(await db.query(`select to_regprocedure($1) is null as absent`,
    ["public.direct_entry_assert_team_leader_authority(uuid,uuid,uuid)"]).then((r) => r.rows[0].absent), true);
  for (const name of [...RPC_NAMES, "direct_entry_list_team_leader_candidates"]) {
    const rows = functionRows.filter((row) => row.proname === name);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prosecdef, true);
    assert.equal(rows[0].config, "search_path=pg_catalog, public");
    assert.equal(rows[0].public_exec || rows[0].anon_exec || rows[0].auth_exec, false);
    assert.equal(rows[0].service_exec, true);
    if (name !== "direct_entry_list_team_leader_candidates") {
      assert.ok(rows[0].source.includes(RESERVED));
      assert.equal(rows[0].source.includes("direct_entry_system_vendor_team_id"), false);
      assert.ok(rows[0].source.includes(
        "join public.recruiters r on r.recruiter_id = a.leader_recruiter_id"));
      assert.ok(rows[0].source.includes("r.display_name ilike"));
      assert.equal(rows[0].source.includes("direct_entry_app_users"), false);
      assert.equal(rows[0].source.includes("direct_entry_app_user_recruiter_links"), false);
    } else {
      assert.ok(rows[0].source.includes("direct_entry_assert_catalog_operator"));
      assert.equal(rows[0].source.includes("direct_entry_assert_team_leader_read_authority"), false);
      assert.equal(rows[0].source.includes("personnel_position"), false);
      assert.ok(rows[0].source.includes(RESERVED));
      assert.ok(rows[0].source.includes("r.display_name"));
      assert.equal(rows[0].source.includes("'recruiter_id', recruiter_id"), false);
    }
  }

  const { rows: grantVocabulary } = await db.query(
    "select pg_get_constraintdef(oid) as definition from pg_constraint"
      + " where conname='direct_entry_capability_grants_capability_check'");
  assert.equal([...grantVocabulary[0].definition.matchAll(/'[^']+'::text/g)].length, 23);
  const fullInventory = await inventory(db);
  const addedNames = [...allInventoryNames].filter((name) => !oldInventoryNames.has(name)).sort();
  assert.deepEqual(addedNames, [
    "direct_entry_apply_team_leader_mutation",
    "direct_entry_assert_team_leader_read_authority",
    "direct_entry_designate_team_leader",
    "direct_entry_list_team_leader_candidates",
    "direct_entry_list_team_leader_history",
    "direct_entry_list_team_leaders_current",
    "direct_entry_list_team_leaders_scheduled",
    "direct_entry_revoke_team_leader",
    "direct_entry_team_leader_marker",
    "direct_entry_team_leader_projection",
    "direct_entry_team_leader_snapshot",
    "direct_entry_transition_legacy_team_leaders",
  ]);
  assert.equal(fullInventory.total - inventoryBefore.total, 12);
  assert.equal(fullInventory.service - inventoryBefore.service, 5);
  assert.equal(fullInventory.internal - inventoryBefore.internal, 7);
  assert.equal(fullInventory.total, fullInventory.service + fullInventory.internal);
  console.log(`Direct Entry function inventory: #70 ${inventoryBefore.total} total / ${inventoryBefore.service} service / ${inventoryBefore.internal} internal; #71 ${fullInventory.total} / ${fullInventory.service} / ${fullInventory.internal} (A1b1/A1b2/A1b3 add six service-role RPCs and six internal helpers; revoking the legacy seed moves one existing function from service to internal).`);

  db.close();
});
