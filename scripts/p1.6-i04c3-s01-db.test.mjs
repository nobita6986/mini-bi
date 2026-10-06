import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const IDS = {
  auth: "91600000-0000-4000-8000-000000000001",
  user: "92600000-0000-4000-8000-000000000001",
  readAuth: "91600000-0000-4000-8000-000000000002",
  readUser: "92600000-0000-4000-8000-000000000002",
  teamAuth: "91600000-0000-4000-8000-000000000003",
  teamUser: "92600000-0000-4000-8000-000000000003",
  paymentAuth: "91600000-0000-4000-8000-000000000004",
  paymentUser: "92600000-0000-4000-8000-000000000004",
  outsideAuth: "91600000-0000-4000-8000-000000000005",
  outsideUser: "92600000-0000-4000-8000-000000000005",
  disabledAuth: "91600000-0000-4000-8000-000000000006",
  disabledUser: "92600000-0000-4000-8000-000000000006",
  team: "94600000-0000-4000-8000-000000000001",
  outsideTeam: "94600000-0000-4000-8000-000000000002",
  recruiter: "93600000-0000-4000-8000-000000000001",
  inactiveRecruiter: "93600000-0000-4000-8000-000000000002",
  noTeamRecruiter: "93600000-0000-4000-8000-000000000003",
  noProviderRecruiter: "93600000-0000-4000-8000-000000000004",
  bank: "bank_i04c3_synthetic",
  inactiveBank: "bank_i04c3_inactive",
};
const CONTRACT = "worker-profile/1.0";
const RPC = `select public.direct_entry_create_full_profile_batch(
  $1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text
) as result`;
const GENERATED_RPC = `select public.direct_entry_create_full_profile_batch_v2(
  $1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text
) as result`;

async function database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.equal(migrations.length, 44, "P2-W04B migration #44 rebaselines the cutoff; PGlite must apply all 44 migrations");
  for (const name of migrations) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  await db.exec(`
    insert into auth.users(id) values
      ('${IDS.auth}'), ('${IDS.readAuth}'), ('${IDS.teamAuth}'), ('${IDS.paymentAuth}'),
      ('${IDS.outsideAuth}'), ('${IDS.disabledAuth}');
    insert into public.direct_entry_app_users(app_user_id, auth_subject, enabled) values
      ('${IDS.user}', '${IDS.auth}', true),
      ('${IDS.readUser}', '${IDS.readAuth}', true),
      ('${IDS.teamUser}', '${IDS.teamAuth}', true),
      ('${IDS.paymentUser}', '${IDS.paymentAuth}', true),
      ('${IDS.outsideUser}', '${IDS.outsideAuth}', true),
      ('${IDS.disabledUser}', '${IDS.disabledAuth}', false);
    insert into public.teams(team_id, code, display_name)
      values ('${IDS.team}', 'I04C3-SYNTH', 'Synthetic I04C3 Team'),
             ('${IDS.outsideTeam}', 'I04C3-OUTSIDE', 'Synthetic outside team');
    insert into public.recruiters(recruiter_id, display_name, active)
      values ('${IDS.recruiter}', 'Synthetic I04C3 Recruiter', true),
             ('${IDS.inactiveRecruiter}', 'Synthetic Inactive Recruiter', false),
             ('${IDS.noTeamRecruiter}', 'Synthetic Recruiter Without Team', true),
             ('${IDS.noProviderRecruiter}', 'Synthetic Recruiter Without Provider', true);
    insert into public.recruiter_provider_memberships
      (recruiter_id, provider_type, valid_from)
      values ('${IDS.recruiter}', 'hrp', '2020-01-01'),
             ('${IDS.noTeamRecruiter}', 'vendor', '2020-01-01');
    insert into public.recruiter_team_memberships
      (recruiter_id, team_id, valid_from)
      values ('${IDS.recruiter}', '${IDS.team}', '2020-01-01'),
             ('${IDS.noProviderRecruiter}', '${IDS.team}', '2020-01-01');
    insert into public.direct_entry_projects(project_id, display_name)
      values ('project_i04c3_synthetic', 'Synthetic I04C3 Project');
    insert into public.direct_entry_project_manager_assignments(project_id, manager_recruiter_id)
      values ('project_i04c3_synthetic', '${IDS.recruiter}');
    insert into public.direct_entry_app_user_recruiter_links
      (app_user_id, recruiter_id, verified, valid_from)
      values ('${IDS.user}', '${IDS.recruiter}', true, '2020-01-01');
    insert into public.direct_entry_banks(bank_id, display_name, active) values
      ('${IDS.bank}', 'Synthetic Active Bank', true),
      ('${IDS.inactiveBank}', 'Synthetic Inactive Bank', false);
    insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from) values
      ('${IDS.user}', 'entry_create', '2020-01-01'),
      ('${IDS.user}', 'submission_create', '2020-01-01'),
      ('${IDS.user}', 'entry_own', '2020-01-01'),
      ('${IDS.user}', 'employment_status.apply', '2020-01-01'),
      ('${IDS.user}', 'payment_view', '2020-01-01'),
      ('${IDS.user}', 'payment_edit', '2020-01-01'),
      ('${IDS.user}', 'pii_view', '2020-01-01'),
      ('${IDS.readUser}', 'entry_admin', '2020-01-01'),
      ('${IDS.teamUser}', 'entry_team', '2020-01-01'),
      ('${IDS.teamUser}', 'employment_status.apply', '2020-01-01'),
      ('${IDS.paymentUser}', 'entry_admin', '2020-01-01'),
      ('${IDS.paymentUser}', 'payment_view', '2020-01-01'),
      ('${IDS.outsideUser}', 'entry_team', '2020-01-01');
    insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, team_id, valid_from) values
      ('${IDS.user}', 'own', null, '2020-01-01'),
      ('${IDS.readUser}', 'all', null, '2020-01-01'),
      ('${IDS.teamUser}', 'team', '${IDS.team}', '2020-01-01'),
      ('${IDS.paymentUser}', 'all', null, '2020-01-01'),
      ('${IDS.outsideUser}', 'team', '${IDS.outsideTeam}', '2020-01-01');
  `);
  return db;
}

