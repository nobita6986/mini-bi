import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTORS,
  PROJECT_ID,
  RECRUITER_A,
  assertDataOk,
  createMigratedDatabase,
  mutate,
  seedChangeRequestFixture,
  transitionInput,
} from "./lib/s04c-read-fixture.mjs";

const AUTH = ACTORS.proposer.auth_subject;
const APP = ACTORS.proposer.app_user_id;
const DOC_CHECKSUM = "a".repeat(64);

async function createDraft(db, suffix, count = 1) {
  const codes = Array.from({ length: count }, (_, index) =>
    `hrp-2026-${String(700000 + Number(suffix) * 10 + index).padStart(6, "0")}`);
  const rows = codes.map((employee_code, index) => ({
    project_id: PROJECT_ID,
    first_work_date: "2026-10-15",
    employee_code,
    worker_details: {
      display_name: `Draft deletion ${suffix}-${index}`,
      date_of_birth: { state: "unknown" },
      national_id: { state: "unknown" },
      address: { state: "unknown" },
      phone: { state: "unknown" },
    },
    recruiter_id: RECRUITER_A,
    labor_type: "TEMPORARY",
  }));
  assertDataOk(await db.query(
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text) as data",
    [AUTH, APP, JSON.stringify(rows), `s122_create_${suffix}`],
  ));
  const { rows: entries } = await db.query(
    "select entry_id,submission_id,candidate_id,version from public.direct_entries" +
    " where employee_code=any($1::text[]) order by employee_code",
    [codes],
  );
  assert.equal(entries.length, count);
  return { submissionId: entries[0].submission_id, entries };
}

async function deleteSubmission(db, actor, submissionId, expectedVersion, key) {
  return mutate(db,
    "select public.direct_entry_delete_draft_submission($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text) as data",
    [actor.auth_subject, actor.app_user_id, submissionId, expectedVersion, key]);
}

