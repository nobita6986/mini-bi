import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTORS,
  createMigratedDatabase,
  seedChangeRequestFixture,
} from "./lib/s04c-read-fixture.mjs";
import {
  LEAVE_REASON_TEXT,
  PAYMENT_PROPOSAL,
  POLICY_ACTORS,
  applyChangeItem,
  auditRows,
  decide,
  entryRow,
  readDetail,
  requestRow,
  revisionCount,
  seedPolicyFixture,
} from "./lib/s04c-policy-fixture.mjs";

const POLICY_MIGRATION = "20261005030000_p1_6_w04_s04c_s03b3_r1_change_policy_closure.sql";
const NEW_HELPERS = [
  "public.direct_entry_has_capability(uuid,text)",
  "public.direct_entry_change_request_required_capabilities(uuid)",
  "public.direct_entry_assert_change_request_capabilities(uuid,uuid,uuid)",
  "public.direct_entry_change_request_proposal_projection(text,jsonb,boolean,boolean,boolean)",
];
const REVOKED_HELPERS = [
  ...NEW_HELPERS,
  "public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)",
  "public.direct_entry_decide_change_request(uuid,uuid,uuid,integer,text,text,text)",
  "public.direct_entry_entry_snapshot(uuid)",
];
const SERVICE_RPCS = [
  "public.direct_entry_read_change_request(uuid,uuid,uuid)",
  "public.direct_entry_list_change_requests(uuid,uuid,integer,text,text)",
  "public.direct_entry_approve_change_request(uuid,uuid,uuid,integer,text,text)",
  "public.direct_entry_reject_change_request(uuid,uuid,uuid,integer,text,text)",
  "public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)",
];

const migrations = await createMigratedDatabase();
const db = migrations.db;
// Fixture nen: teams/recruiters/project/bank + actor proposer/reviewer + entry da SUBMITTED.
await seedChangeRequestFixture(db);
const seeded = await seedPolicyFixture(db, "s03b3r1");
const requests = seeded.requests;
const entries = seeded.entries;

function json(value) {
  return JSON.stringify(value);
}

function assertNoSensitive(label, value) {
  const text = json(value);
  for (const forbidden of [
    "national_id", "date_of_birth", "address", "phone", "account_number",
    "account_holder_name", "checksum_sha256", "idempotency_key", "storage_key",
    "leave_reason", "size_bytes", "mime_type", "0123456789",
    "NGUYEN VAN SYNTHETIC", LEAVE_REASON_TEXT,
  ]) {
    assert.equal(text.includes(forbidden), false, label + " leaked " + forbidden);
  }
}

test("from-scratch apply covers the policy closure migration and its ACLs", async () => {
  assert.equal(migrations.migrationNames.length, 37);
  assert.ok(migrations.migrationNames.includes(POLICY_MIGRATION));
  for (const signature of NEW_HELPERS) {
    const { rows } = await db.query(
      "select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon_exec," +
      " has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth_exec," +
      " has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_exec," +
      " p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as config" +
      " from pg_proc p where p.oid = $1::regprocedure",
      [signature],
    );
    assert.equal(rows.length, 1, signature);
    assert.deepEqual([rows[0].anon_exec, rows[0].auth_exec, rows[0].service_exec],
      [false, false, false], signature);
    if (signature !== NEW_HELPERS[3]) {
      assert.equal(rows[0].prosecdef, true, signature);
      assert.equal(rows[0].config, "search_path=pg_catalog, public", signature);
    }
  }
  for (const signature of REVOKED_HELPERS) {
    const { rows } = await db.query(
      "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_exec",
      [signature],
    );
    assert.equal(rows[0].service_exec, false, signature);
  }
  for (const signature of SERVICE_RPCS) {
    const { rows } = await db.query(
      "select p.prosecdef, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec," +
      " has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec," +
      " has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec" +
      " from pg_proc p where p.oid = $1::regprocedure",
      [signature],
    );
    assert.equal(rows[0].prosecdef, true, signature);
    assert.deepEqual([rows[0].anon_exec, rows[0].auth_exec, rows[0].service_exec],
      [false, false, true], signature);
  }
  for (const table of ["direct_entry_change_requests", "direct_entry_change_request_items",
    "direct_entry_payments", "direct_entry_revisions", "direct_entry_audit_events",
    "direct_entries"]) {
    const { rows } = await db.query(
      "select c.relrowsecurity, c.relforcerowsecurity from pg_class c" +
      " join pg_namespace n on n.oid = c.relnamespace" +
      " where n.nspname = 'public' and c.relname = $1",
      [table],
    );
    assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity], [true, true], table);
    for (const role of ["anon", "authenticated"]) {
      const { rows: privilege } = await db.query(
        "select has_table_privilege($1, $2, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') as allowed",
        [role, "public." + table],
      );
      assert.equal(privilege[0].allowed, false, role + " on " + table);
    }
  }
});

