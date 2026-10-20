import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTORS,
  PROJECT_ID,
  RECRUITER_A,
  TEAM_A,
  TEAM_B,
  createChangeRequest,
  createMigratedDatabase,
  decideChangeRequest,
  item,
  listChangeRequests,
  listGlobalChangeRequestHistory,
  readChangeRequest,
  seedChangeRequestFixture,
  withdrawChangeRequest,
} from "./lib/s04c-read-fixture.mjs";

const R2_1_MIGRATION =
  "20261021120000_r2_1_change_request_queues_and_project_team_guard.sql";

test("R2.1 Change Request 4 queues + GLOBAL_AUDIT + historical proposer/decider boundaries", async () => {
  const { db, migrationNames } = await createMigratedDatabase();
  try {
    assert.ok(migrationNames.includes(R2_1_MIGRATION), "R2.1 migration is applied");
    const fixture = await seedChangeRequestFixture(db);

    // Create a second reviewer with all scope + change_review to verify REVIEWER_RESOLVED isolation
    const reviewerTwo = {
      auth_subject: "10000000-0000-4000-8000-000000000022",
      app_user_id: "20000000-0000-4000-8000-000000000022",
    };
    await db.query("insert into auth.users(id) values ($1)", [reviewerTwo.auth_subject]);
    await db.query(
      "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name)" +
        " values ($1,$2,true,'Reviewer Two')",
      [reviewerTwo.app_user_id, reviewerTwo.auth_subject],
    );
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current)" +
        " values ($1,'change_review','2020-01-01',true)",
      [reviewerTwo.app_user_id],
    );
    await db.query(
      "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from,is_current)" +
        " values ($1,'all','2020-01-01',true)",
      [reviewerTwo.app_user_id],
    );

    const storedA = (await db.query(
      "select version, worker_details from public.direct_entries where entry_id = $1",
      [fixture.entryA.entry_id],
    )).rows[0];
    const storedB = (await db.query(
      "select version, worker_details from public.direct_entries where entry_id = $1",
      [fixture.entryB.entry_id],
    )).rows[0];

    // 1. Proposer creates 4 requests:
    // - reqApproved (approved by ACTORS.reviewerAll)
    // - reqRejectedByTwo (rejected by reviewerTwo)
    // - reqWithdrawn (withdrawn by ACTORS.proposer while still PM)
    // - reqPending (remains PENDING)
    const reqApproved = await createChangeRequest(
      db,
      ACTORS.proposer,
      [item(fixture.entryA.entry_id, storedA.version, {
        worker_details: {
          ...storedA.worker_details,
          address: { state: "provided", value: "R2.1 approved address" },
        },
      })],
      "R2.1 approve request",
      "r2_1_req_approved",
    );
    assert.equal(reqApproved.error, null);
    assert.equal(
      (await decideChangeRequest(
        db,
        ACTORS.reviewerAll,
        reqApproved.data.request_id,
        "approve",
        1,
        "Approved by Reviewer 1",
        "r2_1_decide_approve_1",
      )).error,
      null,
    );

    const reqRejectedByTwo = await createChangeRequest(
      db,
      ACTORS.proposer,
      [item(fixture.entryB.entry_id, storedB.version, {
        worker_details: {
          ...storedB.worker_details,
          address: { state: "provided", value: "R2.1 rejected address" },
        },
      })],
      "R2.1 reject request",
      "r2_1_req_rejected",
    );
    assert.equal(reqRejectedByTwo.error, null);
    assert.equal(
      (await decideChangeRequest(
        db,
        reviewerTwo,
        reqRejectedByTwo.data.request_id,
        "reject",
        1,
        "Rejected by Reviewer 2",
        "r2_1_decide_reject_2",
      )).error,
      null,
    );

    const reqWithdrawn = await createChangeRequest(
      db,
      ACTORS.proposer,
      [item(fixture.entryB.entry_id, storedB.version, {
        worker_details: {
          ...storedB.worker_details,
          address: { state: "provided", value: "R2.1 withdrawn address" },
        },
      })],
      "R2.1 withdraw request",
      "r2_1_req_withdrawn",
    );
    assert.equal(reqWithdrawn.error, null);
    assert.equal(
      (await withdrawChangeRequest(
        db,
        ACTORS.proposer,
        reqWithdrawn.data.request_id,
        1,
        "r2_1_withdraw_1",
      )).error,
      null,
    );

    const updatedAVersion = (await db.query(
      "select version from public.direct_entries where entry_id = $1",
      [fixture.entryA.entry_id],
    )).rows[0].version;
    const reqPending = await createChangeRequest(
      db,
      ACTORS.proposer,
      [item(fixture.entryA.entry_id, updatedAVersion, {
        labor_type: "PERMANENT",
      })],
      "R2.1 pending request",
      "r2_1_req_pending",
    );
    assert.equal(reqPending.error, null);

    // 2. Verify the 4 queues while proposer still holds PM assignment:
    const proposerPending = await listChangeRequests(db, ACTORS.proposer, {
      pageSize: 50,
      state: "PROPOSER_PENDING",
    });
    assert.equal(proposerPending.error, null);
    assert.deepEqual(
      proposerPending.data.requests.map((r) => r.request_id),
      [reqPending.data.request_id],
    );
    assert.equal(proposerPending.data.requests[0].can_withdraw, true);
    assert.equal(proposerPending.data.requests[0].can_decide, false);

    const proposerResolved = await listChangeRequests(db, ACTORS.proposer, {
      pageSize: 50,
      state: "PROPOSER_RESOLVED",
    });
    assert.equal(proposerResolved.error, null);
    assert.deepEqual(
      proposerResolved.data.requests.map((r) => r.request_id).sort(),
      [
        reqApproved.data.request_id,
        reqRejectedByTwo.data.request_id,
        reqWithdrawn.data.request_id,
      ].sort(),
    );
    assert.ok(
      proposerResolved.data.requests.every((r) => !r.can_withdraw && !r.can_decide),
    );

    const reviewerOnePending = await listChangeRequests(db, ACTORS.reviewerAll, {
      pageSize: 50,
      state: "REVIEWER_PENDING",
    });
    assert.equal(reviewerOnePending.error, null);
    assert.deepEqual(
      reviewerOnePending.data.requests.map((r) => r.request_id),
      [reqPending.data.request_id],
    );
    assert.equal(reviewerOnePending.data.requests[0].can_decide, true);
    assert.equal(reviewerOnePending.data.requests[0].can_withdraw, false);

    // REVIEWER_RESOLVED is strictly keyed on decided_by_user_id = p_app_user_id:
    const reviewerOneResolved = await listChangeRequests(db, ACTORS.reviewerAll, {
      pageSize: 50,
      state: "REVIEWER_RESOLVED",
    });
    assert.equal(reviewerOneResolved.error, null);
    assert.deepEqual(
      reviewerOneResolved.data.requests.map((r) => r.request_id),
      [reqApproved.data.request_id],
      "Reviewer 1 only sees requests decided by Reviewer 1 in REVIEWER_RESOLVED",
    );

    const reviewerTwoResolved = await listChangeRequests(db, reviewerTwo, {
      pageSize: 50,
      state: "REVIEWER_RESOLVED",
    });
    assert.equal(reviewerTwoResolved.error, null);
    assert.deepEqual(
      reviewerTwoResolved.data.requests.map((r) => r.request_id),
      [reqRejectedByTwo.data.request_id],
      "Reviewer 2 only sees requests decided by Reviewer 2 in REVIEWER_RESOLVED",
    );

    // GLOBAL_AUDIT sees both terminal decided requests:
    const globalAudit = await listGlobalChangeRequestHistory(db, ACTORS.reviewerAll, {
      days: null,
    });
    assert.equal(globalAudit.error, null);
    assert.deepEqual(
      globalAudit.data.requests.map((r) => r.request_id).sort(),
      [reqApproved.data.request_id, reqRejectedByTwo.data.request_id].sort(),
    );

    // 3. Multi-authority self-approval prevention: give proposer change_review + all scope.
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current)" +
        " select $1,'change_review','2020-01-01',true" +
        " where not exists (select 1 from public.direct_entry_capability_grants where app_user_id=$1 and capability='change_review' and is_current)",
      [ACTORS.proposer.app_user_id],
    );
    await db.query(
      "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from,is_current)" +
        " select $1,'all','2020-01-01',true" +
        " where not exists (select 1 from public.direct_entry_scope_grants where app_user_id=$1 and scope_kind='all' and is_current)",
      [ACTORS.proposer.app_user_id],
    );
    const proposerAsReviewerPending = await listChangeRequests(db, ACTORS.proposer, {
      pageSize: 50,
      state: "REVIEWER_PENDING",
    });
    assert.deepEqual(
      proposerAsReviewerPending.data.requests,
      [],
      "proposer never sees their own pending request in REVIEWER_PENDING even with all+change_review",
    );
    await db.query(
      "delete from public.direct_entry_capability_grants where app_user_id = $1 and capability = 'change_review'",
      [ACTORS.proposer.app_user_id],
    );
    await db.query(
      "delete from public.direct_entry_scope_grants where app_user_id = $1 and scope_kind = 'all'",
      [ACTORS.proposer.app_user_id],
    );

    // 4. Revoke proposer's Project Manager assignment and verify historical visibility vs current entry boundary!
    await db.query(
      "update public.direct_entry_project_manager_assignments" +
        " set is_current = false, valid_to = '2026-10-01', revoked_at = now(), revoked_by_user_id = $1" +
        " where project_id = $2 and manager_recruiter_id = $3 and is_current",
      [ACTORS.admin.app_user_id, PROJECT_ID, RECRUITER_A],
    );

    // 4a. Unassigned proposer still sees their pending request in PROPOSER_PENDING,
    //     but can_withdraw is now FALSE and withdraw RPC rejects with 42501!
    const unassignedPending = await listChangeRequests(db, ACTORS.proposer, {
      pageSize: 50,
      state: "PROPOSER_PENDING",
    });
    assert.equal(unassignedPending.error, null);
    assert.equal(unassignedPending.data.requests.length, 1);
    assert.equal(unassignedPending.data.requests[0].request_id, reqPending.data.request_id);
    assert.equal(
      unassignedPending.data.requests[0].can_withdraw,
      false,
      "can_withdraw must be false after PM assignment is revoked",
    );
    assert.equal(unassignedPending.data.requests[0].can_decide, false);

    const unassignedPendingDetail = await readChangeRequest(
      db,
      ACTORS.proposer,
      reqPending.data.request_id,
    );
    assert.equal(unassignedPendingDetail.error, null);
    assert.equal(unassignedPendingDetail.data.can_withdraw, false);
    assert.equal(unassignedPendingDetail.data.can_decide, false);
    assert.equal(unassignedPendingDetail.data.request_reason, null);

    const deniedWithdraw = await withdrawChangeRequest(
      db,
      ACTORS.proposer,
      reqPending.data.request_id,
      1,
      "r2_1_unassigned_withdraw",
    );
    assert.equal(
      deniedWithdraw.error?.code,
      "42501",
      "withdraw mutation rejects unassigned proposer with 42501",
    );

    // 4b. Unassigned proposer still sees PROPOSER_RESOLVED and can read historical request details:
    const unassignedResolved = await listChangeRequests(db, ACTORS.proposer, {
      pageSize: 50,
      state: "PROPOSER_RESOLVED",
    });
    assert.equal(unassignedResolved.error, null);
    assert.equal(unassignedResolved.data.requests.length, 3);
    for (const reqId of [
      reqApproved.data.request_id,
      reqRejectedByTwo.data.request_id,
      reqWithdrawn.data.request_id,
    ]) {
      const detail = await readChangeRequest(db, ACTORS.proposer, reqId);
      assert.equal(detail.error, null, `unassigned proposer can read historical request ${reqId}`);
      assert.equal(detail.data.can_withdraw, false);
      assert.equal(detail.data.can_decide, false);
    }

    // 4c. Unassigned proposer CANNOT read the current worker profile or managed directory outside current scope
    // (when proposer's own-creator capability/scope is also revoked so proposer has zero current entry scope):
    await db.query(
      "update public.direct_entry_capability_grants set is_current = false where app_user_id = $1 and capability = 'entry_own'",
      [ACTORS.proposer.app_user_id],
    );
    await db.query(
      "update public.direct_entry_scope_grants set is_current = false where app_user_id = $1 and scope_kind = 'own'",
      [ACTORS.proposer.app_user_id],
    );
    await assert.rejects(
      db.query(
        "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid)",
        [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id, fixture.entryB.entry_id],
      ),
      (error) => error.code === "42501",
      "historical request visibility must NOT grant current worker profile read access outside current scope",
    );
    await assert.rejects(
      db.query(
        "select public.direct_entry_list_workers($1::uuid,$2::uuid,'managed',null,null,null,null,25,null)",
        [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id],
      ),
      (error) => error.code === "42501",
      "unassigned proposer cannot list managed worker directory",
    );

    // 4d. Disabled proposer fails closed on both list and detail:
    await db.query(
      "update public.direct_entry_app_users set enabled = false where app_user_id = $1",
      [ACTORS.proposer.app_user_id],
    );
    assert.equal(
      (await listChangeRequests(db, ACTORS.proposer, { state: "PROPOSER_RESOLVED" })).error?.code,
      "42501",
    );
    assert.equal(
      (await readChangeRequest(db, ACTORS.proposer, reqApproved.data.request_id)).error?.code,
      "42501",
    );
  } finally {
    await db.close();
  }
});

