import assert from "node:assert/strict";
import test from "node:test";

import {
  CCCD_REVIEW_MANUAL_RESOLUTION_MIGRATION_NAME,
  CCCD_REVIEW_MANUAL_RESOLUTION_RPC_SIGNATURE,
  PRE_WAVE2_CCCD_REVIEW_MIGRATION_NAME,
  PRE_WAVE2_CCCD_REVIEW_RPC_SIGNATURES,
} from "./lib/migration-validation.mjs";
import {
  ACTORS,
  PROJECT_ID,
  RECRUITER_A,
  createMigratedDatabase,
  seedSubmissionReadFixture,
} from "./lib/s04c-submission-read-fixture.mjs";

const migrations = await createMigratedDatabase();
const db = migrations.db;
await seedSubmissionReadFixture(db);
const projectId = PROJECT_ID;
const recruiterId = RECRUITER_A;

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

const QR_CANDIDATE_MATCH = {
  source: "CCCD_QR",
  authenticity: "UNVERIFIED_QR_TEXT",
  national_id: "079095008811",
  display_name: "Lê Thị Hồng Nhung",
  date_of_birth: "12/04/1996",
  date_of_birth_iso: "1996-04-12",
  gender: "FEMALE",
  gender_label: "Nữ",
  address: "45 Lê Lợi, Quận 1, TP. Hồ Chí Minh",
  national_id_issued_at: "15/06/2022",
  national_id_issued_at_iso: "2022-06-15",
};

const QR_CANDIDATE_MISMATCH = {
  source: "CCCD_QR",
  authenticity: "UNVERIFIED_QR_TEXT",
  national_id: "079095009922",
  display_name: "Trần Văn Khác",
  date_of_birth: "01/01/1990",
  date_of_birth_iso: "1990-01-01",
  gender: "MALE",
  gender_label: "Nam",
  address: "99 Hai Bà Trưng, Quận 3, TP. Hồ Chí Minh",
  national_id_issued_at: "10/10/2021",
  national_id_issued_at_iso: "2021-10-10",
};

async function createBatchV2(actor, contractVersion, rows, idempotencyKey) {
  const res = await db.query(
    "select public.direct_entry_create_full_profile_batch_v2_unscoped_h03($1::uuid, $2::uuid, $3::text, $4::jsonb, $5::text) as data",
    [actor.auth_subject, actor.app_user_id, contractVersion, JSON.stringify(rows), idempotencyKey],
  );
  return res.rows[0].data;
}

async function reserveAndFinalizeCccd(entryId, entryVersion, docType, keySuffix) {
  const reserved = await db.query(
    "select public.direct_entry_reserve_document_direct_upload(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text, " +
      "$6::text, 512, 'image/jpeg', null) as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      entryVersion,
      docType,
      `res-${keySuffix}`,
    ],
  );
  const docId = reserved.rows[0].data.document_id;
  const verAfterReserve = reserved.rows[0].data.entry_version;
  const finalized = await db.query(
    "select public.direct_entry_finalize_document_direct_upload(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, " +
      "$6::text, 'validated', $7::text, 512, 'image/jpeg') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      docId,
      verAfterReserve,
      `fin-${keySuffix}`,
      "a".repeat(64),
    ],
  );
  return {
    documentId: docId,
    entryVersion: finalized.rows[0].data.entry_version,
  };
}

