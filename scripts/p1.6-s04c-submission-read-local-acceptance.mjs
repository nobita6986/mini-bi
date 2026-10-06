#!/usr/bin/env node
/**
 * P1.6-W04-S04C-S02C - Local acceptance cho doc/list own submission.
 *
 * CHI PGlite trong bo nho: khong ket noi Supabase, khong apply shared DB, khong network.
 * Migration #32 chua duoc apply o bat ky dau - acceptance nay chung minh migration + RPC doc
 * dung ngay khi duoc apply (from scratch).
 *
 * Dung: node --conditions=react-server scripts/p1.6-s04c-submission-read-local-acceptance.mjs
 */
import assert from "node:assert/strict";

import {
  ACTORS,
  SUBMISSION_STAMPS,
  createMigratedDatabase,
  listOwnSubmissions,
  readOwnSubmission,
  seedSubmissionReadFixture,
} from "./lib/s04c-submission-read-fixture.mjs";

const checks = [];

function pass(label) {
  checks.push(label);
}

const migrations = await createMigratedDatabase();
const db = migrations.db;
// P3-W07B migration #43 adds project-manager scope enforcement.
assert.equal(migrations.migrationNames.length, 43);
pass("from-scratch apply 43 migration local trong PGlite (khong dung shared DB, khong network)");

for (const signature of [
  "public.direct_entry_list_own_submissions(uuid,uuid,integer,text,text)",
  "public.direct_entry_read_own_submission(uuid,uuid,uuid)",
]) {
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
  assert.equal(rows[0].prosecdef, true, signature);
  assert.equal(rows[0].config, "search_path=pg_catalog, public", signature);
  assert.equal(rows[0].public_exec, false, signature);
  assert.equal(rows[0].anon_exec, false, signature);
  assert.equal(rows[0].auth_exec, false, signature);
  assert.equal(rows[0].service_exec, true, signature);
}
pass("hai RPC: SECURITY DEFINER, search_path co dinh, chi service_role duoc EXECUTE");

for (const table of [
  "direct_entry_submissions", "direct_entries", "direct_entry_app_users",
  "direct_entry_scope_grants", "direct_entry_capability_grants", "direct_entry_audit_events",
]) {
  for (const role of ["anon", "authenticated", "service_role"]) {
    const { rows } = await db.query(
      "select has_table_privilege($1, $2, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') as allowed",
      [role, "public." + table],
    );
    assert.equal(rows[0].allowed, false, role + " on " + table);
  }
}
pass("khong co table privilege moi: anon/authenticated/service_role deu khong co quyen tren bang");

const fixture = await seedSubmissionReadFixture(db);
const submissions = fixture.submissions;
assert.equal(Object.keys(submissions).length, 4);
pass("fixture 5 actor (owner, thieu capability, thieu own grant, chi team scope, actor khac) + 4 submission");

const own = await listOwnSubmissions(db, ACTORS.owner, { pageSize: 50 });
assert.equal(own.error, null);
assert.equal(own.data.items.length, 4);
const byId = new Map(own.data.items.map((item) => [item.submission_id, item]));
for (const state of ["DRAFT", "REVIEW", "SUBMITTED"]) {
  assert.equal([...byId.values()].some((item) => item.state === state), true, state);
}
pass("owner thay du ca ba trang thai DRAFT, REVIEW, SUBMITTED sau khi tai lai (khong can client state)");

const review = await listOwnSubmissions(db, ACTORS.owner, { pageSize: 50, state: "REVIEW" });
assert.deepEqual(review.data.items.map((item) => item.submission_id), [submissions.review]);
const draft = await listOwnSubmissions(db, ACTORS.owner, { pageSize: 50, state: "DRAFT" });
assert.equal(draft.data.items.length, 2);
const submitted = await listOwnSubmissions(db, ACTORS.owner, { pageSize: 50, state: "SUBMITTED" });
assert.deepEqual(submitted.data.items.map((item) => item.submission_id), [submissions.submitted]);
pass("loc state tra dung tap con cho ca ba trang thai");

assert.deepEqual(byId.get(submissions.draft).allowed_transitions, ["REVIEW"]);
assert.deepEqual(byId.get(submissions.review).allowed_transitions, ["DRAFT", "SUBMITTED"]);
assert.deepEqual(byId.get(submissions.submitted).allowed_transitions, []);
assert.equal(byId.get(submissions.submitted).submitted_at !== null, true);
assert.equal(byId.get(submissions.draft).submitted_at, null);
assert.equal(byId.get(submissions.review).submitted_at, null);
pass("allowed_transitions dung ma tran trang thai va submitted_at chi co o SUBMITTED");

const detail = await readOwnSubmission(db, ACTORS.owner, submissions.submitted);
assert.equal(detail.error, null);
assert.equal(detail.data.entry_count, 2);
assert.equal(detail.data.entry_ids.length, 2);
assert.deepEqual([...detail.data.entry_ids].sort(), detail.data.entry_ids);
const draftDetail = await readOwnSubmission(db, ACTORS.owner, submissions.draft);
assert.equal(draftDetail.data.entry_count, 1);
pass("entry_count va entry_ids deterministic (sap xep tang dan theo uuid)");

