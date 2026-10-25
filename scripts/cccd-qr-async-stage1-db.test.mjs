import assert from "node:assert/strict";
import test from "node:test";

import {
  CCCD_QR_ASYNC_STAGE1_MIGRATION_NAME,
  CCCD_QR_ASYNC_STAGE1_RPC_SIGNATURES,
} from "./lib/migration-validation.mjs";
import {
  ACTORS,
  createMigratedDatabase,
  seedSubmissionReadFixture,
} from "./lib/s04c-submission-read-fixture.mjs";

const migrations = await createMigratedDatabase();
const db = migrations.db;
const fixture = await seedSubmissionReadFixture(db);
const draftEntryId = fixture.draft.entryIds[0];
const submittedEntryId = fixture.submitted.entryIds[0];

await db.query(
  "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current)" +
    " values ($1,'document_upload','2020-01-01',true),($1,'document_view','2020-01-01',true)",
  [ACTORS.owner.app_user_id],
);

await db.query(
  "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current)" +
    " values ($1,'document_upload','2020-01-01',true),($1,'document_view','2020-01-01',true)",
  [ACTORS.otherOwner.app_user_id],
);

const CANDIDATE_DATA = {
  source: "CCCD_QR",
  authenticity: "UNVERIFIED_QR_TEXT",
  national_id: "079095001234",
  display_name: "Nguyễn Văn An",
  date_of_birth: "15/08/1995",
  date_of_birth_iso: "1995-08-15",
  gender: "MALE",
  gender_label: "Nam",
  address: "123 Nguyễn Trãi, Quận 1, TP. Hồ Chí Minh",
  national_id_issued_at: "20/10/2021",
  national_id_issued_at_iso: "2021-10-20",
};

test("CCCD QR Stage 1 migration enforces Forced RLS, default-deny table ACLs, and service_role-only SECURITY DEFINER RPCs", async () => {
  assert.ok(
    migrations.migrationNames.includes(CCCD_QR_ASYNC_STAGE1_MIGRATION_NAME),
    "migration inventory includes 20261026150000_cccd_qr_async_stage1.sql",
  );

  const { rows: tableMeta } = await db.query(
    `select c.relrowsecurity, c.relforcerowsecurity,
            (select count(*)::int from pg_catalog.pg_policy pol where pol.polrelid = c.oid) as policy_count
       from pg_catalog.pg_class c
      where c.oid = 'public.direct_entry_cccd_qr_extractions'::pg_catalog.regclass`,
  );
  assert.deepEqual(tableMeta[0], {
    relrowsecurity: true,
    relforcerowsecurity: true,
    policy_count: 0,
  });

  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const { rows } = await db.query(
        "select pg_catalog.has_table_privilege($1, 'public.direct_entry_cccd_qr_extractions', $2) as allowed",
        [role, priv],
      );
      assert.equal(rows[0].allowed, false, `${role} must not have ${priv} on direct_entry_cccd_qr_extractions`);
    }
  }

  for (const sig of CCCD_QR_ASYNC_STAGE1_RPC_SIGNATURES) {
    const { rows } = await db.query(
      `select p.prosecdef,
              p.proconfig,
              pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
              pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
              pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
         from pg_catalog.pg_proc p
        where p.oid = $1::pg_catalog.regprocedure`,
      [sig],
    );
    assert.deepEqual(rows[0], {
      prosecdef: true,
      proconfig: ["search_path=pg_catalog, public"],
      anon_exec: false,
      auth_exec: false,
      service_exec: true,
    });
  }
});

