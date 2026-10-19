import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTORS,
  PROJECT_ID,
  RECRUITER_A,
  createChangeRequest,
  createMigratedDatabase,
  decideChangeRequest,
  item,
  readChangeRequest,
  seedChangeRequestFixture,
  transitionInput,
} from "./lib/s04c-read-fixture.mjs";

const VOID_MIGRATION = "20261019100000_hf_duplicate_entry_void_and_directory_document_download.sql";

async function createActor(db, actor, capabilities, scope = "all", teamId = null) {
  await db.query("insert into auth.users(id) values ($1)", [actor.auth_subject]);
  await db.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name)" +
      " values ($1,$2,true,'Synthetic reviewer')",
    [actor.app_user_id, actor.auth_subject],
  );
  for (const capability of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
        " values ($1,$2,'2020-01-01')",
      [actor.app_user_id, capability],
    );
  }
  await db.query(
    "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from)" +
      " values ($1,$2,$3,'2020-01-01')",
    [actor.app_user_id, scope, scope === "team" ? teamId : null],
  );
}

async function addSubmittedRows(db, count = 2) {
  const details = (name) => ({
    display_name: name,
    date_of_birth: { state: "unknown" },
    national_id: { state: "provided", value: "012345678901" },
    address: { state: "unknown" },
    phone: { state: "unknown" },
  });
  const codes = Array.from({ length: count }, (_, index) =>
    "hrp-2026-" + String(index + 3).padStart(6, "0"));
  const created = await db.query(
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text) as data",
    [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id,
      JSON.stringify(codes.map((employee_code) => ({
        project_id: PROJECT_ID,
        first_work_date: "2026-10-17",
        employee_code,
        worker_details: details(employee_code),
        recruiter_id: RECRUITER_A,
        labor_type: "TEMPORARY",
      }))), "hf_void_extra_batch"],
  );
  const submissionId = created.rows[0].data.submission_id;
  const duplicateState = (await db.query(
    "select public.direct_entry_submission_duplicate_cccd_preflight($1::uuid,$2::uuid,$3::uuid) data",
    [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id, submissionId],
  )).rows[0].data;
  if (duplicateState.conflict_count > 0) {
    await db.query(
      "select public.direct_entry_transition_submission_duplicate_cccd_confirmed" +
        "($1::uuid,$2::uuid,$3::uuid,1,'SUBMITTED','hf_void_extra_submit',$4::text,$5::int)",
      [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id, submissionId,
        duplicateState.fingerprint, duplicateState.conflict_count],
    );
  } else {
    const transition = transitionInput(ACTORS.proposer, submissionId, 1, "SUBMITTED", "hf_void_extra");
    await db.query(transition.sql, transition.values);
  }
  return (await db.query(
    "select entry_id, version from public.direct_entries where employee_code=any($1::text[]) order by employee_code",
    [codes],
  )).rows;
}

async function requestVoid(db, entry, key) {
  return createChangeRequest(db, ACTORS.proposer,
    [item(entry.entry_id, entry.version, {}, "ENTRY_VOID")],
    "Hồ sơ bị nhập trùng trong đợt tuyển dụng.", key);
}

async function callDuplicateReport(db) {
  const result = await db.query(
    "select public.direct_entry_duplicate_cccd_report($1::uuid,$2::uuid,1,25) as data",
    [ACTORS.admin.auth_subject, ACTORS.admin.app_user_id],
  );
  return result.rows[0].data;
}

