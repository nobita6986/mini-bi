#!/usr/bin/env node
import assert from "node:assert/strict";
import process from "node:process";
import pg from "pg";

import { postDirectEntryBatch, getDirectEntryEntry } from "../src/lib/direct-entry/write-api.ts";
import { createDirectEntryWriteRepository } from "../src/lib/direct-entry/write-repository.ts";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const fixture = {
  authSubject: "98100000-0000-4000-8000-000000000001",
  appUserId: "98200000-0000-4000-8000-000000000001",
  deniedAuthSubject: "98100000-0000-4000-8000-000000000002",
  deniedAppUserId: "98200000-0000-4000-8000-000000000002",
  recruiterId: "98300000-0000-4000-8000-000000000001",
  teamId: "98400000-0000-4000-8000-000000000001",
  createGrantId: "98500000-0000-4000-8000-000000000001",
  submissionGrantId: "98500000-0000-4000-8000-000000000002",
  readGrantId: "98500000-0000-4000-8000-000000000003",
  ownScopeGrantId: "98600000-0000-4000-8000-000000000001",
  projectId: "project_s03b_synthetic_01",
  employeeCodes: ["hrp-2026-990001", "hrp-2026-990002"],
  idempotencyKey: "s03b-synthetic-batch-01",
};
const startDate = "2026-10-15";

async function reportingBaseline(client) {
  const { rows } = await client.query(`
    select
      (select count(*) from public.data_sources where active and not is_test)::int
        as "reportingSources",
      (select count(*) from public.data_sources where is_test)::int
        as "existingFixtureSources",
      (select coalesce(sum(b.recruited_count), 0)
         from public.daily_recruitment_breakdown b
         join public.data_sources s on s.id = b.source_id
        where s.active and not s.is_test)::bigint as "recruitedTotal",
      (select count(*)
         from public.daily_recruitment_breakdown b
         join public.data_sources s on s.id = b.source_id
        where s.active and not s.is_test)::int as "breakdownRows"
  `);
  return rows[0];
}

async function assertFixtureAbsent(client) {
  const { rows } = await client.query(`
    select
      (select count(*) from auth.users where id = any($1::uuid[]))::int as auth_users,
      (select count(*) from public.direct_entry_app_users where app_user_id = any($2::uuid[]))::int as app_users,
      (select count(*) from public.recruiters where recruiter_id = $3)::int as recruiters,
      (select count(*) from public.teams where team_id = $4)::int as teams,
      (select count(*) from public.direct_entry_projects where project_id = $5)::int as projects,
      (select count(*) from public.recruiter_provider_memberships where recruiter_id = $3)::int as provider_memberships,
      (select count(*) from public.recruiter_team_memberships where recruiter_id = $3)::int as team_memberships,
      (select count(*) from public.direct_entry_capability_grants where grant_id = any($6::uuid[]))::int as capabilities,
      (select count(*) from public.direct_entry_scope_grants where grant_id = $7)::int as scopes,
      (select count(*) from public.direct_entries where employee_code = any($8::text[]))::int as entries
  `, [
    [fixture.authSubject, fixture.deniedAuthSubject],
    [fixture.appUserId, fixture.deniedAppUserId],
    fixture.recruiterId, fixture.teamId, fixture.projectId,
    [fixture.createGrantId, fixture.submissionGrantId, fixture.readGrantId],
    fixture.ownScopeGrantId, fixture.employeeCodes,
  ]);
  assert.deepEqual(rows[0], {
    auth_users: 0, app_users: 0, recruiters: 0, teams: 0,
    projects: 0, provider_memberships: 0, team_memberships: 0,
    capabilities: 0, scopes: 0, entries: 0,
  });
}

async function assertWriteArtifactsRolledBack(client, created) {
  const { rows } = await client.query(`
    select
      (select count(*)::int from public.direct_entry_submissions where submission_id = $1) as submissions,
      (select count(*)::int from public.direct_entries where entry_id = any($2::uuid[])) as entries,
      (select count(*)::int from public.direct_entry_revisions where entry_id = any($2::uuid[])) as entry_revisions,
      (select count(*)::int from public.direct_entry_submission_revisions where submission_id = $1) as submission_revisions,
      (select count(*)::int from public.direct_entry_audit_events where resource_ref = any($3::text[])) as audit_events,
      (select count(*)::int from public.direct_entry_rpc_idempotency
        where app_user_id = $4 and idempotency_key = $5) as idempotency_records
  `, [
    created.submission_id,
    created.entry_ids,
    [created.submission_id, ...created.entry_ids],
    fixture.appUserId,
    fixture.idempotencyKey,
  ]);
  assert.deepEqual(rows[0], {
    submissions: 0,
    entries: 0,
    entry_revisions: 0,
    submission_revisions: 0,
    audit_events: 0,
    idempotency_records: 0,
  });
}