test("Pre-Wave-2 migration enforces Forced RLS, default-deny table ACLs, and service_role-only SECURITY DEFINER RPCs", async () => {
  assert.ok(
    migrations.migrationNames.includes(PRE_WAVE2_CCCD_REVIEW_MIGRATION_NAME),
    "migration inventory includes 20261026180000_pre_wave2_cccd_reconciliation_and_review.sql",
  );

  const { rows: tableMeta } = await db.query(
    `select c.relrowsecurity, c.relforcerowsecurity,
            (select count(*)::int from pg_catalog.pg_policy pol where pol.polrelid = c.oid) as policy_count
       from pg_catalog.pg_class c
      where c.oid = 'public.direct_entry_cccd_reconciliations'::pg_catalog.regclass`,
  );
  assert.deepEqual(tableMeta[0], {
    relrowsecurity: true,
    relforcerowsecurity: true,
    policy_count: 0,
  });

  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const { rows } = await db.query(
        "select pg_catalog.has_table_privilege($1, 'public.direct_entry_cccd_reconciliations', $2) as allowed",
        [role, priv],
      );
      assert.equal(rows[0].allowed, false);
    }
  }

  assert.ok(migrations.migrationNames.includes(CCCD_REVIEW_MANUAL_RESOLUTION_MIGRATION_NAME));
  for (const sig of [
    ...PRE_WAVE2_CCCD_REVIEW_RPC_SIGNATURES,
    CCCD_REVIEW_MANUAL_RESOLUTION_RPC_SIGNATURE,
  ]) {
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

test("worker-profile/1.2 requires 12-digit CCCD and allows blank display_name, while worker-profile/1.1 (Grid) stays unchanged", async () => {
  // 1. worker-profile/1.1 (Grid mode) still rejects blank display_name and allows omitted national_id
  await assert.rejects(
    createBatchV2(
      ACTORS.owner,
      "worker-profile/1.1",
      [
        {
          project_id: projectId,
          first_work_date: "2026-04-01",
          recruiter_id: recruiterId,
          provider_type: "hrp",
          labor_type: "TEMPORARY",
          display_name: "",
          worker_details: {
            gender: { state: "omitted" },
            date_of_birth: { state: "omitted" },
            national_id: { state: "provided", value: "079095008800" },
            national_id_issued_at: { state: "omitted" },
            national_id_issued_place: { state: "omitted" },
            address: { state: "omitted" },
            phone: { state: "omitted" },
          },
          general_note: { state: "omitted" },
          payment: null,
          employment: { initial_status: "ON" },
        },
      ],
      "11111111-1111-4111-8111-000000000001",
    ),
    (err) => err.code === "22023",
  );

  const gridCreated = await createBatchV2(
    ACTORS.owner,
    "worker-profile/1.1",
    [
      {
        project_id: projectId,
        first_work_date: "2026-04-01",
        recruiter_id: recruiterId,
        provider_type: "hrp",
        labor_type: "TEMPORARY",
        display_name: "Nguyễn Văn Lưới",
        worker_details: {
          gender: { state: "omitted" },
          date_of_birth: { state: "omitted" },
          national_id: { state: "omitted" },
          national_id_issued_at: { state: "omitted" },
          national_id_issued_place: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "omitted" },
        },
        general_note: { state: "omitted" },
        payment: null,
        employment: { initial_status: "ON" },
      },
    ],
    "11111111-1111-4111-8111-000000000002",
  );
  assert.equal(gridCreated.entry_ids.length, 1);

  // 2. worker-profile/1.2 (Form & Android) rejects omitted national_id
  await assert.rejects(
    createBatchV2(
      ACTORS.owner,
      "worker-profile/1.2",
      [
        {
          project_id: projectId,
          first_work_date: "2026-04-01",
          recruiter_id: recruiterId,
          provider_type: "hrp",
          labor_type: "TEMPORARY",
          display_name: "Có Tên Nhưng Thiếu CCCD",
          worker_details: {
            gender: { state: "omitted" },
            date_of_birth: { state: "omitted" },
            national_id: { state: "omitted" },
            national_id_issued_at: { state: "omitted" },
            national_id_issued_place: { state: "omitted" },
            address: { state: "omitted" },
            phone: { state: "omitted" },
          },
          general_note: { state: "omitted" },
          payment: null,
          employment: { initial_status: "ON" },
        },
      ],
      "11111111-1111-4111-8111-000000000003",
    ),
    (err) => err.code === "22023",
  );

  // 3. worker-profile/1.2 succeeds with blank display_name ("") and valid 12-digit national_id,
  //    and initializes PENDING reconciliation row.
  const formCreated = await createBatchV2(
    ACTORS.owner,
    "worker-profile/1.2",
    [
      {
        project_id: projectId,
        first_work_date: "2026-04-01",
        recruiter_id: recruiterId,
        provider_type: "hrp",
        labor_type: "TEMPORARY",
        display_name: "",
        worker_details: {
          gender: { state: "omitted" },
          date_of_birth: { state: "omitted" },
          national_id: { state: "provided", value: "079095008811" },
          national_id_issued_at: { state: "omitted" },
          national_id_issued_place: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "provided", value: "0909123456" },
        },
        general_note: { state: "omitted" },
        payment: null,
        employment: { initial_status: "ON" },
      },
    ],
    "11111111-1111-4111-8111-000000000004",
  );
  const entryId = formCreated.entry_ids[0];

  const { rows: recRows } = await db.query(
    "select status, entered_national_id, qr_national_id from public.direct_entry_cccd_reconciliations where entry_id = $1",
    [entryId],
  );
  assert.deepEqual(recRows[0], {
    status: "PENDING",
    entered_national_id: "079095008811",
    qr_national_id: null,
  });
});

