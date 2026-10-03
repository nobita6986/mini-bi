#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import pg from "pg";

import { getDirectEntryEntry, postDirectEntryBatch } from "../src/lib/direct-entry/write-api.ts";
import { getInputCatalog } from "../src/lib/direct-entry/draft-api.ts";
import { patchDraftPayment } from "../src/lib/direct-entry/payment-api.ts";
import { createDirectEntryWriteRepository } from "../src/lib/direct-entry/write-repository.ts";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const fixture = {
  authSubject: "91300000-0000-4000-8000-000000000001",
  otherAuthSubject: "91300000-0000-4000-8000-000000000002",
  appUserId: "92300000-0000-4000-8000-000000000001",
  otherAppUserId: "92300000-0000-4000-8000-000000000002",
  recruiterId: "93300000-0000-4000-8000-000000000001",
  teamId: "94300000-0000-4000-8000-000000000001",
  projectId: "project_s04a_synthetic_01",
  activeBankId: "bank_s04a_synthetic_active",
  inactiveBankId: "bank_s04a_synthetic_inactive",
  employeeCode: "hrp-2026-941001",
  idempotencyKeys: [
    "s04a-dev-omitted",
    "s04a-dev-unknown",
    "s04a-dev-blank",
    "s04a-dev-provided",
    "s04a-dev-inactive",
    "s04a-dev-stale",
  ],
};
const effectiveDate = "2026-10-15";
const syntheticAccountNumber = "000012340056";

async function assertDevProject(projectRef) {
  const manifest = JSON.parse(await readFile(
    new URL("./p1.6-w03-g3-dev-manifest.json", import.meta.url),
    "utf8",
  ));
  assert.equal(projectRef, manifest.expectedProjectRef, "wrong Supabase project; aborting");
}

function actor(authSubject, appUserId, capabilities) {
  return {
    actor: {
      ok: true,
      actor: {
        auth_subject: authSubject,
        app_user_id: appUserId,
        enabled: true,
        capabilities,
        scopes: [{
          kind: "own",
          reference: appUserId,
          valid_from: "2020-01-01",
          valid_to: null,
        }],
        self_recruiter_suggestion: null,
        session: { provider: "supabase", verification: "getUser", authenticated_at: null },
      },
    },
    response_headers: {},
  };
}

