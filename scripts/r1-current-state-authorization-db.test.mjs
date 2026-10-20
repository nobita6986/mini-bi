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
const PROJECT_PM = "r1-synthetic-pm-project";

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

async function insertSyntheticProjectEntry(db, state = "DRAFT", options = {}) {
  const {
    entryId = uuid(7), candidateId = uuid(8), submissionId = uuid(9),
    ownerApp = APP, projectId = PROJECT_PM, employeeSuffix = "000901",
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
      }), REC_A, TEAM_A],
    );
    if (state === "SUBMITTED") {
      await db.query(
        "update public.direct_entry_submissions set state='SUBMITTED', submitted_at=now() where submission_id=$1",
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

test("project deactivation preserves PM history authority until explicit unassign", async () => {
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
    await assert.rejects(
      db.query(
        `select public.direct_entry_update_draft_row(
          $1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5::text)`,
        [managerAuth, managerApp, entryId,
          JSON.stringify({ employee_code: `hrp-${year}-000902` }), "r1-pm-draft-denied"],
      ),
      (error) => error.code === "42501",
      "project-manager assignment alone does not grant draft-row edit authority",
    );
    assert.deepEqual((await db.query(
      "select employee_code, version from public.direct_entries where entry_id = $1", [entryId],
    )).rows[0], { employee_code: `hrp-${year}-000901`, version: 1 });
    await addCurrentCapability(db, APP, "submission_create");
    await db.query(
      `insert into public.direct_entry_scope_grants
         (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1, 'own', null, '2020-01-01', true)`, [APP],
    );
    await db.query(
      `select public.direct_entry_transition_submission_apply(
        $1::uuid, $2::uuid, $3::uuid, 1, 'SUBMITTED', $4::text, null, null)`,
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

test("own DRAFT wrapper preserves note/payment updates, OCC, audit and owner/workflow guards", async () => {
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
    const patch = {
      general_note: "Synthetic note update",
      payment: {
        state: "provided",
        account_number: "000012345678",
        bank_name: "Synthetic Bank",
        account_holder_name: "Synthetic Holder",
      },
    };
    await db.query(
      `select public.direct_entry_update_own_draft_row(
        $1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5::text)`,
      [ownerAuth, ownerApp, entryId, JSON.stringify(patch), "r1-own-draft-update"],
    );
    assert.deepEqual((await db.query(
      `select general_note, version from public.direct_entries where entry_id=$1`, [entryId],
    )).rows[0], { general_note: "Synthetic note update", version: 2 });
    assert.deepEqual((await db.query(
      `select state, account_number, bank_id, bank_name, account_holder_name, version
         from public.direct_entry_payments where entry_id=$1`, [entryId],
    )).rows[0], {
      state: "provided", account_number: "000012345678", bank_id: null,
      bank_name: "Synthetic Bank", account_holder_name: "Synthetic Holder", version: 1,
    });
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_revisions where entry_id=$1`, [entryId],
    )).rows[0].n, 1, "one row revision records the allowed draft edit");
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_audit_events
        where resource_ref=$1 and action='draft_row_update' and outcome='APPLIED'`, [entryId],
    )).rows[0].n, 1, "one applied audit event records the edit");

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
          $1::uuid, $2::uuid, $3::uuid, 2, $4::jsonb, $5::text)`,
        [ownerAuth, ownerApp, entryId, JSON.stringify({ general_note: "submitted" }), "r1-own-draft-submitted"],
      ),
      (error) => error.code === "42501",
      "the owner wrapper denies submitted rows",
    );
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_audit_events
        where resource_ref=$1 and action='draft_row_update' and outcome='APPLIED'`, [entryId],
    )).rows[0].n, 1, "denied retries do not create extra applied audit events");
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