const otherList = await listOwnSubmissions(db, ACTORS.otherOwner, { pageSize: 50 });
assert.deepEqual(otherList.data.items, []);
const otherDetail = await readOwnSubmission(db, ACTORS.otherOwner, submissions.draft);
assert.equal(otherDetail.error.code, "P0002");
pass("actor khac owner khong thay (list rong) va khong doc duoc submission cua nguoi khac");

const absent = await readOwnSubmission(db, ACTORS.otherOwner,
  "1f000000-0000-4000-8000-0000000000ff");
assert.equal(absent.error.code, "P0002");
assert.equal(absent.error.message, otherDetail.error.message);
pass("detail khong ton tai va detail ngoai scope tra CUNG mot loi (khong enumeration)");

const full = await listOwnSubmissions(db, ACTORS.owner, { pageSize: 50 });
const expectedOrder = full.data.items.map((item) => item.submission_id);
const walked = [];
let cursor = null;
for (let guard = 0; guard < 10; guard += 1) {
  const page = await listOwnSubmissions(db, ACTORS.owner, { pageSize: 1, cursor });
  walked.push(...page.data.items.map((item) => item.submission_id));
  if (!page.data.has_more) {
    assert.equal(page.data.next_cursor, null);
    break;
  }
  cursor = page.data.next_cursor;
}
assert.deepEqual(walked, expectedOrder);
assert.equal(new Set(walked).size, walked.length);
for (let index = 1; index < full.data.items.length; index += 1) {
  const previous = full.data.items[index - 1];
  const current = full.data.items[index];
  assert.ok(previous.created_at > current.created_at ||
    (previous.created_at === current.created_at && previous.submission_id > current.submission_id));
}
assert.equal(SUBMISSION_STAMPS.draft, SUBMISSION_STAMPS.draftTied);
const tiedIndexes = [submissions.draft, submissions.draftTied]
  .map((id) => expectedOrder.indexOf(id));
assert.equal(Math.abs(tiedIndexes[0] - tiedIndexes[1]), 1);
pass("keyset pagination page_size=1: dung thu tu, khong trung, khong sot, hai created_at bang nhau van tach dung");

for (const [label, options] of [
  ["page_size=51", { pageSize: 51 }],
  ["page_size=0", { pageSize: 0 }],
  ["cursor sai", { pageSize: 20, cursor: "nope" }],
  ["state sai", { pageSize: 20, state: "SUBMIT" }],
]) {
  const result = await listOwnSubmissions(db, ACTORS.owner, options);
  assert.equal(result.error.code, "22023", label);
}
for (const actor of [ACTORS.noCapability, ACTORS.noScope, ACTORS.teamScopeOnly]) {
  const result = await listOwnSubmissions(db, actor, { pageSize: 20 });
  assert.equal(result.error.code, "42501");
}
const mapping = await listOwnSubmissions(db,
  { auth_subject: ACTORS.owner.auth_subject, app_user_id: ACTORS.otherOwner.app_user_id }, { pageSize: 20 });
assert.equal(mapping.error.code, "42501");
pass("page_size/cursor/state sai tra 22023; thieu capability, thieu own grant, chi team scope, mapping sai deu tra 42501");

const serializedList = JSON.stringify(full.data);
const serializedDetail = JSON.stringify(detail.data);
for (const forbidden of [
  "created_by_user_id", "auth_subject", "app_user_id", "worker_details", "payment",
  "audit", "revision", "idempotency", "reason", "scope_kind", "account_number",
]) {
  assert.equal(serializedList.includes(forbidden), false, "list: " + forbidden);
  assert.equal(serializedDetail.includes(forbidden), false, "detail: " + forbidden);
}
pass("khong lo PII/payment/document/audit/revision/idempotency/reason/identity trong list hoac detail");

const before = await db.query("select count(*)::int as submissions from public.direct_entry_submissions");
await db.exec("begin");
await db.query(
  "insert into public.direct_entry_projects(project_id,display_name) values ('s02c_rollback','rollback probe')");
await db.exec("rollback");
const after = await db.query("select count(*)::int as submissions from public.direct_entry_submissions");
assert.equal(after.rows[0].submissions, before.rows[0].submissions);
const { rows: probe } = await db.query(
  "select count(*)::int as rows from public.direct_entry_projects where project_id = 's02c_rollback'");
assert.equal(probe[0].rows, 0);
pass("rollback local sach: mutation thu bi huy hoan toan, khong de lai residue");

await db.close();
pass("dong PGlite: fixture chi ton tai trong bo nho, khong ghi shared DB, khong network");

for (const [index, label] of checks.entries()) {
  console.log("PASS " + (index + 1) + ". " + label);
}
console.log("S04C-S02C own submission read LOCAL acceptance: " + checks.length + " checks passed.");
