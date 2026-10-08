/**
 * P1.6-W04-S04C-S03B3-R1 - Fixture synthetic cho change policy closure.
 *
 * Dung chung cho PGlite DB test va DEV acceptance: KHONG chua PII that, khong credential,
 * khong network. Moi actor/entry/request deu synthetic va duoc don sach bang rollback.
 */
import {
  ACTORS,
  PROJECT_ID,
  RECRUITER_A,
  assertDataOk,
  createChangeRequest,
  decideChangeRequest,
  item,
  mutate,
  readChangeRequest,
  transitionInput,
} from "./s04c-read-fixture.mjs";

export const POLICY_RECRUITER = RECRUITER_A;

export const PAYMENT_PROPOSAL = Object.freeze({
  state: "provided",
  account_number: "0123456789",
  bank_id: "s02b_bank",
  account_holder_name: "NGUYEN VAN SYNTHETIC",
});

export const DOCUMENT_PROPOSAL = Object.freeze({
  document_type: "EMPLOYMENT_CONTRACT",
  idempotency_key: "s03b3r1_document_key",
  checksum_sha256: "a".repeat(64),
  size_bytes: 2048,
  mime_type: "application/pdf",
});

export const LEAVE_REASON_TEXT = "Synthetic leave reason";

export const WORK_STATUS_PROPOSAL = Object.freeze({
  status: "OFF",
  effective_date: "2026-10-16",
  leave_reason: LEAVE_REASON_TEXT,
});

export const POLICY_ACTORS = Object.freeze({
  entryOnly: {
    auth_subject: "10000000-0000-4000-8000-000000000101",
    app_user_id: "20000000-0000-4000-8000-000000000201",
    capabilities: ["change_review"],
  },
  piiView: {
    auth_subject: "10000000-0000-4000-8000-000000000102",
    app_user_id: "20000000-0000-4000-8000-000000000202",
    capabilities: ["change_review", "pii_view"],
  },
  paymentView: {
    auth_subject: "10000000-0000-4000-8000-000000000103",
    app_user_id: "20000000-0000-4000-8000-000000000203",
    capabilities: ["change_review", "payment_view"],
  },
  paymentFull: {
    auth_subject: "10000000-0000-4000-8000-000000000104",
    app_user_id: "20000000-0000-4000-8000-000000000204",
    capabilities: ["change_review", "payment_view", "payment_edit"],
  },
  statusApply: {
    auth_subject: "10000000-0000-4000-8000-000000000105",
    app_user_id: "20000000-0000-4000-8000-000000000205",
    capabilities: ["change_review", "employment_status.apply"],
  },
  documentView: {
    auth_subject: "10000000-0000-4000-8000-000000000106",
    app_user_id: "20000000-0000-4000-8000-000000000206",
    capabilities: ["change_review", "document_view"],
  },
  documentFull: {
    auth_subject: "10000000-0000-4000-8000-000000000107",
    app_user_id: "20000000-0000-4000-8000-000000000207",
    capabilities: ["change_review", "document_view", "document_upload"],
  },
  allCapabilities: {
    auth_subject: "10000000-0000-4000-8000-000000000108",
    app_user_id: "20000000-0000-4000-8000-000000000208",
    capabilities: [
      "change_review", "pii_view", "payment_view", "payment_edit",
      "employment_status.apply", "document_view", "document_upload",
    ],
  },
});

export function unprotectedWorkerDetails(displayName) {
  return { ...worker(displayName), address: { state: "provided", value: "W04 unprotected change" } };
}

export function worker(displayName) {
  const optional = { state: "unknown" };
  return {
    display_name: displayName,
    date_of_birth: optional,
    national_id: optional,
    address: optional,
    phone: optional,
  };
}

