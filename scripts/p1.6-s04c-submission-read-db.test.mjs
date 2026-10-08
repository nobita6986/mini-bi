import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTORS,
  SUBMISSION_STAMPS,
  createMigratedDatabase,
  listOwnSubmissions,
  readOwnSubmission,
  seedSubmissionReadFixture,
} from "./lib/s04c-submission-read-fixture.mjs";

const LIST_RPC = "public.direct_entry_list_own_submissions(uuid,uuid,integer,text,text)";
const READ_RPC = "public.direct_entry_read_own_submission(uuid,uuid,uuid)";

const migrations = await createMigratedDatabase();
const db = migrations.db;
const fixture = await seedSubmissionReadFixture(db);
const submissions = fixture.submissions;

test("from-scratch apply 58 migrations and read RPC ACLs", async () => {
  // P2-W04B migration #44 rebaselines the cutoff to 2026-10-06.
  // W05A #48, W07C-R7 #49, W07E #50, P2.5-W02 #51, P2.5-W03 #52, P2.5-W04 #53,
  // P2.5-W06A #54, P2.5-W05 #55, W05-R1 #56 and initial-ON #57.
  assert.equal(migrations.migrationNames.length, 58);
  assert.ok(migrations.migrationNames.includes("20261005020000_p1_6_w04_s04c_submission_reads.sql"));
  assert.ok(migrations.migrationNames.includes("20261008030000_p2_w04b_post_purge_cutover_rebaseline.sql"));
  assert.deepEqual(migrations.migrationNames, [...migrations.migrationNames].sort(),
    "migration phai duoc ap theo thu tu ten file");
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
  for (const table of [
    "direct_entry_submissions", "direct_entries", "direct_entry_app_users",
    "direct_entry_scope_grants", "direct_entry_capability_grants",
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

test("owner sees all three lifecycle states with exact transitions and entry counts", async () => {
  const listed = await listOwnSubmissions(db, ACTORS.owner, { pageSize: 50 });
  assert.equal(listed.error, null);
  const byId = new Map(listed.data.items.map((item) => [item.submission_id, item]));
  assert.equal(byId.get(submissions.draft).state, "DRAFT");
  assert.deepEqual(byId.get(submissions.draft).allowed_transitions, ["REVIEW"]);
  assert.equal(byId.get(submissions.draft).submitted_at, null);
  assert.equal(byId.get(submissions.review).state, "REVIEW");
  assert.deepEqual(byId.get(submissions.review).allowed_transitions, ["DRAFT", "SUBMITTED"]);
  assert.equal(byId.get(submissions.review).submitted_at, null);
  assert.equal(byId.get(submissions.submitted).state, "SUBMITTED");
  assert.deepEqual(byId.get(submissions.submitted).allowed_transitions, []);
  assert.equal(byId.get(submissions.submitted).submitted_at !== null, true);
  assert.equal(byId.get(submissions.submitted).entry_count, 2);
  assert.equal(listed.data.items.length, 4);
  const filtered = await listOwnSubmissions(db, ACTORS.owner, { pageSize: 50, state: "REVIEW" });
  assert.deepEqual(filtered.data.items.map((item) => item.submission_id), [submissions.review]);
  const submittedOnly = await listOwnSubmissions(db, ACTORS.owner,
    { pageSize: 50, state: "SUBMITTED" });
  assert.deepEqual(submittedOnly.data.items.map((item) => item.submission_id), [submissions.submitted]);
});

test("detail returns deterministic entry_ids and hides existence from other actors", async () => {
  const detail = await readOwnSubmission(db, ACTORS.owner, submissions.submitted);
  assert.equal(detail.error, null);
  assert.equal(detail.data.entry_count, detail.data.entry_ids.length);
  assert.deepEqual([...detail.data.entry_ids].sort(), detail.data.entry_ids);
  assert.equal(new Set(detail.data.entry_ids).size, detail.data.entry_ids.length);
  assert.deepEqual(Object.keys(detail.data).sort(), [
    "allowed_transitions", "created_at", "entry_count", "entry_ids", "project_scoped", "state",
    "submission_id", "submitted_at", "updated_at", "version",
  ]);
  const other = await readOwnSubmission(db, ACTORS.otherOwner, submissions.submitted);
  const absent = await readOwnSubmission(db, ACTORS.otherOwner,
    "1f000000-0000-4000-8000-0000000000ff");
  assert.equal(other.error.code, "P0002");
  assert.equal(absent.error.code, "P0002");
  assert.equal(other.error.message, absent.error.message);
  const otherList = await listOwnSubmissions(db, ACTORS.otherOwner, { pageSize: 50 });
  assert.deepEqual(otherList.data.items, []);
});

test("authority mirrors the transition RPC: capability and exactly one own scope", async () => {
  for (const actor of [ACTORS.noCapability, ACTORS.noScope, ACTORS.teamScopeOnly]) {
    const listed = await listOwnSubmissions(db, actor, { pageSize: 50 });
    assert.equal(listed.error.code, "42501");
    const detail = await readOwnSubmission(db, actor, submissions.draft);
    assert.equal(detail.error.code, "42501");
  }
  const mapping = await listOwnSubmissions(db,
    { auth_subject: ACTORS.owner.auth_subject, app_user_id: ACTORS.otherOwner.app_user_id },
    { pageSize: 50 });
  assert.equal(mapping.error.code, "42501");
  assert.equal(ACTORS.teamScopeOnly.app_user_id !== ACTORS.owner.app_user_id, true);
});

test("keyset pagination is deterministic for equal created_at without duplicates or gaps", async () => {
  const full = await listOwnSubmissions(db, ACTORS.owner, { pageSize: 50 });
  const expected = full.data.items.map((item) => item.submission_id);
  assert.equal(expected.length, 4);
  for (let index = 1; index < full.data.items.length; index += 1) {
    const previous = full.data.items[index - 1];
    const current = full.data.items[index];
    assert.ok(
      previous.created_at > current.created_at ||
        (previous.created_at === current.created_at && previous.submission_id > current.submission_id),
      "ordering must be created_at DESC then submission_id DESC at index " + index,
    );
  }
  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await listOwnSubmissions(db, ACTORS.owner, { pageSize: 1, cursor });
    seen.push(...page.data.items.map((item) => item.submission_id));
    if (!page.data.has_more) {
      assert.equal(page.data.next_cursor, null);
      break;
    }
    cursor = page.data.next_cursor;
  }
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, seen.length);
  const tied = [submissions.draft, submissions.draftTied];
  assert.equal(SUBMISSION_STAMPS.draft, SUBMISSION_STAMPS.draftTied);
  const tiedIndexes = tied.map((id) => expected.indexOf(id));
  assert.equal(Math.abs(tiedIndexes[0] - tiedIndexes[1]), 1);
});

test("invalid cursor, page size and state fail closed, and projection leaks nothing", async () => {
  for (const [label, options] of [
    ["page_size", { pageSize: 51 }],
    ["page_size zero", { pageSize: 0 }],
    ["cursor", { pageSize: 20, cursor: "nope" }],
    ["state", { pageSize: 20, state: "SUBMIT" }],
  ]) {
    const result = await listOwnSubmissions(db, ACTORS.owner, options);
    assert.equal(result.error.code, "22023", label);
  }
  const listed = await listOwnSubmissions(db, ACTORS.owner, { pageSize: 50 });
  const serialized = JSON.stringify(listed.data);
  for (const forbidden of ["created_by_user_id", "auth_subject", "app_user_id",
    "worker_details", "payment", "audit", "idempotency", "reason", "scope_kind"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  for (const item of listed.data.items) {
    assert.deepEqual(Object.keys(item).sort(), [
      "allowed_transitions", "created_at", "entry_count", "project_scoped", "state",
      "submission_id", "submitted_at", "updated_at", "version",
    ]);
  }
});
