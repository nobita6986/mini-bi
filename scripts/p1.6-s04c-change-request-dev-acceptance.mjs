#!/usr/bin/env node
/**
 * P1.6-W04-S04C-S02A - DEV synthetic acceptance cho change request boundary.
 *
 * Chay THAT tren DEV trong MOT transaction ngoai cung va rollback o cuoi (residue = 0).
 * Khong migration moi, khong deploy, fixture hoan toan synthetic.
 *
 * Dung: node --conditions=react-server scripts/p1.6-s04c-change-request-dev-acceptance.mjs
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";

import {
  createChangeRequest,
  decideChangeRequest,
  withdrawChangeRequest,
} from "../src/lib/direct-entry/change-request-api.ts";
import { createChangeRequestRepository } from "../src/lib/direct-entry/change-request-repository.ts";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";
import { readMigrations } from "./lib/migration-validation.mjs";

const migrationDir = path.resolve("supabase/migrations");
const expectedMigrationCount = 29;
const namespace = "s04cs02a";
const checks = [];
let transactionOpen = false;

function pass(label) {
  checks.push(label);
}

function key(label) {
  return namespace + "_" + label + "_" + randomBytes(3).toString("hex");
}

async function roleQuery(client, role, sql, values = []) {
  const savepoint = namespace + "_role_" + randomBytes(3).toString("hex");
  await client.query("savepoint " + savepoint);
  try {
    await client.query("set local role " + role);
    const result = await client.query(sql, values);
    await client.query("reset role");
    await client.query("release savepoint " + savepoint);
    return result;
  } catch (error) {
    await client.query("rollback to savepoint " + savepoint);
    await client.query("release savepoint " + savepoint);
    throw error;
  }
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
    "   where s.active and not s.is_test) as rows"
  );
  return rows[0];
}

async function assertDatabaseBoundary(client) {
  const { rows: migrationRows } = await client.query(
    "select version, checksum from public.schema_migrations order by version",
  );
  const local = await readMigrations(migrationDir);
  assert.equal(local.length, expectedMigrationCount);
  assert.equal(migrationRows.length, expectedMigrationCount);
  const applied = new Map(migrationRows.map(({ version, checksum }) => [version, checksum]));
  assert.deepEqual(local.filter(({ name }) => !applied.has(name)), []);
  assert.deepEqual(
    local.filter(({ name, checksum }) => applied.has(name) && applied.get(name) !== checksum),
    [],
  );
  pass(expectedMigrationCount + " migrations applied; no pending migration and no checksum mismatch");

  for (const signature of [
    "public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)",
    "public.direct_entry_withdraw_change_request(uuid,uuid,uuid,integer,text)",
    "public.direct_entry_approve_change_request(uuid,uuid,uuid,integer,text,text)",
    "public.direct_entry_reject_change_request(uuid,uuid,uuid,integer,text,text)",
  ]) {
    const { rows } = await client.query(
      "select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as config," +
      " has_function_privilege('anon',p.oid,'EXECUTE') as anon_exec," +
      " has_function_privilege('authenticated',p.oid,'EXECUTE') as auth_exec," +
      " has_function_privilege('service_role',p.oid,'EXECUTE') as service_exec" +
      " from pg_proc p where p.oid = $1::regprocedure",
      [signature],
    );
    assert.equal(rows.length, 1, signature);
    assert.equal(rows[0].prosecdef, true, signature);
    assert.ok(rows[0].config.includes("search_path=pg_catalog, public"), signature);
    assert.equal(rows[0].anon_exec, false, signature);
    assert.equal(rows[0].auth_exec, false, signature);
    assert.equal(rows[0].service_exec, true, signature);
  }
  pass("four change request RPCs are security definer, pinned and service-role only");

  const { rows: helper } = await client.query(
    "select has_function_privilege('service_role'," +
    " 'public.direct_entry_decide_change_request(uuid,uuid,uuid,integer,text,text,text)'::regprocedure," +
    " 'EXECUTE') as service_exec",
  );
  assert.equal(helper[0].service_exec, false);
  pass("helper direct_entry_decide_change_request is NOT executable by service_role");

  const localSql = local.map(({ sql }) => sql).join("\n");
  const declared = new Set(
    [...localSql.matchAll(/function public\.(direct_entry_[a-z0-9_]+)\s*\(/g)].map((match) => match[1]),
  );
  const { rows: functions } = await client.query(
    "select distinct p.proname from pg_proc p" +
    " join pg_namespace n on n.oid=p.pronamespace" +
    " where n.nspname='public' and p.proname like 'direct_entry_%'",
  );
  assert.deepEqual(functions.map(({ proname }) => proname).sort(), [...declared].sort());
  pass("RPC inventory matches migrations exactly (" + declared.size + " functions, no drift)");
}

async function insertActor(client, actor, capabilities, scopeKind, teamId) {
  await client.query("insert into auth.users(id) values ($1)", [actor.auth_subject]);
  await client.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled) values ($1,$2,true)",
    [actor.app_user_id, actor.auth_subject],
  );
  for (const capability of capabilities) {
    await client.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)" +
      " values ($1,$2,public.direct_entry_authorization_date()-1)",
      [actor.app_user_id, capability],
    );
  }
  await client.query(
    "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from)" +
    " values ($1,$2,$3,public.direct_entry_authorization_date()-1)",
    [actor.app_user_id, scopeKind, scopeKind === "team" ? teamId : null],
  );
}
async function rpc(client, name, args) {
  const queries = {
    direct_entry_create_change_request: [
      "select public.direct_entry_create_change_request($1::uuid,$2::uuid,$3::jsonb,$4::text,$5::text) data",
      [args.p_auth_subject, args.p_app_user_id, JSON.stringify(args.p_items), args.p_reason, args.p_idempotency_key],
    ],
    direct_entry_withdraw_change_request: [
      "select public.direct_entry_withdraw_change_request($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text) data",
      [args.p_auth_subject, args.p_app_user_id, args.p_request_id, args.p_expected_version, args.p_idempotency_key],
    ],
    direct_entry_approve_change_request: [
      "select public.direct_entry_approve_change_request($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text) data",
      [args.p_auth_subject, args.p_app_user_id, args.p_request_id, args.p_expected_version, args.p_reason, args.p_idempotency_key],
    ],
    direct_entry_reject_change_request: [
      "select public.direct_entry_reject_change_request($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text) data",
      [args.p_auth_subject, args.p_app_user_id, args.p_request_id, args.p_expected_version, args.p_reason, args.p_idempotency_key],
    ],
  };
  const query = queries[name];
  if (!query) throw new Error("unexpected RPC in S04C-S02A acceptance: " + name);
  try {
    const { rows } = await roleQuery(client, "service_role", query[0], query[1]);
    return { data: rows[0]?.data, error: null };
  } catch (error) {
    return { data: null, error: { code: error.code, message: error.message } };
  }
}

function sessionFor(actor) {
  return {
    actor: { ok: true, actor: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id } },
    response_headers: {},
  };
}

function requestFor(pathname, body, headers = {}) {
  return new Request("https://example.test" + pathname, {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function callCreate(repository, body, session, extra = {}) {
  return createChangeRequest(
    requestFor("/api/direct-entry/change-requests", body, extra.headers ?? {}),
    "flag" in extra ? extra.flag : "true",
    { resolveSession: async () => session, repository },
  );
}

function callWithdraw(repository, requestId, body, session, extra = {}) {
  return withdrawChangeRequest(
    requestFor("/api/direct-entry/change-requests/" + requestId + "/withdraw", body),
    extra.id ?? requestId, "flag" in extra ? extra.flag : "true",
    { resolveSession: async () => session, repository },
  );
}

function callDecision(repository, requestId, body, session, extra = {}) {
  return decideChangeRequest(
    requestFor("/api/direct-entry/change-requests/" + requestId + "/decision", body),
    extra.id ?? requestId, "flag" in extra ? extra.flag : "true",
    { resolveSession: async () => session, repository },
  );
}

function item(entryId, expectedVersion, proposal, kind = "ENTRY_FIELD") {
  return { entry_id: entryId, target_kind: kind, expected_version: expectedVersion, proposal };
}

async function entrySnapshot(client, entryId) {
  const { rows } = await client.query(
    "select e.version, e.labor_type, e.deleted_at," +
    " (select count(*)::int from public.direct_entry_revisions r where r.entry_id=e.entry_id) as revisions" +
    " from public.direct_entries e where e.entry_id=$1",
    [entryId],
  );
  assert.equal(rows.length, 1);
  return rows[0];
}

async function requestSnapshot(client, requestId) {
  const { rows } = await client.query(
    "select r.state, r.version, r.items_count, r.proposer_user_id, r.decided_by_user_id," +
    " (select count(*)::int from public.direct_entry_change_request_revisions v" +
    "   where v.request_id=r.request_id) as revisions," +
    " (select count(*)::int from public.direct_entry_audit_events a" +
    "   where a.resource_ref=r.request_id::text) as audits" +
    " from (select r.*, (select count(*)::int from public.direct_entry_change_request_items i" +
    "   where i.request_id=r.request_id) as items_count" +
    " from public.direct_entry_change_requests r) r where r.request_id=$1",
    [requestId],
  );
  assert.equal(rows.length, 1);
  return rows[0];
}

async function createBatch(client, actor, projectId, recruiterId, codes) {
  await roleQuery(client, "service_role",
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text) data",
    [actor.auth_subject, actor.app_user_id, JSON.stringify(codes.map((employeeCode) => ({
      project_id: projectId,
      first_work_date: "2026-10-15",
      employee_code: employeeCode,
      worker_details: {
        display_name: "Synthetic S02A worker",
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      },
      recruiter_id: recruiterId,
      labor_type: "TEMPORARY",
    }))), key("create")],
  );
  const { rows } = await client.query(
    "select e.entry_id, e.submission_id, e.version, s.state" +
    " from public.direct_entries e join public.direct_entry_submissions s using(submission_id)" +
    " where e.employee_code = any($1::text[]) order by e.entry_id",
    [codes],
  );
  assert.equal(rows.length, codes.length);
  return rows;
}

async function submitSubmission(client, actor, submissionId, version) {
  for (const [target, expected] of [["REVIEW", version], ["SUBMITTED", version + 1]]) {
    await roleQuery(client, "service_role",
      "select public.direct_entry_transition_submission($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text) data",
      [actor.auth_subject, actor.app_user_id, submissionId, expected, target, key("submit" + target)],
    );
  }
}

async function fixture(client) {
  const proposer = { auth_subject: randomUUID(), app_user_id: randomUUID() };
  const reviewer = { auth_subject: randomUUID(), app_user_id: randomUUID() };
  const reviewerNoCap = { auth_subject: randomUUID(), app_user_id: randomUUID() };
  const reviewerNoScope = { auth_subject: randomUUID(), app_user_id: randomUUID() };
  const recruiterId = randomUUID();
  const teamId = randomUUID();
  const projectId = namespace + "_project";
  const submissionCodes = [
    "hrp-2026-" + (100000 + Number.parseInt(randomBytes(4).toString("hex"), 16) % 400000),
    "hrp-2026-" + (500000 + Number.parseInt(randomBytes(4).toString("hex"), 16) % 400000),
  ];
  const draftCode = "hrp-2026-" + (900000 + Number.parseInt(randomBytes(4).toString("hex"), 16) % 90000);

  await client.query("insert into public.teams(team_id,code,display_name) values ($1,$2,$3)", [
    teamId, namespace + "_team", "Synthetic S02A team",
  ]);
  await insertActor(client, proposer,
    ["entry_create", "submission_create", "entry_own", "change_request_create", "change_review"],
    "own", null);
  await insertActor(client, reviewer, ["change_review"], "team", teamId);
  await insertActor(client, reviewerNoCap, [], "team", teamId);
  await insertActor(client, reviewerNoScope, ["change_review"], "own", null);
  await client.query("insert into public.recruiters(recruiter_id,display_name) values ($1,$2)", [
    recruiterId, "Synthetic S02A recruiter",
  ]);
  await client.query(
    "insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from)" +
    " values ($1,'hrp','2020-01-01')", [recruiterId],
  );
  await client.query(
    "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)" +
    " values ($1,$2,'2020-01-01')", [recruiterId, teamId],
  );
  await client.query(
    "insert into public.direct_entry_projects(project_id,display_name) values ($1,$2)",
    [projectId, "Synthetic S02A project"],
  );

  const submittedEntries = await createBatch(client, proposer, projectId, recruiterId, submissionCodes);
  const submissionId = submittedEntries[0].submission_id;
  await submitSubmission(client, proposer, submissionId, submittedEntries[0].version);
  const draftEntries = await createBatch(client, proposer, projectId, recruiterId, [draftCode]);
  return {
    proposer, reviewer, reviewerNoCap, reviewerNoScope,
    teamId, recruiterId, projectId, submissionCodes, draftCode,
    submittedEntries, submissionId, draftEntries,
  };
}
async function runAcceptance(client, reportingBefore) {
  const data = await fixture(client);
  const repository = createChangeRequestRepository((name, args) => rpc(client, name, args));
  const proposerSession = sessionFor(data.proposer);
  const reviewerSession = sessionFor(data.reviewer);
  const [first, second] = [...data.submittedEntries].sort((a, b) => a.entry_id.localeCompare(b.entry_id));
  const draftEntry = data.draftEntries[0];

  // 1. Gate tat.
  let gateCalls = 0;
  const gateRepository = {
    async createChangeRequest() {
      gateCalls += 1;
      return { ok: false, kind: "unavailable" };
    },
  };
  const gated = await callCreate(gateRepository, {
    items: [item(first.entry_id, 1, { labor_type: "PERMANENT" })],
    reason: "Synthetic gate probe",
    idempotency_key: key("gate"),
  }, proposerSession, { flag: undefined });
  assert.equal(gated.status, 404);
  assert.equal(gateCalls, 0);
  pass("gate off returns 404 before session or repository");

  // 2-3. CSRF va truong authority.
  const csrf = await callCreate(repository, {
    items: [item(first.entry_id, 1, { labor_type: "PERMANENT" })],
    reason: "Synthetic csrf probe",
    idempotency_key: key("csrf"),
  }, proposerSession, { headers: { origin: "https://attacker.test" } });
  assert.equal(csrf.status, 403);
  const authority = await callCreate(repository, {
    items: [item(first.entry_id, 1, { labor_type: "PERMANENT", scope: "all" })],
    reason: "Synthetic authority probe",
    idempotency_key: key("authority"),
  }, proposerSession);
  assert.equal(authority.status, 400);
  assert.equal((await authority.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  pass("cross-origin 403 and nested authority field 400 never reach the RPC");

  // 4. Create tren entry chua SUBMITTED bi DB tu choi.
  const notSubmitted = await callCreate(repository, {
    items: [item(draftEntry.entry_id, draftEntry.version, { labor_type: "PERMANENT" })],
    reason: "Synthetic draft probe",
    idempotency_key: key("draft"),
  }, proposerSession);
  assert.equal(notSubmitted.status, 403);
  assert.equal((await notSubmitted.json()).code, "CHANGE_REQUEST_DENIED");
  pass("change request on a non-SUBMITTED entry is denied with 403");

  // 5. Create mot item.
  const singleProposal = { labor_type: "PERMANENT" };
  const singleKey = key("single");
  const created = await callCreate(repository, {
    items: [item(first.entry_id, first.version, singleProposal)],
    reason: "Synthetic single item request",
    idempotency_key: singleKey,
  }, proposerSession);
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.state, "PENDING");
  assert.equal(createdBody.items, 1);
  const singleRequestId = createdBody.request_id;
  const singleCreated = await requestSnapshot(client, singleRequestId);
  assert.deepEqual(
    { state: singleCreated.state, version: singleCreated.version, items: singleCreated.items_count,
      revisions: singleCreated.revisions, audits: singleCreated.audits },
    { state: "PENDING", version: 1, items: 1, revisions: 1, audits: 1 },
  );
  assert.deepEqual(await entrySnapshot(client, first.entry_id), await entrySnapshot(client, first.entry_id));
  pass("single item create returns PENDING with one revision and one audit row");

  // 6. Create nhieu item.
  const multiKey = key("multi");
  const multiItems = [
    item(first.entry_id, first.version, singleProposal),
    item(second.entry_id, second.version, { labor_type: "PERMANENT" }),
  ];
  const multi = await callCreate(repository, {
    items: multiItems,
    reason: "Synthetic multi item request",
    idempotency_key: multiKey,
  }, proposerSession);
  assert.equal(multi.status, 200);
  const multiBody = await multi.json();
  assert.equal(multiBody.items, 2);
  const multiRequestId = multiBody.request_id;
  pass("multi item create records two items in one request");

  // 7. Replay idempotent khong sinh them revision/audit.
  const beforeReplay = await requestSnapshot(client, multiRequestId);
  const replay = await callCreate(repository, {
    items: multiItems,
    reason: "Synthetic multi item request",
    idempotency_key: multiKey,
  }, proposerSession);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), multiBody);
  assert.deepEqual(await requestSnapshot(client, multiRequestId), beforeReplay);
  pass("same key with the same payload replays the same request and adds no revision or audit");

  // 8. Cung key nhung payload doi.
  const changed = await callCreate(repository, {
    items: multiItems,
    reason: "Synthetic changed reason",
    idempotency_key: multiKey,
  }, proposerSession);
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).code, "CHANGE_REQUEST_CONFLICT");
  pass("same key with a changed payload returns 409");

  // 9. Pending khong doi canonical.
  const canonicalAfterPending = await entrySnapshot(client, first.entry_id);
  assert.equal(canonicalAfterPending.version, first.version);
  assert.equal(canonicalAfterPending.labor_type, "TEMPORARY");
  pass("pending requests never change canonical entry data");

  // 10. Withdraw boi proposer.
  const withdrawn = await callWithdraw(repository, singleRequestId, {
    expected_version: 1, idempotency_key: key("withdraw"),
  }, proposerSession);
  assert.equal(withdrawn.status, 200);
  assert.deepEqual(await withdrawn.json(), {
    ok: true, request_id: singleRequestId, state: "WITHDRAWN", version: 2,
  });
  const withdrawnSnapshot = await requestSnapshot(client, singleRequestId);
  assert.equal(withdrawnSnapshot.state, "WITHDRAWN");
  assert.equal(withdrawnSnapshot.revisions, 2);
  assert.equal(withdrawnSnapshot.audits, 2);
  pass("proposer withdraw succeeds and records a request revision and audit row");

  // 11. Nguoi khong phai proposer khong rut duoc.
  const foreignWithdraw = await callWithdraw(repository, multiRequestId, {
    expected_version: 1, idempotency_key: key("foreign"),
  }, reviewerSession);
  assert.equal(foreignWithdraw.status, 403);
  assert.equal((await foreignWithdraw.json()).code, "CHANGE_REQUEST_DENIED");
  pass("non-proposer withdraw is denied with 403");

  // 12. Stale request version.
  const staleWithdraw = await callWithdraw(repository, multiRequestId, {
    expected_version: 7, idempotency_key: key("stale"),
  }, proposerSession);
  assert.equal(staleWithdraw.status, 409);
  assert.equal((await staleWithdraw.json()).code, "CHANGE_REQUEST_CONFLICT");
  pass("stale request version returns 409");

  // 13. Self-review bi tu choi.
  const selfReview = await callDecision(repository, multiRequestId, {
    decision: "approve", expected_version: 1, reason: "Synthetic self review",
    idempotency_key: key("self"),
  }, proposerSession);
  assert.equal(selfReview.status, 403);
  assert.equal((await selfReview.json()).code, "CHANGE_REQUEST_DENIED");
  pass("proposer cannot approve their own request (403)");

  // 14-15. Reviewer thieu capability / thieu scope.
  for (const [actor, label] of [[data.reviewerNoCap, "capability"], [data.reviewerNoScope, "scope"]]) {
    const denied = await callDecision(repository, multiRequestId, {
      decision: "approve", expected_version: 1, reason: "Synthetic review probe",
      idempotency_key: key("probe"),
    }, sessionFor(actor));
    assert.equal(denied.status, 403, label);
    assert.equal((await denied.json()).code, "CHANGE_REQUEST_DENIED", label);
  }
  pass("reviewer without change_review capability or without scope on the entries is denied");

  // 16. Multi-entry approval atomic: lam mot item stale roi approve request nhieu item.
  const seedRequest = await callCreate(repository, {
    items: [item(second.entry_id, second.version, { labor_type: "PERMANENT" })],
    reason: "Synthetic seed change for the second entry",
    idempotency_key: key("seedcreate"),
  }, proposerSession);
  assert.equal(seedRequest.status, 200);
  const seedRequestId = (await seedRequest.json()).request_id;
  const seedApprove = await callDecision(repository, seedRequestId, {
    decision: "approve", expected_version: 1, reason: "Synthetic seed approval",
    idempotency_key: key("seedapprove"),
  }, reviewerSession);
  assert.equal(seedApprove.status, 200);
  const secondAfterSeed = await entrySnapshot(client, second.entry_id);
  assert.equal(secondAfterSeed.version, second.version + 1);
  assert.equal(secondAfterSeed.labor_type, "PERMANENT");

  // Request nhieu item o buoc 6 gio co mot item stale (second) va mot item con hop le (first).
  // RPC xu ly theo order by entry_id nen item cua `first` duoc apply TRUOC khi gap item stale;
  // rollback toan bo phai tra `first` ve nguyen trang.
  const firstBeforeAtomic = await entrySnapshot(client, first.entry_id);
  const atomicApprove = await callDecision(repository, multiRequestId, {
    decision: "approve", expected_version: 1, reason: "Synthetic atomic approve",
    idempotency_key: key("atomicapprove"),
  }, reviewerSession);
  assert.equal(atomicApprove.status, 409);
  assert.equal((await atomicApprove.json()).code, "CHANGE_REQUEST_CONFLICT");
  assert.deepEqual(await entrySnapshot(client, first.entry_id), firstBeforeAtomic);
  const atomicSnapshot = await requestSnapshot(client, multiRequestId);
  assert.equal(atomicSnapshot.state, "PENDING");
  assert.equal(atomicSnapshot.revisions, 1);
  pass("stale item in a multi-entry approval rolls the whole request back (canonical unchanged)");

  // 17. Approve hop le doi canonical.
  const approveKey = key("approve");
  const approveRequest = await callCreate(repository, {
    items: [item(first.entry_id, first.version, { labor_type: "PERMANENT" })],
    reason: "Synthetic approved change",
    idempotency_key: key("approvecreate"),
  }, proposerSession);
  assert.equal(approveRequest.status, 200);
  const approveRequestId = (await approveRequest.json()).request_id;
  const approved = await callDecision(repository, approveRequestId, {
    decision: "approve", expected_version: 1, reason: "Synthetic reviewer approval",
    idempotency_key: approveKey,
  }, reviewerSession);
  assert.equal(approved.status, 200);
  assert.deepEqual(await approved.json(), {
    ok: true, request_id: approveRequestId, state: "APPROVED", version: 2,
  });
  const firstApproved = await entrySnapshot(client, first.entry_id);
  assert.equal(firstApproved.version, first.version + 1);
  assert.equal(firstApproved.labor_type, "PERMANENT");
  assert.equal(firstApproved.revisions, firstBeforeAtomic.revisions + 1);
  const approvedSnapshot = await requestSnapshot(client, approveRequestId);
  assert.equal(approvedSnapshot.state, "APPROVED");
  assert.equal(approvedSnapshot.decided_by_user_id, data.reviewer.app_user_id);
  assert.equal(approvedSnapshot.revisions, 2);
  assert.equal(approvedSnapshot.audits, 2);
  pass("approval by a different reviewer applies canonical change with entry revision");

  // 18. Reject giu nguyen canonical.
  const rejectRequest = await callCreate(repository, {
    items: [item(first.entry_id, firstApproved.version, { labor_type: "TEMPORARY" })],
    reason: "Synthetic rejected change",
    idempotency_key: key("rejectcreate"),
  }, proposerSession);
  assert.equal(rejectRequest.status, 200);
  const rejectRequestId = (await rejectRequest.json()).request_id;
  const rejected = await callDecision(repository, rejectRequestId, {
    decision: "reject", expected_version: 1, reason: "Synthetic reviewer rejection",
    idempotency_key: key("reject"),
  }, reviewerSession);
  assert.equal(rejected.status, 200);
  assert.deepEqual(await rejected.json(), {
    ok: true, request_id: rejectRequestId, state: "REJECTED", version: 2,
  });
  assert.deepEqual(await entrySnapshot(client, first.entry_id), firstApproved);
  const rejectedSnapshot = await requestSnapshot(client, rejectRequestId);
  assert.equal(rejectedSnapshot.state, "REJECTED");
  assert.equal(rejectedSnapshot.revisions, 2);
  assert.equal(rejectedSnapshot.audits, 2);
  pass("reject keeps canonical data unchanged and records the decision");

  // 19. Doi chieu actor/capability/audit.
  const { rows: ledger } = await client.query(
    "select a.action, a.capability, a.outcome, count(*)::int as events," +
    " count(distinct a.app_user_id)::int as actors" +
    " from public.direct_entry_audit_events a" +
    " where a.resource_ref = any($1::text[]) group by 1, 2, 3 order by 1",
    [[singleRequestId, multiRequestId, seedRequestId, approveRequestId, rejectRequestId]],
  );
  assert.deepEqual(ledger, [
    { action: "change_request_approved", capability: "change_review", outcome: "APPLIED", events: 2, actors: 1 },
    { action: "change_request_create", capability: "change_request_create", outcome: "APPLIED", events: 5, actors: 1 },
    { action: "change_request_rejected", capability: "change_review", outcome: "APPLIED", events: 1, actors: 1 },
    { action: "change_request_withdraw", capability: "change_request_create", outcome: "APPLIED", events: 1, actors: 1 },
  ]);
  const { rows: actors } = await client.query(
    "select a.action, a.app_user_id from public.direct_entry_audit_events a" +
    " where a.resource_ref = any($1::text[]) and a.action in ('change_request_create','change_request_approved')" +
    " group by 1, 2 order by 1",
    [[singleRequestId, multiRequestId, seedRequestId, approveRequestId, rejectRequestId]],
  );
  const auditActors = Object.fromEntries(actors.map(({ action, app_user_id: id }) => [action, id]));
  assert.equal(auditActors.change_request_create, data.proposer.app_user_id);
  assert.equal(auditActors.change_request_approved, data.reviewer.app_user_id);
  pass("audit rows match capability, outcome and the correct proposer or reviewer actor");

  // 20. Cleanup.
  await client.query("rollback");
  transactionOpen = false;
  const { rows: residue } = await client.query(
    "select" +
    " (select count(*)::int from public.direct_entry_app_users where app_user_id = any($1::uuid[])) as actors," +
    " (select count(*)::int from public.direct_entry_change_requests" +
    "   where request_id = any($2::uuid[])) as requests," +
    " (select count(*)::int from public.direct_entries where employee_code = any($3::text[])) as entries," +
    " (select count(*)::int from public.direct_entry_submissions where submission_id=$4) as submissions," +
    " (select count(*)::int from public.teams where code=$5) as teams," +
    " (select count(*)::int from public.recruiters where recruiter_id=$6) as recruiters," +
    " (select count(*)::int from public.direct_entry_projects where project_id=$7) as projects",
    [
      [data.proposer.app_user_id, data.reviewer.app_user_id, data.reviewerNoCap.app_user_id,
        data.reviewerNoScope.app_user_id],
      [singleRequestId, multiRequestId, seedRequestId, approveRequestId, rejectRequestId],
      [...data.submissionCodes, data.draftCode],
      data.submissionId, namespace + "_team", data.recruiterId, namespace + "_project",
    ],
  );
  assert.deepEqual(residue[0], {
    actors: 0, requests: 0, entries: 0, submissions: 0, teams: 0, recruiters: 0, projects: 0,
  });
  assert.deepEqual(await baseline(client), reportingBefore);
  pass("outer transaction rollback leaves zero synthetic residue and the reporting baseline unchanged");
}

async function main() {
  const { databaseUrl, projectRef, usesPooler } = await loadSupabaseConfig();
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: buildSslOptions(),
    application_name: "p1.6-s04c-s02a-dev-acceptance",
  });
  await client.connect();
  try {
    console.log("DEV acceptance project: " + projectRef.slice(0, 4) + "***; pooler=" + (usesPooler ? "yes" : "no"));
    await client.query("begin");
    transactionOpen = true;
    await assertDatabaseBoundary(client);
    const reportingBefore = await baseline(client);
    await runAcceptance(client, reportingBefore);
    for (const [index, label] of checks.entries()) console.log("PASS " + (index + 1) + ". " + label);
    console.log("S04C-S02A change request DEV acceptance: " + checks.length + " checks passed.");
  } finally {
    if (transactionOpen) await client.query("rollback").catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error("S04C-S02A DEV acceptance failed; SQLSTATE=" + (error.code ?? "none") +
    "; constraint=" + (error.constraint ?? "none") + "; message=" + error.message);
  process.exitCode = 1;
});