export async function insertPolicyActor(db, actor) {
  await db.query("insert into auth.users(id) values ($1)", [actor.auth_subject]);
  // P2.5-HF-R5: display_name exists from #62; earlier partial ledgers
  // (historical contract tests) must keep working without it.
  const hasDisplayName = (await db.query(
    "select 1 from information_schema.columns where table_schema='public'" +
    " and table_name='direct_entry_app_users' and column_name='display_name'",
  )).rows.length > 0;
  await db.query(
    hasDisplayName
      ? "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name) values ($1,$2,true,'Synthetic Account')"
      : "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled) values ($1,$2,true)",
    [actor.app_user_id, actor.auth_subject],
  );
  for (const capability of actor.capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
      " values ($1,$2,'2020-01-01')",
      [actor.app_user_id, capability],
    );
  }
  await db.query(
    "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from)" +
    " values ($1,'all','2020-01-01')",
    [actor.app_user_id],
  );
}

export async function insertPolicyActors(db) {
  for (const actor of Object.values(POLICY_ACTORS)) {
    await insertPolicyActor(db, actor);
  }
}

/**
 * Tao mot submission rieng voi 7 entry synthetic (da SUBMITTED) de moi quyet dinh duong tinh
 * khong lam lech expected_version cua cac request khac.
 */
export async function seedPolicyEntries(db, suffix) {
  const codes = {
    nonPiiApprove: "hrp-2026-300101",
    nonPiiReject: "hrp-2026-300102",
    payment: "hrp-2026-300103",
    status: "hrp-2026-300104",
    document: "hrp-2026-300105",
    pii: "hrp-2026-300106",
    occ: "hrp-2026-300107",
  };
  // first_work_date phai la ngay da qua: trigger employment status doi hieu luc <= ngay hien tai.
  const { rows: dayRows } = await db.query(
    "select (current_date - 30)::text as first_work_date");
  const firstWorkDate = dayRows[0].first_work_date;
  const created = await db.query(
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text) as data",
    [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id,
      JSON.stringify(Object.values(codes).map((code) => ({
        project_id: PROJECT_ID,
        first_work_date: firstWorkDate,
        employee_code: code,
        worker_details: worker("Synthetic " + code),
        recruiter_id: POLICY_RECRUITER,
        labor_type: "TEMPORARY",
      }))),
      suffix + "_batch"],
  );
  assertDataOk(created);
  const rows = await db.query(
    "select e.entry_id, e.submission_id, e.employee_code, e.version, e.team_id" +
    " from public.direct_entries e where e.employee_code = any($1::text[])" +
    " order by e.employee_code",
    [Object.values(codes)],
  );
  const byCode = new Map(rows.rows.map((row) => [row.employee_code, row]));
  const entries = {};
  for (const [name, code] of Object.entries(codes)) {
    entries[name] = byCode.get(code);
  }
  const submissionId = rows.rows[0].submission_id;
  const toReview = transitionInput(ACTORS.proposer, submissionId, 1, "REVIEW", suffix + "_r");
  await db.query(toReview.sql, toReview.values);
  const toSubmitted = transitionInput(ACTORS.proposer, submissionId, 2, "SUBMITTED", suffix + "_s");
  await db.query(toSubmitted.sql, toSubmitted.values);
  // New batches start ON; the status proposal below is a valid transition from
  // that server-created baseline (legacy UNCONFIRMED remains accepted).
  const refreshed = await db.query(
    "select e.entry_id, e.version from public.direct_entries e where e.entry_id = any($1::uuid[])",
    [Object.values(entries).map((entry) => entry.entry_id)]);
  const versions = new Map(refreshed.rows.map((row) => [row.entry_id, row.version]));
  for (const entry of Object.values(entries)) {
    entry.version = versions.get(entry.entry_id) ?? entry.version;
  }
  return { entries, submissionId, codes, firstWorkDate };
}

/**
 * Tao mot change request cho tung nhom policy. Tra ve { requestId, expectedVersion, entryId }.
 */