const ownerActor = actor(fixture.authSubject, fixture.appUserId, [
  "entry_create", "submission_create", "entry_own", "payment_edit",
]);
const otherActor = actor(fixture.otherAuthSubject, fixture.otherAppUserId, [
  "entry_own", "payment_edit",
]);

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
      (select count(*)::int from public.direct_entry_banks where bank_id = any($6::text[])) as banks,
      (select count(*)::int from public.recruiter_provider_memberships where recruiter_id = $3) as provider_memberships,
      (select count(*)::int from public.recruiter_team_memberships where recruiter_id = $3) as team_memberships,
      (select count(*)::int from public.direct_entry_capability_grants where app_user_id = any($2::uuid[])) as capabilities,
      (select count(*)::int from public.direct_entry_scope_grants where app_user_id = any($2::uuid[])) as scopes,
      (select count(*)::int from public.direct_entries where employee_code = $7) as entries,
      (select count(*)::int from public.direct_entry_payments p
        join public.direct_entries e on e.entry_id = p.entry_id
        where e.employee_code = $7) as payments
  `, [
    [fixture.authSubject, fixture.otherAuthSubject],
    [fixture.appUserId, fixture.otherAppUserId],
    fixture.recruiterId,
    fixture.teamId,
    fixture.projectId,
    [fixture.activeBankId, fixture.inactiveBankId],
    fixture.employeeCode,
  ]);
  return rows[0];
}

function emptyFixtureCounts() {
  return {
    auth_users: 0,
    app_users: 0,
    recruiters: 0,
    teams: 0,
    projects: 0,
    banks: 0,
    provider_memberships: 0,
    team_memberships: 0,
    capabilities: 0,
    scopes: 0,
    entries: 0,
    payments: 0,
  };
}

async function seed(client) {
  await client.query("insert into auth.users (id) values ($1), ($2)", [
    fixture.authSubject, fixture.otherAuthSubject,
  ]);
  await client.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject) values ($1, $2), ($3, $4)",
    [
      fixture.appUserId, fixture.authSubject,
      fixture.otherAppUserId, fixture.otherAuthSubject,
    ],
  );
  await client.query(
    "insert into public.teams (team_id, code, display_name) values ($1, $2, $3)",
    [fixture.teamId, "S04A-DEV-SYNTH", "Synthetic S04A Team"],
  );
  await client.query(
    "insert into public.recruiters (recruiter_id, display_name) values ($1, $2)",
    [fixture.recruiterId, "Synthetic S04A Recruiter"],
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
    [fixture.projectId, "Synthetic S04A Project"],
  );
  await client.query(
    `insert into public.direct_entry_banks (bank_id, display_name, active)
     values ($1, 'Synthetic Active Bank', true), ($2, 'Synthetic Inactive Bank', false)`,
    [fixture.activeBankId, fixture.inactiveBankId],
  );
  await client.query(
    `insert into public.direct_entry_capability_grants
       (app_user_id, capability, valid_from) values
       ($1, 'entry_create', '2020-01-01'),
       ($1, 'submission_create', '2020-01-01'),
       ($1, 'entry_own', '2020-01-01'),
       ($1, 'payment_edit', '2020-01-01'),
       ($2, 'entry_own', '2020-01-01'),
       ($2, 'payment_edit', '2020-01-01')`,
    [fixture.appUserId, fixture.otherAppUserId],
  );
  await client.query(
    `insert into public.direct_entry_scope_grants
       (app_user_id, scope_kind, valid_from)
     values ($1, 'own', '2020-01-01'), ($2, 'own', '2020-01-01')`,
    [fixture.appUserId, fixture.otherAppUserId],
  );
}

function rpcAdapter(client) {
  return async (name, args) => {
    await client.query("savepoint s04a_rpc");
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
        case "direct_entry_update_payment":
          query = `select public.direct_entry_update_payment(
            $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::integer,
            $6::jsonb, $7::text, $8::text
          ) as data`;
          values = [
            args.p_auth_subject, args.p_app_user_id, args.p_entry_id,
            args.p_expected_entry_version, args.p_expected_payment_version,
            JSON.stringify(args.p_payment), args.p_reason, args.p_idempotency_key,
          ];
          break;
        default:
          throw new Error("Unexpected Direct Entry RPC");
      }
      const { rows } = await client.query(query, values);
      await client.query("reset role");
      await client.query("release savepoint s04a_rpc");
      return { data: rows[0].data, error: null };
    } catch (error) {
      await client.query("rollback to savepoint s04a_rpc");
      await client.query("release savepoint s04a_rpc");
      return { data: null, error: { code: error.code, message: error.message } };
    }
  };
}

function dependencies(repository, selectedActor = ownerActor) {
  return { resolveSession: async () => selectedActor, repository };
}

function batchRequest() {
  return new Request("https://example.test/api/direct-entry/batches", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": "s04a-dev-create",
    },
    body: JSON.stringify({
      rows: [{
        project_id: fixture.projectId,
        first_work_date: effectiveDate,
        employee_code: fixture.employeeCode,
        worker: {
          display_name: "Synthetic S04A Worker",
          date_of_birth: { state: "omitted" },
          national_id: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "omitted" },
        },
        recruiter_id: fixture.recruiterId,
        labor_type: "TEMPORARY",
      }],
    }),
  });
}

function paymentRequest(entryId, expectedEntryVersion, expectedPaymentVersion, state, fields, key) {
  return new Request(`https://example.test/api/direct-entry/entries/${entryId}/payment`, {
    method: "PATCH",
    headers: {
      origin: "https://example.test",
      host: "example.test",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({
      expected_entry_version: expectedEntryVersion,
      expected_payment_version: expectedPaymentVersion,
      payment: {
        state,
        account_number: state === "provided" ? fields.account_number : null,
        bank_id: state === "provided" ? fields.bank_id : null,
        account_holder_name: state === "provided" ? fields.account_holder_name : null,
      },
      reason: "Synthetic S04A acceptance update",
    }),
  });
}

