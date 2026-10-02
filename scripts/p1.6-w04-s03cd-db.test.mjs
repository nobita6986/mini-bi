import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

const migrations = [
  "20261002170000_p1_6_direct_entry_foundation.sql",
  "20261003170000_p1_6_w03_submission_noop_guard.sql",
  "20261003180000_p1_6_w04_s03a_actor_context.sql",
  "20261003200000_p1_6_w04_s03cd_catalog_drafts.sql",
];
const ids = {
  subjectA: "91100000-0000-4000-8000-000000000001",
  subjectB: "91100000-0000-4000-8000-000000000002",
  userA: "92100000-0000-4000-8000-000000000001",
  userB: "92100000-0000-4000-8000-000000000002",
  recruiter: "93100000-0000-4000-8000-000000000001",
  ambiguousRecruiter: "93100000-0000-4000-8000-000000000002",
  ambiguousTeamRecruiter: "93100000-0000-4000-8000-000000000003",
  team: "94100000-0000-4000-8000-000000000001",
  inactiveTeam: "94100000-0000-4000-8000-000000000002",
};

async function buildDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
  `);
  for (const migration of migrations) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), "utf8"));
  }
  return db;
}

async function seed(db) {
  await db.exec(`
    insert into auth.users (id) values ('${ids.subjectA}'), ('${ids.subjectB}');
    insert into public.direct_entry_app_users (app_user_id, auth_subject)
      values ('${ids.userA}', '${ids.subjectA}'), ('${ids.userB}', '${ids.subjectB}');
    insert into public.teams (team_id, code, display_name, active)
      values ('${ids.team}', 'S03CD-SYNTH', 'Synthetic Team', true),
             ('${ids.inactiveTeam}', 'S03CD-INACTIVE', 'Synthetic inactive team', false);
    insert into public.recruiters (recruiter_id, display_name)
      values ('${ids.recruiter}', 'Synthetic Recruiter A'),
             ('${ids.ambiguousRecruiter}', 'Synthetic Recruiter B'),
             ('${ids.ambiguousTeamRecruiter}', 'Synthetic Recruiter C');
    alter table public.recruiter_provider_memberships disable trigger user;
    insert into public.recruiter_provider_memberships
      (recruiter_id, provider_type, valid_from, valid_to)
      values ('${ids.recruiter}', 'hrp', '2026-01-01', '2027-01-01'),
             ('${ids.ambiguousRecruiter}', 'hrp', '2026-01-01', '2027-01-01'),
             ('${ids.ambiguousRecruiter}', 'vendor', '2026-06-01', '2026-12-01'),
             ('${ids.ambiguousTeamRecruiter}', 'hrp', '2026-01-01', '2027-01-01');
    alter table public.recruiter_provider_memberships enable trigger user;
    alter table public.recruiter_team_memberships disable trigger user;
    insert into public.recruiter_team_memberships
      (recruiter_id, team_id, valid_from, valid_to)
      values ('${ids.recruiter}', '${ids.team}', '2026-01-01', '2027-01-01'),
             ('${ids.ambiguousRecruiter}', '${ids.team}', '2026-01-01', '2027-01-01'),
             ('${ids.ambiguousTeamRecruiter}', '${ids.team}', '2026-01-01', '2027-01-01'),
             ('${ids.ambiguousTeamRecruiter}', '${ids.inactiveTeam}', '2026-06-01', '2026-12-01');
    alter table public.recruiter_team_memberships enable trigger user;
    insert into public.direct_entry_projects (project_id, display_name, active)
      values ('project_s03cd_active', 'Synthetic active project', true),
             ('project_s03cd_inactive', 'Synthetic inactive project', false);
    insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)
      values
        ('${ids.userA}', 'entry_create', '2020-01-01'),
        ('${ids.userA}', 'submission_create', '2020-01-01'),
        ('${ids.userA}', 'entry_own', '2020-01-01'),
        ('${ids.userB}', 'entry_own', '2020-01-01');
    insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from)
      values ('${ids.userA}', 'own', '2020-01-01'),
             ('${ids.userB}', 'own', '2020-01-01');
  `);
}

async function rpc(db, name, sql, args) {
  await db.exec("begin; set local role service_role;");
  try {
    const result = await db.query(sql, args);
    await db.exec("commit;");
    return result.rows[0][name];
  } catch (error) {
    await db.exec("rollback;");
    throw error;
  }
}

test("S03CD catalog, own drafts, update OCC/idempotency, PII bounds and ACL", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const catalog = await rpc(
      db,
      "catalog",
      "select public.direct_entry_input_catalog($1::uuid, $2::uuid, $3::date) as catalog",
      [ids.subjectA, ids.userA, "2026-10-15"],
    );
    assert.deepEqual(catalog.projects.map(({ project_id }) => project_id), ["project_s03cd_active"]);
    assert.deepEqual(catalog.recruiters.map(({ recruiter_id }) => recruiter_id), [ids.recruiter]);
    assert.equal(catalog.recruiters[0].provider_type, "hrp");
    assert.equal(catalog.recruiters[0].team_id, ids.team);
    assert.equal(JSON.stringify(catalog).includes("national_id"), false);
    assert.equal(JSON.stringify(catalog).includes("phone"), false);
    assert.equal(JSON.stringify(catalog).includes("email"), false);

    const outsideDate = await rpc(
      db,
      "catalog",
      "select public.direct_entry_input_catalog($1::uuid, $2::uuid, $3::date) as catalog",
      [ids.subjectA, ids.userA, "2027-02-01"],
    );
    assert.deepEqual(outsideDate.recruiters, []);

    const created = await rpc(
      db,
      "created",
      `select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as created`,
      [
        ids.subjectA,
        ids.userA,
        JSON.stringify([{
          project_id: "project_s03cd_active",
          first_work_date: "2026-10-15",
          employee_code: "hrp-2026-900001",
          worker_details: {
            display_name: "Synthetic Before",
            date_of_birth: { state: "omitted" },
            national_id: { state: "provided", value: "SYNTHETIC-ONLY" },
            address: { state: "unknown" },
            phone: { state: "intentionally_blank" },
          },
          recruiter_id: ids.recruiter,
          labor_type: "TEMPORARY",
        }]),
        "s03cd-create-key",
      ],
    );

    const draftsA = await rpc(
      db,
      "drafts",
      "select public.direct_entry_list_own_drafts($1::uuid, $2::uuid) as drafts",
      [ids.subjectA, ids.userA],
    );
    const draftsB = await rpc(
      db,
      "drafts",
      "select public.direct_entry_list_own_drafts($1::uuid, $2::uuid) as drafts",
      [ids.subjectB, ids.userB],
    );
    assert.equal(draftsA.drafts.length, 1);
    assert.equal(draftsB.drafts.length, 0);
    assert.equal(draftsA.drafts[0].worker_display_name, "Synthetic Before");
    assert.equal(JSON.stringify(draftsA).includes("SYNTHETIC-ONLY"), false);
    assert.equal(JSON.stringify(draftsA).includes("national_id"), false);
    assert.equal(JSON.stringify(draftsA).includes("audit"), false);
    assert.equal(JSON.stringify(draftsA).includes("document"), false);

    const patch = {
      project_id: "project_s03cd_active",
      first_work_date: "2026-10-15",
      employee_code: "hrp-2026-900001",
      worker_details: { display_name: "Synthetic After" },
      recruiter_id: ids.recruiter,
      labor_type: "TEMPORARY",
    };
    const updateArgs = [
      ids.subjectA, ids.userA, created.entry_ids[0], 1, JSON.stringify(patch), "s03cd-update-key",
    ];
    const updated = await rpc(
      db,
      "updated",
      `select public.direct_entry_update_draft_row(
        $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, $6::text
      ) as updated`,
      updateArgs,
    );
    assert.equal(updated.version, 2);
    assert.equal(updated.submission_version, 2);
    const replay = await rpc(
      db,
      "updated",
      `select public.direct_entry_update_draft_row(
        $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, $6::text
      ) as updated`,
      updateArgs,
    );
    assert.deepEqual(replay, updated);

    await assert.rejects(
      rpc(
        db,
        "updated",
        `select public.direct_entry_update_draft_row(
          $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, $6::text
        ) as updated`,
        [ids.subjectA, ids.userA, created.entry_ids[0], 1,
          JSON.stringify({ ...patch, worker_details: { display_name: "Different Synthetic Name" } }),
          "s03cd-update-key"],
      ),
      { code: "22023" },
    );
    await assert.rejects(
      rpc(
        db,
        "updated",
        `select public.direct_entry_update_draft_row(
          $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, $6::text
        ) as updated`,
        [ids.subjectA, ids.userA, created.entry_ids[0], 1, JSON.stringify(patch), "s03cd-stale-key"],
      ),
      { code: "40001" },
    );

    const { rows: preservedWorker } = await db.query(
      "select worker_details from public.direct_entries where entry_id = $1",
      [created.entry_ids[0]],
    );
    assert.equal(preservedWorker[0].worker_details.display_name, "Synthetic After");
    assert.equal(preservedWorker[0].worker_details.national_id.value, "SYNTHETIC-ONLY");
    const refreshed = await rpc(
      db,
      "drafts",
      "select public.direct_entry_list_own_drafts($1::uuid, $2::uuid) as drafts",
      [ids.subjectA, ids.userA],
    );
    assert.equal(refreshed.drafts[0].worker_display_name, "Synthetic After");
    assert.equal(refreshed.drafts[0].entry_version, 2);

    const { rows: aclRows } = await db.query(`
      select
        has_function_privilege('service_role',
          'public.direct_entry_input_catalog(uuid,uuid,date)', 'execute') as catalog_service,
        has_function_privilege('anon',
          'public.direct_entry_input_catalog(uuid,uuid,date)', 'execute') as catalog_anon,
        has_function_privilege('authenticated',
          'public.direct_entry_input_catalog(uuid,uuid,date)', 'execute') as catalog_authenticated,
        has_function_privilege('service_role',
          'public.direct_entry_list_own_drafts(uuid,uuid)', 'execute') as drafts_service,
        has_function_privilege('anon',
          'public.direct_entry_list_own_drafts(uuid,uuid)', 'execute') as drafts_anon,
        has_function_privilege('service_role',
          'public.direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)', 'execute') as update_service,
        has_function_privilege('authenticated',
          'public.direct_entry_update_draft_row(uuid,uuid,uuid,integer,jsonb,text)', 'execute') as update_authenticated,
        (select bool_or(has_table_privilege('service_role', quote_ident(table_name), 'select')
          or has_table_privilege('service_role', quote_ident(table_name), 'insert')
          or has_table_privilege('service_role', quote_ident(table_name), 'update')
          or has_table_privilege('service_role', quote_ident(table_name), 'delete'))
           from information_schema.tables
          where table_schema = 'public'
            and table_name in (
              'direct_entries', 'direct_entry_submissions', 'direct_entry_audit_events',
              'direct_entry_revisions', 'direct_entry_rpc_idempotency',
              'recruiter_provider_memberships', 'recruiter_team_memberships'
            )) as table_dml
    `);
    assert.deepEqual(aclRows[0], {
      catalog_service: true,
      catalog_anon: false,
      catalog_authenticated: false,
      drafts_service: true,
      drafts_anon: false,
      update_service: true,
      update_authenticated: false,
      table_dml: false,
    });
    const { rows: functionRows } = await db.query(`
      select p.proname, p.prosecdef,
        coalesce(array_to_string(p.proconfig, ','), '') as function_config,
        coalesce(bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE'), false) as public_execute
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        left join lateral aclexplode(coalesce(
          p.proacl, acldefault('f'::"char", p.proowner)
        )) a on true
       where n.nspname = 'public'
         and p.proname in (
           'direct_entry_input_catalog', 'direct_entry_list_own_drafts',
           'direct_entry_update_draft_row'
         )
       group by p.oid
    `);
    assert.equal(functionRows.length, 3);
    assert.equal(functionRows.every((fn) =>
      fn.prosecdef && fn.function_config.includes("search_path=pg_catalog, public") &&
      !fn.public_execute
    ), true);
    const { rows: rpcRows } = await db.query(`
      select count(*)::int as count
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname like 'direct_entry_%'
         and has_function_privilege('service_role', p.oid, 'execute')
    `);
    assert.equal(rpcRows[0].count, 20);
  } finally {
    await db.close();
  }
});
