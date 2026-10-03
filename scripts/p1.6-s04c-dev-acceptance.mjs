#!/usr/bin/env node
/**
 * P1.6-W04-S04C-S01A - DEV synthetic acceptance cho submission transition boundary.
 *
 * Chay THAT tren DEV (khong co schema delta): fixture synthetic nam trong MOT transaction
 * ngoai cung va rollback o cuoi, nen khong de lai residue. Khong deploy, khong migration moi.
 *
 * Dung: node --conditions=react-server scripts/p1.6-s04c-dev-acceptance.mjs
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";

import { transitionSubmission } from "../src/lib/direct-entry/submission-transition-api.ts";
import { createSubmissionTransitionRepository } from "../src/lib/direct-entry/submission-transition-repository.ts";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";
import { readMigrations } from "./lib/migration-validation.mjs";

const migrationDir = path.resolve("supabase/migrations");
const expectedMigrationCount = 29;
const namespace = "s04c";
const checks = [];

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

  const { rows: rpc } = await client.query(
    "select p.prosecdef," +
    " coalesce(array_to_string(p.proconfig, ','), '') as config," +
    " has_function_privilege('anon',p.oid,'EXECUTE') as anon_exec," +
    " has_function_privilege('authenticated',p.oid,'EXECUTE') as auth_exec," +
    " has_function_privilege('service_role',p.oid,'EXECUTE') as service_exec" +
    " from pg_proc p" +
    " where p.oid = 'public.direct_entry_transition_submission(uuid,uuid,uuid,integer,text,text)'::regprocedure",
  );
  assert.equal(rpc.length, 1);
  assert.equal(rpc[0].prosecdef, true);
  assert.ok(rpc[0].config.includes("search_path=pg_catalog, public"));
  assert.equal(rpc[0].anon_exec, false);
  assert.equal(rpc[0].auth_exec, false);
  assert.equal(rpc[0].service_exec, true);
  pass("transition RPC is security definer, search_path pinned, service_role-only EXECUTE");

  const { rows: trigger } = await client.query(
    "select t.tgname, t.tgenabled, p.proname" +
    " from pg_trigger t join pg_proc p on p.oid=t.tgfoid" +
    " where t.tgrelid='public.direct_entry_submissions'::regclass and not t.tgisinternal" +
    " order by t.tgname",
  );
  assert.deepEqual(
    trigger.map(({ tgname }) => tgname),
    ["direct_entry_submission_nonempty", "direct_entry_submission_transition"],
  );
  const transitionTrigger = trigger.find(({ tgname }) => tgname === "direct_entry_submission_transition");
  assert.equal(transitionTrigger.tgenabled, "O");
  assert.equal(transitionTrigger.proname, "direct_entry_submission_transition_guard");
  assert.equal(trigger.find(({ tgname }) => tgname === "direct_entry_submission_nonempty").tgenabled, "O");
  pass("transition guard trigger is enabled next to the deferred non-empty constraint trigger");

  const localSql = local.map(({ sql }) => sql).join("\n");
  const declared = new Set(
    [...localSql.matchAll(/function public\.(direct_entry_[a-z0-9_]+)\s*\(/g)].map((match) => match[1]),
  );
  const { rows: functions } = await client.query(
    "select distinct p.proname from pg_proc p" +
    " join pg_namespace n on n.oid=p.pronamespace" +
    " where n.nspname='public' and p.proname like 'direct_entry_%'",
  );
  const actual = functions.map(({ proname }) => proname).sort();
  assert.deepEqual(actual, [...declared].sort());
  pass("RPC inventory matches migrations exactly (" + actual.length + " functions, no drift)");
}

async function insertActor(client, actor, capabilities, ownScope) {
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
  if (ownScope) {
    await client.query(
      "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from)" +
      " values ($1,'own',public.direct_entry_authorization_date()-1)",
      [actor.app_user_id],
    );
  }
}

async function rpc(client, name, args) {
  if (name !== "direct_entry_transition_submission") {
    throw new Error("unexpected RPC in S04C acceptance: " + name);
  }
  const sql = "select public.direct_entry_transition_submission(" +
    "$1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text) data";
  const values = [
    args.p_auth_subject, args.p_app_user_id, args.p_submission_id,
    args.p_expected_version, args.p_target_state, args.p_idempotency_key,
  ];
  try {
    const { rows } = await roleQuery(client, "service_role", sql, values);
    return { data: rows[0]?.data, error: null };
  } catch (error) {
    return { data: null, error: { code: error.code, message: error.message } };
  }
}
function requestFor(submissionId, body, headers = {}) {
  return new Request(
    "https://example.test/api/direct-entry/submissions/" + submissionId + "/transition",
    {
      method: "POST",
      headers: {
        origin: "https://example.test",
        host: "example.test",
        "content-type": "application/json",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

function sessionFor(actor) {
  return {
    actor: { ok: true, actor: { auth_subject: actor.auth_subject, app_user_id: actor.app_user_id } },
    response_headers: {},
  };
}

function callTransition(repository, submissionId, body, session, extra = {}) {
  const id = extra.id ?? submissionId;
  const flag = "flag" in extra ? extra.flag : "true";
  return transitionSubmission(requestFor(id, body, extra.headers ?? {}), id, flag, {
    resolveSession: async () => session,
    repository,
  });
}

function transitionBody(expectedVersion, targetState, idempotencyKey) {
  return {
    expected_version: expectedVersion,
    target_state: targetState,
    idempotency_key: idempotencyKey,
  };
}

async function snapshot(client, submissionId, appUserId) {
  const { rows } = await client.query(
    "select s.state, s.version, s.submitted_at," +
    " (select count(*)::int from public.direct_entry_submission_revisions r" +
    "   where r.submission_id=s.submission_id) as revisions," +
    " (select coalesce(max(r.version),0)::int from public.direct_entry_submission_revisions r" +
    "   where r.submission_id=s.submission_id) as max_revision_version," +
    " (select count(*)::int from public.direct_entry_audit_events a" +
    "   where a.resource_ref=s.submission_id::text and a.action='submission_transition') as audits," +
    " (select count(*)::int from public.direct_entry_rpc_idempotency i" +
    "   where i.app_user_id=$2 and i.action='submission_transition') as idempotencies" +
    " from public.direct_entry_submissions s where s.submission_id=$1",
    [submissionId, appUserId],
  );
  assert.equal(rows.length, 1);
  return rows[0];
}

async function fixture(client) {
  const actor = { auth_subject: randomUUID(), app_user_id: randomUUID() };
  const outsider = { auth_subject: randomUUID(), app_user_id: randomUUID() };
  const recruiterId = randomUUID();
  const teamId = randomUUID();
  const projectId = namespace + "_project";
  const employeeCode = "hrp-2026-" +
    (100000 + Number.parseInt(randomBytes(4).toString("hex"), 16) % 900000);
  await insertActor(client, actor, ["entry_create", "submission_create", "entry_own"], true);
  await insertActor(client, outsider, ["submission_create", "entry_own"], false);
  await client.query("insert into public.teams(team_id,code,display_name) values ($1,$2,$3)", [
    teamId, namespace + "_team", "Synthetic S04C team",
  ]);
  await client.query("insert into public.recruiters(recruiter_id,display_name) values ($1,$2)", [
    recruiterId, "Synthetic S04C recruiter",
  ]);
  await client.query(
    "insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from)" +
    " values ($1,'hrp','2020-01-01')",
    [recruiterId],
  );
  await client.query(
    "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)" +
    " values ($1,$2,'2020-01-01')",
    [recruiterId, teamId],
  );
  await client.query(
    "insert into public.direct_entry_projects(project_id,display_name) values ($1,$2)",
    [projectId, "Synthetic S04C project"],
  );
  await roleQuery(client, "service_role",
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text) data",
    [actor.auth_subject, actor.app_user_id, JSON.stringify([{
      project_id: projectId,
      first_work_date: "2026-10-15",
      employee_code: employeeCode,
      worker_details: {
        display_name: "Synthetic S04C worker",
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      },
      recruiter_id: recruiterId,
      labor_type: "TEMPORARY",
    }]), key("create")],
  );
  const { rows } = await client.query(
    "select e.entry_id, e.candidate_id, e.version, e.submission_id, s.state, s.version as submission_version" +
    " from public.direct_entries e" +
    " join public.direct_entry_submissions s using(submission_id)" +
    " where e.employee_code=$1",
    [employeeCode],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "DRAFT");
  assert.equal(rows[0].submission_version, 1);
  return { actor, outsider, entry: rows[0], employeeCode, recruiterId, teamId, projectId };
}
async function runAcceptance(client, reportingBefore) {
  const data = await fixture(client);
  const submissionId = data.entry.submission_id;
  const actor = data.actor;
  const repository = createSubmissionTransitionRepository((name, args) => rpc(client, name, args));
  const session = sessionFor(actor);
  const before = await snapshot(client, submissionId, actor.app_user_id);

  // 1. Gate tat: fail truoc session/repository.
  let gateCalls = 0;
  const gateRepository = {
    async transitionSubmission() {
      gateCalls += 1;
      return { ok: false, kind: "unavailable" };
    },
  };
  const gated = await callTransition(
    gateRepository, submissionId, transitionBody(1, "REVIEW", key("gate")), session, { flag: undefined },
  );
  assert.equal(gated.status, 404);
  assert.equal(gateCalls, 0);
  pass("gate off returns 404 before session or repository");

  // 2. CSRF/same-origin.
  const csrf = await callTransition(repository, submissionId, transitionBody(1, "REVIEW", key("csrf")), session, {
    headers: { origin: "https://attacker.test" },
  });
  assert.equal(csrf.status, 403);
  pass("cross-origin transition is rejected with 403");

  // 3. submissionId khong hop le.
  assert.equal((await callTransition(
    repository, submissionId, transitionBody(1, "REVIEW", key("uuid")), session, { id: "not-a-uuid" },
  )).status, 400);
  pass("malformed submissionId returns 400");

  // 4. Truong authority tu client.
  const authority = await callTransition(
    repository, submissionId,
    { ...transitionBody(1, "REVIEW", key("auth")), created_by_user_id: actor.app_user_id },
    session,
  );
  assert.equal(authority.status, 400);
  assert.equal((await authority.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  pass("client-supplied authority field returns 400 and never reaches the RPC");

  // 5-6. Session fail-closed.
  assert.equal((await callTransition(
    repository, submissionId, transitionBody(1, "REVIEW", key("unauth")),
    { actor: { ok: false, reason: "UNAUTHENTICATED" }, response_headers: {} },
  )).status, 401);
  assert.equal((await callTransition(
    repository, submissionId, transitionBody(1, "REVIEW", key("disabled")),
    { actor: { ok: false, reason: "ACTOR_DISABLED" }, response_headers: {} },
  )).status, 403);
  assert.deepEqual(await snapshot(client, submissionId, actor.app_user_id), before);
  pass("unauthenticated 401 and disabled actor 403 leave the submission untouched");

  // 7. DRAFT -> REVIEW.
  const review = await callTransition(repository, submissionId, transitionBody(1, "REVIEW", key("review")), session);
  assert.equal(review.status, 200);
  assert.deepEqual(await review.json(), {
    ok: true, submission_id: submissionId, state: "REVIEW", version: 2,
  });
  const atReview = await snapshot(client, submissionId, actor.app_user_id);
  assert.equal(atReview.state, "REVIEW");
  assert.equal(atReview.version, 2);
  assert.equal(atReview.revisions, before.revisions + 1);
  assert.equal(atReview.audits, before.audits + 1);
  assert.equal(atReview.idempotencies, before.idempotencies + 1);
  assert.equal(atReview.max_revision_version, 2);
  pass("DRAFT -> REVIEW returns 200 with version 2 and one new revision plus audit row");

  // 8. REVIEW chan mutation draft.
  let blocked = null;
  try {
    await roleQuery(client, "service_role",
      "select public.direct_entry_update_draft_row($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::jsonb,$6::text) data",
      [actor.auth_subject, actor.app_user_id, data.entry.entry_id, data.entry.version,
        JSON.stringify({ labor_type: "PERMANENT" }), key("blocked")]);
  } catch (error) {
    blocked = error;
  }
  assert.equal(blocked?.code, "42501");
  const entryAfterBlock = await client.query(
    "select version from public.direct_entries where entry_id=$1", [data.entry.entry_id],
  );
  assert.equal(entryAfterBlock.rows[0].version, data.entry.version);
  pass("draft row update is denied with 42501 while the submission is in REVIEW");

  // 9. OCC stale.
  const stale = await callTransition(repository, submissionId, transitionBody(1, "DRAFT", key("stale")), session);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "SUBMISSION_CONFLICT");
  pass("stale expected_version returns 409 SUBMISSION_CONFLICT");

  // 10. REVIEW -> DRAFT.
  const backToDraft = await callTransition(
    repository, submissionId, transitionBody(2, "DRAFT", key("return")), session,
  );
  assert.equal(backToDraft.status, 200);
  assert.deepEqual(await backToDraft.json(), {
    ok: true, submission_id: submissionId, state: "DRAFT", version: 3,
  });
  pass("REVIEW -> DRAFT returns 200 with version 3");

  // 11. DRAFT -> SUBMITTED bi DB tu choi (khong co duong tat o application).
  const shortcut = await callTransition(
    repository, submissionId, transitionBody(3, "SUBMITTED", key("shortcut")), session,
  );
  assert.equal(shortcut.status, 409);
  assert.equal((await shortcut.json()).code, "SUBMISSION_CONFLICT");
  const stillDraft = await snapshot(client, submissionId, actor.app_user_id);
  assert.equal(stillDraft.state, "DRAFT");
  assert.equal(stillDraft.version, 3);
  pass("DRAFT -> SUBMITTED is denied by the database and leaves state DRAFT");

  // 12. DRAFT -> REVIEW lai.
  assert.equal((await callTransition(
    repository, submissionId, transitionBody(3, "REVIEW", key("review2")), session,
  )).status, 200);

  // 13. REVIEW -> SUBMITTED voi key duoc replay o buoc 15.
  const submitKey = key("submit");
  const submitted = await callTransition(
    repository, submissionId, transitionBody(4, "SUBMITTED", submitKey), session,
  );
  assert.equal(submitted.status, 200);
  assert.deepEqual(await submitted.json(), {
    ok: true, submission_id: submissionId, state: "SUBMITTED", version: 5,
  });
  const atSubmitted = await snapshot(client, submissionId, actor.app_user_id);
  assert.equal(atSubmitted.state, "SUBMITTED");
  assert.equal(atSubmitted.version, 5);
  assert.notEqual(atSubmitted.submitted_at, null);
  assert.equal(atSubmitted.max_revision_version, 5);
  pass("DRAFT -> REVIEW -> SUBMITTED reaches version 5 with submitted_at recorded");

  // 14. SUBMITTED la terminal.
  assert.equal((await callTransition(
    repository, submissionId, transitionBody(5, "DRAFT", key("terminal")), session,
  )).status, 409);
  const noop = await callTransition(
    repository, submissionId, transitionBody(5, "SUBMITTED", key("noop")), session,
  );
  assert.equal(noop.status, 400);
  assert.equal((await noop.json()).code, "SUBMISSION_TRANSITION_INVALID");
  pass("SUBMITTED cannot transition again (409 terminal) and same-state is a 400 no-op");

  // 15. Replay idempotent.
  const replay = await callTransition(
    repository, submissionId, transitionBody(4, "SUBMITTED", submitKey), session,
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    ok: true, submission_id: submissionId, state: "SUBMITTED", version: 5,
  });
  const afterReplay = await snapshot(client, submissionId, actor.app_user_id);
  assert.deepEqual(afterReplay, atSubmitted);
  pass("idempotent replay returns the same outcome with no extra revision or audit row");

  // 16. Cung key nhung payload doi.
  const conflict = await callTransition(
    repository, submissionId, transitionBody(4, "DRAFT", submitKey), session,
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "SUBMISSION_CONFLICT");
  pass("same idempotency key with a changed target or version returns 409");

  // 17. Actor ngoai scope.
  const outsider = await callTransition(
    repository, submissionId, transitionBody(4, "SUBMITTED", key("outsider")), sessionFor(data.outsider),
  );
  assert.equal(outsider.status, 403);
  assert.equal((await outsider.json()).code, "SUBMISSION_DENIED");
  assert.deepEqual(await snapshot(client, submissionId, actor.app_user_id), atSubmitted);
  pass("actor without own scope is denied with 403 SUBMISSION_DENIED");

  // 18. Audit/revision/version khop nhau.
  const { rows: ledger } = await client.query(
    "select count(*)::int as transitions," +
    " count(distinct a.submission_revision_id)::int as linked," +
    " count(*) filter (where a.outcome='APPLIED')::int as applied," +
    " count(*) filter (where a.capability='submission_create')::int as with_capability" +
    " from public.direct_entry_audit_events a" +
    " where a.resource_ref=$1 and a.action='submission_transition'",
    [submissionId],
  );
  assert.deepEqual(ledger[0], { transitions: 4, linked: 4, applied: 4, with_capability: 4 });
  const { rows: revisions } = await client.query(
    "select version, actor_user_id from public.direct_entry_submission_revisions" +
    " where submission_id=$1 order by version",
    [submissionId],
  );
  // Revision 1 do create_batch tao; bon transition tao revision 2..5.
  assert.deepEqual(revisions.map(({ version }) => version), [1, 2, 3, 4, 5]);
  assert.deepEqual([...new Set(revisions.map(({ actor_user_id }) => actor_user_id))], [actor.app_user_id]);
  pass("four revisions and four audit rows agree on version sequence and actor");

  // Cleanup: rollback toan bo fixture trong transaction ngoai cung.
  await client.query("rollback");
  transactionOpen = false;
  const { rows: residue } = await client.query(
    "select" +
    " (select count(*)::int from public.direct_entry_app_users where app_user_id in ($1,$2)) as actors," +
    " (select count(*)::int from public.direct_entries where employee_code=$3) as entries," +
    " (select count(*)::int from public.direct_entry_submissions where submission_id=$4) as submissions," +
    " (select count(*)::int from public.teams where code=$5) as teams," +
    " (select count(*)::int from public.recruiters where recruiter_id=$6) as recruiters," +
    " (select count(*)::int from public.direct_entry_projects where project_id=$7) as projects",
    [actor.app_user_id, data.outsider.app_user_id, data.employeeCode,
      submissionId, namespace + "_team", data.recruiterId, namespace + "_project"],
  );
  assert.deepEqual(residue[0], {
    actors: 0, entries: 0, submissions: 0, teams: 0, recruiters: 0, projects: 0,
  });
  assert.deepEqual(await baseline(client), reportingBefore);
  pass("outer transaction rollback leaves zero synthetic residue and the reporting baseline unchanged");
}

let transactionOpen = false;

async function main() {
  const { databaseUrl, projectRef, usesPooler } = await loadSupabaseConfig();
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: buildSslOptions(),
    application_name: "p1.6-s04c-dev-acceptance",
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
    console.log("S04C submission transition DEV acceptance: " + checks.length + " checks passed.");
  } finally {
    if (transactionOpen) await client.query("rollback").catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error("S04C DEV acceptance failed; SQLSTATE=" + (error.code ?? "none") +
    "; constraint=" + (error.constraint ?? "none") + "; message=" + error.message);
  process.exitCode = 1;
});