async function assertFixtureAbsent(client) {
  assert.deepEqual(await fixtureCounts(client), emptyFixtureCounts());
}

async function main() {
  const config = await loadSupabaseConfig();
  await assertDevProject(config.projectRef);
  const client = new pg.Client({
    connectionString: config.databaseUrl,
    ssl: buildSslOptions(),
  });
  await client.connect();
  let transactionOpen = false;
  try {
    const before = await reportingBaseline(client);
    await assertFixtureAbsent(client);
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
    assert.deepEqual(inventory[0], { migration_count: 25, rpc_count: 20 });

    const repository = createDirectEntryWriteRepository(rpcAdapter(client));
    const ownerDependencies = dependencies(repository);
    const catalogResponse = await getInputCatalog(effectiveDate, "true", ownerDependencies);
    assert.equal(catalogResponse.status, 200);
    const catalog = (await catalogResponse.json()).catalog;
    assert.deepEqual(catalog.banks, [{
      bank_id: fixture.activeBankId,
      display_name: "Synthetic Active Bank",
    }]);

    const createdResponse = await postDirectEntryBatch(
      batchRequest(), "true", ownerDependencies,
    );
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const entryId = created.entry_ids[0];

    const omittedRequest = () => paymentRequest(
      entryId, 1, 0, "omitted", {}, fixture.idempotencyKeys[0],
    );
    const omittedResponse = await patchDraftPayment(
      omittedRequest(), entryId, "true", ownerDependencies,
    );
    assert.equal(omittedResponse.status, 200);
    const omitted = await omittedResponse.json();
    assert.deepEqual(
      { entry_version: omitted.entry_version, payment_version: omitted.payment_version },
      { entry_version: 2, payment_version: 1 },
    );
    const replayResponse = await patchDraftPayment(
      omittedRequest(), entryId, "true", ownerDependencies,
    );
    assert.deepEqual(await replayResponse.json(), omitted);

    const changedReplay = await patchDraftPayment(
      paymentRequest(entryId, 1, 0, "unknown", {}, fixture.idempotencyKeys[0]),
      entryId,
      "true",
      ownerDependencies,
    );
    assert.equal(changedReplay.status, 409);

    const unknownResponse = await patchDraftPayment(
      paymentRequest(entryId, 2, 1, "unknown", {}, fixture.idempotencyKeys[1]),
      entryId,
      "true",
      ownerDependencies,
    );
    const unknown = await unknownResponse.json();
    assert.equal(unknownResponse.status, 200);
    assert.equal(unknown.payment_version, 2);
    const blankResponse = await patchDraftPayment(
      paymentRequest(entryId, 3, 2, "intentionally_blank", {}, fixture.idempotencyKeys[2]),
      entryId,
      "true",
      ownerDependencies,
    );
    const blank = await blankResponse.json();
    assert.equal(blankResponse.status, 200);
    assert.equal(blank.payment_version, 3);

    const providedFields = {
      account_number: syntheticAccountNumber,
      bank_id: fixture.activeBankId,
      account_holder_name: "Synthetic S04A Account Holder",
    };
    const providedResponse = await patchDraftPayment(
      paymentRequest(entryId, 4, 3, "provided", providedFields, fixture.idempotencyKeys[3]),
      entryId,
      "true",
      ownerDependencies,
    );
    const provided = await providedResponse.json();
    assert.equal(providedResponse.status, 200);
    assert.equal(provided.entry_version, 5);
    assert.equal(provided.payment_version, 4);

    const inactiveResponse = await patchDraftPayment(
      paymentRequest(entryId, 5, 4, "provided", {
        ...providedFields,
        bank_id: fixture.inactiveBankId,
      }, fixture.idempotencyKeys[4]),
      entryId,
      "true",
      ownerDependencies,
    );
    assert.equal(inactiveResponse.status, 400);
    assert.equal((await inactiveResponse.json()).code, "BANK_INVALID");

    const staleResponse = await patchDraftPayment(
      paymentRequest(entryId, 4, 3, "unknown", {}, fixture.idempotencyKeys[5]),
      entryId,
      "true",
      ownerDependencies,
    );
    assert.equal(staleResponse.status, 409);

    const outOfScopeResponse = await patchDraftPayment(
      paymentRequest(entryId, 5, 4, "unknown", {}, "s04a-outside-scope"),
      entryId,
      "true",
      dependencies(repository, otherActor),
    );
    assert.equal(outOfScopeResponse.status, 404);

    const maskedResponse = await getDirectEntryEntry(entryId, "true", ownerDependencies);
    const maskedBody = await maskedResponse.json();
    assert.equal(maskedResponse.status, 200);
    assert.equal(maskedBody.entry.payment.account_number, "••••••••0056");
    assert.equal(maskedBody.entry.payment.version, 4);
    assert.equal("bank_id" in maskedBody.entry.payment, false);
    assert.equal("account_holder_name" in maskedBody.entry.payment, false);
    assert.equal(JSON.stringify(maskedBody).includes(syntheticAccountNumber), false);

    await client.query(
      `insert into public.direct_entry_capability_grants
         (app_user_id, capability, valid_from) values ($1, 'payment_view', '2020-01-01')`,
      [fixture.appUserId],
    );
    const fullResponse = await getDirectEntryEntry(entryId, "true", ownerDependencies);
    const fullBody = await fullResponse.json();
    assert.equal(fullResponse.status, 200);
    assert.equal(fullBody.entry.payment.account_number, syntheticAccountNumber);
    assert.equal(fullBody.entry.payment.bank_id, fixture.activeBankId);
    assert.equal(fullBody.entry.payment.account_holder_name, "Synthetic S04A Account Holder");

    const { rows: evidence } = await client.query(`
      select
        (select count(*)::int from public.direct_entry_audit_events
          where resource_ref = $1 and action = 'payment_update') as payment_audit_count,
        (select count(*)::int from public.direct_entry_revisions
          where entry_id = $2) as entry_revision_count,
        (select count(*)::int from public.direct_entry_rpc_idempotency
          where app_user_id = $3 and action = 'payment_update') as idempotency_count,
        (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb)
          from public.direct_entry_audit_events a
         where a.resource_ref = $1 and a.action = 'payment_update') as payment_audit
    `, [entryId, entryId, fixture.appUserId]);
    assert.equal(evidence[0].payment_audit_count, 4);
    assert.equal(evidence[0].entry_revision_count, 5);
    assert.equal(evidence[0].idempotency_count, 4);
    assert.equal(JSON.stringify(evidence[0].payment_audit).includes(syntheticAccountNumber), false);
    assert.equal(JSON.stringify(evidence[0].payment_audit).includes("Synthetic S04A Account Holder"), false);

    await client.query("rollback");
    transactionOpen = false;
    assert.deepEqual(await reportingBaseline(client), before);
    await assertFixtureAbsent(client);
    console.log(JSON.stringify({
      result: "PASS",
      migrationCount: inventory[0].migration_count,
      paymentRpcInventory: inventory[0].rpc_count,
      activeBankProjection: true,
      paymentStates: ["omitted", "unknown", "intentionally_blank", "provided"],
      accountLeadingZeroPreserved: true,
      initialPaymentVersion: 1,
      updateEntryAndPaymentVersions: true,
      identicalIdempotentReplay: true,
      changedPayloadAndStaleVersionConflict: true,
      inactiveBankRejected: true,
      outOfScopeActorDenied: true,
      paymentViewMaskingAndFullProjection: true,
      generalAuditExcludesPaymentValues: true,
      baselineUnchanged: true,
      cleanupVerified: true,
    }, null, 2));
  } finally {
    if (transactionOpen) await client.query("rollback").catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error(
    `S04A DEV acceptance failed (${error.code ?? error.name ?? "unknown"}); transaction rollback was attempted.`,
  );
  process.exitCode = 1;
});
