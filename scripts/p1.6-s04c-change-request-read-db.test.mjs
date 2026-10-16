import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTORS,
  REQUEST_STAMPS,
  RECRUITER_A,
  createMigratedDatabase,
  createChangeRequest,
  decideChangeRequest,
  item,
  listChangeRequests,
  listGlobalChangeRequestHistory,
  readChangeRequest,
  setRequestDecidedAt,
  seedChangeRequestFixture,
  seedChangeRequests,
} from "./lib/s04c-read-fixture.mjs";

const LIST_RPC = "public.direct_entry_list_change_requests(uuid,uuid,integer,text,text)";
const READ_RPC = "public.direct_entry_read_change_request(uuid,uuid,uuid)";
const AUDIT_RPC = "public.direct_entry_list_global_change_request_history(uuid,uuid,integer,text,integer)";
const HELPER_RPCS = [
  "public.direct_entry_assert_actor_mapping(uuid,uuid)",
  "public.direct_entry_has_entry_access(uuid,text,uuid,uuid,date)",
  "public.direct_entry_change_request_audience(uuid,uuid,uuid)",
];

const migrations = await createMigratedDatabase();
const db = migrations.db;
const fixture = await seedChangeRequestFixture(db);
const requests = await seedChangeRequests(db, fixture);

test("from-scratch migration apply covers the new read migration and its ACLs", async () => {
  // P2-W04B migration #44 rebaselines the cutoff to 2026-10-06.
  // Main carries W07C-R2 (#45), W07C-R3 (#46) and P2-W04C (#47); W05A appends
  // as #49 after W07C-R7; W07E #50, P2.5-W02 #51 and P2.5-W03 #52.
  assert.equal(migrations.migrationNames.length, 111);
  assert.ok(migrations.migrationNames.includes("20261005010000_p1_6_w04_s04c_change_request_reads.sql"));
  assert.ok(migrations.migrationNames.includes(
    "20261005030000_p1_6_w04_s04c_s03b3_r1_change_policy_closure.sql"));
  assert.ok(migrations.migrationNames.includes(
    "20261016120000_pre_w2_team_leader_change_request_entry_read.sql"));
  assert.ok(migrations.migrationNames.includes(
    "20261016130000_pre_w2_personnel_catalog_team_names.sql"));
  assert.ok(migrations.migrationNames.includes(
    "20261016140000_pre_w2_team_leader_apply_change_item.sql"));
  assert.ok(migrations.migrationNames.includes(
    "20261016150000_pre_w2_global_change_request_review_history.sql"));
  for (const signature of [LIST_RPC, READ_RPC, AUDIT_RPC]) {
    const { rows } = await db.query(
      "select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as config," +
      " coalesce(bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE'), false) as public_exec," +
      " has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec," +
      " has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec," +
      " has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec" +
      " from pg_proc p left join lateral aclexplode(coalesce(p.proacl, acldefault('f'::\"char\", p.proowner))) a on true" +
      " where p.oid = $1::regprocedure group by p.oid",
      [signature],
    );
    assert.equal(rows.length, 1, signature);
    assert.equal(rows[0].prosecdef, true, signature);
    assert.equal(rows[0].config, "search_path=pg_catalog, public", signature);
    assert.equal(rows[0].public_exec, false, signature);
    assert.equal(rows[0].anon_exec, false, signature);
    assert.equal(rows[0].auth_exec, false, signature);
    assert.equal(rows[0].service_exec, true, signature);
  }
  for (const signature of HELPER_RPCS) {
    const { rows } = await db.query(
      "select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon_exec," +
      " has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth_exec," +
      " has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_exec",
      [signature],
    );
    assert.deepEqual(rows[0], { anon_exec: false, auth_exec: false, service_exec: false }, signature);
  }
  for (const table of [
    "direct_entry_change_requests",
    "direct_entry_change_request_items",
    "direct_entry_change_request_revisions",
    "direct_entry_rpc_idempotency",
    "direct_entry_audit_events",
  ]) {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const { rows } = await db.query(
        "select has_table_privilege($1, $2, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') as allowed",
        [role, "public." + table],
      );
      assert.equal(rows[0].allowed, false, role + " on " + table);
    }
  }
});

