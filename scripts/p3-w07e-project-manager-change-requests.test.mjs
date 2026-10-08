import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTORS,
  PROJECT_ID,
  RECRUITER_B,
  createChangeRequest,
  decideChangeRequest,
  item,
  listChangeRequests,
  mutate,
  readChangeRequest,
  seedChangeRequestFixture,
  transitionInput,
  withdrawChangeRequest,
} from "./lib/s04c-read-fixture.mjs";
import {
  listOwnSubmissions,
  readOwnSubmission,
  createMigratedDatabase,
} from "./lib/s04c-submission-read-fixture.mjs";

const PROJECT_MANAGER = {
  auth_subject: "a1000000-0000-4000-8000-000000000021",
  app_user_id: "a2000000-0000-4000-8000-000000000021",
};
const OUTSIDE_PROJECT = "s02b_unassigned_project";
const OUTSIDE_CODE = "hrp-2026-399999";

function worker(displayName) {
  const optional = { state: "unknown" };
  return {
    display_name: displayName,
    date_of_birth: optional,
    national_id: optional,
    address: optional,
    phone: optional,
  };
}

async function seedProjectManager(db) {
  await db.query("insert into auth.users(id) values ($1)", [PROJECT_MANAGER.auth_subject]);
  await db.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name) values ($1,$2,true,'Synthetic Account')",
    [PROJECT_MANAGER.app_user_id, PROJECT_MANAGER.auth_subject],
  );
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links" +
    " (app_user_id,recruiter_id,verified,valid_from) values ($1,$2,true,'2020-01-01')",
    [PROJECT_MANAGER.app_user_id, RECRUITER_B],
  );
  await db.query(
    "insert into public.direct_entry_project_manager_assignments(project_id,manager_recruiter_id)" +
    " values ($1,$2)",
    [PROJECT_ID, RECRUITER_B],
  );
  const { rows } = await db.query(
    "select count(*)::int as total from public.direct_entry_capability_grants" +
    " where app_user_id = $1",
    [PROJECT_MANAGER.app_user_id],
  );
  assert.equal(rows[0].total, 0, "project assignment itself should enable proposal access");
}

async function createSubmittedRow(db, projectId, employeeCode, key) {
  const result = await mutate(db,
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text) as data",
    [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id,
      JSON.stringify([{
        project_id: projectId,
        first_work_date: "2026-10-15",
        employee_code: employeeCode,
        worker_details: worker("W07E " + employeeCode),
        recruiter_id: RECRUITER_B,
        labor_type: "TEMPORARY",
      }]), key]);
  if (result.error) throw new Error("fixture create failed: " + result.error.message);
  const { rows } = await db.query(
    "select e.entry_id,e.submission_id,e.version from public.direct_entries e where e.employee_code=$1",
    [employeeCode],
  );
  assert.equal(rows.length, 1);
  for (const [target, suffix] of [["REVIEW", "review"], ["SUBMITTED", "submit"]]) {
    const transition = transitionInput(
      ACTORS.proposer, rows[0].submission_id, target === "REVIEW" ? 1 : 2, target,
      key + "_" + suffix,
    );
    await db.query(transition.sql, transition.values);
  }
  return rows[0];
}

