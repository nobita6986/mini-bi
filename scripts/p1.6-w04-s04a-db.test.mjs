import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

const migrations = [
  "20261002170000_p1_6_direct_entry_foundation.sql",
  "20261003170000_p1_6_w03_submission_noop_guard.sql",
  "20261003180000_p1_6_w04_s03a_actor_context.sql",
  "20261003200000_p1_6_w04_s03cd_catalog_drafts.sql",
  "20261003210000_p1_6_w04_s04a_payment_projection.sql",
  "20261003220000_p1_6_w04_s04a_r1_payment_draft_authority.sql",
];
const ids = {
  subjectA: "91200000-0000-4000-8000-000000000001",
  subjectB: "91200000-0000-4000-8000-000000000002",
  userA: "92200000-0000-4000-8000-000000000001",
  userB: "92200000-0000-4000-8000-000000000002",
  team: "94200000-0000-4000-8000-000000000001",
  recruiter: "93200000-0000-4000-8000-000000000001",
  bankActive: "bank_s04a_active",
  bankInactive: "bank_s04a_inactive",
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
    await db.exec(await readFile(
      new URL(`../supabase/migrations/${migration}`, import.meta.url),
      "utf8",
    ));
  }
  return db;
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

async function seed(db) {
  await db.exec(`
    insert into auth.users (id) values ('${ids.subjectA}'), ('${ids.subjectB}');
    insert into public.direct_entry_app_users (app_user_id, auth_subject)
      values ('${ids.userA}', '${ids.subjectA}'), ('${ids.userB}', '${ids.subjectB}');
    insert into public.teams (team_id, code, display_name)
      values ('${ids.team}', 'S04A-SYNTH', 'Synthetic S04A Team');
    insert into public.recruiters (recruiter_id, display_name)
      values ('${ids.recruiter}', 'Synthetic S04A Recruiter');
    insert into public.recruiter_provider_memberships
      (recruiter_id, provider_type, valid_from)
      values ('${ids.recruiter}', 'hrp', '2020-01-01');
    insert into public.recruiter_team_memberships
      (recruiter_id, team_id, valid_from)
      values ('${ids.recruiter}', '${ids.team}', '2020-01-01');
    insert into public.direct_entry_projects (project_id, display_name)
      values ('project_s04a_synthetic', 'Synthetic S04A Project');
    insert into public.direct_entry_banks (bank_id, display_name, active)
      values ('${ids.bankActive}', 'Synthetic Active Bank', true),
             ('${ids.bankInactive}', 'Synthetic Inactive Bank', false);
    insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from) values
      ('${ids.userA}', 'entry_create', '2020-01-01'),
      ('${ids.userA}', 'submission_create', '2020-01-01'),
      ('${ids.userA}', 'entry_own', '2020-01-01'),
      ('${ids.userB}', 'entry_own', '2020-01-01');
    insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, valid_from) values
      ('${ids.userA}', 'own', '2020-01-01'),
      ('${ids.userB}', 'own', '2020-01-01');
  `);
}