test("global audit is read-only, paginated, time-bounded, and limited to global reviewers/admins", async () => {
  const oldDecisionAt = (await db.query("select now() - interval '10 days' as stamp")).rows[0].stamp;
  await setRequestDecidedAt(db, requests.rejected, oldDecisionAt);
  const reviewer = await listGlobalChangeRequestHistory(db, ACTORS.reviewerAll, { days: 3 });
  assert.equal(reviewer.error, null);
  assert.equal(reviewer.data.requests.length, 1);
  assert.ok(reviewer.data.requests.every((item) => ["APPROVED", "REJECTED"].includes(item.state)));
  assert.ok(reviewer.data.requests.every((item) => item.decided_by_display_name === "Synthetic Account"));
  assert.ok(reviewer.data.requests.every((item) => typeof item.decided_at === "string"));
  assert.ok(reviewer.data.requests.every((item) => item.can_decide === false && item.can_withdraw === false));

  const admin = await listGlobalChangeRequestHistory(db, ACTORS.admin, { days: null });
  assert.equal(admin.error, null);
  assert.equal(admin.data.requests.length, 2);
  const detail = await readChangeRequest(db, ACTORS.admin, requests.approved);
  assert.equal(detail.error, null, "all-scope entry admins may inspect terminal audit details");
  assert.equal(detail.data.can_decide, false, "audit detail must never grant decision authority");
  assert.equal(detail.data.request_reason, "S02B request approved");
  const pendingDetail = await readChangeRequest(db, ACTORS.admin, requests.single);
  assert.equal(pendingDetail.error.code, "P0002", "audit-only access excludes pending requests");

  for (const actor of [ACTORS.reviewer, ACTORS.reviewerNoCapability, ACTORS.outsider]) {
    const denied = await listGlobalChangeRequestHistory(db, actor, { days: 7 });
    assert.equal(denied.error.code, "42501");
  }
  assert.equal((await listGlobalChangeRequestHistory(db, ACTORS.reviewerAll, { days: 2 })).error.code, "22023");

  const first = await listGlobalChangeRequestHistory(db, ACTORS.admin, { pageSize: 1, days: null });
  assert.equal(first.data.requests.length, 1);
  assert.equal(first.data.has_more, true);
  const second = await listGlobalChangeRequestHistory(db, ACTORS.admin, {
    pageSize: 1, cursor: first.data.next_cursor, days: null,
  });
  assert.equal(second.data.requests.length, 1);
  assert.equal(second.data.has_more, false);
  assert.notEqual(first.data.requests[0].request_id, second.data.requests[0].request_id);
});

test("proposer sees own requests with withdraw rights only while pending", async () => {
  const listed = await listChangeRequests(db, ACTORS.proposer, { pageSize: 50 });
  const page = listed.data;
  assert.equal(page.requests.length, 6);
  const byId = new Map(page.requests.map((item) => [item.request_id, item]));
  assert.equal(byId.get(requests.single).can_withdraw, true);
  assert.equal(byId.get(requests.single).can_decide, false);
  assert.equal(byId.get(requests.withdrawn).can_withdraw, false);
  assert.equal(byId.get(requests.rejected).can_withdraw, false);
  assert.equal(byId.get(requests.approved).can_withdraw, false);
  for (const item of page.requests) assert.equal(item.can_decide, false, item.request_id);
});