test("R2.1 P0: Team Leader cannot approve an ENTRY_FIELD change request moving project_id outside effective project-team scope", async () => {
  const { db } = await createMigratedDatabase();
  try {
    const fixture = await seedChangeRequestFixture(db);
    const unmappedProject = "r2_1_unmapped_project";
    await db.query(
      "insert into public.direct_entry_projects(project_id, display_name) values ($1, 'Unmapped Project')",
      [unmappedProject],
    );

    // Seed Team Leader for TEAM_A
    const leader = {
      auth_subject: "10000000-0000-4000-8000-000000000066",
      app_user_id: "20000000-0000-4000-8000-000000000066",
    };
    const leaderRecruiter = "30000000-0000-4000-8000-000000000066";
    await db.query("insert into auth.users(id) values ($1)", [leader.auth_subject]);
    await db.query(
      "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name)" +
        " values ($1,$2,true,'Team Leader A')",
      [leader.app_user_id, leader.auth_subject],
    );
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current)" +
        " values ($1,'team_manager_assign','2020-01-01',true)",
      [leader.app_user_id],
    );
    await db.query(
      "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from,is_current)" +
        " values ($1,'team',$2,'2020-01-01',true)",
      [leader.app_user_id, TEAM_A],
    );
    await db.query(
      "insert into public.recruiters(recruiter_id,display_name) values ($1,'Team Leader A')",
      [leaderRecruiter],
    );
    await db.query(
      "insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from,is_current)" +
        " values ($1,'hrp','2020-01-01',true)",
      [leaderRecruiter],
    );
    await db.query(
      "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from,is_current)" +
        " values ($1,$2,'2020-01-01',true)",
      [leaderRecruiter, TEAM_A],
    );
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links(app_user_id,recruiter_id,verified,valid_from,is_current)" +
        " values ($1,$2,true,'2020-01-01',true)",
      [leader.app_user_id, leaderRecruiter],
    );
    await db.query(
      "insert into public.direct_entry_team_leader_assignments(team_id,leader_app_user_id,leader_recruiter_id,valid_from,is_current)" +
        " values ($1,$2,$3,'2020-01-01',true)",
      [TEAM_A, leader.app_user_id, leaderRecruiter],
    );

    // Map PROJECT_ID <-> TEAM_A, but leave unmappedProject unmapped to TEAM_A
    await db.exec("begin");
    await db.query("select set_config('direct_entry.project_team_scope_marker', 'on', true)");
    await db.query(
      "insert into public.direct_entry_project_team_scopes" +
        " (project_id, team_id, valid_from, is_current, version, granted_by_user_id)" +
        " values ($1, $2, '2020-01-01', true, 1, $3)",
      [PROJECT_ID, TEAM_A, ACTORS.admin.app_user_id],
    );
    await db.exec("commit");

    const entryVersion = (await db.query(
      "select version from public.direct_entries where entry_id = $1",
      [fixture.entryA.entry_id],
    )).rows[0].version;

    // Proposer creates an ENTRY_FIELD request moving entryA to unmappedProject
    const crossProjectReq = await createChangeRequest(
      db,
      ACTORS.proposer,
      [item(fixture.entryA.entry_id, entryVersion, {
        project_id: unmappedProject,
      })],
      "Move entry to unmapped project",
      "r2_1_cross_project_req",
    );
    assert.equal(crossProjectReq.error, null);

    // Team Leader attempts to APPROVE the cross-project move -> MUST FAIL with 42501!
    const deniedApprove = await decideChangeRequest(
      db,
      leader,
      crossProjectReq.data.request_id,
      "approve",
      1,
      "Attempt cross-project approve",
      "r2_1_tl_cross_project_approve",
    );
    assert.equal(
      deniedApprove.error?.code,
      "42501",
      "Team Leader must be denied when approving an ENTRY_FIELD proposal moving project_id outside effective project-team scope",
    );

    // Entry project_id and version remain untouched
    const entryAfterDeny = (await db.query(
      "select project_id, version from public.direct_entries where entry_id = $1",
      [fixture.entryA.entry_id],
    )).rows[0];
    assert.equal(entryAfterDeny.project_id, PROJECT_ID);
    assert.equal(entryAfterDeny.version, entryVersion);

    // Now grant effective project-team scope for (unmappedProject, TEAM_A) and verify approval succeeds!
    await db.exec("begin");
    await db.query("select set_config('direct_entry.project_team_scope_marker', 'on', true)");
    await db.query(
      "insert into public.direct_entry_project_team_scopes" +
        " (project_id, team_id, valid_from, is_current, version, granted_by_user_id)" +
        " values ($1, $2, '2020-01-01', true, 1, $3)",
      [unmappedProject, TEAM_A, ACTORS.admin.app_user_id],
    );
    await db.exec("commit");
    const allowedApprove = await decideChangeRequest(
      db,
      leader,
      crossProjectReq.data.request_id,
      "approve",
      1,
      "Approve after project-team scope granted",
      "r2_1_tl_mapped_project_approve",
    );
    assert.equal(allowedApprove.error, null);
    assert.equal(allowedApprove.data.state, "APPROVED");

    // Verify Team Leader still appears in REVIEWER_RESOLVED for the request they decided
    const leaderResolved = await listChangeRequests(db, leader, {
      pageSize: 50,
      state: "REVIEWER_RESOLVED",
    });
    assert.equal(leaderResolved.error, null);
    assert.deepEqual(
      leaderResolved.data.requests.map((r) => r.request_id),
      [crossProjectReq.data.request_id],
    );
  } finally {
    await db.close();
  }
});

