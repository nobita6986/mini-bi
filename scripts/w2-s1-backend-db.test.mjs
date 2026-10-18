import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTORS,
  createMigratedDatabase,
  mutate,
  seedSubmissionReadFixture,
} from "./lib/s04c-submission-read-fixture.mjs";

const migrations = await createMigratedDatabase();
const db = migrations.db;
const fixture = await seedSubmissionReadFixture(db);
const entryId = fixture.draft.entryIds[0];
const privileged = {
  auth_subject: "11000000-0000-4000-8000-000000000006",
  app_user_id: "21000000-0000-4000-8000-000000000006",
};

await db.query("insert into auth.users(id) values ($1)", [privileged.auth_subject]);
await db.query(
  "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name)" +
  " values ($1,$2,true,'Synthetic Privileged Actor')",
  [privileged.app_user_id, privileged.auth_subject],
);
await db.query(
  "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
  " values ($1,'entry_privileged_edit','2020-01-01'),($1,'document_view','2020-01-01')",
  [privileged.app_user_id],
);
await db.query(
  "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from)" +
  " values ($1,'all','2020-01-01')",
  [privileged.app_user_id],
);
await db.query(
  "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
  " values ($1,'document_view','2020-01-01')",
  [ACTORS.otherOwner.app_user_id],
);

test("migration #114 follows the W2S1 portrait stage migration without changing earlier guards", async () => {
  assert.equal(migrations.migrationNames.length, 114);
  assert.equal(migrations.migrationNames.at(-2),
    "20261018090000_w2_s1_worker_portrait_enrollment_staging.sql");
  assert.equal(migrations.migrationNames.at(-1),
    "20261018110000_w2_s1_portrait_stage_recovery_cccd_scope.sql");
  assert.equal(migrations.migrationNames.at(-4),
    "20261017100000_pre_w2_s1_worker_portrait_private_projection.sql");
  assert.equal(migrations.migrationNames.at(-3),
    "20261017110000_pre_w2_s1_document_direct_context_access_guard.sql");
  for (const role of ["anon", "authenticated", "service_role"]) {
    const { rows } = await db.query(
      "select has_table_privilege($1,'public.direct_entry_candidates','UPDATE') allowed",
      [role],
    );
    assert.equal(rows[0].allowed, false, `${role} cannot change portrait origin`);
  }
  const { rows } = await db.query(
    "select p.prosecdef, has_function_privilege('anon',p.oid,'EXECUTE') anon_exec," +
    " has_function_privilege('authenticated',p.oid,'EXECUTE') auth_exec," +
    " has_function_privilege('service_role',p.oid,'EXECUTE') service_exec" +
    " from pg_proc p where p.oid=" +
    "'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)'::regprocedure",
  );
  assert.deepEqual(rows[0], {
    prosecdef: true, anon_exec: false, auth_exec: false, service_exec: true,
  });
});

test("privileged edit scope reads the entry while an actor outside scope is denied", async () => {
  const allowed = await db.query(
    "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) data",
    [privileged.auth_subject, privileged.app_user_id, entryId],
  );
  assert.equal(allowed.rows[0].data.entry_id, entryId);
  assert.equal(allowed.rows[0].data.scope_kind, "all");

  await assert.rejects(db.query(
    "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid)",
    [ACTORS.otherOwner.auth_subject, ACTORS.otherOwner.app_user_id, entryId],
  ), (error) => error.code === "42501");
});