test("record-first worker profile creation/submission succeeds without CCCD images, and background QR failures never corrupt worker_details", async () => {
  // 1. Before any CCCD upload on submittedEntryId, get_cccd_qr_extractions returns empty state cleanly
  const { rows: initialRows } = await db.query(
    "select public.direct_entry_get_cccd_qr_extractions($1::uuid, $2::uuid, $3::uuid, null) as data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, submittedEntryId],
  );
  assert.equal(initialRows[0].data.entry_id, submittedEntryId);
  assert.equal(initialRows[0].data.latest, null);
  assert.deepEqual(initialRows[0].data.extractions, []);
  assert.deepEqual(initialRows[0].data.eligible_documents, []);

  // 2. Reserve + finalize CCCD_FRONT on the SUBMITTED worker entry
  const { rows: verRows } = await db.query(
    "select version, worker_details from public.direct_entries where entry_id = $1",
    [submittedEntryId],
  );
  const originalWorkerDetails = verRows[0].worker_details;
  const reserved = await db.query(
    "select public.direct_entry_reserve_document_direct_upload(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::integer, 'CCCD_FRONT', " +
      "'qr-stage1-sub-reserve', 512, 'image/jpeg', null) as data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, submittedEntryId, verRows[0].version],
  );
  const docId = reserved.rows[0].data.document_id;
  const entryVersionAfterReserve = reserved.rows[0].data.entry_version;

  const finalized = await db.query(
    "select public.direct_entry_finalize_document_direct_upload(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, " +
      "'qr-stage1-sub-finalize', 'validated', $6, 512, 'image/jpeg') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      submittedEntryId,
      docId,
      entryVersionAfterReserve,
      "b".repeat(64),
    ],
  );
  assert.equal(finalized.rows[0].data.upload_status, "READY");
  const entryVersionAfterFinalize = finalized.rows[0].data.entry_version;

  // 3. Prepare extraction -> creates PENDING extraction row
  const prepared = await db.query(
    "select public.direct_entry_prepare_cccd_qr_extraction($1::uuid, $2::uuid, $3::uuid, $4::uuid, null) as data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, submittedEntryId, docId],
  );
  assert.equal(prepared.rows[0].data.document_id, docId);
  assert.equal(prepared.rows[0].data.document_type, "CCCD_FRONT");
  assert.equal(prepared.rows[0].data.extraction.status, "PENDING");

  // 4. Record FAILED_RETRYABLE then NO_QR_FOUND -> worker_details and entry version are completely untouched
  const failedRetryable = await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FAILED_RETRYABLE', 'QR_STORAGE_UNAVAILABLE', null, null, false, null, 'idem-fail-retry') as data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, submittedEntryId, docId],
  );
  assert.equal(failedRetryable.rows[0].data.extraction.status, "FAILED_RETRYABLE");
  assert.equal(failedRetryable.rows[0].data.extraction.error_code, "QR_STORAGE_UNAVAILABLE");
  assert.equal(failedRetryable.rows[0].data.extraction.attempts, 1);

  const noQr = await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'NO_QR_FOUND', 'QR_NOT_DETECTED', null, null, false, null, 'idem-no-qr') as data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, submittedEntryId, docId],
  );
  assert.equal(noQr.rows[0].data.extraction.status, "NO_QR_FOUND");
  assert.equal(noQr.rows[0].data.extraction.error_code, "QR_NOT_DETECTED");
  assert.equal(noQr.rows[0].data.extraction.attempts, 2);

  const { rows: afterFailureRows } = await db.query(
    "select version, worker_details from public.direct_entries where entry_id = $1",
    [submittedEntryId],
  );
  assert.equal(afterFailureRows[0].version, entryVersionAfterFinalize);
  assert.deepEqual(afterFailureRows[0].worker_details, originalWorkerDetails);
});

