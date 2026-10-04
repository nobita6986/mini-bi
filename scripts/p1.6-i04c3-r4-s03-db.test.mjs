import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTORS,
  PROJECT_ID,
  RECRUITER_A,
  TEAM_A,
  createMigratedDatabase,
  seedChangeRequestFixture,
} from "./lib/s04c-read-fixture.mjs";

const updateSql = `select public.direct_entry_update_payment(
  $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::integer,
  $6::jsonb, $7::text, $8::text
) as data`;
const keep = () => ({ op: "keep" });
const clear = () => ({ op: "clear" });
const set = (value) => ({ op: "set", value });
const metadata = (account_number, bank_name, account_holder_name) => ({
  account_number,
  bank_name,
  account_holder_name,
});
const PAYMENT_EDITOR = {
  auth_subject: "10000000-0000-4000-8000-000000000006",
  app_user_id: "20000000-0000-4000-8000-000000000006",
};

async function update(db, entryId, entryVersion, paymentVersion, payment, key, actor = ACTORS.proposer) {
  await db.exec("begin; set local role service_role;");
  try {
    const result = await db.query(updateSql, [
      actor.auth_subject,
      actor.app_user_id,
      entryId,
      entryVersion,
      paymentVersion,
      JSON.stringify(payment),
      "Synthetic account metadata correction",
      key,
    ]);
    await db.exec("commit;");
    return result.rows[0].data;
  } catch (error) {
    await db.exec("rollback;");
    throw error;
  }
}

async function createDraft(db) {
  const created = await db.query(
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text) as data",
    [
      ACTORS.proposer.auth_subject,
      ACTORS.proposer.app_user_id,
      JSON.stringify([{
        project_id: PROJECT_ID,
        first_work_date: "2026-10-15",
        employee_code: "hrp-2026-390001",
        worker_details: {
          display_name: "Synthetic Metadata Worker",
          date_of_birth: { state: "omitted" },
          national_id: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "omitted" },
        },
        recruiter_id: RECRUITER_A,
        labor_type: "TEMPORARY",
      }]),
      "r4s03_create_draft",
    ],
  );
  return created.rows[0].data.entry_ids[0];
}

async function paymentRow(db, entryId) {
  const result = await db.query(
    "select state, account_number, bank_id, bank_name, account_holder_name, version " +
    "from public.direct_entry_payments where entry_id = $1",
    [entryId],
  );
  return result.rows[0];
}

async function mutationState(db, entryId) {
  const result = await db.query(
    "select e.version as entry_version, p.version as payment_version," +
    " (select count(*)::int from public.direct_entry_revisions where entry_id = e.entry_id) as revisions," +
    " (select count(*)::int from public.direct_entry_audit_events where resource_ref = e.entry_id::text) as events," +
    " (select count(*)::int from public.direct_entry_rpc_idempotency" +
    "   where app_user_id = e.created_by_user_id and action = 'payment_update') as idempotency_rows" +
    " from public.direct_entries e left join public.direct_entry_payments p using(entry_id)" +
    " where e.entry_id = $1",
    [entryId],
  );
  return result.rows[0];
}

