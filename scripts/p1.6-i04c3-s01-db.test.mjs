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
  team: "94600000-0000-4000-8000-000000000001",
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

async function database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.equal(migrations.length, 36, "PGlite must apply migrations #1-#36");
  for (const name of migrations) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  await db.exec(`
    insert into auth.users(id) values ('${IDS.auth}'), ('${IDS.readAuth}');
    insert into public.direct_entry_app_users(app_user_id, auth_subject, enabled) values
      ('${IDS.user}', '${IDS.auth}', true),
      ('${IDS.readUser}', '${IDS.readAuth}', true);
    insert into public.teams(team_id, code, display_name)
      values ('${IDS.team}', 'I04C3-SYNTH', 'Synthetic I04C3 Team');
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
      ('${IDS.readUser}', 'entry_admin', '2020-01-01');
    insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, valid_from) values
      ('${IDS.user}', 'own', '2020-01-01'),
      ('${IDS.readUser}', 'all', '2020-01-01');
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