test("portrait upload uses the existing reservation/finalize lifecycle and snapshots current version", async () => {
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
    " values ($1,'document_upload','2020-01-01'),($1,'document_view','2020-01-01')",
    [ACTORS.owner.app_user_id],
  );
  const { rows: entryRows } = await db.query(
    "select version from public.direct_entries where entry_id=$1",
    [entryId],
  );
  const reserved = await db.query(
    "select public.direct_entry_reserve_document_direct_upload(" +
    "$1::uuid,$2::uuid,$3::uuid,$4::integer,'WORKER_PORTRAIT'," +
    "'w2s1-portrait-reserve',512,'image/jpeg',null) data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId, entryRows[0].version],
  );
  const reservation = reserved.rows[0].data;
  assert.equal(reservation.upload_status, "QUEUED");
  assert.match(reservation.storage_key, /\/WORKER_PORTRAIT\/1\//);

  const finalized = await db.query(
    "select public.direct_entry_finalize_document_direct_upload(" +
    "$1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::integer," +
    "'w2s1-portrait-finalize','validated',$6,256,'image/jpeg') data",
    [
      ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId,
      reservation.document_id, reservation.entry_version, "a".repeat(64),
    ],
  );
  assert.equal(finalized.rows[0].data.upload_status, "READY");

  const context = await db.query(
    "select public.direct_entry_document_direct_context(" +
    "$1::uuid,$2::uuid,$3::uuid,$4::uuid,'preview') data",
    [
      ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId, reservation.document_id,
    ],
  );
  assert.equal(context.rows[0].data.document_type, "WORKER_PORTRAIT");
  assert.equal(context.rows[0].data.size_bytes, 256);
  assert.equal(context.rows[0].data.checksum_sha256, "a".repeat(64));

  const projection = await db.query(
    "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, entryId],
  );
  assert.deepEqual(projection.rows[0].data.worker_portrait, {
    origin: "ENROLLMENT",
    added_at: null,
    status: "READY",
    current: {
      document_id: reservation.document_id,
      version: 1,
      checksum_sha256: "a".repeat(64),
      mime_type: "image/jpeg",
      size_bytes: 256,
    },
  });
  assert.equal(
    projection.rows[0].data.documents.some(({ document_type }) =>
      document_type === "WORKER_PORTRAIT"),
    false,
  );

  const { rows: revisions } = await db.query(
    "select after_snapshot from public.direct_entry_revisions" +
    " where entry_id=$1 order by version desc limit 1",
    [entryId],
  );
  assert.deepEqual(revisions[0].after_snapshot.worker_portrait, {
    origin: "ENROLLMENT",
    added_at: null,
    current: {
      document_id: reservation.document_id,
      version: 1,
      checksum_sha256: "a".repeat(64),
      mime_type: "image/jpeg",
      size_bytes: 256,
    },
  });
});

