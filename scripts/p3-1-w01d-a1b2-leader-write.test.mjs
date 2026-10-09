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
const TEAM_A = "95000000-0000-4000-8000-0000000000a1";
const TEAM_B = "95000000-0000-4000-8000-0000000000a2";
const TEAM_C = "95000000-0000-4000-8000-0000000000a3";
const TEAM_INACTIVE = "95000000-0000-4000-8000-0000000000a4";
const TEAM_LEGACY = "95000000-0000-4000-8000-0000000000a6";
const VENDOR_ID = "vendor.a1b2";
const PAST = "2020-01-01";
const FAR_FUTURE = "2099-01-01";
const WRITE_RPCS = [
  "direct_entry_designate_team_leader",
  "direct_entry_revoke_team_leader",
];
const SNAPSHOT_KEYS = [
  "team_id", "leader_app_user_id", "leader_recruiter_id", "valid_from",
  "valid_to", "previous_leader_recruiter_id", "version", "change",
].sort();
const MUTATION = process.env.LEADER_WRITE_MUTATION;

function uuid(value) {
  return "11000000-0000-4000-8000-" + String(value).padStart(12, "0");
}

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, "mutation source anchor occurs once");
  return source.replace(before, after);
}

function mutateFunctionBody(sql, name, mutation) {
  const start = sql.indexOf(`create or replace function public.${name}`);
  assert.notEqual(start, -1, `mutation function ${name} exists`);
  const bodyStart = sql.indexOf("as $$", start) + "as $$".length;
  const bodyEnd = sql.indexOf("\n$$;", bodyStart);
  assert.ok(bodyStart >= "as $$".length && bodyEnd > bodyStart,
    `mutation function ${name} has a body`);
  return sql.slice(0, bodyStart) + mutation(sql.slice(bodyStart, bodyEnd))
    + sql.slice(bodyEnd);
}

