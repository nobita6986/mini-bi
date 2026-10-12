import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const NEW_MIGRATION = "20261011180000_p3_1_w03b_capability_scope_lifecycle.sql";
const BASE_MIGRATION_COUNT = 84;

const ADMIN_AUTH = "10000000-0000-4000-8000-000000000001";
const ADMIN_APP = "20000000-0000-4000-8000-000000000001";
const ACCOUNTING_AUTH = "10000000-0000-4000-8000-000000000002";
const ACCOUNTING_APP = "20000000-0000-4000-8000-000000000002";
const LEADER_AUTH = "10000000-0000-4000-8000-000000000003";
const LEADER_APP = "20000000-0000-4000-8000-000000000003";
const STAFF_AUTH = "10000000-0000-4000-8000-000000000004";
const STAFF_APP = "20000000-0000-4000-8000-000000000004";
const TARGET_AUTH = "10000000-0000-4000-8000-000000000005";
const TARGET_APP = "20000000-0000-4000-8000-000000000005";
const DISABLED_ADMIN_AUTH = "10000000-0000-4000-8000-000000000006";
const DISABLED_ADMIN_APP = "20000000-0000-4000-8000-000000000006";
const DISABLED_TARGET_AUTH = "10000000-0000-4000-8000-000000000007";
const DISABLED_TARGET_APP = "20000000-0000-4000-8000-000000000007";
const LEADER_TARGET_AUTH = "10000000-0000-4000-8000-000000000008";
const LEADER_TARGET_APP = "20000000-0000-4000-8000-000000000008";
const TEAM_ID = "30000000-0000-4000-8000-000000000001";
const RECRUITER_ID = "40000000-0000-4000-8000-000000000001";
const MISSING_APP = "20000000-0000-4000-8000-0000000000ff";
const MISSING_GRANT = "50000000-0000-4000-8000-0000000000ff";
const REASON = "Synthetic W03B lifecycle reason";

async function migrationNames() {
  return (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
}

async function readMigration(name) {
  return readFile(path.join(MIGRATION_DIR, name), "utf8");
}

async function database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  for (const name of await migrationNames()) await db.exec(await readMigration(name));
  return db;
}

async function query(db, sql, values = []) {
  return (await db.query(sql, values)).rows;
}

async function grantCapability(db, [auth, actor, target, capability, validFrom, version, reason, key]) {
  return (await query(db, `select public.direct_entry_grant_capability(
    $1::uuid,$2::uuid,$3::uuid,$4::text,$5::date,$6::integer,$7::text,$8::text) as result`,
    [auth, actor, target, capability, validFrom, version, reason, key]))[0].result;
}

async function revokeCapability(db, [auth, actor, target, grantId, effectiveDate, version, reason, key]) {
  return (await query(db, `select public.direct_entry_revoke_capability(
    $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,$6::integer,$7::text,$8::text) as result`,
    [auth, actor, target, grantId, effectiveDate, version, reason, key]))[0].result;
}

async function grantScope(db, [auth, actor, target, scopeKind, teamId, validFrom, version, reason, key]) {
  return (await query(db, `select public.direct_entry_grant_scope(
    $1::uuid,$2::uuid,$3::uuid,$4::text,$5::uuid,$6::date,$7::integer,$8::text,$9::text) as result`,
    [auth, actor, target, scopeKind, teamId, validFrom, version, reason, key]))[0].result;
}

async function revokeScope(db, [auth, actor, target, grantId, effectiveDate, version, reason, key]) {
  return (await query(db, `select public.direct_entry_revoke_scope(
    $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::date,$6::integer,$7::text,$8::text) as result`,
    [auth, actor, target, grantId, effectiveDate, version, reason, key]))[0].result;
}

async function appUser(db, appUserId) {
  return (await query(db, "select enabled, version from public.direct_entry_app_users where app_user_id = $1", [appUserId]))[0];
}

async function today(db) {
  return (await query(db, "select public.direct_entry_authorization_date()::text as d"))[0].d;
}

async function capabilityRows(db, appUserId) {
  return query(db, `select grant_id::text, capability, valid_from::text, valid_to::text
    from public.direct_entry_capability_grants where app_user_id = $1 order by grant_id`, [appUserId]);
}

