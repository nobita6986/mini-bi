#!/usr/bin/env node
/**
 * P1.6-W04-S04C-S03B3-R1 - DEV synthetic acceptance cho change policy security closure.
 *
 * Chay THAT tren shared DEV trong MOT transaction ngoai cung va rollback o cuoi (residue = 0).
 * Chi dung SQL + RPC san co: KHONG R2, KHONG provider AI, KHONG deploy, KHONG ghi file/secret.
 * Fixture hoan toan synthetic. Day la hardening truoc go-live, khong phai xu ly su co du lieu.
 *
 * Luu y ky thuat: moi loi DU KIEN phai chay trong SAVEPOINT (tren Postgres that mot statement loi
 * lam hong transaction ngoai cung: SQLSTATE 25P02). Vi vay harness goi RPC truc tiep va bat loi,
 * khong dung helper tra ve { error } vi helper do se che mat trang thai aborted cua transaction.
 *
 * Dung: node scripts/p1.6-s04c-policy-closure-dev-acceptance.mjs
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import pg from "pg";

import { expectedDirectEntryFunctions } from "./lib/direct-entry-inventory.mjs";
import { readMigrations } from "./lib/migration-validation.mjs";
import {
  ACTORS,
  PROJECT_ID,
  RECRUITER_A,
  RECRUITER_B,
  TEAM_A,
  TEAM_B,
  seedChangeRequestFixture,
} from "./lib/s04c-read-fixture.mjs";
import {
  LEAVE_REASON_TEXT,
  PAYMENT_PROPOSAL,
  POLICY_ACTORS,
  auditRows,
  entryRow,
  requestRow,
  revisionCount,
  seedPolicyFixture,
} from "./lib/s04c-policy-fixture.mjs";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const migrationDir = path.resolve("supabase/migrations");
const namespace = "s03b3r1dev";
const POLICY_MIGRATION = "20261005030000_p1_6_w04_s04c_s03b3_r1_change_policy_closure.sql";
const NEW_HELPERS = [
  "public.direct_entry_has_capability(uuid,text)",
  "public.direct_entry_change_request_required_capabilities(uuid)",
  "public.direct_entry_assert_change_request_capabilities(uuid,uuid,uuid)",
  "public.direct_entry_change_request_proposal_projection(text,jsonb,boolean,boolean,boolean)",
];
const INTERNAL_HELPERS = [
  ...NEW_HELPERS,
  "public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)",
  "public.direct_entry_decide_change_request(uuid,uuid,uuid,integer,text,text,text)",
  "public.direct_entry_entry_snapshot(uuid)",
  "public.direct_entry_assert_actor_mapping(uuid,uuid)",
  "public.direct_entry_has_entry_access(uuid,text,uuid,uuid,date)",
  "public.direct_entry_change_request_audience(uuid,uuid,uuid)",
];
const SERVICE_RPCS = [
  "public.direct_entry_read_change_request(uuid,uuid,uuid)",
  "public.direct_entry_list_change_requests(uuid,uuid,integer,text,text)",
  "public.direct_entry_approve_change_request(uuid,uuid,uuid,integer,text,text)",
  "public.direct_entry_reject_change_request(uuid,uuid,uuid,integer,text,text)",
];
const checks = [];
let transactionOpen = false;

function pass(label) {
  checks.push(label);
}

function key(label) {
  return namespace + "_" + label + "_" + randomBytes(3).toString("hex");
}

function json(value) {
  return JSON.stringify(value);
}

/** Chay mot lenh DU KIEN that bai trong savepoint de transaction ngoai cung con dung duoc. */
async function attempt(client, run) {
  const savepoint = namespace + "_sp_" + randomBytes(3).toString("hex");
  await client.query("savepoint " + savepoint);
  try {
    const result = await run();
    await client.query("release savepoint " + savepoint);
    return { data: result, error: null };
  } catch (error) {
    await client.query("rollback to savepoint " + savepoint);
    await client.query("release savepoint " + savepoint);
    return { data: null, error: { code: error.code, constraint: error.constraint, message: error.message } };
  }
}