async function rpc(db, rows, key) {
  await db.exec("begin; set local role service_role;");
  try {
    const result = await db.query(RPC, [
      IDS.auth, IDS.user, CONTRACT, JSON.stringify(rows), key,
    ]);
    await db.exec("commit;");
    return result.rows[0].result;
  } catch (error) {
    await db.exec("rollback;");
    throw error;
  }
}

async function generatedRpc(db, rows, key) {
  await db.exec("begin; set local role service_role;");
  try {
    const result = await db.query(GENERATED_RPC, [
      IDS.auth, IDS.user, "worker-profile/1.1", JSON.stringify(rows), key,
    ]);
    await db.exec("commit;");
    return result.rows[0].result;
  } catch (error) {
    await db.exec("rollback;");
    throw error;
  }
}

async function listDrafts(db, authSubject, appUserId) {
  await db.exec("begin; set local role service_role;");
  try {
    const result = await db.query(
      "select public.direct_entry_list_own_drafts($1::uuid,$2::uuid) as result",
      [authSubject, appUserId],
    );
    await db.exec("commit;");
    return result.rows[0].result;
  } catch (error) {
    await db.exec("rollback;");
    throw error;
  }
}

function row(index, overrides = {}) {
  const suffix = String(index).padStart(6, "0");
  return {
    project_id: "project_i04c3_synthetic",
    first_work_date: "2020-01-01",
    employee_code: `hrp-2020-${suffix}`,
    recruiter_id: IDS.recruiter,
    labor_type: "TEMPORARY",
    display_name: `Synthetic Worker ${suffix}`,
    worker_details: {
      gender: { state: "provided", value: "OTHER" },
      date_of_birth: { state: "omitted" },
      national_id: { state: "omitted" },
      national_id_issued_at: { state: "omitted" },
      national_id_issued_place: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
    general_note: { state: "omitted" },
    payment: null,
    employment: null,
    ...overrides,
  };
}

function generatedRow(index, overrides = {}) {
  const { employee_code: _employeeCode, provider_type, ...base } = row(index, overrides);
  void _employeeCode;
  return { ...base, provider_type: provider_type ?? "hrp" };
}

async function count(db, table) {
  const { rows } = await db.query(`select count(*)::integer as count from public.${table}`);
  return rows[0].count;
}

async function tableState(db, table) {
  const { rows } = await db.query(
    `select count(*)::integer as count, md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' ` +
    `order by to_jsonb(t)::text), '')) as fingerprint from public.${table} t`,
  );
  return rows[0];
}

async function tableStates(db, tables) {
  const result = {};
  for (const table of tables) result[table] = await tableState(db, table);
  return result;
}

test("migration #39 generates employee codes transactionally and replays idempotently", async () => {
  const db = await database();
  try {
    const key = "91600000-0000-4000-8000-000000000201";
    const rows = [
      generatedRow(201, { payment: { state: "provided", account_number: "000012340001" } }),
      generatedRow(202),
    ];
    const first = await generatedRpc(db, rows, key);
    assert.deepEqual(first.employee_codes, ["hrp-2020-000001", "hrp-2020-000002"]);
    assert.equal(first.replayed, false);
    const counter = await db.query(
      "select last_sequence from public.direct_entry_employee_code_counters where employee_year=2020",
    );
    assert.equal(counter.rows[0].last_sequence, 2);
    const savedAccount = await db.query(
      "select account_number from public.direct_entry_payments where entry_id=$1",
      [first.entry_ids[0]],
    );
    assert.equal(savedAccount.rows[0].account_number, "000012340001");

    const replay = await generatedRpc(db, rows, key);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.employee_codes, first.employee_codes);
    assert.deepEqual(replay.entry_ids, first.entry_ids);
    const unchangedCounter = await db.query(
      "select last_sequence from public.direct_entry_employee_code_counters where employee_year=2020",
    );
    assert.equal(unchangedCounter.rows[0].last_sequence, 2);

    await assert.rejects(
      generatedRpc(db, [generatedRow(203)], key),
      (error) => error.code === "22023",
    );
    await assert.rejects(
      generatedRpc(db, [generatedRow(204, { provider_type: "vendor" })],
        "91600000-0000-4000-8000-000000000202"),
      (error) => error.message === "RECRUITER_MEMBERSHIP_INVALID",
    );
    const afterRejected = await db.query(
      "select last_sequence from public.direct_entry_employee_code_counters where employee_year=2020",
    );
    assert.equal(afterRejected.rows[0].last_sequence, 2);
    const tablePrivileges = await db.query(
      "select c.relrowsecurity, c.relforcerowsecurity, " +
      "has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as service_dml, " +
      "has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as anon_dml, " +
      "has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as auth_dml " +
      "from pg_class c where c.oid='public.direct_entry_employee_code_counters'::regclass",
    );
    assert.deepEqual(tablePrivileges.rows[0], {
      relrowsecurity: true, relforcerowsecurity: true, service_dml: false,
      anon_dml: false, auth_dml: false,
    });
    const rpcPrivileges = await db.query(
      "select p.prosecdef, p.proconfig, " +
      "has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec, " +
      "has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec, " +
      "has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec " +
      "from pg_proc p where p.oid=" +
      "'public.direct_entry_create_full_profile_batch_v2(uuid,uuid,text,jsonb,text)'::regprocedure",
    );
    assert.deepEqual(rpcPrivileges.rows[0], {
      prosecdef: true,
      proconfig: ["search_path=pg_catalog, public"],
      service_exec: true,
      anon_exec: false,
      auth_exec: false,
    });
  } finally {
    await db.close();
  }
});