test("MATCHED_INITIAL auto-fills blank display_name and personal fields from QR, preserves OCC compatibility for concurrent uploads, and non-QR back side never downgrades MATCHED_INITIAL", async () => {
  const created = await createBatchV2(
    ACTORS.owner,
    "worker-profile/1.2",
    [
      {
        project_id: projectId,
        first_work_date: "2026-04-02",
        recruiter_id: recruiterId,
        provider_type: "hrp",
        labor_type: "TEMPORARY",
        display_name: "",
        worker_details: {
          gender: { state: "omitted" },
          date_of_birth: { state: "omitted" },
          national_id: { state: "provided", value: QR_CANDIDATE_MATCH.national_id },
          national_id_issued_at: { state: "omitted" },
          national_id_issued_place: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "provided", value: "0912000111" },
        },
        general_note: { state: "omitted" },
        payment: null,
        employment: { initial_status: "ON" },
      },
    ],
    "11111111-1111-4111-8111-000000000005",
  );
  const entryId = created.entry_ids[0];

  // Upload CCCD_FRONT
  const front = await reserveAndFinalizeCccd(entryId, 1, "CCCD_FRONT", "match-front");
  await db.query(
    "select public.direct_entry_prepare_cccd_qr_extraction($1::uuid, $2::uuid, $3::uuid, $4::uuid, null)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId, front.documentId],
  );

  // Complete QR extraction with matching CCCD and apply_blank_fields = true (no expected_entry_version, simulating background worker)
  const completed = await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', null, null, $5::jsonb, true, null, 'idem-match-autofill') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      front.documentId,
      JSON.stringify(QR_CANDIDATE_MATCH),
    ],
  );
  assert.equal(completed.rows[0].data.extraction.reconciliation_status, "MATCHED_INITIAL");
  assert.equal(completed.rows[0].data.reconciliation.status, "MATCHED_INITIAL");
  assert.deepEqual(completed.rows[0].data.extraction.applied_fields, [
    "address",
    "date_of_birth",
    "display_name",
    "gender",
    "national_id_issued_at",
  ]);

  // Verify blank display_name and personal fields were filled on direct_entries, while phone stayed intact
  const { rows: entryRows } = await db.query(
    "select version, worker_details from public.direct_entries where entry_id = $1",
    [entryId],
  );
  const versionAfterAutoFill = entryRows[0].version;
  assert.equal(versionAfterAutoFill, front.entryVersion + 1);
  assert.equal(entryRows[0].worker_details.display_name, QR_CANDIDATE_MATCH.display_name);
  assert.deepEqual(entryRows[0].worker_details.date_of_birth, {
    state: "provided",
    value: QR_CANDIDATE_MATCH.date_of_birth,
  });
  assert.deepEqual(entryRows[0].worker_details.gender, {
    state: "provided",
    value: QR_CANDIDATE_MATCH.gender,
  });
  assert.deepEqual(entryRows[0].worker_details.address, {
    state: "provided",
    value: QR_CANDIDATE_MATCH.address,
  });
  assert.deepEqual(entryRows[0].worker_details.national_id_issued_at, {
    state: "provided",
    value: QR_CANDIDATE_MATCH.national_id_issued_at,
  });
  assert.deepEqual(entryRows[0].worker_details.phone, {
    state: "provided",
    value: "0912000111",
  });

  // Verify OCC compatibility: client holding pre-autofill version (front.entryVersion) can still upload CCCD_BACK!
  const back = await reserveAndFinalizeCccd(entryId, front.entryVersion, "CCCD_BACK", "match-back");
  await db.query(
    "select public.direct_entry_prepare_cccd_qr_extraction($1::uuid, $2::uuid, $3::uuid, $4::uuid, null)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId, back.documentId],
  );
  const backNoQr = await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'NO_QR_FOUND', 'QR_NOT_DETECTED', null, null, true, null, 'idem-match-back-noqr') as data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId, back.documentId],
  );
  // Entry reconciliation MUST remain MATCHED_INITIAL even though CCCD_BACK had NO_QR_FOUND!
  assert.equal(backNoQr.rows[0].data.reconciliation.status, "MATCHED_INITIAL");
});