async function decideRpc(client, actor, requestId, decision, expectedVersion, reason,
  idempotencyKey) {
  const fn = decision === "approve"
    ? "public.direct_entry_approve_change_request"
    : "public.direct_entry_reject_change_request";
  const { rows } = await client.query(
    "select " + fn + "($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text) as data",
    [actor.auth_subject, actor.app_user_id, requestId, expectedVersion, reason, idempotencyKey]);
  return rows[0].data;
}

async function readRequest(client, actor, requestId) {
  const { rows } = await client.query(
    "select public.direct_entry_read_change_request($1::uuid,$2::uuid,$3::uuid) as data",
    [actor.auth_subject, actor.app_user_id, requestId]);
  return rows[0].data;
}

async function applyItemRpc(client, actor, requestId, entryId, targetKind, proposal) {
  const { rows: reasonRows } = await client.query(
    "select public.direct_entry_reason($1::uuid,$2::text) as id",
    [actor.app_user_id, "S03B3R1 DEV direct apply probe"]);
  const { rows } = await client.query(
    "select public.direct_entry_apply_change_item($1::uuid,$2::uuid,$3::uuid," +
    " (select e from public.direct_entries e where e.entry_id = $4::uuid)," +
    " $5::text, $6::jsonb, $7::uuid) as data",
    [actor.auth_subject, actor.app_user_id, requestId, entryId, targetKind,
      JSON.stringify(proposal), reasonRows[0].id]);
  return rows[0].data;
}

async function baseline(client) {
  const { rows } = await client.query(
    "select" +
    " (select count(*)::int from public.data_sources where active and not is_test) as sources," +
    " (select coalesce(sum(b.recruited_count), 0)::bigint" +
    "    from public.daily_recruitment_breakdown b" +
    "    join public.data_sources s on s.id=b.source_id" +
    "   where s.active and not s.is_test) as total," +
    " (select count(*)::int" +
    "    from public.daily_recruitment_breakdown b" +
    "    join public.data_sources s on s.id=b.source_id" +
    "   where s.active and not s.is_test) as rows",
  );
  return rows[0];
}

async function assertDatabaseBoundary(client) {
  const local = await readMigrations(migrationDir);
  const { rows: applied } = await client.query(
    "select version, checksum from public.schema_migrations order by version");
  assert.equal(applied.length, local.length, "migration count");
  const appliedMap = new Map(applied.map(({ version, checksum }) => [version, checksum]));
  assert.deepEqual(local.filter(({ name }) => !appliedMap.has(name)), [], "pending migration");
  assert.deepEqual(
    local.filter(({ name, checksum }) => appliedMap.has(name) && appliedMap.get(name) !== checksum),
    [], "checksum mismatch");
  assert.ok(local.some(({ name }) => name === POLICY_MIGRATION), POLICY_MIGRATION);
  pass(local.length + " migrations applied (bao gom " + POLICY_MIGRATION + "); 0 pending, 0 mismatch");

  const expected = [...expectedDirectEntryFunctions(local)].sort();
  const { rows: live } = await client.query(
    "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
    " where n.nspname = 'public' and p.proname like 'direct_entry_%'");
  const liveNames = [...new Set(live.map(({ proname }) => proname))].sort();
  assert.deepEqual(liveNames, expected, "RPC inventory phai khop migration source");
  pass(expected.length + " direct_entry_* functions tren DEV khop inventory suy ra tu migration");

  for (const signature of INTERNAL_HELPERS) {
    const { rows } = await client.query(
      "select has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon_exec," +
      " has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth_exec," +
      " has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_exec",
      [signature]);
    assert.equal(rows.length, 1, signature);
    assert.deepEqual([rows[0].anon_exec, rows[0].auth_exec, rows[0].service_exec],
      [false, false, false], signature);
  }
  for (const signature of SERVICE_RPCS) {
    const { rows } = await client.query(
      "select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as config," +
      " has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec," +
      " has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec," +
      " has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec" +
      " from pg_proc p where p.oid = $1::regprocedure",
      [signature]);
    assert.equal(rows[0].prosecdef, true, signature);
    assert.equal(rows[0].config, "search_path=pg_catalog, public", signature);
    assert.deepEqual([rows[0].anon_exec, rows[0].auth_exec, rows[0].service_exec],
      [false, false, true], signature);
  }
  pass("helper noi bo khong co EXECUTE; RPC public security definer + search_path co dinh + service_role only");

  for (const table of ["direct_entry_change_requests", "direct_entry_change_request_items",
    "direct_entry_payments", "direct_entry_revisions", "direct_entry_audit_events",
    "direct_entries", "direct_entry_document_versions"]) {
    const { rows } = await client.query(
      "select c.relrowsecurity, c.relforcerowsecurity from pg_class c" +
      " join pg_namespace n on n.oid = c.relnamespace" +
      " where n.nspname = 'public' and c.relname = $1", [table]);
    assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity], [true, true], table);
    for (const role of ["anon", "authenticated"]) {
      const { rows: privilege } = await client.query(
        "select has_table_privilege($1, $2, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') as allowed",
        [role, "public." + table]);
      assert.equal(privilege[0].allowed, false, role + " on " + table);
    }
  }
  pass("RLS + FORCE RLS giu nguyen tren bang policy; anon/authenticated khong co table privilege");
}