test("document context keeps downloads draft-scoped and limits privileged fallback to portrait preview", async () => {
  const projectManager = {
    auth_subject: "11000000-0000-4000-8000-000000000007",
    app_user_id: "21000000-0000-4000-8000-000000000007",
  };
  await db.query("insert into auth.users(id) values ($1)", [projectManager.auth_subject]);
  await db.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name)" +
    " values ($1,$2,true,'Synthetic Project Manager')",
    [projectManager.app_user_id, projectManager.auth_subject],
  );
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
    " values ($1,'document_view','2020-01-01')",
    [projectManager.app_user_id],
  );
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links" +
    "(app_user_id,recruiter_id,verified,valid_from) values ($1,$2,true,'2020-01-01')",
    [projectManager.app_user_id, "93000000-0000-4000-8000-0000000000c1"],
  );
  await db.query(
    "insert into public.direct_entry_project_manager_assignments(project_id,manager_recruiter_id)" +
    " values ('s02c_project','93000000-0000-4000-8000-0000000000c1')",
  );

  const submittedEntryId = fixture.submitted.entryIds[0];
  const { rows: candidateRows } = await db.query(
    "select candidate_id from public.direct_entries where entry_id=$1",
    [submittedEntryId],
  );
  const cccdId = "b3000000-0000-4000-8000-000000000001";
  await db.query(
    "insert into public.direct_entry_document_versions" +
    "(document_id,candidate_id,document_type,version,idempotency_key,checksum_sha256," +
    "size_bytes,mime_type,storage_key,upload_status,scan_status,created_by_user_id)" +
    " values ($1,$2,'CCCD_FRONT',1,'w2s1_scope_cccd', $3,128,'image/jpeg',$4," +
    "'READY','CLEAN',$5)",
    [
      cccdId, candidateRows[0].candidate_id, "c".repeat(64),
      `p1.6/${candidateRows[0].candidate_id}/CCCD_FRONT/1/${cccdId}`,
      ACTORS.owner.app_user_id,
    ],
  );
  await db.query(
    "insert into public.direct_entry_document_events" +
    "(document_id,upload_status,scan_status,validation_status,attempts)" +
    " values ($1,'READY','CLEAN','VALIDATED',1)",
    [cccdId],
  );

  const ownerDownload = await db.query(
    "select public.direct_entry_document_direct_context(" +
    "$1::uuid,$2::uuid,$3::uuid,$4::uuid,'download') data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, submittedEntryId, cccdId],
  );
  assert.equal(ownerDownload.rows[0].data.document_type, "CCCD_FRONT");
  assert.equal(ownerDownload.rows[0].data.storage_key,
    `p1.6/${candidateRows[0].candidate_id}/CCCD_FRONT/1/${cccdId}`,
    "a creator with valid draft scope and document_view retains the existing download context");

  const deniedManagerDownload = await mutate(
    db,
    "select public.direct_entry_document_direct_context(" +
      "$1::uuid,$2::uuid,$3::uuid,$4::uuid,'download') data",
    [projectManager.auth_subject, projectManager.app_user_id, submittedEntryId, cccdId],
  );
  assert.equal(deniedManagerDownload.error?.code, "42501",
    "project-manager read scope plus document_view is not a substitute for draft download scope");
  assert.equal(deniedManagerDownload.data, null,
    "a denied manager download returns no context and therefore no storage_key");
  const managerCccdPreview = await db.query(
    "select public.direct_entry_document_direct_context(" +
    "$1::uuid,$2::uuid,$3::uuid,$4::uuid,'cccd_preview') data",
    [projectManager.auth_subject, projectManager.app_user_id, submittedEntryId, cccdId],
  );
  assert.equal(managerCccdPreview.rows[0].data.document_type, "CCCD_FRONT",
    "document_view with server-resolved entry scope permits CCCD preview");
  await assert.rejects(
    db.query(
      "select public.direct_entry_document_direct_context(" +
      "$1::uuid,$2::uuid,$3::uuid,$4::uuid,'cccd_preview')",
      [ACTORS.otherOwner.auth_subject, ACTORS.otherOwner.app_user_id, submittedEntryId, cccdId],
    ),
    (error) => error.code === "42501",
    "CCCD preview is denied outside the entry scope",
  );
  await assert.rejects(
    db.query(
      "select public.direct_entry_document_direct_context(" +
      "$1::uuid,$2::uuid,$3::uuid,$4::uuid,'cccd_preview')",
      [ACTORS.noCapability.auth_subject, ACTORS.noCapability.app_user_id, submittedEntryId, cccdId],
    ),
    (error) => error.code === "42501",
    "CCCD preview requires document_view",
  );

  const { rows: portraitRows } = await db.query(
    "select d.document_id from public.direct_entry_document_versions d" +
    " join public.direct_entries e on e.candidate_id=d.candidate_id" +
    " join public.direct_entry_current_documents cd on cd.document_id=d.document_id" +
    " where e.entry_id=$1 and d.document_type='WORKER_PORTRAIT'",
    [entryId],
  );
  const portraitId = portraitRows[0].document_id;
  const privilegedPreview = await db.query(
    "select public.direct_entry_document_direct_context(" +
    "$1::uuid,$2::uuid,$3::uuid,$4::uuid,'preview') data",
    [privileged.auth_subject, privileged.app_user_id, entryId, portraitId],
  );
  assert.equal(privilegedPreview.rows[0].data.document_type, "WORKER_PORTRAIT");
  assert.equal(typeof privilegedPreview.rows[0].data.storage_key, "string");

  await assert.rejects(
    db.query(
      "select public.direct_entry_document_direct_context(" +
      "$1::uuid,$2::uuid,$3::uuid,$4::uuid,'preview') data",
      [privileged.auth_subject, privileged.app_user_id, submittedEntryId, cccdId],
    ),
    (error) => error.code === "P0002",
    "even a scoped entry_privileged_edit actor cannot use private preview for CCCD",
  );
  await assert.rejects(
    db.query(
      "select public.direct_entry_document_direct_context(" +
      "$1::uuid,$2::uuid,$3::uuid,$4::uuid,'preview') data",
      [ACTORS.otherOwner.auth_subject, ACTORS.otherOwner.app_user_id, entryId, portraitId],
    ),
    (error) => error.code === "42501",
    "portrait preview remains denied outside the resolved or privileged entry scope",
  );
});