test("S04A payment catalog, projection masking, RPC boundary, OCC and audit", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const catalog = await rpc(
      db,
      "catalog",
      "select public.direct_entry_input_catalog($1::uuid, $2::uuid, $3::date) as catalog",
      [ids.subjectA, ids.userA, "2026-10-15"],
    );
    assert.deepEqual(catalog.banks, [{
      bank_id: ids.bankActive,
      display_name: "Synthetic Active Bank",
    }]);
    assert.deepEqual(Object.keys(catalog.banks[0]).sort(), ["bank_id", "display_name"]);

    const created = await rpc(
      db,
      "created",
      "select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as created",
      [
        ids.subjectA,
        ids.userA,
        JSON.stringify([{
          project_id: "project_s04a_synthetic",
          first_work_date: "2026-10-15",
          employee_code: "hrp-2026-910001",
          worker_details: {
            display_name: "Synthetic Payment Worker",
            date_of_birth: { state: "omitted" },
            national_id: { state: "omitted" },
            address: { state: "omitted" },
            phone: { state: "omitted" },
          },
          recruiter_id: ids.recruiter,
          labor_type: "TEMPORARY",
        }]),
        "s04a-create",
      ],
    );
    const entryId = created.entry_ids[0];
    const updateSql = `select public.direct_entry_update_payment(
      $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::integer,
      $6::jsonb, $7::text, $8::text
    ) as updated`;
    const callUpdate = (entryVersion, paymentVersion, state, account, bank, holder, key) =>
      rpc(db, "updated", updateSql, [
        ids.subjectA, ids.userA, entryId, entryVersion, paymentVersion,
        JSON.stringify({
          state,
          account_number: account,
          bank_id: bank,
          account_holder_name: holder,
        }),
        "Synthetic reason for payment update",
        key,
      ]);

    const first = await callUpdate(1, 0, "omitted", null, null, null, "s04a-payment-omitted");
    assert.deepEqual(first, {
      entry_id: entryId,
      entry_version: 2,
      payment_version: 1,
    });
    assert.deepEqual(await callUpdate(
      1, 0, "omitted", null, null, null, "s04a-payment-omitted",
    ), first);
    await assert.rejects(
      callUpdate(1, 0, "unknown", null, null, null, "s04a-payment-omitted"),
      (error) => error.code === "22023",
    );

    const unknown = await callUpdate(2, 1, "unknown", null, null, null, "s04a-payment-unknown");
    const blank = await callUpdate(3, 2, "intentionally_blank", null, null, null, "s04a-payment-blank");
    const provided = await callUpdate(
      4, 3, "provided", "000012340056", ids.bankActive,
      "Synthetic Account Holder", "s04a-payment-provided",
    );
    assert.deepEqual([unknown.payment_version, blank.payment_version, provided.payment_version], [2, 3, 4]);
    assert.equal(provided.entry_version, 5);

    await assert.rejects(
      callUpdate(5, 4, "provided", "000012340056", ids.bankInactive,
        "Synthetic Account Holder", "s04a-inactive-bank"),
      (error) => error.code === "23514",
    );
    await assert.rejects(
      callUpdate(4, 3, "unknown", null, null, null, "s04a-stale-version"),
      (error) => error.code === "40001",
    );

    await db.exec("begin; set local role service_role;");
    try {
      const maskedResult = await db.query(
        "select public.direct_entry_read_projection($1::uuid, $2::uuid, $3::uuid) as projection",
        [ids.subjectA, ids.userA, entryId],
      );
      const masked = maskedResult.rows[0].projection.payment;
      assert.deepEqual(Object.keys(masked).sort(), ["account_number", "state", "version"]);
      assert.equal(masked.account_number, "••••••••0056");
      assert.equal(masked.version, 4);
      assert.equal(JSON.stringify(masked).includes("000012340056"), false);
      await db.exec("reset role;");
      await db.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from) values ($1, 'payment_view', '2020-01-01')",
        [ids.userA],
      );
      const fullResult = await db.query(
        "select public.direct_entry_read_projection($1::uuid, $2::uuid, $3::uuid) as projection",
        [ids.subjectA, ids.userA, entryId],
      );
      const full = fullResult.rows[0].projection.payment;
      assert.deepEqual(Object.keys(full).sort(), [
        "account_holder_name", "account_number", "bank_id", "state", "version",
      ]);
      assert.equal(full.account_number, "000012340056");
      assert.equal(full.bank_id, ids.bankActive);
      await db.exec("commit;");
    } catch (error) {
      await db.exec("rollback;");
      throw error;
    }

    await assert.rejects(
      rpc(db, "updated", updateSql, [
        ids.subjectB, ids.userB, entryId, 5, 4,
        JSON.stringify({
          state: "unknown",
          account_number: null,
          bank_id: null,
          account_holder_name: null,
        }),
        "Synthetic denied scope",
        "s04a-outside-scope",
      ]),
      (error) => error.code === "42501",
    );

    const evidence = await db.query(`
      select
        (select count(*)::int from public.direct_entry_audit_events
          where resource_ref = $1 and action = 'payment_update') as audit_count,
        (select count(*)::int from public.direct_entry_revisions
          where entry_id = $2) as revision_count,
        (select count(*)::int from public.direct_entry_rpc_idempotency
          where app_user_id = $3 and action = 'payment_update') as idempotency_count,
        (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb)
          from public.direct_entry_audit_events a
         where a.resource_ref = $1 and a.action = 'payment_update') as audit_rows
    `, [entryId, entryId, ids.userA]);
    assert.equal(evidence.rows[0].audit_count, 4);
    assert.equal(evidence.rows[0].revision_count, 5);
    assert.equal(evidence.rows[0].idempotency_count, 4);
    assert.ok(evidence.rows[0].audit_rows.every((row) => row.capability === "entry_own"));
    assert.equal(JSON.stringify(evidence.rows[0].audit_rows).includes("000012340056"), false);

    await rpc(db, "reviewed", `select public.direct_entry_transition_submission(
      $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text, $6::text
    ) as reviewed`, [
      ids.subjectA, ids.userA, created.submission_id, 1, "REVIEW", "s04a-review",
    ]);
    await rpc(db, "submitted", `select public.direct_entry_transition_submission(
      $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text, $6::text
    ) as submitted`, [
      ids.subjectA, ids.userA, created.submission_id, 2, "SUBMITTED", "s04a-submit",
    ]);
    await assert.rejects(
      callUpdate(5, 4, "unknown", null, null, null, "s04a-submitted-without-payment-edit"),
      (error) => error.code === "42501",
    );

    const acl = await db.query(`
      select
        has_function_privilege('service_role',
          'public.direct_entry_update_payment(uuid,uuid,uuid,integer,integer,jsonb,text,text)',
          'execute') as service_execute,
        has_function_privilege('anon',
          'public.direct_entry_update_payment(uuid,uuid,uuid,integer,integer,jsonb,text,text)',
          'execute') as anon_execute,
        has_function_privilege('authenticated',
          'public.direct_entry_update_payment(uuid,uuid,uuid,integer,integer,jsonb,text,text)',
          'execute') as authenticated_execute,
        has_table_privilege('anon', 'public.direct_entry_payments', 'select') as anon_payment_select,
        has_table_privilege('authenticated', 'public.direct_entry_payments', 'select') as auth_payment_select,
        has_table_privilege('service_role', 'public.direct_entry_payments', 'select') as service_payment_select,
        has_table_privilege('anon', 'public.direct_entry_banks', 'select') as anon_bank_select,
        has_table_privilege('authenticated', 'public.direct_entry_banks', 'select') as auth_bank_select,
        has_table_privilege('service_role', 'public.direct_entry_banks', 'select') as service_bank_select
    `);
    assert.deepEqual(acl.rows[0], {
      service_execute: true,
      anon_execute: false,
      authenticated_execute: false,
      anon_payment_select: false,
      auth_payment_select: false,
      service_payment_select: false,
      anon_bank_select: false,
      auth_bank_select: false,
      service_bank_select: false,
    });
  } finally {
    await db.close();
  }
});