test("R4-S03-R1 applies explicit metadata operations atomically under the existing payment boundary", async () => {
  const { db, migrationNames } = await createMigratedDatabase();
  try {
    assert.equal(migrationNames.length, 38);
    const fixture = await seedChangeRequestFixture(db);

    const inventory = await db.query(`
      select count(*)::int as total,
             count(*) filter (
               where has_function_privilege('service_role', p.oid, 'EXECUTE')
             )::int as service_role,
             count(*) filter (
               where not has_function_privilege('service_role', p.oid, 'EXECUTE')
             )::int as internal
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'direct_entry_%'
    `);
    assert.deepEqual(inventory.rows[0], { total: 67, service_role: 30, internal: 37 });

    const signature =
      "public.direct_entry_update_payment(uuid,uuid,uuid,integer,integer,jsonb,text,text)";
    const boundary = await db.query(
      "select p.prosecdef, p.proconfig," +
      " has_function_privilege('service_role',p.oid,'EXECUTE') as service_exec," +
      " has_function_privilege('anon',p.oid,'EXECUTE') as anon_exec," +
      " has_function_privilege('authenticated',p.oid,'EXECUTE') as auth_exec," +
      " exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a" +
      " where a.grantee=0 and a.privilege_type='EXECUTE') as public_exec" +
      " from pg_proc p where p.oid=$1::regprocedure",
      [signature],
    );
    assert.deepEqual(boundary.rows[0], {
      prosecdef: true,
      proconfig: ["search_path=pg_catalog, public"],
      service_exec: true,
      anon_exec: false,
      auth_exec: false,
      public_exec: false,
    });
    const boundaries = await db.query(
      "select p.oid::regprocedure as signature," +
      " has_function_privilege('service_role',p.oid,'EXECUTE') as service_exec," +
      " has_function_privilege('anon',p.oid,'EXECUTE') as anon_exec," +
      " has_function_privilege('authenticated',p.oid,'EXECUTE') as auth_exec," +
      " exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a" +
      " where a.grantee=0 and a.privilege_type='EXECUTE') as public_exec" +
      " from pg_proc p join pg_namespace n on n.oid=p.pronamespace" +
      " where n.nspname='public' and p.proname like 'direct_entry_%'" +
      " and has_function_privilege('service_role',p.oid,'EXECUTE')",
    );
    assert.equal(boundaries.rows.length, 30);
    for (const fn of boundaries.rows) {
      assert.deepEqual({
        service_exec: fn.service_exec,
        anon_exec: fn.anon_exec,
        auth_exec: fn.auth_exec,
        public_exec: fn.public_exec,
      }, {
        service_exec: true,
        anon_exec: false,
        auth_exec: false,
        public_exec: false,
      }, fn.signature);
    }
    for (const table of [
      "direct_entries",
      "direct_entry_submissions",
      "direct_entry_payments",
      "direct_entry_revisions",
      "direct_entry_audit_events",
      "direct_entry_rpc_idempotency",
    ]) {
      const { rows } = await db.query(
        "select relrowsecurity, relforcerowsecurity from pg_class where oid=$1::regclass",
        [`public.${table}`],
      );
      assert.deepEqual(rows[0], { relrowsecurity: true, relforcerowsecurity: true }, table);
    }
    for (const fn of inventory.rows[0].internal === 37
      ? (await db.query(
        "select p.oid::regprocedure as signature from pg_proc p" +
        " join pg_namespace n on n.oid=p.pronamespace" +
        " where n.nspname='public' and p.proname like 'direct_entry_%'" +
        " and not has_function_privilege('service_role',p.oid,'EXECUTE')",
      )).rows
      : []) {
      assert.deepEqual(await db.query(
        "select has_function_privilege('anon',$1::regprocedure,'EXECUTE') as anon_exec," +
        " has_function_privilege('authenticated',$1::regprocedure,'EXECUTE') as auth_exec," +
        " exists(select 1 from pg_proc p, lateral aclexplode(" +
        " coalesce(p.proacl,acldefault('f',p.proowner))) a" +
        " where p.oid=$1::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') as public_exec",
        [fn.signature],
      ).then((result) => result.rows[0]), {
        anon_exec: false,
        auth_exec: false,
        public_exec: false,
      }, fn.signature);
    }

    const malformed = metadata(set("000012340056"), set("Synthetic Bank"), set("Synthetic Holder"));
    await assert.rejects(
      update(db, fixture.entryA.entry_id, fixture.entryA.version, 0, {
        account_number: "000012340056",
        bank_name: "Unauthorized Synthetic Bank",
        account_holder_name: null,
      }, "r4s03_submitted_unauthorized"),
      (error) => error.code === "22023",
    );
    await assert.rejects(
      update(db, fixture.entryA.entry_id, fixture.entryA.version, 0, malformed,
        "r4s03_submitted_unauthorized_valid", ACTORS.reviewer),
      (error) => error.code === "42501",
    );

    await db.query("insert into auth.users(id) values ($1)", [PAYMENT_EDITOR.auth_subject]);
    await db.query(
      "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled)" +
      " values ($1,$2,true)",
      [PAYMENT_EDITOR.app_user_id, PAYMENT_EDITOR.auth_subject],
    );
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
      " values ($1,'payment_edit','2020-01-01')",
      [PAYMENT_EDITOR.app_user_id],
    );
    await db.query(
      "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from)" +
      " values ($1,'team',$2,'2020-01-01')",
      [PAYMENT_EDITOR.app_user_id, TEAM_A],
    );
    assert.deepEqual((await db.query(
      "select capability from public.direct_entry_capability_grants where app_user_id=$1",
      [PAYMENT_EDITOR.app_user_id],
    )).rows, [{ capability: "payment_edit" }]);
    const seeded = await update(
      db, fixture.entryA.entry_id, fixture.entryA.version, 0,
      metadata(set("000012340056"), set("Synthetic Bank"), set("Synthetic Holder")),
      "r4s03_payment_edit_only_seed", PAYMENT_EDITOR,
    );
    assert.deepEqual(seeded, {
      entry_id: fixture.entryA.entry_id,
      entry_version: fixture.entryA.version + 1,
      payment_version: 1,
    });
    assert.equal(JSON.stringify(seeded).includes("000012340056"), false);
    const keptAccount = metadata(keep(), set("Renamed Synthetic Bank"), keep());
    const updated = await update(
      db, fixture.entryA.entry_id, fixture.entryA.version + 1, 1, keptAccount,
      "r4s03_payment_edit_only_keep", PAYMENT_EDITOR,
    );
    assert.deepEqual(updated, {
      entry_id: fixture.entryA.entry_id,
      entry_version: fixture.entryA.version + 2,
      payment_version: 2,
    });
    assert.equal(JSON.stringify(updated).includes("000012340056"), false);
    assert.deepEqual(await paymentRow(db, fixture.entryA.entry_id), {
      state: "provided",
      account_number: "000012340056",
      bank_id: null,
      bank_name: "Renamed Synthetic Bank",
      account_holder_name: "Synthetic Holder",
      version: 2,
    });
    const masked = await db.query(
      "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as projection",
      [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id, fixture.entryA.entry_id],
    );
    assert.equal(masked.rows[0].projection.payment.account_number, "••••••••0056");
    assert.equal("bank_name" in masked.rows[0].projection.payment, false);
    assert.equal("account_holder_name" in masked.rows[0].projection.payment, false);

    assert.deepEqual(await update(
      db, fixture.entryA.entry_id, fixture.entryA.version + 1, 1, keptAccount,
      "r4s03_payment_edit_only_keep", PAYMENT_EDITOR,
    ), updated);
    await assert.rejects(
      update(db, fixture.entryA.entry_id, fixture.entryA.version + 2, 2,
        metadata(keep(), set("Different Synthetic Bank"), keep()),
        "r4s03_payment_edit_only_keep", PAYMENT_EDITOR),
      (error) => error.code === "22023",
    );

    const entryId = await createDraft(db);
    let result = await update(db, entryId, 1, 0, {
      state: "provided",
      account_number: "000012340056",
      bank_id: "s02b_bank",
      account_holder_name: "Synthetic Legacy Holder",
    }, "r4s03_legacy_seed");
    assert.deepEqual(result, { entry_id: entryId, entry_version: 2, payment_version: 1 });

    result = await update(
      db, entryId, 2, 1,
      metadata(set(" 000012340056 "), keep(), set("Synthetic Updated Holder")),
      "r4s03_set-leading-zero-and-bank-keep",
    );
    assert.deepEqual(result, { entry_id: entryId, entry_version: 3, payment_version: 2 });
    assert.deepEqual(await paymentRow(db, entryId), {
      state: "provided",
      account_number: "000012340056",
      bank_id: "s02b_bank",
      bank_name: null,
      account_holder_name: "Synthetic Updated Holder",
      version: 2,
    });

    result = await update(
      db, entryId, 3, 2, metadata(keep(), set("Synthetic Bank"), keep()),
      "r4s03_bank-set",
    );
    assert.deepEqual(result, { entry_id: entryId, entry_version: 4, payment_version: 3 });
    assert.deepEqual(await paymentRow(db, entryId), {
      state: "provided",
      account_number: "000012340056",
      bank_id: null,
      bank_name: "Synthetic Bank",
      account_holder_name: "Synthetic Updated Holder",
      version: 3,
    });

    result = await update(db, entryId, 4, 3, {
      state: "provided",
      account_number: "000056780099",
      bank_id: "s02b_bank",
      account_holder_name: "Synthetic Legacy Holder",
    }, "r4s03_legacy-preserves-bank-name");
    assert.deepEqual(result, { entry_id: entryId, entry_version: 5, payment_version: 4 });
    assert.deepEqual(await paymentRow(db, entryId), {
      state: "provided",
      account_number: "000056780099",
      bank_id: "s02b_bank",
      bank_name: "Synthetic Bank",
      account_holder_name: "Synthetic Legacy Holder",
      version: 4,
    });

    result = await update(
      db, entryId, 5, 4, metadata(keep(), clear(), keep()),
      "r4s03_bank-clear",
    );
    assert.deepEqual(result, { entry_id: entryId, entry_version: 6, payment_version: 5 });
    assert.deepEqual(await paymentRow(db, entryId), {
      state: "provided",
      account_number: "000056780099",
      bank_id: null,
      bank_name: null,
      account_holder_name: "Synthetic Legacy Holder",
      version: 5,
    });

    result = await update(
      db, entryId, 6, 5, metadata(clear(), keep(), keep()),
      "r4s03_account-number-clear",
    );
    assert.deepEqual(result, { entry_id: entryId, entry_version: 7, payment_version: 6 });
    assert.equal((await paymentRow(db, entryId)).account_number, null);
    result = await update(
      db, entryId, 7, 6, metadata(keep(), keep(), clear()),
      "r4s03_holder-clear",
    );
    assert.deepEqual(result, { entry_id: entryId, entry_version: 8, payment_version: 7 });
    assert.equal((await paymentRow(db, entryId)).account_holder_name, null);

    const beforeNoop = await mutationState(db, entryId);
    await assert.rejects(
      update(db, entryId, 8, 7, metadata(keep(), keep(), keep()), "r4s03_all-keep"),
      (error) => error.code === "22023",
    );
    assert.deepEqual(await mutationState(db, entryId), beforeNoop);

    const beforeInvalid = await mutationState(db, entryId);
    for (const [key, value] of [
      ["masked-bullets", "••••0056"],
      ["masked-ascii", "****0056"],
      ["spaces", "12 34"],
      ["hyphens", "12-34"],
      ["blank-set", "   "],
    ]) {
      await assert.rejects(
        update(db, entryId, 8, 7, metadata(set(value), keep(), keep()), `r4s03_invalid-${key}`),
        (error) => error.code === "22023" &&
          !error.message.includes(value),
      );
    }
    await assert.rejects(
      update(db, entryId, 8, 7, metadata({ op: "keep", value: "1234" }, keep(), keep()),
        "r4s03_invalid-operation-shape"),
      (error) => error.code === "22023",
    );
    await assert.rejects(
      update(db, entryId, 8, 7, metadata({ op: null }, keep(), set("Synthetic Holder")),
        "r4s03_invalid-null-operation"),
      (error) => error.code === "22023",
    );
    assert.deepEqual(await mutationState(db, entryId), beforeInvalid);

    await assert.rejects(
      update(db, entryId, 7, 7, metadata(keep(), set("Stale Synthetic Bank"), keep()),
        "r4s03_stale-entry"),
      (error) => error.code === "40001",
    );
    await assert.rejects(
      update(db, entryId, 8, 6, metadata(keep(), set("Stale Payment Bank"), keep()),
        "r4s03_stale-payment"),
      (error) => error.code === "40001",
    );

    result = await update(
      db, entryId, 8, 7,
      metadata(set("000056780099"), set("Synthetic Bank"), set("Synthetic Legacy Holder")),
      "r4s03_clear-all-seed",
    );
    assert.deepEqual(result, { entry_id: entryId, entry_version: 9, payment_version: 8 });
    result = await update(
      db, entryId, 9, 8, metadata(clear(), clear(), clear()),
      "r4s03_clear-all",
    );
    assert.deepEqual(result, { entry_id: entryId, entry_version: 10, payment_version: 9 });
    assert.deepEqual(await paymentRow(db, entryId), {
      state: "omitted",
      account_number: null,
      bank_id: null,
      bank_name: null,
      account_holder_name: null,
      version: 9,
    });

    await db.query("delete from public.direct_entry_banks");
    result = await update(
      db, entryId, 10, 9, metadata(keep(), set("Synthetic Text Bank"), keep()),
      "r4s03_metadata-without-catalog",
    );
    assert.deepEqual(result, { entry_id: entryId, entry_version: 11, payment_version: 10 });
    assert.equal((await paymentRow(db, entryId)).bank_name, "Synthetic Text Bank");
    assert.equal((await db.query(
      "select count(*)::int as banks from public.direct_entry_banks",
    )).rows[0].banks, 0);

    for (const [entry, version, paymentVersion, input, key] of [
      [entryId, 10, 9, metadata(keep(), keep(), set("Should Roll Back")), "r4s03_rollback-stale"],
      [entryId, 11, 10, metadata(set("••••0056"), keep(), keep()), "r4s03_rollback-masked"],
    ]) {
      const before = await mutationState(db, entry);
      await assert.rejects(
        update(db, entry, version, paymentVersion, input, key),
        (error) => error.code === "22023" || error.code === "40001",
      );
      assert.deepEqual(await mutationState(db, entry), before);
    }

    const rawValues = [
      "000012340056",
      "000056780099",
      "Synthetic Bank",
      "Renamed Synthetic Bank",
      "Synthetic Updated Holder",
      "Synthetic Legacy Holder",
      "Synthetic Text Bank",
    ];
    const revisions = await db.query(
      "select coalesce(before_snapshot::text,'') || coalesce(after_snapshot::text,'') as value " +
      "from public.direct_entry_revisions",
    );
    const events = await db.query(
      "select to_jsonb(event)::text as value from public.direct_entry_audit_events event",
    );
    const reasons = await db.query(
      "select to_jsonb(reason)::text as value from public.direct_entry_restricted_reasons reason",
    );
    const idempotency = await db.query(
      "select to_jsonb(item)::text as value from public.direct_entry_rpc_idempotency item" +
      " where action='payment_update'",
    );
    for (const { value } of [
      ...revisions.rows,
      ...events.rows,
      ...reasons.rows,
      ...idempotency.rows,
    ]) {
      for (const raw of rawValues) assert.equal(value.includes(raw), false);
    }
  } finally {
    await db.close();
  }
});