test("portrait enrollment stages enforce owner, MIME, replay, cancellation and attachment lifecycle", async () => {
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
    " select $1,'document_upload','2020-01-01' where not exists (" +
    " select 1 from public.direct_entry_capability_grants where app_user_id=$1" +
    " and capability='document_upload' and valid_to is null)",
    [ACTORS.owner.app_user_id],
  );
  const stageId = "b5000000-0000-4000-8000-000000000001";
  const created = await db.query(
    "select public.direct_entry_create_worker_portrait_stage(" +
    "$1::uuid,$2::uuid,$3::uuid,'image/jpeg',256,$4) data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, stageId, "a".repeat(64)],
  );
  assert.deepEqual(created.rows[0].data, {
    stage_id: stageId,
    mime_type: "image/jpeg",
    size_bytes: 256,
    checksum_sha256: "a".repeat(64),
    status: "STAGED",
    claim_idempotency_key: null,
    entry_id: null,
    document_id: null,
  });
  await assert.rejects(
    db.query(
      "select public.direct_entry_create_worker_portrait_stage(" +
      "$1::uuid,$2::uuid,$3::uuid,'application/pdf',256,$4)",
      [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id,
        "b5000000-0000-4000-8000-000000000002", "a".repeat(64)],
    ),
    (error) => error.code === "22023",
  );

  await assert.rejects(
    db.query(
      "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,'save-key')",
      [ACTORS.otherOwner.auth_subject, ACTORS.otherOwner.app_user_id, stageId],
    ),
    (error) => error.code === "42501",
    "another actor cannot claim a staged image by guessing its UUID",
  );
  const claimed = await db.query(
    "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,'save-key') data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, stageId],
  );
  assert.equal(claimed.rows[0].data.status, "CLAIMED");
  assert.equal(claimed.rows[0].data.claim_idempotency_key, "save-key");
  await assert.rejects(
    db.query(
      "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,'different-key')",
      [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, stageId],
    ),
    (error) => error.code === "40001",
    "a stage cannot be replayed into a second batch",
  );
  assert.equal((await db.query(
    "select public.direct_entry_release_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,'save-key') data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, stageId],
  )).rows[0].data, true);
  assert.equal((await db.query(
    "select public.direct_entry_cancel_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid) data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, stageId],
  )).rows[0].data, true);
  const cancelled = await db.query(
    "select status from public.direct_entry_worker_portrait_stages where stage_id=$1",
    [stageId],
  );
  assert.equal(cancelled.rows[0].status, "CANCELLED");
  await assert.rejects(
    db.query(
      "select public.direct_entry_recover_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid)",
      [ACTORS.otherOwner.auth_subject, ACTORS.otherOwner.app_user_id, stageId],
    ),
    (error) => error.code === "42501",
    "another actor cannot recover a staged image by guessing its UUID",
  );

  const attachmentStageId = "b5000000-0000-4000-8000-000000000003";
  const existingPortrait = (await db.query(
    "select d.document_id,d.size_bytes,d.mime_type," +
    "coalesce(o.checksum_sha256,d.checksum_sha256) checksum" +
    " from public.direct_entry_document_versions d" +
    " join public.direct_entries e on e.candidate_id=d.candidate_id" +
    " left join public.direct_entry_document_objects o on o.document_id=d.document_id" +
    " where e.entry_id=$1 and d.document_type='WORKER_PORTRAIT' order by d.version desc limit 1",
    [entryId],
  )).rows[0];
  await db.query(
    "select public.direct_entry_create_worker_portrait_stage(" +
    "$1::uuid,$2::uuid,$3::uuid,$4::text,$5::bigint,$6::text)",
    [
      ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, attachmentStageId,
      existingPortrait.mime_type, existingPortrait.size_bytes, existingPortrait.checksum,
    ],
  );
  await db.query(
    "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,'save-key-2')",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, attachmentStageId],
  );
  assert.equal((await db.query(
    "select public.direct_entry_complete_worker_portrait_stage(" +
    "$1::uuid,$2::uuid,$3::uuid,'save-key-2',$4::uuid,$5::uuid) data",
    [
      ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, attachmentStageId,
      entryId, existingPortrait.document_id,
    ],
  )).rows[0].data, true);
  const attachedReplay = await db.query(
    "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,'save-key-2') data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, attachmentStageId],
  );
  assert.equal(attachedReplay.rows[0].data.status, "ATTACHED");
  assert.equal(attachedReplay.rows[0].data.entry_id, entryId);
  await assert.rejects(
    db.query(
      "select public.direct_entry_cancel_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid)",
      [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, attachmentStageId],
    ),
    (error) => error.code === "40001",
    "an attached portrait cannot be cancelled as an orphan",
  );
  assert.equal((await db.query(
    "select public.direct_entry_recover_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid) data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, attachmentStageId],
  )).rows[0].data.status, "ATTACHED",
  "recovering an attached stage cannot release its claim");

  const lostKeyStage = "b5000000-0000-4000-8000-000000000004";
  await db.query(
    "select public.direct_entry_create_worker_portrait_stage(" +
    "$1::uuid,$2::uuid,$3::uuid,'image/jpeg',256,$4)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, lostKeyStage, "c".repeat(64)],
  );
  await db.query(
    "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,'lost-key')",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, lostKeyStage],
  );
  const recoveredLostKey = await db.query(
    "select public.direct_entry_recover_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid) data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, lostKeyStage],
  );
  assert.equal(recoveredLostKey.rows[0].data.status, "STAGED",
    "an uncommitted/absent batch result safely releases the lost claim");
  const retriedClaim = await db.query(
    "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,'retry-key') data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, lostKeyStage],
  );
  assert.equal(retriedClaim.rows[0].data.status, "CLAIMED",
    "a released stage can be claimed for a retry");

  const committedStage = "b5000000-0000-4000-8000-000000000005";
  const committedKey = "b6000000-0000-4000-8000-000000000001";
  await db.query(
    "select public.direct_entry_create_worker_portrait_stage(" +
    "$1::uuid,$2::uuid,$3::uuid,'image/jpeg',256,$4)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, committedStage, "d".repeat(64)],
  );
  await db.query(
    "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,$4)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, committedStage, committedKey],
  );
  await db.query(
    "insert into public.direct_entry_rpc_idempotency" +
    "(app_user_id,action,idempotency_key,request_hash,result)" +
    " values ($1,'full_profile_batch_create_v2',$2,$3,'{\"entry_ids\":[]}'::jsonb)",
    [ACTORS.owner.app_user_id, committedKey, "e".repeat(64)],
  );
  const recoveredCommitted = await db.query(
    "select public.direct_entry_recover_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid) data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, committedStage],
  );
  assert.equal(recoveredCommitted.rows[0].data.status, "CLAIMED");
  assert.equal(recoveredCommitted.rows[0].data.claim_idempotency_key, committedKey,
    "a committed batch keeps the original key available for exact replay");
  assert.equal((await db.query(
    "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,$4) data",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, committedStage, committedKey],
  )).rows[0].data.status, "CLAIMED");

  const incompleteStage = "b5000000-0000-4000-8000-000000000008";
  const incompleteKey = "b6000000-0000-4000-8000-000000000002";
  await db.query(
    "select public.direct_entry_create_worker_portrait_stage(" +
    "$1::uuid,$2::uuid,$3::uuid,'image/jpeg',256,$4)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, incompleteStage, "e".repeat(64)],
  );
  await db.query(
    "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,$4)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, incompleteStage, incompleteKey],
  );
  await db.query(
    "insert into public.direct_entry_rpc_idempotency" +
    "(app_user_id,action,idempotency_key,request_hash,result)" +
    " values ($1,'full_profile_batch_create_v2',$2,$3,null)",
    [ACTORS.owner.app_user_id, incompleteKey, "f".repeat(64)],
  );
  await assert.rejects(
    db.query(
      "select public.direct_entry_recover_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid)",
      [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, incompleteStage],
    ),
    (error) => error.code === "40001",
    "an idempotency record with an incomplete result fails closed",
  );
  assert.equal((await db.query(
    "select status,claim_idempotency_key from public.direct_entry_worker_portrait_stages" +
    " where stage_id=$1",
    [incompleteStage],
  )).rows[0].status, "CLAIMED",
    "failed recovery never releases a possibly committed in-flight stage");

  const changeRequestActor = {
    auth_subject: "11000000-0000-4000-8000-000000000008",
    app_user_id: "21000000-0000-4000-8000-000000000008",
  };
  await db.query("insert into auth.users(id) values ($1)", [changeRequestActor.auth_subject]);
  await db.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name)" +
    " values ($1,$2,true,'Change Request Only')",
    [changeRequestActor.app_user_id, changeRequestActor.auth_subject],
  );
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
    " values ($1,'change_request_create','2020-01-01')",
    [changeRequestActor.app_user_id],
  );
  const deniedStage = "b5000000-0000-4000-8000-000000000006";
  await assert.rejects(
    db.query(
      "select public.direct_entry_create_worker_portrait_stage(" +
      "$1::uuid,$2::uuid,$3::uuid,'image/jpeg',256,$4)",
      [changeRequestActor.auth_subject, changeRequestActor.app_user_id, deniedStage, "f".repeat(64)],
    ),
    (error) => error.code === "42501",
    "change_request_create cannot create an upload stage",
  );
  await db.query(
    "insert into public.direct_entry_worker_portrait_stages" +
    "(stage_id,created_by_user_id,mime_type,size_bytes,checksum_sha256)" +
    " values ($1,$2,'image/jpeg',256,$3)",
    [deniedStage, changeRequestActor.app_user_id, "f".repeat(64)],
  );
  await assert.rejects(
    db.query(
      "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,'change-key')",
      [changeRequestActor.auth_subject, changeRequestActor.app_user_id, deniedStage],
    ),
    (error) => error.code === "42501",
    "change_request_create cannot claim an upload stage",
  );
  const deniedBatch = await mutate(
    db,
    "select public.direct_entry_create_full_profile_batch_with_portrait_stages(" +
    "$1::uuid,$2::uuid,'worker-profile/1.1','[]'::jsonb,$3,array[$4::uuid]) data",
    [
      changeRequestActor.auth_subject, changeRequestActor.app_user_id,
      "b7000000-0000-4000-8000-000000000001", deniedStage,
    ],
  );
  assert.equal(deniedBatch.error?.code, "42501",
    "change_request_create cannot call the stage-aware batch RPC");
  assert.equal((await db.query(
    "select status from public.direct_entry_worker_portrait_stages where stage_id=$1",
    [deniedStage],
  )).rows[0].status, "STAGED",
    "denied capability does not mutate the stage");

  const mismatchedStage = "b5000000-0000-4000-8000-000000000007";
  await db.query(
    "select public.direct_entry_create_worker_portrait_stage(" +
    "$1::uuid,$2::uuid,$3::uuid,'image/jpeg',257,$4)",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, mismatchedStage, "a".repeat(64)],
  );
  await db.query(
    "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,'mismatch-key')",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, mismatchedStage],
  );
  await assert.rejects(
    db.query(
      "select public.direct_entry_complete_worker_portrait_stage(" +
      "$1::uuid,$2::uuid,$3::uuid,'mismatch-key',$4::uuid,$5::uuid)",
      [
        ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, mismatchedStage,
        entryId, existingPortrait.document_id,
      ],
    ),
    (error) => error.code === "40001",
    "completion rejects a document whose size differs from the staged object",
  );

  const wrongChecksumStage = "b5000000-0000-4000-8000-000000000009";
  await db.query(
    "select public.direct_entry_create_worker_portrait_stage(" +
    "$1::uuid,$2::uuid,$3::uuid,$4::text,$5::bigint,$6::text)",
    [
      ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, wrongChecksumStage,
      existingPortrait.mime_type, existingPortrait.size_bytes, "9".repeat(64),
    ],
  );
  await db.query(
    "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,'checksum-key')",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, wrongChecksumStage],
  );
  await assert.rejects(
    db.query(
      "select public.direct_entry_complete_worker_portrait_stage(" +
      "$1::uuid,$2::uuid,$3::uuid,'checksum-key',$4::uuid,$5::uuid)",
      [
        ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, wrongChecksumStage,
        entryId, existingPortrait.document_id,
      ],
    ),
    (error) => error.code === "40001",
    "completion rejects a document whose checksum differs from the staged object",
  );

  const wrongEntryStage = "b5000000-0000-4000-8000-00000000000a";
  await db.query(
    "select public.direct_entry_create_worker_portrait_stage(" +
    "$1::uuid,$2::uuid,$3::uuid,$4::text,$5::bigint,$6::text)",
    [
      ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, wrongEntryStage,
      existingPortrait.mime_type, existingPortrait.size_bytes, existingPortrait.checksum,
    ],
  );
  await db.query(
    "select public.direct_entry_claim_worker_portrait_stage($1::uuid,$2::uuid,$3::uuid,'entry-key')",
    [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, wrongEntryStage],
  );
  await assert.rejects(
    db.query(
      "select public.direct_entry_complete_worker_portrait_stage(" +
      "$1::uuid,$2::uuid,$3::uuid,'entry-key',$4::uuid,$5::uuid)",
      [
        ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, wrongEntryStage,
        fixture.submitted.entryIds[0], existingPortrait.document_id,
      ],
    ),
    (error) => error.code === "40001",
    "completion rejects a portrait document attached to a different entry",
  );
});