async function scopeRows(db, appUserId) {
  return query(db, `select grant_id::text, scope_kind, team_id::text, valid_from::text, valid_to::text
    from public.direct_entry_scope_grants where app_user_id = $1 order by grant_id`, [appUserId]);
}

async function seed(db) {
  await db.query(
    "insert into auth.users (id) values ($1),($2),($3),($4),($5),($6),($7),($8)",
    [ADMIN_AUTH, ACCOUNTING_AUTH, LEADER_AUTH, STAFF_AUTH, TARGET_AUTH,
      DISABLED_ADMIN_AUTH, DISABLED_TARGET_AUTH, LEADER_TARGET_AUTH],
  );
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
     values ($1,$2,'Synthetic Admin',true),($3,$4,'Synthetic Accounting',true),
            ($5,$6,'Synthetic Leader',true),($7,$8,'Synthetic Staff',true),
            ($9,$10,'Synthetic Target',true),($11,$12,'Synthetic Disabled Admin',false),
            ($13,$14,'Synthetic Disabled Target',false),($15,$16,'Synthetic Leader Target',true)`,
    [ADMIN_APP, ADMIN_AUTH, ACCOUNTING_APP, ACCOUNTING_AUTH, LEADER_APP, LEADER_AUTH,
      STAFF_APP, STAFF_AUTH, TARGET_APP, TARGET_AUTH, DISABLED_ADMIN_APP, DISABLED_ADMIN_AUTH,
      DISABLED_TARGET_APP, DISABLED_TARGET_AUTH, LEADER_TARGET_APP, LEADER_TARGET_AUTH],
  );
  await db.query("insert into public.teams (team_id, code, display_name) values ($1,'w03b_team','W03B Team')", [TEAM_ID]);
  // The reserved vendor team is created lazily in production; materialize it here so the
  // scope-grant vendor rejection can be exercised.
  await db.query(
    `insert into public.teams (code, display_name, active)
     values ('__system_vendor__','Vendor',true) on conflict (code) do nothing`);
  await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,'W03B Recruiter')", [RECRUITER_ID]);
  await db.query(
    `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from)
     values ($1,$2,true,'2026-01-01')`, [TARGET_APP, RECRUITER_ID]);

  // Actor authority seeds.
  const fullAdmin = ["entry_admin", "recruiter_master_manage", "team_master_manage"];
  for (const appUserId of [ADMIN_APP, DISABLED_ADMIN_APP]) {
    for (const [index, capability] of fullAdmin.entries()) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)
         values ($1,$2,$3::date)`, [appUserId, capability, `2026-01-0${index + 1}`]);
    }
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from)
       values ($1,'all','2026-01-01')`, [appUserId]);
  }
  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)
     values ($1,'catalog_master_manage','2026-01-01'),
            ($2,'team_manager_assign','2026-01-01'),
            ($3,'entry_create','2026-01-01')`, [ACCOUNTING_APP, LEADER_APP, STAFF_APP]);
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from)
     values ($1,'all',null,'2026-01-01'),($2,'team',$3,'2026-01-01'),($4,'own',null,'2026-01-01')`,
    [ACCOUNTING_APP, LEADER_APP, TEAM_ID, STAFF_APP]);

  // LEADER_TARGET is an enabled app user already holding a leader bundle: a current
  // team_manager_assign capability plus a team scope row on TEAM_ID. W03B must refuse
  // to grant or revoke a team scope for it (owned by the W01D leader lifecycle).
  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)
     values ($1,'team_manager_assign','2026-01-01')`, [LEADER_TARGET_APP]);
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from)
     values ($1,'team',$2,'2026-01-01')`, [LEADER_TARGET_APP, TEAM_ID]);
}

async function assertSqlState(operation, code) {
  await assert.rejects(operation, (error) => error.code === code);
}

async function vendorTeamId(db) {
  return (await query(db, "select team_id::text as id from public.teams where code = '__system_vendor__'"))[0].id;
}

test("W03B migration is #85 append-only and exposes the locked schema and ACL", async () => {
  const names = await migrationNames();
  assert.equal(names.length, BASE_MIGRATION_COUNT + 1);
  assert.ok(names.includes(NEW_MIGRATION));
  assert.equal(names[names.length - 1], NEW_MIGRATION);

  const db = await database();

  const rpcSignatures = [
    "public.direct_entry_grant_capability(uuid,uuid,uuid,text,date,integer,text,text)",
    "public.direct_entry_revoke_capability(uuid,uuid,uuid,uuid,date,integer,text,text)",
    "public.direct_entry_grant_scope(uuid,uuid,uuid,text,uuid,date,integer,text,text)",
    "public.direct_entry_revoke_scope(uuid,uuid,uuid,uuid,date,integer,text,text)",
  ];
  for (const signature of rpcSignatures) {
    const acl = await query(db, `select
        to_regprocedure($1) is not null as exists,
        has_function_privilege('service_role',$1,'execute') as service_exec,
        has_function_privilege('authenticated',$1,'execute') as auth_exec,
        has_function_privilege('anon',$1,'execute') as anon_exec`, [signature]);
    assert.equal(acl[0].exists, true, signature);
    assert.equal(acl[0].service_exec, true, signature);
    assert.equal(acl[0].auth_exec, false, signature);
    assert.equal(acl[0].anon_exec, false, signature);
  }

  for (const signature of [
    "public.direct_entry_capability_snapshot(uuid,text,date,date,uuid)",
    "public.direct_entry_scope_snapshot(uuid,text,uuid,date,date,uuid)",
  ]) {
    const acl = await query(db, `select
        has_function_privilege('service_role',$1,'execute') as service_exec,
        has_function_privilege('authenticated',$1,'execute') as auth_exec,
        has_function_privilege('public',$1,'execute') as public_exec`, [signature]);
    assert.equal(acl[0].service_exec, false, signature);
    assert.equal(acl[0].auth_exec, false, signature);
    assert.equal(acl[0].public_exec, false, signature);
  }

  const definer = await query(db, `
    select p.proname, p.prosecdef, pg_catalog.array_to_string(p.proconfig, ',') as config
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in (
       'direct_entry_grant_capability','direct_entry_revoke_capability',
       'direct_entry_grant_scope','direct_entry_revoke_scope',
       'direct_entry_capability_snapshot','direct_entry_scope_snapshot')`);
  assert.equal(definer.length, 6);
  for (const row of definer) {
    assert.equal(row.prosecdef, true, row.proname);
    assert.equal(row.config, "search_path=pg_catalog, public", row.proname);
  }

  const childUpdatedAt = await query(db, `
    select count(*)::int as count from information_schema.columns
     where table_schema = 'public'
       and table_name in ('direct_entry_capability_grants','direct_entry_scope_grants')
       and column_name = 'updated_at'`);
  assert.equal(childUpdatedAt[0].count, 0);

  await db.close();
});

test("W03B Full Admin can grant, replay, and revoke a capability with an audited revision", async () => {
  const db = await database();
  await seed(db);
  const now = await today(db);

  const before = await capabilityRows(db, TARGET_APP);
  assert.equal(before.length, 0);

  const granted = await grantCapability(db, [
    ADMIN_AUTH, ADMIN_APP, TARGET_APP, "entry_privileged_edit", "2026-02-01", 1, REASON, "w03b-cap-1"]);
  assert.equal(granted.change, "capability_grant");
  assert.equal(granted.app_user_id, TARGET_APP);
  assert.equal(granted.version, 2);
  assert.equal((await appUser(db, TARGET_APP)).version, 2);

  const rows = await capabilityRows(db, TARGET_APP);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].capability, "entry_privileged_edit");
  assert.equal(rows[0].valid_from, "2026-02-01");
  assert.equal(rows[0].valid_to, null);
  assert.equal(granted.grant_id, rows[0].grant_id);

  const revision = await query(db, `
    select action, version, before_snapshot, after_snapshot, reason_id
      from public.direct_entry_app_user_revisions where revision_id = $1`, [granted.revision_id]);
  assert.equal(revision[0].action, "capability_grant");
  assert.equal(revision[0].version, 2);
  assert.equal(revision[0].before_snapshot, null);
  assert.deepEqual(Object.keys(revision[0].after_snapshot).sort(),
    ["actor_app_user_id", "changed", "interval", "target_app_user_id"]);
  assert.equal(revision[0].after_snapshot.changed.capability, "entry_privileged_edit");
  assert.equal(revision[0].after_snapshot.changed.valid_from, "2026-02-01");
  assert.equal(revision[0].after_snapshot.actor_app_user_id, ADMIN_APP);
  assert.equal(revision[0].after_snapshot.target_app_user_id, TARGET_APP);

  const audit = await query(db, `
    select action, capability, outcome, app_user_id, resource_ref, scope_kind,
           revision_id, app_user_revision_id, changed_fields
      from public.direct_entry_audit_events where app_user_revision_id = $1`, [granted.revision_id]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "capability_grant");
  assert.equal(audit[0].capability, "entry_admin");
  assert.equal(audit[0].outcome, "APPLIED");
  assert.equal(audit[0].app_user_id, ADMIN_APP);
  assert.equal(audit[0].resource_ref, TARGET_APP);
  assert.equal(audit[0].scope_kind, "all");
  assert.equal(audit[0].revision_id, null);
  assert.deepEqual(audit[0].changed_fields, ["capability", "valid_from"]);

  // Authorized replay is byte-identical and creates no second revision.
  const replay = await grantCapability(db, [
    ADMIN_AUTH, ADMIN_APP, TARGET_APP, "entry_privileged_edit", "2026-02-01", 1, REASON, "w03b-cap-1"]);
  assert.deepEqual(replay, granted);
  assert.equal((await appUser(db, TARGET_APP)).version, 2);
  assert.equal((await capabilityRows(db, TARGET_APP)).length, 1);

  // Same key, different reason is a reuse conflict.
  await assertSqlState(
    grantCapability(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "entry_privileged_edit", "2026-02-01", 1, "other", "w03b-cap-1"]),
    "22023");

  // Stale OCC version is refused and changes nothing.
  await assertSqlState(
    revokeCapability(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, granted.grant_id, "2026-06-01", 1, REASON, "w03b-cap-stale"]),
    "40001");
  assert.equal((await appUser(db, TARGET_APP)).version, 2);

  const revoked = await revokeCapability(db, [
    ADMIN_AUTH, ADMIN_APP, TARGET_APP, granted.grant_id, "2026-06-01", 2, REASON, "w03b-cap-rev"]);
  assert.equal(revoked.change, "capability_revoke");
  assert.equal(revoked.version, 3);
  assert.equal(revoked.grant_id, granted.grant_id);
  const closed = await capabilityRows(db, TARGET_APP);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].valid_to, "2026-06-01");
  assert.equal((await query(db,
    "select count(*)::int as count from public.direct_entry_app_user_revisions where app_user_id = $1",
    [TARGET_APP]))[0].count, 2);

  const revRevision = await query(db, `
    select action, before_snapshot, after_snapshot
      from public.direct_entry_app_user_revisions where revision_id = $1`, [revoked.revision_id]);
  assert.equal(revRevision[0].action, "capability_revoke");
  assert.equal(revRevision[0].before_snapshot.interval.valid_to, null);
  assert.equal(revRevision[0].after_snapshot.interval.valid_to, "2026-06-01");

  // The revoke never touched the leader bundle or the recruiter link.
  assert.equal((await query(db,
    "select count(*)::int as count from public.direct_entry_team_leader_assignments"))[0].count, 0);
  assert.equal((await query(db,
    "select count(*)::int as count from public.direct_entry_app_user_recruiter_links where app_user_id = $1",
    [TARGET_APP]))[0].count, 1);
  assert.ok(now);
  await db.close();
});

test("W03B revoke is a three-branch cancellation: marker, backdate, and re-close", async () => {
  const db = await database();
  await seed(db);

  // Branch 1: same-day cancellation writes an audited zero-length inert marker.
  const granted = await grantCapability(db, [
    ADMIN_AUTH, ADMIN_APP, TARGET_APP, "document_view", "2026-03-01", 1, REASON, "w03b-marker-grant"]);
  const marker = await revokeCapability(db, [
    ADMIN_AUTH, ADMIN_APP, TARGET_APP, granted.grant_id, "2026-03-01", 2, REASON, "w03b-marker-revoke"]);
  assert.equal(marker.change, "capability_revoke");
  const markerRow = await capabilityRows(db, TARGET_APP);
  assert.equal(markerRow[0].valid_from, "2026-03-01");
  assert.equal(markerRow[0].valid_to, "2026-03-01");

  // A closed / marker row cannot be revoked again.
  await assertSqlState(
    revokeCapability(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, granted.grant_id, "2026-03-01", 3, REASON, "w03b-marker-again"]),
    "23514");

  // Branch 2: an effective_date before valid_from is refused with zero residue.
  const second = await grantCapability(db, [
    ADMIN_AUTH, ADMIN_APP, TARGET_APP, "payment_view", "2026-04-01", 3, REASON, "w03b-backdate-grant"]);
  const revisionsBefore = (await query(db,
    "select count(*)::int as count from public.direct_entry_app_user_revisions where app_user_id = $1",
    [TARGET_APP]))[0].count;
  await assertSqlState(
    revokeCapability(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, second.grant_id, "2026-03-15", 4, REASON, "w03b-backdate"]),
    "22023");
  assert.equal((await appUser(db, TARGET_APP)).version, 4);
  assert.equal((await query(db,
    "select count(*)::int as count from public.direct_entry_app_user_revisions where app_user_id = $1",
    [TARGET_APP]))[0].count, revisionsBefore);
  assert.equal((await capabilityRows(db, TARGET_APP)).find((r) => r.grant_id === second.grant_id).valid_to, null);

  // A raw zero-length marker written outside the audited path is rejected by the W01D guard.
  await assertSqlState(
    db.query(`insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to)
              values ($1,'audit_view','2026-05-01','2026-05-01')`, [TARGET_APP]),
    "23514");
  await db.close();
});

test("W03B Full Admin can grant and revoke own / team / all scopes", async () => {
  const db = await database();
  await seed(db);

  const own = await grantScope(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "own", null, "2026-02-01", 1, REASON, "w03b-scope-own"]);
  assert.equal(own.change, "scope_grant");
  assert.equal(own.version, 2);
  const team = await grantScope(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "team", TEAM_ID, "2026-02-02", 2, REASON, "w03b-scope-team"]);
  assert.equal(team.version, 3);
  const all = await grantScope(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "all", null, "2026-02-03", 3, REASON, "w03b-scope-all"]);
  assert.equal(all.version, 4);

  const rows = await scopeRows(db, TARGET_APP);
  assert.deepEqual(rows.map((r) => r.scope_kind).sort(), ["all", "own", "team"]);

  const teamRevision = await query(db, `
    select after_snapshot from public.direct_entry_app_user_revisions where revision_id = $1`, [team.revision_id]);
  assert.equal(teamRevision[0].after_snapshot.changed.scope_kind, "team");
  assert.equal(teamRevision[0].after_snapshot.changed.team_id, TEAM_ID);

  const teamAudit = await query(db, `
    select action, capability, scope_kind, changed_fields from public.direct_entry_audit_events
     where app_user_revision_id = $1`, [team.revision_id]);
  assert.equal(teamAudit[0].action, "scope_grant");
  assert.equal(teamAudit[0].capability, "entry_admin");
  assert.equal(teamAudit[0].scope_kind, "all");
  assert.deepEqual(teamAudit[0].changed_fields, ["scope_kind", "team_id", "valid_from"]);

  // Revoke the team scope by immutable id (target has no leader bundle).
  const revoked = await revokeScope(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, team.grant_id, "2026-07-01", 4, REASON, "w03b-scope-team-rev"]);
  assert.equal(revoked.change, "scope_revoke");
  assert.equal(revoked.version, 5);
  const after = await scopeRows(db, TARGET_APP);
  assert.equal(after.find((r) => r.grant_id === team.grant_id).valid_to, "2026-07-01");

  // Re-granting an identical open (scope_kind, team_id, valid_from) overlaps the live row
  // and the foundation overlap trigger refuses it.
  await assertSqlState(
    grantScope(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "own", null, "2026-02-01", 5, REASON, "w03b-scope-dup"]),
    "23P01");
  await db.close();
});

test("W03B scope grant refuses the reserved vendor team and the leader bundle", async () => {
  const db = await database();
  await seed(db);
  const vendor = await vendorTeamId(db);

  await assertSqlState(
    grantScope(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "team", vendor, "2026-02-01", 1, REASON, "w03b-vendor"]),
    "23514");
  assert.equal((await appUser(db, TARGET_APP)).version, 1);

  // LEADER_TARGET already holds a current team_manager_assign bundle.
  await assertSqlState(
    grantScope(db, [ADMIN_AUTH, ADMIN_APP, LEADER_TARGET_APP, "team", TEAM_ID, "2026-02-01", 1, REASON, "w03b-leader-grant"]),
    "42501");

  const leaderTeamRow = (await scopeRows(db, LEADER_TARGET_APP)).find((r) => r.scope_kind === "team");
  await assertSqlState(
    revokeScope(db, [ADMIN_AUTH, ADMIN_APP, LEADER_TARGET_APP, leaderTeamRow.grant_id, "2026-07-01", 1, REASON, "w03b-leader-revoke"]),
    "42501");

  // No residue on either target.
  assert.equal((await appUser(db, TARGET_APP)).version, 1);
  assert.equal((await appUser(db, LEADER_TARGET_APP)).version, 1);
  assert.equal((await query(db,
    "select count(*)::int as count from public.direct_entry_app_user_revisions"))[0].count, 0);
  await db.close();
});

test("W03B capability grant refuses team_manager_assign and a disabled target; revoke ignores enabled", async () => {
  const db = await database();
  await seed(db);

  await assertSqlState(
    grantCapability(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "team_manager_assign", "2026-02-01", 1, REASON, "w03b-tma"]),
    "42501");
  assert.equal((await appUser(db, TARGET_APP)).version, 1);

  await assertSqlState(
    grantCapability(db, [ADMIN_AUTH, ADMIN_APP, DISABLED_TARGET_APP, "document_view", "2026-02-01", 1, REASON, "w03b-disabled-grant"]),
    "42501");
  await assertSqlState(
    grantScope(db, [ADMIN_AUTH, ADMIN_APP, DISABLED_TARGET_APP, "own", null, "2026-02-01", 1, REASON, "w03b-disabled-scope"]),
    "42501");

  // Revoke does NOT require the target to be enabled (close-only path). Seed a row on the
  // disabled target, then disable-close it.
  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)
     values ($1,'payment_view','2026-02-01')`, [DISABLED_TARGET_APP]);
  const seeded = (await capabilityRows(db, DISABLED_TARGET_APP))[0];
  const disabledVersion = (await appUser(db, DISABLED_TARGET_APP)).version;
  const revoked = await revokeCapability(db, [
    ADMIN_AUTH, ADMIN_APP, DISABLED_TARGET_APP, seeded.grant_id, "2026-06-01", disabledVersion, REASON, "w03b-disabled-revoke"]);
  assert.equal(revoked.change, "capability_revoke");
  assert.equal((await capabilityRows(db, DISABLED_TARGET_APP))[0].valid_to, "2026-06-01");
  await db.close();
});