function mutateMigration(sql) {
  if (!MUTATION) return sql;
  switch (MUTATION) {
    case "bypass-authority":
      assert.equal(sql.split(
        "v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);",
      ).length - 1, 2);
      return sql.replaceAll(
        "v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);",
        "v_authority := 'entry_admin';",
      );
    case "inactive-team":
      return replaceOnce(sql,
        "if p_operation = 'designate' and not v_team.active then",
        "if false then");
    case "reserved-team":
      return mutateFunctionBody(sql, "direct_entry_apply_team_leader_mutation", (body) =>
        replaceOnce(body,
          "if v_team.code = '__system_vendor__' then",
          "if false then")).replace(
        "\ncommit;",
        "\nalter table public.direct_entry_scope_grants disable trigger direct_entry_no_vendor_team_scope;\n\ncommit;",
      );
    case "reserved-helper-reference":
      return mutateFunctionBody(sql, "direct_entry_apply_team_leader_mutation", (body) =>
        `\n  -- dormant reference: public.direct_entry_system_vendor_team_id()\n${body}`);
    case "postcondition-team-count":
      return mutateFunctionBody(sql, "direct_entry_apply_team_leader_mutation", (body) =>
        replaceOnce(body,
          "if v_post_team_assignment_count <> 1\n       or v_post_target_team_assignment_count <> 1 then",
          "if false then"));
    case "postcondition-one-team":
      return mutateFunctionBody(sql, "direct_entry_apply_team_leader_mutation", (body) =>
        replaceOnce(body,
          "if v_post_target_assignment_count <> 1\n       or v_post_target_team_assignment_count <> 1 then",
          "if false then"));
    case "postcondition-coextensive":
      return mutateFunctionBody(sql, "direct_entry_apply_team_leader_mutation", (body) =>
        replaceOnce(body,
          "or v_post_coextensive_capability_count <> 1 then",
          "or false then"));
    case "postcondition-scope-coextensive":
      return mutateFunctionBody(sql, "direct_entry_apply_team_leader_mutation", (body) =>
        replaceOnce(body,
          "or v_post_coextensive_scope_count <> 1",
          "or false"));
    case "same-team-membership":
      return mutateFunctionBody(sql, "direct_entry_apply_team_leader_mutation", (body) =>
        replaceOnce(body,
          "if v_membership_count <> 1 or v_matching_membership_count <> 1 then",
          "if false then"));
    case "other-team-leader":
      return mutateFunctionBody(sql, "direct_entry_apply_team_leader_mutation", (body) =>
        replaceOnce(body, "and a.team_id <> p_team_id", "and a.team_id = p_team_id"));
    case "outgoing-grants":
      return replaceOnce(
        replaceOnce(sql,
          "update public.direct_entry_scope_grants\n       set valid_to = p_effective_date",
          "update public.direct_entry_scope_grants\n       set valid_to = p_effective_date + 1"),
        "update public.direct_entry_capability_grants\n       set valid_to = p_effective_date",
        "update public.direct_entry_capability_grants\n       set valid_to = p_effective_date + 1");
    case "team-version":
      return replaceOnce(sql,
        "if v_team.version <> p_expected_version then",
        "if false then");
    case "revision":
      return replaceOnce(sql,
        `  insert into public.direct_entry_team_leader_revisions
    (team_id, version, actor_user_id, action, before_snapshot, after_snapshot)
  values
    (p_team_id, v_team_version, p_app_user_id, v_change, v_before, v_after)
  returning revision_id into v_revision_id;`,
        "  v_revision_id := gen_random_uuid();");
    case "marker-guard":
      return replaceOnce(sql,
        "and coalesce(current_setting('direct_entry.team_leader_marker', true), '') <> 'on' then",
        "and coalesce(current_setting('direct_entry.team_leader_marker', true), '') = 'on' then");
    case "authenticated-execute":
      return replaceOnce(sql, "\ncommit;", `
grant execute on function public.direct_entry_designate_team_leader(uuid,uuid,uuid,uuid,date,integer,text,text)
  to authenticated;

commit;`);
    default:
      throw new Error(`unknown leader-write mutation: ${MUTATION}`);
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
  assert.equal(names.length, 71);
  assert.equal(names.at(-1), MIGRATION_71);
  assert.equal(names.some((name) => name.startsWith("202610100")), false);
  const migrations = await Promise.all(names.map(async (name) => ({
    name,
    sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
  })));
  for (const name of names.slice(0, -1)) {
    const file = path.join(MIGRATION_DIR, name);
    const local = await readFile(file);
    const trackedPath = path.relative(ROOT, file).replaceAll("\\", "/");
    const base = execFileSync("git", ["show", `HEAD:${trackedPath}`], { encoding: "buffer" });
    assert.deepEqual(local, base, "migrations #1-#70 remain byte-identical");
    await db.exec(local.toString("utf8"));
  }
  const baseline = await inventory(db);
  await db.exec(mutateMigration(migrations.at(-1).sql));
  return { db, names, baseline, migrations };
}

let db;
let today;
let nextActorId = 50;
let reservedTeamId;

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

async function addCandidate(id, {
  enabled = true,
  active = true,
  position = "STAFF",
  providers = [{ type: "hrp", from: PAST, to: null }],
  memberships = [TEAM_A],
  links = [{ verified: true, from: PAST, to: null }],
  bypassIntervalGuards = false,
} = {}) {
  const actor = await addActor(id, { enabled });
  const recruiter = uuid(3000 + id);
  await db.query(
    "insert into public.recruiters(recruiter_id,display_name,personnel_position,active)"
      + " values ($1::uuid,'Synthetic candidate',$2,$3)",
    [recruiter, position, active]);

  const seedRows = async () => {
    for (const provider of providers) {
      await db.query(
        "insert into public.recruiter_provider_memberships"
          + "(recruiter_id,provider_type,vendor_id,valid_from,valid_to)"
          + " values ($1::uuid,$2,$3,$4::date,$5::date)",
        [recruiter, provider.type, provider.type === "vendor" ? VENDOR_ID : null,
          provider.from ?? PAST, provider.to ?? null]);
    }
    for (const team of memberships) {
      const membership = typeof team === "string" ? { team } : team;
      await db.query(
        "insert into public.recruiter_team_memberships"
          + "(recruiter_id,team_id,valid_from,valid_to)"
          + " values ($1::uuid,$2::uuid,$3::date,$4::date)",
        [recruiter, membership.team, membership.from ?? PAST, membership.to ?? null]);
    }
    for (const link of links) {
      const linkedRecruiter = link.recruiter ?? recruiter;
      await db.query(
        "insert into public.direct_entry_app_user_recruiter_links"
          + "(app_user_id,recruiter_id,verified,valid_from,valid_to)"
          + " values ($1::uuid,$2::uuid,$3,$4::date,$5::date)",
        [actor.app, linkedRecruiter, link.verified, link.from ?? PAST, link.to ?? null]);
    }
  };

  if (bypassIntervalGuards) {
    await db.exec("alter table public.recruiter_provider_memberships disable trigger all");
    await db.exec("alter table public.recruiter_team_memberships disable trigger all");
    await db.exec("alter table public.direct_entry_app_user_recruiter_links disable trigger all");
    try {
      await seedRows();
    } finally {
      await db.exec("alter table public.recruiter_provider_memberships enable trigger all");
      await db.exec("alter table public.recruiter_team_memberships enable trigger all");
      await db.exec("alter table public.direct_entry_app_user_recruiter_links enable trigger all");
    }
  } else {
    await seedRows();
  }
  return { ...actor, recruiter };
}

async function freshCandidate(options = {}) {
  return addCandidate(nextActorId++, options);
}

async function designate(actor, team, candidate, {
  date = today,
  version = 1,
  reason = "Approved team leader change",
  key = `designate-${nextActorId++}`,
} = {}) {
  const { rows } = await db.query(
    "select public.direct_entry_designate_team_leader("
      + "$1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,$6::integer,$7::text,$8::text) as result",
    [actor.auth, actor.app, team, candidate.app, date, version, reason, key]);
  return rows[0].result;
}

async function revoke(actor, team, {
  date = today,
  version = 1,
  reason = "Approved leader revocation",
  key = `revoke-${nextActorId++}`,
} = {}) {
  const { rows } = await db.query(
    "select public.direct_entry_revoke_team_leader("
      + "$1::uuid,$2::uuid,$3::uuid,$4::date,$5::integer,$6::text,$7::text) as result",
    [actor.auth, actor.app, team, date, version, reason, key]);
  return rows[0].result;
}

async function withRole(role, callback) {
  await db.exec(`set role ${role}`);
  try {
    return await callback();
  } finally {
    await db.exec("reset role");
  }
}

async function deny(promise, code = "42501") {
  await assert.rejects(promise, (error) => error.code === code);
}

async function teamState(team, actorIds = []) {
  const assignments = await db.query(
    "select count(*)::int as n from public.direct_entry_team_leader_assignments where team_id=$1::uuid",
    [team]);
  const scopes = await db.query(
    "select count(*)::int as n from public.direct_entry_scope_grants"
      + " where app_user_id = any($1::uuid[]) and scope_kind='team' and team_id=$2::uuid",
    [actorIds, team]);
  const capabilities = await db.query(
    "select count(*)::int as n from public.direct_entry_capability_grants"
      + " where app_user_id = any($1::uuid[]) and capability='team_manager_assign'",
    [actorIds]);
  const revisions = await db.query(
    "select count(*)::int as n from public.direct_entry_team_leader_revisions where team_id=$1::uuid",
    [team]);
  const audit = await db.query(
    "select count(*)::int as n from public.direct_entry_audit_events"
      + " where resource_ref=$1 and leader_revision_id is not null",
    [team]);
  const reasons = await db.query(
    "select count(*)::int as n from public.direct_entry_restricted_reasons where actor_user_id=$1::uuid",
    [uuid(2001)]);
  const idempotency = await db.query(
    "select count(*)::int as n from public.direct_entry_rpc_idempotency"
      + " where app_user_id=$1::uuid and action in ('team_leader_designate','team_leader_revoke')",
    [uuid(2001)]);
  const version = await db.query("select version from public.teams where team_id=$1::uuid", [team]);
  return {
    assignment: assignments.rows[0].n,
    scope: scopes.rows[0].n,
    capability: capabilities.rows[0].n,
    revision: revisions.rows[0].n,
    audit: audit.rows[0].n,
    reason: reasons.rows[0].n,
    idempotency: idempotency.rows[0].n,
    version: version.rows[0].version,
  };
}

async function replacementSnapshot(team, actorIds, authorityActor, idempotencyKey) {
  const snapshots = {
    version: "select version from public.teams where team_id=$1::uuid",
    assignments: "select assignment_id,leader_app_user_id,leader_recruiter_id,valid_from::text,valid_to::text"
      + " from public.direct_entry_team_leader_assignments where team_id=$1::uuid order by assignment_id",
    scopes: "select grant_id,app_user_id,team_id,valid_from::text,valid_to::text"
      + " from public.direct_entry_scope_grants where app_user_id=any($1::uuid[])"
      + " and scope_kind='team' order by grant_id",
    capabilities: "select grant_id,app_user_id,valid_from::text,valid_to::text"
      + " from public.direct_entry_capability_grants where app_user_id=any($1::uuid[])"
      + " and capability='team_manager_assign' order by grant_id",
    reasons: "select reason_id,actor_user_id,reason_text"
      + " from public.direct_entry_restricted_reasons where actor_user_id=$1::uuid order by reason_id",
    revisions: "select revision_id,version,actor_user_id,action,before_snapshot,after_snapshot"
      + " from public.direct_entry_team_leader_revisions where team_id=$1::uuid order by version",
    audit: "select event_id,app_user_id,action,capability,resource_ref,outcome,reason_id,leader_revision_id"
      + " from public.direct_entry_audit_events where resource_ref=$1 order by event_id",
    idempotency: "select idempotency_id,app_user_id,action,idempotency_key,request_hash,result"
      + " from public.direct_entry_rpc_idempotency where app_user_id=$1::uuid"
      + " and idempotency_key=$2 order by idempotency_id",
  };
  const result = {};
  for (const [key, sql] of Object.entries(snapshots)) {
    const values = ["scopes", "capabilities"].includes(key)
      ? [actorIds]
      : key === "reasons" ? [authorityActor.app]
        : key === "idempotency" ? [authorityActor.app, idempotencyKey] : [team];
    result[key] = (await db.query(sql, values)).rows;
  }
  return result;
}

async function addTeam(team, code, active = true) {
  await db.query(
    "insert into public.teams(team_id,code,display_name,active)"
      + " values ($1::uuid,$2,$3,$4)",
    [team, code, code, active]);
}

async function countRows(table, where, values) {
  const { rows } = await db.query(`select count(*)::int as n from public.${table} where ${where}`, values);
  return rows[0].n;
}

async function effectiveRows(table, appUserId, team = null) {
  const scope = table === "direct_entry_scope_grants";
  const query = scope
    ? "select count(*)::int as n from public.direct_entry_scope_grants"
      + " where app_user_id=$1::uuid and scope_kind='team' and team_id=$2::uuid"
      + " and valid_from <= $3::date and (valid_to is null or $3::date < valid_to)"
      + " and (valid_to is null or valid_to > valid_from)"
    : "select count(*)::int as n from public.direct_entry_capability_grants"
      + " where app_user_id=$1::uuid and capability='team_manager_assign'"
      + " and valid_from <= $2::date and (valid_to is null or $2::date < valid_to)"
      + " and (valid_to is null or valid_to > valid_from)";
  const { rows } = await db.query(query, scope ? [appUserId, team, today] : [appUserId, today]);
  return rows[0].n;
}

async function installFailureTrigger(table, operation) {
  await db.exec(`
    create or replace function public.test_fail_leader_write()
    returns trigger language plpgsql as $$
    begin
      if current_setting('test.leader_write_fail', true) = tg_table_name then
        raise exception 'injected failure' using errcode = 'P0001';
      end if;
      return new;
    end;
    $$;
  `);
  await db.exec(
    `create trigger test_leader_write_failure before ${operation} on public.${table}`
      + " for each row execute function public.test_fail_leader_write()");
}

async function installPostconditionProbe() {
  await db.exec(`
    create or replace function public.test_leader_postcondition_probe()
    returns trigger language plpgsql as $$
    declare
      v_mode text := current_setting('test.leader_postcondition', true);
    begin
      if tg_table_name = 'direct_entry_team_leader_assignments' then
        if v_mode = 'team-count'
           and coalesce(current_setting('test.leader_postcondition_nested', true), '') <> 'on' then
          perform set_config('test.leader_postcondition_nested', 'on', true);
          insert into public.direct_entry_team_leader_assignments
            (team_id, leader_app_user_id, leader_recruiter_id, valid_from)
          values (new.team_id, '11000000-0000-4000-8000-000000002001'::uuid,
                  new.leader_recruiter_id, new.valid_from - 1);
          perform set_config('test.leader_postcondition_nested', '', true);
        elsif v_mode = 'one-team'
              and coalesce(current_setting('test.leader_postcondition_nested', true), '') <> 'on' then
          perform set_config('test.leader_postcondition_nested', 'on', true);
          insert into public.direct_entry_team_leader_assignments
            (team_id, leader_app_user_id, leader_recruiter_id, valid_from)
          values ('95000000-0000-4000-8000-0000000000a2'::uuid,
                  new.leader_app_user_id, new.leader_recruiter_id, new.valid_from - 1);
          perform set_config('test.leader_postcondition_nested', '', true);
        elsif v_mode = 'missing-team-leader' then
          return null;
        end if;
      elsif tg_table_name = 'direct_entry_scope_grants'
            and v_mode = 'scope-coextensive' then
        new.valid_to := new.valid_from + 1;
      elsif tg_table_name = 'direct_entry_capability_grants'
            and v_mode = 'coextensive' then
        new.valid_to := new.valid_from + 1;
      end if;
      return new;
    end;
    $$;
  `);
  await db.exec(`
    create trigger test_leader_postcondition_probe
      before insert on public.direct_entry_team_leader_assignments
      for each row execute function public.test_leader_postcondition_probe();
    create trigger test_leader_postcondition_probe
      before insert on public.direct_entry_capability_grants
      for each row execute function public.test_leader_postcondition_probe();
    create trigger test_leader_postcondition_probe
      before insert on public.direct_entry_scope_grants
      for each row execute function public.test_leader_postcondition_probe();
  `);
}

async function dropPostconditionProbe() {
  await db.exec(`
    drop trigger test_leader_postcondition_probe on public.direct_entry_team_leader_assignments;
    drop trigger test_leader_postcondition_probe on public.direct_entry_capability_grants;
    drop trigger test_leader_postcondition_probe on public.direct_entry_scope_grants;
    drop function public.test_leader_postcondition_probe();
  `);
}

test("P3.1-W01D-A1b2 designate, replace, revoke, rollback, authority and read lifecycle", async () => {
  const state = await createDatabase();
  db = state.db;
  const names = state.names;
  const inventoryBefore = state.baseline;
  const allMigrations = state.migrations;
  assert.equal(names.length, 71);
  assert.equal(names.at(-1), MIGRATION_71);

  await addTeam(TEAM_A, "TEAM_A");
  await addTeam(TEAM_B, "TEAM_B");
  await addTeam(TEAM_C, "TEAM_C");
  await addTeam(TEAM_INACTIVE, "TEAM_INACTIVE", false);
  await addTeam(TEAM_LEGACY, "TEAM_LEGACY");
  await db.query("insert into public.vendors(vendor_id,display_name) values ($1,'Synthetic vendor')", [VENDOR_ID]);
  reservedTeamId = (await db.query(
    "select public.direct_entry_system_vendor_team_id() as id")).rows[0].id;

  const fullAdmin = await addActor(1, {
    capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    scopes: [{ team: null }],
  });
  const catalog = await addActor(2, {
    capabilities: ["catalog_master_manage"], scopes: [{ team: null }],
  });
  const accountingOperator = await addActor(9, {
    capabilities: ["catalog_master_manage"], scopes: [{ team: null }],
  });
  const entryAdminOnly = await addActor(3, {
    capabilities: ["entry_admin"], scopes: [{ team: null }],
  });
  const catalogWithoutAll = await addActor(4, {
    capabilities: ["catalog_master_manage"], scopes: [{ team: TEAM_A }],
  });
  const leaderOperator = await addActor(5, {
    capabilities: ["team_manager_assign"], scopes: [{ team: TEAM_A }],
  });
  const pmOperator = await addActor(6, {
    capabilities: ["entry_team"], scopes: [{ team: TEAM_A }],
  });
  const staffOperator = await addActor(7, {
    capabilities: ["entry_create"], scopes: [{ team: TEAM_A }],
  });
  const disabledAdmin = await addActor(8, {
    enabled: false,
    capabilities: ["catalog_master_manage"],
    scopes: [{ team: null }],
  });
  const unmapped = { auth: uuid(900000), app: uuid(900001) };
  await db.query("insert into auth.users(id) values ($1::uuid)", [unmapped.auth]);

  today = (await db.query(
    "select public.direct_entry_authorization_date()::text as today")).rows[0].today;
  const initialLeader = await freshCandidate({ position: "TEAM_LEADER" });
  const initialKey = "designate-51";
  const initial = await withRole("service_role", () => designate(fullAdmin, TEAM_A, initialLeader, {
    key: initialKey,
  }));
  assert.equal(initial.change, "designate");
  assert.equal(initial.version, 2);
  assert.deepEqual(Object.keys(initial).sort(), [
    "assignment_id", "change", "leader_app_user_id", "leader_recruiter_id",
    "revision_id", "team_id", "valid_from", "valid_to", "version",
  ].sort());
  assert.equal(await countRows("direct_entry_team_leader_assignments",
    "team_id=$1::uuid and valid_to is null", [TEAM_A]), 1);
  assert.equal(await effectiveRows("direct_entry_scope_grants", initialLeader.app, TEAM_A), 1);
  assert.equal(await effectiveRows("direct_entry_capability_grants", initialLeader.app), 1);
  let audit = (await db.query(
    "select capability,scope_kind,action,changed_fields,reason_id,leader_revision_id"
      + " from public.direct_entry_audit_events where app_user_id=$1::uuid and resource_ref=$2",
    [fullAdmin.app, TEAM_A])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].capability, "entry_admin");
  assert.equal(audit[0].scope_kind, "all");
  assert.equal(audit[0].action, "team_leader_designate");
  assert.deepEqual(audit[0].changed_fields,
    ["team_leader_assignment", "team_scope", "team_manager_assign"]);
  assert.equal(audit[0].leader_revision_id, initial.revision_id);

  const initialSnapshot = await db.query(
    "select before_snapshot,after_snapshot,action,version"
      + " from public.direct_entry_team_leader_revisions where revision_id=$1::uuid",
    [initial.revision_id]);
  assert.equal(initialSnapshot.rows[0].before_snapshot, null);
  assert.deepEqual(Object.keys(initialSnapshot.rows[0].after_snapshot).sort(), SNAPSHOT_KEYS);
  assert.equal(initialSnapshot.rows[0].version, 2);

  const firstCounts = await teamState(TEAM_A, [initialLeader.app]);
  const replay = await designate(fullAdmin, TEAM_A, initialLeader, { key: initialKey });
  assert.deepEqual(replay, initial);
  assert.deepEqual(await teamState(TEAM_A, [initialLeader.app]), firstCounts);
  await deny(designate(fullAdmin, TEAM_A, initialLeader, {
    date: FAR_FUTURE, version: 1, key: initialKey,
  }), "22023");

  const nextLeader = await freshCandidate({ position: "STAFF" });
  const replacement = await withRole("service_role", () => designate(accountingOperator, TEAM_A, nextLeader, {
    date: today, version: 2, key: "replace-a",
  }));
  assert.equal(replacement.change, "replace");
  assert.equal(replacement.version, 3);
  assert.equal(await effectiveRows("direct_entry_scope_grants", initialLeader.app, TEAM_A), 0);
  assert.equal(await effectiveRows("direct_entry_capability_grants", initialLeader.app), 0);
  assert.equal(await effectiveRows("direct_entry_scope_grants", nextLeader.app, TEAM_A), 1);
  assert.equal(await effectiveRows("direct_entry_capability_grants", nextLeader.app), 1);
  assert.equal(await countRows("direct_entry_team_leader_assignments",
    "team_id=$1::uuid and valid_to is null", [TEAM_A]), 1);
  const outgoing = (await db.query(
    "select valid_to::text as valid_to from public.direct_entry_team_leader_assignments"
      + " where team_id=$1::uuid and leader_app_user_id=$2::uuid",
    [TEAM_A, initialLeader.app])).rows[0];
  assert.equal(outgoing.valid_to, today);
  audit = (await db.query(
    "select capability,scope_kind,action from public.direct_entry_audit_events"
      + " where app_user_id=$1::uuid and leader_revision_id=$2::uuid",
    [accountingOperator.app, replacement.revision_id])).rows[0];
  assert.deepEqual(audit, {
    capability: "catalog_master_manage", scope_kind: "all", action: "team_leader_replace",
  });
  const currentRead = (await db.query(
    "select public.direct_entry_list_team_leaders_current($1::uuid,$2::uuid,$3::uuid)"
      + " as result",
    [catalog.auth, catalog.app, TEAM_A])).rows[0].result;
  assert.equal(currentRead.total, 1);
  assert.equal(currentRead.leaders[0].leader_app_user_id, nextLeader.app);
  assert.equal(Object.keys(currentRead.leaders[0]).length, 9);
  for (const forbidden of ["auth_subject", "email", "grant_id", "scope_kind", "reason", "audit"]) {
    assert.equal(forbidden in currentRead.leaders[0], false);
  }
  const teamAHistory = (await db.query(
    "select public.direct_entry_list_team_leader_history($1::uuid,$2::uuid,$3::uuid) as result",
    [catalog.auth, catalog.app, TEAM_A])).rows[0].result;
  assert.ok(teamAHistory.leaders.some((row) =>
    row.leader_app_user_id === initialLeader.app && row.state === "HISTORY"));

  const scheduledTeam = await freshCandidate({ memberships: [TEAM_B] });
  const futureDesignation = await designate(catalog, TEAM_B, scheduledTeam, {
    date: FAR_FUTURE, key: "future-designate",
  });
  assert.equal(futureDesignation.change, "designate");
  assert.equal(await effectiveRows("direct_entry_scope_grants", scheduledTeam.app, TEAM_B), 0);
  assert.equal(await effectiveRows("direct_entry_capability_grants", scheduledTeam.app), 0);
  const scheduledRead = (await db.query(
    "select public.direct_entry_list_team_leaders_scheduled($1::uuid,$2::uuid,$3::uuid)"
      + " as result",
    [catalog.auth, catalog.app, TEAM_B])).rows[0].result;
  assert.equal(scheduledRead.total, 1);
  assert.equal(scheduledRead.leaders[0].leader_app_user_id, scheduledTeam.app);
  const cancelledFuture = await revoke(catalog, TEAM_B, {
    date: FAR_FUTURE, version: 2, key: "cancel-future-designate",
  });
  assert.equal(cancelledFuture.change, "revoke");
  assert.equal(await countRows("direct_entry_team_leader_assignments",
    "team_id=$1::uuid and valid_from=valid_to and valid_from=$2::date", [TEAM_B, FAR_FUTURE]), 1);
  assert.equal(await countRows("direct_entry_scope_grants",
    "app_user_id=$1::uuid and team_id=$2::uuid and valid_from=valid_to and valid_from=$3::date",
    [scheduledTeam.app, TEAM_B, FAR_FUTURE]), 1);
  assert.equal(await countRows("direct_entry_capability_grants",
    "app_user_id=$1::uuid and capability='team_manager_assign' and valid_from=valid_to and valid_from=$2::date",
    [scheduledTeam.app, FAR_FUTURE]), 1);
  const historyRead = (await db.query(
    "select public.direct_entry_list_team_leader_history($1::uuid,$2::uuid,$3::uuid) as result",
    [catalog.auth, catalog.app, TEAM_B])).rows[0].result;
  assert.ok(historyRead.leaders.some((row) => row.valid_from === FAR_FUTURE
    && row.valid_to === FAR_FUTURE && row.state === "HISTORY"));
  assert.equal((await db.query(
    "select public.direct_entry_list_team_leaders_scheduled($1::uuid,$2::uuid,$3::uuid) as result",
    [catalog.auth, catalog.app, TEAM_B])).rows[0].result.total, 0);
  assert.equal((await db.query(
    "select public.direct_entry_list_team_leaders_current($1::uuid,$2::uuid,$3::uuid) as result",
    [catalog.auth, catalog.app, TEAM_B])).rows[0].result.total, 0);

  const futureRevokeLeader = await freshCandidate({ memberships: [TEAM_C] });
  await designate(fullAdmin, TEAM_C, futureRevokeLeader, { key: "future-revoke-start" });
  const futureRevoke = await revoke(catalog, TEAM_C, {
    date: FAR_FUTURE, version: 2, key: "future-revoke",
  });
  assert.equal(futureRevoke.valid_to, FAR_FUTURE);
  assert.equal(await effectiveRows("direct_entry_scope_grants", futureRevokeLeader.app, TEAM_C), 1);
  assert.equal(await effectiveRows("direct_entry_capability_grants", futureRevokeLeader.app), 1);
  assert.equal((await db.query(
    "select public.direct_entry_list_team_leaders_current($1::uuid,$2::uuid,$3::uuid) as result",
    [catalog.auth, catalog.app, TEAM_C])).rows[0].result.total, 1);
  const sameDayRevoked = await revoke(catalog, TEAM_C, {
    date: today, version: 3, key: "same-day-revoke",
  });
  assert.equal(sameDayRevoked.change, "revoke");
  assert.equal(await countRows("direct_entry_team_leader_assignments",
    "team_id=$1::uuid and valid_from=valid_to and valid_from=$2::date",
    [TEAM_C, today]), 1);
  assert.equal(await effectiveRows("direct_entry_scope_grants", futureRevokeLeader.app, TEAM_C), 0);
  assert.equal(await effectiveRows("direct_entry_capability_grants", futureRevokeLeader.app), 0);
  assert.equal((await db.query(
    "select public.direct_entry_list_team_leaders_current($1::uuid,$2::uuid,$3::uuid) as result",
    [catalog.auth, catalog.app, TEAM_C])).rows[0].result.total, 0);

  const reservedCandidate = await freshCandidate({
    memberships: [reservedTeamId], bypassIntervalGuards: true,
  });
  const reservedBefore = await teamState(reservedTeamId, [reservedCandidate.app]);
  await deny(designate(fullAdmin, reservedTeamId, reservedCandidate, {
    key: "reserved-team-designate",
  }), "23514");
  await deny(revoke(fullAdmin, reservedTeamId, {
    key: "reserved-team-revoke",
  }), "23514");
  assert.deepEqual(await teamState(reservedTeamId, [reservedCandidate.app]), reservedBefore);

  await installPostconditionProbe();
  for (const [index, mode] of [
    "team-count", "one-team", "coextensive", "scope-coextensive", "missing-team-leader",
  ].entries()) {
    const team = uuid(60000 + index);
    await addTeam(team, `POSTCONDITION_${mode.toUpperCase()}`);
    const candidate = await freshCandidate({ memberships: [team] });
    const before = await teamState(team, [candidate.app]);
    await db.query("select set_config('test.leader_postcondition',$1,false)", [mode]);
    await assert.rejects(designate(fullAdmin, team, candidate, {
      key: `postcondition-${mode}`,
    }), (error) => error.code === "55000", `${mode} postcondition must fail closed`);
    await db.query("select set_config('test.leader_postcondition','',false)");
    await db.query("select set_config('test.leader_postcondition_nested','',false)");
    assert.deepEqual(await teamState(team, [candidate.app]), before, `${mode} postcondition rolled back`);
    assert.equal(await countRows("direct_entry_team_leader_assignments",
      "leader_app_user_id=$1::uuid", [candidate.app]), 0);
  }
  await dropPostconditionProbe();

  const wrongTeamCandidate = await freshCandidate({ memberships: [TEAM_B] });
  await deny(designate(fullAdmin, TEAM_A, wrongTeamCandidate, {
    version: 3, key: "wrong-team-member",
  }));
  const positionOnly = await freshCandidate({
    position: "TEAM_LEADER", providers: [], memberships: [], links: [],
  });
  await deny(designate(fullAdmin, TEAM_C, positionOnly, {
    version: 4, key: "position-only",
  }));
  const nonLeaderPosition = await freshCandidate({ position: "STAFF", memberships: [TEAM_C] });
  const positionIndependent = await designate(fullAdmin, TEAM_C, nonLeaderPosition, {
    version: 4, key: "non-leader-position",
  });
  assert.equal(positionIndependent.change, "designate");

  const entryAdminTarget = await freshCandidate();
  await deny(designate(entryAdminOnly, TEAM_C, entryAdminTarget, {
    date: null, version: null, reason: null, key: "entry-admin-only",
  }));
  await deny(designate(catalogWithoutAll, TEAM_C, await freshCandidate(), {
    key: "catalog-no-all",
  }));
  await deny(designate(leaderOperator, TEAM_C, await freshCandidate(), {
    key: "leader-operator",
  }));
  await deny(designate(pmOperator, TEAM_C, await freshCandidate(), {
    key: "pm-operator",
  }));
  await deny(designate(staffOperator, TEAM_C, await freshCandidate(), {
    key: "staff-operator",
  }));
  await deny(designate(disabledAdmin, TEAM_C, await freshCandidate(), {
    key: "disabled-admin",
  }));
  await deny(designate(unmapped, TEAM_C, await freshCandidate(), {
    key: "unmapped-actor",
  }));
  await deny(designate({ auth: fullAdmin.auth, app: catalog.app }, TEAM_C,
    await freshCandidate(), { key: "mismatched-actor" }));
  await deny(designate(entryAdminOnly, null, await freshCandidate(), {
    key: "invalid-team-unauthorized",
  }));

  const invalidCandidates = [
    { enabled: false },
    { links: [] },
    { links: [{ verified: false }], bypassIntervalGuards: true },
    { links: [
      { verified: true }, { verified: true, from: "2021-01-01" },
    ], bypassIntervalGuards: true },
    { active: false },
    { providers: [] },
    { providers: [{ type: "hrp", from: PAST, to: today }] },
    { providers: [{ type: "hrp", from: FAR_FUTURE }] },
    { providers: [{ type: "vendor", from: PAST }], memberships: [] },
    { providers: [
      { type: "hrp", from: PAST }, { type: "vendor", from: "2021-01-01" },
    ], bypassIntervalGuards: true, memberships: [] },
    { memberships: [] },
    { memberships: [TEAM_B] },
    { memberships: [{ team: TEAM_A, from: PAST, to: today }] },
    { memberships: [{ team: TEAM_A, from: FAR_FUTURE }] },
    { memberships: [TEAM_A, { team: TEAM_B, from: "2021-01-01" }], bypassIntervalGuards: true },
  ];
  for (let i = 0; i < invalidCandidates.length; i++) {
    const candidate = await freshCandidate(invalidCandidates[i]);
    await deny(designate(fullAdmin, TEAM_A, candidate, {
      version: 3, key: `eligibility-${i}`,
    }));
  }

  const multiTeamLeader = await freshCandidate({ memberships: [TEAM_A] });
  await db.query(
    "insert into public.direct_entry_team_leader_assignments"
      + "(team_id,leader_app_user_id,leader_recruiter_id,valid_from)"
      + " values ($1::uuid,$2::uuid,$3::uuid,$4::date)",
    [TEAM_B, multiTeamLeader.app, multiTeamLeader.recruiter, PAST]);
  await deny(designate(fullAdmin, TEAM_A, multiTeamLeader, {
    version: 3, key: "other-team-leader",
  }));
  const scheduledOtherTeamLeader = await freshCandidate({ memberships: [TEAM_A] });
  await db.query(
    "insert into public.direct_entry_team_leader_assignments"
      + "(team_id,leader_app_user_id,leader_recruiter_id,valid_from)"
      + " values ($1::uuid,$2::uuid,$3::uuid,$4::date)",
    [TEAM_B, scheduledOtherTeamLeader.app, scheduledOtherTeamLeader.recruiter, FAR_FUTURE]);
  await deny(designate(fullAdmin, TEAM_A, scheduledOtherTeamLeader, {
    version: 3, key: "scheduled-other-team-leader",
  }));

  const futureGrantCandidate = await freshCandidate();
  await db.query(
    "insert into public.direct_entry_scope_grants"
      + "(app_user_id,scope_kind,team_id,valid_from) values ($1::uuid,'team',$2::uuid,$3::date)",
    [futureGrantCandidate.app, TEAM_A, FAR_FUTURE]);
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)"
      + " values ($1::uuid,'team_manager_assign',$2::date)",
    [futureGrantCandidate.app, FAR_FUTURE]);
  await deny(designate(fullAdmin, TEAM_A, futureGrantCandidate, {
    version: 3, key: "future-preexisting-grants",
  }));

  const legacyLeader = await freshCandidate({ memberships: [TEAM_LEGACY] });
  await db.query(
    "insert into public.direct_entry_team_leader_assignments"
      + "(team_id,leader_app_user_id,leader_recruiter_id,valid_from)"
      + " values ($1::uuid,$2::uuid,$3::uuid,$4::date)",
    [TEAM_LEGACY, legacyLeader.app, legacyLeader.recruiter, PAST]);
  const legacyVersion = (await db.query(
    "select version from public.teams where team_id=$1::uuid", [TEAM_LEGACY])).rows[0].version;
  const legacyBefore = await teamState(TEAM_LEGACY, [legacyLeader.app]);
  const legacyIncoming = await freshCandidate({ memberships: [TEAM_LEGACY] });
  await deny(designate(fullAdmin, TEAM_LEGACY, legacyIncoming, {
    version: legacyVersion, key: "legacy-mismatch-replace",
  }));
  await deny(revoke(fullAdmin, TEAM_LEGACY, {
    version: legacyVersion, key: "legacy-mismatch-revoke",
  }));
  assert.deepEqual(await teamState(TEAM_LEGACY, [legacyLeader.app]), legacyBefore);

  const badGrantTeam = "95000000-0000-4000-8000-0000000000aa";
  await addTeam(badGrantTeam, "BAD_GRANT_TEAM");
  const badGrantLeader = await freshCandidate({ memberships: [badGrantTeam] });
  await db.query(
    "insert into public.direct_entry_team_leader_assignments"
      + "(team_id,leader_app_user_id,leader_recruiter_id,valid_from)"
      + " values ($1::uuid,$2::uuid,$3::uuid,$4::date)",
    [badGrantTeam, badGrantLeader.app, badGrantLeader.recruiter, PAST]);
  await db.query(
    "insert into public.direct_entry_scope_grants"
      + "(app_user_id,scope_kind,team_id,valid_from,valid_to)"
      + " values ($1::uuid,'team',$2::uuid,$3::date,$4::date)",
    [badGrantLeader.app, badGrantTeam, PAST, today]);
  await db.query(
    "insert into public.direct_entry_capability_grants"
      + "(app_user_id,capability,valid_from) values ($1::uuid,'team_manager_assign',$2::date)",
    [badGrantLeader.app, PAST]);
  const badGrantBefore = await teamState(badGrantTeam, [badGrantLeader.app]);
  await deny(revoke(fullAdmin, badGrantTeam, {
    version: 1, key: "expired-outgoing-scope",
  }));
  assert.deepEqual(await teamState(badGrantTeam, [badGrantLeader.app]), badGrantBefore);

  const inactiveTeamCandidate = await freshCandidate({ memberships: [TEAM_INACTIVE] });
  await deny(designate(fullAdmin, TEAM_INACTIVE, inactiveTeamCandidate, {
    key: "inactive-designate",
  }), "23514");
  const inactiveRevokeTeam = "95000000-0000-4000-8000-0000000000a7";
  await addTeam(inactiveRevokeTeam, "INACTIVE_REVOKE");
  const inactiveLeader = await freshCandidate({ memberships: [inactiveRevokeTeam] });
  await designate(fullAdmin, inactiveRevokeTeam, inactiveLeader, {
    date: PAST, key: "inactive-revoke-seed",
  });
  await db.query("update public.teams set active=false where team_id=$1::uuid", [inactiveRevokeTeam]);
  const inactiveVersion = (await db.query(
    "select version from public.teams where team_id=$1::uuid", [inactiveRevokeTeam])).rows[0].version;
  const inactiveRevoked = await revoke(catalog, inactiveRevokeTeam, {
    version: inactiveVersion, key: "inactive-revoke",
  });
  assert.equal(inactiveRevoked.change, "revoke");
  assert.equal(inactiveRevoked.valid_to, today);
  assert.equal((await db.query(
    "select public.direct_entry_list_team_leaders_current($1::uuid,$2::uuid,$3::uuid) as result",
    [catalog.auth, catalog.app, inactiveRevokeTeam])).rows[0].result.total, 0);

  const staleTeam = "95000000-0000-4000-8000-0000000000a8";
  await addTeam(staleTeam, "STALE_TEAM");
  const staleCandidate = await freshCandidate({ memberships: [staleTeam] });
  const staleBefore = await teamState(staleTeam, [staleCandidate.app]);
  await deny(designate(fullAdmin, staleTeam, staleCandidate, {
    version: 0, key: "stale-version",
  }), "22023");
  await deny(designate(fullAdmin, staleTeam, staleCandidate, {
    version: 9, key: "stale-version-conflict",
  }), "40001");
  assert.deepEqual(await teamState(staleTeam, [staleCandidate.app]), staleBefore);

  const concurrentTeam = "95000000-0000-4000-8000-0000000000a9";
  await addTeam(concurrentTeam, "CONCURRENT_TEAM");
  const concurrentOld = await freshCandidate({ memberships: [concurrentTeam] });
  await designate(fullAdmin, concurrentTeam, concurrentOld, { key: "concurrent-seed" });
  const concurrentIncoming = await freshCandidate({ memberships: [concurrentTeam] });
  const race = await Promise.allSettled([
    designate(catalog, concurrentTeam, concurrentIncoming, {
      version: 2, key: "concurrent-replace",
    }),
    revoke(fullAdmin, concurrentTeam, {
      version: 2, key: "concurrent-revoke",
    }),
  ]);
  assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
  const loser = race.find((result) => result.status === "rejected");
  assert.equal(loser.reason.code, "40001");
  assert.equal((await db.query(
    "select version from public.teams where team_id=$1::uuid", [concurrentTeam])).rows[0].version, 3);
  assert.equal(await countRows("direct_entry_team_leader_revisions",
    "team_id=$1::uuid", [concurrentTeam]), 2);
  assert.equal(await countRows("direct_entry_audit_events",
    "resource_ref=$1 and leader_revision_id is not null", [concurrentTeam]), 2);

  const rawMarkerDate = "2050-01-01";
  for (const table of [
    "direct_entry_team_leader_assignments",
    "direct_entry_scope_grants",
    "direct_entry_capability_grants",
  ]) {
    if (table === "direct_entry_team_leader_assignments") {
      await deny(db.query(
        `insert into public.${table}(team_id,leader_app_user_id,leader_recruiter_id,valid_from,valid_to)`
          + " values ($1::uuid,$2::uuid,$3::uuid,$4::date,$4::date)",
        [TEAM_B, initialLeader.app, initialLeader.recruiter, rawMarkerDate]), "23514");
    } else if (table === "direct_entry_scope_grants") {
      await deny(db.query(
        `insert into public.${table}(app_user_id,scope_kind,team_id,valid_from,valid_to)`
          + " values ($1::uuid,'team',$2::uuid,$3::date,$3::date)",
        [initialLeader.app, TEAM_B, rawMarkerDate]), "23514");
    } else {
      await deny(db.query(
        `insert into public.${table}(app_user_id,capability,valid_from,valid_to)`
          + " values ($1::uuid,'team_manager_assign',$2::date,$2::date)",
        [initialLeader.app, rawMarkerDate]), "23514");
    }
  }

  for (const [table, operation] of [
    ["direct_entry_team_leader_assignments", "insert or update"],
    ["direct_entry_scope_grants", "insert or update"],
    ["direct_entry_capability_grants", "insert or update"],
    ["direct_entry_team_leader_revisions", "insert"],
    ["direct_entry_audit_events", "insert"],
    ["direct_entry_rpc_idempotency", "update"],
  ]) {
    const injectedTeam = uuid(50000 + nextActorId);
    await addTeam(injectedTeam, `FAIL_${table}`);
    const candidate = await freshCandidate({ memberships: [injectedTeam] });
    const before = await teamState(injectedTeam, [candidate.app]);
    await installFailureTrigger(table, operation);
    await db.query("select set_config('test.leader_write_fail',$1,false)", [table]);
    await deny(designate(fullAdmin, injectedTeam, candidate, {
      key: `injection-${table}`,
    }), "P0001");
    await db.query("select set_config('test.leader_write_fail','',false)");
    await db.exec(`drop trigger test_leader_write_failure on public.${table}`);
    assert.deepEqual(await teamState(injectedTeam, [candidate.app]), before, `${table} failure rolled back`);
  }
  for (const table of [
    "direct_entry_capability_grants",
    "direct_entry_team_leader_revisions",
    "direct_entry_audit_events",
    "direct_entry_rpc_idempotency",
  ]) {
    const replacementTeam = uuid(70000 + nextActorId);
    const key = `replacement-injection-${table}`;
    await addTeam(replacementTeam, `REPLACEMENT_FAIL_${table}`);
    const outgoingLeader = await freshCandidate({ memberships: [replacementTeam] });
    const incomingLeader = await freshCandidate({ memberships: [replacementTeam] });
    await designate(fullAdmin, replacementTeam, outgoingLeader, {
      date: PAST, key: `replacement-seed-${table}`,
    });
    const actorIds = [outgoingLeader.app, incomingLeader.app];
    const before = await replacementSnapshot(replacementTeam, actorIds, fullAdmin, key);
    await installFailureTrigger(table, table === "direct_entry_rpc_idempotency" ? "update" : "insert or update");
    await db.query("select set_config('test.leader_write_fail',$1,false)", [table]);
    await deny(designate(fullAdmin, replacementTeam, incomingLeader, {
      date: today, version: 2, key,
    }), "P0001");
    await db.query("select set_config('test.leader_write_fail','',false)");
    await db.exec(`drop trigger test_leader_write_failure on public.${table}`);
    assert.deepEqual(
      await replacementSnapshot(replacementTeam, actorIds, fullAdmin, key),
      before,
      `${table} replacement failure rolled back every row`,
    );
    assert.equal(await effectiveRows("direct_entry_scope_grants", outgoingLeader.app, replacementTeam), 1);
    assert.equal(await effectiveRows("direct_entry_capability_grants", outgoingLeader.app), 1);
    assert.equal(await effectiveRows("direct_entry_scope_grants", incomingLeader.app, replacementTeam), 0);
    assert.equal(await effectiveRows("direct_entry_capability_grants", incomingLeader.app), 0);
    const stillOutgoing = await db.query(
      "select count(*)::int as n from public.direct_entry_team_leader_assignments"
        + " where team_id=$1::uuid and leader_app_user_id=$2::uuid"
        + " and valid_from <= $3::date and (valid_to is null or $3::date < valid_to)",
      [replacementTeam, outgoingLeader.app, today]);
    assert.equal(stillOutgoing.rows[0].n, 1);
    assert.equal(await countRows("direct_entry_team_leader_assignments",
      "team_id=$1::uuid and leader_app_user_id=$2::uuid",
      [replacementTeam, incomingLeader.app]), 0);

    const recovered = await designate(fullAdmin, replacementTeam, incomingLeader, {
      date: today, version: 2, key,
    });
    assert.equal(recovered.change, "replace");
    assert.equal(recovered.version, 3);
    assert.equal(await effectiveRows("direct_entry_scope_grants", outgoingLeader.app, replacementTeam), 0);
    assert.equal(await effectiveRows("direct_entry_capability_grants", outgoingLeader.app), 0);
    assert.equal(await effectiveRows("direct_entry_scope_grants", incomingLeader.app, replacementTeam), 1);
    assert.equal(await effectiveRows("direct_entry_capability_grants", incomingLeader.app), 1);
  }
  await db.exec("drop function public.test_fail_leader_write()");

  const functionRows = (await db.query(`
    select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as config,
           p.proargnames as argnames,
           has_function_privilege('public',p.oid,'EXECUTE') as public_exec,
           has_function_privilege('anon',p.oid,'EXECUTE') as anon_exec,
           has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_exec,
           has_function_privilege('service_role',p.oid,'EXECUTE') as service_exec,
           pg_get_functiondef(p.oid) as source
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname like 'direct_entry\\_%'
  `)).rows;
  for (const name of WRITE_RPCS) {
    const rows = functionRows.filter((row) => row.proname === name);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prosecdef, true);
    assert.equal(rows[0].config, "search_path=pg_catalog, public");
    assert.equal(rows[0].public_exec || rows[0].anon_exec || rows[0].authenticated_exec, false);
    assert.equal(rows[0].service_exec, true);
    assert.ok(rows[0].source.includes("direct_entry_assert_catalog_operator"));
    assert.equal(rows[0].source.includes("personnel_position"), false);
    assert.equal(rows[0].source.includes("direct_entry_system_vendor_team_id"), false);
  }
  assert.deepEqual(
    functionRows.find((row) => row.proname === WRITE_RPCS[0]).argnames,
    ["p_auth_subject", "p_app_user_id", "p_team_id", "p_leader_app_user_id",
      "p_effective_date", "p_expected_version", "p_reason", "p_idempotency_key"],
  );
  assert.deepEqual(
    functionRows.find((row) => row.proname === WRITE_RPCS[1]).argnames,
    ["p_auth_subject", "p_app_user_id", "p_team_id", "p_effective_date",
      "p_expected_version", "p_reason", "p_idempotency_key"],
  );
  const internal = functionRows.find((row) => row.proname === "direct_entry_apply_team_leader_mutation");
  assert.ok(internal);
  assert.equal(internal.prosecdef, true);
  assert.equal(internal.config, "search_path=pg_catalog, public");
  assert.equal(internal.public_exec || internal.anon_exec
    || internal.authenticated_exec || internal.service_exec, false);
  assert.equal(internal.source.includes("direct_entry_system_vendor_team_id"), false);
  assert.equal(functionRows.filter((row) => row.proname.startsWith("direct_entry_assert_team_leader")).length, 1);
  assert.equal(await db.query(
    "select to_regprocedure('public.direct_entry_assert_team_leader_authority(uuid,uuid,uuid)')"
      + " is null as absent").then((result) => result.rows[0].absent), true);
  const protectedTables = (await db.query(`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity,
           has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as public_priv,
           has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as anon_priv,
           has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as authenticated_priv,
           has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as service_priv
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public'
       and c.relname in ('direct_entry_team_leader_assignments',
                         'direct_entry_team_leader_revisions')
  `)).rows;
  assert.equal(protectedTables.length, 2);
  for (const table of protectedTables) {
    assert.equal(table.relrowsecurity, true);
    assert.equal(table.relforcerowsecurity, true);
    assert.equal(table.public_priv || table.anon_priv || table.authenticated_priv
      || table.service_priv, false);
  }
  for (const name of [
    "direct_entry_list_team_leaders_current",
    "direct_entry_list_team_leaders_scheduled",
    "direct_entry_list_team_leader_history",
  ]) {
    const row = functionRows.find((fn) => fn.proname === name);
    assert.ok(row && row.prosecdef && row.config === "search_path=pg_catalog, public");
    assert.equal(row.public_exec || row.anon_exec || row.authenticated_exec, false);
    assert.equal(row.service_exec, true);
  }
  const oldNames = expectedDirectEntryFunctions(allMigrations.slice(0, -1));
  const allNames = expectedDirectEntryFunctions(allMigrations);
  assert.deepEqual([...new Set(functionRows.map((row) => row.proname))].sort(), [...allNames].sort());
  assert.deepEqual([...allNames].filter((name) => !oldNames.has(name)).sort(), [
    "direct_entry_apply_team_leader_mutation",
    "direct_entry_assert_team_leader_read_authority",
    "direct_entry_designate_team_leader",
    "direct_entry_list_team_leader_history",
    "direct_entry_list_team_leaders_current",
    "direct_entry_list_team_leaders_scheduled",
    "direct_entry_revoke_team_leader",
    "direct_entry_team_leader_marker",
    "direct_entry_team_leader_projection",
    "direct_entry_team_leader_snapshot",
  ]);
  const inventoryAfter = await inventory(db);
  assert.deepEqual(
    [inventoryAfter.total, inventoryAfter.service, inventoryAfter.internal],
    [172, 81, 91],
  );
  assert.deepEqual(
    [inventoryAfter.total - inventoryBefore.total,
      inventoryAfter.service - inventoryBefore.service,
      inventoryAfter.internal - inventoryBefore.internal],
    [10, 5, 5],
  );
  console.log(`Direct Entry function inventory: #70 ${inventoryBefore.total}/${inventoryBefore.service}/${inventoryBefore.internal}; #71 ${inventoryAfter.total}/${inventoryAfter.service}/${inventoryAfter.internal}. A1b2 adds one internal helper and two service-role RPCs.`);

  const roleDeniedTarget = await freshCandidate({ memberships: [TEAM_C] });
  await withRole("authenticated", async () => {
    await deny(designate(fullAdmin, TEAM_C, roleDeniedTarget, {
      version: 5, key: "auth-role-denied",
    }), "42501");
  });
  await db.close();
});