test("MISMATCH and QR_UNREADABLE queue, creator scope vs out-of-scope isolation, and direct resolutions (UPDATE_ENTERED_CCCD and STANDARDIZE_FROM_QR)", async () => {
  // Create an entry with CCCD 079095007733 and blank display_name
  const created = await createBatchV2(
    ACTORS.owner,
    "worker-profile/1.2",
    [
      {
        project_id: projectId,
        first_work_date: "2026-04-03",
        recruiter_id: recruiterId,
        provider_type: "hrp",
        labor_type: "TEMPORARY",
        display_name: "",
        worker_details: {
          gender: { state: "omitted" },
          date_of_birth: { state: "omitted" },
          national_id: { state: "provided", value: "079095007733" },
          national_id_issued_at: { state: "omitted" },
          national_id_issued_place: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "omitted" },
        },
        general_note: { state: "omitted" },
        payment: null,
        employment: { initial_status: "ON" },
      },
    ],
    "11111111-1111-4111-8111-000000000006",
  );
  const entryId = created.entry_ids[0];

  const front = await reserveAndFinalizeCccd(entryId, 1, "CCCD_FRONT", "mismatch-front");
  await db.query(
    "select public.direct_entry_prepare_cccd_qr_extraction($1::uuid, $2::uuid, $3::uuid, $4::uuid, null)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId, front.documentId],
  );

  // Complete QR with MISMATCH candidate ("079095009922" != "079095007733")
  const mismatched = await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', null, null, $5::jsonb, true, null, 'idem-mismatch-1') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      front.documentId,
      JSON.stringify(QR_CANDIDATE_MISMATCH),
    ],
  );
  assert.equal(mismatched.rows[0].data.reconciliation.status, "MISMATCH");
  assert.deepEqual(mismatched.rows[0].data.extraction.applied_fields, []);

  // Verify worker_details was NOT modified on MISMATCH (display_name is still "", national_id is still "079095007733")
  const { rows: afterMismatch } = await db.query(
    "select version, worker_details from public.direct_entries where entry_id = $1",
    [entryId],
  );
  assert.equal(afterMismatch[0].worker_details.display_name, "");
  assert.equal(afterMismatch[0].worker_details.national_id.value, "079095007733");

  // 1. Creator (ACTORS.owner) sees the entry in NEEDS_REVIEW / MISMATCH queue
  const ownerQueue = await db.query(
    "select public.direct_entry_list_cccd_review_queue($1::uuid, $2::uuid, 'MISMATCH', 1, 20) as data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id],
  );
  const queueItem = ownerQueue.rows[0].data.items.find((item) => item.entry_id === entryId);
  assert.ok(queueItem, "creator must see their own created MISMATCH entry in review queue");
  assert.equal(queueItem.reconciliation_status, "MISMATCH");
  assert.equal(queueItem.entered_national_id, "079095007733");
  assert.equal(queueItem.entered_national_id_masked, "••••••••7733");
  assert.equal(queueItem.qr_national_id, "079095009922");
  assert.equal(queueItem.qr_national_id_masked, "••••••••9922");
  assert.ok(["project_manager", "creator_own"].includes(queueItem.actor_authority));

  // 2. Unrelated recruiter (ACTORS.otherOwner) does NOT see ACTORS.owner's entry in the review queue
  //    and is denied from resolving it
  const otherQueue = await db.query(
    "select public.direct_entry_list_cccd_review_queue($1::uuid, $2::uuid, 'ALL', 1, 50) as data",
    [ACTORS.otherOwner.auth_subject, ACTORS.otherOwner.app_user_id],
  );
  assert.equal(
    otherQueue.rows[0].data.items.some((item) => item.entry_id === entryId),
    false,
    "unrelated recruiter must not see out-of-scope worker CCCD in review queue",
  );
  await assert.rejects(
    db.query(
      "select public.direct_entry_resolve_cccd_review($1::uuid, $2::uuid, $3::uuid, $4::integer, 'UPDATE_ENTERED_CCCD', $5::jsonb, 'idem-other-deny')",
      [
        ACTORS.otherOwner.auth_subject,
        ACTORS.otherOwner.app_user_id,
        entryId,
        afterMismatch[0].version,
        JSON.stringify({ national_id: "079095009922", apply_blank_fields_from_qr: true }),
      ],
    ),
    (err) => err.code === "42501",
  );
  await assert.rejects(
    db.query(
      "select public.direct_entry_apply_cccd_manual_resolution($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, 'idem-manual-deny')",
      [
        ACTORS.otherOwner.auth_subject,
        ACTORS.otherOwner.app_user_id,
        entryId,
        afterMismatch[0].version,
        JSON.stringify({ national_id: "079095009922", display_name: "Tên ngoài phạm vi" }),
      ],
    ),
    (err) => err.code === "42501",
  );

  // 3. Creator resolves via UPDATE_ENTERED_CCCD to match QR ("079095009922") with apply_blank_fields_from_qr = true
  const resolvedUpdate = await db.query(
    "select public.direct_entry_resolve_cccd_review($1::uuid, $2::uuid, $3::uuid, $4::integer, 'UPDATE_ENTERED_CCCD', $5::jsonb, 'idem-resolve-update-1') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      afterMismatch[0].version,
      JSON.stringify({
        national_id: "079095009922",
        apply_blank_fields_from_qr: true,
        note: "Sửa lại số CCCD bị gõ nhầm",
      }),
    ],
  );
  assert.equal(resolvedUpdate.rows[0].data.reconciliation.status, "RESOLVED_EDITED_CCCD");
  assert.equal(resolvedUpdate.rows[0].data.reused, false);
  assert.ok(resolvedUpdate.rows[0].data.changed_fields.includes("national_id"));
  assert.ok(resolvedUpdate.rows[0].data.changed_fields.includes("display_name"));

  // Replay with same idempotency key returns reused = true
  const replayedUpdate = await db.query(
    "select public.direct_entry_resolve_cccd_review($1::uuid, $2::uuid, $3::uuid, $4::integer, 'UPDATE_ENTERED_CCCD', $5::jsonb, 'idem-resolve-update-1') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      afterMismatch[0].version,
      JSON.stringify({
        national_id: "079095009922",
        apply_blank_fields_from_qr: true,
        note: "Sửa lại số CCCD bị gõ nhầm",
      }),
    ],
  );
  assert.equal(replayedUpdate.rows[0].data.reused, true);

  const manualPayload = {
    national_id: "079095004466",
    display_name: "Nguyễn Thị Minh Anh",
    date_of_birth: "09/12/1998",
    gender: "FEMALE",
    address: null,
    national_id_issued_at: "10/02/2024",
    reason: "Đã đối chiếu CCCD bản chính với người lao động",
  };
  const manualResolution = await db.query(
    "select public.direct_entry_apply_cccd_manual_resolution($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, 'idem-manual-save-1') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      resolvedUpdate.rows[0].data.entry_version,
      JSON.stringify(manualPayload),
    ],
  );
  assert.equal(manualResolution.rows[0].data.action, "MANUAL_UPDATE_DETAILS");
  assert.equal(manualResolution.rows[0].data.reconciliation.status, "RESOLVED_EDITED_CCCD");
  assert.equal(manualResolution.rows[0].data.reconciliation.resolution_action, "MANUAL_UPDATE_DETAILS");
  assert.ok(manualResolution.rows[0].data.changed_fields.includes("national_id"));
  const afterLateQr = await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', null, null, $5::jsonb, true, null, 'idem-qr-after-manual') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      front.documentId,
      JSON.stringify({
        ...QR_CANDIDATE_MISMATCH,
        national_id: manualPayload.national_id,
        address: "Địa chỉ lấy từ QR đến muộn",
      }),
    ],
  );
  assert.equal(afterLateQr.rows[0].data.reconciliation.status, "RESOLVED_EDITED_CCCD");
  assert.equal(afterLateQr.rows[0].data.reconciliation.resolution_action, "MANUAL_UPDATE_DETAILS");
  const manualReplay = await db.query(
    "select public.direct_entry_apply_cccd_manual_resolution($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, 'idem-manual-save-1') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId,
      resolvedUpdate.rows[0].data.entry_version,
      JSON.stringify(manualPayload),
    ],
  );
  assert.equal(manualReplay.rows[0].data.reused, true);
  await assert.rejects(
    db.query(
      "select public.direct_entry_apply_cccd_manual_resolution($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, 'idem-manual-stale')",
      [
        ACTORS.owner.auth_subject,
        ACTORS.owner.app_user_id,
        entryId,
        resolvedUpdate.rows[0].data.entry_version,
        JSON.stringify(manualPayload),
      ],
    ),
    (err) => err.code === "PT409",
  );
  const { rows: manuallySaved } = await db.query(
    "select version, worker_details from public.direct_entries where entry_id = $1",
    [entryId],
  );
  assert.equal(manuallySaved[0].worker_details.national_id.value, manualPayload.national_id);
  assert.equal(manuallySaved[0].worker_details.display_name, manualPayload.display_name);
  assert.equal(manuallySaved[0].worker_details.date_of_birth.value, manualPayload.date_of_birth);
  assert.equal(manuallySaved[0].worker_details.gender.value, "FEMALE");
  assert.equal(manuallySaved[0].worker_details.address.state, "omitted");
  assert.equal(manuallySaved[0].worker_details.national_id_issued_at.value, manualPayload.national_id_issued_at);
  assert.equal(manuallySaved[0].worker_details.phone.state, "omitted");
  const { rows: manualAudit } = await db.query(
    "select action, changed_fields from public.direct_entry_audit_events where resource_ref = $1 and action = 'cccd_review_manual_update_worker_details'",
    [entryId],
  );
  assert.equal(manualAudit.length, 1);
  assert.ok(manualAudit[0].changed_fields.includes("address"));

  // 4. Test STANDARDIZE_FROM_QR on a second MISMATCH entry
  const created2 = await createBatchV2(
    ACTORS.owner,
    "worker-profile/1.2",
    [
      {
        project_id: projectId,
        first_work_date: "2026-04-04",
        recruiter_id: recruiterId,
        provider_type: "hrp",
        labor_type: "TEMPORARY",
        display_name: "Tên Nhập Tay Cũ",
        worker_details: {
          gender: { state: "omitted" },
          date_of_birth: { state: "omitted" },
          national_id: { state: "provided", value: "079095006644" },
          national_id_issued_at: { state: "omitted" },
          national_id_issued_place: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "omitted" },
        },
        general_note: { state: "omitted" },
        payment: null,
        employment: { initial_status: "ON" },
      },
    ],
    "11111111-1111-4111-8111-000000000007",
  );
  const entryId2 = created2.entry_ids[0];
  const front2 = await reserveAndFinalizeCccd(entryId2, 1, "CCCD_FRONT", "std-front");
  await db.query(
    "select public.direct_entry_prepare_cccd_qr_extraction($1::uuid, $2::uuid, $3::uuid, $4::uuid, null)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId2, front2.documentId],
  );
  await db.query(
    "select public.direct_entry_complete_cccd_qr_extraction(" +
      "$1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUCCEEDED', null, null, $5::jsonb, true, null, 'idem-std-qr') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId2,
      front2.documentId,
      JSON.stringify({
        ...QR_CANDIDATE_MATCH,
        national_id: "079095005566",
        display_name: "Tên Chuẩn Theo QR",
      }),
    ],
  );

  const standardized = await db.query(
    "select public.direct_entry_resolve_cccd_review($1::uuid, $2::uuid, $3::uuid, $4::integer, 'STANDARDIZE_FROM_QR', $5::jsonb, 'idem-std-resolve') as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      entryId2,
      front2.entryVersion,
      JSON.stringify({
        fields: ["national_id", "display_name", "date_of_birth", "gender", "address", "national_id_issued_at"],
        note: "Chuẩn hóa toàn bộ theo QR CCCD",
      }),
    ],
  );
  assert.equal(standardized.rows[0].data.reconciliation.status, "RESOLVED_FROM_QR");
  const { rows: afterStd } = await db.query(
    "select worker_details from public.direct_entries where entry_id = $1",
    [entryId2],
  );
  assert.equal(afterStd[0].worker_details.display_name, "Tên Chuẩn Theo QR");
  assert.equal(afterStd[0].worker_details.national_id.value, "079095005566");
  assert.equal(afterStd[0].worker_details.gender.value, "FEMALE");
});

