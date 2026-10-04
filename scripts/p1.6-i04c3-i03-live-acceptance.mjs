#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";

import { getDirectEntryEntry } from "../src/lib/direct-entry/write-api.ts";
import { createDirectEntryWriteRepository } from "../src/lib/direct-entry/write-repository.ts";
import { expectedDirectEntryFunctions } from "./lib/direct-entry-inventory.mjs";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { readMigrations } from "./lib/migration-validation.mjs";
import { createMigratedDatabase } from "./lib/s04c-read-fixture.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const EXPECTED_PROJECT_REF = "kiamyvfymxdattohfwmt";
const MIGRATION = "20261005060000_p1_6_i04c3_full_profile_server_foundation.sql";
const CONTRACT = "worker-profile/1.0";
const RPC = `select public.direct_entry_create_full_profile_batch(
  $1::uuid, $2::uuid, $3::text, $4::jsonb, $5::text
) as result`;
const TABLES = [
  "auth.users",
  "public.direct_entry_app_users",
  "public.direct_entry_capability_grants",
  "public.direct_entry_scope_grants",
  "public.direct_entry_restricted_reasons",
  "public.direct_entry_catalog_bootstrap_runs",
  "public.direct_entry_projects",
  "public.recruiters",
  "public.teams",
  "public.recruiter_provider_memberships",
  "public.recruiter_team_memberships",
  "public.direct_entry_banks",
  "public.direct_entry_candidates",
  "public.direct_entry_submissions",
  "public.direct_entries",
  "public.direct_entry_payments",
  "public.direct_entry_employment_status_events",
  "public.direct_entry_revisions",
  "public.direct_entry_submission_revisions",
  "public.direct_entry_audit_events",
  "public.direct_entry_rpc_idempotency",
  "public.direct_entry_document_versions",
  "public.direct_entry_document_events",
];
const checks = [];