test("W03B denies non-Full-Admin and forged actors without residue", async () => {
  const db = await database();
  await seed(db);

  const denied = [
    [DISABLED_ADMIN_AUTH, DISABLED_ADMIN_APP],
    [ACCOUNTING_AUTH, ACCOUNTING_APP],
    [LEADER_AUTH, LEADER_APP],
    [STAFF_AUTH, STAFF_APP],
    [TARGET_AUTH, TARGET_APP],
    [ADMIN_AUTH, STAFF_APP],
    ["10000000-0000-4000-8000-000000000099", ADMIN_APP],
  ];
  for (const [auth, actor] of denied) {
    await assertSqlState(
      grantCapability(db, [auth, actor, TARGET_APP, "document_view", "2026-02-01", 1, REASON, `deny-cap-${actor}`]),
      "42501");
    await assertSqlState(
      grantScope(db, [auth, actor, TARGET_APP, "own", null, "2026-02-01", 1, REASON, `deny-scope-${actor}`]),
      "42501");
  }

  assert.equal((await appUser(db, TARGET_APP)).version, 1);
  assert.equal((await capabilityRows(db, TARGET_APP)).length, 0);
  assert.equal((await scopeRows(db, TARGET_APP)).length, 0);
  assert.equal((await query(db,
    "select count(*)::int as count from public.direct_entry_app_user_revisions"))[0].count, 0);
  assert.equal((await query(db,
    "select count(*)::int as count from public.direct_entry_audit_events where action in ('capability_grant','scope_grant','capability_revoke','scope_revoke')"))[0].count, 0);
  await db.close();
});