async function seed(client) {
  await client.query("insert into auth.users (id) values ($1), ($2)", [
    fixture.authSubject, fixture.deniedAuthSubject,
  ]);
  await client.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject) values ($1, $2), ($3, $4)",
    [fixture.appUserId, fixture.authSubject, fixture.deniedAppUserId, fixture.deniedAuthSubject],
  );
  await client.query(
    "insert into public.teams (team_id, code, display_name) values ($1, $2, $3)",
    [fixture.teamId, "S03B-SYNTH", "Synthetic S03B team"],
  );
  await client.query(
    "insert into public.recruiters (recruiter_id, display_name) values ($1, $2)",
    [fixture.recruiterId, "Synthetic S03B recruiter"],
  );
  await client.query(
    `insert into public.recruiter_provider_memberships
       (recruiter_id, provider_type, valid_from) values ($1, 'hrp', '2020-01-01')`,
    [fixture.recruiterId],
  );
  await client.query(
    `insert into public.recruiter_team_memberships
       (recruiter_id, team_id, valid_from) values ($1, $2, '2020-01-01')`,
    [fixture.recruiterId, fixture.teamId],
  );
  await client.query(
    "insert into public.direct_entry_projects (project_id, display_name) values ($1, $2)",
    [fixture.projectId, "Synthetic S03B project"],
  );
  await client.query(
    `insert into public.direct_entry_capability_grants
       (grant_id, app_user_id, capability, valid_from) values
       ($1, $2, 'entry_create', '2020-01-01'),
       ($3, $2, 'submission_create', '2020-01-01'),
       ($4, $2, 'entry_own', '2020-01-01')`,
    [fixture.createGrantId, fixture.appUserId, fixture.submissionGrantId, fixture.readGrantId],
  );
  await client.query(
    `insert into public.direct_entry_scope_grants
       (grant_id, app_user_id, scope_kind, valid_from)
     values ($1, $2, 'own', '2020-01-01')`,
    [fixture.ownScopeGrantId, fixture.appUserId],
  );
}

function actor(authSubject, appUserId) {
  return {
    actor: {
      ok: true,
      actor: {
        auth_subject: authSubject,
        app_user_id: appUserId,
        enabled: true,
        capabilities: ["entry_create", "submission_create", "entry_own"],
        scopes: [{ kind: "own", reference: appUserId, valid_from: "2020-01-01", valid_to: null }],
        self_recruiter_suggestion: null,
        session: { provider: "supabase", verification: "getUser", authenticated_at: null },
      },
    },
    response_headers: {},
  };
}

function apiRequest(rows, key = fixture.idempotencyKey) {
  return new Request("https://example.test/api/direct-entry/batches", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ rows }),
  });
}