test("ENTRY_FIELD non-PII with change_review stays decidable for approve and reject", async () => {
  const approveKey = "s03b3r1_approve_nonpii";
  const approved = await decide(db, POLICY_ACTORS.entryOnly, requests.nonPiiApprove,
    "approve", 1, "S03B3R1 approved", approveKey);
  assert.equal(approved.error, null);
  assert.deepEqual(approved.data, {
    request_id: requests.nonPiiApprove, state: "APPROVED", version: 2,
  });
  assert.equal((await entryRow(db, entries.nonPiiApprove.entry_id)).labor_type, "PERMANENT");
  const replay = await decide(db, POLICY_ACTORS.entryOnly, requests.nonPiiApprove,
    "approve", 1, "S03B3R1 approved", approveKey);
  assert.deepEqual(replay.data, approved.data, "replay cung key phai tra cung ket qua");

  const rejected = await decide(db, POLICY_ACTORS.entryOnly, requests.nonPiiReject,
    "reject", 1, "S03B3R1 rejected", "s03b3r1_reject_nonpii");
  assert.equal(rejected.error, null);
  assert.equal(rejected.data.state, "REJECTED");
  assert.equal((await entryRow(db, entries.nonPiiReject.entry_id)).labor_type, "TEMPORARY",
    "reject khong duoc doi du lieu canonical");
});

test("worker_details requires pii_view for both approve and reject", async () => {
  const revisionsBefore = await revisionCount(db, entries.pii.entry_id);
  for (const decision of ["approve", "reject"]) {
    const denied = await decide(db, POLICY_ACTORS.entryOnly, requests.pii,
      decision, 1, "S03B3R1 denied " + decision, "s03b3r1_pii_" + decision);
    assert.equal(denied.error.code, "42501", decision);
    assert.equal(denied.error.message.includes("capability denied"), true, decision);
  }
  const before = await entryRow(db, entries.pii.entry_id);
  assert.equal(before.version, 1);
  assert.equal((await requestRow(db, requests.pii)).state, "PENDING");
  assert.equal(await revisionCount(db, entries.pii.entry_id), revisionsBefore);
});

test("PAYMENT requires payment_view and payment_edit", async () => {
  const withoutView = await decide(db, POLICY_ACTORS.entryOnly, requests.payment,
    "approve", 1, "S03B3R1 denied payment view", "s03b3r1_payment_view");
  assert.equal(withoutView.error.code, "42501");
  const withoutEdit = await decide(db, POLICY_ACTORS.paymentView, requests.payment,
    "approve", 1, "S03B3R1 denied payment edit", "s03b3r1_payment_edit");
  assert.equal(withoutEdit.error.code, "42501");
  const deniedReject = await decide(db, POLICY_ACTORS.paymentView, requests.payment,
    "reject", 1, "S03B3R1 denied payment reject", "s03b3r1_payment_reject");
  assert.equal(deniedReject.error.code, "42501", "reject cung phai theo capability matrix");
  assert.equal((await entryRow(db, entries.payment.entry_id)).version, 1);

  // Guard o tang apply: helper khong the bi goi thieu quyen tu duong khac.
  const reasonId = (await db.query(
    "select public.direct_entry_reason($1::uuid,$2::text) as id",
    [POLICY_ACTORS.paymentView.app_user_id, "S03B3R1 direct apply probe"])).rows[0].id;
  const direct = await applyChangeItem(db, POLICY_ACTORS.paymentView, requests.payment,
    entries.payment.entry_id, "PAYMENT", PAYMENT_PROPOSAL, reasonId);
  assert.equal(direct.error.code, "42501");
});

test("WORK_STATUS requires employment_status.apply", async () => {
  const denied = await decide(db, POLICY_ACTORS.entryOnly, requests.status,
    "approve", 1, "S03B3R1 denied status", "s03b3r1_status_denied");
  assert.equal(denied.error.code, "42501");
  assert.equal((await entryRow(db, entries.status.entry_id)).version, 1);
});