test("#120 preserves document_view while adding bounded submitted-row download fallback", async () => {
  const { db, migrationNames } = await createMigratedDatabase();
  try {
    assert.equal(migrationNames.at(-2), VOID_MIGRATION);
    const fixture = await seedChangeRequestFixture(db);
    const viewer = {
      auth_subject: "10000000-0000-4000-8000-000000000020",
      app_user_id: "20000000-0000-4000-8000-000000000020",
    };
    await createActor(db, viewer, ["document_view"], "own");
    await db.query(
      "update public.direct_entry_app_user_recruiter_links set valid_to='2020-01-02'" +
        " where app_user_id=$1 and recruiter_id=$2",
      [ACTORS.proposer.app_user_id, RECRUITER_A],
    );
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links" +
        "(app_user_id,recruiter_id,verified,valid_from) values ($1,$2,true,'2020-01-02')",
      [viewer.app_user_id, RECRUITER_A],
    );
    const entry = (await db.query(
      "select entry_id,created_by_user_id,team_id,first_work_date from public.direct_entries where entry_id=$1",
      [fixture.entryA.entry_id],
    )).rows[0];
    const candidateId = (await db.query(
      "select candidate_id from public.direct_entries where entry_id=$1",
      [entry.entry_id],
    )).rows[0].candidate_id;
    const contractId = "d2000000-0000-4000-8000-000000000001";
    const cccdId = "d2000000-0000-4000-8000-000000000002";
    for (const [documentId, documentType] of [
      [contractId, "EMPLOYMENT_CONTRACT"], [cccdId, "CCCD_FRONT"],
    ]) {
      await db.query(
        "insert into public.direct_entry_document_versions" +
          "(document_id,candidate_id,document_type,version,idempotency_key,checksum_sha256," +
          "size_bytes,mime_type,storage_key,upload_status,scan_status,created_by_user_id)" +
          " values ($1,$2,$3,1,$4,$5,128,$6,$7,'READY','CLEAN',$8)",
        [documentId, candidateId, documentType, "hf_void_download_" + documentType,
          "d".repeat(64), documentType === "EMPLOYMENT_CONTRACT" ? "application/pdf" : "image/jpeg",
          `p1.6/${candidateId}/${documentType}/1/${documentId}`, ACTORS.proposer.app_user_id],
      );
      await db.query(
        "insert into public.direct_entry_document_events" +
          "(document_id,upload_status,scan_status,validation_status,attempts)" +
          " values ($1,'READY','CLEAN','VALIDATED',1)",
        [documentId],
      );
    }
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
        " values ($1,'document_view','2020-01-01') on conflict do nothing",
      [ACTORS.proposer.app_user_id],
    );
    const allowed = await db.query(
      "select public.direct_entry_assert_document_download_access($1,$2,$3,$4,$5,$6,$7) as scope",
      [viewer.auth_subject, viewer.app_user_id,
        entry.entry_id, contractId, entry.created_by_user_id, entry.team_id, entry.first_work_date],
    );
    assert.equal(allowed.rows[0].scope, "project",
      "submitted project manager read scope can reach the private document download guard");
    await assert.rejects(() => db.query(
      "select public.direct_entry_assert_document_download_access($1,$2,$3,$4,$5,$6,$7)",
      [ACTORS.outsider.auth_subject, ACTORS.outsider.app_user_id,
        entry.entry_id, contractId, entry.created_by_user_id, entry.team_id, entry.first_work_date],
    ), (error) => error.code === "42501");
    await assert.rejects(() => db.query(
      "select public.direct_entry_assert_document_download_access($1,$2,$3,$4,$5,$6,$7)",
      [viewer.auth_subject, viewer.app_user_id,
        entry.entry_id, cccdId, entry.created_by_user_id, entry.team_id, entry.first_work_date],
    ), (error) => error.code === "42501",
    "submitted read scope does not extend the existing draft-only CCCD download policy");

    const downloaded = await db.query(
      "select public.direct_entry_document_direct_context($1::uuid,$2::uuid,$3::uuid,$4::uuid,'download') as data",
      [viewer.auth_subject, viewer.app_user_id, entry.entry_id, contractId],
    );
    assert.equal(downloaded.rows[0].data.document_type, "EMPLOYMENT_CONTRACT",
      "the route's private document context can return a submitted worker's contract");
    await assert.rejects(() => db.query(
      "select public.direct_entry_document_direct_context($1::uuid,$2::uuid,$3::uuid,$4::uuid,'download')",
      [viewer.auth_subject, viewer.app_user_id, entry.entry_id, cccdId],
    ), (error) => error.code === "42501",
    "CCCD and other documents remain draft-guarded");

    const { rows } = await db.query(
      "select pg_get_functiondef($1::regprocedure) context, " +
        "pg_get_functiondef('public.direct_entry_assert_document_download_access(uuid,uuid,uuid,uuid,uuid,uuid,date)'::regprocedure) helper",
      ["public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)"],
    );
    assert.match(rows[0].context, /direct_entry_assert_document_download_access/);
    assert.match(rows[0].context, /g\.capability = 'document_view'/,
      "the existing independent document_view check remains in the production context RPC");
    assert.match(rows[0].helper, /direct_entry_resolve_submission_read_scope/);
    assert.match(rows[0].helper, /direct_entry_assert_draft_access/);
    assert.match(rows[0].helper, /EMPLOYMENT_CONTRACT/);
  } finally {
    await db.close();
  }
});

