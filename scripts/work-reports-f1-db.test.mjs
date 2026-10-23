/**
 * F1 Work Reports — Database & Contract Foundation Regression Suite (`F1-WP0` / `F1-WP1`).
 *
 * Verifies against PGlite (all migrations through `20261021160000_f1_work_reports_foundation.sql`):
 *   - 27 DB capability tokens / 23 active TS tokens (`direct-entry-auth/1.5`)
 *   - Forced RLS + zero direct table grants on all 10 `work_report_*` tables
 *   - Revoked helper/trigger EXECUTE + exact service-role RPC allowlist
 *   - Actor binding (`auth_subject` mismatch, disabled user) & scope enforcement
 *   - Team Leader auto-grant / revoke / same-day re-designation / independent grant preservation (`OD-04`, `AG-14`, `AG-23`)
 *   - Template CRUD, draft update, clone, publish, archive & published version immutability (`AG-07`, `AG-18`)
 *   - Assignment `USER` / `TEAM` / `USER_SET` normalized target rows & all-or-nothing scope rejection (`OD-03`, `AG-09`)
 *   - Obligation materialization, `snapshot_team_id` immutability across team transfers (`AG-03`, `AG-08`)
 *   - `Asia/Ho_Chi_Minh` (`00:00 +07:00`) day boundary & deadline computation (`AG-15`)
 *   - Obligation `EXEMPT` & `REOPEN` with mandatory reason and audit (`OD-02`, `OD-03`, `AG-11`)
 *   - Draft save & submission revision append-only history, `is_late` & `has_post_deadline_amendment` (`OD-02`, `OD-05`, `AG-10`)
 *   - Synchronous metric projection (`requires_review = false` -> `COMPLETED`, `is_final = true`, `is_eligible = true`) & single current revision (`AG-04`, `AG-05`, `AG-12`)
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import {
  CAPABILITIES,
  DIRECT_ENTRY_AUTH_CONTRACT_VERSION,
} from "../src/lib/auth/direct-entry-v2.ts";
import {
  RECRUITMENT_DAILY_TEMPLATE_SCHEMA,
  WORK_REPORT_FIELD_TYPES,
} from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";
import {
  F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_RPC_SIGNATURE,
  F1_WORK_REPORTS_ASSIGNMENT_TRACKING_RPC_SIGNATURE,
  F1_5_WORK_REPORTS_ANALYTICS_RPC_SIGNATURES,
  F1_WORK_REPORTS_SERVICE_RPC_SIGNATURES,
  F2_WORK_REPORTS_REVIEW_AND_DELEGATION_RPC_SIGNATURES,
  WORK_REPORTS_READER_CONTRACT_RPC_SIGNATURES,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const WORK_REPORT_TABLES = [
  "work_report_templates",
  "work_report_template_versions",
  "work_report_assignments",
  "work_report_assignment_targets",
  "work_report_obligations",
  "work_report_submissions",
  "work_report_submission_revisions",
  "work_report_metric_values",
  "work_report_audit_events",
  "work_report_team_leader_capability_grants",
];

const TEAM_A = "94000000-0000-4000-8000-00000000f10a";
const TEAM_B = "94000000-0000-4000-8000-00000000f10b";

const ADMIN = {
  auth: "10000000-0000-4000-8000-00000000f101",
  app: "20000000-0000-4000-8000-00000000f101",
  name: "Work Report Admin",
};
const LEADER_A = {
  auth: "10000000-0000-4000-8000-00000000f102",
  app: "20000000-0000-4000-8000-00000000f102",
  recruiter: "30000000-0000-4000-8000-00000000f102",
  name: "Team Leader A",
};
const STAFF_A1 = {
  auth: "10000000-0000-4000-8000-00000000f103",
  app: "20000000-0000-4000-8000-00000000f103",
  recruiter: "30000000-0000-4000-8000-00000000f103",
  name: "Staff A1",
};
const STAFF_A2 = {
  auth: "10000000-0000-4000-8000-00000000f104",
  app: "20000000-0000-4000-8000-00000000f104",
  recruiter: "30000000-0000-4000-8000-00000000f104",
  name: "Staff A2",
};
const STAFF_B1 = {
  auth: "10000000-0000-4000-8000-00000000f105",
  app: "20000000-0000-4000-8000-00000000f105",
  recruiter: "30000000-0000-4000-8000-00000000f105",
  name: "Staff B1",
};
const DISABLED_USER = {
  auth: "10000000-0000-4000-8000-00000000f106",
  app: "20000000-0000-4000-8000-00000000f106",
  name: "Disabled Actor",
};

let seq = 0;
const KEY = (prefix) => `f1_${prefix}_${++seq}`;

async function createDatabase() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return db;
}

async function seedFixtures(db) {
  await db.query(
    `insert into public.teams (team_id, code, display_name, active)
     values ($1::uuid, 'WR_TEAM_A', 'Team Tuyển Dụng A', true),
            ($2::uuid, 'WR_TEAM_B', 'Team Tuyển Dụng B', true)`,
    [TEAM_A, TEAM_B],
  );

  for (const actor of [ADMIN, LEADER_A, STAFF_A1, STAFF_A2, STAFF_B1, DISABLED_USER]) {
    await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
       values ($1::uuid, $2::uuid, $3, $4)`,
      [actor.app, actor.auth, actor.name, actor !== DISABLED_USER],
    );
  }

  for (const capability of [
    "entry_admin",
    "team_master_manage",
    "recruiter_master_manage",
    "catalog_master_manage",
    "report_form_manage",
    "report_assign",
    "report_view",
    "report_analytics_view",
  ]) {
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)`,
      [ADMIN.app, capability],
    );
  }
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
     values ($1::uuid, 'all', '2026-01-01', true)`,
    [ADMIN.app],
  );

  for (const [person, teamId, code] of [
    [LEADER_A, TEAM_A, "NV_WR_LA"],
    [STAFF_A1, TEAM_A, "NV_WR_A1"],
    [STAFF_A2, TEAM_A, "NV_WR_A2"],
    [STAFF_B1, TEAM_B, "NV_WR_B1"],
  ]) {
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
       values ($1::uuid, $2, $3, 'STAFF', true)`,
      [person.recruiter, person.name, code],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
       values ($1::uuid, 'hrp', '2026-01-01', true)`,
      [person.recruiter],
    );
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, '2026-01-01', true)`,
      [person.recruiter, teamId],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
      [person.app, person.recruiter],
    );
  }
}

const db = await createDatabase();
await seedFixtures(db);

test("F1 schema, forced RLS, table privilege revocation and RPC allowlist match locked contract", async () => {
  assert.equal(DIRECT_ENTRY_AUTH_CONTRACT_VERSION, "direct-entry-auth/1.5");
  assert.equal(CAPABILITIES.length, 25);
  assert.equal(WORK_REPORT_FIELD_TYPES.length, 8);

  const { rows: tableRows } = await db.query(
    `select c.relname,
            c.relrowsecurity,
            c.relforcerowsecurity,
            has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
            has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
            has_table_privilege('service_role', c.oid, 'SELECT') as service_select,
            has_table_privilege('service_role', c.oid, 'INSERT') as service_insert
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = any($1::text[])
      order by c.relname`,
    [WORK_REPORT_TABLES],
  );
  assert.equal(tableRows.length, WORK_REPORT_TABLES.length);
  for (const row of tableRows) {
    assert.equal(row.relrowsecurity, true, `${row.relname} RLS enabled`);
    assert.equal(row.relforcerowsecurity, true, `${row.relname} FORCE RLS enabled`);
    assert.equal(row.anon_select, false, `${row.relname} anon select revoked`);
    assert.equal(row.auth_select, false, `${row.relname} authenticated select revoked`);
    assert.equal(row.service_select, false, `${row.relname} service_role select revoked`);
    assert.equal(row.service_insert, false, `${row.relname} service_role insert revoked`);
  }

  const { rows: fnRows } = await db.query(
    `select p.oid::regprocedure::text as signature,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
            has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname like 'work_report_%'
      order by p.oid::regprocedure::text`,
  );
  assert.ok(fnRows.every((r) => !r.anon_exec && !r.auth_exec), "zero client EXECUTE on work_report_*");
  const { rows: expectedFnRows } = await db.query(
    "select to_regprocedure(sig)::regprocedure::text as signature from unnest($1::text[]) as u(sig) order by 1",
    [[...F1_WORK_REPORTS_SERVICE_RPC_SIGNATURES, F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_RPC_SIGNATURE,
      F1_WORK_REPORTS_ASSIGNMENT_TRACKING_RPC_SIGNATURE, ...F1_5_WORK_REPORTS_ANALYTICS_RPC_SIGNATURES,
      ...F2_WORK_REPORTS_REVIEW_AND_DELEGATION_RPC_SIGNATURES,
      ...WORK_REPORTS_READER_CONTRACT_RPC_SIGNATURES]],
  );
  const serviceExec = fnRows.filter((r) => r.service_exec).map((r) => r.signature).sort();
  assert.deepEqual(serviceExec, expectedFnRows.map((r) => r.signature).sort());
});

test("Team Leader lifecycle auto-grants and revokes only the 3 F1 capabilities while preserving independent grants", async () => {
  // Give LEADER_A an independent report_view grant before designation
  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
     values ($1::uuid, 'report_view', '2026-01-01', true)`,
    [LEADER_A.app],
  );

  // Designate LEADER_A on TEAM_A via canonical RPC (4th arg is p_leader_app_user_id)
  await db.query(
    `select public.direct_entry_designate_team_leader(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-02-01'::date, 1, 'Designate leader A', $5
     )`,
    [ADMIN.auth, ADMIN.app, TEAM_A, LEADER_A.app, KEY("leader_desig_1")],
  );

  const { rows: currentAfterDesignate } = await db.query(
    `select capability from public.direct_entry_capability_grants
      where app_user_id = $1::uuid and is_current
      order by capability`,
    [LEADER_A.app],
  );
  assert.deepEqual(
    currentAfterDesignate.map((r) => r.capability),
    ["report_analytics_view", "report_assign", "report_review", "report_view", "team_manager_assign"],
  );
  assert.equal(
    currentAfterDesignate.some((r) => r.capability === "report_form_manage" || r.capability === "report_delegate"),
    false,
    "never auto-grants report_form_manage or report_delegate",
  );

  // Revoke LEADER_A on the same day (2026-02-01, team version = 2) -> independent report_view stays active, generated grants close cleanly
  await db.query(
    `select public.direct_entry_revoke_team_leader(
       $1::uuid, $2::uuid, $3::uuid, '2026-02-01'::date, 2, 'Revoke leader A same day', $4
     )`,
    [ADMIN.auth, ADMIN.app, TEAM_A, KEY("leader_revoke_1")],
  );

  const { rows: currentAfterRevoke } = await db.query(
    `select capability from public.direct_entry_capability_grants
      where app_user_id = $1::uuid and is_current
      order by capability`,
    [LEADER_A.app],
  );
  assert.deepEqual(
    currentAfterRevoke.map((r) => r.capability),
    ["report_view"],
    "independent report_view grant survives leader revocation while auto-granted capabilities close",
  );

  // Re-designate LEADER_A on the same day (2026-02-01, team version = 3) -> must not hit 23P01 overlap
  await db.query(
    `select public.direct_entry_designate_team_leader(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-02-01'::date, 3, 'Re-designate leader A', $5
     )`,
    [ADMIN.auth, ADMIN.app, TEAM_A, LEADER_A.app, KEY("leader_desig_2")],
  );

  const { rows: currentAfterRedesignate } = await db.query(
    `select capability from public.direct_entry_capability_grants
      where app_user_id = $1::uuid and is_current
      order by capability`,
    [LEADER_A.app],
  );
  assert.deepEqual(
    currentAfterRedesignate.map((r) => r.capability),
    ["report_analytics_view", "report_assign", "report_review", "report_view", "team_manager_assign"],
  );
});

test("closed overlapping independent Work Reports grants are never resurrected or overwritten across designate, revoke, disable and re-designate", async () => {
  // STAFF_B1 is a valid candidate on TEAM_B (version = 1).
  // 1) Give STAFF_B1 a CLOSED independent report_assign grant [2026-01-10, 2026-06-01) (is_current = false)
  //    that overlaps the upcoming Team Leader assignment effective 2026-02-01, AND an ACTIVE independent
  //    report_view grant [2026-01-10, null) (is_current = true).
  const { rows: closedIndRows } = await db.query(
    `insert into public.direct_entry_capability_grants
       (app_user_id, capability, valid_from, valid_to, is_current)
     values ($1::uuid, 'report_assign', '2026-01-10'::date, '2026-06-01'::date, false)
     returning grant_id, valid_from::text, valid_to::text, is_current`,
    [STAFF_B1.app],
  );
  const closedIndependentGrantId = closedIndRows[0].grant_id;

  const { rows: activeIndRows } = await db.query(
    `insert into public.direct_entry_capability_grants
       (app_user_id, capability, valid_from, valid_to, is_current)
     values ($1::uuid, 'report_view', '2026-01-10'::date, null, true)
     returning grant_id`,
    [STAFF_B1.app],
  );
  const activeIndependentGrantId = activeIndRows[0].grant_id;

  // 2) Designate STAFF_B1 on TEAM_B effective 2026-02-01 (overlaps [2026-01-10, 2026-06-01))
  const { rows: desigB1 } = await db.query(
    `select public.direct_entry_designate_team_leader(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-02-01'::date, 1, 'Designate B1 with closed overlapping grant', $5
     ) as result`,
    [ADMIN.auth, ADMIN.app, TEAM_B, STAFF_B1.app, KEY("leader_b1_desig_1")],
  );
  const assignmentId1 = desigB1[0].result.assignment_id;

  // Verify the closed independent report_assign grant was NOT resurrected, NOT modified, and NOT linked to leader grants
  const { rows: checkClosedAfterDesig } = await db.query(
    `select g.grant_id, g.valid_from::text as valid_from, g.valid_to::text as valid_to, g.is_current,
            exists (
              select 1 from public.work_report_team_leader_capability_grants x
               where x.capability_grant_id = g.grant_id
            ) as linked_to_leader
       from public.direct_entry_capability_grants g
      where g.grant_id = $1::uuid`,
    [closedIndependentGrantId],
  );
  assert.deepEqual(checkClosedAfterDesig[0], {
    grant_id: closedIndependentGrantId,
    valid_from: "2026-01-10",
    valid_to: "2026-06-01",
    is_current: false,
    linked_to_leader: false,
  });

  // Verify a separate current leader-owned report_assign grant was created starting at 2026-06-01
  const { rows: leaderOwnedAfterDesig } = await db.query(
    `select g.grant_id, g.valid_from::text as valid_from, g.valid_to::text as valid_to, g.is_current
       from public.work_report_team_leader_capability_grants x
       join public.direct_entry_capability_grants g on g.grant_id = x.capability_grant_id
      where x.leader_assignment_id = $1::uuid and x.capability = 'report_assign'`,
    [assignmentId1],
  );
  assert.equal(leaderOwnedAfterDesig.length, 1);
  assert.notEqual(leaderOwnedAfterDesig[0].grant_id, closedIndependentGrantId);
  assert.equal(leaderOwnedAfterDesig[0].valid_from, "2026-06-01");
  assert.equal(leaderOwnedAfterDesig[0].valid_to, null);
  assert.equal(leaderOwnedAfterDesig[0].is_current, true);

  // 3) Revoke STAFF_B1 on TEAM_B on 2026-02-15 (team version = 2)
  await db.query(
    `select public.direct_entry_revoke_team_leader(
       $1::uuid, $2::uuid, $3::uuid, '2026-02-15'::date, 2, 'Revoke B1 before closed grant valid_to', $4
     )`,
    [ADMIN.auth, ADMIN.app, TEAM_B, KEY("leader_b1_revoke_1")],
  );

  // Closed independent report_assign stays [2026-01-10, 2026-06-01) with is_current = false;
  // active independent report_view stays is_current = true; leader-owned grants are closed.
  const { rows: b1CurrentAfterRevoke } = await db.query(
    `select grant_id, capability from public.direct_entry_capability_grants
      where app_user_id = $1::uuid and is_current
      order by capability`,
    [STAFF_B1.app],
  );
  assert.deepEqual(b1CurrentAfterRevoke, [
    { grant_id: activeIndependentGrantId, capability: "report_view" },
  ]);

  const { rows: checkClosedAfterRevoke } = await db.query(
    `select valid_from::text as valid_from, valid_to::text as valid_to, is_current
       from public.direct_entry_capability_grants
      where grant_id = $1::uuid`,
    [closedIndependentGrantId],
  );
  assert.deepEqual(checkClosedAfterRevoke[0], {
    valid_from: "2026-01-10",
    valid_to: "2026-06-01",
    is_current: false,
  });

  // 4) Re-designate STAFF_B1 on TEAM_B effective 2026-03-01 (team version = 3), then disable via assignment is_current=false,
  //    then revoke & re-designate again -> closed independent grant remains intact and active independent grant survives.
  const { rows: desigB2 } = await db.query(
    `select public.direct_entry_designate_team_leader(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-03-01'::date, 3, 'Re-designate B1', $5
     ) as result`,
    [ADMIN.auth, ADMIN.app, TEAM_B, STAFF_B1.app, KEY("leader_b1_desig_2")],
  );
  const assignmentId2 = desigB2[0].result.assignment_id;

  // Simulate disable clearing assignment is_current (as direct_entry_clear_authority_on_disable does)
  await db.query(
    `update public.direct_entry_team_leader_assignments set is_current = false where assignment_id = $1::uuid`,
    [assignmentId2],
  );

  const { rows: b1CurrentAfterDisable } = await db.query(
    `select grant_id, capability from public.direct_entry_capability_grants
      where app_user_id = $1::uuid and capability like 'report_%' and is_current
      order by capability`,
    [STAFF_B1.app],
  );
  assert.deepEqual(
    b1CurrentAfterDisable,
    [{ grant_id: activeIndependentGrantId, capability: "report_view" }],
    "disabling leader assignment closes leader-owned Work Reports grants without closing active independent report_view",
  );

  // Restore assignmentId2 to current so we can cleanly revoke TEAM_B via canonical RPC
  await db.query(
    `update public.direct_entry_team_leader_assignments set is_current = true where assignment_id = $1::uuid`,
    [assignmentId2],
  );
  await db.query(
    `select public.direct_entry_revoke_team_leader(
       $1::uuid, $2::uuid, $3::uuid, '2026-03-10'::date, 4, 'Clean revoke B1 after disable test', $4
     )`,
    [ADMIN.auth, ADMIN.app, TEAM_B, KEY("leader_b1_revoke_2")],
  );

  // Clean up STAFF_B1 independent grants so subsequent tests see STAFF_B1 with no special grants
  await db.query(
    `delete from public.direct_entry_capability_grants where grant_id = any($1::uuid[])`,
    [[closedIndependentGrantId, activeIndependentGrantId]],
  );
});

test("actor binding rejects auth_subject mismatch, disabled user, and non-form-manager", async () => {
  const metricContract = buildWorkReportMetricContract(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);

  // Forged auth_subject / app_user_id pair
  await assert.rejects(
    db.query("select public.work_report_list_templates($1::uuid, $2::uuid)", [
      ADMIN.auth,
      LEADER_A.app,
    ]),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_ACTOR_DENIED"),
  );

  // Disabled user
  await assert.rejects(
    db.query("select public.work_report_list_my_obligations($1::uuid, $2::uuid, null)", [
      DISABLED_USER.auth,
      DISABLED_USER.app,
    ]),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_ACTOR_DENIED"),
  );

  // Team Leader without report_form_manage cannot create template
  await assert.rejects(
    db.query(
      `select public.work_report_create_template(
         $1::uuid, $2::uuid, 'RECRUITMENT_DAILY_V1', 'Báo cáo ngày', null, 'DAILY', $3::jsonb, $4::jsonb, $5
       )`,
      [
        LEADER_A.auth,
        LEADER_A.app,
        JSON.stringify(RECRUITMENT_DAILY_TEMPLATE_SCHEMA),
        JSON.stringify(metricContract),
        KEY("denied_tpl"),
      ],
    ),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_CAPABILITY_DENIED"),
  );
});

test("template lifecycle: create, update draft, publish, immutability of published version, and clone draft", async () => {
  const metricContract = buildWorkReportMetricContract(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);

  const createKey = KEY("tpl_create");
  const { rows: createdRows } = await db.query(
    `select public.work_report_create_template(
       $1::uuid, $2::uuid, 'RECRUITMENT_DAILY_V1', 'Báo cáo công việc tuyển dụng ngày',
       'Mẫu số 1 đã khóa F0', 'DAILY', $3::jsonb, $4::jsonb, $5
     ) as result`,
    [
      ADMIN.auth,
      ADMIN.app,
      JSON.stringify(RECRUITMENT_DAILY_TEMPLATE_SCHEMA),
      JSON.stringify(metricContract),
      createKey,
    ],
  );
  const created = createdRows[0].result;
  assert.ok(created.template_id);
  assert.ok(created.draft_version_id);
  assert.equal(created.version, 1);

  // Idempotent replay returns exact same result
  const { rows: replayRows } = await db.query(
    `select public.work_report_create_template(
       $1::uuid, $2::uuid, 'RECRUITMENT_DAILY_V1', 'Báo cáo công việc tuyển dụng ngày',
       'Mẫu số 1 đã khóa F0', 'DAILY', $3::jsonb, $4::jsonb, $5
     ) as result`,
    [
      ADMIN.auth,
      ADMIN.app,
      JSON.stringify(RECRUITMENT_DAILY_TEMPLATE_SCHEMA),
      JSON.stringify(metricContract),
      createKey,
    ],
  );
  assert.deepEqual(replayRows[0].result, created);

  // Update draft before publish
  const { rows: updatedRows } = await db.query(
    `select public.work_report_update_template_draft(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1,
       'Báo cáo công việc tuyển dụng ngày (Chính thức)', 'Mẫu nghiệp vụ tuyển dụng', 'DAILY',
       $5::jsonb, $6::jsonb, $7
     ) as result`,
    [
      ADMIN.auth,
      ADMIN.app,
      created.template_id,
      created.draft_version_id,
      JSON.stringify(RECRUITMENT_DAILY_TEMPLATE_SCHEMA),
      JSON.stringify(metricContract),
      KEY("tpl_update"),
    ],
  );
  assert.equal(updatedRows[0].result.version, 2);

  // Publish template version 1
  const { rows: publishedRows } = await db.query(
    `select public.work_report_publish_template(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 2, $5
     ) as result`,
    [
      ADMIN.auth,
      ADMIN.app,
      created.template_id,
      created.draft_version_id,
      KEY("tpl_publish"),
    ],
  );
  assert.equal(publishedRows[0].result.published_version_id, created.draft_version_id);
  assert.equal(publishedRows[0].result.version, 3);

  // Published version cannot be mutated in place (trigger guard AG-07 / AG-18)
  await assert.rejects(
    db.query(
      `update public.work_report_template_versions
          set schema_checksum = repeat('0', 64)
        where version_id = $1::uuid`,
      [created.draft_version_id],
    ),
    (err) => err.code === "55000" && err.message.includes("immutable"),
  );

  // Clone new draft (version_no = 2) from published version 1
  const { rows: clonedRows } = await db.query(
    `select public.work_report_clone_template_draft(
       $1::uuid, $2::uuid, $3::uuid, 3, $4
     ) as result`,
    [ADMIN.auth, ADMIN.app, created.template_id, KEY("tpl_clone")],
  );
  assert.ok(clonedRows[0].result.draft_version_id);
  assert.notEqual(clonedRows[0].result.draft_version_id, created.draft_version_id);
  assert.equal(clonedRows[0].result.version, 4);
});

test("assignments, obligations, snapshot_team_id immutability, deadline/reopen/exempt and synchronous metric projection", async () => {
  const { rows: tplList } = await db.query(
    "select public.work_report_list_templates($1::uuid, $2::uuid) as result",
    [ADMIN.auth, ADMIN.app],
  );
  const templateId = tplList[0].result.items[0].template_id;

  const { rows: leaderOptions } = await db.query(
    "select public.work_report_list_assignment_options($1::uuid, $2::uuid, null) as result",
    [LEADER_A.auth, LEADER_A.app],
  );
  assert.deepEqual(leaderOptions[0].result.teams.map((team) => team.team_id), [TEAM_A]);
  assert.ok(leaderOptions[0].result.templates.some((item) => item.template_id === templateId));
  assert.deepEqual(leaderOptions[0].result.users, [], "unselected team returns no roster");

  const { rows: rosterOptions } = await db.query(
    "select public.work_report_list_assignment_options($1::uuid, $2::uuid, $3::uuid) as result",
    [LEADER_A.auth, LEADER_A.app, TEAM_A],
  );
  assert.deepEqual(
    rosterOptions[0].result.users.map((user) => user.app_user_id).sort(),
    [LEADER_A.app, STAFF_A1.app, STAFF_A2.app].sort(),
    "Team Leader sees only enabled, verified current members in their authorized team",
  );
  await assert.rejects(
    db.query("select public.work_report_list_assignment_options($1::uuid, $2::uuid, $3::uuid)",
      [LEADER_A.auth, LEADER_A.app, TEAM_B]),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_SCOPE_DENIED"),
  );
  await assert.rejects(
    db.query("select public.work_report_list_assignment_options($1::uuid, $2::uuid, null)",
      [ADMIN.auth, LEADER_A.app]),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_ACTOR_DENIED"),
  );

  // OD-03 / AG-09: LEADER_A (team A scope) attempting USER_SET with STAFF_A1 (team A) + STAFF_B1 (team B)
  // must reject the entire transaction with zero rows created
  await assert.rejects(
    db.query(
      `select public.work_report_create_assignment(
         $1::uuid, $2::uuid, $3::uuid, 'USER_SET', null, null, $4::uuid[],
         'DAILY', true, 0, '23:59:59'::time, false, '2026-10-01'::date, null, $5
       )`,
      [
        LEADER_A.auth,
        LEADER_A.app,
        templateId,
        [STAFF_A1.app, STAFF_B1.app],
        KEY("assign_mixed_denied"),
      ],
    ),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_SCOPE_DENIED"),
  );

  const { rows: targetCountAfterReject } = await db.query(
    "select count(*)::int as n from public.work_report_assignment_targets",
  );
  assert.equal(targetCountAfterReject[0].n, 0, "mixed-scope USER_SET leaves zero target rows");

  // LEADER_A creates valid USER_SET assignment for STAFF_A1 and STAFF_A2 in Team A
  const { rows: assignRows } = await db.query(
    `select public.work_report_create_assignment(
       $1::uuid, $2::uuid, $3::uuid, 'USER_SET', null, null, $4::uuid[],
       'DAILY', true, 0, '23:59:59'::time, false, '2026-01-01'::date, null, $5
     ) as result`,
    [
      LEADER_A.auth,
      LEADER_A.app,
      templateId,
      [STAFF_A1.app, STAFF_A2.app],
      KEY("assign_team_a_set"),
    ],
  );
  const assignmentId = assignRows[0].result.assignment_id;
  assert.ok(assignmentId);

  const { rows: targetRows } = await db.query(
    `select target_user_id from public.work_report_assignment_targets
      where assignment_id = $1::uuid order by target_user_id`,
    [assignmentId],
  );
  assert.equal(targetRows.length, 2, "normalized work_report_assignment_targets stores both assignees");

  const { rows: leaderAssignments } = await db.query(
    "select public.work_report_list_assignments($1::uuid, $2::uuid, $3::uuid) as result",
    [LEADER_A.auth, LEADER_A.app, TEAM_A],
  );
  assert.equal(leaderAssignments[0].result.items.length, 1);
  assert.equal(leaderAssignments[0].result.items[0].assignment_id, assignmentId);
  assert.equal(leaderAssignments[0].result.items[0].target_label, "Staff A1, Staff A2");
  assert.equal(leaderAssignments[0].result.items[0].obligation_total, 0);
  await assert.rejects(
    db.query("select public.work_report_list_assignments($1::uuid, $2::uuid, $3::uuid)",
      [LEADER_A.auth, LEADER_A.app, TEAM_B]),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_SCOPE_DENIED"),
  );
  await assert.rejects(
    db.query("select public.work_report_list_assignments($1::uuid, $2::uuid, null)",
      [ADMIN.auth, LEADER_A.app]),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_ACTOR_DENIED"),
  );

  // Materialize obligations for a future business date so due_at is in the future for normal submit
  const futureDate = "2099-10-21";
  const { rows: matFuture } = await db.query(
    `select public.work_report_ensure_obligations_for_window(
       $1::uuid, $2::uuid, $3::date
     ) as result`,
    [LEADER_A.auth, LEADER_A.app, futureDate],
  );
  assert.equal(matFuture[0].result.inserted_count, 2);

  const { rows: progressRows } = await db.query(
    "select public.work_report_list_assignments($1::uuid, $2::uuid, $3::uuid) as result",
    [LEADER_A.auth, LEADER_A.app, TEAM_A],
  );
  const tracked = progressRows[0].result.items.find((item) => item.assignment_id === assignmentId);
  assert.equal(tracked.obligation_total, 2);
  assert.equal(tracked.not_started_count, 2);
  assert.equal(tracked.submitted_count, 0);

  // Re-running materialization for the same window is idempotent (inserted_count = 0)
  const { rows: matFutureReplay } = await db.query(
    `select public.work_report_ensure_obligations_for_window(
       $1::uuid, $2::uuid, $3::date
     ) as result`,
    [LEADER_A.auth, LEADER_A.app, futureDate],
  );
  assert.equal(matFutureReplay[0].result.inserted_count, 0);

  // Check STAFF_A1 obligation list
  const { rows: myObsRows } = await db.query(
    "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE') as result",
    [STAFF_A1.auth, STAFF_A1.app],
  );
  const a1Obligation = myObsRows[0].result.items.find((o) => o.period_key === futureDate);
  assert.ok(a1Obligation, "STAFF_A1 sees materialized obligation");
  assert.equal(a1Obligation.submission_state, "NOT_STARTED");

  // Save draft (partial payload allowed when required fields are omitted/null)
  const { rows: draftRows } = await db.query(
    `select public.work_report_save_draft(
       $1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5
     ) as result`,
    [
      STAFF_A1.auth,
      STAFF_A1.app,
      a1Obligation.obligation_id,
      JSON.stringify({ calls_made: 12, notes: "Bản nháp buổi sáng" }),
      KEY("save_draft_1"),
    ],
  );
  assert.equal(draftRows[0].result.state, "DRAFT");
  assert.equal(draftRows[0].result.version, 1);

  // Submit revision 1 (requires_review = false -> COMPLETED, synchronous metric projection)
  const { rows: submit1Rows } = await db.query(
    `select public.work_report_submit(
       $1::uuid, $2::uuid, $3::uuid, $4::jsonb, 1, $5
     ) as result`,
    [
      STAFF_A1.auth,
      STAFF_A1.app,
      a1Obligation.obligation_id,
      JSON.stringify({
        calls_made: 25,
        interested_candidates: 6,
        workers_started: 2,
        notes: "Hoàn thành chỉ tiêu ngày",
      }),
      KEY("submit_rev_1"),
    ],
  );
  const sub1 = submit1Rows[0].result;
  assert.equal(sub1.revision_no, 1);
  assert.equal(sub1.state, "COMPLETED");
  assert.equal(sub1.version, 2);

  // Resubmit revision 2 before due_at -> revision 1 stays in history, only revision 2 is is_eligible
  const { rows: submit2Rows } = await db.query(
    `select public.work_report_submit(
       $1::uuid, $2::uuid, $3::uuid, $4::jsonb, 2, $5
     ) as result`,
    [
      STAFF_A1.auth,
      STAFF_A1.app,
      a1Obligation.obligation_id,
      JSON.stringify({
        calls_made: 30,
        interested_candidates: 8,
        workers_started: 3,
        notes: "Cập nhật bổ sung buổi chiều",
      }),
      KEY("submit_rev_2"),
    ],
  );
  const sub2 = submit2Rows[0].result;
  assert.equal(sub2.revision_no, 2);
  assert.equal(sub2.state, "COMPLETED");

  const { rows: metricRows } = await db.query(
    `select revision_id, metric_key, numeric_value::int as val, is_current_revision, is_provisional, is_final, is_eligible
       from public.work_report_metric_values
      where submission_id = $1::uuid
      order by created_at, metric_key`,
    [sub2.submission_id],
  );
  assert.equal(metricRows.length, 6, "3 metrics for rev 1 + 3 metrics for rev 2");
  const eligibleMetrics = metricRows.filter((m) => m.is_eligible);
  assert.equal(eligibleMetrics.length, 3, "only the 3 metrics from current revision 2 are eligible");
  assert.ok(eligibleMetrics.every((m) => m.revision_id === sub2.revision_id && m.is_final && !m.is_provisional));
  assert.deepEqual(
    eligibleMetrics.map((m) => [m.metric_key, m.val]),
    [
      ["calls_made", 30],
      ["interested_candidates", 8],
      ["workers_started", 3],
    ],
  );

  // AG-08: Transfer STAFF_A1 from TEAM_A to TEAM_B; historical obligation & metric snapshot_team_id must stay TEAM_A
  await db.query(
    `update public.recruiter_team_memberships set is_current = false, valid_to = '2026-10-22'
      where recruiter_id = $1::uuid and is_current`,
    [STAFF_A1.recruiter],
  );
  await db.query(
    `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
     values ($1::uuid, $2::uuid, '2026-10-22', true)`,
    [STAFF_A1.recruiter, TEAM_B],
  );
  const { rows: snapCheck } = await db.query(
    `select o.snapshot_team_id, o.snapshot_team_code, s.submitted_team_id
       from public.work_report_obligations o
       join public.work_report_submissions s on s.obligation_id = o.obligation_id
      where o.obligation_id = $1::uuid`,
    [a1Obligation.obligation_id],
  );
  assert.equal(snapCheck[0].snapshot_team_id, TEAM_A);
  assert.equal(snapCheck[0].snapshot_team_code, "WR_TEAM_A");
  assert.equal(snapCheck[0].submitted_team_id, TEAM_A);

  // Restore STAFF_A1 back to TEAM_A for subsequent deadline tests
  await db.query(
    `delete from public.recruiter_team_memberships where recruiter_id = $1::uuid and team_id = $2::uuid`,
    [STAFF_A1.recruiter, TEAM_B],
  );
  await db.query(
    `update public.recruiter_team_memberships set is_current = true, valid_to = null
      where recruiter_id = $1::uuid and team_id = $2::uuid`,
    [STAFF_A1.recruiter, TEAM_A],
  );

  // Past-due window test (OD-02, OD-05, AG-11): materialize for 2026-01-10 (already past due_at)
  const pastDate = "2026-01-10";
  await db.query(
    `select public.work_report_ensure_obligations_for_window(
       $1::uuid, $2::uuid, $3::date
     )`,
    [LEADER_A.auth, LEADER_A.app, pastDate],
  );

  const { rows: pastObs } = await db.query(
    `select obligation_id, assignee_app_user_id, version
       from public.work_report_obligations
      where period_key = $1 order by assignee_app_user_id`,
    [pastDate],
  );
  const pastA1 = pastObs.find((o) => o.assignee_app_user_id === STAFF_A1.app);
  const pastA2 = pastObs.find((o) => o.assignee_app_user_id === STAFF_A2.app);

  // STAFF_A1 cannot submit after due_at when not reopened
  await assert.rejects(
    db.query(
      `select public.work_report_submit(
         $1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5
       )`,
      [
        STAFF_A1.auth,
        STAFF_A1.app,
        pastA1.obligation_id,
        JSON.stringify({
          calls_made: 5,
          interested_candidates: 1,
          workers_started: 0,
          notes: "Nộp muộn",
        }),
        KEY("late_denied"),
      ],
    ),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_DEADLINE_PASSED"),
  );

  // LEADER_A reopens pastA1 with mandatory reason
  const reopenUntil = "2099-12-31T16:59:59Z";
  await db.query(
    `select public.work_report_change_obligation_status(
       $1::uuid, $2::uuid, $3::uuid, $4, 'REOPEN', 'Cho phép nộp bù báo cáo ngày 10/01',
       $5::timestamptz, $6
     )`,
    [LEADER_A.auth, LEADER_A.app, pastA1.obligation_id, pastA1.version, reopenUntil, KEY("reopen_past_a1")],
  );

  // Now STAFF_A1 submits during reopened window -> is_late = true, has_post_deadline_amendment = false on first submit
  const { rows: lateSub1 } = await db.query(
    `select public.work_report_submit(
       $1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5
     ) as result`,
    [
      STAFF_A1.auth,
      STAFF_A1.app,
      pastA1.obligation_id,
      JSON.stringify({
        calls_made: 5,
        interested_candidates: 1,
        workers_started: 0,
        notes: "Nộp bù lần 1",
      }),
      KEY("late_sub_1"),
    ],
  );
  // Second submit after due_at sets has_post_deadline_amendment = true while preserving is_late = true
  await db.query(
    `select public.work_report_submit(
       $1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $6
     )`,
    [
      STAFF_A1.auth,
      STAFF_A1.app,
      pastA1.obligation_id,
      JSON.stringify({
        calls_made: 7,
        interested_candidates: 2,
        workers_started: 1,
        notes: "Nộp bù chỉnh sửa lần 2",
      }),
      lateSub1[0].result.version,
      KEY("late_sub_2"),
    ],
  );

  const { rows: detailRows } = await db.query(
    "select public.work_report_get_submission($1::uuid, $2::uuid, $3::uuid) as result",
    [LEADER_A.auth, LEADER_A.app, pastA1.obligation_id],
  );
  const subDetail = detailRows[0].result.submission;
  assert.equal(subDetail.is_late, true, "first submission after due_at marks is_late = true");
  assert.equal(
    subDetail.has_post_deadline_amendment,
    true,
    "second submission after due_at marks has_post_deadline_amendment = true",
  );
  assert.equal(detailRows[0].result.revisions.length, 2, "both revisions preserved in append-only history");

  // LEADER_A exempts pastA2 with mandatory reason
  const { rows: exemptRows } = await db.query(
    `select public.work_report_change_obligation_status(
       $1::uuid, $2::uuid, $3::uuid, $4, 'EXEMPT', 'Nhân sự nghỉ phép có duyệt', null, $5
     ) as result`,
    [LEADER_A.auth, LEADER_A.app, pastA2.obligation_id, pastA2.version, KEY("exempt_past_a2")],
  );
  assert.equal(exemptRows[0].result.status, "EXEMPTED");
});

test("Vietnam timezone boundary (00:00 Asia/Ho_Chi_Minh) and Sunday deadline rule", async () => {
  // 2026-10-25 is a Sunday. With exclude_sundays = true and offset = 0, due date shifts to Monday 2026-10-26.
  const { rows } = await db.query(
    `select public.work_report_due_at('2026-10-25'::date, 0, '00:00:00'::time, true) as shifted_sunday,
            public.work_report_due_at('2026-10-21'::date, 0, '00:00:00'::time, false) as exact_midnight_vn`,
  );
  assert.equal(new Date(rows[0].shifted_sunday).toISOString(), "2026-10-25T17:00:00.000Z");
  assert.equal(new Date(rows[0].exact_midnight_vn).toISOString(), "2026-10-20T17:00:00.000Z");
});

test("SQL validators enforce parity with TypeScript for required empty text, pattern_preset, decimal precision and field_type aggregations", async () => {
  const technicalSchema = {
    version: "work-report-schema/1.0",
    sections: [
      {
        section_key: "parity_sec",
        label: "Kiểm tra đồng bộ SQL/TS",
        description: null,
        sort_order: 10,
        fields: [
          {
            field_key: "required_note",
            section_key: "parity_sec",
            sort_order: 10,
            label: "Ghi chú bắt buộc",
            description: null,
            field_type: "text",
            required: true,
            default_value: null,
            validation: { min_length: 0, max_length: 100, pattern_preset: "none" },
            options: null,
            is_metric: false,
            metric_spec: null,
            is_dimension: false,
          },
          {
            field_key: "emp_code",
            section_key: "parity_sec",
            sort_order: 20,
            label: "Mã nhân sự",
            description: null,
            field_type: "text",
            required: true,
            default_value: null,
            validation: { min_length: 1, max_length: 20, pattern_preset: "code" },
            options: null,
            is_metric: false,
            metric_spec: null,
            is_dimension: false,
          },
          {
            field_key: "conversion_rate",
            section_key: "parity_sec",
            sort_order: 30,
            label: "Tỷ lệ chuyển đổi",
            description: null,
            field_type: "decimal",
            required: true,
            default_value: 0,
            validation: { min_value: 0, max_value: 100, decimal_places: 2, allow_zero: true },
            options: null,
            is_metric: true,
            metric_spec: {
              metric_key: "conversion_rate",
              unit: "%",
              aggregations: ["AVG", "MAX", "COUNT_VALID"],
              null_policy: "EXCLUDE_FROM_AVG",
              zero_policy: "INCLUDE_AS_ZERO",
              compatible_group: "parity_conversion_rate_v1",
            },
            is_dimension: false,
          },
          {
            field_key: "is_verified",
            section_key: "parity_sec",
            sort_order: 40,
            label: "Đã xác minh",
            description: null,
            field_type: "boolean",
            required: true,
            default_value: false,
            validation: {},
            options: null,
            is_metric: true,
            metric_spec: {
              metric_key: "is_verified",
              unit: "báo cáo",
              aggregations: ["TRUE_COUNT", "TRUE_RATE"],
              null_policy: "EXCLUDE_FROM_AVG",
              zero_policy: "INCLUDE_AS_ZERO",
              compatible_group: "parity_is_verified_v1",
            },
            is_dimension: true,
          },
        ],
      },
    ],
  };

  const validContract = buildWorkReportMetricContract(technicalSchema);

  const { rows: schemaValid } = await db.query(
    `select public.work_report_valid_template_schema($1::jsonb) as valid_schema,
            public.work_report_valid_metric_contract($1::jsonb, $2::jsonb) as valid_contract`,
    [JSON.stringify(technicalSchema), JSON.stringify(validContract)],
  );
  assert.equal(schemaValid[0].valid_schema, true);
  assert.equal(schemaValid[0].valid_contract, true);

  // 1) Invalid decimal_places (5 > 4) and invalid pattern_preset in schema are rejected by SQL
  const badDecimalSchema = structuredClone(technicalSchema);
  badDecimalSchema.sections[0].fields[2].validation.decimal_places = 5;
  const badPatternSchema = structuredClone(technicalSchema);
  badPatternSchema.sections[0].fields[1].validation.pattern_preset = "invalid_preset";

  const { rows: badSchemas } = await db.query(
    `select public.work_report_valid_template_schema($1::jsonb) as bad_decimal,
            public.work_report_valid_template_schema($2::jsonb) as bad_pattern`,
    [JSON.stringify(badDecimalSchema), JSON.stringify(badPatternSchema)],
  );
  assert.equal(badSchemas[0].bad_decimal, false, "decimal_places > 4 rejected in SQL schema validator");
  assert.equal(badSchemas[0].bad_pattern, false, "unknown pattern_preset rejected in SQL schema validator");

  // 2) Invalid aggregation for field_type (e.g., SUM on boolean) is rejected by SQL metric contract validator
  const badAggSchema = structuredClone(technicalSchema);
  badAggSchema.sections[0].fields[3].metric_spec.aggregations = ["SUM"];
  const badAggContract = buildWorkReportMetricContract(badAggSchema);
  const { rows: badMetricRows } = await db.query(
    `select public.work_report_valid_metric_contract($1::jsonb, $2::jsonb) as valid`,
    [JSON.stringify(badAggSchema), JSON.stringify(badAggContract)],
  );
  assert.equal(badMetricRows[0].valid, false, "SUM aggregation on boolean field rejected in SQL");

  // 3) Payload checks: valid payload, required empty text "", pattern_preset violation, decimal scale violation
  const validPayload = {
    required_note: "OK",
    emp_code: "NV-01",
    conversion_rate: 99.25,
    is_verified: true,
  };
  const emptyRequiredTextPayload = {
    ...validPayload,
    required_note: "",
  };
  const badPatternPayload = {
    ...validPayload,
    emp_code: "NV 01",
  };
  const badDecimalScalePayload = {
    ...validPayload,
    conversion_rate: 99.251,
  };

  const { rows: payloadChecks } = await db.query(
    `select public.work_report_valid_submission_payload($1::jsonb, $2::jsonb, '2026-10-21'::date, '2026-10-21'::date, true) as ok_payload,
            public.work_report_valid_submission_payload($1::jsonb, $3::jsonb, '2026-10-21'::date, '2026-10-21'::date, true) as empty_req_submit,
            public.work_report_valid_submission_payload($1::jsonb, $3::jsonb, '2026-10-21'::date, '2026-10-21'::date, false) as empty_req_draft,
            public.work_report_valid_submission_payload($1::jsonb, $4::jsonb, '2026-10-21'::date, '2026-10-21'::date, true) as bad_pattern,
            public.work_report_valid_submission_payload($1::jsonb, $5::jsonb, '2026-10-21'::date, '2026-10-21'::date, true) as bad_scale`,
    [
      JSON.stringify(technicalSchema),
      JSON.stringify(validPayload),
      JSON.stringify(emptyRequiredTextPayload),
      JSON.stringify(badPatternPayload),
      JSON.stringify(badDecimalScalePayload),
    ],
  );
  assert.equal(payloadChecks[0].ok_payload, true);
  assert.equal(payloadChecks[0].empty_req_submit, false, "required empty string rejected on submit");
  assert.equal(payloadChecks[0].empty_req_draft, true, "empty string allowed on draft save");
  assert.equal(payloadChecks[0].bad_pattern, false, "pattern_preset violation rejected in SQL");
  assert.equal(payloadChecks[0].bad_scale, false, "decimal precision > decimal_places rejected in SQL");
});

test("F2 review, delegation, effective_report_review_scopes and finality lifecycle", async () => {
  // 1) Create and publish a template with requires_review = true
  const schema = structuredClone(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);
  const metrics = buildWorkReportMetricContract(schema);
  const { rows: tplRows } = await db.query(
    `select public.work_report_create_template(
       $1::uuid, $2::uuid, 'RECRUITMENT_DAILY_F2_REV', 'Báo cáo F2 cần duyệt',
       'Kiểm thử luồng duyệt và ủy quyền F2', 'DAILY', $3::jsonb, $4::jsonb, $5
     ) as result`,
    [ADMIN.auth, ADMIN.app, JSON.stringify(schema), JSON.stringify(metrics), KEY("f2_tpl_create")],
  );
  const tplId = tplRows[0].result.template_id;
  const verId = tplRows[0].result.draft_version_id;
  await db.query(
    `update public.work_report_template_versions set requires_review = true where version_id = $1::uuid`,
    [verId],
  );
  await db.query(
    `select public.work_report_publish_template($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5)`,
    [ADMIN.auth, ADMIN.app, tplId, verId, KEY("f2_tpl_pub")],
  );

  // 2) Grant ADMIN report_review and report_delegate so ADMIN can review and delegate
  for (const cap of ["report_review", "report_delegate"]) {
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)
       on conflict do nothing`,
      [ADMIN.app, cap],
    );
  }

  // Ensure LEADER_A is active Team Leader on TEAM_A
  const { rows: teamARows } = await db.query(
    `select version from public.teams where team_id = $1::uuid`,
    [TEAM_A],
  );
  const { rows: currentLeaderARows } = await db.query(
    `select assignment_id from public.direct_entry_team_leader_assignments where team_id = $1::uuid and is_current`,
    [TEAM_A],
  );
  if (currentLeaderARows.length === 0) {
    await db.query(
      `select public.direct_entry_designate_team_leader(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-02-01'::date, $5, 'Ensure Leader A for F2', $6
       )`,
      [ADMIN.auth, ADMIN.app, TEAM_A, LEADER_A.app, teamARows[0].version, KEY("f2_leader_a")],
    );
  }

  // 3) Create assignment on TEAM_A and materialize for 2099-11-02
  await db.query(
    `select public.work_report_create_assignment(
       $1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null,
       'DAILY', true, 0, '23:59:00'::time, false, '2099-11-01'::date, '2099-11-05'::date, $5
     )`,
    [LEADER_A.auth, LEADER_A.app, tplId, TEAM_A, KEY("f2_assign_a")],
  );
  await db.query(
    `select public.work_report_ensure_obligations_for_window($1::uuid, $2::uuid, '2099-11-02'::date)`,
    [LEADER_A.auth, LEADER_A.app],
  );

  const { rows: obRows } = await db.query(
    `select obligation_id, assignee_app_user_id from public.work_report_obligations
      where template_id = $1::uuid and period_key = '2099-11-02'`,
    [tplId],
  );
  const staffA1Ob = obRows.find((r) => r.assignee_app_user_id === STAFF_A1.app);
  const leaderAOb = obRows.find((r) => r.assignee_app_user_id === LEADER_A.app);
  assert.ok(staffA1Ob && leaderAOb);

  const makePayload = (calls) => ({
    calls_made: calls,
    interested_candidates: 4,
    workers_started: 2,
    notes: "Báo cáo F2",
  });

  // 4) Submit STAFF_A1 and LEADER_A -> both enter PENDING_REVIEW with provisional metrics
  const { rows: subA1Rows } = await db.query(
    `select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5) as result`,
    [STAFF_A1.auth, STAFF_A1.app, staffA1Ob.obligation_id, JSON.stringify(makePayload(15)), KEY("f2_sub_a1")],
  );
  const subA1 = subA1Rows[0].result;
  assert.equal(subA1.state, "PENDING_REVIEW");

  const { rows: subLeaderRows } = await db.query(
    `select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5) as result`,
    [LEADER_A.auth, LEADER_A.app, leaderAOb.obligation_id, JSON.stringify(makePayload(25)), KEY("f2_sub_la")],
  );
  const subLeader = subLeaderRows[0].result;
  assert.equal(subLeader.state, "PENDING_REVIEW");

  // 5) Self-review by LEADER_A is rejected with WORK_REPORT_SELF_REVIEW_FORBIDDEN
  await assert.rejects(
    db.query(
      `select public.work_report_decide_review($1::uuid, $2::uuid, $3::uuid, 'APPROVED', null, $4, $5)`,
      [LEADER_A.auth, LEADER_A.app, leaderAOb.obligation_id, subLeader.version, KEY("f2_self_rev")],
    ),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_SELF_REVIEW_FORBIDDEN"),
  );

  // 6) LEADER_A rejects STAFF_A1 with reason -> state REJECTED; STAFF_A1 sees latest_review_event without reviewer_user_id
  const { rows: rejRows } = await db.query(
    `select public.work_report_decide_review($1::uuid, $2::uuid, $3::uuid, 'REJECTED', 'Cần bổ sung số liệu', $4, $5) as result`,
    [LEADER_A.auth, LEADER_A.app, staffA1Ob.obligation_id, subA1.version, KEY("f2_rej_a1")],
  );
  assert.equal(rejRows[0].result.state, "REJECTED");

  // Expire due_at to prove REJECTED submission can be amended and resubmitted after due_at without manual reopen
  await db.query(
    `update public.work_report_obligations set due_at = '2020-01-01T00:00:00Z' where obligation_id = $1::uuid`,
    [staffA1Ob.obligation_id],
  );

  const { rows: detailAfterRej } = await db.query(
    `select public.work_report_get_submission($1::uuid, $2::uuid, $3::uuid) as result`,
    [STAFF_A1.auth, STAFF_A1.app, staffA1Ob.obligation_id],
  );
  assert.equal(detailAfterRej[0].result.latest_review_event.decision, "REJECTED");
  assert.equal(detailAfterRej[0].result.latest_review_event.reason, "Cần bổ sung số liệu");
  assert.equal("reviewer_user_id" in detailAfterRej[0].result.latest_review_event, false);

  const { rows: resubRows } = await db.query(
    `select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $6) as result`,
    [STAFF_A1.auth, STAFF_A1.app, staffA1Ob.obligation_id, JSON.stringify(makePayload(18)), rejRows[0].result.version, KEY("f2_resub_a1")],
  );
  assert.equal(resubRows[0].result.state, "PENDING_REVIEW");
  assert.equal(resubRows[0].result.revision_no, 2);
  const { rows: detailAfterResub } = await db.query(
    `select public.work_report_get_submission($1::uuid, $2::uuid, $3::uuid) as result`,
    [STAFF_A1.auth, STAFF_A1.app, staffA1Ob.obligation_id],
  );
  assert.equal(detailAfterResub[0].result.submission.has_post_deadline_amendment, true);

  // 7) Delegation of report_review and effective_report_review_scopes projection in direct_entry_resolve_actor_context
  const { rows: delRows } = await db.query(
    `select public.work_report_create_delegation(
       $1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'team', $5::uuid,
       (now() - interval '1 hour'), (now() + interval '1 day'), $6
     ) as result`,
    [ADMIN.auth, ADMIN.app, STAFF_A2.app, tplId, TEAM_A, KEY("f2_del_a2")],
  );
  const delegationId = delRows[0].result.delegation_id;

  const { rows: resolvedDelegateCtx } = await db.query(
    `select public.direct_entry_resolve_actor_context($1::uuid) as ctx`,
    [STAFF_A2.auth],
  );
  assert.equal(resolvedDelegateCtx[0].ctx.app_user_id, STAFF_A2.app);
  assert.ok(
    Array.isArray(resolvedDelegateCtx[0].ctx.effective_report_review_scopes) &&
      resolvedDelegateCtx[0].ctx.effective_report_review_scopes.some(
        (s) => s.kind === "team" && s.team_id === TEAM_A,
      ),
    "delegate without direct report_review receives effective_report_review_scopes from active delegation",
  );

  // Delegate STAFF_A2 approves STAFF_A1's resubmitted report
  const { rows: delApproveRows } = await db.query(
    `select public.work_report_decide_review($1::uuid, $2::uuid, $3::uuid, 'APPROVED', null, $4, $5) as result`,
    [STAFF_A2.auth, STAFF_A2.app, staffA1Ob.obligation_id, resubRows[0].result.version, KEY("f2_del_app")],
  );
  assert.equal(delApproveRows[0].result.state, "APPROVED");
  assert.equal(delApproveRows[0].result.delegation_id, delegationId);

  // Analytics finality check: final = 18 (only approved STAFF_A1 rev 2), provisional_included = 43 (18 + pending LEADER_A 25)
  const { rows: ovFinal } = await db.query(
    `select public.work_report_analytics_overview($1::uuid, $2::uuid, $3::uuid, null, '2099-11-02'::date, '2099-11-02'::date, null, null, 'final') as result`,
    [ADMIN.auth, ADMIN.app, tplId],
  );
  const { rows: ovProv } = await db.query(
    `select public.work_report_analytics_overview($1::uuid, $2::uuid, $3::uuid, null, '2099-11-02'::date, '2099-11-02'::date, null, null, 'provisional_included') as result`,
    [ADMIN.auth, ADMIN.app, tplId],
  );
  assert.equal(ovFinal[0].result.metrics.find((m) => m.metric_key === "calls_made").sum_value, 18);
  assert.equal(ovProv[0].result.metrics.find((m) => m.metric_key === "calls_made").sum_value, 43);

  // Reconciliation passes with zero discrepancies across APPROVED, REJECTED (historical), and PENDING_REVIEW revisions
  const { rows: reconRows } = await db.query(
    `select public.work_report_reconcile_metric_projection($1::uuid, $2::uuid, $3::uuid) as result`,
    [ADMIN.auth, ADMIN.app, tplId],
  );
  assert.equal(reconRows[0].result.ok, true);
  assert.equal(reconRows[0].result.total_discrepancy_count, 0);
});