test("mixed request thieu dung mot capability thi khong item nao duoc ap dung", async () => {
  const revisionsBefore = await revisionCount(db, entries.nonPiiApprove.entry_id);
  const paymentRevisionsBefore = await revisionCount(db, entries.payment.entry_id);
  const denied = await decide(db, POLICY_ACTORS.paymentView, requests.mixed,
    "approve", 1, "S03B3R1 mixed denied", "s03b3r1_mixed");
  assert.equal(denied.error.code, "42501");
  assert.equal((await entryRow(db, entries.nonPiiApprove.entry_id)).employee_code,
    "hrp-2026-300101", "item thu nhat khong duoc ap dung");
  assert.equal((await entryRow(db, entries.payment.entry_id)).version, 1);
  assert.equal(await revisionCount(db, entries.nonPiiApprove.entry_id), revisionsBefore);
  assert.equal(await revisionCount(db, entries.payment.entry_id), paymentRevisionsBefore);
  assert.equal((await requestRow(db, requests.mixed)).state, "PENDING");
  const audits = (await auditRows(db, requests.mixed))
    .filter((row) => row.action === "change_request_approved" || row.action === "change_request_rejected");
  assert.equal(audits.length, 0, "khong co partial audit");
});

test("self-review van bi cam o DB", async () => {
  const denied = await decide(db, ACTORS.proposer, requests.occ,
    "approve", 1, "S03B3R1 self review", "s03b3r1_self_review");
  assert.equal(denied.error.code, "42501");
  assert.match(denied.error.message, /proposer cannot review own request/);
  assert.equal((await requestRow(db, requests.occ)).state, "PENDING");
});

test("reviewer du capability thi quyet dinh thanh cong cho tung target kind", async () => {
  const pii = await decide(db, POLICY_ACTORS.piiView, requests.pii,
    "approve", 1, "S03B3R1 pii approved", "s03b3r1_pii_approved");
  assert.equal(pii.error, null, json(pii.error));
  assert.equal(pii.data.state, "APPROVED");
  assert.equal((await entryRow(db, entries.pii.entry_id)).version, 2);

  const payment = await decide(db, POLICY_ACTORS.paymentFull, requests.payment,
    "approve", 1, "S03B3R1 payment approved", "s03b3r1_payment_approved");
  assert.equal(payment.error, null, json(payment.error));
  assert.equal((await entryRow(db, entries.payment.entry_id)).version, 2);

  const status = await decide(db, POLICY_ACTORS.allCapabilities, requests.status,
    "approve", 1, "S03B3R1 status approved", "s03b3r1_status_approved");
  assert.equal(status.error, null, json(status.error));

});

test("OCC va idempotency khong hoi quy", async () => {
  const conflict = await decide(db, POLICY_ACTORS.entryOnly, requests.occ,
    "approve", 99, "S03B3R1 occ conflict", "s03b3r1_occ_conflict");
  assert.equal(conflict.error.code, "40001");
  const approved = await decide(db, POLICY_ACTORS.entryOnly, requests.occ,
    "approve", 1, "S03B3R1 occ approved", "s03b3r1_occ_approved");
  assert.equal(approved.error, null, json(approved.error));
  assert.equal(approved.data.version, 2);
  const replay = await decide(db, POLICY_ACTORS.entryOnly, requests.occ,
    "approve", 1, "S03B3R1 occ approved", "s03b3r1_occ_approved");
  assert.deepEqual(replay.data, approved.data);
  const decided = await decide(db, POLICY_ACTORS.entryOnly, requests.occ,
    "approve", 1, "S03B3R1 occ approved", "s03b3r1_occ_second_key");
  assert.equal(decided.error.code, "40001");
});

test("audit event chi ghi field name, khong ghi gia tri nhay cam", async () => {
  for (const requestId of [requests.payment, requests.status, requests.pii]) {
    const audits = await auditRows(db, requestId);
    assert.equal(audits.length >= 1, true, requestId);
    for (const row of audits) {
      assertNoSensitive("audit " + row.action, row);
      assert.equal(Array.isArray(row.changed_fields), true);
    }
  }
});