function check(condition, label) {
  if (!condition) throw new Error("Acceptance check failed: " + label);
  checks.push(label);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function actor() {
  return { auth: randomUUID(), user: randomUUID() };
}

async function tableCounts(client) {
  const counts = {};
  for (const table of TABLES) {
    const { rows } = await client.query(`select count(*)::int as n from ${table}`);
    counts[table] = rows[0].n;
  }
  return counts;
}

async function reportingBaseline(client) {
  const { rows } = await client.query(`
    select
      (select count(*)::int from public.data_sources) as sources,
      (select count(*)::int from public.sync_runs) as sync_runs,
      (select count(*)::int from public.daily_recruitment_breakdown) as breakdown_rows,
      (select coalesce(sum(recruited_count), 0)::bigint
         from public.daily_recruitment_breakdown) as recruited_total
  `);
  return rows[0];
}

async function functionState(client) {
  const { rows } = await client.query(`
    select p.proname, p.prosecdef,
      coalesce(array_to_string(p.proconfig, ','), '') as config,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
      exists (
        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         where a.grantee = 0 and a.privilege_type = 'EXECUTE'
      ) as public_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'direct_entry\\_%'
    order by p.proname, p.oid
  `);
  return rows;
}

async function tableSecurityState(client) {
  const { rows } = await client.query(`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity,
      bool_or(has_table_privilege(r.rolname, c.oid, 'INSERT')) as insert_priv,
      bool_or(has_table_privilege(r.rolname, c.oid, 'UPDATE')) as update_priv,
      bool_or(has_table_privilege(r.rolname, c.oid, 'DELETE')) as delete_priv,
      bool_or(has_table_privilege(r.rolname, c.oid, 'TRUNCATE')) as truncate_priv
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (
      select rolname from pg_roles
       where rolname in ('anon', 'authenticated', 'service_role')
    ) r
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and (c.relname like 'direct_entry\\_%' or c.relname = 'direct_entries')
    group by c.relname, c.relrowsecurity, c.relforcerowsecurity
    order by c.relname
  `);
  return rows;
}

async function verifySchema(client, migrations) {
  const migration = migrations.find(({ name }) => name === MIGRATION);
  check(migrations.length === 36 && migration, "36 local migrations including #36");

  const { rows: applied } = await client.query(
    "select version, checksum from public.schema_migrations order by version",
  );
  check(applied.length === migrations.length, "migration ledger has 36 rows");
  const checksums = new Map(applied.map(({ version, checksum }) => [version, checksum]));
  check(migrations.every(({ name, checksum }) => checksums.get(name) === checksum),
    "all applied checksums match source");

  const expectedNames = expectedDirectEntryFunctions(migrations);
  const sourceNames = [...expectedNames].sort();
  const fromScratch = await createMigratedDatabase();
  try {
    check(fromScratch.migrationNames.length === 36, "PGlite applied all 36 migrations");
    const expectedFunctions = await functionState(fromScratch.db);
    const liveFunctions = await functionState(client);
    const expectedLiveNames = [...new Set(liveFunctions.map(({ proname }) => proname))].sort();
    check(sourceNames.length === 67 && sameJson(expectedLiveNames, sourceNames),
      "live Direct Entry function names equal migration-derived inventory of 67");
    check(expectedFunctions.length === liveFunctions.length &&
      expectedFunctions.every((row, index) =>
        row.proname === liveFunctions[index].proname &&
        row.prosecdef === liveFunctions[index].prosecdef &&
        row.config === liveFunctions[index].config &&
        row.anon_exec === liveFunctions[index].anon_exec &&
        row.auth_exec === liveFunctions[index].auth_exec &&
        row.service_exec === liveFunctions[index].service_exec &&
        row.public_exec === liveFunctions[index].public_exec),
    "live function ACL/definer/search_path state equals PGlite");

    const serviceNames = liveFunctions
      .filter(({ service_exec }) => service_exec)
      .map(({ proname }) => proname);
    check(new Set(serviceNames).size === 30 &&
      liveFunctions.filter(({ service_exec }) => service_exec).length === 30,
    "exactly 30 service-role boundary functions");
    check(liveFunctions.filter(({ service_exec }) => !service_exec).length === 37 &&
      liveFunctions.filter(({ service_exec, anon_exec, auth_exec, public_exec }) =>
        !service_exec && (anon_exec || auth_exec || public_exec)).length === 0,
    "37 internal functions are not executable by runtime roles or PUBLIC");
    const requiredDefiners = new Set([
      "direct_entry_create_full_profile_batch",
      "direct_entry_read_projection",
    ]);
    check([...requiredDefiners].every((name) => {
      const fn = liveFunctions.find(({ proname }) => proname === name);
      return fn?.service_exec && fn.prosecdef &&
        fn.config.includes("search_path=pg_catalog, public") &&
        !fn.anon_exec && !fn.auth_exec && !fn.public_exec;
    }), "full-profile create/read boundaries are SECURITY DEFINER, pinned and service-role only");
    check(liveFunctions.filter(({ service_exec }) => service_exec)
      .every(({ anon_exec, auth_exec, public_exec }) =>
        !anon_exec && !auth_exec && !public_exec),
    "all service-role Direct Entry functions are not executable by other runtime roles");

    const expectedTables = await tableSecurityState(fromScratch.db);
    const liveTables = await tableSecurityState(client);
    check(sameJson(liveTables, expectedTables),
      "live Direct Entry RLS/FORCE RLS and runtime DML grants equal PGlite");
    check(liveTables.every(({ relrowsecurity, relforcerowsecurity, insert_priv,
      update_priv, delete_priv, truncate_priv }) =>
      relrowsecurity && relforcerowsecurity &&
      !insert_priv && !update_priv && !delete_priv && !truncate_priv),
    "Direct Entry tables enforce RLS and grant no runtime DML");
  } finally {
    await fromScratch.db.close();
  }
}

async function insertActor(client, value, capabilities, withOwnScope) {
  await client.query("insert into auth.users(id) values ($1::uuid)", [value.auth]);
  await client.query(
    "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled) " +
    "values ($1::uuid,$2::uuid,true)",
    [value.user, value.auth],
  );
  if (capabilities.length > 0) {
    await client.query(
      "insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from) " +
      "select $1::uuid, capability, '2020-01-01'::date from unnest($2::text[]) capability",
      [value.user, capabilities],
    );
  }
  if (withOwnScope) {
    await client.query(
      "insert into public.direct_entry_scope_grants(app_user_id,scope_kind,valid_from) " +
      "values ($1::uuid,'own','2020-01-01')",
      [value.user],
    );
  }
}

async function invokeRpc(client, value, rows, key) {
  await client.query("set local role service_role");
  const { rows: result } = await client.query(RPC, [
    value.auth, value.user, CONTRACT, JSON.stringify(rows), key,
  ]);
  await client.query("reset role");
  return result[0].result;
}

async function expectRpcError(client, label, expectedCode, operation) {
  const savepoint = "i03_" + checks.length;
  await client.query("savepoint " + savepoint);
  let error;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  await client.query("rollback to savepoint " + savepoint);
  await client.query("reset role");
  await client.query("release savepoint " + savepoint);
  check(error?.code === expectedCode, label);
}

function row(projectId, recruiterId, code, overrides = {}) {
  return {
    project_id: projectId,
    first_work_date: "2020-01-01",
    employee_code: code,
    recruiter_id: recruiterId,
    labor_type: "TEMPORARY",
    display_name: "Synthetic Worker " + code.slice(-6),
    worker_details: {},
    general_note: { state: "omitted" },
    payment: null,
    employment: null,
    ...overrides,
  };
}

async function tableStateInTransaction(client) {
  const counts = await tableCounts(client);
  const report = await reportingBaseline(client);
  return { counts, report };
}

async function directProjection(client, owner, entryId) {
  const savepoint = "i03_projection_" + checks.length;
  await client.query("savepoint " + savepoint);
  try {
    await client.query("set local role service_role");
    const { rows } = await client.query(
      "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as value",
      [owner.auth, owner.user, entryId],
    );
    await client.query("reset role");
    await client.query("release savepoint " + savepoint);
    return rows[0].value;
  } catch (error) {
    await client.query("rollback to savepoint " + savepoint);
    await client.query("reset role");
    await client.query("release savepoint " + savepoint);
    throw error;
  }
}

async function apiRead(client, value, entryId) {
  let rpcCall = 0;
  const repository = createDirectEntryWriteRepository(async (name, args) => {
    if (name !== "direct_entry_read_projection") {
      return { data: null, error: { code: "UNEXPECTED_RPC" } };
    }
    const savepoint = "i03_api_read_" + (++rpcCall);
    await client.query("savepoint " + savepoint);
    try {
      await client.query("set local role service_role");
      const { rows } = await client.query(
        "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as value",
        [args.p_auth_subject, args.p_app_user_id, args.p_entry_id],
      );
      await client.query("reset role");
      await client.query("release savepoint " + savepoint);
      return { data: rows[0].value, error: null };
    } catch (error) {
      await client.query("rollback to savepoint " + savepoint);
      await client.query("reset role");
      await client.query("release savepoint " + savepoint);
      return { data: null, error: { code: error.code, message: error.message } };
    }
  });
  const response = await getDirectEntryEntry(entryId, "true", {
    resolveSession: async () => ({
      actor: { ok: true, actor: { auth_subject: value.auth, app_user_id: value.user } },
      response_headers: new Headers(),
    }),
    repository,
  });
  return { status: response.status, body: await response.json() };
}

async function liveAcceptance(client) {
  const tablesBefore = await tableCounts(client);
  const reportingBefore = await reportingBaseline(client);
  const { rows: bankRows } = await client.query(
    "select count(*)::int as n from public.direct_entry_banks",
  );
  check(bankRows[0].n === 0, "bank catalog remains empty before acceptance");

  let transactionOpen = false;
  try {
    await client.query("begin");
    transactionOpen = true;
    const token = randomUUID().replaceAll("-", "");
    const projectId = "i03_" + token;
    const team = randomUUID();
    const recruiter = randomUUID();
    const owner = actor();
    const noCapability = actor();
    const noScope = actor();
    const outsider = actor();
    const idempotencyKey = randomUUID();

    await insertActor(client, owner, [
      "entry_create", "submission_create", "entry_own", "pii_view",
      "payment_view", "payment_edit", "employment_status.apply",
    ], true);
    await insertActor(client, noCapability, [], true);
    await insertActor(client, noScope, ["entry_create", "submission_create"], false);
    await insertActor(client, outsider, ["entry_own"], true);
    await client.query(
      "insert into public.teams(team_id,code,display_name) values ($1::uuid,$2,$3)",
      [team, "I03-" + token.slice(0, 24), "Synthetic I03 Team"],
    );
    await client.query(
      "insert into public.direct_entry_projects(project_id,display_name) values ($1,$2)",
      [projectId, "Synthetic I03 Project"],
    );
    await client.query(
      "insert into public.recruiters(recruiter_id,display_name,active) values ($1::uuid,$2,true)",
      [recruiter, "Synthetic I03 Recruiter"],
    );
    await client.query(
      "insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from) " +
      "values ($1::uuid,'hrp','2020-01-01')",
      [recruiter],
    );
    await client.query(
      "insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from) " +
      "values ($1::uuid,$2::uuid,'2020-01-01')",
      [recruiter, team],
    );
    check(true, "synthetic actor and catalog fixtures seeded inside outer transaction");

    const complete = row(projectId, recruiter, "hrp-2020-940001", {
      display_name: "Synthetic Complete Profile",
      worker_details: {
        gender: { state: "provided", value: "OTHER" },
        date_of_birth: { state: "provided", value: "1990-01-01" },
        national_id: { state: "provided", value: "001234567890" },
        national_id_issued_at: { state: "provided", value: "2010-01-01" },
        national_id_issued_place: { state: "provided", value: "Synthetic District" },
        address: { state: "provided", value: "Synthetic Address" },
        phone: { state: "provided", value: "09000000001" },
      },
      general_note: { state: "provided", value: "Synthetic private note" },
      employment: {
        initial_status: "OFF",
        leave_date: "2024-01-01",
        leave_reason_text: "Synthetic historical reason",
      },
    });
    const minimal = row(projectId, recruiter, "hrp-2020-940002");
    const paymentUnknown = row(projectId, recruiter, "hrp-2020-940003", {
      payment: { state: "unknown" },
    });
    const paymentBlank = row(projectId, recruiter, "hrp-2020-940004", {
      payment: { state: "intentionally_blank" },
    });
    const rows = [complete, minimal, paymentUnknown, paymentBlank];
    const created = await invokeRpc(client, owner, rows, idempotencyKey);
    check(created.replayed === false && created.entry_ids.length === rows.length &&
      created.entry_ids.every((id) => typeof id === "string"),
    "non-payment full-profile batch succeeds through boundary RPC with ordered IDs");
    const ordered = await client.query(
      "select e.employee_code from unnest($1::uuid[]) with ordinality ids(id,ordinal) " +
      "join public.direct_entries e on e.entry_id=ids.id order by ids.ordinal",
      [created.entry_ids],
    );
    check(sameJson(ordered.rows.map(({ employee_code }) => employee_code),
      rows.map(({ employee_code }) => employee_code)),
    "RPC preserves entry_ids order against persisted worker codes");

    const replay = await invokeRpc(client, owner, rows, idempotencyKey);
    check(replay.replayed === true && sameJson(replay.entry_ids, created.entry_ids),
      "same idempotency key and intent replay without duplicate entries");
    const afterCreate = await tableStateInTransaction(client);
    await expectRpcError(client, "same idempotency key with changed intent conflicts", "22023",
      () => invokeRpc(client, owner, [minimal], idempotencyKey));
    check(sameJson(await tableStateInTransaction(client), afterCreate),
      "changed-intent replay leaves no duplicate or residue");

    const projection = await directProjection(client, owner, created.entry_ids[0]);
    const serialized = JSON.stringify(projection);
    check(projection.version === 1 && projection.employee_code === complete.employee_code &&
      projection.project_id === projectId && projection.recruiter_id === recruiter &&
      projection.team_id === team && projection.provider_type === "hrp" &&
      projection.labor_type === "TEMPORARY" &&
      projection.worker_details.display_name === complete.display_name &&
      projection.worker_details.national_id.value === "001234567890" &&
      projection.general_note === "Synthetic private note" &&
      projection.employment_status.status === "OFF",
    "authorized projection returns full profile schema and version");
    check(!serialized.includes(owner.auth) && !serialized.includes(owner.user) &&
      !serialized.includes(idempotencyKey) &&
      !/storage_key|checksum|signed_url|bucket|capabilities|scope_grants/i.test(serialized),
    "projection omits auth/app identities, idempotency key and internal transport/authority data");
    const unknownProjection = await directProjection(client, owner, created.entry_ids[2]);
    const blankProjection = await directProjection(client, owner, created.entry_ids[3]);
    check(unknownProjection.payment?.state === "unknown" &&
      blankProjection.payment?.state === "intentionally_blank" &&
      unknownProjection.payment?.account_number == null &&
      blankProjection.payment?.account_number == null,
    "unknown and intentionally-blank payments succeed with banks=0 and no account data");

    await client.query(
      "delete from public.direct_entry_capability_grants " +
      "where app_user_id=$1::uuid and capability='pii_view'",
      [owner.user],
    );
    const redacted = await directProjection(client, owner, created.entry_ids[0]);
    check(redacted.worker_details.display_name.present === true &&
      redacted.worker_details.national_id.state === "provided" &&
      redacted.general_note.present === true &&
      !JSON.stringify(redacted).includes("Synthetic Complete Profile") &&
      !JSON.stringify(redacted).includes("001234567890") &&
      !JSON.stringify(redacted).includes("Synthetic private note"),
    "missing pii_view returns fail-closed redacted worker, national ID and note projection");

    const revisions = await client.query(
      "select before_snapshot,after_snapshot from public.direct_entry_revisions " +
      "where entry_id=any($1::uuid[])",
      [created.entry_ids],
    );
    check(revisions.rows.length === rows.length &&
      revisions.rows.every(({ before_snapshot, after_snapshot }) => {
        const text = JSON.stringify([before_snapshot, after_snapshot]);
        return !text.includes("001234567890") && !text.includes("09000000001") &&
          !text.includes("Synthetic Address") && !text.includes("Synthetic private note") &&
          !text.includes("Synthetic historical reason") &&
          text.includes('"worker_details":{"present":true}');
      }),
    "revision snapshots keep worker and note values redacted");
    const audit = await client.query(
      "select changed_fields from public.direct_entry_audit_events " +
      "where resource_ref=any($1::text[])",
      [[...created.entry_ids, created.submission_id]],
    );
    const changedFieldAllowlist = new Set([
      "entry_created", "worker_details", "general_note", "payment", "employment_status",
      "submission_created", "entries_created",
    ]);
    check(audit.rows.length === rows.length + 1 &&
      audit.rows.every(({ changed_fields }) =>
        Array.isArray(changed_fields) &&
        changed_fields.every((field) => changedFieldAllowlist.has(field))),
    "audit changed_fields contains field names only");

    const apiMissing = await apiRead(client, owner, randomUUID());
    const apiOutside = await apiRead(client, outsider, created.entry_ids[0]);
    check(apiMissing.status === 404 && apiMissing.body.code === "ENTRY_NOT_FOUND" &&
      apiOutside.status === 404 && apiOutside.body.code === "ENTRY_NOT_FOUND",
    "absent and out-of-scope detail reads have the same sanitized API result");

    const beforeRejected = await tableStateInTransaction(client);
    const invalidBatch = [
      row(projectId, recruiter, "hrp-2020-940005"),
      row(projectId, recruiter, "hrp-2019-940006"),
    ];
    await expectRpcError(client, "invalid multi-row batch is rejected", "22023",
      () => invokeRpc(client, owner, invalidBatch, randomUUID()));
    check(sameJson(await tableStateInTransaction(client), beforeRejected),
      "invalid multi-row batch leaves no entry/submission/revision/audit/idempotency residue");

    await expectRpcError(client, "actor missing entry_create is denied", "42501",
      () => invokeRpc(client, noCapability, [minimal], randomUUID()));
    await expectRpcError(client, "actor without own scope is denied", "42501",
      () => invokeRpc(client, noScope, [minimal], randomUUID()));
    check(sameJson(await tableStateInTransaction(client), beforeRejected),
      "denied capability and scope attempts leave no business or idempotency residue");

    const paymentProvided = row(projectId, recruiter, "hrp-2020-940007", {
      payment: {
        state: "provided",
        account_number: "000012345678",
        bank_id: "i03_no_bank",
        account_holder_name: "Synthetic Holder",
      },
    });
    await expectRpcError(client, "payment-bearing row is blocked while banks=0", "22023",
      () => invokeRpc(client, owner, [paymentProvided], randomUUID()));
    check(sameJson(await tableStateInTransaction(client), beforeRejected),
      "bank-blocked payment row leaves no partial records");
    check((await tableCounts(client))["public.direct_entry_banks"] === 0,
      "bank catalog remains empty during acceptance");

    await client.query("rollback");
    transactionOpen = false;
  } finally {
    if (transactionOpen) await client.query("rollback");
  }

  check(sameJson(await tableCounts(client), tablesBefore),
    "outer transaction rollback restores all Direct Entry, actor and fixture row counts");
  check(sameJson(await reportingBaseline(client), reportingBefore),
    "outer transaction rollback preserves reporting baseline");
  const { rows: afterBanks } = await client.query(
    "select count(*)::int as n from public.direct_entry_banks",
  );
  check(afterBanks[0].n === 0, "bank catalog remains empty after rollback");
  return {
    directEntryCountsBefore: tablesBefore,
    reportingBaselineBefore: reportingBefore,
    directEntryCountsAfter: await tableCounts(client),
    reportingBaselineAfter: await reportingBaseline(client),
  };
}

async function main() {
  const config = await loadSupabaseConfig();
  check(config.projectRef === EXPECTED_PROJECT_REF, "configured project matches Owner-approved Production");
  const migrations = await readMigrations(path.resolve("supabase/migrations"));
  const client = new pg.Client({
    connectionString: config.databaseUrl,
    ssl: buildSslOptions(),
  });
  await client.connect();
  let acceptance;
  try {
    await verifySchema(client, migrations);
    acceptance = await liveAcceptance(client);
  } finally {
    await client.end();
  }
  console.log(JSON.stringify({
    ok: true,
    projectRef: config.projectRef,
    migrationCount: migrations.length,
    functionInventory: { total: 67, serviceRole: 30, internal: 37 },
    outerTransactionRolledBack: true,
    banks: 0,
    checks: checks.length,
    acceptance,
  }, null, 2));
}

main().catch((error) => {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code : "ACCEPTANCE_FAILED";
  console.error(JSON.stringify({ ok: false, code, reason: error?.message?.startsWith("Acceptance check failed:")
    ? error.message : "sanitized acceptance failure" }));
  process.exitCode = 1;
});