test("migration #39 keeps the source-derived function inventory and service boundary aligned", async () => {
  const db = await database();
  try {
    const result = await db.query(`
      select count(distinct p.proname)::integer as total,
        count(distinct p.proname) filter (
          where has_function_privilege('service_role', p.oid, 'EXECUTE')
        )::integer as service_role,
        count(distinct p.proname) filter (
          where not has_function_privilege('service_role', p.oid, 'EXECUTE')
        )::integer as internal,
        count(*) filter (
          where not has_function_privilege('service_role', p.oid, 'EXECUTE')
            and (has_function_privilege('anon', p.oid, 'EXECUTE')
              or has_function_privilege('authenticated', p.oid, 'EXECUTE')
              or exists (
                select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'
              ))
        )::integer as exposed_internal
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'direct_entry_%'
    `);
    // P2-W04A migration #40 added 8 new public.direct_entry_reporting_*
    // helpers (cutoff, source_id, dim_key, recruiter_alias_key,
    // recruiter_provider_key, employment_key, pre_cutover_blocker_count,
    // reconciliation_totals). All are GRANT EXECUTE to service_role so the
    // runtime can call them (no public RPC exposure). Pre-cutover inventory
    // was 69 (31 service + 38 internal); #40 adds 8 service helpers and
    // W07B adds 3 private scope helpers/wrapped implementations. The
    // exposed_internal counter stays at 0
    // because no function is granted to anon/authenticated/public.
    assert.deepEqual(result.rows[0], {
      total: 80,
      service_role: 39,
      internal: 41,
      exposed_internal: 0,
    });
  } finally {
    await db.close();
  }
});