test("background QR extraction stores candidate_data, is idempotent on retry, and apply_blank_fields only fills blank worker_details fields under OCC", async () => {
  // Seed draftEntryId with mixed worker_details:
  // - display_name: "Original Worker Name" (must never be overwritten)
  // - national_id: provided by user ("079099887766") -> must NOT be overwritten
  // - address: intentionally_blank -> must NOT be overwritten
  // - date_of_birth: unknown -> eligible blank
  // - gender: omitted -> eligible blank
  // - national_id_issued_at: omitted -> eligible blank
  const initialDetails = {
    display_name: "Original Worker Name",
    national_id: { state: "provided", value: "079099887766" },
    address: { state: "intentionally_blank" },
    date_of_birth: { state: "unknown" },
    gender: { state: "omitted" },
    phone: { state: "unknown" },
  };
  await db.query(
    "update public.direct_entries set worker_details = $2::jsonb, version = version + 1 where entry_id = $1",
    [draftEntryId, JSON.stringify(initialDetails)],
  );

  const { rows: draftVerRows } = await db.query(
    "select version from public.direct_entries where entry_id = $1",
    [draftEntryId],
  );
  const reserved = await db.query(
    "select public.direct_entry_reserve_document_direct_upload(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::integer, 'CCCD_FRONT', " +
      "'qr-stage1-draft-reserve', 640, 'image/png', null) as data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, draftEntryId, draftVerRows[0].version],
  );
  const docId = reserved.rows[0].data.document_id;
  const finalized = await db.query(
    "select public.direct_entry_finalize_document_direct_upload(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, " +
      "'qr-stage1-draft-finalize', 'validated', $6, 640, 'image/png') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      draftEntryId,
      docId,
      reserved.rows[0].data.entry_version,
      "c".repeat(64),
    ],
  );
  const versionBeforeQr = finalized.rows[0].data.entry_version;

  await assert.rejects(
    db.query(
      "select public.direct_entry_complete_cccd_qr_extraction(" +
        "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', null, null, $5::jsonb, false, null, 'bg-legacy-id') as data",
      [
        ACTORS.owner.auth_subject,
        ACTORS.owner.app_user_id,
        draftEntryId,
        docId,
        JSON.stringify({ ...CANDIDATE_DATA, legacy_national_id: "025123456" }),
      ],
    ),
    (error) => error.code === "22023",
    "database must reject candidate data containing the discarded CMND field",
  );

  // 1. Complete background extraction with apply_blank_fields = false -> stores candidate_data without bumping entry version
  const bgCompleted = await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', null, null, $5::jsonb, false, null, 'bg-idem-1') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      draftEntryId,
      docId,
      JSON.stringify(CANDIDATE_DATA),
    ],
  );
  assert.equal(bgCompleted.rows[0].data.reused, false);
  assert.equal(bgCompleted.rows[0].data.entry_version, versionBeforeQr);
  assert.equal(bgCompleted.rows[0].data.extraction.status, "SUCCEEDED");
  assert.equal(
    bgCompleted.rows[0].data.extraction.candidate_data.authenticity,
    "UNVERIFIED_QR_TEXT",
  );
  assert.deepEqual(bgCompleted.rows[0].data.extraction.field_merge_preview, {
    display_name: "kept_existing",
    national_id: "kept_existing",
    address: "kept_existing",
    date_of_birth: "eligible_blank",
    gender: "eligible_blank",
    national_id_issued_at: "eligible_blank",
  });

  // 2. Idempotent retry of background completion returns reused = true and keeps single extraction row
  const bgRetry = await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', null, null, $5::jsonb, false, null, 'bg-idem-2') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      draftEntryId,
      docId,
      JSON.stringify(CANDIDATE_DATA),
    ],
  );
  assert.equal(bgRetry.rows[0].data.reused, true);
  const { rows: extractionCountRows } = await db.query(
    "select count(*)::int as cnt from public.direct_entry_cccd_qr_extractions where entry_id = $1",
    [draftEntryId],
  );
  assert.equal(extractionCountRows[0].cnt, 1);

  // 3. Stale expected_entry_version on apply_blank_fields = true fails closed with 40001
  await assert.rejects(
    db.query(
      "select public.direct_entry_complete_cccd_qr_extraction(" +
        "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', null, null, $5::jsonb, true, 999, 'apply-stale') as data",
      [
        ACTORS.owner.auth_subject,
        ACTORS.owner.app_user_id,
        draftEntryId,
        docId,
        JSON.stringify(CANDIDATE_DATA),
      ],
    ),
    (error) => error.code === "40001",
  );

  // 4. Matching expected_entry_version applies ONLY blank fields and preserves user-entered fields
  const applied = await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', null, null, $5::jsonb, true, $6::integer, 'apply-ok-1') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      draftEntryId,
      docId,
      JSON.stringify(CANDIDATE_DATA),
      versionBeforeQr,
    ],
  );
  assert.equal(applied.rows[0].data.reused, false);
  assert.equal(applied.rows[0].data.entry_version, versionBeforeQr + 1);
  assert.deepEqual(applied.rows[0].data.extraction.applied_fields, [
    "date_of_birth",
    "gender",
    "national_id_issued_at",
  ]);
  assert.deepEqual(applied.rows[0].data.extraction.skipped_fields, [
    "display_name",
    "national_id",
    "address",
  ]);

  const { rows: updatedEntryRows } = await db.query(
    "select version, worker_details from public.direct_entries where entry_id = $1",
    [draftEntryId],
  );
  assert.equal(updatedEntryRows[0].version, versionBeforeQr + 1);
  assert.deepEqual(updatedEntryRows[0].worker_details, {
    display_name: "Original Worker Name",
    national_id: { state: "provided", value: "079099887766" },
    address: { state: "intentionally_blank" },
    date_of_birth: { state: "provided", value: "15/08/1995" },
    gender: { state: "provided", value: "MALE" },
    national_id_issued_at: { state: "provided", value: "20/10/2021" },
    phone: { state: "unknown" },
  });

  // 5. Verify audit event records field names only and zero PII
  const { rows: auditRows } = await db.query(
    "select action, outcome, changed_fields from public.direct_entry_audit_events where resource_ref = $1 and action = 'cccd_qr_autofill_blank_fields'",
    [draftEntryId],
  );
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].outcome, "APPLIED");
  assert.deepEqual(auditRows[0].changed_fields, [
    "date_of_birth",
    "gender",
    "national_id_issued_at",
  ]);
  const serializedAudit = JSON.stringify(auditRows[0]);
  assert.ok(!serializedAudit.includes("079095001234"));
  assert.ok(!serializedAudit.includes("Nguyễn Văn An"));
  assert.ok(!serializedAudit.includes("123 Nguyễn Trãi"));

  // 6. Idempotent replay of apply_blank_fields with same idempotency_key returns reused = true
  const appliedReplay = await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', null, null, $5::jsonb, true, $6::integer, 'apply-ok-1') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      draftEntryId,
      docId,
      JSON.stringify(CANDIDATE_DATA),
      versionBeforeQr,
    ],
  );
  assert.equal(appliedReplay.rows[0].data.reused, true);
  assert.equal(appliedReplay.rows[0].data.entry_version, versionBeforeQr + 1);
});

test("unauthorized actors are rejected with 42501 on all CCCD QR RPCs", async () => {
  for (const unauthorizedActor of [ACTORS.noCapability, ACTORS.noScope, ACTORS.otherOwner]) {
    await assert.rejects(
      db.query(
        "select public.direct_entry_get_cccd_qr_extractions($1::uuid, $2::uuid, $3::uuid, null)",
        [unauthorizedActor.auth_subject, unauthorizedActor.app_user_id, draftEntryId],
      ),
      (error) => error.code === "42501",
    );

    await assert.rejects(
      db.query(
        "select public.direct_entry_prepare_cccd_qr_extraction($1::uuid, $2::uuid, $3::uuid, null, 'CCCD_FRONT')",
        [unauthorizedActor.auth_subject, unauthorizedActor.app_user_id, draftEntryId],
      ),
      (error) => error.code === "42501",
    );
  }
});