test("reviewer visibility needs change_review plus an effective all scope", async () => {
  // P2.5-W05 (#55): the reviewer audience is capability change_review plus an
  // effective all scope grant, so the C01-R2 team-scoped reviewer no longer sees the
  // queue. The all-scope reviewer keeps seeing every request.
  const teamReviewer = await listChangeRequests(db, ACTORS.reviewer, { pageSize: 50 });
  assert.deepEqual(teamReviewer.data.requests, [], "a team scope is not a reviewer audience");
  const allReviewer = await listChangeRequests(db, ACTORS.reviewerAll, { pageSize: 50 });
  assert.equal(allReviewer.data.requests.length, 6);
  for (const item of allReviewer.data.requests) {
    assert.equal(item.can_withdraw, false, item.request_id);
    assert.equal(item.can_decide, item.state === "PENDING", item.request_id);
  }
  const noCapability = await listChangeRequests(db, ACTORS.reviewerNoCapability, { pageSize: 50 });
  assert.deepEqual(noCapability.data.requests, []);
  const outsider = await listChangeRequests(db, ACTORS.outsider, { pageSize: 50 });
  assert.deepEqual(outsider.data.requests, []);
});

test("detail returns the same not-found code for unknown and out-of-scope requests", async () => {
  const unknown = await readChangeRequest(db, ACTORS.outsider,
    "d1000000-0000-4000-8000-0000000000ff");
  const outOfScope = await readChangeRequest(db, ACTORS.outsider, requests.single);
  const hiddenMulti = await readChangeRequest(db, ACTORS.reviewer, requests.multi);
  const hiddenTeam = await readChangeRequest(db, ACTORS.reviewer, requests.single);
  assert.equal(unknown.error.code, "P0002");
  assert.equal(outOfScope.error.code, "P0002");
  assert.equal(hiddenMulti.error.code, "P0002");
  assert.equal(hiddenTeam.error.code, "P0002",
    "P2.5-W05: a team-scoped reviewer cannot read the detail either");
  assert.equal(unknown.error.message, outOfScope.error.message);
  const ok = await readChangeRequest(db, ACTORS.reviewerAll, requests.single);
  assert.equal(ok.error, null);
  assert.deepEqual(Object.keys(ok.data).sort(), [
    "can_decide", "can_withdraw", "created_at", "items", "request_id", "request_reason",
    "state", "version",
  ]);
  assert.deepEqual(Object.keys(ok.data.items[0]).sort(), [
    "entry_id", "expected_version", "labor_type_display", "proposal", "target_kind",
  ]);
  // ACTORS.reviewerAll holds pii_view, so the reviewer sees the proposal payload;
  // the presence-only projection for a reviewer WITHOUT pii_view stays asserted in
  // p1.6-s04c-policy-closure-db.test.mjs (POLICY_ACTORS.entryOnly).
  assert.equal(typeof ok.data.items[0].proposal.worker_details.display_name, "string");
  assert.equal(ok.data.request_reason, "S02B request single");
  const proposerDetail = await readChangeRequest(db, ACTORS.proposer, requests.single);
  assert.equal(proposerDetail.error, null);
  assert.equal(proposerDetail.data.request_reason, null,
    "free-text reason is returned only to the reviewer audience");
  for (const leaked of ["idempotency_key", "checksum_sha256", "storage_key"]) {
    assert.equal(JSON.stringify(ok.data).includes(leaked), false, leaked + " must never leak");
  }
});

test("keyset pagination is deterministic without duplicates or gaps", async () => {
  const full = await listChangeRequests(db, ACTORS.proposer, { pageSize: 50 });
  const expected = full.data.requests.map((item) => item.request_id);
  assert.equal(expected.length, 6);
  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await listChangeRequests(db, ACTORS.proposer, { pageSize: 2, cursor });
    seen.push(...page.data.requests.map((item) => item.request_id));
    if (!page.data.has_more) {
      assert.equal(page.data.next_cursor, null);
      break;
    }
    cursor = page.data.next_cursor;
  }
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, seen.length);
  for (let index = 1; index < full.data.requests.length; index += 1) {
    const previous = full.data.requests[index - 1];
    const current = full.data.requests[index];
    assert.ok(
      previous.created_at > current.created_at ||
        (previous.created_at === current.created_at && previous.request_id > current.request_id),
      "ordering must be created_at DESC then request_id DESC at index " + index,
    );
  }
  const tiedIndexes = [requests.approved, requests.tied].map((id) => expected.indexOf(id));
  assert.equal(Math.abs(tiedIndexes[0] - tiedIndexes[1]), 1,
    "equal created_at items must be adjacent");
  assert.equal(REQUEST_STAMPS.approved, REQUEST_STAMPS.tied);
});

