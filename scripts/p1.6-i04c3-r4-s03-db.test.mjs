import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTORS,
  PROJECT_ID,
  RECRUITER_A,
  createMigratedDatabase,
  seedChangeRequestFixture,
} from "./lib/s04c-read-fixture.mjs";

const updateSql = `select public.direct_entry_update_payment(
  $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::integer,
  $6::jsonb, $7::text, $8::text
) as data`;

async function update(db, entryId, entryVersion, paymentVersion, payment, key) {
  await db.exec("begin; set local role service_role;");
  try {
    const result = await db.query(updateSql, [
      ACTORS.proposer.auth_subject,
      ACTORS.proposer.app_user_id,
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

test("R4-S03 full-replacement metadata edit preserves authority, versions, redaction, and legacy compatibility", async () => {
  const { db, migrationNames } = await createMigratedDatabase();
  try {
    assert.equal(migrationNames.length, 38);
    const fixture = await seedChangeRequestFixture(db);
    await assert.rejects(
      update(db, fixture.entryA.entry_id, fixture.entryA.version, 0, {
        account_number: null,
        bank_name: "Unauthorized Synthetic Bank",
        account_holder_name: null,
      }, "r4s03_submitted_unauthorized"),
      (error) => error.code === "42501",
    );
    const submittedAfterDeniedWrite = await db.query(
      "select e.version, count(p.entry_id)::int as payments " +
      "from public.direct_entries e left join public.direct_entry_payments p using(entry_id) " +
      "where e.entry_id = $1 group by e.version",
      [fixture.entryA.entry_id],
    );
    assert.deepEqual(submittedAfterDeniedWrite.rows[0], {
      version: fixture.entryA.version,
      payments: 0,
    });
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
    const entryId = created.rows[0].data.entry_ids[0];

    const legacy = await update(db, entryId, 1, 0, {
      state: "provided",
      account_number: "000012340056",
      bank_id: "s02b_bank",
      account_holder_name: "Synthetic Legacy Holder",
    }, "r4s03_legacy_payment");
    assert.deepEqual(legacy, {
      entry_id: entryId,
      entry_version: 2,
      payment_version: 1,
    });
    const first = await update(db, entryId, 2, 1, {
      account_number: " 000012340056 ",
      bank_name: "\u00a0Ngân hàng Á Châu\u3000",
      account_holder_name: null,
    }, "r4s03_metadata_partial");
    assert.deepEqual(first, {
      entry_id: entryId,
      entry_version: 3,
      payment_version: 2,
    });
    assert.deepEqual(await update(db, entryId, 2, 1, {
      account_number: " 000012340056 ",
      bank_name: "\u00a0Ngân hàng Á Châu\u3000",
      account_holder_name: null,
    }, "r4s03_metadata_partial"), first);

    const persisted = await db.query(
      "select state, account_number, bank_id, bank_name, account_holder_name, version " +
      "from public.direct_entry_payments where entry_id = $1",
      [entryId],
    );
    assert.deepEqual(persisted.rows[0], {
      state: "provided",
      account_number: "000012340056",
      bank_id: null,
      bank_name: "Ngân hàng Á Châu",
      account_holder_name: null,
      version: 2,
    });

    const maskedResult = await db.query(
      "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as projection",
      [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id, entryId],
    );
    assert.equal(maskedResult.rows[0].projection.payment.account_number, "••••••••0056");
    assert.equal("bank_name" in maskedResult.rows[0].projection.payment, false);

    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
      " values ($1,'payment_view','2020-01-01')",
      [ACTORS.proposer.app_user_id],
    );
    const fullResult = await db.query(
      "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as projection",
      [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id, entryId],
    );
    assert.deepEqual(fullResult.rows[0].projection.payment, {
      state: "provided",
      account_number: "000012340056",
      bank_id: null,
      bank_name: "Ngân hàng Á Châu",
      account_holder_name: null,
      version: 2,
    });

    await assert.rejects(
      update(db, entryId, 2, 1, {
        account_number: null,
        bank_name: null,
        account_holder_name: "Synthetic Holder",
      }, "r4s03_stale_entry"),
      (error) => error.code === "40001",
    );
    await assert.rejects(
      update(db, entryId, 3, 2, {
        account_number: "x".repeat(65),
        bank_name: null,
        account_holder_name: null,
      }, "r4s03_invalid_length"),
      (error) => error.code === "22023",
    );
    await assert.rejects(
      update(db, entryId, 3, 2, {
        account_number: null,
        bank_name: "Synthetic\nBank",
        account_holder_name: null,
      }, "r4s03_invalid_control"),
      (error) => error.code === "22023",
    );
    await assert.rejects(
      update(db, entryId, 3, 2, {
        account_number: null,
        bank_name: null,
        account_holder_name: null,
        bank_id: "unexpected",
      }, "r4s03_extra_field"),
      (error) => error.code === "22023",
    );

    const legacyUpdate = await update(db, entryId, 3, 2, {
      state: "provided",
      account_number: "000056780099",
      bank_id: "s02b_bank",
      account_holder_name: "Synthetic Legacy Holder",
    }, "r4s03_legacy_preserves_text");
    assert.equal(legacyUpdate.entry_version, 4);
    const preservedBankName = await db.query(
      "select bank_id, bank_name from public.direct_entry_payments where entry_id = $1",
      [entryId],
    );
    assert.deepEqual(preservedBankName.rows[0], {
      bank_id: "s02b_bank",
      bank_name: "Ngân hàng Á Châu",
    });

    const holderOnly = await update(db, entryId, 4, 3, {
      account_number: null,
      bank_name: null,
      account_holder_name: "Synthetic Holder",
    }, "r4s03_metadata_holder");
    assert.deepEqual(holderOnly, {
      entry_id: entryId,
      entry_version: 5,
      payment_version: 4,
    });
    const cleared = await update(db, entryId, 5, 4, {
      account_number: null,
      bank_name: null,
      account_holder_name: null,
    }, "r4s03_metadata_clear");
    assert.deepEqual(cleared, {
      entry_id: entryId,
      entry_version: 6,
      payment_version: 5,
    });
    const clearedRow = await db.query(
      "select state, account_number, bank_id, bank_name, account_holder_name, version " +
      "from public.direct_entry_payments where entry_id = $1",
      [entryId],
    );
    assert.deepEqual(clearedRow.rows[0], {
      state: "omitted",
      account_number: null,
      bank_id: null,
      bank_name: null,
      account_holder_name: null,
      version: 5,
    });

    await db.query("delete from public.direct_entry_banks");
    const withoutCatalog = await update(db, entryId, 6, 5, {
      account_number: null,
      bank_name: "Synthetic Text Bank",
      account_holder_name: null,
    }, "r4s03_metadata_without_catalog");
    assert.deepEqual(withoutCatalog, {
      entry_id: entryId,
      entry_version: 7,
      payment_version: 6,
    });
    const noCatalogRow = await db.query(
      "select count(*)::int as banks from public.direct_entry_banks",
    );
    assert.equal(noCatalogRow.rows[0].banks, 0);

    const rawValues = [
      "000012340056",
      "000056780099",
      "Ngân hàng Á Châu",
      "Synthetic Holder",
      "Synthetic Legacy Holder",
      "Synthetic Text Bank",
    ];
    const revisions = await db.query(
      "select coalesce(before_snapshot::text,'') || coalesce(after_snapshot::text,'') as value " +
      "from public.direct_entry_revisions where entry_id = $1",
      [entryId],
    );
    const events = await db.query(
      "select to_jsonb(event)::text as value from public.direct_entry_audit_events event " +
      "where resource_ref = $1",
      [entryId],
    );
    for (const { value } of [...revisions.rows, ...events.rows]) {
      for (const raw of rawValues) assert.equal(value.includes(raw), false);
    }

  } finally {
    await db.close();
  }
});