test("revision snapshot moi duoc redact co dinh luc ghi", async () => {
  for (const name of ["payment", "status", "pii"]) {
    const { rows } = await db.query(
      "select before_snapshot, after_snapshot from public.direct_entry_revisions" +
      " where entry_id = $1 order by version desc limit 1",
      [entries[name].entry_id],
    );
    assert.equal(rows.length, 1, name);
    assertNoSensitive("revision " + name, rows[0]);
    assert.deepEqual(rows[0].after_snapshot.worker_details, { present: true }, name);
    assert.equal(typeof rows[0].after_snapshot.employee_code, "string", name);
    assert.equal(typeof rows[0].after_snapshot.version, "number", name);
  }
  const { rows: payment } = await db.query(
    "select after_snapshot from public.direct_entry_revisions" +
    " where entry_id = $1 order by version desc limit 1",
    [entries.payment.entry_id],
  );
  assert.deepEqual(Object.keys(payment[0].after_snapshot.payment).sort(), ["state", "version"]);
  const { rows: status } = await db.query(
    "select after_snapshot from public.direct_entry_revisions" +
    " where entry_id = $1 order by version desc limit 1",
    [entries.status.entry_id],
  );
  assert.deepEqual(Object.keys(status[0].after_snapshot.employment_status).sort(),
    ["effective_date", "status", "version"]);
});

test("read projection tra FULL / MASKED / PRESENCE_ONLY / OMIT theo capability", async () => {
  const fullPayment = await readDetail(db, POLICY_ACTORS.paymentFull, requests.payment);
  assert.equal(fullPayment.error, null);
  assert.deepEqual(fullPayment.data.items[0].proposal, {
    state: "provided", account_number: PAYMENT_PROPOSAL.account_number,
    bank_id: PAYMENT_PROPOSAL.bank_id, account_holder_name: PAYMENT_PROPOSAL.account_holder_name,
  });

  const maskedPayment = await readDetail(db, POLICY_ACTORS.entryOnly, requests.payment);
  const masked = maskedPayment.data.items[0].proposal;
  assert.equal(masked.state, "provided");
  assert.notEqual(masked.account_number, PAYMENT_PROPOSAL.account_number);
  assert.equal(masked.account_number.endsWith("6789"), true);
  assert.equal("bank_id" in masked, false);
  assert.equal("account_holder_name" in masked, false);

  const status = await readDetail(db, ACTORS.proposer, requests.status);
  assert.deepEqual(status.data.items[0].proposal, {
    status: "OFF", effective_date: seeded.proposals.workStatus.effective_date,
  });

  const historicalDocument = await db.query(
    "select public.direct_entry_change_request_proposal_projection(" +
    "'DOCUMENT', $1::jsonb, false, false, true) as full," +
    " public.direct_entry_change_request_proposal_projection(" +
    "'DOCUMENT', $1::jsonb, false, false, false) as limited",
    [JSON.stringify({ document_type: "EMPLOYMENT_CONTRACT", size_bytes: 2048,
      mime_type: "application/pdf", checksum_sha256: "a".repeat(64) })],
  );
  assert.deepEqual(historicalDocument.rows[0].full,
    { document_type: "EMPLOYMENT_CONTRACT", size_bytes: 2048, mime_type: "application/pdf" });
  assert.deepEqual(historicalDocument.rows[0].limited,
    { document_type: "EMPLOYMENT_CONTRACT" });

  const fullPii = await readDetail(db, POLICY_ACTORS.piiView, requests.pii);
  assert.equal(fullPii.data.items[0].proposal.worker_details.display_name, "Synthetic worker");
  const presencePii = await readDetail(db, POLICY_ACTORS.entryOnly, requests.pii);
  assert.deepEqual(presencePii.data.items[0].proposal, { worker_details: { present: true } });

  const nonPii = await readDetail(db, POLICY_ACTORS.entryOnly, requests.nonPiiApprove);
  assert.deepEqual(nonPii.data.items[0].proposal, { labor_type: "PERMANENT" });
  assert.deepEqual(Object.keys(nonPii.data.items[0]).sort(),
    ["entry_id", "expected_version", "proposal", "target_kind"]);

  for (const detail of [fullPayment, maskedPayment, status, fullPii, presencePii, nonPii]) {
    const text = json(detail.data);
    for (const forbidden of ["checksum_sha256", "idempotency_key", "storage_key",
      "leave_reason", "reason_id", "auth_subject", "created_by_user_id", "bucket"]) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  }
});
