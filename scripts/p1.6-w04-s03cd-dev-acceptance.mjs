#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import pg from "pg";

import { postDirectEntryBatch, getDirectEntryEntry } from "../src/lib/direct-entry/write-api.ts";
import {
  getInputCatalog,
  getOwnDrafts,
  patchDraftEntry,
} from "../src/lib/direct-entry/draft-api.ts";
import { createDirectEntryWriteRepository } from "../src/lib/direct-entry/write-repository.ts";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const fixture = {
  authSubjectA: "99100000-0000-4000-8000-000000000001",
  authSubjectB: "99100000-0000-4000-8000-000000000002",
  appUserA: "99200000-0000-4000-8000-000000000001",
  appUserB: "99200000-0000-4000-8000-000000000002",
  recruiter: "99300000-0000-4000-8000-000000000001",
  team: "99400000-0000-4000-8000-000000000001",
  capabilityGrants: [
    "99500000-0000-4000-8000-000000000001",
    "99500000-0000-4000-8000-000000000002",
    "99500000-0000-4000-8000-000000000003",
    "99500000-0000-4000-8000-000000000004",
  ],
  scopeGrants: [
    "99600000-0000-4000-8000-000000000001",
    "99600000-0000-4000-8000-000000000002",
  ],
  project: "project_s03cd_dev_synthetic_01",
  employeeCodes: ["hrp-2026-991001", "hrp-2026-991002"],
  createKey: "s03cd-dev-create-991001",
  updateKey: "s03cd-dev-update-991001",
};
const effectiveDate = "2026-10-15";

async function assertDevProject(projectRef) {
  const manifest = JSON.parse(await readFile(
    new URL("./p1.6-w03-g3-dev-manifest.json", import.meta.url),
    "utf8",
  ));
  assert.equal(projectRef, manifest.expectedProjectRef, "wrong Supabase project; aborting");
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

async function fixtureCounts(client) {
  const { rows } = await client.query(`
    select
      (select count(*)::int from auth.users where id = any($1::uuid[])) as auth_users,
      (select count(*)::int from public.direct_entry_app_users where app_user_id = any($2::uuid[])) as app_users,
      (select count(*)::int from public.recruiters where recruiter_id = $3) as recruiters,
      (select count(*)::int from public.teams where team_id = $4) as teams,
      (select count(*)::int from public.direct_entry_projects where project_id = $5) as projects,
      (select count(*)::int from public.recruiter_provider_memberships where recruiter_id = $3) as provider_memberships,
      (select count(*)::int from public.recruiter_team_memberships where recruiter_id = $3) as team_memberships,
      (select count(*)::int from public.direct_entry_capability_grants where grant_id = any($6::uuid[])) as capabilities,
      (select count(*)::int from public.direct_entry_scope_grants where grant_id = any($7::uuid[])) as scopes,
      (select count(*)::int from public.direct_entries where employee_code = any($8::text[])) as entries
  `, [
    [fixture.authSubjectA, fixture.authSubjectB],
    [fixture.appUserA, fixture.appUserB],
    fixture.recruiter,
    fixture.team,
    fixture.project,
    fixture.capabilityGrants,
    fixture.scopeGrants,
    fixture.employeeCodes,
  ]);
  return rows[0];
}

async function artifactCounts(client, created) {
  const { rows } = await client.query(`
    select
      (select count(*)::int from public.direct_entry_submissions where submission_id = $1) as submissions,
      (select count(*)::int from public.direct_entry_revisions where entry_id = any($2::uuid[])) as entry_revisions,
      (select count(*)::int from public.direct_entry_submission_revisions where submission_id = $1) as submission_revisions,
      (select count(*)::int from public.direct_entry_audit_events
        where app_user_id = $3 and resource_ref = any($4::text[])) as audit_events,
      (select count(*)::int from public.direct_entry_rpc_idempotency
        where app_user_id = $3 and idempotency_key = any($5::text[])) as idempotency_records
  `, [
    created.submission_id,
    created.entry_ids,
    fixture.appUserA,
    [created.submission_id, ...created.entry_ids],
    [fixture.createKey, fixture.updateKey],
  ]);
  return rows[0];
}

function expectedNoFixtures() {
  return {
    auth_users: 0,
    app_users: 0,
    recruiters: 0,
    teams: 0,
    projects: 0,
    provider_memberships: 0,
    team_memberships: 0,
    capabilities: 0,
    scopes: 0,
    entries: 0,
  };
}

async function seed(client) {
  await client.query("insert into auth.users (id) values ($1), ($2)", [
    fixture.authSubjectA,
    fixture.authSubjectB,
  ]);
  await client.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject) values ($1, $2), ($3, $4)",
    [fixture.appUserA, fixture.authSubjectA, fixture.appUserB, fixture.authSubjectB],
  );
  await client.query(
    "insert into public.teams (team_id, code, display_name) values ($1, $2, $3)",
    [fixture.team, "S03CD-DEV-SYNTH", "Synthetic S03CD Team"],
  );
  await client.query(
    "insert into public.recruiters (recruiter_id, display_name) values ($1, $2)",
    [fixture.recruiter, "Synthetic S03CD Recruiter"],
  );
  await client.query(
    `insert into public.recruiter_provider_memberships
       (recruiter_id, provider_type, valid_from, valid_to)
     values ($1, 'hrp', '2020-01-01', '2030-01-01')`,
    [fixture.recruiter],
  );
  await client.query(
    `insert into public.recruiter_team_memberships
       (recruiter_id, team_id, valid_from, valid_to)
     values ($1, $2, '2020-01-01', '2030-01-01')`,
    [fixture.recruiter, fixture.team],
  );
  await client.query(
    "insert into public.direct_entry_projects (project_id, display_name) values ($1, $2)",
    [fixture.project, "Synthetic S03CD project"],
  );
  await client.query(
    `insert into public.direct_entry_capability_grants
       (grant_id, app_user_id, capability, valid_from) values
       ($1, $2, 'entry_create', '2020-01-01'),
       ($3, $2, 'submission_create', '2020-01-01'),
       ($4, $2, 'entry_own', '2020-01-01'),
       ($5, $6, 'entry_own', '2020-01-01')`,
    [
      fixture.capabilityGrants[0], fixture.appUserA,
      fixture.capabilityGrants[1], fixture.capabilityGrants[2],
      fixture.capabilityGrants[3], fixture.appUserB,
    ],
  );
  await client.query(
    `insert into public.direct_entry_scope_grants
       (grant_id, app_user_id, scope_kind, valid_from)
     values ($1, $2, 'own', '2020-01-01'), ($3, $4, 'own', '2020-01-01')`,
    [
      fixture.scopeGrants[0], fixture.appUserA,
      fixture.scopeGrants[1], fixture.appUserB,
    ],
  );
}

