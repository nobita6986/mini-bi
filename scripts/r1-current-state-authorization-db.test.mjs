/**
 * R1-T1-B current-state authorization regressions. Uses the full local migration
 * chain in PGlite only; fixture rows contain synthetic identities and dates.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDb } from "./lib/p3-w05b-team-fixture.mjs";

const uuid = (n) => "10000000-0000-4000-8000-" + String(n).padStart(12, "0");
const AUTH = uuid(1), APP = uuid(2);
const FUTURE_AUTH = uuid(3), FUTURE_APP = uuid(4);
const TEAM_A = uuid(11), TEAM_B = uuid(12);
const REC_A = uuid(21), REC_B = uuid(22);
const PROJECT = "r1-synthetic-project";

async function addActor(db, auth, app, name) {
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
     values ($1, $2, true, $3)`, [app, auth, name],
  );
}

async function addCurrentCapability(db, app, capability) {
  await db.query(
    `insert into public.direct_entry_capability_grants
       (app_user_id, capability, valid_from, valid_to, is_current)
     values ($1, $2, '2020-01-01', '2021-01-01', true)`, [app, capability],
  );
}

async function seedActorsAndResources(db) {
  await addActor(db, AUTH, APP, "Synthetic Admin");
  await addActor(db, FUTURE_AUTH, FUTURE_APP, "Synthetic Future Actor");
  for (const capability of [
    "entry_admin", "recruiter_master_manage", "team_master_manage",
    "pii_view", "pii_export", "payment_view", "payment_edit",
  ]) await addCurrentCapability(db, APP, capability);
  await db.query(
    `insert into public.teams (team_id, code, display_name, active) values
      ($1, 'R1_TEAM_A', 'Synthetic Team A', true),
      ($2, 'R1_TEAM_B', 'Synthetic Team B', true)`, [TEAM_A, TEAM_B],
  );
  await db.query(
    `insert into public.recruiters (recruiter_id, display_name, active) values
      ($1, 'Synthetic Recruiter A', true), ($2, 'Synthetic Recruiter B', true)`, [REC_A, REC_B],
  );
  await db.query(
    `insert into public.direct_entry_scope_grants
       (app_user_id, scope_kind, team_id, valid_from, valid_to, is_current) values
      ($1, 'all', null, '2020-01-01', '2021-01-01', true),
      ($1, 'team', $2, '2020-01-01', '2021-01-01', true),
      ($1, 'team', $3, '2020-01-01', null, false)`, [APP, TEAM_A, TEAM_B],
  );
  await db.query(
    `insert into public.direct_entry_app_user_recruiter_links
       (app_user_id, recruiter_id, verified, valid_from, valid_to, is_current) values
      ($1, $2, true, '2020-01-01', '2021-01-01', true),
      ($1, $3, true, '2010-01-01', '2011-01-01', false)`, [APP, REC_A, REC_B],
  );
  await db.query(
    `insert into public.direct_entry_projects (project_id, display_name, active)
     values ($1, 'Synthetic Project', true)`, [PROJECT],
  );
}

test("actor context and capability/scope helpers use only explicit current rows", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);

    const context = (await db.query(
      "select public.direct_entry_resolve_actor_context($1) as context", [AUTH],
    )).rows[0].context;
    assert.deepEqual(Object.keys(context).sort(), [
      "all_scope_grants", "app_user_id", "auth_subject", "capabilities", "display_name",
      "enabled", "recruiter_links", "team_scope_grants", "teams",
    ]);
    assert.ok(context.capabilities.includes("entry_admin"));
    for (const retired of ["pii_view", "pii_export", "payment_view", "payment_edit"]) {
      assert.equal(context.capabilities.includes(retired), false, retired);
      assert.equal((await db.query(
        "select public.direct_entry_has_capability($1, $2) as allowed", [APP, retired],
      )).rows[0].allowed, false, retired + " is not an effective capability");
    }
    assert.equal(context.recruiter_links.length, 1);
    assert.equal(context.recruiter_links[0].recruiter_id, REC_A);
    assert.equal(context.recruiter_links[0].valid_to, "2021-01-01",
      "date fields stay available as inert history metadata");
    assert.equal(context.team_scope_grants.length, 1);
    assert.equal(context.team_scope_grants[0].team_id, TEAM_A);
    assert.equal(context.all_scope_grants.length, 1);
    assert.deepEqual(context.teams.map((team) => team.team_id), [TEAM_A]);

    assert.equal((await db.query(
      "select public.direct_entry_has_capability($1, 'entry_admin') as allowed", [APP],
    )).rows[0].allowed, true, "a current marker stays authoritative after its legacy date interval");
    assert.equal((await db.query(
      "select public.direct_entry_has_scope($1, 'all') as allowed", [APP],
    )).rows[0].allowed, true);
    assert.equal((await db.query(
      "select public.direct_entry_has_scope($1, 'team') as allowed", [APP],
    )).rows[0].allowed, true);

    // A scheduled row starts false, and changing only its dates never promotes it.
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from)
       values ($1, 'all', '2099-01-01')`, [FUTURE_APP],
    );
    assert.equal((await db.query(
      "select is_current from public.direct_entry_scope_grants where app_user_id=$1", [FUTURE_APP],
    )).rows[0].is_current, false);
    assert.equal((await db.query(
      "select public.direct_entry_has_scope($1, 'all') as allowed", [FUTURE_APP],
    )).rows[0].allowed, false);
    await db.query(
      `update public.direct_entry_scope_grants set valid_from='2020-01-01'
       where app_user_id=$1`, [FUTURE_APP],
    );
    assert.equal((await db.query(
      "select public.direct_entry_has_scope($1, 'all') as allowed", [FUTURE_APP],
    )).rows[0].allowed, false, "date-only changes do not activate scheduled authority");
    const futureContext = (await db.query(
      "select public.direct_entry_resolve_actor_context($1) as context", [FUTURE_AUTH],
    )).rows[0].context;
    assert.deepEqual(futureContext.all_scope_grants, []);
  } finally {
    await db.close();
  }
});

test("project-team grant/revoke is transactional current state, not an interval comparison", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);
    const futureDate = "2999-01-01";
    await assert.rejects(
      db.query(
        `select public.direct_entry_grant_project_team_scope(
          $1::uuid,$2::uuid,$3::text,$4::uuid,0,$5::date,'future grant probe','r1-future-scope')`,
        [AUTH, APP, PROJECT, TEAM_A, futureDate],
      ),
      (error) => error.code === "22023",
      "the audited grant RPC cannot create future active authority",
    );

    const result = (await db.query(
      `select public.direct_entry_grant_project_team_scope(
        $1::uuid,$2::uuid,$3::text,$4::uuid,0,null,'synthetic current grant','r1-current-scope') as result`,
      [AUTH, APP, PROJECT, TEAM_A],
    )).rows[0].result;
    const mappingId = result.mapping_id;
    assert.ok(mappingId);
    assert.equal((await db.query(
      `select is_current from public.direct_entry_project_team_scopes where mapping_id=$1`, [mappingId],
    )).rows[0].is_current, true);
    assert.equal((await db.query(
      "select public.direct_entry_project_team_scope_effective($1,$2) as allowed", [PROJECT, TEAM_A],
    )).rows[0].allowed, true);

    await db.query(
      `select public.direct_entry_revoke_project_team_scope(
        $1::uuid,$2::uuid,$3::uuid,null,'synthetic revoke','r1-revoke-scope')`,
      [AUTH, APP, mappingId],
    );
    assert.equal((await db.query(
      `select is_current from public.direct_entry_project_team_scopes where mapping_id=$1`, [mappingId],
    )).rows[0].is_current, false);
    assert.equal((await db.query(
      "select public.direct_entry_project_team_scope_effective($1,$2) as allowed", [PROJECT, TEAM_A],
    )).rows[0].allowed, false, "revoke denies the next request");
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_audit_events
        where resource_ref=$1 and action in ('project_team_scope_grant','project_team_scope_revoke')
          and outcome='APPLIED'`, [mappingId],
    )).rows[0].n, 2);
  } finally {
    await db.close();
  }
});

test("actor binding and S0 service-role ACLs remain enforced", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);
    await assert.rejects(
      db.query("select public.direct_entry_assert_actor($1,$2,'entry_admin')", [FUTURE_AUTH, APP]),
      (error) => error.code === "42501",
      "a client-supplied actor UUID cannot substitute for the mapped auth subject",
    );

    const { rows } = await db.query(
      `select
         has_function_privilege('service_role', 'public.direct_entry_resolve_actor_context(uuid)', 'EXECUTE') as resolver_service,
         has_function_privilege('anon', 'public.direct_entry_resolve_actor_context(uuid)', 'EXECUTE') as resolver_anon,
         has_function_privilege('authenticated', 'public.direct_entry_resolve_actor_context(uuid)', 'EXECUTE') as resolver_authenticated,
         has_function_privilege('anon', 'public.direct_entry_has_capability(uuid,text)', 'EXECUTE') as helper_anon,
         has_function_privilege('authenticated', 'public.direct_entry_has_capability(uuid,text)', 'EXECUTE') as helper_authenticated,
         has_function_privilege('service_role', 'public.direct_entry_has_capability(uuid,text)', 'EXECUTE') as helper_service,
         has_function_privilege('service_role', 'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)', 'EXECUTE') as export_service,
         has_function_privilege('anon', 'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)', 'EXECUTE') as export_anon`,
    );
    assert.deepEqual(rows[0], {
      resolver_service: true,
      resolver_anon: false,
      resolver_authenticated: false,
      helper_anon: false,
      helper_authenticated: false,
      helper_service: false,
      export_service: true,
      export_anon: false,
    });
  } finally {
    await db.close();
  }
});
