import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { resolveActor } from "../src/lib/auth/direct-entry-v2.ts";

const foundationPath = new URL("../supabase/migrations/20261002170000_p1_6_direct_entry_foundation.sql", import.meta.url);
const correctionPath = new URL("../supabase/migrations/20261003170000_p1_6_w03_submission_noop_guard.sql", import.meta.url);
const migrationPath = new URL("../supabase/migrations/20261003180000_p1_6_w04_s03a_actor_context.sql", import.meta.url);

const authSubject = "91000000-0000-4000-8000-000000000001";
const appUserId = "92000000-0000-4000-8000-000000000001";
const recruiterId = "93000000-0000-4000-8000-000000000001";
const teamId = "94000000-0000-4000-8000-000000000001";

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
  `);
  await db.exec(await readFile(foundationPath, "utf8"));
  await db.exec(await readFile(correctionPath, "utf8"));
  await db.exec(await readFile(migrationPath, "utf8"));
  return db;
}

async function seedActor(db, { enabled = true } = {}) {
  await db.exec(`
    insert into auth.users (id) values ('${authSubject}');
    insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled)
      values ('${appUserId}', '${authSubject}', ${enabled});
    insert into public.teams (team_id, code, display_name)
      values ('${teamId}', 'S03A-SYNTH', 'Synthetic Team');
    insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, team_id, valid_from)
      values ('${appUserId}', 'team', '${teamId}', date '2020-01-01');
    insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from)
      values ('${appUserId}', 'all', date '2020-01-01');
    insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from)
      values ('${appUserId}', 'entry_create', date '2020-01-01');
    insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from, valid_to)
      values ('${appUserId}', 'payment_view', date '2020-01-01', date '2020-01-02');
    insert into public.recruiters (recruiter_id, display_name)
      values ('${recruiterId}', 'Synthetic Recruiter');
    insert into public.direct_entry_app_user_recruiter_links
      (app_user_id, recruiter_id, verified, valid_from)
      values ('${appUserId}', '${recruiterId}', true, date '2020-01-01');
  `);
}

test("actor context RPC returns only resolver inputs and resolves stable identity", async () => {
  const db = await createDatabase();
  try {
    await seedActor(db);
    const { rows } = await db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as context",
      [authSubject],
    );
    const context = rows[0].context;
    assert.deepEqual(Object.keys(context).sort(), [
      "all_scope_grants", "app_user_id", "auth_subject", "capabilities",
      "enabled", "recruiter_links", "team_scope_grants", "teams",
    ]);
    assert.equal(context.app_user_id, appUserId);
    assert.deepEqual(context.capabilities, ["entry_create"]);
    assert.deepEqual(context.team_scope_grants, [{
      team_id: teamId,
      valid_from: "2020-01-01",
      valid_to: null,
    }]);
    assert.deepEqual(context.teams, [{
      team_id: teamId,
      code: "S03A-SYNTH",
      display: "Synthetic Team",
      active: true,
    }]);
    assert.deepEqual(context.all_scope_grants, [{
      valid_from: "2020-01-01",
      valid_to: null,
    }]);
    assert.equal(context.recruiter_links[0].recruiter_id, recruiterId);

    const result = await resolveActor({
      session: {
        auth_subject: authSubject,
        provider: "supabase",
        authenticated_at: null,
      },
      repository: { loadByAuthSubject: async () => context },
      at: new Date().toISOString(),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.actor.app_user_id, appUserId);
    assert.deepEqual(result.actor.capabilities, ["entry_create"]);
    assert.deepEqual(
      result.actor.scopes.map(({ kind, reference }) => [kind, reference]),
      [["own", appUserId], ["team", teamId], ["all", "all"]],
    );
    assert.equal(result.actor.self_recruiter_suggestion, recruiterId);
  } finally {
    await db.close();
  }
});

test("unknown actors return the same null projection and disabled actors stay disabled", async () => {
  const db = await createDatabase();
  try {
    const missing = await db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as context",
      [authSubject],
    );
    assert.equal(missing.rows[0].context, null);
    await seedActor(db, { enabled: false });
    const disabled = await db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as context",
      [authSubject],
    );
    assert.equal(disabled.rows[0].context.enabled, false);
  } finally {
    await db.close();
  }
});

test("actor context RPC ACL is service-role-only and grants no table DML", async () => {
  const db = await createDatabase();
  try {
    const migration = await readFile(migrationPath, "utf8");
    assert.doesNotMatch(migration, /\bgrant\s+(?:select|insert|update|delete|all)\b[\s\S]*?\bon\s+table\b/i);
    const acl = await db.query(`
      select
        has_function_privilege('service_role',
          'public.direct_entry_resolve_actor_context(uuid)', 'execute') as service_execute,
        has_function_privilege('anon',
          'public.direct_entry_resolve_actor_context(uuid)', 'execute') as anon_execute,
        has_function_privilege('authenticated',
          'public.direct_entry_resolve_actor_context(uuid)', 'execute') as authenticated_execute,
        has_table_privilege('service_role', 'public.direct_entry_app_users', 'select') as service_select,
        has_table_privilege('service_role', 'public.direct_entry_app_users', 'insert') as service_insert,
        has_table_privilege('authenticated', 'public.direct_entry_app_users', 'select') as authenticated_select
    `);
    const functionProperties = await db.query(`
      select p.prosecdef, p.proconfig
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname = 'direct_entry_resolve_actor_context'
    `);
    assert.deepEqual(acl.rows[0], {
      service_execute: true,
      anon_execute: false,
      authenticated_execute: false,
      service_select: false,
      service_insert: false,
      authenticated_select: false,
    });
    assert.equal(functionProperties.rows[0].prosecdef, true);
    assert.deepEqual(functionProperties.rows[0].proconfig, ["search_path=pg_catalog"]);

    await db.exec("set role service_role");
    await assert.rejects(db.query(
      "select * from public.direct_entry_app_users",
    ), /permission denied for table direct_entry_app_users/i);
    await assert.rejects(db.query(`
      insert into public.direct_entry_app_users (auth_subject)
      values ('${authSubject}')
    `), /permission denied for table direct_entry_app_users/i);
    await db.exec("reset role");
    await db.exec("set role anon");
    await assert.rejects(db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid)",
      [authSubject],
    ), /permission denied for function direct_entry_resolve_actor_context/i);
  } finally {
    await db.close();
  }
});