export async function seedPolicyRequests(db, seeded, suffix) {
  const { entries } = seeded;
  // Ngay hieu luc phai >= lan chuyen truoc va <= ngay hien tai (trigger cua DB).
  const workStatusProposal = {
    ...WORK_STATUS_PROPOSAL, effective_date: seeded.firstWorkDate,
  };
  const plan = [
    ["nonPiiApprove", entries.nonPiiApprove, "ENTRY_FIELD", { worker_details: unprotectedWorkerDetails("Synthetic " + entries.nonPiiApprove.employee_code) }],
    ["nonPiiReject", entries.nonPiiReject, "ENTRY_FIELD", { worker_details: unprotectedWorkerDetails("Synthetic " + entries.nonPiiReject.employee_code) }],
    ["pii", entries.pii, "ENTRY_FIELD", { worker_details: unprotectedWorkerDetails("Synthetic " + entries.pii.employee_code) }],
    ["payment", entries.payment, "PAYMENT", PAYMENT_PROPOSAL],
    ["status", entries.status, "WORK_STATUS", workStatusProposal],
    ["occ", entries.occ, "ENTRY_FIELD", { worker_details: unprotectedWorkerDetails("Synthetic " + entries.occ.employee_code) }],
  ];
  const requests = {};
  for (const [name, entry, targetKind, proposal] of plan) {
    const created = await createChangeRequest(
      db, ACTORS.proposer,
      [item(entry.entry_id, entry.version, proposal, targetKind)],
      "S03B3R1 " + name + " reason", suffix + "_create_" + name,
    );
    if (created.error) throw new Error(name + " create failed: " + created.error.message);
    requests[name] = created.data.request_id;
  }
  const mixed = await createChangeRequest(
    db, ACTORS.proposer,
    [
      item(entries.nonPiiApprove.entry_id, entries.nonPiiApprove.version,
        { worker_details: unprotectedWorkerDetails("Synthetic " + entries.nonPiiApprove.employee_code) }),
      item(entries.payment.entry_id, entries.payment.version, PAYMENT_PROPOSAL, "PAYMENT"),
    ],
    "S03B3R1 mixed reason", suffix + "_create_mixed",
  );
  if (mixed.error) throw new Error("mixed create failed: " + mixed.error.message);
  requests.mixed = mixed.data.request_id;
  return { requests, workStatusProposal };
}

export async function seedPolicyFixture(db, suffix, { manageTransaction = true } = {}) {
  if (manageTransaction) await db.query("begin");
  try {
    await insertPolicyActors(db);
    const seeded = await seedPolicyEntries(db, suffix);
    const { requests, workStatusProposal } = await seedPolicyRequests(db, seeded, suffix);
    if (manageTransaction) await db.query("commit");
    return { ...seeded, requests, proposals: { workStatus: workStatusProposal } };
  } catch (error) {
    if (manageTransaction) await db.query("rollback");
    throw error;
  }
}

export function decide(db, actor, requestId, decision, expectedVersion, reason, key) {
  return decideChangeRequest(db, actor, requestId, decision, expectedVersion, reason, key);
}

export function readDetail(db, actor, requestId) {
  return readChangeRequest(db, actor, requestId);
}

export function applyChangeItem(db, actor, requestId, entryId, targetKind, proposal, reasonId) {
  return mutate(db,
    "select public.direct_entry_apply_change_item($1::uuid,$2::uuid,$3::uuid," +
    " (select e from public.direct_entries e where e.entry_id = $4::uuid)," +
    " $5::text, $6::jsonb, $7::uuid) as data",
    [actor.auth_subject, actor.app_user_id, requestId, entryId, targetKind,
      JSON.stringify(proposal), reasonId]);
}

export async function entryRow(db, entryId) {
  const { rows } = await db.query(
    "select version, employee_code, labor_type from public.direct_entries where entry_id = $1",
    [entryId]);
  return rows[0];
}

export async function requestRow(db, requestId) {
  const { rows } = await db.query(
    "select state, version from public.direct_entry_change_requests where request_id = $1",
    [requestId]);
  return rows[0];
}

export async function revisionCount(db, entryId) {
  const { rows } = await db.query(
    "select count(*)::int as total from public.direct_entry_revisions where entry_id = $1",
    [entryId]);
  return rows[0].total;
}

export async function auditRows(db, requestId) {
  const { rows } = await db.query(
    "select action, capability, outcome, changed_fields, resource_ref" +
    " from public.direct_entry_audit_events where resource_ref = $1",
    [requestId]);
  return rows;
}