function rpcAdapter(client) {
  return async (name, args) => {
    await client.query("savepoint direct_entry_rpc");
    try {
      await client.query("set local role service_role");
      let query;
      let values;
      switch (name) {
        case "direct_entry_create_batch":
          query = "select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as data";
          values = [args.p_auth_subject, args.p_app_user_id, JSON.stringify(args.p_rows), args.p_idempotency_key];
          break;
        case "direct_entry_read_projection":
          query = "select public.direct_entry_read_projection($1::uuid, $2::uuid, $3::uuid) as data";
          values = [args.p_auth_subject, args.p_app_user_id, args.p_entry_id];
          break;
        case "direct_entry_input_catalog":
          query = "select public.direct_entry_input_catalog($1::uuid, $2::uuid, $3::date) as data";
          values = [args.p_auth_subject, args.p_app_user_id, args.p_effective_date];
          break;
        case "direct_entry_list_own_drafts":
          query = "select public.direct_entry_list_own_drafts($1::uuid, $2::uuid) as data";
          values = [args.p_auth_subject, args.p_app_user_id];
          break;
        case "direct_entry_update_draft_row":
          query = `select public.direct_entry_update_draft_row(
            $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::jsonb, $6::text
          ) as data`;
          values = [
            args.p_auth_subject, args.p_app_user_id, args.p_entry_id,
            args.p_expected_version, JSON.stringify(args.p_patch), args.p_idempotency_key,
          ];
          break;
        default:
          throw new Error("Unexpected Direct Entry RPC");
      }
      const { rows } = await client.query(query, values);
      await client.query("reset role");
      await client.query("release savepoint direct_entry_rpc");
      return { data: rows[0].data, error: null };
    } catch (error) {
      await client.query("rollback to savepoint direct_entry_rpc");
      await client.query("release savepoint direct_entry_rpc");
      return { data: null, error: { code: error.code, message: error.message } };
    }
  };
}