test("approved ENTRY_VOID keeps history, accepts only the named reviewers, and decrements one hire exactly once", async () => {
  const { db } = await createMigratedDatabase();
  try {
    const fixture = await seedChangeRequestFixture(db);
    const extraRows = await addSubmittedRows(db);
    const entries = [
      { ...extraRows[0], code: "C" },
      { entry_id: fixture.entryA.entry_id, version: fixture.entryA.version, code: "A" },
      { entry_id: fixture.entryB.entry_id, version: fixture.entryB.version, code: "B" },
      { ...extraRows[1], code: "D" },
    ];
    const reviewerId = ACTORS.reviewer.app_user_id;
    const leaderRecruiterId = "93000000-0000-4000-8000-0000000000e1";
    await db.query(
      "insert into public.recruiters(recruiter_id,display_name) values ($1,'Synthetic team leader')",
      [leaderRecruiterId],
    );
    await db.query(
      "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)" +
        " values ($1,$2,'2020-01-01')",
      [leaderRecruiterId, fixture.entryA.team_id],
    );
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
        " values ($1,'team_manager_assign','2020-01-01')",
      [reviewerId],
    );
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links" +
        "(app_user_id,recruiter_id,verified,valid_from) values ($1,$2,true,'2020-01-01')",
      [reviewerId, leaderRecruiterId],
    );
    await db.exec("begin");
    await db.query("select set_config('direct_entry.team_leader_marker','on',true)");
    await db.query(
      "insert into public.direct_entry_team_leader_assignments" +
        "(team_id,leader_app_user_id,leader_recruiter_id,valid_from)" +
        " values ($1,$2,$3,'2020-01-01')",
      [fixture.entryA.team_id, reviewerId, leaderRecruiterId],
    );
    await db.exec("commit");

    const bod = ACTORS.reviewerAll;
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
        " values ($1,'entry_privileged_edit','2020-01-01')",
      [bod.app_user_id],
    );
    const accounting = {
      auth_subject: "10000000-0000-4000-8000-000000000021",
      app_user_id: "20000000-0000-4000-8000-000000000021",
    };
    await createActor(db, accounting, ["change_review"]);

    for (const app of [ACTORS.admin.app_user_id, ACTORS.reviewerAll.app_user_id]) {
      for (const capability of ["pii_view", "payment_view", "pii_export"]) {
        if (app === ACTORS.admin.app_user_id || capability !== "pii_view") {
          await db.query(
            "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
              " values ($1,$2,'2020-01-01') on conflict do nothing",
            [app, capability],
          );
        }
      }
    }

    const unauthorized = await createChangeRequest(db, ACTORS.proposer,
      [item(entries[0].entry_id, entries[0].version, {}, "ENTRY_VOID"),
        item(entries[1].entry_id, entries[1].version, {}, "ENTRY_VOID")],
      "must be rejected", "hf-void-multi");
    assert.equal(unauthorized.error.code, "22023", "void requests are one exact row only");
    const forgedProposal = await createChangeRequest(db, ACTORS.proposer,
      [item(entries[0].entry_id, entries[0].version, { deleted_at: "forged" }, "ENTRY_VOID")],
      "must be rejected", "hf-void-forged");
    assert.equal(forgedProposal.error.code, "22023", "client cannot supply state or audit fields");

    const beforeTotal = (await db.query(
      "select coalesce(sum(recruited_count),0)::int n from public.direct_entry_reporting_facts_v01",
    )).rows[0].n;
    assert.equal(beforeTotal, entries.length);
    assert.equal((await callDuplicateReport(db)).groups.length, 1,
      "two active submitted duplicate profiles appear before void approval");

    const leadersForOtherTeam = {
      auth_subject: "10000000-0000-4000-8000-000000000022",
      app_user_id: "20000000-0000-4000-8000-000000000022",
    };
    await createActor(db, leadersForOtherTeam, ["team_manager_assign"], "team",
      "94000000-0000-4000-8000-00000000000b");
    const otherLeaderRecruiterId = "93000000-0000-4000-8000-0000000000e2";
    await db.query(
      "insert into public.recruiters(recruiter_id,display_name) values ($1,'Synthetic other leader')",
      [otherLeaderRecruiterId],
    );
    await db.query(
      "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)" +
        " values ($1,$2,'2020-01-01')",
      [otherLeaderRecruiterId, "94000000-0000-4000-8000-00000000000b"],
    );
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links" +
        "(app_user_id,recruiter_id,verified,valid_from) values ($1,$2,true,'2020-01-01')",
      [leadersForOtherTeam.app_user_id, otherLeaderRecruiterId],
    );
    await db.exec("begin");
    await db.query("select set_config('direct_entry.team_leader_marker','on',true)");
    await db.query(
      "insert into public.direct_entry_team_leader_assignments" +
        "(team_id,leader_app_user_id,leader_recruiter_id,valid_from)" +
        " values ($1,$2,$3,'2020-01-01')",
      ["94000000-0000-4000-8000-00000000000b", leadersForOtherTeam.app_user_id,
        otherLeaderRecruiterId],
    );
    await db.exec("commit");

    const reviewers = [
      { actor: ACTORS.reviewer, expectedAuditCapability: "team_manager_assign", name: "team leader" },
      { actor: bod, expectedAuditCapability: "entry_privileged_edit", name: "BoD" },
      { actor: accounting, expectedAuditCapability: "change_review", name: "accounting" },
      { actor: ACTORS.admin, expectedAuditCapability: "entry_admin", name: "Admin" },
    ];
    let total = beforeTotal;
    for (let index = 0; index < reviewers.length; index += 1) {
      const entry = entries[index];
      const beforeStatusCount = (await db.query(
        "select count(*)::int n from public.direct_entry_employment_status_events where entry_id=$1",
        [entry.entry_id],
      )).rows[0].n;
      const created = await requestVoid(db, entry, "hf-void-create-" + index);
      assert.equal(created.error, null, "original submitter can request row " + entry.code);
      const duplicatePending = await requestVoid(db, entry, "hf-void-duplicate-" + index);
      assert.equal(duplicatePending.error.code, "40001", "only one pending void request per row");

      const selfReview = await decideChangeRequest(db, ACTORS.proposer, created.data.request_id,
        "approve", 1, "self review", "hf-void-self-" + index);
      assert.equal(selfReview.error.code, "42501", "proposer cannot review their own request");
      if (index === 0) {
        const wrongTeam = await decideChangeRequest(db, leadersForOtherTeam, created.data.request_id,
          "approve", 1, "wrong team", "hf-void-wrong-team");
        assert.equal(wrongTeam.error.code, "42501", "team leader cannot decide another team's request");
      }

      const approved = await decideChangeRequest(db, reviewers[index].actor, created.data.request_id,
        "approve", 1, "đã xác minh hồ sơ bị nhập trùng", "hf-void-approve-" + index);
      assert.equal(approved.error, null, reviewers[index].name + " can approve an eligible request");
      assert.equal(approved.data.state, "APPROVED");
      const nextTotal = (await db.query(
        "select coalesce(sum(recruited_count),0)::int n from public.direct_entry_reporting_facts_v01",
      )).rows[0].n;
      assert.equal(nextTotal, total - 1,
        "approving one duplicate decreases canonical recruitment count by exactly one");
      total = nextTotal;

      const retained = (await db.query(
        "select count(*)::int n, bool_and(deleted_at is null) retained," +
          " bool_and(voided_at is not null and voided_by_user_id=$2 and void_reason_id is not null) voided" +
          " from public.direct_entries where entry_id=$1",
        [entry.entry_id, reviewers[index].actor.app_user_id],
      )).rows[0];
      assert.deepEqual(retained, { n: 1, retained: true, voided: true },
        "void keeps the original row and stores who/reason instead of soft deletion");
      assert.equal((await db.query(
        "select count(*)::int n from public.direct_entry_employment_status_events where entry_id=$1",
        [entry.entry_id],
      )).rows[0].n, beforeStatusCount,
      "void is not implemented as an employment-status transition");

      const itemAudit = (await db.query(
        "select capability from public.direct_entry_audit_events" +
          " where resource_ref=$1 and action='change_request_approve' order by created_at desc limit 1",
        [entry.entry_id],
      )).rows[0];
      assert.equal(itemAudit.capability, reviewers[index].expectedAuditCapability,
        "audit records the actual authority used");
      const history = await readChangeRequest(db, ACTORS.proposer, created.data.request_id);
      assert.equal(history.error, null);
      assert.equal(history.data.items[0].target_kind, "ENTRY_VOID");
      assert.deepEqual(history.data.items[0].proposal, {});
      if (index === 0) assert.equal((await callDuplicateReport(db)).groups.length, 0,
        "the void row no longer participates in active duplicate reporting");
    }

    assert.equal(total, 0);
    const directory = await db.query(
      "select public.direct_entry_list_workers($1::uuid,$2::uuid,'all',null,null,null,null,25) as data",
      [ACTORS.admin.auth_subject, ACTORS.admin.app_user_id],
    );
    assert.equal(directory.rows[0].data.items.length, 0,
      "void rows do not appear in the normal worker directory");
    const exported = await db.query(
      "select public.direct_entry_export_workers($1::uuid,$2::uuid,'all',null,null,null,'void regression') as data",
      [ACTORS.admin.auth_subject, ACTORS.admin.app_user_id],
    );
    assert.equal(exported.rows[0].data.status, "ok");
    assert.equal(exported.rows[0].data.rows.length, 0,
      "void rows do not appear in worker export");
    assert.equal((await db.query(
      "select count(*)::int n from public.direct_entries where entry_id=any($1::uuid[]) and deleted_at is null and voided_at is not null",
      [entries.map((entry) => entry.entry_id)],
    )).rows[0].n, entries.length, "source records remain available for audited history");
  } finally {
    await db.close();
  }
});