test("state filter, actor mapping and invalid query text fail closed", async () => {
  const pending = await listChangeRequests(db, ACTORS.proposer, { pageSize: 50, state: "PENDING" });
  assert.equal(pending.data.requests.length, 3);
  for (const item of pending.data.requests) assert.equal(item.state, "PENDING");
  const resolved = await listChangeRequests(db, ACTORS.reviewerAll,
    { pageSize: 50, state: "RESOLVED" });
  assert.equal(resolved.error, null);
  assert.equal(resolved.data.requests.length, 3);
  assert.ok(resolved.data.requests.every((item) => item.state !== "PENDING"));
  for (const [label, options] of [
    ["page_size", { pageSize: 51 }],
    ["cursor", { pageSize: 20, cursor: "nope" }],
    ["state", { pageSize: 20, state: "pending" }],
  ]) {
    const result = await listChangeRequests(db, ACTORS.proposer, options);
    assert.equal(result.error.code, "22023", label);
  }
  const mapping = await listChangeRequests(db,
    { auth_subject: ACTORS.proposer.auth_subject, app_user_id: ACTORS.reviewer.app_user_id }, {});
  assert.equal(mapping.error.code, "42501");
});

test("reviewer can read work-status leave reason while proposer projection stays redacted", async () => {
  const currentEntry = await db.query(
    "select version from public.direct_entries where entry_id = $1",
    [fixture.entryA.entry_id],
  );
  const request = await createChangeRequest(db, ACTORS.proposer, [item(
    fixture.entryA.entry_id, currentEntry.rows[0].version,
    { status: "OFF", effective_date: "2026-10-15", leave_reason: "Kết thúc công việc theo nguyện vọng" },
    "WORK_STATUS",
  )], "Cập nhật trạng thái theo xác nhận", "s02b_work_status_reason");
  assert.equal(request.error, null);
  const reviewer = await readChangeRequest(db, ACTORS.reviewerAll, request.data.request_id);
  assert.equal(reviewer.error, null);
  assert.equal(reviewer.data.request_reason, "Cập nhật trạng thái theo xác nhận");
  assert.equal(reviewer.data.items[0].proposal.leave_reason, "Kết thúc công việc theo nguyện vọng");
  const proposer = await readChangeRequest(db, ACTORS.proposer, request.data.request_id);
  assert.equal(proposer.error, null);
  assert.equal(proposer.data.request_reason, null);
  assert.equal("leave_reason" in proposer.data.items[0].proposal, false);
});