test("draft submission deletion is owned, versioned, atomic, idempotent and cleanup-retryable", async () => {
  const { db } = await createMigratedDatabase();
  try {
    const fixture = await seedChangeRequestFixture(db, { submissionWorkflow: "draft" });
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
      " values ($1,'submission_create','2020-01-01')",
      [ACTORS.outsider.app_user_id],
    );

    const beforeDenied = await db.query(
      "select version,state from public.direct_entry_submissions where submission_id=$1",
      [fixture.submissionId],
    );
    const denied = await deleteSubmission(
      db, ACTORS.outsider, fixture.submissionId, 1, "s122_other_owner",
    );
    assert.equal(denied.error?.code, "42501", "same-scope non-owner cannot delete");
    assert.deepEqual((await db.query(
      "select version,state from public.direct_entry_submissions where submission_id=$1",
      [fixture.submissionId],
    )).rows, beforeDenied.rows);
    assert.equal((await db.query(
      "select count(*)::int n from public.direct_entry_rpc_idempotency" +
      " where app_user_id=$1 and action='draft_submission_delete'",
      [ACTORS.outsider.app_user_id],
    )).rows[0].n, 0);

    const entry = fixture.entryA;
    const candidate = (await db.query(
      "select candidate_id from public.direct_entries where entry_id=$1",
      [entry.entry_id],
    )).rows[0].candidate_id;
    const document = await db.query(
      "insert into public.direct_entry_document_versions (" +
      "candidate_id,document_type,version,idempotency_key,checksum_sha256,size_bytes,mime_type," +
      "storage_key,upload_status,scan_status,created_by_user_id" +
      ") values ($1,'CCCD_FRONT',1,'s122-document','" + DOC_CHECKSUM + "',100,'image/jpeg'," +
      "'p1.6/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/CCCD_FRONT/1/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'," +
      "'READY','CLEAN',$2) returning document_id",
      [candidate, APP],
    );
    const documentId = document.rows[0].document_id;
    const stageId = "c1220000-0000-4000-8000-000000000001";
    await db.query(
      "insert into public.direct_entry_worker_portrait_stages (" +
      "stage_id,created_by_user_id,document_type,mime_type,size_bytes,checksum_sha256,status," +
      "claim_idempotency_key,entry_id,document_id,submission_id" +
      ") values ($1,$2,'CCCD_FRONT','image/jpeg',100,$3,'ATTACHED','s122-claimed',$4,$5,$6)",
      [stageId, APP, DOC_CHECKSUM, entry.entry_id, documentId, fixture.submissionId],
    );

    const stale = await deleteSubmission(
      db, ACTORS.proposer, fixture.submissionId, 2, "s122_stale_version",
    );
    assert.equal(stale.error?.code, "PT409");
    assert.equal((await db.query(
      "select count(*)::int n from public.direct_entry_rpc_idempotency" +
      " where app_user_id=$1 and action='draft_submission_delete' and idempotency_key=$2",
      [APP, "s122_stale_version"],
    )).rows[0].n, 0, "stale OCC leaves no idempotency record");

    const countsBefore = (await db.query(
      "select (select count(*)::int from public.direct_entry_revisions where entry_id=any($1::uuid[])) entry_revisions," +
      " (select count(*)::int from public.direct_entry_submission_revisions where submission_id=$2) submission_revisions," +
      " (select count(*)::int from public.direct_entry_audit_events where resource_ref=$2::text) submission_audits",
      [[fixture.entryA.entry_id, fixture.entryB.entry_id], fixture.submissionId],
    )).rows[0];
    const deleted = await deleteSubmission(
      db, ACTORS.proposer, fixture.submissionId, 1, "s122_delete_success",
    );
    assert.equal(deleted.error, null);
    assert.deepEqual(deleted.data, {
      submission_id: fixture.submissionId,
      deleted: true,
      version: 2,
      entries_deleted: 2,
      cleanup_objects_queued: 3,
    });
    assert.deepEqual((await deleteSubmission(
      db, ACTORS.proposer, fixture.submissionId, 1, "s122_delete_success",
    )).data, deleted.data, "a retry returns the stored result");
    assert.equal((await deleteSubmission(
      db, ACTORS.proposer, fixture.submissionId, 2, "s122_delete_success",
    )).error?.code, "22023", "same key with another request hash conflicts");

    const { rows: [submissionAfter] } = await db.query(
      "select state,version,submitted_at from public.direct_entry_submissions where submission_id=$1",
      [fixture.submissionId],
    );
    assert.deepEqual(submissionAfter, { state: "DELETED", version: 2, submitted_at: null });
    const { rows: deletedEntries } = await db.query(
      "select deleted_at is not null as deleted,version from public.direct_entries" +
      " where submission_id=$1 order by entry_id",
      [fixture.submissionId],
    );
    assert.deepEqual(deletedEntries, [{ deleted: true, version: 2 }, { deleted: true, version: 2 }]);
    const countsAfter = (await db.query(
      "select (select count(*)::int from public.direct_entry_revisions where entry_id=any($1::uuid[])) entry_revisions," +
      " (select count(*)::int from public.direct_entry_submission_revisions where submission_id=$2) submission_revisions," +
      " (select count(*)::int from public.direct_entry_audit_events where resource_ref=$2::text) submission_audits",
      [[fixture.entryA.entry_id, fixture.entryB.entry_id], fixture.submissionId],
    )).rows[0];
    assert.equal(countsAfter.entry_revisions, countsBefore.entry_revisions + 2);
    assert.equal(countsAfter.submission_revisions, countsBefore.submission_revisions + 1);
    assert.equal(countsAfter.submission_audits, countsBefore.submission_audits + 1);

    const claimA = "d1220000-0000-4000-8000-000000000001";
    const claimed = await db.query(
      "select * from public.direct_entry_claim_submission_object_cleanup($1::uuid,10)",
      [claimA],
    );
    assert.equal(claimed.rows.length, 3);
    assert.equal(claimed.rows.filter(({ object_kind }) => object_kind === "PORTRAIT_STAGE")[0].stage_id, stageId);
    const retryId = claimed.rows.find(({ object_kind }) => object_kind === "DOCUMENT_FINAL").cleanup_id;
    const otherClaims = claimed.rows.filter(({ cleanup_id }) => cleanup_id !== retryId);
    for (const row of otherClaims) {
      assert.equal((await db.query(
        "select public.direct_entry_complete_submission_object_cleanup($1::uuid,$2::uuid) done",
        [row.cleanup_id, claimA],
      )).rows[0].done, true);
    }
    await db.query(
      "update public.direct_entry_submission_object_cleanup" +
      " set cleanup_lease_until=clock_timestamp()-interval '1 second' where cleanup_id=$1",
      [retryId],
    );
    const claimB = "d1220000-0000-4000-8000-000000000002";
    const retry = await db.query(
      "select * from public.direct_entry_claim_submission_object_cleanup($1::uuid,10)",
      [claimB],
    );
    assert.deepEqual(retry.rows.map(({ cleanup_id }) => cleanup_id), [retryId]);
    assert.equal((await db.query(
      "select public.direct_entry_complete_submission_object_cleanup($1::uuid,$2::uuid) done",
      [retryId, claimA],
    )).rows[0].done, false, "expired lease token cannot complete after re-claim");
    assert.equal((await db.query(
      "select public.direct_entry_complete_submission_object_cleanup($1::uuid,$2::uuid) done",
      [retryId, claimB],
    )).rows[0].done, true);

    const submitted = await createDraft(db, 1);
    const submit = transitionInput(
      ACTORS.proposer, submitted.submissionId, 1, "SUBMITTED", "s122_submitted_before_delete",
    );
    assertDataOk(await db.query(submit.sql, submit.values));
    const rejectedState = await deleteSubmission(
      db, ACTORS.proposer, submitted.submissionId, 2, "s122_submitted_delete",
    );
    assert.equal(rejectedState.error?.code, "55000");
    assert.deepEqual((await db.query(
      "select state,version from public.direct_entry_submissions where submission_id=$1",
      [submitted.submissionId],
    )).rows[0], { state: "SUBMITTED", version: 2 });

    const claimedStageSubmission = await createDraft(db, 2);
    const claimedStageId = "c1220000-0000-4000-8000-000000000002";
    await db.query(
      "insert into public.direct_entry_worker_portrait_stages (" +
      "stage_id,created_by_user_id,document_type,mime_type,size_bytes,checksum_sha256,status," +
      "claim_idempotency_key,submission_id" +
      ") values ($1,$2,'WORKER_PORTRAIT','image/jpeg',100,$3,'CLAIMED','s122-batch-key',$4)",
      [claimedStageId, APP, DOC_CHECKSUM, claimedStageSubmission.submissionId],
    );
    const processing = await deleteSubmission(
      db, ACTORS.proposer, claimedStageSubmission.submissionId, 1, "s122_processing_delete",
    );
    assert.equal(processing.error?.code, "55P03");
    assert.deepEqual((await db.query(
      "select state,version from public.direct_entry_submissions where submission_id=$1",
      [claimedStageSubmission.submissionId],
    )).rows[0], { state: "DRAFT", version: 1 });
    assert.equal((await db.query(
      "select count(*)::int n from public.direct_entry_rpc_idempotency" +
      " where app_user_id=$1 and action='draft_submission_delete' and idempotency_key=$2",
      [APP, "s122_processing_delete"],
    )).rows[0].n, 0);

    const atomic = await createDraft(db, 3, 2);
    const failCode = "hrp-2026-700031";
    await db.exec(`
      create function public.test_fail_second_submission_delete()
      returns trigger language plpgsql as $$
      begin
        if new.employee_code = '${failCode}' then
          raise exception 'synthetic row failure' using errcode = 'P0001';
        end if;
        return new;
      end
      $$;
      create trigger zz_test_fail_second_submission_delete
        before update on public.direct_entries
        for each row execute function public.test_fail_second_submission_delete();
    `);
    const revisionCount = (await db.query(
      "select count(*)::int n from public.direct_entry_revisions where entry_id=any($1::uuid[])",
      [atomic.entries.map(({ entry_id }) => entry_id)],
    )).rows[0].n;
    const atomicResult = await deleteSubmission(
      db, ACTORS.proposer, atomic.submissionId, 1, "s122_atomic_failure",
    );
    assert.equal(atomicResult.error?.code, "P0001");
    assert.equal((await db.query(
      "select count(*)::int n from public.direct_entries where submission_id=$1 and deleted_at is not null",
      [atomic.submissionId],
    )).rows[0].n, 0, "failure after one row update rolls the full statement back");
    assert.equal((await db.query(
      "select count(*)::int n from public.direct_entry_revisions where entry_id=any($1::uuid[])",
      [atomic.entries.map(({ entry_id }) => entry_id)],
    )).rows[0].n, revisionCount);
    assert.equal((await db.query(
      "select count(*)::int n from public.direct_entry_rpc_idempotency" +
      " where app_user_id=$1 and action='draft_submission_delete' and idempotency_key=$2",
      [APP, "s122_atomic_failure"],
    )).rows[0].n, 0);
    await db.exec(
      "drop trigger zz_test_fail_second_submission_delete on public.direct_entries;" +
      " drop function public.test_fail_second_submission_delete();",
    );

    const list = await db.query(
      "select public.direct_entry_list_own_submissions($1::uuid,$2::uuid,50,null,null) data",
      [AUTH, APP],
    );
    const items = list.rows[0].data.items;
    assert.equal(items.some(({ submission_id }) => submission_id === fixture.submissionId), false,
      "deleted submission is absent from own submission listing");
    const readDeleted = await mutate(db,
      "select public.direct_entry_read_own_submission($1::uuid,$2::uuid,$3::uuid) data",
      [AUTH, APP, fixture.submissionId]);
    assert.equal(readDeleted.error?.code, "P0002",
      "deleted submission is indistinguishable from missing at the read boundary");
  } finally {
    await db.close();
  }
});