test("PRE-W2-HF migration aligns owners and keeps direct_entry_create_full_profile_batch_with_portrait_stages idempotent on replay", async () => {
  assert.ok(
    migrations.migrationNames.includes("20261026210000_pre_w2_hf_form_save_owner_and_stage_alignment.sql"),
    "migration inventory includes 20261026210000_pre_w2_hf_form_save_owner_and_stage_alignment.sql",
  );

  const stageId = "e8000000-0000-4000-8000-000000000001";
  const stageCreateKey = "e9000000-0000-4000-8000-000000000001";
  const batchIdemKey = "ea000000-0000-4000-8000-000000000001";

  await db.query(
    "select public.direct_entry_create_worker_document_stage_idempotent(" +
      "$1::uuid, $2::uuid, $3::uuid, 'WORKER_PORTRAIT', 'image/jpeg', 512, $4, $5)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, stageId, "b".repeat(64), stageCreateKey],
  );
  await db.query(
    "select public.direct_entry_claim_worker_portrait_stage($1::uuid, $2::uuid, $3::uuid, $4::text)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, stageId, batchIdemKey],
  );

  const rowsPayload = [
    {
      project_id: projectId,
      first_work_date: "2026-04-04",
      recruiter_id: recruiterId,
      provider_type: "hrp",
      labor_type: "TEMPORARY",
      display_name: "",
      worker_details: {
        gender: { state: "provided", value: "MALE" },
        date_of_birth: { state: "omitted" },
        national_id: { state: "provided", value: "079095007788" },
        national_id_issued_at: { state: "omitted" },
        national_id_issued_place: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      },
      general_note: { state: "omitted" },
      payment: null,
      employment: { initial_status: "ON" },
    },
  ];

  const firstCall = await db.query(
    "select public.direct_entry_create_full_profile_batch_with_portrait_stages(" +
      "$1::uuid, $2::uuid, 'worker-profile/1.2', $3::jsonb, $4::text, $5::uuid[]) as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      JSON.stringify(rowsPayload),
      batchIdemKey,
      [stageId],
    ],
  );
  assert.equal(firstCall.rows[0].data.entry_ids.length, 1);
  assert.equal(firstCall.rows[0].data.replayed, false);

  const replayedCall = await db.query(
    "select public.direct_entry_create_full_profile_batch_with_portrait_stages(" +
      "$1::uuid, $2::uuid, 'worker-profile/1.2', $3::jsonb, $4::text, $5::uuid[]) as data",
    [
      ACTORS.owner.auth_subject,
      ACTORS.owner.app_user_id,
      JSON.stringify(rowsPayload),
      batchIdemKey,
      [stageId],
    ],
  );
  assert.equal(replayedCall.rows[0].data.submission_id, firstCall.rows[0].data.submission_id);
  assert.equal(replayedCall.rows[0].data.replayed, true);
});

