/**
 * R1-T1-B current-state authorization regressions. Uses the full local migration
 * chain in PGlite only; fixture rows contain synthetic identities and dates.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildDb } from "./lib/p3-w05b-team-fixture.mjs";

const uuid = (n) => "10000000-0000-4000-8000-" + String(n).padStart(12, "0");
const AUTH = uuid(1), APP = uuid(2);
const FUTURE_AUTH = uuid(3), FUTURE_APP = uuid(4);
const TEAM_A = uuid(11), TEAM_B = uuid(12);
const REC_A = uuid(21), REC_B = uuid(22), REC_C = uuid(23);
const PROJECT = "r1-synthetic-project";
const PROJECT_PM = "r1-synthetic-pm-project";
const PRE_R1_BASELINE = "20261019130000_pre_w2_hf_draft_submission_delete.sql";
const R1_MIGRATION = "20261020200000_r1_current_state_authorization.sql";

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

async function seedProjectManager(db) {
  await seedActorsAndResources(db);
  await db.query(
    `insert into public.recruiter_provider_memberships
       (recruiter_id, provider_type, valid_from, is_current)
     values ($1, 'hrp', '2020-01-01', true)`, [REC_A],
  );
  await db.query(
    `insert into public.recruiter_team_memberships
       (recruiter_id, team_id, valid_from, is_current)
     values ($1, $2, '2020-01-01', true)`, [REC_A, TEAM_A],
  );
  const managerAuth = uuid(5), managerApp = uuid(6);
  await addActor(db, managerAuth, managerApp, "Synthetic Project Manager");
  await db.query(
    `insert into public.direct_entry_app_user_recruiter_links
       (app_user_id, recruiter_id, verified, valid_from, is_current)
     values ($1, $2, true, '2020-01-01', true)`, [managerApp, REC_B],
  );
  await db.query(
    `select public.direct_entry_create_project(
      $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text)`,
    [AUTH, APP, PROJECT_PM, "Synthetic PM Project", "create for PM history test", "r1-pm-create"],
  );
  const assignment = (await db.query(
    `select public.direct_entry_assign_project_manager(
      $1::uuid, $2::uuid, $3::text, $4::uuid, null, 1, $5::text, $6::text) as result`,
    [AUTH, APP, PROJECT_PM, REC_B, "assign synthetic PM", "r1-pm-assign"],
  )).rows[0].result;
  return { assignment, managerAuth, managerApp };
}

async function seedStrictTeamLeader(db, {
  auth = uuid(70), app = uuid(71), recruiter = REC_B, team = TEAM_A,
} = {}) {
  await addActor(db, auth, app, "Synthetic Team Leader");
  await addCurrentCapability(db, app, "team_manager_assign");
  await db.query(
    `insert into public.direct_entry_scope_grants
       (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1, 'team', $2, '2020-01-01', true)`, [app, team],
  );
  await db.query(
    `insert into public.recruiter_provider_memberships
       (recruiter_id, provider_type, valid_from, is_current)
     values ($1, 'hrp', '2020-01-01', true)`, [recruiter],
  );
  await db.query(
    `insert into public.recruiter_team_memberships
       (recruiter_id, team_id, valid_from, is_current)
     values ($1, $2, '2020-01-01', true)`, [recruiter, team],
  );
  await db.query(
    `insert into public.direct_entry_app_user_recruiter_links
       (app_user_id, recruiter_id, verified, valid_from, is_current)
     values ($1, $2, true, '2020-01-01', true)`, [app, recruiter],
  );
  await db.query(
    `insert into public.direct_entry_team_leader_assignments
       (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
     values ($1, $2, $3, '2020-01-01', true)`, [team, app, recruiter],
  );
  return { auth, app, recruiter, team };
}

async function insertSyntheticProjectEntry(db, state = "DRAFT", options = {}) {
  const {
    entryId = uuid(7), candidateId = uuid(8), submissionId = uuid(9),
    ownerApp = APP, projectId = PROJECT_PM, employeeSuffix = "000901",
    recruiterId = REC_A, teamId = TEAM_A,
  } = options;
  const year = (await db.query(
    "select to_char(public.direct_entry_authorization_date(), 'YYYY') as year",
  )).rows[0].year;
  await db.query("begin");
  try {
    await db.query("insert into public.direct_entry_candidates(candidate_id) values ($1)", [candidateId]);
    await db.query(
      "insert into public.direct_entry_submissions(submission_id, created_by_user_id) values ($1, $2)",
      [submissionId, ownerApp],
    );
    await db.query(
      `insert into public.direct_entries (
         entry_id, submission_id, candidate_id, created_by_user_id, project_id,
         first_work_date, employee_code, worker_details, recruiter_id, team_id,
         provider_type, labor_type
       ) values (
         $1, $2, $3, $4, $5, public.direct_entry_authorization_date(), $6,
         $7::jsonb, $8, $9, 'hrp', 'TEMPORARY'
       )`,
      [entryId, submissionId, candidateId, ownerApp, projectId, `hrp-${year}-${employeeSuffix}`, JSON.stringify({
        display_name: "Synthetic PM Draft",
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      }), recruiterId, teamId],
    );
    if (state === "SUBMITTED") {
      await db.query(
        "update public.direct_entry_submissions set state='SUBMITTED', version=version+1 where submission_id=$1",
        [submissionId],
      );
    }
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
  return { entryId, year };
}

test("R1 current-state backfill handles an existing project-team mapping", async () => {
  const { db } = await buildDb({ throughMigration: PRE_R1_BASELINE });
  try {
    await addActor(db, AUTH, APP, "Synthetic Pre-R1 Admin");
    for (const capability of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)
         values ($1, $2, '2020-01-01')`, [APP, capability],
      );
    }
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from)
       values ($1, 'all', '2020-01-01')`, [APP],
    );
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1, 'R1_CUTOVER_TEAM', 'Synthetic Cutover Team', true)`, [TEAM_A],
    );
    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active)
       values ($1, 'Synthetic Cutover Project', true)`, [PROJECT],
    );
    const result = (await db.query(
      `select public.direct_entry_grant_project_team_scope(
        $1::uuid, $2::uuid, $3::text, $4::uuid, 0, '2020-01-01'::date, $5::text, $6::text) as result`,
      [AUTH, APP, PROJECT, TEAM_A, "Synthetic R1 cutover seed", "r1-cutover-seed"],
    )).rows[0].result;
    const migration = await readFile(path.resolve("supabase/migrations", R1_MIGRATION), "utf8");
    await db.exec(migration);
    assert.deepEqual((await db.query(
      `select is_current, version from public.direct_entry_project_team_scopes where mapping_id=$1`,
      [result.mapping_id],
    )).rows[0], { is_current: true, version: 1 },
    "backfill activates the existing mapping without changing its business pair version");
  } finally {
    await db.close();
  }
});

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
    assert.deepEqual((await db.query(
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
          $1::uuid,$2::uuid,$3::text,$4::uuid,0,$5::date,null,'r1-future-scope')`,
        [AUTH, APP, PROJECT, TEAM_A, futureDate],
      ),
      (error) => error.code === "22023",
      "the audited grant RPC cannot create future active authority",
    );

    const result = (await db.query(
        `select public.direct_entry_grant_project_team_scope(
          $1::uuid,$2::uuid,$3::text,$4::uuid,0,null,null,'r1-current-scope') as result`,
      [AUTH, APP, PROJECT, TEAM_A],
    )).rows[0].result;
    const mappingId = result.mapping_id;
    assert.ok(mappingId);
    assert.deepEqual((await db.query(
      `select is_current, reason_id from public.direct_entry_project_team_scopes where mapping_id=$1`, [mappingId],
    )).rows[0], { is_current: true, reason_id: null },
    "the grant remains current without a placeholder reason row");
    const pairVersion = (await db.query(
      `select version from public.direct_entry_project_team_scopes where mapping_id=$1`, [mappingId],
    )).rows[0].version;
    await db.query(
      `update public.direct_entry_project_team_scopes set is_current=false where mapping_id=$1`, [mappingId],
    );
    await db.query(
      `update public.direct_entry_project_team_scopes set is_current=true where mapping_id=$1`, [mappingId],
    );
    assert.equal((await db.query(
      `select version from public.direct_entry_project_team_scopes where mapping_id=$1`, [mappingId],
    )).rows[0].version, pairVersion, "current-state marker changes leave the project/team pair version untouched");
    assert.equal((await db.query(
      "select public.direct_entry_project_team_scope_effective($1,$2) as allowed", [PROJECT, TEAM_A],
    )).rows[0].allowed, true);

    await db.query(
      `select public.direct_entry_revoke_project_team_scope(
        $1::uuid,$2::uuid,$3::uuid,null,null,'r1-revoke-scope')`,
      [AUTH, APP, mappingId],
    );
    assert.deepEqual((await db.query(
      `select is_current, revoke_reason_id from public.direct_entry_project_team_scopes where mapping_id=$1`, [mappingId],
    )).rows[0], { is_current: false, revoke_reason_id: null },
    "revocation metadata stays complete while its action reason remains optional");
    assert.equal((await db.query(
      "select public.direct_entry_project_team_scope_effective($1,$2) as allowed", [PROJECT, TEAM_A],
    )).rows[0].allowed, false, "revoke denies the next request");
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_audit_events
        where resource_ref=$1 and action in ('project_team_scope_grant','project_team_scope_revoke')
          and outcome='APPLIED'`, [mappingId],
    )).rows[0].n, 2);
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_audit_events
        where resource_ref=$1 and action in ('project_team_scope_grant','project_team_scope_revoke')
          and outcome='APPLIED' and reason_id is not null`, [mappingId],
    )).rows[0].n, 0, "both auditable scope operations omit fake reason records");
  } finally {
    await db.close();
  }
});

test("project deactivation preserves PM draft and history authority until explicit unassign", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);
    await db.query(
      `insert into public.recruiter_provider_memberships
         (recruiter_id, provider_type, valid_from, is_current)
       values ($1, 'hrp', '2020-01-01', true)`, [REC_A],
    );
    await db.query(
      `insert into public.recruiter_team_memberships
         (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2020-01-01', true)`, [REC_A, TEAM_A],
    );
    const managerAuth = uuid(5), managerApp = uuid(6);
    await addActor(db, managerAuth, managerApp, "Synthetic Project Manager");
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1, $2, true, '2020-01-01', true)`, [managerApp, REC_B],
    );

    await db.query(
      `select public.direct_entry_create_project(
        $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text)`,
      [AUTH, APP, PROJECT_PM, "Synthetic PM Project", "create for PM history test", "r1-pm-create"],
    );
    const assignment = (await db.query(
      `select public.direct_entry_assign_project_manager(
        $1::uuid, $2::uuid, $3::text, $4::uuid, null, 1, $5::text, $6::text) as result`,
      [AUTH, APP, PROJECT_PM, REC_B, "assign synthetic PM", "r1-pm-assign"],
    )).rows[0].result;
    const entryId = uuid(7), candidateId = uuid(8), submissionId = uuid(9);
    const year = (await db.query(
      "select to_char(public.direct_entry_authorization_date(), 'YYYY') as year",
    )).rows[0].year;
    await db.query("begin");
    await db.query("insert into public.direct_entry_candidates(candidate_id) values ($1)", [candidateId]);
    await db.query(
      "insert into public.direct_entry_submissions(submission_id, created_by_user_id) values ($1, $2)",
      [submissionId, APP],
    );
    await db.query(
      `insert into public.direct_entries (
         entry_id, submission_id, candidate_id, created_by_user_id, project_id,
         first_work_date, employee_code, worker_details, recruiter_id, team_id,
         provider_type, labor_type
       ) values (
         $1, $2, $3, $4, $5, public.direct_entry_authorization_date(),
         'hrp-' || to_char(public.direct_entry_authorization_date(), 'YYYY') || '-000901',
         $6::jsonb, $7, $8, 'hrp', 'TEMPORARY'
       )`,
      [entryId, submissionId, candidateId, APP, PROJECT_PM, JSON.stringify({
        display_name: "Synthetic PM Draft",
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      }), REC_A, TEAM_A],
    );
    await db.query("commit");
    const draftUpdate = (await db.query(
      `select public.direct_entry_update_draft_row(
        $1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5::text) as result`,
      [managerAuth, managerApp, entryId,
        JSON.stringify({ employee_code: `hrp-${year}-000902` }), "r1-pm-draft-update"],
    )).rows[0].result;
    assert.equal(draftUpdate.version, 2,
      "a current project-manager assignment retains the existing scoped DRAFT edit authority");
    assert.deepEqual((await db.query(
      "select employee_code, version from public.direct_entries where entry_id = $1", [entryId],
    )).rows[0], { employee_code: `hrp-${year}-000902`, version: 2 });
    await addCurrentCapability(db, APP, "submission_create");
    await db.query(
      `insert into public.direct_entry_scope_grants
         (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1, 'own', null, '2020-01-01', true)`, [APP],
    );
    await db.query(
      `select public.direct_entry_transition_submission_apply(
        $1::uuid, $2::uuid, $3::uuid, 2, 'SUBMITTED', $4::text, null, null)`,
      [AUTH, APP, submissionId, "r1-pm-submit"],
    );

    await db.query(
      `select public.direct_entry_set_project_active(
        $1::uuid, $2::uuid, $3::text, false, 2, $4::text, $5::text)`,
      [AUTH, APP, PROJECT_PM, "deactivate synthetic project", "r1-pm-deactivate"],
    );
    await db.query(
      `update public.direct_entry_project_manager_assignments
          set version = version + 1 where assignment_id = $1`,
      [assignment.assignment_id],
    );
    assert.deepEqual((await db.query(
      `select is_current, valid_to::text as valid_to from public.direct_entry_project_manager_assignments
        where assignment_id = $1`, [assignment.assignment_id],
    )).rows[0], { is_current: true, valid_to: null });
    assert.equal((await db.query(
      `select public.direct_entry_actor_can_access_project($1, $2) as allowed`,
      [managerApp, PROJECT_PM],
    )).rows[0].allowed, true,
    "deactivation hides new-work choices but keeps the manager's history authority");
    const managedWorkers = (await db.query(
      `select public.direct_entry_list_workers(
         $1::uuid, $2::uuid, 'managed', $3::text, null, null, null, 25) as result`,
      [managerAuth, managerApp, PROJECT_PM],
    )).rows[0].result.items;
    assert.deepEqual(managedWorkers.map((worker) => worker.entry_id), [entryId],
      "managed history read retains the existing row after project deactivation");

    await db.query(
      `select public.direct_entry_unassign_project_manager(
        $1::uuid, $2::uuid, $3::uuid, 2, 3, $4::text, $5::text)`,
      [AUTH, APP, assignment.assignment_id, "unassign synthetic PM", "r1-pm-unassign"],
    );
    assert.deepEqual((await db.query(
      `select is_current, valid_to::text as valid_to from public.direct_entry_project_manager_assignments
        where assignment_id = $1`, [assignment.assignment_id],
    )).rows[0], { is_current: false, valid_to: await db.query(
      "select public.direct_entry_authorization_date()::text as today").then((r) => r.rows[0].today) });
    assert.equal((await db.query(
      `select public.direct_entry_actor_can_access_project($1, $2) as allowed`,
      [managerApp, PROJECT_PM],
    )).rows[0].allowed, false, "explicit unassign revokes the history authority");
    await assert.rejects(
      db.query(
        `select public.direct_entry_list_workers(
          $1::uuid, $2::uuid, 'managed', $3::text, null, null, null, 25)`,
        [managerAuth, managerApp, PROJECT_PM],
      ),
      (error) => error.code === "42501",
      "managed history read is denied after explicit unassign",
    );
  } finally {
    await db.close();
  }
});

test("PM assignment authority fails closed for ambiguous links and revoked rows", async () => {
  const { db } = await buildDb();
  try {
    const { assignment, managerApp } = await seedProjectManager(db);
    await db.query(
      `insert into public.direct_entry_project_manager_assignments (
         project_id, manager_recruiter_id, valid_from, valid_to, revoked_at, is_current
       ) values ($1, $2, '2020-01-01', '2020-01-02', now(), true)`,
      [PROJECT_PM, REC_B],
    );
    assert.equal((await db.query(
      `select is_current from public.direct_entry_project_manager_assignments
        where project_id=$1 and manager_recruiter_id=$2 and revoked_at is not null`,
      [PROJECT_PM, REC_B],
    )).rows[0].is_current, false,
    "a pre-revoked row cannot be marked current by the insert trigger");
    assert.equal((await db.query(
      "select public.direct_entry_project_assignment_effective($1, $2) as allowed",
      [managerApp, PROJECT_PM],
    )).rows[0].allowed, true, "the unique current link retains PM authority");

    const duplicateAuth = uuid(30), duplicateApp = uuid(31);
    await addActor(db, duplicateAuth, duplicateApp, "Synthetic Duplicate PM Link");
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, valid_to, is_current)
       values ($1, $2, true, '2015-01-01', '2019-01-01', true)`, [duplicateApp, REC_B],
    );
    assert.equal((await db.query(
      "select public.direct_entry_project_assignment_effective($1, $2) as allowed",
      [managerApp, PROJECT_PM],
    )).rows[0].allowed, false,
    "two current verified links make PM authority ambiguous for the original actor");
    assert.equal((await db.query(
      "select public.direct_entry_project_assignment_effective($1, $2) as allowed",
      [duplicateApp, PROJECT_PM],
    )).rows[0].allowed, false,
    "the second linked app user cannot inherit a PM assignment");
    await assert.rejects(
      db.query(
        `select public.direct_entry_list_workers(
          $1::uuid, $2::uuid, 'managed', $3::text, null, null, null, 25)`,
        [duplicateAuth, duplicateApp, PROJECT_PM],
      ),
      (error) => error.code === "42501",
      "managed directory reads reject ambiguous recruiter links",
    );
    const secondProject = `${PROJECT_PM}-duplicate-link`;
    await db.query(
      `select public.direct_entry_create_project(
        $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text)`,
      [AUTH, APP, secondProject, "Synthetic duplicate-link project", "duplicate-link rejection test", "r1-pm-create-second"],
    );
    await assert.rejects(
      db.query(
        `select public.direct_entry_assign_project_manager(
          $1::uuid, $2::uuid, $3::text, $4::uuid, null, 1, $5::text, $6::text)`,
        [AUTH, APP, secondProject, REC_B, "ambiguous PM link must be rejected", "r1-pm-assign-duplicate"],
      ),
      (error) => error.code === "22023",
      "the audited assignment mutation rejects an ambiguous manager link",
    );
    assert.equal((await db.query(
      `select is_current from public.direct_entry_project_manager_assignments where assignment_id=$1`,
      [assignment.assignment_id],
    )).rows[0].is_current, true,
    "the assignment remains current while the helper denies ambiguous link state");
  } finally {
    await db.close();
  }
});

test("own DRAFT wrapper preserves omitted payments and explicit updates, OCC, audit and guards", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);
    await db.query(
      `insert into public.recruiter_provider_memberships
         (recruiter_id, provider_type, valid_from, is_current)
       values ($1, 'hrp', '2020-01-01', true)`, [REC_A],
    );
    await db.query(
      `insert into public.recruiter_team_memberships
         (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2020-01-01', true)`, [REC_A, TEAM_A],
    );
    const ownerAuth = uuid(50), ownerApp = uuid(51);
    await addActor(db, ownerAuth, ownerApp, "Synthetic Own Draft Actor");
    await addCurrentCapability(db, ownerApp, "entry_own");
    await db.query(
      `insert into public.direct_entry_scope_grants
         (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1, 'own', null, '2020-01-01', true)`, [ownerApp],
    );
    const { entryId } = await insertSyntheticProjectEntry(db, "DRAFT", {
      entryId: uuid(52), candidateId: uuid(53), submissionId: uuid(54),
      ownerApp, projectId: PROJECT, employeeSuffix: "000952",
    });
    await db.query(
      `insert into public.direct_entry_banks (bank_id, display_name)
       values ('hf2-synthetic-bank', 'HF2 Synthetic Bank')`,
    );
    await db.query(
      `insert into public.direct_entry_payments (
         entry_id, state, account_number, bank_id, bank_name, account_holder_name, version
       ) values ($1, 'provided', '000098765432', 'hf2-synthetic-bank',
         'HF2 Synthetic Bank', 'HF2 Synthetic Holder', 4)`, [entryId],
    );
    await db.query(
      `select public.direct_entry_update_own_draft_row(
        $1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5::text)`,
      [ownerAuth, ownerApp, entryId, JSON.stringify({ general_note: "Synthetic unrelated edit" }),
        "r1-own-draft-unrelated-edit"],
    );
    assert.deepEqual((await db.query(
      `select general_note, version from public.direct_entries where entry_id=$1`, [entryId],
    )).rows[0], { general_note: "Synthetic unrelated edit", version: 2 });
    assert.deepEqual((await db.query(
      `select state, account_number, bank_id, bank_name, account_holder_name, version
         from public.direct_entry_payments where entry_id=$1`, [entryId],
    )).rows[0], {
      state: "provided", account_number: "000098765432", bank_id: "hf2-synthetic-bank",
      bank_name: "HF2 Synthetic Bank", account_holder_name: "HF2 Synthetic Holder", version: 4,
    }, "an unrelated draft edit leaves the complete saved payment row unchanged");
    const patch = {
      general_note: "Synthetic payment edit",
      payment: {
        state: "provided",
        account_number: "000012345678",
        bank_name: "Synthetic Bank",
        account_holder_name: "Synthetic Holder",
      },
    };
    await db.query(
      `select public.direct_entry_update_own_draft_row(
        $1::uuid, $2::uuid, $3::uuid, 2, $4::jsonb, $5::text)`,
      [ownerAuth, ownerApp, entryId, JSON.stringify(patch), "r1-own-draft-update"],
    );
    assert.deepEqual((await db.query(
      `select general_note, version from public.direct_entries where entry_id=$1`, [entryId],
    )).rows[0], { general_note: "Synthetic payment edit", version: 3 });
    assert.deepEqual((await db.query(
      `select state, account_number, bank_id, bank_name, account_holder_name, version
         from public.direct_entry_payments where entry_id=$1`, [entryId],
    )).rows[0], {
      state: "provided", account_number: "000012345678", bank_id: null,
      bank_name: "Synthetic Bank", account_holder_name: "Synthetic Holder", version: 5,
    }, "an explicit payment edit keeps leading zeros and increments payment OCC");
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_revisions where entry_id=$1`, [entryId],
    )).rows[0].n, 2, "each allowed draft edit records one row revision");
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_audit_events
        where resource_ref=$1 and action='draft_row_update' and outcome='APPLIED'`, [entryId],
    )).rows[0].n, 2, "one applied audit event records each edit");

    await assert.rejects(
      db.query(
        `select public.direct_entry_update_own_draft_row(
          $1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5::text)`,
        [ownerAuth, ownerApp, entryId, JSON.stringify({ general_note: "stale" }), "r1-own-draft-stale"],
      ),
      (error) => error.code === "40001",
      "the owner wrapper preserves strict entry OCC",
    );

    const { entryId: otherEntryId } = await insertSyntheticProjectEntry(db, "DRAFT", {
      entryId: uuid(55), candidateId: uuid(56), submissionId: uuid(57),
      ownerApp: APP, projectId: PROJECT, employeeSuffix: "000953",
    });
    await assert.rejects(
      db.query(
        `select public.direct_entry_update_own_draft_row(
          $1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5::text)`,
        [ownerAuth, ownerApp, otherEntryId, JSON.stringify({ general_note: "other owner" }), "r1-own-draft-other-owner"],
      ),
      (error) => error.code === "42501",
      "the owner wrapper denies another owner's draft row",
    );

    await db.query(
      `update public.direct_entry_submissions set state='SUBMITTED', version=version+1
        where submission_id=$1`, [uuid(54)],
    );
    await assert.rejects(
      db.query(
        `select public.direct_entry_update_own_draft_row(
          $1::uuid, $2::uuid, $3::uuid, 3, $4::jsonb, $5::text)`,
        [ownerAuth, ownerApp, entryId, JSON.stringify({ general_note: "submitted" }), "r1-own-draft-submitted"],
      ),
      (error) => error.code === "42501",
      "the owner wrapper denies submitted rows",
    );
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_audit_events
        where resource_ref=$1 and action='draft_row_update' and outcome='APPLIED'`, [entryId],
    )).rows[0].n, 2, "denied retries do not create extra applied audit events");
  } finally {
    await db.close();
  }
});

test("R1.1 projects team edit scope and preserves strict current-team direct-edit authority", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);
    const reasonCountBeforeBlank = (await db.query(
      `select count(*)::int as n from public.direct_entry_restricted_reasons where actor_user_id=$1`, [APP],
    )).rows[0].n;
    assert.equal((await db.query(
      `select public.direct_entry_reason($1, null) as reason_id`, [APP],
    )).rows[0].reason_id, null);
    assert.equal((await db.query(
      `select public.direct_entry_reason($1, '   ') as reason_id`, [APP],
    )).rows[0].reason_id, null);
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_restricted_reasons where actor_user_id=$1`, [APP],
    )).rows[0].n, reasonCountBeforeBlank,
    "omitted and blank reasons normalize to NULL without creating restricted-reason rows");
    await assert.rejects(
      db.query(`select public.direct_entry_reason($1, $2)`, [APP, "x".repeat(4001)]),
      (error) => error.code === "22023",
      "the restricted-reason boundary retains its existing 4,000 character maximum",
    );
    const leader = await seedStrictTeamLeader(db);
    await addCurrentCapability(db, APP, "entry_privileged_edit");
    await db.query(
      `insert into public.recruiter_provider_memberships
         (recruiter_id, provider_type, valid_from, is_current)
       values ($1, 'hrp', '2020-01-01', true)`, [REC_A],
    );
    await db.query(
      `insert into public.recruiter_team_memberships
         (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2020-01-01', true)`, [REC_A, TEAM_A],
    );
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, active)
       values ($1, 'Synthetic Team B Worker', true)`, [REC_C],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships
         (recruiter_id, provider_type, valid_from, is_current)
       values ($1, 'hrp', '2020-01-01', true)`, [REC_C],
    );
    await db.query(
      `insert into public.recruiter_team_memberships
         (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2020-01-01', true)`, [REC_C, TEAM_B],
    );

    const targetProject = "r1-synthetic-team-target";
    await db.query(
      `insert into public.direct_entry_projects(project_id, display_name, active)
       values ($1, 'Synthetic Team Target', true)`, [targetProject],
    );
    const mapReason = (await db.query(
      `select public.direct_entry_reason($1, 'Synthetic project team mapping') as reason_id`, [APP],
    )).rows[0].reason_id;
    await db.query(
      `insert into public.direct_entry_project_team_scopes
         (project_id, team_id, valid_from, version, granted_by_user_id, reason_id, is_current)
       values ($1, $2, '2020-01-01', 1, $3, $4, true),
              ($5, $2, '2020-01-01', 1, $3, $4, true)`,
      [PROJECT, TEAM_A, APP, mapReason, targetProject],
    );

    const { entryId: inTeamEntry } = await insertSyntheticProjectEntry(db, "SUBMITTED", {
      entryId: uuid(72), candidateId: uuid(73), submissionId: uuid(74),
      projectId: PROJECT, employeeSuffix: "000972", recruiterId: REC_A, teamId: TEAM_A,
    });
    const { entryId: outsideEntry } = await insertSyntheticProjectEntry(db, "SUBMITTED", {
      entryId: uuid(75), candidateId: uuid(76), submissionId: uuid(77),
      projectId: PROJECT, employeeSuffix: "000973", recruiterId: REC_C, teamId: TEAM_B,
    });
    const statusReason = (await db.query(
      `select public.direct_entry_reason($1, 'Synthetic initial status') as reason_id`, [APP],
    )).rows[0].reason_id;
    const authDate = (await db.query(
      `select public.direct_entry_authorization_date()::text as date`,
    )).rows[0].date;
    await db.query(
      `insert into public.direct_entry_employment_status_events
         (entry_id, status, effective_date, version, actor_user_id, reason_id)
       values ($1, 'UNCONFIRMED', $2, 1, $3, $4)`,
      [inTeamEntry, authDate, APP, statusReason],
    );

    assert.equal((await db.query(
      `select public.direct_entry_assert_team_leader_current_team($1, $2, $3) as team_id`,
      [leader.auth, leader.app, TEAM_A],
    )).rows[0].team_id, TEAM_A);

    const teamPage = (await db.query(
      `select public.direct_entry_list_workers($1, $2, 'team', null, null, null, null, 25) as data`,
      [leader.auth, leader.app],
    )).rows[0].data;
    assert.equal(teamPage.scope, "team");
    assert.deepEqual(teamPage.items.map((row) => row.entry_id), [inTeamEntry],
      "Team Leader directory only returns rows in its one current team");
    assert.equal(teamPage.items[0].allowed_actions.direct_edit, true,
      "direct edit is projected by the server for an in-team row");

    await db.query(
      `update public.direct_entry_scope_grants set is_current=false
        where app_user_id=$1 and scope_kind='team' and team_id=$2`, [APP, TEAM_A],
    );
    const adminPage = (await db.query(
      `select public.direct_entry_list_workers($1, $2, 'all', null, null, null, null, 25) as data`,
      [AUTH, APP],
    )).rows[0].data;
    assert.equal(adminPage.items.find((row) => row.entry_id === inTeamEntry)
      .allowed_actions.direct_edit, true, "the existing Admin/BoD edit action remains projected");

    assert.equal((await db.query(
      `select public.direct_entry_has_entry_access($1, 'entry_privileged_edit', $2, $3, $4) as allowed`,
      [leader.app, APP, TEAM_A, authDate],
    )).rows[0].allowed, false,
    "the Team Leader is not granted the existing all-scope edit capability");
    await assert.rejects(
      db.query(
        `select public.direct_entry_read_projection($1, $2, $3)`,
        [leader.auth, leader.app, outsideEntry],
      ),
      (error) => error.code === "42501",
      "Team Leader row detail is denied outside the current team",
    );
    await assert.rejects(
      db.query(
        `select public.direct_entry_privileged_edit(
          $1, $2, $3, 1, $4::jsonb, 'outside team attempt', 'r1-1-outside-team')`,
        [leader.auth, leader.app, outsideEntry, JSON.stringify({ employee_code: "outside" })],
      ),
      (error) => error.code === "42501",
      "direct_edit RPC remains the final authority for out-of-team rows",
    );

    const onResult = (await db.query(
      `select public.direct_entry_privileged_edit(
        $1, $2, $3, 1, $4::jsonb, null, 'r1-1-team-on') as result`,
      [leader.auth, leader.app, inTeamEntry, JSON.stringify({ employment_status: {
        status: "ON", effective_date: authDate,
      } })],
    )).rows[0].result;
    assert.equal(onResult.version, 2);
    const onReplay = (await db.query(
      `select public.direct_entry_privileged_edit(
        $1, $2, $3, 1, $4::jsonb, '   ', 'r1-1-team-on') as result`,
      [leader.auth, leader.app, inTeamEntry, JSON.stringify({ employment_status: {
        status: "ON", effective_date: authDate,
      } })],
    )).rows[0].result;
    assert.deepEqual(onReplay, onResult,
      "NULL and blank normalize before idempotency hashing and replay the same result");
    await assert.rejects(
      db.query(
        `select public.direct_entry_privileged_edit(
          $1, $2, $3, 2, $4::jsonb, $5, 'r1-1-long-reason')`,
        [leader.auth, leader.app, inTeamEntry,
          JSON.stringify({ employee_code: `hrp-${authDate.slice(0, 4)}-999999` }), "x".repeat(1001)],
      ),
      (error) => error.code === "22023",
      "the privileged-edit endpoint retains its narrower 1,000 character reason maximum",
    );
    assert.deepEqual((await db.query(
      `select status, leave_reason_text, version from public.direct_entry_employment_status_events
        where entry_id = $1 order by version desc limit 1`, [inTeamEntry],
    )).rows[0], { status: "ON", leave_reason_text: null, version: 2 });
    assert.deepEqual((await db.query(
      `select reason_id from public.direct_entry_employment_status_events
        where entry_id=$1 order by version desc limit 1`, [inTeamEntry],
    )).rows[0], { reason_id: null }, "the ON event retains its history with no placeholder reason");

    await assert.rejects(
      db.query(
        `select public.direct_entry_privileged_edit(
          $1, $2, $3, 2, $4::jsonb, 'missing leave reason', 'r1-1-team-off-missing-reason')`,
        [leader.auth, leader.app, inTeamEntry, JSON.stringify({
          employment_status: { status: "OFF", effective_date: authDate },
        })],
      ),
      (error) => ["22023", "23514"].includes(error.code),
      "OFF remains invalid without a nonblank leave reason",
    );

    const offPatch = { employment_status: {
      status: "OFF", effective_date: authDate, leave_reason: "Synthetic leave reason required for OFF",
    } };
    const offResult = (await db.query(
      `select public.direct_entry_privileged_edit($1, $2, $3, 2, $4::jsonb, $5, $6) as result`,
      [leader.auth, leader.app, inTeamEntry, JSON.stringify(offPatch), "   ", "r1-1-team-off"],
    )).rows[0].result;
    assert.equal(offResult.version, 3);
    assert.deepEqual((await db.query(
      `select status, leave_reason_text, version from public.direct_entry_employment_status_events
        where entry_id = $1 order by version desc limit 1`, [inTeamEntry],
    )).rows[0], {
      status: "OFF", leave_reason_text: "Synthetic leave reason required for OFF", version: 3,
    }, "Team Leader OFF change preserves mandatory leave reason and event history");
    assert.deepEqual((await db.query(
      `select reason_id from public.direct_entry_employment_status_events
        where entry_id=$1 order by version desc limit 1`, [inTeamEntry],
    )).rows[0], { reason_id: null },
    "OFF keeps its required leave reason independently from the optional action reason");

    const projectResult = (await db.query(
      `select public.direct_entry_privileged_edit(
        $1, $2, $3, 3, $4::jsonb, 'Move within team project', 'r1-1-team-project') as result`,
      [leader.auth, leader.app, inTeamEntry, JSON.stringify({ project_id: targetProject })],
    )).rows[0].result;
    assert.equal(projectResult.version, 4, "old and proposed project/team scopes are both current");
    await assert.rejects(
      db.query(
        `select public.direct_entry_privileged_edit(
          $1, $2, $3, 4, $4::jsonb, 'Move outside team', 'r1-1-team-project-outside')`,
        [leader.auth, leader.app, inTeamEntry, JSON.stringify({ recruiter_id: REC_C })],
      ),
      (error) => error.code === "42501",
      "a proposed recruiter on another team is denied before the row changes",
    );
    assert.deepEqual((await db.query(
      `select recruiter_id, team_id, project_id, version from public.direct_entries where entry_id=$1`,
      [inTeamEntry],
    )).rows[0], { recruiter_id: REC_A, team_id: TEAM_A, project_id: targetProject, version: 4 });
    await assert.rejects(
      db.query(
        `select public.direct_entry_privileged_edit(
          $1, $2, $3, 3, $4::jsonb, 'Stale edit', 'r1-1-team-stale')`,
        [leader.auth, leader.app, inTeamEntry, JSON.stringify({ employee_code: "stale" })],
      ),
      (error) => error.code === "40001",
      "direct Team Leader edits keep strict OCC after the scoped authorization path",
    );
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_audit_events
        where app_user_id=$1 and action='entry_privileged_edit' and outcome='APPLIED'
          and scope_kind='team' and scope_team_id=$2`, [leader.app, TEAM_A],
    )).rows[0].n, 3, "successful ON/OFF and project changes are audited as team-scoped");

    const teamExport = (await db.query(
      `select public.direct_entry_export_workers(
        $1, $2, 'team', null, null, null, 'Synthetic team export reason') as data`,
      [leader.auth, leader.app],
    )).rows[0].data;
    assert.equal(teamExport.status, "ok");
    assert.equal(teamExport.rows.length, 1);
    assert.equal(teamExport.rows[0].employee_code, `hrp-${authDate.slice(0, 4)}-000972`);
    assert.equal((await db.query(
      `select scope_kind from public.direct_entry_audit_events
        where app_user_id=$1 and action='worker_export' order by created_at desc limit 1`,
      [leader.app],
    )).rows[0].scope_kind, "team", "team export uses the same strict team audience and audit scope");

    await assert.rejects(
      db.query(
        `select public.direct_entry_assert_team_leader_current_team($1, $2, null)`, [AUTH, APP],
      ),
      (error) => error.code === "42501",
      "a full catalog operator cannot inherit Team Leader proof through the isolated bypass",
    );
    await assert.rejects(
      db.query(
        `select public.direct_entry_worker_directory_audience($1, $2, 'team', null)`, [AUTH, APP],
      ),
      (error) => error.code === "42501",
      "the catalog-operator branch does not authorize the Team Leader team directory scope",
    );

    await db.query(
      `insert into public.direct_entry_scope_grants
         (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1, 'team', $2, '2020-01-01', true)`, [leader.app, TEAM_B],
    );
    await assert.rejects(
      db.query(
        `select public.direct_entry_assert_team_leader_current_team($1, $2, null)`,
        [leader.auth, leader.app],
      ),
      (error) => error.code === "42501",
      "ambiguous multiple current team scopes fail closed",
    );
    await db.query(
      `update public.direct_entry_scope_grants set is_current=false
        where app_user_id=$1 and scope_kind='team' and team_id=$2`, [leader.app, TEAM_B],
    );
    await db.query("begin");
    await db.query("select set_config('direct_entry.team_leader_marker', 'on', true)");
    await db.query(
      `update public.direct_entry_team_leader_assignments
          set valid_to=valid_from, is_current=false
        where team_id=$1 and leader_app_user_id=$2`, [TEAM_A, leader.app],
    );
    await db.query("commit");
    await assert.rejects(
      db.query(
        `select public.direct_entry_assert_team_leader_current_team($1, $2, null)`,
        [leader.auth, leader.app],
      ),
      (error) => error.code === "42501",
      "revoked Team Leader assignment no longer authorizes current-team reads or edits",
    );

    const ambiguousAuth = uuid(80), ambiguousApp = uuid(81);
    await addActor(db, ambiguousAuth, ambiguousApp, "Synthetic Ambiguous Team Leader");
    await addCurrentCapability(db, ambiguousApp, "team_manager_assign");
    await db.query(
      `insert into public.direct_entry_scope_grants
         (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1, 'team', $2, '2020-01-01', true)`, [ambiguousApp, TEAM_B],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1, $2, true, '2020-01-01', true)`, [ambiguousApp, REC_C],
    );
    await db.query(
      `insert into public.direct_entry_team_leader_assignments
         (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
       values ($1, $2, $3, '2020-01-01', true)`, [TEAM_B, ambiguousApp, REC_C],
    );
    await db.query(
      `update public.direct_entry_app_user_recruiter_links
          set valid_to='2021-01-01'
        where app_user_id=$1 and recruiter_id=$2`, [ambiguousApp, REC_C],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1, $2, true, '2021-01-01', true)`, [ambiguousApp, REC_A],
    );
    await assert.rejects(
      db.query(
        `select public.direct_entry_assert_team_leader_current_team($1, $2, null)`,
        [ambiguousAuth, ambiguousApp],
      ),
      (error) => error.code === "42501",
      "ambiguous current recruiter links fail closed even when their history intervals do not overlap",
    );
  } finally {
    await db.close();
  }
});

test("R1.1 Team Leader request review uses the same current team for WORK_STATUS detail and decision", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);
    const leader = await seedStrictTeamLeader(db);
    await db.query(
      `insert into public.recruiter_provider_memberships
         (recruiter_id, provider_type, valid_from, is_current)
       values ($1, 'hrp', '2020-01-01', true)`, [REC_A],
    );
    await db.query(
      `insert into public.recruiter_team_memberships
         (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2020-01-01', true)`, [REC_A, TEAM_A],
    );
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, active)
       values ($1, 'Synthetic Team B Worker', true)`, [REC_C],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships
         (recruiter_id, provider_type, valid_from, is_current)
       values ($1, 'hrp', '2020-01-01', true)`, [REC_C],
    );
    await db.query(
      `insert into public.recruiter_team_memberships
         (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2020-01-01', true)`, [REC_C, TEAM_B],
    );
    const proposer = { auth: uuid(78), app: uuid(79) };
    await addActor(db, proposer.auth, proposer.app, "Synthetic Team Member");
    await addCurrentCapability(db, proposer.app, "change_request_create");
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1, $2, true, '2020-01-01', true)`, [proposer.app, REC_C],
    );
    await db.query(
      `select public.direct_entry_assign_project_manager(
        $1, $2, $3, $4, null, 1, 'Synthetic optional-reason PM', 'r1-1-optional-pm')`,
      [AUTH, APP, PROJECT, REC_C],
    );

    const { entryId: inTeamEntry } = await insertSyntheticProjectEntry(db, "SUBMITTED", {
      entryId: uuid(80), candidateId: uuid(81), submissionId: uuid(82),
      projectId: PROJECT, employeeSuffix: "000980", recruiterId: REC_A, teamId: TEAM_A,
    });
    const { entryId: outsideEntry } = await insertSyntheticProjectEntry(db, "SUBMITTED", {
      entryId: uuid(83), candidateId: uuid(84), submissionId: uuid(85),
      projectId: PROJECT, employeeSuffix: "000981", recruiterId: REC_C, teamId: TEAM_B,
    });
    const statusReason = (await db.query(
      `select public.direct_entry_reason($1, 'Synthetic initial status') as reason_id`, [APP],
    )).rows[0].reason_id;
    const authDate = (await db.query(
      `select public.direct_entry_authorization_date()::text as date`,
    )).rows[0].date;
    await db.query(
      `insert into public.direct_entry_employment_status_events
         (entry_id, status, effective_date, version, actor_user_id, reason_id)
       values ($1, 'UNCONFIRMED', $2, 1, $3, $4),
              ($5, 'UNCONFIRMED', $2, 1, $3, $4)`,
      [inTeamEntry, authDate, APP, statusReason, outsideEntry],
    );

    await db.query(
      `select public.direct_entry_privileged_edit(
        $1, $2, $3, 1, $4::jsonb, 'Current status baseline', 'r1-1-review-baseline')`,
      [leader.auth, leader.app, inTeamEntry, JSON.stringify({ employment_status: {
        status: "ON", effective_date: authDate,
      } })],
    );

    const requestReason = (await db.query(
      `select public.direct_entry_reason($1, 'Synthetic request context') as reason_id`, [proposer.app],
    )).rows[0].reason_id;
    const inTeamRequest = uuid(86);
    const outsideRequest = uuid(87);
    const staleRequest = uuid(88);
    const requestIds = [inTeamRequest, outsideRequest, staleRequest];
    for (const [index, requestId] of requestIds.entries()) {
      await db.query(
        `insert into public.direct_entry_change_requests
           (request_id, proposer_user_id, state, version, idempotency_key, request_hash, reason_id)
         values ($1, $2, 'PENDING', 1, $3, $4, $5)`,
        [requestId, proposer.app, `r1-1-request-${index}`, "a".repeat(64), requestReason],
      );
    }
    await db.query(
      `insert into public.direct_entry_change_request_items
         (request_id, entry_id, target_kind, expected_version, proposal)
       values ($1, $2, 'WORK_STATUS', 2, $3::jsonb),
              ($4, $5, 'WORK_STATUS', 1, $3::jsonb),
              ($6, $2, 'WORK_STATUS', 1, $3::jsonb)`,
      [inTeamRequest, inTeamEntry, JSON.stringify({
        status: "OFF", effective_date: authDate, leave_reason: "Synthetic proposed leave reason",
      }), outsideRequest, outsideEntry, staleRequest],
    );

    const inTeamEntryVersion = (await db.query(
      `select version from public.direct_entries where entry_id=$1`, [inTeamEntry],
    )).rows[0].version;
    const optionalItems = JSON.stringify([{
      entry_id: inTeamEntry, target_kind: "ENTRY_FIELD", expected_version: inTeamEntryVersion,
      proposal: { labor_type: "TEMPORARY" },
    }]);
    const optionalRequest = (await db.query(
      `select public.direct_entry_create_change_request(
        $1, $2, $3::jsonb, null, 'r1-1-optional-request') as data`,
      [proposer.auth, proposer.app, optionalItems],
    )).rows[0].data;
    const optionalRequestReplay = (await db.query(
      `select public.direct_entry_create_change_request(
        $1, $2, $3::jsonb, '   ', 'r1-1-optional-request') as data`,
      [proposer.auth, proposer.app, optionalItems],
    )).rows[0].data;
    assert.deepEqual(optionalRequestReplay, optionalRequest,
      "change-request create hashes the canonical NULL action reason");
    assert.equal((await db.query(
      `select reason_id from public.direct_entry_change_requests where request_id=$1`,
      [optionalRequest.request_id],
    )).rows[0].reason_id, null);
    assert.equal((await db.query(
      `select reason_id from public.direct_entry_change_request_revisions
        where request_id=$1 order by version desc limit 1`, [optionalRequest.request_id],
    )).rows[0].reason_id, null);
    assert.equal((await db.query(
      `select reason_id from public.direct_entry_audit_events
        where resource_ref=$1 and action='change_request_create' order by created_at desc limit 1`,
      [optionalRequest.request_id],
    )).rows[0].reason_id, null);

    assert.equal((await db.query(
      `select public.direct_entry_team_leader_request_team($1, $2) as team_id`,
      [leader.app, inTeamRequest],
    )).rows[0].team_id, TEAM_A);
    assert.equal((await db.query(
      `select public.direct_entry_change_request_audience($1, $2, $3) as audience`,
      [leader.app, proposer.app, inTeamRequest],
    )).rows[0].audience, "REVIEWER");
    assert.equal((await db.query(
      `select public.direct_entry_team_leader_request_team($1, $2) as team_id`,
      [leader.app, outsideRequest],
    )).rows[0].team_id, null);
    assert.equal((await db.query(
      `select public.direct_entry_change_request_audience($1, $2, $3) as audience`,
      [leader.app, proposer.app, outsideRequest],
    )).rows[0].audience, "NONE", "outside-team requests are not visible to the Team Leader");

    const requestList = (await db.query(
      `select public.direct_entry_list_change_requests($1, $2, 50, null, null) as data`,
      [leader.auth, leader.app],
    )).rows[0].data;
    assert.deepEqual(requestList.requests.map((request) => request.request_id).sort(),
      [inTeamRequest, staleRequest, optionalRequest.request_id].sort());
    assert.equal(requestList.requests.find((request) => request.request_id === inTeamRequest).can_decide, true);
    const detail = (await db.query(
      `select public.direct_entry_read_change_request($1, $2, $3) as data`,
      [leader.auth, leader.app, inTeamRequest],
    )).rows[0].data;
    assert.equal(detail.can_decide, true);
    assert.equal(detail.items[0].target_kind, "WORK_STATUS");
    assert.equal(detail.items[0].proposal.status, "OFF");
    assert.equal(detail.items[0].proposal.leave_reason, "Synthetic proposed leave reason");
    await assert.rejects(
      db.query(
        `select public.direct_entry_read_change_request($1, $2, $3)`,
        [leader.auth, leader.app, outsideRequest],
      ),
      (error) => error.code === "P0002",
      "outside-team request detail uses the non-enumerating not-found response",
    );

    await assert.rejects(
      db.query(
        `select public.direct_entry_decide_change_request(
          $1, $2, $3, 1, 'APPROVED', 'Approve stale proposal', 'r1-1-stale-approve')`,
        [leader.auth, leader.app, staleRequest],
      ),
      (error) => error.code === "40001",
      "a stale WORK_STATUS proposal cannot be applied by the Team Leader",
    );
    const rejected = (await db.query(
      `select public.direct_entry_decide_change_request(
        $1, $2, $3, 1, 'REJECTED', 'Reject stale proposal', 'r1-1-stale-reject') as data`,
      [leader.auth, leader.app, staleRequest],
    )).rows[0].data;
    assert.equal(rejected.state, "REJECTED", "a Team Leader can reject a stale current-team proposal");

    const approved = (await db.query(
      `select public.direct_entry_decide_change_request(
        $1, $2, $3, 1, 'APPROVED', null, 'r1-1-work-status-approve') as data`,
      [leader.auth, leader.app, inTeamRequest],
    )).rows[0].data;
    assert.equal(approved.state, "APPROVED");
    assert.equal((await db.query(
      `select decision_reason_id from public.direct_entry_change_requests where request_id=$1`,
      [inTeamRequest],
    )).rows[0].decision_reason_id, null);
    assert.equal((await db.query(
      `select reason_id from public.direct_entry_change_request_revisions
        where request_id=$1 order by version desc limit 1`, [inTeamRequest],
    )).rows[0].reason_id, null, "review revision persists without a placeholder decision reason");
    assert.equal((await db.query(
      `select reason_id from public.direct_entry_audit_events
        where app_user_id=$1 and action='change_request_approve' and resource_ref=$2
        order by created_at desc limit 1`,
      [leader.app, inTeamEntry],
    )).rows[0].reason_id, null, "review audit persists without a placeholder decision reason");
    assert.equal((await db.query(
      `select status, leave_reason_text from public.direct_entry_employment_status_events
        where entry_id=$1 order by version desc limit 1`, [inTeamEntry],
    )).rows[0].status, "OFF");
    assert.equal((await db.query(
      `select scope_kind, scope_team_id from public.direct_entry_audit_events
        where app_user_id=$1 and action='change_request_approve' and resource_ref=$2
        order by created_at desc limit 1`, [leader.app, inTeamEntry],
    )).rows[0].scope_team_id, TEAM_A,
    "WORK_STATUS approval retains the Team Leader current-team audit scope");

    await assert.rejects(
      db.query(
        `select public.direct_entry_decide_change_request(
          $1, $2, $3, 1, 'REJECTED', 'Cross-team decision', 'r1-1-cross-team-decision')`,
        [leader.auth, leader.app, outsideRequest],
      ),
      (error) => error.code === "42501",
      "the Team Leader cannot decide requests for another team",
    );
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
         has_function_privilege('public', 'public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)', 'EXECUTE') as team_helper_public,
         has_function_privilege('anon', 'public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)', 'EXECUTE') as team_helper_anon,
         has_function_privilege('authenticated', 'public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)', 'EXECUTE') as team_helper_authenticated,
         has_function_privilege('service_role', 'public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)', 'EXECUTE') as team_helper_service,
         has_function_privilege('service_role', 'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)', 'EXECUTE') as export_service,
         has_function_privilege('anon', 'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)', 'EXECUTE') as export_anon,
         has_function_privilege('authenticated', 'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)', 'EXECUTE') as export_authenticated`,
    );
    assert.deepEqual(rows[0], {
      resolver_service: true,
      resolver_anon: false,
      resolver_authenticated: false,
      helper_anon: false,
      helper_authenticated: false,
      helper_service: false,
      team_helper_public: false,
      team_helper_anon: false,
      team_helper_authenticated: false,
      team_helper_service: false,
      export_service: true,
      export_anon: false,
      export_authenticated: false,
    });
  } finally {
    await db.close();
  }
});
