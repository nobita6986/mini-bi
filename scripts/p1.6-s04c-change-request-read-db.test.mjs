import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTORS,
  REQUEST_STAMPS,
  createMigratedDatabase,
  listChangeRequests,
  readChangeRequest,
  seedChangeRequestFixture,
  seedChangeRequests,
} from "./lib/s04c-read-fixture.mjs";

const LIST_RPC = "public.direct_entry_list_change_requests(uuid,uuid,integer,text,text)";
const READ_RPC = "public.direct_entry_read_change_request(uuid,uuid,uuid)";
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
  assert.equal(migrations.migrationNames.length, 63);
  assert.ok(migrations.migrationNames.includes("20261005010000_p1_6_w04_s04c_change_request_reads.sql"));
  assert.ok(migrations.migrationNames.includes(
    "20261005030000_p1_6_w04_s04c_s03b3_r1_change_policy_closure.sql"));
  for (const signature of [LIST_RPC, READ_RPC]) {
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
    "can_decide", "can_withdraw", "created_at", "items", "request_id", "state", "version",
  ]);
  assert.deepEqual(Object.keys(ok.data.items[0]).sort(), [
    "entry_id", "expected_version", "proposal", "target_kind",
  ]);
  // ACTORS.reviewerAll holds pii_view, so the reviewer sees the proposal payload;
  // the presence-only projection for a reviewer WITHOUT pii_view stays asserted in
  // p1.6-s04c-policy-closure-db.test.mjs (POLICY_ACTORS.entryOnly).
  assert.equal(typeof ok.data.items[0].proposal.worker_details.display_name, "string");
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

test("list projection exposes no sensitive columns", async () => {
  const listed = await listChangeRequests(db, ACTORS.proposer, { pageSize: 50 });
  for (const item of listed.data.requests) {
    assert.deepEqual(Object.keys(item).sort(), [
      "can_decide", "can_withdraw", "created_at", "entry_ids", "item_count",
      "request_id", "state", "version",
    ]);
    assert.equal(item.item_count, item.entry_ids.length);
  }
  const serialized = JSON.stringify(listed.data);
  for (const forbidden of ["reason", "idempotency", "auth_subject", "app_user_id",
    "proposer_user_id", "decided_by_user_id", "audit", "account_number", "national_id"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
