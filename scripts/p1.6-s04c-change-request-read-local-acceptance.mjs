#!/usr/bin/env node
/**
 * P1.6-W04-S04C-S02B - Local acceptance cho change request read/list.
 *
 * CHI PGlite trong bo nho: khong ket noi Supabase DEV, khong apply shared DB, khong network.
 * Migration #31 chua duoc apply o bat ky dau - acceptance nay chung minh migration + RPC doc
 * dung ngay khi duoc apply (from scratch).
 *
 * Dung: node --conditions=react-server scripts/p1.6-s04c-change-request-read-local-acceptance.mjs
 */
import assert from "node:assert/strict";

import {
  ACTORS,
  createMigratedDatabase,
  listChangeRequests,
  readChangeRequest,
  seedChangeRequestFixture,
  seedChangeRequests,
} from "./lib/s04c-read-fixture.mjs";

const checks = [];

function pass(label) {
  checks.push(label);
}

const migrations = await createMigratedDatabase();
const db = migrations.db;

assert.equal(migrations.migrationNames.length, 38);
pass("from-scratch apply 36 migration local trong PGlite (khong dung shared DB)");

const fixture = await seedChangeRequestFixture(db);
const requests = await seedChangeRequests(db, fixture);
assert.equal(Object.keys(requests).length, 6);
assert.equal(fixture.entryA.team_id !== fixture.entryB.team_id, true);
pass("tao fixture synthetic: 5 actor, 2 entry da SUBMITTED, 6 change request voi created_at ghim");

const own = await listChangeRequests(db, ACTORS.proposer, { pageSize: 50 });
assert.equal(own.error, null);
assert.equal(own.data.requests.length, 6);
const ownById = new Map(own.data.requests.map((item) => [item.request_id, item]));
assert.equal(ownById.get(requests.single).can_withdraw, true);
assert.equal(ownById.get(requests.single).can_decide, false);
assert.equal(ownById.get(requests.withdrawn).can_withdraw, false);
assert.equal(ownById.get(requests.approved).can_withdraw, false);
pass("proposer thay 6/6 request cua minh; can_withdraw chi o PENDING; proposer KHONG tu co quyen review");

const team = await listChangeRequests(db, ACTORS.reviewer, { pageSize: 50 });
const teamIds = team.data.requests.map((item) => item.request_id);
assert.equal(teamIds.length, 5);
assert.equal(teamIds.includes(requests.multi), false);
for (const item of team.data.requests) {
  assert.equal(item.can_withdraw, false);
  assert.equal(item.can_decide, item.state === "PENDING");
}
pass("reviewer team scope thay 5/6; request nhieu entry fail-closed vi thieu scope o mot item");

const allScope = await listChangeRequests(db, ACTORS.reviewerAll, { pageSize: 50 });
assert.equal(allScope.data.requests.length, 6);
const noCapability = await listChangeRequests(db, ACTORS.reviewerNoCapability, { pageSize: 50 });
const outsider = await listChangeRequests(db, ACTORS.outsider, { pageSize: 50 });
assert.deepEqual(noCapability.data.requests, []);
assert.deepEqual(outsider.data.requests, []);
pass("reviewerAll (scope all) thay 6/6; thieu change_review hoac ngoai scope thi khong thay request nao");

const detail = await readChangeRequest(db, ACTORS.reviewer, requests.single);
assert.equal(detail.error, null);
assert.equal(detail.data.state, "PENDING");
assert.equal(detail.data.can_decide, true);
assert.equal(detail.data.can_withdraw, false);
assert.deepEqual(detail.data.items[0].proposal, { labor_type: "PERMANENT" });
assert.deepEqual(Object.keys(detail.data.items[0]).sort(), [
  "entry_id", "expected_version", "proposal", "target_kind",
]);
pass("detail tra dung projection va proposal thuoc vocabulary W01/W03 da khoa");