function inputRows() {
  return fixture.employeeCodes.map((employee_code) => ({
    project_id: fixture.projectId,
    first_work_date: startDate,
    employee_code,
    worker: {
      display_name: "Synthetic Worker",
      date_of_birth: { state: "omitted" },
      national_id: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
    recruiter_id: fixture.recruiterId,
    labor_type: "TEMPORARY",
  }));
}

function rpcAdapter(client) {
  return async (name, args) => {
    await client.query("savepoint direct_entry_rpc");
    try {
      await client.query("set local role service_role");
      let query;
      let values;
      if (name === "direct_entry_create_batch") {
        query = "select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as data";
        values = [args.p_auth_subject, args.p_app_user_id, JSON.stringify(args.p_rows), args.p_idempotency_key];
      } else if (name === "direct_entry_read_projection") {
        query = "select public.direct_entry_read_projection($1::uuid, $2::uuid, $3::uuid) as data";
        values = [args.p_auth_subject, args.p_app_user_id, args.p_entry_id];
      } else if (name === "direct_entry_input_catalog") {
        query = "select public.direct_entry_input_catalog($1::uuid, $2::uuid, $3::date) as data";
        values = [args.p_auth_subject, args.p_app_user_id, args.p_effective_date];
      } else {
        throw new Error("Unexpected Direct Entry RPC");
      }
      const { rows } = await client.query(query, values);
      await client.query("reset role");
      await client.query("release savepoint direct_entry_rpc");
      return { data: rows[0].data, error: null };
    } catch (error) {
      await client.query("rollback to savepoint direct_entry_rpc");
      await client.query("release savepoint direct_entry_rpc");
      return {
        data: null,
        error: { code: error.code, message: error.message },
      };
    }
  };
}

async function main() {
  const { databaseUrl } = await loadSupabaseConfig();
  const client = new pg.Client({ connectionString: databaseUrl, ssl: buildSslOptions() });
  await client.connect();
  let transactionOpen = false;
  try {
    const before = await reportingBaseline(client);
    await assertFixtureAbsent(client);
    await client.query("begin");
    transactionOpen = true;
    await seed(client);

    const { rows: inventoryRows } = await client.query(`
      select
        (select count(*)::int from public.schema_migrations) as migrations,
        (select count(*)::int
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname like 'direct_entry_%'
            and has_function_privilege('service_role', p.oid, 'execute')) as rpc_count
    `);
    assert.deepEqual(inventoryRows[0], { migrations: 24, rpc_count: 20 });

    const repository = createDirectEntryWriteRepository(rpcAdapter(client));
    const authorized = actor(fixture.authSubject, fixture.appUserId);
    const createDependencies = {
      resolveSession: async () => authorized,
      repository,
    };
    const rows = inputRows();
    const createdResponse = await postDirectEntryBatch(apiRequest(rows), "true", createDependencies);
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.status, "DRAFT");
    assert.equal(created.entry_ids.length, 2);

    const replayResponse = await postDirectEntryBatch(apiRequest(rows), "true", createDependencies);
    assert.equal(replayResponse.status, 201);
    const replay = await replayResponse.json();
    assert.equal(replay.submission_id, created.submission_id);
    assert.deepEqual(replay.entry_ids, created.entry_ids);

    const conflictRows = inputRows();
    conflictRows[0].worker.display_name = "Different Synthetic Worker";
    const conflictResponse = await postDirectEntryBatch(
      apiRequest(conflictRows), "true", createDependencies,
    );
    assert.equal(conflictResponse.status, 409);
    assert.equal((await conflictResponse.json()).code, "IDEMPOTENCY_CONFLICT");

    const readResponse = await getDirectEntryEntry(
      created.entry_ids[0], "true", {
        resolveSession: async () => authorized,
        repository,
      },
    );
    assert.equal(readResponse.status, 200);
    const readBody = await readResponse.json();
    assert.equal(readBody.entry.entry_id, created.entry_ids[0]);
    assert.deepEqual(readBody.entry.worker_details, {});
    assert.equal(readBody.entry.payment, null);
    assert.deepEqual(readBody.entry.documents, []);
    assert.equal(JSON.stringify(readBody).includes(fixture.authSubject), false);

    const deniedResponse = await postDirectEntryBatch(apiRequest(inputRows(), "s03b-denied-01"), "true", {
      resolveSession: async () => actor(fixture.deniedAuthSubject, fixture.deniedAppUserId),
      repository,
    });
    assert.equal(deniedResponse.status, 403);

    const { rows: evidenceRows } = await client.query(`
      select
        (select count(*)::int from public.direct_entries where entry_id = any($1::uuid[])) as entries,
        (select count(*)::int from public.direct_entry_revisions where entry_id = any($1::uuid[])) as entry_revisions,
        (select count(*)::int from public.direct_entry_submission_revisions where submission_id = $2) as submission_revisions,
        (select count(*)::int from public.direct_entry_audit_events
          where resource_ref = any($3::text[])) as audit_events,
        (select count(*)::int from public.direct_entry_rpc_idempotency
          where app_user_id = $4 and action = 'batch_create' and idempotency_key = $5) as idempotency_records
    `, [
      created.entry_ids,
      created.submission_id,
      [created.submission_id, ...created.entry_ids],
      fixture.appUserId,
      fixture.idempotencyKey,
    ]);
    assert.deepEqual(evidenceRows[0], {
      entries: 2,
      entry_revisions: 2,
      submission_revisions: 1,
      audit_events: 3,
      idempotency_records: 1,
    });
    await client.query("rollback");
    transactionOpen = false;

    const after = await reportingBaseline(client);
    assert.deepEqual(after, before);
    await assertFixtureAbsent(client);
    await assertWriteArtifactsRolledBack(client, created);
    console.log(JSON.stringify({
      result: "PASS",
      rpcCount: inventoryRows[0].rpc_count,
      migrationCount: inventoryRows[0].migrations,
      batchRows: 2,
      replayReusedSameBatch: true,
      differentPayloadConflict: true,
      restrictedRead: true,
      deniedActor: true,
      auditRevisionIdempotencyEvidence: evidenceRows[0],
      baselineUnchanged: true,
      cleanupVerified: true,
    }, null, 2));
  } finally {
    if (transactionOpen) await client.query("rollback").catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error(`S03B DEV acceptance failed (${error.code ?? error.name ?? "unknown"}); transaction rollback was attempted.`);
  process.exitCode = 1;
});