test("migration #36 installs full-profile boundary and atomic batch semantics", async () => {
  const db = await database();
  try {
    const inventory = await db.query(`
      select p.proname, p.prosecdef, p.proconfig, r.rolname as owner
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        join pg_roles r on r.oid = p.proowner
       where n.nspname = 'public'
         and p.proname in (
           'direct_entry_create_full_profile_batch',
           'direct_entry_read_projection',
           'direct_entry_valid_worker_details'
         )
    `);
    assert.equal(inventory.rows.length, 3);
    for (const functionInfo of inventory.rows.filter((item) =>
      item.proname !== "direct_entry_valid_worker_details"
    )) {
      assert.equal(functionInfo.prosecdef, true);
      assert.ok(functionInfo.proconfig.includes("search_path=pg_catalog, public"));
      assert.equal(await db.query(
        "select has_function_privilege('service_role', $1, 'EXECUTE') as allowed",
        [`public.${functionInfo.proname}(${functionInfo.proname === "direct_entry_read_projection"
          ? "uuid, uuid, uuid" : "uuid, uuid, text, jsonb, text"})`],
      ).then((result) => result.rows[0].allowed), true);
    }
    assert.equal(await db.query(
      "select has_function_privilege('anon', " +
      "'public.direct_entry_create_full_profile_batch(uuid, uuid, text, jsonb, text)', 'EXECUTE') as allowed",
    ).then((result) => result.rows[0].allowed), false);
    const listBoundary = await db.query(`
      select p.prosecdef, p.proconfig,
        has_function_privilege('service_role',
          'public.direct_entry_list_own_drafts(uuid,uuid)', 'EXECUTE') as service_exec,
        has_function_privilege('anon',
          'public.direct_entry_list_own_drafts(uuid,uuid)', 'EXECUTE') as anon_exec,
        has_function_privilege('authenticated',
          'public.direct_entry_list_own_drafts(uuid,uuid)', 'EXECUTE') as auth_exec,
        has_function_privilege('service_role',
          'public.direct_entry_draft_profile_field(jsonb,boolean)', 'EXECUTE') as helper_service_exec
      from pg_proc p
      where p.oid = 'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure
    `);
    assert.deepEqual(listBoundary.rows[0], {
      prosecdef: true,
      proconfig: ["search_path=pg_catalog, public"],
      service_exec: true,
      anon_exec: false,
      auth_exec: false,
      helper_service_exec: false,
    });
    for (const signature of [
      "public.direct_entry_valid_worker_details(jsonb)",
      "public.direct_entry_entry_snapshot(uuid)",
    ]) {
      const access = await db.query(
        "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_exec," +
        " has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon_exec," +
        " has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth_exec," +
        " exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a" +
        " where a.grantee=0 and a.privilege_type='EXECUTE') as public_exec" +
        " from pg_proc p where p.oid=$1::regprocedure",
        [signature],
      );
      assert.deepEqual(access.rows[0], {
        service_exec: false, anon_exec: false, auth_exec: false, public_exec: false,
      }, signature);
    }
    for (const table of [
      "direct_entries",
      "direct_entry_submissions",
      "direct_entry_payments",
      "direct_entry_revisions",
      "direct_entry_audit_events",
      "direct_entry_rpc_idempotency",
    ]) {
      const privileges = await db.query(
        "select has_table_privilege('service_role', $1, 'INSERT') as can_insert," +
        " has_table_privilege('service_role', $1, 'UPDATE') as can_update," +
        " has_table_privilege('service_role', $1, 'DELETE') as can_delete," +
        " has_table_privilege('service_role', $1, 'TRUNCATE') as can_truncate," +
        " c.relrowsecurity and c.relforcerowsecurity as forced_rls" +
        " from pg_class c where c.oid=$1::regclass",
        [`public.${table}`],
      );
      assert.deepEqual(privileges.rows[0], {
        can_insert: false, can_update: false, can_delete: false, can_truncate: false,
        forced_rls: true,
      }, table);
    }

    await db.exec("begin; set local role service_role;");
    await assert.rejects(
      db.query(
        "insert into public.direct_entry_projects(project_id, display_name) " +
        "values ('service-role-write', 'Synthetic forbidden write')",
      ),
      (error) => error.code === "42501",
    );
    await db.exec("rollback;");

    const first = row(1, {
      worker_details: {
        gender: { state: "provided", value: "MALE" },
        date_of_birth: { state: "provided", value: "1990-01-01" },
        national_id: { state: "provided", value: "001234567890" },
        national_id_issued_at: { state: "provided", value: "2010-01-01" },
        national_id_issued_place: { state: "provided", value: "Synthetic District" },
        address: { state: "provided", value: "Synthetic Address 1" },
        phone: { state: "provided", value: "09000000001" },
      },
      general_note: { state: "provided", value: "Synthetic private note" },
      payment: {
        state: "provided",
        account_number: "000012345678",
        bank_id: IDS.bank,
        bank_name: "Synthetic Bank Name",
        account_holder_name: "Synthetic Account Holder",
      },
    });
    const historicalOff = row(2, {
      employment: {
        initial_status: "OFF",
        leave_date: "2024-01-01",
        leave_reason_text: "Synthetic historical departure",
      },
    });
    const before = {
      entries: await count(db, "direct_entries"),
      revisions: await count(db, "direct_entry_revisions"),
      events: await count(db, "direct_entry_audit_events"),
      idempotency: await count(db, "direct_entry_rpc_idempotency"),
    };
    const firstResult = await rpc(
      db, [first, historicalOff], "91600000-0000-4000-8000-000000000101",
    );
    assert.equal(firstResult.replayed, false);
    assert.equal(firstResult.entry_ids.length, 2);
    const ordered = await db.query(
      "select e.employee_code from unnest($1::uuid[]) with ordinality ids(id, ordinal) " +
      "join public.direct_entries e on e.entry_id=ids.id order by ids.ordinal",
      [firstResult.entry_ids],
    );
    assert.deepEqual(ordered.rows.map((item) => item.employee_code), [
      "hrp-2020-000001", "hrp-2020-000002",
    ]);
    const persisted = await db.query(
      "select e.general_note, e.worker_details->'national_id'->>'value' as national_id, " +
      "p.account_number, s.status, s.leave_reason_text " +
      "from public.direct_entries e " +
      "left join public.direct_entry_payments p using(entry_id) " +
      "left join lateral (select status, leave_reason_text from public.direct_entry_employment_status_events " +
      "where entry_id=e.entry_id order by version desc limit 1) s on true " +
      "where e.entry_id=any($1::uuid[]) order by e.employee_code",
      [firstResult.entry_ids],
    );
    assert.equal(persisted.rows[0].national_id, "001234567890");
    assert.equal(persisted.rows[0].general_note, "Synthetic private note");
    assert.equal(persisted.rows[0].account_number, "000012345678");
    assert.equal(persisted.rows[1].status, "OFF");
    assert.equal(persisted.rows[1].leave_reason_text, "Synthetic historical departure");

    const replay = await rpc(
      db, [first, historicalOff], "91600000-0000-4000-8000-000000000101",
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.entry_ids, firstResult.entry_ids);
    await assert.rejects(
      rpc(db, [row(3)], "91600000-0000-4000-8000-000000000101"),
      (error) => error.code === "22023",
    );
    assert.equal(await count(db, "direct_entries"), before.entries + 2);
    assert.equal(await count(db, "direct_entry_revisions"), before.revisions + 2);
    assert.equal(await count(db, "direct_entry_audit_events"), before.events + 3);
    assert.equal(await count(db, "direct_entry_rpc_idempotency"), before.idempotency + 1);

    const ownerList = await listDrafts(db, IDS.auth, IDS.user);
    assert.equal(ownerList.projection_version, "direct-entry-draft-list/1");
    assert.equal(ownerList.drafts.length, 2);
    const ownerFirst = ownerList.drafts.find(({ employee_code }) => employee_code === "hrp-2020-000001");
    const ownerOff = ownerList.drafts.find(({ employee_code }) => employee_code === "hrp-2020-000002");
    assert.ok(ownerFirst && ownerOff);
    assert.equal(ownerFirst.profile.contract_version, "worker-profile/1.0");
    assert.deepEqual(ownerFirst.profile.worker_details.national_id,
      { state: "provided", value: "001234567890" });
    assert.deepEqual(ownerFirst.profile.general_note,
      { state: "provided", value: "Synthetic private note" });
    assert.deepEqual(ownerFirst.profile.payment.account_number,
      { state: "provided", value: "000012345678" });
    assert.deepEqual(ownerFirst.profile.payment.bank_name,
      { state: "provided", value: "Synthetic Bank Name" });
    assert.deepEqual(ownerOff.profile.employment.leave_reason_text,
      { state: "provided", value: "Synthetic historical departure" });
    assert.equal(Object.hasOwn(ownerFirst, "scope_kind"), false);

    const teamList = await listDrafts(db, IDS.teamAuth, IDS.teamUser);
    assert.equal(teamList.drafts.length, 2);
    const teamFirst = teamList.drafts.find(({ employee_code }) => employee_code === "hrp-2020-000001");
    const teamOff = teamList.drafts.find(({ employee_code }) => employee_code === "hrp-2020-000002");
    assert.ok(teamFirst && teamOff);
    const teamListJson = JSON.stringify(teamList);
    for (const secret of [
      "Synthetic Worker", "Synthetic private note", "Synthetic Account Holder",
      "Synthetic Bank Name", "001234567890", "000012345678", "Synthetic Address 1",
      "Synthetic historical departure",
    ]) assert.equal(teamListJson.includes(secret), false, secret);
    assert.equal(teamFirst.worker_display_name, "");
    assert.deepEqual(teamFirst.profile.worker_details.display_name,
      { state: "redacted", present: true });
    assert.deepEqual(teamFirst.profile.general_note,
      { state: "redacted", present: true });
    assert.equal(teamFirst.profile.employment.status, "UNCONFIRMED");
    assert.deepEqual(teamFirst.profile.employment.leave_date, { state: "omitted" });
    assert.deepEqual(teamOff.profile.employment.leave_reason_text,
      { state: "redacted", present: true });
    assert.deepEqual(teamFirst.profile.payment.account_number,
      { state: "masked", value: "••••••••5678" });
    assert.deepEqual(teamFirst.profile.payment.bank_name,
      { state: "redacted", present: true });
    assert.equal(teamListJson.includes("storage_key"), false);
    assert.equal(teamListJson.includes("checksum"), false);
    assert.equal(teamListJson.includes("bucket"), false);
    assert.equal(teamListJson.includes("signed_url"), false);
    assert.equal(teamListJson.includes("idempotency_key"), false);

    const paymentOnlyList = await listDrafts(db, IDS.paymentAuth, IDS.paymentUser);
    const paymentFirst = paymentOnlyList.drafts.find(({ employee_code }) =>
      employee_code === "hrp-2020-000001"
    );
    assert.ok(paymentFirst);
    assert.equal(paymentFirst.worker_display_name, "");
    assert.deepEqual(paymentFirst.profile.payment.account_number,
      { state: "provided", value: "000012345678" });
    assert.deepEqual(paymentFirst.profile.worker_details.national_id,
      { state: "redacted", present: true });
    const paymentOff = paymentOnlyList.drafts.find(({ employee_code }) =>
      employee_code === "hrp-2020-000002"
    );
    assert.ok(paymentOff);
    assert.deepEqual(paymentOff.profile.employment.leave_reason_text, { state: "omitted" });
    const adminList = await listDrafts(db, IDS.readAuth, IDS.readUser);
    assert.equal(adminList.drafts.length, 2);
    assert.deepEqual(adminList.drafts.map(({ entry_id }) => entry_id),
      [...adminList.drafts].sort((a, b) =>
        a.created_at.localeCompare(b.created_at) || a.entry_id.localeCompare(b.entry_id)
      ).map(({ entry_id }) => entry_id));
    assert.deepEqual((await listDrafts(db, IDS.outsideAuth, IDS.outsideUser)).drafts, []);
    await assert.rejects(
      listDrafts(db, IDS.disabledAuth, IDS.disabledUser),
      (error) => error.code === "42501",
    );
    await assert.rejects(
      listDrafts(db, "91600000-0000-4000-8000-000000000099",
        "92600000-0000-4000-8000-000000000099"),
      (error) => error.code === "42501",
    );

    const read = await db.query(
      "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as projection",
      [IDS.readAuth, IDS.readUser, firstResult.entry_ids[0]],
    );
    const projection = read.rows[0].projection;
    assert.deepEqual(projection.worker_details.display_name, { present: true });
    assert.deepEqual(projection.worker_details.gender, { state: "provided" });
    assert.deepEqual(projection.worker_details.national_id, { state: "provided" });
    assert.deepEqual(projection.general_note, { present: true });
    assert.equal(projection.payment.account_number, "••••••••5678");
    assert.equal(JSON.stringify(projection).includes("001234567890"), false);
    assert.equal(JSON.stringify(projection).includes("Synthetic private note"), false);

    const snapshots = await db.query(
      "select coalesce(before_snapshot::text, '') || coalesce(after_snapshot::text, '') as snapshots " +
      "from public.direct_entry_revisions where entry_id=any($1::uuid[])",
      [firstResult.entry_ids],
    );
    for (const revision of snapshots.rows) {
      for (const secret of [
        "001234567890", "09000000001", "000012345678",
        "Synthetic Account Holder", "Synthetic Address 1", "Synthetic private note",
        "Synthetic historical departure",
      ]) assert.equal(revision.snapshots.includes(secret), false);
    }

    const duplicateRows = [
      row(10, { worker_details: {
        ...row(10).worker_details,
        national_id: { state: "provided", value: "123456789" },
      } }),
      row(11, { worker_details: {
        ...row(11).worker_details,
        national_id: { state: "provided", value: "123456789" },
      } }),
    ];
    const countBeforeReject = await count(db, "direct_entries");
    await assert.rejects(
      rpc(db, duplicateRows, "91600000-0000-4000-8000-000000000102"),
      (error) => error.code === "22023",
    );
    await assert.rejects(
      rpc(db, [row(20, { worker_details: {
        ...row(20).worker_details,
        national_id: { state: "provided", value: "001234567890" },
      } })], "91600000-0000-4000-8000-000000000113"),
      (error) => error.code === "23505",
    );
    await assert.rejects(
      rpc(db, [row(1)], "91600000-0000-4000-8000-000000000103"),
      (error) => error.code === "23505",
    );
    await assert.rejects(
      rpc(db, [row(22), row(22)], "91600000-0000-4000-8000-000000000116"),
      (error) => error.code === "22023",
    );
    await assert.rejects(
      rpc(db, [row(23, { employment: {
        initial_status: "OFF", leave_date: "2024-01-01", leave_reason_text: "",
      } })], "91600000-0000-4000-8000-000000000117"),
      (error) => error.code === "22023",
    );
    await assert.rejects(
      rpc(db, [row(21), row(21)], "91600000-0000-4000-8000-000000000114"),
      (error) => error.code === "22023",
    );
    await assert.rejects(
      rpc(db, [row(12, { project_id: "project_missing" })],
        "91600000-0000-4000-8000-000000000104"),
      (error) => error.code === "22023",
    );
    await assert.rejects(
      rpc(db, [row(13, { recruiter_id: IDS.inactiveRecruiter })],
        "91600000-0000-4000-8000-000000000105"),
      (error) => error.code === "22023",
    );
    await assert.rejects(
      rpc(db, [row(24, { recruiter_id: IDS.noProviderRecruiter })],
        "91600000-0000-4000-8000-000000000118"),
      (error) => error.code === "22023",
    );
    await assert.rejects(
      rpc(db, [row(25, { recruiter_id: IDS.noTeamRecruiter })],
        "91600000-0000-4000-8000-000000000119"),
      (error) => error.code === "22023",
    );
    await assert.rejects(
      rpc(db, [row(14, { payment: {
        state: "provided", account_number: "001122", bank_id: IDS.inactiveBank,
        account_holder_name: "Synthetic Holder",
      } })], "91600000-0000-4000-8000-000000000106"),
      (error) => error.code === "22023",
    );
    assert.equal(await count(db, "direct_entries"), countBeforeReject);

    const phoneDuplicates = [
      row(15, { worker_details: {
        ...row(15).worker_details, phone: { state: "provided", value: "09000000002" },
      } }),
      row(16, { worker_details: {
        ...row(16).worker_details, phone: { state: "provided", value: "09000000002" },
      } }),
    ];
    const phoneResult = await rpc(
      db, phoneDuplicates, "91600000-0000-4000-8000-000000000107",
    );
    assert.equal(phoneResult.entry_ids.length, 2);

    const hundredRows = Array.from({ length: 100 }, (_, index) => row(index + 100));
    assert.equal((await rpc(
      db, hundredRows, "91600000-0000-4000-8000-000000000108",
    )).entry_ids.length, 100);
    await assert.rejects(
      rpc(db, [...hundredRows, row(250)], "91600000-0000-4000-8000-000000000109"),
      (error) => error.code === "22023",
    );

    await db.exec(`
      update public.direct_entry_banks set active=false;
      delete from public.direct_entry_capability_grants
       where app_user_id='${IDS.user}' and capability in ('payment_view','payment_edit');
    `);
    const noPayment = await rpc(
      db, [row(300)], "91600000-0000-4000-8000-000000000110",
    );
    assert.equal(noPayment.entry_ids.length, 1);
    const beforePaymentDenied = await count(db, "direct_entries");
    await assert.rejects(
      rpc(db, [row(302, { payment: { state: "unknown" } })],
        "91600000-0000-4000-8000-000000000120"),
      (error) => error.code === "42501",
    );
    assert.equal(await count(db, "direct_entries"), beforePaymentDenied);
    await db.exec(`
      insert into public.direct_entry_capability_grants
        (app_user_id, capability, valid_from) values
        ('${IDS.user}', 'payment_view', '2020-01-01'),
        ('${IDS.user}', 'payment_edit', '2020-01-01');
    `);
    await assert.rejects(
      rpc(db, [row(301, { payment: {
        state: "provided", account_number: "0001", bank_id: IDS.bank,
        account_holder_name: "Synthetic Holder",
      } })], "91600000-0000-4000-8000-000000000111"),
      (error) => error.code === "22023",
    );

    await db.exec(`
      create function public.i04c3_fail_audit_insert() returns trigger
      language plpgsql as $$ begin raise exception 'synthetic audit failure'; end $$;
      create trigger i04c3_fail_audit_insert before insert on public.direct_entry_audit_events
      for each row execute function public.i04c3_fail_audit_insert();
    `);
    const beforeAuditFailure = await count(db, "direct_entries");
    await assert.rejects(
      rpc(db, [row(400)], "91600000-0000-4000-8000-000000000112"),
      /synthetic audit failure/,
    );
    assert.equal(await count(db, "direct_entries"), beforeAuditFailure);
    await db.exec(`
      drop trigger i04c3_fail_audit_insert on public.direct_entry_audit_events;
      drop function public.i04c3_fail_audit_insert();
    `);

    const acceptanceTables = [
      "direct_entry_candidates",
      "direct_entries",
      "direct_entry_revisions",
      "direct_entry_submission_revisions",
      "direct_entry_audit_events",
      "direct_entry_rpc_idempotency",
      "direct_entry_document_versions",
      "direct_entry_document_events",
      "direct_entry_current_documents",
      "data_sources",
      "sync_runs",
      "daily_recruitment_breakdown",
      "direct_entry_catalog_bootstrap_runs",
      "direct_entry_projects",
      "recruiters",
      "teams",
      "recruiter_provider_memberships",
      "recruiter_team_memberships",
      "direct_entry_banks",
    ];
    const acceptanceBaseline = await tableStates(db, acceptanceTables);
    await db.exec("begin; set local role service_role;");
    try {
      const accepted = await db.query(RPC, [
        IDS.auth, IDS.user, CONTRACT, JSON.stringify([row(500)]),
        "91600000-0000-4000-8000-000000000115",
      ]);
      assert.equal(accepted.rows[0].result.entry_ids.length, 1);
      await db.exec("reset role;");
      const uncommitted = await tableStates(db, acceptanceTables);
      assert.equal(uncommitted.direct_entries.count, acceptanceBaseline.direct_entries.count + 1);
      await db.exec("rollback;");
    } catch (error) {
      await db.exec("rollback;");
      throw error;
    }
    const acceptanceAfter = await tableStates(db, acceptanceTables);
    assert.deepEqual(acceptanceAfter, acceptanceBaseline);
  } finally {
    await db.close();
  }
});