test("current project assignment exposes submitted rows for proposals, but not direct writes or files", async () => {
  const migrated = await createMigratedDatabase();
  const db = migrated.db;
  try {
    assert.equal(migrated.migrationNames.length, 63);
    const initialWorkerDetails = worker("S02B worker1");
    initialWorkerDetails.date_of_birth = { state: "provided", value: "01/01/2000" };
    initialWorkerDetails.national_id = { state: "provided", value: "000000000000" };
    const fixture = await seedChangeRequestFixture(db, {
      workerDetailsForFirstEntry: initialWorkerDetails,
    });
    await seedProjectManager(db);

    await db.query(
      "insert into public.direct_entry_projects(project_id,display_name) values ($1,'Outside Project')",
      [OUTSIDE_PROJECT],
    );
    const outside = await createSubmittedRow(db, OUTSIDE_PROJECT, OUTSIDE_CODE, "w07e_outside");

    const listed = await listOwnSubmissions(db, PROJECT_MANAGER, { pageSize: 20, state: "SUBMITTED" });
    assert.equal(listed.error, null);
    assert.equal(listed.data.items.length, 1);
    assert.equal(listed.data.items[0].submission_id, fixture.submissionId);
    assert.equal(listed.data.items[0].entry_count, 2);
    assert.equal(listed.data.items[0].project_scoped, true);

    const detail = await readOwnSubmission(db, PROJECT_MANAGER, fixture.submissionId);
    assert.equal(detail.error, null);
    assert.equal(detail.data.project_scoped, true);
    assert.deepEqual(detail.data.entry_ids, [fixture.entryA.entry_id, fixture.entryB.entry_id].sort());
    assert.equal(detail.data.entry_count, 2);
    assert.equal((await readOwnSubmission(db, PROJECT_MANAGER, outside.submission_id)).error.code, "P0002");
    assert.equal((await listOwnSubmissions(db, ACTORS.outsider, { pageSize: 20 })).error.code, "42501");

    await db.query(
      "insert into public.direct_entry_payments" +
      " (entry_id,state,account_number,bank_id,account_holder_name)" +
      " values ($1,'provided','123456789','s02b_bank','Synthetic Holder')",
      [fixture.entryA.entry_id],
    );
    const projection = await db.query(
      "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as data",
      [PROJECT_MANAGER.auth_subject, PROJECT_MANAGER.app_user_id, fixture.entryA.entry_id],
    );
    assert.equal(projection.rows[0].data.scope_kind, "project");
    assert.equal(projection.rows[0].data.worker_details.display_name, "S02B worker1");
    assert.equal(projection.rows[0].data.worker_details.date_of_birth.value, "01/01/2000");
    assert.equal(projection.rows[0].data.worker_details.national_id.value, "000000000000");
    assert.equal(projection.rows[0].data.payment.account_number, "123456789");
    assert.equal(projection.rows[0].data.payment.account_holder_name, "Synthetic Holder");
    assert.deepEqual(projection.rows[0].data.documents, []);

    const w04Proposal = {
      ...initialWorkerDetails,
      address: { state: "provided", value: "W04 proposed address" },
    };
    const projectChange = await createChangeRequest(db, PROJECT_MANAGER,
      [item(fixture.entryA.entry_id, fixture.entryA.version, { worker_details: w04Proposal })],
      "W07E project manager proposes a normal field change", "w07e_project_field");
    assert.equal(projectChange.error, null);
    const beforeApproval = await db.query(
      "select worker_details->'address'->>'value' as address from public.direct_entries where entry_id=$1",
      [fixture.entryA.entry_id]);
    assert.equal(beforeApproval.rows[0].address, null);
    const managerRequests = await listChangeRequests(db, PROJECT_MANAGER, { pageSize: 20 });
    assert.equal(managerRequests.error, null);
    assert.equal(managerRequests.data.requests.length, 1);
    assert.equal(managerRequests.data.requests[0].request_id, projectChange.data.request_id);
    assert.equal(managerRequests.data.requests[0].can_withdraw, true);
    assert.equal(managerRequests.data.requests[0].can_decide, false);
    assert.equal((await readChangeRequest(db, PROJECT_MANAGER, projectChange.data.request_id)).error, null);
    assert.equal((await withdrawChangeRequest(db, PROJECT_MANAGER, projectChange.data.request_id,
      1, "w07e_project_field_withdraw")).error, null);

    const paymentChange = await createChangeRequest(db, PROJECT_MANAGER,
      [item(fixture.entryB.entry_id, fixture.entryB.version, {
        state: "provided", account_number: "123456789", bank_id: "s02b_bank",
        account_holder_name: "Synthetic Holder",
      }, "PAYMENT")], "W07E project manager proposes payment change", "w07e_project_payment");
    assert.equal(paymentChange.error, null);
    assert.equal((await withdrawChangeRequest(db, PROJECT_MANAGER, paymentChange.data.request_id,
      1, "w07e_project_payment_withdraw")).error, null);

    const statusChange = await createChangeRequest(db, PROJECT_MANAGER,
      [item(fixture.entryA.entry_id, fixture.entryA.version, {
        status: "OFF", effective_date: "2026-10-15", leave_reason: "W07E test proposal",
      }, "WORK_STATUS")], "W07E project manager proposes status change", "w07e_project_status");
    assert.equal(statusChange.error, null);
    assert.equal((await withdrawChangeRequest(db, PROJECT_MANAGER, statusChange.data.request_id,
      1, "w07e_project_status_withdraw")).error, null);

    const documentChange = await createChangeRequest(db, PROJECT_MANAGER,
      [item(fixture.entryA.entry_id, fixture.entryA.version, {
        document_type: "CCCD", idempotency_key: "not-staged", checksum_sha256: "a".repeat(64),
        size_bytes: 1, mime_type: "image/jpeg",
      }, "DOCUMENT")], "W07E document route stays excluded", "w07e_project_document");
    assert.equal(documentChange.error.code, "42501");

    const finalProposal = await createChangeRequest(db, PROJECT_MANAGER,
      [item(fixture.entryA.entry_id, fixture.entryA.version, { worker_details: w04Proposal })],
      "W07E reviewer approval test", "w07e_project_reviewer");
    assert.equal(finalProposal.error, null);
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
      " values ($1,'change_review','2020-01-01')",
      [PROJECT_MANAGER.app_user_id],
    );
    await db.query(
      "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from)" +
      " values ($1,'all','2020-01-01')",
      [PROJECT_MANAGER.app_user_id],
    );
    const selfReview = await decideChangeRequest(db, PROJECT_MANAGER, finalProposal.data.request_id,
      "approve", 1, "Self-review must fail", "w07e_self_review");
    assert.equal(selfReview.error.code, "42501");
    // P2.5-W04: reviewing a worker_details proposal needs change_review + pii_view.
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
      " select $1::uuid,'pii_view','2020-01-01'" +
      " where not exists (select 1 from public.direct_entry_capability_grants g" +
      "  where g.app_user_id=$1::uuid and g.capability='pii_view')",
      [ACTORS.reviewerAll.app_user_id],
    );
    const approved = await decideChangeRequest(db, ACTORS.reviewerAll, finalProposal.data.request_id,
      "approve", 1, "Authorized reviewer approval", "w07e_reviewer_approve");
    assert.equal(approved.error, null);
    const afterApproval = await db.query(
      "select worker_details->'address'->>'value' as address from public.direct_entries where entry_id=$1",
      [fixture.entryA.entry_id]);
    assert.equal(afterApproval.rows[0].address, "W04 proposed address");

    const currentEntry = await db.query(
      "select version from public.direct_entries where entry_id=$1", [fixture.entryA.entry_id]);
    const changedWorkerDetails = {
      ...initialWorkerDetails,
      date_of_birth: { state: "provided", value: "02/02/2001" },
      address: { state: "provided", value: "Synthetic updated address" },
    };
    const workerChange = await createChangeRequest(db, PROJECT_MANAGER,
      [item(fixture.entryA.entry_id, currentEntry.rows[0].version, {
        worker_details: changedWorkerDetails,
      })], "W07E project manager proposes personal-data changes", "w07e_project_worker");
    assert.equal(workerChange.error, null);
    const beforeWorkerApproval = await db.query(
      "select worker_details->'date_of_birth'->>'value' as date_of_birth" +
      " from public.direct_entries where entry_id=$1", [fixture.entryA.entry_id]);
    assert.equal(beforeWorkerApproval.rows[0].date_of_birth, "01/01/2000");

    // Reviewer authorization stays explicit and target-specific; assignment does
    // not grant pii_view to the proposer or reviewer (already granted above).
    const workerApproved = await decideChangeRequest(db, ACTORS.reviewerAll,
      workerChange.data.request_id, "approve", 1, "Authorized PII reviewer approval",
      "w07e_reviewer_worker_approve");
    assert.equal(workerApproved.error, null);
    const afterWorkerApproval = await db.query(
      "select worker_details->'date_of_birth'->>'value' as date_of_birth," +
      " worker_details->'address'->>'value' as address" +
      " from public.direct_entries where entry_id=$1", [fixture.entryA.entry_id]);
    assert.deepEqual(afterWorkerApproval.rows[0], {
      date_of_birth: "02/02/2001", address: "Synthetic updated address",
    });
  } finally {
    await db.close();
  }
});