test("R2.1 direct_entry_resolve_direct_edit_authority is exception-free and preserves exact authority hierarchy", async () => {
  const { db } = await createMigratedDatabase();
  try {
    const fixture = await seedChangeRequestFixture(db);
    const { rows: srcRows } = await db.query(
      "select prosrc from pg_proc where oid = 'public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)'::regprocedure",
    );
    assert.equal(
      srcRows[0].prosrc.toLowerCase().includes("exception when"),
      false,
      "direct_entry_resolve_direct_edit_authority must not use subtransaction exception blocks",
    );

    // 1. Full Admin -> admin_all
    const fullAdmin = await db.query(
      "select public.direct_entry_resolve_direct_edit_authority($1,$2,$3,$4,$5,true,null) as auth",
      [ACTORS.admin.auth_subject, ACTORS.admin.app_user_id, fixture.entryA.created_by_user_id, TEAM_A, PROJECT_ID],
    );
    assert.equal(fullAdmin.rows[0].auth, "admin_all");

    // 2. Assigned Project Manager -> project_manager
    const pmAuth = await db.query(
      "select public.direct_entry_resolve_direct_edit_authority($1,$2,$3,$4,$5,false,null) as auth",
      [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id, fixture.entryA.created_by_user_id, TEAM_A, PROJECT_ID],
    );
    assert.equal(pmAuth.rows[0].auth, "project_manager");

    // 3. Team Leader for matching team -> team_leader
    const tlAuth = await db.query(
      "select public.direct_entry_resolve_direct_edit_authority($1,$2,$3,$4,$5,false,$4) as auth",
      [ACTORS.outsider.auth_subject, ACTORS.outsider.app_user_id, fixture.entryA.created_by_user_id, TEAM_A, "other_proj"],
    );
    assert.equal(tlAuth.rows[0].auth, "team_leader");

    // 4. Outsider without any authority -> null
    const deniedAuth = await db.query(
      "select public.direct_entry_resolve_direct_edit_authority($1,$2,$3,$4,$5,false,null) as auth",
      [ACTORS.outsider.auth_subject, ACTORS.outsider.app_user_id, fixture.entryA.created_by_user_id, TEAM_B, "other_proj"],
    );
    assert.equal(deniedAuth.rows[0].auth, null);
  } finally {
    await db.close();
  }
});