async function runAcceptance(client, reportingBefore) {
  await seedChangeRequestFixture(client, { manageTransaction: false });
  const seeded = await seedPolicyFixture(client, namespace, { manageTransaction: false });
  const requests = seeded.requests;
  const entries = seeded.entries;
  pass("seed fixture synthetic: actor/entry/change request trong scope (khong PII that)");

  const scopeCounts = async () => {
    const { rows } = await client.query(
      "select" +
      " (select count(*)::int from public.direct_entry_change_requests) as requests," +
      " (select count(*)::int from public.direct_entry_change_request_items) as items," +
      " (select count(*)::int from public.direct_entry_change_request_revisions) as request_revisions," +
      " (select count(*)::int from public.direct_entry_revisions) as revisions," +
      " (select count(*)::int from public.direct_entry_audit_events) as audits," +
      " (select count(*)::int from public.direct_entry_rpc_idempotency) as idempotency");
    return rows[0];
  };
  const scopeBefore = await scopeCounts();
  const documentCreate = await attempt(client, () => client.query(
    "select public.direct_entry_create_change_request($1::uuid,$2::uuid,$3::jsonb,$4::text,$5::text)",
    [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id,
      JSON.stringify([{
        entry_id: entries.document.entry_id,
        target_kind: "DOCUMENT",
        expected_version: entries.document.version,
        proposal: {
          document_type: "EMPLOYMENT_CONTRACT",
          idempotency_key: "synthetic_document_idempotency",
          checksum_sha256: "a".repeat(64),
          size_bytes: 2048,
          mime_type: "application/pdf",
        },
      }]),
      "S04C synthetic scope-lock rejection", key("document_scope_lock")]));
  assert.equal(documentCreate.error?.code, "23514", json(documentCreate.error));
  assert.equal(documentCreate.error?.constraint,
    "direct_entry_change_request_items_document_scope_lock");
  assert.deepEqual(await scopeCounts(), scopeBefore,
    "DOCUMENT rejection must not leave request/item/revision/audit/idempotency writes");
  pass("DOCUMENT RPC create bi CHECK tu choi, khong phat sinh request/item/revision/audit/idempotency");

  // 1. Negative policy matrix: thieu capability thi 42501 va khong co mutation nao.
  const revisionsBefore = await revisionCount(client, entries.pii.entry_id);
  const negative = [
    ["worker_details thieu pii_view (approve)", POLICY_ACTORS.entryOnly, requests.pii, "approve"],
    ["worker_details thieu pii_view (reject)", POLICY_ACTORS.entryOnly, requests.pii, "reject"],
    ["PAYMENT thieu payment_view", POLICY_ACTORS.entryOnly, requests.payment, "approve"],
    ["mixed thieu dung mot capability", POLICY_ACTORS.paymentView, requests.mixed, "approve"],
  ];
  // P2.5-W05-R1: PAYMENT needs only payment_view and WORK_STATUS only change_review, so
  // the apply-side tokens (payment_edit / employment_status.apply) are no longer part of
  // the review matrix and are deliberately absent from the negative list.
  for (const [label, actor, requestId, decision] of negative) {
    const outcome = await attempt(client, () => decideRpc(client, actor, requestId, decision, 1,
      "S03B3R1 DEV " + label, key("denied")));
    assert.equal(outcome.error?.code, "42501", label + " :: " + json(outcome.error));
    assert.equal(outcome.error.message.includes("capability denied"), true, label);
  }
  const directApply = await attempt(client, () => applyItemRpc(client, POLICY_ACTORS.entryOnly,
    requests.payment, entries.payment.entry_id, "PAYMENT", PAYMENT_PROPOSAL));
  assert.equal(directApply.error?.code, "42501", "apply-level guard :: " + json(directApply.error));
  assert.equal((await requestRow(client, requests.payment)).state, "PENDING");
  assert.equal((await entryRow(client, entries.payment.entry_id)).version, 1);
  assert.equal((await entryRow(client, entries.nonPiiApprove.entry_id)).employee_code,
    seeded.codes.nonPiiApprove, "mixed request khong duoc ap dung mot phan");
  assert.equal(await revisionCount(client, entries.pii.entry_id), revisionsBefore);
  pass("policy matrix tu choi 4 truong hop + guard o tang apply (khong partial apply)");

  // 2. Self-review van bi cam.
  const selfReview = await attempt(client, () => decideRpc(client, ACTORS.proposer, requests.occ,
    "approve", 1, "S03B3R1 DEV self review", key("self")));
  assert.equal(selfReview.error?.code, "42501", json(selfReview.error));
  assert.match(selfReview.error.message, /proposer cannot review own request/);
  pass("self-review van bi DB tu choi");

  // 3. Positive: ENTRY_FIELD 5 truong non-PII chi can change_review.
  const approveKey = key("approve");
  const approved = await decideRpc(client, POLICY_ACTORS.entryOnly, requests.nonPiiApprove,
    "approve", 1, "S03B3R1 DEV approve", approveKey);
  assert.equal(approved.state, "APPROVED");
  const replayed = await decideRpc(client, POLICY_ACTORS.entryOnly, requests.nonPiiApprove,
    "approve", 1, "S03B3R1 DEV approve", approveKey);
  assert.deepEqual(replayed, approved, "replay cung key phai tra cung ket qua");
  const rejected = await decideRpc(client, POLICY_ACTORS.entryOnly, requests.nonPiiReject,
    "reject", 1, "S03B3R1 DEV reject", key("reject"));
  assert.equal(rejected.state, "REJECTED");
  const replayOtherKey = await attempt(client, () => decideRpc(client, POLICY_ACTORS.entryOnly,
    requests.nonPiiReject, "reject", 1, "S03B3R1 DEV reject", key("reject_other")));
  assert.equal(replayOtherKey.error?.code, "40001", json(replayOtherKey.error));
  pass("ENTRY_FIELD non-PII duoc duyet/tu choi voi change_review; replay khac key bi OCC chan");

  // 4. Positive voi day du capability cho tung target kind.
  for (const [label, actor, requestId] of [
    ["ENTRY_FIELD.worker_details", POLICY_ACTORS.piiView, requests.pii],
    ["PAYMENT", POLICY_ACTORS.paymentFull, requests.payment],
    ["WORK_STATUS", POLICY_ACTORS.allCapabilities, requests.status],
  ]) {
    const decided = await decideRpc(client, actor, requestId, "approve", 1,
      "S03B3R1 DEV approve " + label, key("approve_kind"));
    assert.equal(decided.state, "APPROVED", label);
  }
  pass("reviewer du capability duyet duoc ca ba target kind duoc ho tro");

  // 5. Read projection FULL / MASKED / PRESENCE_ONLY / OMIT.
  const fullPayment = await readRequest(client, POLICY_ACTORS.paymentFull, requests.payment);
  assert.deepEqual(fullPayment.items[0].proposal, {
    state: "provided", account_number: PAYMENT_PROPOSAL.account_number,
    bank_id: PAYMENT_PROPOSAL.bank_id, account_holder_name: PAYMENT_PROPOSAL.account_holder_name,
  });
  const masked = (await readRequest(client, POLICY_ACTORS.entryOnly, requests.payment))
    .items[0].proposal;
  assert.notEqual(masked.account_number, PAYMENT_PROPOSAL.account_number);
  assert.equal(masked.account_number.endsWith("6789"), true);
  assert.equal("bank_id" in masked, false);
  assert.equal("account_holder_name" in masked, false);
  const fullPii = await readRequest(client, POLICY_ACTORS.piiView, requests.pii);
  assert.equal(fullPii.items[0].proposal.worker_details.display_name, "Synthetic worker");
  const presencePii = await readRequest(client, POLICY_ACTORS.entryOnly, requests.pii);
  assert.deepEqual(presencePii.items[0].proposal, { worker_details: { present: true } });
  const historicalDocument = await client.query(
    "select public.direct_entry_change_request_proposal_projection(" +
    "'DOCUMENT', $1::jsonb, false, false, true) as full," +
    " public.direct_entry_change_request_proposal_projection(" +
    "'DOCUMENT', $1::jsonb, false, false, false) as limited",
    [JSON.stringify({ document_type: "EMPLOYMENT_CONTRACT", size_bytes: 2048,
      mime_type: "application/pdf", checksum_sha256: "a".repeat(64) })]);
  assert.deepEqual(historicalDocument.rows[0].full,
    { document_type: "EMPLOYMENT_CONTRACT", size_bytes: 2048, mime_type: "application/pdf" });
  assert.deepEqual(historicalDocument.rows[0].limited,
    { document_type: "EMPLOYMENT_CONTRACT" });
  const statusDetail = await readRequest(client, ACTORS.proposer, requests.status);
  assert.deepEqual(statusDetail.items[0].proposal,
    { status: "OFF", effective_date: seeded.proposals.workStatus.effective_date });
  for (const detail of [fullPayment, masked, fullPii, presencePii, statusDetail]) {
    const text = json(detail);
    for (const forbidden of ["checksum_sha256", "idempotency_key", "storage_key",
      "leave_reason", "reason_id", "auth_subject"]) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  }
  pass("read projection tra FULL/MASKED/PRESENCE_ONLY/OMIT dung matrix, khong co key cam");

  // 6. Audit + revision redaction.
  for (const requestId of [requests.payment, requests.status, requests.pii]) {
    const audits = await auditRows(client, requestId);
    assert.equal(audits.length >= 1, true, requestId);
    for (const row of audits) {
      const text = json(row);
      for (const forbidden of ["0123456789", "NGUYEN VAN SYNTHETIC", LEAVE_REASON_TEXT,
        "checksum_sha256", "idempotency_key", "national_id", "date_of_birth", "phone"]) {
        assert.equal(text.includes(forbidden), false, requestId + " audit leaked " + forbidden);
      }
    }
  }
  for (const name of ["payment", "status", "pii"]) {
    const { rows } = await client.query(
      "select before_snapshot, after_snapshot from public.direct_entry_revisions" +
      " where entry_id = $1 order by version desc limit 1", [entries[name].entry_id]);
    assert.equal(rows.length, 1, name);
    const text = json(rows[0]);
    for (const forbidden of ["0123456789", "NGUYEN VAN SYNTHETIC", LEAVE_REASON_TEXT,
      "checksum_sha256", "idempotency_key", "storage_key", "national_id", "date_of_birth",
      "phone", "address", "account_number", "account_holder_name", "size_bytes", "mime_type"]) {
      assert.equal(text.includes(forbidden), false, "revision " + name + " leaked " + forbidden);
    }
    assert.deepEqual(rows[0].after_snapshot.worker_details, { present: true }, name);
  }
  pass("audit chi ghi field name; revision moi duoc redact co dinh luc ghi tren DEV");

  // 7. Cleanup.
  await client.query("rollback");
  transactionOpen = false;
  const actorIds = [...Object.values(POLICY_ACTORS).map((actor) => actor.app_user_id),
    ACTORS.proposer.app_user_id, ACTORS.reviewer.app_user_id];
  const requestIds = Object.values(requests);
  const entryIds = Object.values(entries).map((entry) => entry.entry_id);
  const { rows: residue } = await client.query(
    "select" +
    " (select count(*)::int from public.direct_entry_app_users where app_user_id = any($1::uuid[])) as actors," +
    " (select count(*)::int from public.direct_entry_change_requests where request_id = any($2::uuid[])) as requests," +
    " (select count(*)::int from public.direct_entries where entry_id = any($3::uuid[])) as entries," +
    " (select count(*)::int from public.direct_entry_revisions where entry_id = any($3::uuid[])) as revisions," +
    " (select count(*)::int from public.direct_entry_audit_events where resource_ref = any($2::text[])) as audits," +
    " (select count(*)::int from public.teams where team_id = any($4::uuid[])) as teams," +
    " (select count(*)::int from public.recruiters where recruiter_id = any($5::uuid[])) as recruiters," +
    " (select count(*)::int from public.direct_entry_projects where project_id = $6) as projects," +
    " (select count(*)::int from public.direct_entry_payments where entry_id = any($3::uuid[])) as payments," +
    " (select count(*)::int from public.direct_entry_document_versions where candidate_id in" +
    "   (select candidate_id from public.direct_entries where entry_id = any($3::uuid[]))) as documents",
    [actorIds, requestIds, entryIds, [TEAM_A, TEAM_B], [RECRUITER_A, RECRUITER_B], PROJECT_ID]);
  assert.deepEqual(residue[0], {
    actors: 0, requests: 0, entries: 0, revisions: 0, audits: 0, teams: 0, recruiters: 0,
    projects: 0, payments: 0, documents: 0,
  });
  assert.deepEqual(await baseline(client), reportingBefore);
  pass("rollback de lai residue = 0 va reporting baseline khong doi (khong cham R2)");
}

async function main() {
  const { databaseUrl, projectRef, usesPooler } = await loadSupabaseConfig();
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: buildSslOptions(),
    application_name: "p1.6-s04c-s03b3-r1-dev-acceptance",
  });
  await client.connect();
  try {
    console.log("DEV acceptance project: " + projectRef.slice(0, 4) + "***; pooler=" +
      (usesPooler ? "yes" : "no"));
    // Boundary/baseline chi doc: chay truoc transaction nghiep vu cho gon.
    await assertDatabaseBoundary(client);
    const reportingBefore = await baseline(client);
    await client.query("begin");
    transactionOpen = true;
    await runAcceptance(client, reportingBefore);
    for (const [index, label] of checks.entries()) console.log("PASS " + (index + 1) + ". " + label);
    console.log("S03B3-R1 change policy DEV acceptance: " + checks.length + " checks passed.");
  } finally {
    if (transactionOpen) await client.query("rollback").catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error("S03B3-R1 DEV acceptance failed; SQLSTATE=" + (error.code ?? "none") +
    "; constraint=" + (error.constraint ?? "none") + "; message=" + error.message);
  process.exitCode = 1;
});