test("W03B rechecks authority before the OCC version compare", async () => {
  const db = await database();
  await seed(db);
  // A non-admin actor with a stale expected version must fail on authority (42501),
  // never on the version conflict (40001): authority precedes OCC.
  await assertSqlState(
    grantCapability(db, [STAFF_AUTH, STAFF_APP, TARGET_APP, "document_view", "2026-02-01", 999, REASON, "w03b-order"]),
    "42501");
  await assertSqlState(
    grantCapability(db, [ADMIN_AUTH, STAFF_APP, TARGET_APP, "document_view", "2026-02-01", 999, REASON, "w03b-order-forge"]),
    "42501");
  assert.equal((await appUser(db, TARGET_APP)).version, 1);
  await db.close();
});

test("W03B rejects malformed input and unavailable targets", async () => {
  const db = await database();
  await seed(db);

  // Missing reason / key / version.
  await assertSqlState(grantCapability(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "document_view", "2026-02-01", 1, null, "k"]), "22023");
  await assertSqlState(grantCapability(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "document_view", "2026-02-01", 1, REASON, null]), "22023");
  await assertSqlState(grantCapability(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "document_view", "2026-02-01", 0, REASON, "k"]), "22023");
  // team scope without a team id.
  await assertSqlState(grantScope(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "team", null, "2026-02-01", 1, REASON, "k"]), "22023");

  // Unknown target.
  await assertSqlState(grantCapability(db, [ADMIN_AUTH, ADMIN_APP, MISSING_APP, "document_view", "2026-02-01", 1, REASON, "k"]), "P0002");
  // Unknown grant id on revoke.
  await assertSqlState(revokeCapability(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, MISSING_GRANT, "2026-06-01", 1, REASON, "k"]), "P0002");

  // A grant id owned by a different app user is target_unavailable.
  const granted = await grantCapability(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "document_view", "2026-02-01", 1, REASON, "w03b-owner"]);
  await assertSqlState(
    revokeCapability(db, [ADMIN_AUTH, ADMIN_APP, DISABLED_TARGET_APP, granted.grant_id, "2026-06-01", 1, REASON, "w03b-owner-mismatch"]),
    "P0002");

  // Unknown capability / scope_kind enum propagate as a CHECK violation (23514). The target
  // is at version 2 after the successful owner grant above.
  await assertSqlState(grantCapability(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "not_a_capability", "2026-02-01", 2, REASON, "w03b-bad-cap"]), "23514");
  await assertSqlState(grantScope(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "galaxy", null, "2026-02-01", 2, REASON, "w03b-bad-scope"]), "23514");
  await db.close();
});

test("W03B revisions and linked audit events are immutable", async () => {
  const db = await database();
  await seed(db);
  const granted = await grantCapability(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "document_view", "2026-02-01", 1, REASON, "w03b-immutable"]);
  await assertSqlState(
    db.query("update public.direct_entry_app_user_revisions set action = 'scope_grant' where revision_id = $1", [granted.revision_id]),
    "55000");
  await assertSqlState(
    db.query("delete from public.direct_entry_app_user_revisions where revision_id = $1", [granted.revision_id]),
    "55000");
  await assertSqlState(
    db.query("update public.direct_entry_audit_events set action = 'scope_grant' where app_user_revision_id = $1", [granted.revision_id]),
    "55000");
  await db.close();
});