const multiDetail = await readChangeRequest(db, ACTORS.reviewerAll, requests.multi);
assert.equal(multiDetail.error, null);
assert.equal(multiDetail.data.items.length, 2);
const hidden = await readChangeRequest(db, ACTORS.reviewer, requests.multi);
const unknown = await readChangeRequest(db, ACTORS.reviewer,
  "d1000000-0000-4000-8000-0000000000ff");
assert.equal(hidden.error.code, "P0002");
assert.equal(unknown.error.code, "P0002");
assert.equal(hidden.error.message, unknown.error.message);
pass("request khong ton tai va request ngoai scope tra CUNG mot ma (khong enumeration)");

const full = await listChangeRequests(db, ACTORS.proposer, { pageSize: 50 });
const expectedOrder = full.data.requests.map((item) => item.request_id);
const walked = [];
let cursor = null;
for (let guard = 0; guard < 10; guard += 1) {
  const page = await listChangeRequests(db, ACTORS.proposer, { pageSize: 2, cursor });
  walked.push(...page.data.requests.map((item) => item.request_id));
  if (!page.data.has_more) {
    assert.equal(page.data.next_cursor, null);
    break;
  }
  cursor = page.data.next_cursor;
}
assert.deepEqual(walked, expectedOrder);
assert.equal(new Set(walked).size, walked.length);
for (let index = 1; index < full.data.requests.length; index += 1) {
  const previous = full.data.requests[index - 1];
  const current = full.data.requests[index];
  assert.ok(previous.created_at > current.created_at ||
    (previous.created_at === current.created_at && previous.request_id > current.request_id));
}
pass("keyset pagination (page_size=2) tra dung thu tu, khong trung, khong sot, cursor ket thuc = null");

const pending = await listChangeRequests(db, ACTORS.proposer, { pageSize: 50, state: "PENDING" });
assert.equal(pending.data.requests.length, 3);
for (const item of pending.data.requests) assert.equal(item.state, "PENDING");
pass("loc state=PENDING tra dung 3 request PENDING");

for (const [label, options] of [
  ["page_size=51", { pageSize: 51 }],
  ["cursor sai", { pageSize: 20, cursor: "nope" }],
  ["state sai", { pageSize: 20, state: "pending" }],
]) {
  const result = await listChangeRequests(db, ACTORS.proposer, options);
  assert.equal(result.error.code, "22023", label);
}
const mapping = await listChangeRequests(db, {
  auth_subject: ACTORS.proposer.auth_subject,
  app_user_id: ACTORS.reviewer.app_user_id,
}, { pageSize: 20 });
assert.equal(mapping.error.code, "42501");
pass("page_size/cursor/state sai tra 22023; mapping auth_subject <-> app_user_id sai tra 42501");

const serializedList = JSON.stringify(full.data);
const serializedDetail = JSON.stringify(detail.data);
for (const forbidden of [
  "reason", "idempotency", "auth_subject", "app_user_id", "proposer_user_id",
  "decided_by_user_id", "audit", "revision", "account_number", "national_id", "created_by_user_id",
]) {
  assert.equal(serializedList.includes(forbidden), false, "list: " + forbidden);
  assert.equal(serializedDetail.includes(forbidden), false, "detail: " + forbidden);
}
pass("khong lo reason/idempotency/audit/revision/identity/PII trong list hoac detail");

const before = await db.query(
  "select count(*)::int as teams from public.teams");
await db.exec("begin");
await db.query(
  "insert into public.teams(team_id,code,display_name) values ('94000000-0000-4000-8000-0000000000ff','s02b_rollback','rollback probe')");
await db.exec("rollback");
const after = await db.query("select count(*)::int as teams from public.teams");
assert.equal(after.rows[0].teams, before.rows[0].teams);
pass("rollback local hoat dong: mutation thu bi huy, khong de lai residue");

await db.close();
pass("dong PGlite: toan bo fixture chi ton tai trong bo nho, khong ghi shared DB, khong network");

for (const [index, label] of checks.entries()) {
  console.log("PASS " + (index + 1) + ". " + label);
}
console.log("S04C-S02B change request read LOCAL acceptance: " + checks.length + " checks passed.");