test("migration #37 accepts partial banking metadata without a catalog and preserves redaction", async () => {
  const db = await database();
  try {
    await db.exec("delete from public.direct_entry_banks;");
    assert.equal(await count(db, "direct_entry_banks"), 0);

    const inputRows = [
      row(600),
      row(601, { payment: { state: "provided", bank_name: "\u00a0 Ngân hàng Á Châu \u3000" } }),
      row(602, { payment: { state: "provided", account_number: "\u00a000001234\u3000" } }),
      row(603, { payment: { state: "provided", account_holder_name: "\ufeffSynthetic Holder\u202f" } }),
      row(604, { payment: {
        state: "provided",
        account_number: "00005678",
        bank_name: "Synthetic Bank",
        account_holder_name: "Synthetic Full Holder",
      } }),
    ];
    const result = await rpc(
      db, inputRows, "91600000-0000-4000-8000-000000000601",
    );
    assert.equal(result.entry_ids.length, 5);
    const persisted = await db.query(
      "select e.employee_code, p.account_number, p.bank_name, p.account_holder_name " +
      "from public.direct_entries e left join public.direct_entry_payments p using(entry_id) " +
      "where e.entry_id=any($1::uuid[]) order by e.employee_code",
      [result.entry_ids],
    );
    assert.deepEqual(persisted.rows, [
      { employee_code: "hrp-2020-000600", account_number: null, bank_name: null, account_holder_name: null },
      { employee_code: "hrp-2020-000601", account_number: null, bank_name: "Ngân hàng Á Châu", account_holder_name: null },
      { employee_code: "hrp-2020-000602", account_number: "00001234", bank_name: null, account_holder_name: null },
      { employee_code: "hrp-2020-000603", account_number: null, bank_name: null, account_holder_name: "Synthetic Holder" },
      { employee_code: "hrp-2020-000604", account_number: "00005678", bank_name: "Synthetic Bank", account_holder_name: "Synthetic Full Holder" },
    ]);
    assert.equal(await count(db, "direct_entry_payments"), 4);

    const authorized = await db.query(
      "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as projection",
      [IDS.auth, IDS.user, result.entry_ids[1]],
    );
    assert.deepEqual(authorized.rows[0].projection.payment, {
      state: "provided",
      account_number: null,
      bank_id: null,
      bank_name: "Ngân hàng Á Châu",
      account_holder_name: null,
      version: 1,
    });
    const masked = await db.query(
      "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as projection",
      [IDS.readAuth, IDS.readUser, result.entry_ids[2]],
    );
    assert.equal(masked.rows[0].projection.payment.account_number, "••••1234");
    assert.equal("bank_name" in masked.rows[0].projection.payment, false);
    assert.equal("account_holder_name" in masked.rows[0].projection.payment, false);

    const protectedData = [
      "00001234", "00005678", "Ngân hàng Á Châu", "Synthetic Bank",
      "Synthetic Holder", "Synthetic Full Holder",
    ];
    const revisions = await db.query(
      "select coalesce(before_snapshot::text, '') || coalesce(after_snapshot::text, '') as snapshot " +
      "from public.direct_entry_revisions where entry_id=any($1::uuid[])",
      [result.entry_ids],
    );
    for (const { snapshot } of revisions.rows) {
      for (const value of protectedData) assert.equal(snapshot.includes(value), false);
    }
    const events = await db.query(
      "select to_jsonb(a)::text as event from public.direct_entry_audit_events a " +
      "where a.resource_ref=any($1::text[])",
      [result.entry_ids],
    );
    for (const { event } of events.rows) {
      for (const value of protectedData) assert.equal(event.includes(value), false);
    }

    const baseline = {
      entries: await count(db, "direct_entries"),
      payments: await count(db, "direct_entry_payments"),
      idempotency: await count(db, "direct_entry_rpc_idempotency"),
    };
    await assert.rejects(
      rpc(db, [row(605, { payment: {
        state: "provided", account_number: "00009999", bank_id: "missing-synthetic-bank",
      } })], "91600000-0000-4000-8000-000000000602"),
      (error) => error.code === "22023",
    );
    assert.deepEqual({
      entries: await count(db, "direct_entries"),
      payments: await count(db, "direct_entry_payments"),
      idempotency: await count(db, "direct_entry_rpc_idempotency"),
    }, baseline);

    await db.exec("begin; set local role service_role;");
    try {
      await assert.rejects(
        db.query(
          "select public.direct_entry_update_payment($1::uuid,$2::uuid,$3::uuid," +
          "$4::integer,$5::integer,$6::jsonb,$7::text,$8::text)",
          [
            IDS.auth, IDS.user, result.entry_ids[2], 999, 1,
            JSON.stringify({ state: "provided" }), "Synthetic stale-version check",
            "91600000-0000-4000-8000-000000000603",
          ],
        ),
        (error) => error.code === "40001",
      );
    } finally {
      await db.exec("rollback;");
    }
  } finally {
    await db.close();
  }
});