test("list projection exposes no sensitive columns", async () => {
  const listed = await listChangeRequests(db, ACTORS.proposer, { pageSize: 50 });
  for (const item of listed.data.requests) {
    assert.deepEqual(Object.keys(item).sort(), [
      "can_decide", "can_withdraw", "created_at", "entry_ids", "item_count",
      "proposer_display_name", "request_id", "state", "summary", "version",
    ]);
    assert.equal(item.item_count, item.entry_ids.length);
    assert.equal(item.proposer_display_name, "Synthetic Account");
    assert.equal(typeof item.summary, "string");
  }
  const serialized = JSON.stringify(listed.data);
  for (const forbidden of ["reason", "idempotency", "auth_subject", "app_user_id",
    "proposer_user_id", "decided_by_user_id", "audit", "account_number", "national_id"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("assigned Team Leader sees only same-team requests and can reject a stale one", async () => {
  const leader = {
    auth_subject: "10000000-0000-4000-8000-000000000006",
    app_user_id: "20000000-0000-4000-8000-000000000006",
  };
  await db.query("insert into auth.users(id) values ($1)", [leader.auth_subject]);
  await db.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name)" +
      " values ($1,$2,true,'Team Leader')", [leader.app_user_id, leader.auth_subject]);
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
      " values ($1,'team_manager_assign','2020-01-01'),($1,'pii_view','2020-01-01')",
    [leader.app_user_id]);
  await db.query(
    "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from)" +
      " values ($1,'team',$2,'2020-01-01')", [leader.app_user_id, fixture.entryA.team_id]);
  await db.query(
    "insert into public.direct_entry_team_leader_assignments" +
      " (team_id,leader_app_user_id,leader_recruiter_id,valid_from) values ($1,$2,$3,'2020-01-01')",
    [fixture.entryA.team_id, leader.app_user_id, RECRUITER_A]);
  assert.equal((await db.query(
    "select public.direct_entry_has_capability($1,'change_review') as allowed", [leader.app_user_id],
  )).rows[0].allowed, false, "team review does not create a global reviewer capability");

  const listed = await listChangeRequests(db, leader, { pageSize: 50 });
  assert.equal(listed.error, null);
  const byId = new Map(listed.data.requests.map((item) => [item.request_id, item]));
  assert.equal(byId.get(requests.single).can_decide, true);
  assert.equal(byId.has(requests.multi), false, "mixed-team requests are not visible to one leader");
  assert.equal(byId.get(requests.single).proposer_display_name, "Synthetic Account");
  const detail = await readChangeRequest(db, leader, requests.single);
  assert.equal(detail.error, null);
  assert.equal(detail.data.items[0].proposal.worker_details.display_name, "S02B worker1");
  const currentEntry = await db.query(
    "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as data",
    [leader.auth_subject, leader.app_user_id, fixture.entryA.entry_id],
  );
  assert.equal(currentEntry.rows[0].data.entry_id, fixture.entryA.entry_id,
    "the assigned team leader can read the current row for its review request");
  assert.equal(currentEntry.rows[0].data.worker_details.display_name, "S02B worker1",
    "PII still follows the explicit pii_view capability");
  await assert.rejects(db.query(
    "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid)",
    [leader.auth_subject, leader.app_user_id, fixture.entryB.entry_id],
  ), (error) => error.code === "42501",
  "team-leader review does not grant access to entries outside the assigned team request");

  const rejected = await decideChangeRequest(db, leader, requests.single, "reject", 1,
    "Dữ liệu hiện tại đã thay đổi", "s02b_team_leader_stale_reject");
  assert.equal(rejected.error, null, "rejection is allowed even though the entry version is stale");
  assert.equal(rejected.data.state, "REJECTED");
  const resolvedEntry = await db.query(
    "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as data",
    [leader.auth_subject, leader.app_user_id, fixture.entryA.entry_id],
  );
  assert.equal(resolvedEntry.rows[0].data.entry_id, fixture.entryA.entry_id,
    "the leader can still read history for the assigned team after a decision");

  const currentProfile = await db.query(
    "select version, worker_details from public.direct_entries where entry_id = $1",
    [fixture.entryA.entry_id],
  );
  const approvedRequest = await createChangeRequest(db, ACTORS.proposer, [item(
    fixture.entryA.entry_id,
    currentProfile.rows[0].version,
    { worker_details: {
      ...currentProfile.rows[0].worker_details,
      address: { state: "provided", value: "Team Leader approved address" },
    } },
  )], "Team leader approval", "s02b_team_leader_approve");
  assert.equal(approvedRequest.error, null);
  const approved = await decideChangeRequest(db, leader, approvedRequest.data.request_id,
    "approve", 1, "Đã đối chiếu", "s02b_team_leader_approve_decision");
  assert.equal(approved.error, null, "the assigned team leader can approve a team request");
  assert.equal(approved.data.state, "APPROVED");
});