function batchRequest(rows) {
  return new Request("https://example.test/api/direct-entry/batches", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": fixture.createKey,
    },
    body: JSON.stringify({ rows }),
  });
}

function updateRequest(entryId, expectedVersion, patch, key) {
  return new Request(`https://example.test/api/direct-entry/entries/${entryId}`, {
    method: "PATCH",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ expected_version: expectedVersion, patch }),
  });
}

function batchRows() {
  return fixture.employeeCodes.map((employee_code) => ({
    project_id: fixture.project,
    first_work_date: effectiveDate,
    employee_code,
    worker: {
      display_name: "Synthetic S03CD Worker",
      date_of_birth: { state: "omitted" },
      national_id: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
    recruiter_id: fixture.recruiter,
    labor_type: "TEMPORARY",
  }));
}

async function main() {
  const config = await loadSupabaseConfig();
  await assertDevProject(config.projectRef);
  const { databaseUrl } = config;
  const client = new pg.Client({ connectionString: databaseUrl, ssl: buildSslOptions() });
  await client.connect();
  let transactionOpen = false;
  try {
    const before = await reportingBaseline(client);
    assert.deepEqual(await fixtureCounts(client), expectedNoFixtures());
    await client.query("begin");
    transactionOpen = true;
    await seed(client);

    const { rows: inventory } = await client.query(`
      select
        (select count(*)::int from public.schema_migrations) as migration_count,
        (select count(*)::int
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname like 'direct_entry_%'
            and has_function_privilege('service_role', p.oid, 'execute')) as rpc_count
    `);
    assert.deepEqual(inventory[0], { migration_count: 24, rpc_count: 20 });

    const repository = createDirectEntryWriteRepository(rpcAdapter(client));
    const actorA = actor(fixture.authSubjectA, fixture.appUserA);
    const actorB = actor(fixture.authSubjectB, fixture.appUserB);
    const dependencies = { resolveSession: async () => actorA, repository };

    const catalogResponse = await getInputCatalog(effectiveDate, "true", dependencies);
    assert.equal(catalogResponse.status, 200);
    const catalog = (await catalogResponse.json()).catalog;
    assert.deepEqual(catalog.projects.map(({ project_id }) => project_id), [fixture.project]);
    assert.deepEqual(catalog.recruiters.map(({ recruiter_id }) => recruiter_id), [fixture.recruiter]);
    assert.equal(catalog.recruiters[0].provider_type, "hrp");
    assert.equal(catalog.recruiters[0].team_id, fixture.team);
    assert.deepEqual((await repository.loadInputCatalog({
      auth_subject: fixture.authSubjectA,
      app_user_id: fixture.appUserA,
      effective_date: "2031-01-01",
    })).data.recruiters, []);
    assert.equal(JSON.stringify(catalog).includes(fixture.authSubjectA), false);

    const createdResponse = await postDirectEntryBatch(batchRequest(batchRows()), "true", dependencies);
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.entry_ids.length, 2);
    const createReplayResponse = await postDirectEntryBatch(
      batchRequest(batchRows()),
      "true",
      dependencies,
    );
    assert.equal(createReplayResponse.status, 201);
    const createReplay = await createReplayResponse.json();
    assert.equal(createReplay.submission_id, created.submission_id);
    assert.deepEqual(createReplay.entry_ids, created.entry_ids);

    const actorADrafts = await getOwnDrafts("true", dependencies);
    const actorBDrafts = await getOwnDrafts("true", {
      resolveSession: async () => actorB,
      repository,
    });
    assert.equal((await actorADrafts.json()).drafts.length, 2);
    assert.equal((await actorBDrafts.json()).drafts.length, 0);

    const readResponse = await getDirectEntryEntry(created.entry_ids[0], "true", dependencies);
    assert.equal(readResponse.status, 200);
    const readBody = await readResponse.json();
    assert.equal(readBody.entry.provider_type, "hrp");
    assert.equal(readBody.entry.team_id, fixture.team);
    assert.deepEqual(readBody.entry.worker_details, {});
    assert.equal(readBody.entry.payment, null);
    assert.deepEqual(readBody.entry.documents, []);
    assert.equal(JSON.stringify(readBody).includes(fixture.authSubjectA), false);
    const otherActorRead = await getDirectEntryEntry(created.entry_ids[0], "true", {
      resolveSession: async () => actorB,
      repository,
    });
    assert.equal(otherActorRead.status, 404);

    const patch = {
      project_id: fixture.project,
      first_work_date: effectiveDate,
      employee_code: fixture.employeeCodes[0],
      worker_details: { display_name: "Synthetic S03CD Updated Worker" },
      recruiter_id: fixture.recruiter,
      labor_type: "TEMPORARY",
    };
    const firstUpdate = await patchDraftEntry(
      updateRequest(created.entry_ids[0], 1, patch, fixture.updateKey),
      created.entry_ids[0],
      "true",
      dependencies,
    );
    assert.equal(firstUpdate.status, 200);
    const firstResult = await firstUpdate.json();
    assert.equal(firstResult.entry_version, 2);

    const replay = await patchDraftEntry(
      updateRequest(created.entry_ids[0], 1, patch, fixture.updateKey),
      created.entry_ids[0],
      "true",
      dependencies,
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), firstResult);

    const changedPayload = { ...patch, worker_details: { display_name: "Other synthetic name" } };
    const idempotencyConflict = await patchDraftEntry(
      updateRequest(created.entry_ids[0], 1, changedPayload, fixture.updateKey),
      created.entry_ids[0],
      "true",
      dependencies,
    );
    assert.equal(idempotencyConflict.status, 409);

    const staleUpdate = await patchDraftEntry(
      updateRequest(created.entry_ids[0], 1, changedPayload, "s03cd-dev-stale-991001"),
      created.entry_ids[0],
      "true",
      dependencies,
    );
    assert.equal(staleUpdate.status, 409);

    const reloaded = await getOwnDrafts("true", dependencies);
    const reloadedDrafts = (await reloaded.json()).drafts;
    assert.equal(reloadedDrafts[0].worker_display_name, "Synthetic S03CD Updated Worker");
    assert.equal(reloadedDrafts[0].entry_version, 2);

    const { rows: evidence } = await client.query(`
      select
        (select count(*)::int from public.direct_entries where entry_id = any($1::uuid[])) as entries,
        (select count(*)::int from public.direct_entry_revisions where entry_id = any($1::uuid[])) as entry_revisions,
        (select count(*)::int from public.direct_entry_submission_revisions where submission_id = $2) as submission_revisions,
        (select count(*)::int from public.direct_entry_audit_events
          where resource_ref = any($3::text[])) as audit_events,
        (select count(*)::int from public.direct_entry_rpc_idempotency
          where app_user_id = $4 and idempotency_key = any($5::text[])) as idempotency_records
    `, [
      created.entry_ids,
      created.submission_id,
      [created.submission_id, ...created.entry_ids],
      fixture.appUserA,
      [fixture.createKey, fixture.updateKey],
    ]);
    assert.deepEqual(evidence[0], {
      entries: 2,
      entry_revisions: 3,
      submission_revisions: 2,
      audit_events: 4,
      idempotency_records: 2,
    });

    await client.query("rollback");
    transactionOpen = false;
    assert.deepEqual(await fixtureCounts(client), expectedNoFixtures());
    assert.deepEqual(await artifactCounts(client, created), {
      submissions: 0,
      entry_revisions: 0,
      submission_revisions: 0,
      audit_events: 0,
      idempotency_records: 0,
    });
    assert.deepEqual(await reportingBaseline(client), before);
    console.log(JSON.stringify({
      result: "PASS",
      migrationCount: inventory[0].migration_count,
      rpcCount: inventory[0].rpc_count,
      catalogEffectiveDateAndDerivedProviderTeam: true,
      outOfDateMembershipExcluded: true,
      actorAOwnDrafts: 2,
      actorBDrafts: 0,
      createAndReload: true,
      createReplayReusedSameBatch: true,
      updateVersion: firstResult.entry_version,
      idempotentReplay: true,
      changedPayloadConflict: true,
      staleExpectedVersionConflict: true,
      restrictedRead: true,
      otherActorEntryHidden: true,
      auditRevisionIdempotencyEvidence: evidence[0],
      baselineUnchanged: true,
      cleanupVerified: true,
    }, null, 2));
  } finally {
    if (transactionOpen) await client.query("rollback").catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  const reason = error.name === "AssertionError"
    ? error.message
    : error.code ?? error.name ?? "unknown";
  console.error(`S03CD DEV acceptance failed (${reason}); transaction rollback was attempted.`);
  process.exitCode = 1;
});
