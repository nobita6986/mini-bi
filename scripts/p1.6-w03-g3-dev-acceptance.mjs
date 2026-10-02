#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";
import { migrationChecksum } from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MANIFEST_PATH = path.resolve(
  ROOT,
  process.argv[2] ?? "scripts/p1.6-w03-g3-dev-manifest.json",
);
const MIGRATION_NAME = "20261002170000_p1_6_direct_entry_foundation.sql";
const MIGRATION_PATH = path.join(ROOT, "supabase", "migrations", MIGRATION_NAME);
const CORRECTIVE_MIGRATION_NAME = "20261003170000_p1_6_w03_submission_noop_guard.sql";
const CORRECTIVE_MIGRATION_PATH = path.join(ROOT, "supabase", "migrations", CORRECTIVE_MIGRATION_NAME);
const EXPECTED_RPC_NAMES = [
  "direct_entry_append_document_event",
  "direct_entry_apply_employment_status",
  "direct_entry_approve_change_request",
  "direct_entry_correct_latest_status",
  "direct_entry_create_batch",
  "direct_entry_create_change_request",
  "direct_entry_create_document_metadata",
  "direct_entry_create_draft_row",
  "direct_entry_delete_draft_row",
  "direct_entry_privileged_edit",
  "direct_entry_read_audit",
  "direct_entry_read_projection",
  "direct_entry_reject_change_request",
  "direct_entry_transition_submission",
  "direct_entry_update_draft_row",
  "direct_entry_update_payment",
  "direct_entry_withdraw_change_request",
].sort();
const DML_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"];
const IMMUTABLE_TABLES = [
  "direct_entry_audit_events",
  "direct_entry_revisions",
  "direct_entry_submission_revisions",
  "direct_entry_change_request_revisions",
  "direct_entry_employment_status_events",
  "direct_entry_document_versions",
  "direct_entry_document_events",
];

let manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
let client;
let fixtureCommitted = false;
let phase = "preflight";
let action = "preflight";
let transactionOpen = false;
const checks = [];
let keyCounter = 0;

function saveManifest() {
  return writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function pass(label) {
  checks.push(label);
}

function idempotencyKey(label) {
  const key = `${manifest.namespace}_${label}_${++keyCounter}`;
  manifest.idempotencyKeys.push(key);
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return key;
}

async function persistedKey(label) {
  return idempotencyKey(label);
}

async function roleQuery(role, sql, args = []) {
  await client.query(`set role ${role}`);
  try {
    const result = await client.query(sql, args);
    await client.query("reset role");
    return result;
  } catch (error) {
    await client.query("reset role").catch(() => {});
    throw error;
  }
}

async function serviceRpc(sql, args = []) {
  const result = await roleQuery("service_role", sql, args);
  return result.rows[0]?.result ?? result.rows;
}

async function expectDenied(label, fn, pattern) {
  const savepoint = `g3_denial_${++keyCounter}`;
  if (transactionOpen) await client.query(`savepoint ${savepoint}`);
  let error;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  if (transactionOpen) {
    if (error) await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
  assert.ok(error, `${label}: expected denial`);
  assert.match(String(error.message), pattern, `${label}: wrong denial`);
  pass(label);
}

async function baseline() {
  const result = await client.query(`
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
        where s.active and not s.is_test)::int as "breakdownRows",
      (select count(distinct b.business_date)
         from public.daily_recruitment_breakdown b
         join public.data_sources s on s.id = b.source_id
        where s.active and not s.is_test)::int as "breakdownDateBuckets",
      (select count(distinct b.project_key)
         from public.daily_recruitment_breakdown b
         join public.data_sources s on s.id = b.source_id
        where s.active and not s.is_test)::int as projects,
      (select count(distinct b.recruiter_key)
         from public.daily_recruitment_breakdown b
         join public.data_sources s on s.id = b.source_id
        where s.active and not s.is_test)::int as recruiters,
      (select count(*)::int from public.direct_entry_app_users) as "directEntryUsers",
      (select count(*)::int from public.direct_entries) as "directEntryRows"
  `);
  return Object.fromEntries(
    Object.entries(result.rows[0]).map(([key, value]) => [
      key,
      typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
    ]),
  );
}

async function verifyMigrationRegistry() {
  const expectedChecksum = migrationChecksum(await readFile(MIGRATION_PATH, "utf8"));
  const correctiveChecksum = migrationChecksum(await readFile(CORRECTIVE_MIGRATION_PATH, "utf8"));
  const { rows } = await client.query(
    "select version, checksum from public.schema_migrations order by version",
  );
  assert.equal(rows.length, 21, "expected exactly 21 registered migrations including W03 correction");
  assert.equal(rows.filter((row) => row.version === MIGRATION_NAME).length, 1);
  assert.equal(rows.find((row) => row.version === MIGRATION_NAME)?.checksum, expectedChecksum);
  assert.equal(rows.filter((row) => row.version === CORRECTIVE_MIGRATION_NAME).length, 1);
  assert.equal(rows.find((row) => row.version === CORRECTIVE_MIGRATION_NAME)?.checksum, correctiveChecksum);
  const files = (await import("node:fs/promises")).readdir;
  const migrations = (await files(path.join(ROOT, "supabase", "migrations")))
    .filter((name) => name.endsWith(".sql"));
  assert.equal(migrations.length, 21);
  assert.deepEqual(rows.map((row) => row.version), migrations.sort());
  pass("21 migration records present; foundation and forward-correction checksums match");
}

async function verifyCatalogBoundary() {
  const tables = await client.query(`
    select c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
      has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
      has_table_privilege('anon', c.oid, 'INSERT') as anon_insert,
      has_table_privilege('anon', c.oid, 'UPDATE') as anon_update,
      has_table_privilege('anon', c.oid, 'DELETE') as anon_delete,
      has_table_privilege('anon', c.oid, 'TRUNCATE') as anon_truncate,
      has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
      has_table_privilege('authenticated', c.oid, 'INSERT') as auth_insert,
      has_table_privilege('authenticated', c.oid, 'UPDATE') as auth_update,
      has_table_privilege('authenticated', c.oid, 'DELETE') as auth_delete,
      has_table_privilege('authenticated', c.oid, 'TRUNCATE') as auth_truncate,
      has_table_privilege('service_role', c.oid, 'SELECT') as service_select,
      has_table_privilege('service_role', c.oid, 'INSERT') as service_insert,
      has_table_privilege('service_role', c.oid, 'UPDATE') as service_update,
      has_table_privilege('service_role', c.oid, 'DELETE') as service_delete,
      has_table_privilege('service_role', c.oid, 'TRUNCATE') as service_truncate,
      exists (
        select 1
          from aclexplode(coalesce(
            c.relacl,
            acldefault((case when c.relkind = 'v' then 'v' else 'r' end)::"char", c.relowner)
          )) a
         where a.grantee = 0
           and a.privilege_type = any($1::text[])
      ) as public_dml
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and (
        c.relname like 'direct_entry_%'
        or c.relname in (
          'recruiters', 'teams', 'recruiter_aliases',
          'recruiter_provider_memberships', 'recruiter_team_memberships'
        )
      )
      and c.relkind in ('r', 'p')
    order by c.relname
  `, [DML_PRIVILEGES]);
  assert.equal(tables.rowCount, 25);
  for (const row of tables.rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname}: RLS disabled`);
    assert.equal(row.relforcerowsecurity, true, `${row.relname}: FORCE RLS disabled`);
    assert.equal(row.public_dml, false, `${row.relname}: PUBLIC table DML`);
    for (const col of [
      "anon_select", "anon_insert", "anon_update", "anon_delete", "anon_truncate",
      "auth_select", "auth_insert", "auth_update", "auth_delete", "auth_truncate",
      "service_select", "service_insert", "service_update", "service_delete", "service_truncate",
    ]) assert.equal(row[col], false, `${row.relname}: ${col}`);
  }
  pass("all 25 W03/shared identity tables force RLS and revoke all table privileges");

  const immutable = await client.query(`
    select count(*)::int n
      from pg_trigger t
      join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace
      join pg_proc p on p.oid=t.tgfoid
     where n.nspname='public'
       and c.relname=any($1::text[])
       and p.proname='direct_entry_reject_immutable_change'
       and t.tgenabled='O' and not t.tgisinternal
  `, [IMMUTABLE_TABLES]);
  assert.equal(immutable.rows[0].n, IMMUTABLE_TABLES.length);
  pass("append-only audit/revision/status/document triggers are installed and enabled");

  const functions = await client.query(`
    select p.oid::regprocedure::text as signature, p.proname, p.prosecdef,
      coalesce(array_to_string(p.proconfig, ','), '') as config,
      coalesce(bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE'), false) as public_exec,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join lateral aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a on true
    where n.nspname = 'public' and p.proname like 'direct_entry_%'
    group by p.oid
    order by p.proname, p.oid
  `);
  assert.ok(functions.rows.every((fn) =>
    !fn.public_exec && !fn.anon_exec && !fn.auth_exec &&
    (!fn.prosecdef || fn.config.includes("search_path="))));
  const callable = functions.rows.filter((fn) => fn.service_exec);
  assert.deepEqual(callable.map((fn) => fn.proname).sort(), EXPECTED_RPC_NAMES);
  const view = await client.query(`
    select has_table_privilege('anon', 'public.direct_entry_current_documents', 'SELECT') anon,
      has_table_privilege('authenticated', 'public.direct_entry_current_documents', 'SELECT') auth,
      has_table_privilege('service_role', 'public.direct_entry_current_documents', 'SELECT') service
  `);
  assert.deepEqual(view.rows[0], { anon: false, auth: false, service: false });
  pass("exact 17 service RPC grants; all helpers private; SECURITY DEFINER search_path pinned");
  pass("current-document view is not client or service-role readable");
}

function codeSuffix(index) {
  const suffix = (parseInt(manifest.namespace.slice(-6), 16) + index)
    .toString().padStart(6, "0").slice(-6);
  return `hrp-2020-${suffix}`;
}

async function fixtureCollisions() {
  const { ids } = manifest;
  action = "fixture collision check for unmapped identity";
  const unmappedUser = await client.query(
    "select count(*)::int n from public.direct_entry_app_users where app_user_id=$1",
    [ids.unmappedAppUserId],
  );
  assert.equal(unmappedUser.rows[0].n, 0, "manifest collision in unmapped app user ID");
  const checks = [
    ["auth.users", "id", ids.authSubjects],
    ["public.direct_entry_app_users", "app_user_id", ids.appUsers],
    ["public.recruiters", "recruiter_id", ids.recruiters],
    ["public.teams", "team_id", ids.teams],
    ["public.direct_entry_projects", "project_id", [ids.projectId]],
    ["public.direct_entry_banks", "bank_id", [ids.bankId]],
  ];
  for (const [table, column, values] of checks) {
    action = `fixture collision check for ${table}`;
    const { rows } = await client.query(
      `select count(*)::int n from ${table} where ${column} = any($1)`,
      [values],
    );
    assert.equal(rows[0].n, 0, `manifest collision in ${table}`);
  }
  action = "fixture collision check for employee codes";
  const codes = [0, 1, 2, 3, 4].map(codeSuffix);
  const { rows } = await client.query(
    "select count(*)::int n from public.direct_entries where employee_code = any($1::text[])",
    [codes],
  );
  assert.equal(rows[0].n, 0, "synthetic employee-code collision");
}

async function seedFixtures() {
  const { ids, namespace } = manifest;
  await fixtureCollisions();
  const authUsers = ids.authSubjects;
  const appUsers = ids.appUsers;
  const caps = [
    ["entry_create", "submission_create", "entry_own", "document_upload", "document_view",
      "payment_view", "pii_view", "audit_view", "employment_status.apply",
      "change_request_create"],
    ["entry_team", "entry_privileged_edit", "payment_edit", "document_upload", "document_view"],
    ["change_review", "change_request_create", "entry_team"],
    ["entry_admin", "entry_privileged_edit", "payment_edit", "document_upload",
      "document_view", "change_review"],
    ["entry_own"],
    ["entry_team", "entry_create", "submission_create"],
    ["entry_team"],
    ["entry_team"],
    ["entry_admin"],
    ["entry_create", "submission_create", "entry_team"],
  ];
  const scopes = [
    ["own", null, "2020-01-01", null],
    ["team", ids.teams[0], "2020-01-01", null],
    ["team", ids.teams[0], "2020-01-01", null],
    ["all", null, "2020-01-01", null],
    ["team", ids.teams[0], "2020-01-01", null],
    ["own", null, "2020-01-01", null],
    ["team", ids.teams[0], "2020-01-01", null],
    ["team", ids.teams[0], "2020-01-01", null],
    ["team", ids.teams[0], "2020-01-01", null],
    ["own", null, "2020-01-01", null],
  ];
  action = "verify exact-cleanup table ownership";
  const ownerRole = await client.query(
    "select current_user = pg_get_userbyid(c.relowner) as owns from pg_class c where c.oid='public.direct_entry_audit_events'::regclass",
  );
  assert.equal(ownerRole.rows[0].owns, true, "test account must own W03 tables for exact cleanup");

  await client.query("begin");
  transactionOpen = true;
  try {
    action = "seed-auth-identities";
    for (const actor of authUsers) {
      await client.query("insert into auth.users(id) values ($1)", [actor]);
    }
    action = "seed-app-user-mappings";
    for (let i = 0; i < appUsers.length; i++) {
      await client.query(
        "insert into public.direct_entry_app_users(app_user_id, auth_subject, enabled) values ($1, $2, $3)",
        [appUsers[i], authUsers[i], i !== 7],
      );
    }
    action = "seed-recruiter-identities";
    for (let i = 0; i < ids.recruiters.length; i++) {
      await client.query(
        "insert into public.recruiters(recruiter_id, display_name) values ($1, $2)",
        [ids.recruiters[i], `${namespace} synthetic recruiter ${i}`],
      );
    }
    action = "seed-team-identities";
    for (let i = 0; i < ids.teams.length; i++) {
      await client.query(
        "insert into public.teams(team_id, code, display_name) values ($1, $2, $3)",
        [ids.teams[i], `${namespace}_TEAM_${i}`, `${namespace} synthetic team ${i}`],
      );
    }
    action = "seed-effective-memberships";
    await client.query(`
      insert into public.recruiter_provider_memberships(recruiter_id, provider_type, valid_from)
      values ($1, 'hrp', '2020-01-01'), ($2, 'hrp', '2020-01-01')
    `, ids.recruiters);
    await client.query(`
      insert into public.recruiter_team_memberships(recruiter_id, team_id, valid_from, valid_to)
      values ($1, $2, '2020-01-01', null),
             ($3, $4, '2020-01-01', '2020-01-15'),
             ($3, $4, '2020-01-15', null)
    `, [ids.recruiters[0], ids.teams[0], ids.recruiters[1], ids.teams[1]]);
    action = "seed-project-bank-references";
    await client.query(
      "insert into public.direct_entry_projects(project_id, display_name) values ($1, $2)",
      [ids.projectId, `${namespace} synthetic project`],
    );
    await client.query(
      "insert into public.direct_entry_banks(bank_id, display_name) values ($1, $2)",
      [ids.bankId, `${namespace} synthetic bank`],
    );
    action = "seed-capability-scope-grants";
    for (let i = 0; i < appUsers.length; i++) {
      for (const capability of caps[i]) {
        const validTo = i === 6 ? "2025-01-01" : null;
        await client.query(`
          insert into public.direct_entry_capability_grants(app_user_id, capability, valid_from, valid_to)
          values ($1, $2, '2020-01-01', $3)
        `, [appUsers[i], capability, validTo]);
      }
      const [scopeKind, teamId, validFrom, validTo] = scopes[i];
      await client.query(`
        insert into public.direct_entry_scope_grants(app_user_id, scope_kind, team_id, valid_from, valid_to)
        values ($1, $2, $3, $4, $5)
      `, [appUsers[i], scopeKind, teamId, validFrom, validTo]);
    }

    const ownerRows = [0, 1, 2].map((index) => ({
        project_id: ids.projectId,
        first_work_date: `2020-01-${String(15 + index).padStart(2, "0")}`,
        employee_code: codeSuffix(index),
        worker_details: {
          display_name: `${namespace} synthetic person ${index}`,
          date_of_birth: { state: "unknown" },
          national_id: { state: "unknown" },
          address: { state: "unknown" },
          phone: { state: "unknown" },
        },
        recruiter_id: ids.recruiters[0],
        labor_type: "TEMPORARY",
      }));
    const batchKey = `${namespace}_BATCH_OWNER`;
    action = "seed-owner-batch";
    manifest.idempotencyKeys.push(batchKey);
    await saveManifest();
    const created = await roleQuery(
      "service_role",
      "select public.direct_entry_create_batch($1, $2, $3::jsonb, $4) as result",
      [authUsers[0], appUsers[0], JSON.stringify(ownerRows), batchKey],
    );
    const batch = created.rows[0].result;
    manifest.ids.submissions.push(batch.submission_id);
    manifest.ids.entries.push(...batch.entry_ids);
    const candidateRows = await client.query(
      "select candidate_id from public.direct_entries where entry_id = any($1::uuid[]) order by employee_code",
      [batch.entry_ids],
    );
    manifest.ids.candidates.push(...candidateRows.rows.map((record) => record.candidate_id));
    manifest.ownerSubmission = batch.submission_id;
    manifest.ownerEntries = batch.entry_ids;
    await saveManifest();

    const ownRow = {
      project_id: ids.projectId,
      first_work_date: "2020-01-15",
      employee_code: codeSuffix(3),
      worker_details: {
        display_name: `${namespace} synthetic own-scope person`,
        date_of_birth: { state: "unknown" },
        national_id: { state: "unknown" },
        address: { state: "unknown" },
        phone: { state: "unknown" },
      },
      recruiter_id: ids.recruiters[0],
      labor_type: "TEMPORARY",
    };
    const secondaryBatchKey = `${namespace}_BATCH_SCOPE`;
    action = "seed-secondary-batch";
    manifest.idempotencyKeys.push(secondaryBatchKey);
    await saveManifest();
    const ownCreated = await roleQuery(
      "service_role",
      "select public.direct_entry_create_batch($1, $2, $3::jsonb, $4) as result",
      [authUsers[9], appUsers[9], JSON.stringify([ownRow]), secondaryBatchKey],
    );
    manifest.secondarySubmission = ownCreated.rows[0].result.submission_id;
    manifest.secondaryEntry = ownCreated.rows[0].result.entry_ids[0];
    manifest.ids.submissions.push(manifest.secondarySubmission);
    manifest.ids.entries.push(manifest.secondaryEntry);
    manifest.ids.candidates.push((await client.query(
      "select candidate_id from public.direct_entries where entry_id=$1",
      [manifest.secondaryEntry],
    )).rows[0].candidate_id);
    await saveManifest();
    await client.query("commit");
    transactionOpen = false;
    fixtureCommitted = true;
    pass("synthetic batch RPC created three-entry batch and isolated own-scope fixture");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    transactionOpen = false;
    throw error;
  }
}

async function transitionSubmission(actorIndex, userIndex, submission, version, target, key) {
  return serviceRpc(
    "select public.direct_entry_transition_submission($1,$2,$3,$4,$5,$6) as result",
    [
      manifest.ids.authSubjects[actorIndex], manifest.ids.appUsers[userIndex],
      submission, version, target, key,
    ],
  );
}

async function updateDraft(actorIndex, userIndex, entry, version, patch, key, c = client) {
  return c.query(
    "select public.direct_entry_update_draft_row($1,$2,$3,$4,$5::jsonb,$6) as result",
    [
      manifest.ids.authSubjects[actorIndex], manifest.ids.appUsers[userIndex],
      entry, version, JSON.stringify(patch), key,
    ],
  );
}

async function entryVersion(entry) {
  return (await client.query(
    "select version from public.direct_entries where entry_id=$1",
    [entry],
  )).rows[0].version;
}

async function paymentVersion(entry) {
  const result = await client.query(
    "select version from public.direct_entry_payments where entry_id=$1",
    [entry],
  );
  return result.rowCount ? result.rows[0].version : 0;
}

async function updatePayment(actorIndex, userIndex, entry, entryV, paymentV, body, reason, key, c = client) {
  const result = await c.query(
    "select public.direct_entry_update_payment($1,$2,$3,$4,$5,$6::jsonb,$7,$8) as result",
    [
      manifest.ids.authSubjects[actorIndex], manifest.ids.appUsers[userIndex],
      entry, entryV, paymentV, JSON.stringify(body), reason, key,
    ],
  );
  return result.rows[0].result;
}

async function createDocument(actorIndex, userIndex, entry, expected, type, key, checksum, reason) {
  const result = await roleQuery("service_role",
    "select public.direct_entry_create_document_metadata($1,$2,$3,$4,$5,$6,$7,512,'image/png',$8) as result",
    [
      manifest.ids.authSubjects[actorIndex], manifest.ids.appUsers[userIndex],
      entry, expected, type, key, checksum, reason,
    ],
  );
  const value = result.rows[0].result;
  if (!manifest.ids.documentIds.includes(value.document_id)) {
    manifest.ids.documentIds.push(value.document_id);
    await saveManifest();
  }
  return value;
}

async function appendDocumentEvent(documentId, version, upload, scan, attempts, key, c = client) {
  const result = c === client
    ? await roleQuery("service_role",
      "select public.direct_entry_append_document_event($1,$2,$3,$4,$5,$6) as result",
      [documentId, version, upload, scan, attempts, key])
    : await c.query(
    "select public.direct_entry_append_document_event($1,$2,$3,$4,$5,$6) as result",
    [documentId, version, upload, scan, attempts, key],
  );
  return result.rows[0].result;
}

async function createChangeRequest(
  items,
  key,
  reason = `${manifest.namespace} synthetic request reason`,
  proposerIndex = 0,
) {
  const result = await serviceRpc(
    "select public.direct_entry_create_change_request($1,$2,$3::jsonb,$4,$5) as result",
    [
      manifest.ids.authSubjects[proposerIndex], manifest.ids.appUsers[proposerIndex],
      JSON.stringify(items), reason, key,
    ],
  );
  if (!manifest.ids.changeRequestIds.includes(result.request_id)) {
    manifest.ids.changeRequestIds.push(result.request_id);
    await saveManifest();
  }
  return result;
}

async function readProjection(actorIndex, userIndex, entry) {
  return serviceRpc(
    "select public.direct_entry_read_projection($1,$2,$3) as result",
    [manifest.ids.authSubjects[actorIndex], manifest.ids.appUsers[userIndex], entry],
  );
}

async function setSubmissionState(target, key) {
  const { ownerSubmission } = manifest;
  const state = await client.query(
    "select state, version from public.direct_entry_submissions where submission_id=$1",
    [ownerSubmission],
  );
  return transitionSubmission(
    0, 0, ownerSubmission, state.rows[0].version, target, key,
  );
}

async function runAuthorizationProbes() {
  const entries = manifest.ownerEntries;
  const ownEntry = manifest.secondaryEntry;
  const patch = { labor_type: "PERMANENT" };
  await updateDraft(0, 0, entries[0], await entryVersion(entries[0]), patch, idempotencyKey("OWN_ALLOW"));
  await updateDraft(1, 1, entries[0], await entryVersion(entries[0]), patch, idempotencyKey("TEAM_ALLOW"));
  await updateDraft(3, 3, entries[0], await entryVersion(entries[0]), patch, idempotencyKey("ALL_ALLOW"));
  pass("own/team/all scopes allow matching entry actions");

  for (const [actor, user, entry, label] of [
    [4, 4, entries[0], "entry_own capability cannot substitute a team-scoped grant"],
    [4, 4, entries[0], "entry_own capability cannot substitute an all-scoped grant"],
    [5, 5, ownEntry, "entry_team capability cannot substitute an own-scoped grant"],
    [8, 8, entries[0], "entry_admin capability cannot substitute a team-scoped grant"],
  ]) {
    await expectDenied(label, async () => updateDraft(
      actor, user, entry, await entryVersion(entry), patch, idempotencyKey("SCOPE_DENY"),
    ), /draft scope\/capability denied/i);
  }
  await expectDenied(
    "expired capability denied using HCMC authorization date",
    async () => updateDraft(6, 6, entries[0], await entryVersion(entries[0]), patch,
      idempotencyKey("CAP_EXPIRED")),
    /draft scope\/capability denied/i,
  );
  await expectDenied(
    "disabled actor mapping denied",
    async () => updateDraft(7, 7, entries[0], await entryVersion(entries[0]), patch,
      idempotencyKey("ACTOR_DISABLED")),
    /actor mapping denied/i,
  );
  await expectDenied(
    "missing actor mapping denied",
    async () => serviceRpc(
      "select public.direct_entry_update_draft_row($1,$2,$3,$4,$5::jsonb,$6)",
      [manifest.ids.authSubjects[0], manifest.ids.unmappedAppUserId, entries[0],
        await entryVersion(entries[0]), JSON.stringify(patch), idempotencyKey("ACTOR_MISSING")],
    ),
    /actor mapping denied|draft scope\/capability denied/i,
  );
  await expectDenied(
    "mismatched actor/app-user mapping denied",
    async () => updateDraft(1, 0, entries[0], await entryVersion(entries[0]), patch,
      idempotencyKey("ACTOR_MISMATCH")),
    /actor mapping denied/i,
  );
  await expectDenied(
    "malformed actor UUID rejected",
    () => roleQuery(
      "service_role",
      "select public.direct_entry_transition_submission($1,$2,$3,1,'REVIEW',$4)",
      ["not-a-uuid", manifest.ids.appUsers[0], manifest.ownerSubmission,
        idempotencyKey("ACTOR_MALFORMED")],
    ),
    /invalid input syntax for type uuid/i,
  );
  await expectDenied(
    "client authority fields rejected",
    async () => updateDraft(0, 0, entries[0], await entryVersion(entries[0]), {
      owner_user_id: manifest.ids.appUsers[3],
    }, idempotencyKey("FORGED_OWNER")),
    /authority field forbidden|invalid draft patch/i,
  );
  for (const [field, value] of [
    ["role", "admin"],
    ["capability", "entry_admin"],
    ["scope", "all"],
    ["auth_subject", manifest.ids.authSubjects[3]],
  ]) {
    await expectDenied(
      `forged ${field} authority rejected`,
      async () => updateDraft(0, 0, entries[0], await entryVersion(entries[0]), {
        [field]: value,
      }, idempotencyKey(`FORGED_${field.toUpperCase()}`)),
      /authority field forbidden|invalid draft patch/i,
    );
  }
  await expectDenied(
    "capability cannot substitute for matching own-scope capability",
    async () => updateDraft(9, 9, ownEntry, await entryVersion(ownEntry), patch,
      idempotencyKey("CAPABILITY_SCOPE_MISMATCH")),
    /draft scope\/capability denied/i,
  );
  await expectDenied(
    "destination recruiter membership must be active on resource date",
    async () => updateDraft(0, 0, entries[0], await entryVersion(entries[0]), {
      recruiter_id: manifest.ids.recruiters[1],
      first_work_date: "2019-12-31",
    }, idempotencyKey("DESTINATION_MEMBERSHIP_EXPIRED")),
    /team membership denied|provider membership denied/i,
  );

  await expectDenied(
    "overlapping scope grant rejected",
    () => client.query(`
      insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from)
      values ($1,'team',$2,'2025-01-01')
    `, [manifest.ids.appUsers[1], manifest.ids.teams[0]]),
    /overlap/i,
  );
  await expectDenied(
    "overlapping capability grant rejected",
    () => client.query(`
      insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)
      values ($1,'entry_team','2024-01-01')
    `, [manifest.ids.appUsers[1]]),
    /overlap/i,
  );
  await expectDenied(
    "overlapping effective team membership rejected",
    () => client.query(`
      insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from)
      values ($1,$2,'2025-01-01')
    `, [manifest.ids.recruiters[1], manifest.ids.teams[1]]),
    /overlap/i,
  );
  await client.query(`
    insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from)
    values ($1,'entry_team','2025-01-01')
  `, [manifest.ids.appUsers[6]]);
  const adjacentGrant = await client.query(`
    select count(*)::int n from public.direct_entry_capability_grants
     where app_user_id=$1 and capability='entry_team'
       and daterange(valid_from,valid_to,'[)') && daterange('2025-01-01','2025-01-02','[)')
  `, [manifest.ids.appUsers[6]]);
  assert.equal(adjacentGrant.rows[0].n, 1);
  pass("overlapping grants/memberships reject; adjacent HCMC grant intervals are half-open");
  const adjacent = await client.query(`
    select count(*)::int n
      from public.recruiter_team_memberships
     where recruiter_id=$1 and team_id=$2
       and daterange(valid_from,valid_to,'[)') && daterange('2020-01-15','2020-01-16','[)')
  `, [manifest.ids.recruiters[1], manifest.ids.teams[1]]);
  assert.equal(adjacent.rows[0].n, 1);
  pass("adjacent half-open recruiter membership boundary resolves exactly once");

  const paymentEntry = entries[2];
  const paymentReason = `${manifest.namespace} synthetic payment state`;
  await expectDenied(
    "provided payment requires all account fields and an active bank",
    async () => updatePayment(
      0, 0, paymentEntry, await entryVersion(paymentEntry), 0,
      {
        state: "provided",
        account_number: null,
        bank_id: manifest.ids.bankId,
        account_holder_name: null,
      },
      paymentReason, idempotencyKey("PAYMENT_INCOMPLETE"),
    ),
    /check constraint|direct_entry_payments_check/i,
  );
  for (const [index, state] of ["omitted", "unknown", "intentionally_blank"].entries()) {
    const result = await updatePayment(
      0, 0, paymentEntry, await entryVersion(paymentEntry), index,
      { state, account_number: null, bank_id: null, account_holder_name: null },
      paymentReason, idempotencyKey(`PAYMENT_${state.toUpperCase()}`),
    );
    assert.equal(result.payment_version, index + 1);
  }
  const provided = await updatePayment(
    0, 0, paymentEntry, await entryVersion(paymentEntry), 3,
    {
      state: "provided",
      account_number: `${manifest.namespace}_ACCOUNT`,
      bank_id: manifest.ids.bankId,
      account_holder_name: `${manifest.namespace} synthetic account holder`,
    },
    paymentReason, idempotencyKey("PAYMENT_PROVIDED"),
  );
  assert.equal(provided.payment_version, 4);
  pass("payment omitted/unknown/intentionally_blank/provided states remain distinct and validate");
}

async function runLiveRoleProbes() {
  const entry = manifest.ownerEntries[0];
  const { authSubjects, appUsers } = manifest.ids;
  await client.query("begin");
  transactionOpen = true;
  try {
    for (const role of ["anon", "authenticated"]) {
      await expectDenied(
        `${role} cannot SELECT W03 table`,
        () => roleQuery(role, "select * from public.direct_entries limit 1"),
        /permission denied/i,
      );
      await expectDenied(
        `${role} cannot read current-document view`,
        () => roleQuery(role, "select * from public.direct_entry_current_documents limit 1"),
        /permission denied/i,
      );
      await expectDenied(
        `${role} cannot call restricted read RPC`,
        () => roleQuery(role,
          "select public.direct_entry_read_projection($1,$2,$3)",
          [authSubjects[0], appUsers[0], entry]),
        /permission denied/i,
      );
      await expectDenied(
        `${role} cannot call uploader RPC`,
        () => roleQuery(role,
          "select public.direct_entry_append_document_event(null,null,null,null,null,null)"),
        /permission denied/i,
      );
      await expectDenied(
        `${role} cannot INSERT W03 table`,
        () => roleQuery(role, "insert into public.direct_entry_candidates default values"),
        /permission denied/i,
      );
      await expectDenied(
        `${role} cannot UPDATE W03 table`,
        () => roleQuery(role,
          "update public.direct_entries set version=version+1 where entry_id=$1",
          [entry]),
        /permission denied/i,
      );
      await expectDenied(
        `${role} cannot DELETE W03 table`,
        () => roleQuery(role, "delete from public.direct_entries where entry_id=$1", [entry]),
        /permission denied/i,
      );
    }
    for (const [label, sql, args] of [
      ["SELECT", "select * from public.direct_entries limit 1", []],
      ["INSERT", "insert into public.direct_entry_candidates default values", []],
      ["UPDATE", "update public.direct_entries set version=version+1 where entry_id=$1", [entry]],
      ["DELETE", "delete from public.direct_entries where entry_id=$1", [entry]],
    ]) {
      await expectDenied(
        `service_role cannot direct ${label} W03 table`,
        () => roleQuery("service_role", sql, args),
        /permission denied/i,
      );
    }
    await client.query("rollback");
    transactionOpen = false;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    transactionOpen = false;
    throw error;
  }
}

async function runConcurrentProbes() {
  const entries = manifest.ownerEntries;
  const clients = [];
  try {
    for (let i = 0; i < 2; i++) {
      const cfg = await loadSupabaseConfig();
      const c = new pg.Client({ connectionString: cfg.databaseUrl, ssl: buildSslOptions() });
      await c.connect();
      await c.query("set role service_role");
      clients.push(c);
    }
    const startVersion = await entryVersion(entries[0]);
    const keyA = idempotencyKey("OCC_RACE_A");
    const keyB = idempotencyKey("OCC_RACE_B");
    await saveManifest();
    const race = await Promise.allSettled([
      updateDraft(0, 0, entries[0], startVersion, { labor_type: "TEMPORARY" }, keyA, clients[0]),
      updateDraft(0, 0, entries[0], startVersion, { labor_type: "PERMANENT" }, keyB, clients[1]),
    ]);
    assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(race.filter((result) => result.status === "rejected" &&
      /version conflict/i.test(String(result.reason?.message))).length, 1);
    assert.equal(await entryVersion(entries[0]), startVersion + 1);
    pass("concurrent different-key OCC race: one mutation, one stale denial");

    const paymentEntry = entries[1];
    const ev = await entryVersion(paymentEntry);
    const pv = await paymentVersion(paymentEntry);
    const body = {
      state: "provided",
      account_number: `${manifest.namespace}_SYNTHETIC_ACCOUNT`,
      bank_id: manifest.ids.bankId,
      account_holder_name: `${manifest.namespace} synthetic holder`,
    };
    const sameKey = idempotencyKey("PAYMENT_SAME_KEY");
    await saveManifest();
    const before = await client.query(`
      select
        (select count(*)::int from public.direct_entry_revisions where entry_id=$1) revisions,
        (select count(*)::int from public.direct_entry_audit_events where resource_ref=$1::text) audits
    `, [paymentEntry]);
    const same = await Promise.all(clients.map((c) =>
      updatePayment(0, 0, paymentEntry, ev, pv, body,
        `${manifest.namespace} synthetic reason`, sameKey, c)));
    assert.deepEqual(same[0], same[1]);
    const after = await client.query(`
      select
        (select count(*)::int from public.direct_entry_revisions where entry_id=$1) revisions,
        (select count(*)::int from public.direct_entry_audit_events where resource_ref=$1::text) audits,
        (select count(*)::int from public.direct_entry_payments where entry_id=$1) payments
    `, [paymentEntry]);
    assert.equal(after.rows[0].revisions - before.rows[0].revisions, 1);
    assert.equal(after.rows[0].audits - before.rows[0].audits, 1);
    assert.equal(after.rows[0].payments, 1);
    pass("concurrent same-key/same-payload replay created one logical payment mutation");
    await expectDenied(
      "same idempotency key with different payload rejected",
      async () => updatePayment(0, 0, paymentEntry, ev, pv, { state: "unknown" },
        `${manifest.namespace} synthetic reason`, sameKey),
      /idempotency key reused/i,
    );
    await expectDenied(
      "missing expected version rejected",
      async () => updatePayment(0, 0, paymentEntry, null, 1, { state: "unknown" },
        `${manifest.namespace} synthetic reason`, idempotencyKey("VERSION_MISSING")),
      /version conflict|required/i,
    );
    await expectDenied(
      "stale entry version rejected after concurrent mutation",
      async () => updatePayment(
        0, 0, paymentEntry, ev, pv + 1,
        { state: "intentionally_blank", account_number: null, bank_id: null, account_holder_name: null },
        `${manifest.namespace} stale version`, idempotencyKey("VERSION_STALE"),
      ),
      /entry version conflict/i,
    );
    await expectDenied(
      "malformed expected version rejected",
      async () => updatePayment(
        0, 0, paymentEntry, "not-an-integer", pv + 1,
        { state: "intentionally_blank", account_number: null, bank_id: null, account_holder_name: null },
        `${manifest.namespace} malformed version`, idempotencyKey("VERSION_MALFORMED"),
      ),
      /invalid input syntax for type integer/i,
    );
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
  }
}

async function runChangeAndPrivilegedProbes() {
  const entries = manifest.ownerEntries;
  const submission = manifest.ownerSubmission;
  await client.query("begin");
  transactionOpen = true;
  try {
    action = "change-request submit lifecycle";
    const submissionRow = await client.query(
      "select version from public.direct_entry_submissions where submission_id=$1",
      [submission],
    );
    let submissionVersion = submissionRow.rows[0].version;
    const review = await transitionSubmission(
      0, 0, submission, submissionVersion++, "REVIEW", idempotencyKey("CR_REVIEW"),
    );
    const submitted = await transitionSubmission(
      0, 0, submission, submissionVersion, "SUBMITTED", idempotencyKey("CR_SUBMIT"),
    );
    assert.equal(review.state, "REVIEW");
    assert.equal(submitted.state, "SUBMITTED");

    action = "create and withdraw change request";
    const ev = await entryVersion(entries[0]);
    const canonicalBeforeRequest = await client.query(
      "select labor_type from public.direct_entries where entry_id=$1",
      [entries[0]],
    );
    action = "create change request for withdrawal";
    const request = await createChangeRequest([{
      entry_id: entries[0],
      target_kind: "ENTRY_FIELD",
      expected_version: ev,
      proposal: { labor_type: "PERMANENT" },
    }], idempotencyKey("CR_WITHDRAW_CREATE"));
    action = "assert pending request does not mutate canonical entry";
    assert.equal((await client.query(
      "select labor_type from public.direct_entries where entry_id=$1",
      [entries[0]],
    )).rows[0].labor_type, canonicalBeforeRequest.rows[0].labor_type);
    action = "withdraw pending change request";
    await serviceRpc(
      "select public.direct_entry_withdraw_change_request($1,$2,$3,1,$4) as result",
      [manifest.ids.authSubjects[0], manifest.ids.appUsers[0], request.request_id,
        idempotencyKey("CR_WITHDRAW")],
    );
    action = "verify withdrawn request state";
    assert.equal((await client.query(
      "select state from public.direct_entry_change_requests where request_id=$1",
      [request.request_id],
    )).rows[0].state, "WITHDRAWN");

    action = "reject change request";
    const rejectReq = await createChangeRequest([{
      entry_id: entries[0], target_kind: "ENTRY_FIELD", expected_version: ev,
      proposal: { labor_type: "TEMPORARY" },
    }], idempotencyKey("CR_REJECT_CREATE"));
    await serviceRpc(
      "select public.direct_entry_reject_change_request($1,$2,$3,1,$4,$5) as result",
      [manifest.ids.authSubjects[2], manifest.ids.appUsers[2], rejectReq.request_id,
        `${manifest.namespace} synthetic reject`, idempotencyKey("CR_REJECT")],
    );
    const rejected = await client.query(
      "select state,decided_by_user_id,decided_at,decision_reason_id from public.direct_entry_change_requests where request_id=$1",
      [rejectReq.request_id],
    );
    assert.equal(rejected.rows[0].state, "REJECTED");
    assert.equal(rejected.rows[0].decided_by_user_id, manifest.ids.appUsers[2]);
    assert.ok(rejected.rows[0].decided_at);
    assert.ok(rejected.rows[0].decision_reason_id);

    const selfReviewReq = await createChangeRequest([{
      entry_id: entries[0], target_kind: "ENTRY_FIELD", expected_version: ev,
      proposal: { labor_type: "PERMANENT" },
    }], idempotencyKey("CR_SELF_REVIEW_CREATE"),
    `${manifest.namespace} synthetic self-review`, 2);
    await expectDenied(
      "change request proposer cannot approve own request",
      () => serviceRpc(
        "select public.direct_entry_approve_change_request($1,$2,$3,1,$4,$5)",
        [manifest.ids.authSubjects[2], manifest.ids.appUsers[2], selfReviewReq.request_id,
          `${manifest.namespace} synthetic self-review`, idempotencyKey("CR_SELF_REVIEW")],
      ),
      /proposer cannot review own request/i,
    );
    assert.equal((await client.query(
      "select state from public.direct_entry_change_requests where request_id=$1",
      [selfReviewReq.request_id],
    )).rows[0].state, "PENDING");

    action = "approve multi-entry change request";
    const versions = [];
    for (const entry of entries.slice(0, 2)) versions.push(await entryVersion(entry));
    const approvedReq = await createChangeRequest(entries.slice(0, 2).map((entry, index) => ({
      entry_id: entry, target_kind: "ENTRY_FIELD", expected_version: versions[index],
      proposal: { labor_type: index === 0 ? "TEMPORARY" : "PERMANENT" },
    })), idempotencyKey("CR_APPROVE_CREATE"));
    await serviceRpc(
      "select public.direct_entry_approve_change_request($1,$2,$3,1,$4,$5) as result",
      [manifest.ids.authSubjects[2], manifest.ids.appUsers[2], approvedReq.request_id,
        `${manifest.namespace} synthetic approval`, idempotencyKey("CR_APPROVE")],
    );
    const approved = await client.query(
      "select state,decided_by_user_id,decided_at,decision_reason_id from public.direct_entry_change_requests where request_id=$1",
      [approvedReq.request_id],
    );
    assert.equal(approved.rows[0].state, "APPROVED");
    assert.equal(approved.rows[0].decided_by_user_id, manifest.ids.appUsers[2]);
    assert.ok(approved.rows[0].decided_at);
    assert.ok(approved.rows[0].decision_reason_id);
    const approvedValues = await client.query(
      "select entry_id,labor_type from public.direct_entries where entry_id=any($1::uuid[]) order by entry_id",
      [entries.slice(0, 2)],
    );
    const approvedByEntry = new Map(approvedValues.rows.map((row) => [row.entry_id, row.labor_type]));
    assert.equal(approvedByEntry.get(entries[0]), "TEMPORARY");
    assert.equal(approvedByEntry.get(entries[1]), "PERMANENT");
    pass("change request create/withdraw/reject and multi-entry approval lifecycle");

    action = "stale multi-entry approval rollback";
    const staleVersions = [];
    for (const entry of entries.slice(1, 3)) staleVersions.push(await entryVersion(entry));
    action = "create stale multi-entry request";
    const staleReq = await createChangeRequest(entries.slice(1, 3).map((entry, index) => ({
      entry_id: entry, target_kind: "ENTRY_FIELD", expected_version: staleVersions[index],
      proposal: { labor_type: "PERMANENT" },
    })), idempotencyKey("CR_STALE_CREATE"));
    const unchangedFirst = await entryVersion(entries[1]);
    action = "bump second item version under privileged boundary";
    await serviceRpc(
      "select public.direct_entry_privileged_edit($1,$2,$3,$4,$5::jsonb,$6,$7) as result",
      [manifest.ids.authSubjects[3], manifest.ids.appUsers[3], entries[2],
        staleVersions[1], JSON.stringify({ labor_type: "TEMPORARY" }),
        `${manifest.namespace} synthetic privileged`, idempotencyKey("CR_STALE_BUMP")],
    );
    action = "deny stale multi-entry approval";
    await expectDenied(
      "stale multi-row approval denied atomically",
      () => serviceRpc(
        "select public.direct_entry_approve_change_request($1,$2,$3,1,$4,$5) as result",
        [manifest.ids.authSubjects[2], manifest.ids.appUsers[2], staleReq.request_id,
          `${manifest.namespace} synthetic stale approval`, idempotencyKey("CR_STALE_APPROVE")],
      ),
      /change item version conflict/i,
    );
    action = "verify stale approval first item remained unchanged";
    assert.equal(await entryVersion(entries[1]), unchangedFirst);
    action = "verify stale request remains pending";
    assert.equal((await client.query(
      "select state from public.direct_entry_change_requests where request_id=$1",
      [staleReq.request_id],
    )).rows[0].state, "PENDING");
    pass("stale item did not partially modify multi-entry approval");

    action = "reject out-of-scope destination approval";
    const destinationVersion = await entryVersion(entries[0]);
    const destinationReq = await createChangeRequest([{
      entry_id: entries[0], target_kind: "ENTRY_FIELD",
      expected_version: destinationVersion,
      proposal: { recruiter_id: manifest.ids.recruiters[1] },
    }], idempotencyKey("CR_DESTINATION_CREATE"));
    const beforeDestination = await client.query(
      "select recruiter_id,team_id,version from public.direct_entries where entry_id=$1",
      [entries[0]],
    );
    await expectDenied(
      "change approval destination outside reviewer team denied",
      () => serviceRpc(
        "select public.direct_entry_approve_change_request($1,$2,$3,1,$4,$5) as result",
        [manifest.ids.authSubjects[2], manifest.ids.appUsers[2], destinationReq.request_id,
          `${manifest.namespace} synthetic destination denial`,
          idempotencyKey("CR_DESTINATION_APPROVE")],
      ),
      /resource scope denied/i,
    );
    const afterDestination = await client.query(
      "select recruiter_id,team_id,version from public.direct_entries where entry_id=$1",
      [entries[0]],
    );
    assert.deepEqual(afterDestination.rows[0], beforeDestination.rows[0]);
    assert.equal((await client.query(
      "select state from public.direct_entry_change_requests where request_id=$1",
      [destinationReq.request_id],
    )).rows[0].state, "PENDING");
    pass("out-of-scope destination approval rolls back entry and request");

    action = "privileged submitted mutations";
    const beforePrivileged = await entryVersion(entries[0]);
    const paymentResult = await updatePayment(
      1, 1, entries[0], beforePrivileged, await paymentVersion(entries[0]),
      { state: "intentionally_blank", account_number: null, bank_id: null, account_holder_name: null },
      `${manifest.namespace} synthetic payment reason`, idempotencyKey("SUBMITTED_PRIV_PAYMENT"),
    );
    assert.equal(paymentResult.entry_version, beforePrivileged + 1);
    action = "ordinary submitted payment denial";
    await expectDenied(
      "ordinary submitted direct payment denied",
      async () => updatePayment(
        0, 0, entries[0], await entryVersion(entries[0]), await paymentVersion(entries[0]),
        { state: "intentionally_blank", account_number: null, bank_id: null, account_holder_name: null },
        `${manifest.namespace} reason`, idempotencyKey("SUBMITTED_ORDINARY_PAYMENT"),
      ),
      /capability denied|resource scope denied/i,
    );
    const beforeOrdinaryDraft = await client.query(
      "select labor_type,version from public.direct_entries where entry_id=$1",
      [entries[0]],
    );
    action = "ordinary submitted draft edit denial";
    await expectDenied(
      "ordinary submitted direct draft edit denied",
      () => updateDraft(0, 0, entries[0], beforeOrdinaryDraft.rows[0].version,
        { labor_type: "TEMPORARY" }, idempotencyKey("SUBMITTED_ORDINARY_DRAFT")),
      /draft submission is not editable/i,
    );
    assert.deepEqual((await client.query(
      "select labor_type,version from public.direct_entries where entry_id=$1",
      [entries[0]],
    )).rows[0], beforeOrdinaryDraft.rows[0]);
    const beforeDoc = await entryVersion(entries[0]);
    action = "ordinary submitted document denial";
    await expectDenied(
      "ordinary submitted direct document mutation denied",
      async () => createDocument(
        0, 0, entries[0], await entryVersion(entries[0]), "EMPLOYMENT_CONTRACT",
        idempotencyKey("SUBMITTED_ORDINARY_DOCUMENT"), "0".repeat(64),
        `${manifest.namespace} synthetic ordinary document`,
      ),
      /capability denied|resource scope denied/i,
    );
    action = "ordinary actor privileged edit denial";
    await expectDenied(
      "ordinary submitted user cannot call privileged edit",
      async () => serviceRpc(
        "select public.direct_entry_privileged_edit($1,$2,$3,$4,$5::jsonb,$6,$7)",
        [manifest.ids.authSubjects[0], manifest.ids.appUsers[0], entries[0],
          await entryVersion(entries[0]), JSON.stringify({ labor_type: "TEMPORARY" }),
          `${manifest.namespace} unauthorized privileged attempt`,
          idempotencyKey("SUBMITTED_ORDINARY_PRIVILEGED")],
      ),
      /capability denied|resource scope denied/i,
    );
    action = "privileged submitted document mutation";
    const privilegedDoc = await createDocument(
      1, 1, entries[0], beforeDoc, "EMPLOYMENT_CONTRACT",
      idempotencyKey("SUBMITTED_PRIV_DOCUMENT"), "f".repeat(64),
      `${manifest.namespace} synthetic document reason`,
    );
    assert.equal(privilegedDoc.reused, false);
    const beforeAdmin = await entryVersion(entries[0]);
    action = "admin submitted privileged edit";
    const adminResult = await serviceRpc(
      "select public.direct_entry_privileged_edit($1,$2,$3,$4,$5::jsonb,$6,$7) as result",
      [manifest.ids.authSubjects[3], manifest.ids.appUsers[3], entries[0],
        beforeAdmin, JSON.stringify({ labor_type: "PERMANENT" }),
        `${manifest.namespace} synthetic admin reason`, idempotencyKey("SUBMITTED_ADMIN_EDIT")],
    );
    assert.equal(adminResult.version, beforeAdmin + 1);
    const beforeWrongScope = await client.query(
      "select recruiter_id,team_id,version from public.direct_entries where entry_id=$1",
      [entries[0]],
    );
    action = "privileged destination scope denial";
    await expectDenied(
      "privileged destination team outside grant denied",
      () => serviceRpc(
        "select public.direct_entry_privileged_edit($1,$2,$3,$4,$5::jsonb,$6,$7) as result",
        [manifest.ids.authSubjects[1], manifest.ids.appUsers[1], entries[0],
          beforeWrongScope.rows[0].version, JSON.stringify({ recruiter_id: manifest.ids.recruiters[1] }),
          `${manifest.namespace} synthetic destination denial`, idempotencyKey("PRIV_DESTINATION_DENY")],
      ),
      /resource scope denied/i,
    );
    action = "privileged destination scope rollback";
    assert.deepEqual((await client.query(
      "select recruiter_id,team_id,version from public.direct_entries where entry_id=$1",
      [entries[0]],
    )).rows[0], beforeWrongScope.rows[0]);
    const audit = await serviceRpc(
      "select * from public.direct_entry_read_audit($1,$2,$3,100)",
      [manifest.ids.authSubjects[0], manifest.ids.appUsers[0], entries[0]],
    );
    assert.ok(audit.some((row) => row.reason_id && row.revision_id));
    assert.ok(audit.every((row) => !("reason_text" in row) && !("account_number" in row)));
    pass("submitted privileged edits require capability/reason/version and write revision/audit");
    pass("audit projection contains references/fields, not raw reason or payment data");
  } finally {
    await client.query("rollback");
    transactionOpen = false;
  }
}

async function runLifecycleAndStatusProbes() {
  const { ownerEntries: entries, ownerSubmission: submission } = manifest;
  await client.query("begin");
  transactionOpen = true;
  try {
    let submissionVersion = (await client.query(
      "select version from public.direct_entry_submissions where submission_id=$1",
      [submission],
    )).rows[0].version;
    await transitionSubmission(0, 0, submission, submissionVersion++, "REVIEW", idempotencyKey("REVIEW"));
    await expectDenied(
      "REVIEW payment mutation denied",
      async () => updatePayment(0, 0, entries[2], await entryVersion(entries[2]), 0,
        { state: "intentionally_blank", account_number: null, bank_id: null, account_holder_name: null },
        `${manifest.namespace} reason`, idempotencyKey("REVIEW_PAYMENT")),
      /REVIEW submissions are read-only/i,
    );
    await expectDenied(
      "REVIEW document mutation denied",
      async () => createDocument(0, 0, entries[2], await entryVersion(entries[2]),
        "CCCD_FRONT", idempotencyKey("REVIEW_DOCUMENT"), "a".repeat(64),
        `${manifest.namespace} reason`),
      /REVIEW submissions are read-only/i,
    );
    await expectDenied(
      "REVIEW status mutation denied",
      async () => serviceRpc(
        "select public.direct_entry_apply_employment_status($1,$2,$3,$4,'ON','2020-01-16',null,$5,$6) as result",
        [manifest.ids.authSubjects[0], manifest.ids.appUsers[0], entries[2],
          await entryVersion(entries[2]), `${manifest.namespace} reason`,
          idempotencyKey("REVIEW_STATUS")],
      ),
      /REVIEW submissions are read-only/i,
    );
    await transitionSubmission(0, 0, submission, submissionVersion++, "DRAFT", idempotencyKey("BACK_TO_DRAFT"));
    const beforeNoop = await client.query(
      "select state,version from public.direct_entry_submissions where submission_id=$1",
      [submission],
    );
    await expectDenied(
      "DRAFT-to-DRAFT submission no-op denied",
      () => transitionSubmission(
        0, 0, submission, beforeNoop.rows[0].version, "DRAFT",
        idempotencyKey("SUBMISSION_NOOP"),
      ),
      /submission transition cannot be a no-op/i,
    );
    const afterNoop = await client.query(
      "select state,version from public.direct_entry_submissions where submission_id=$1",
      [submission],
    );
    assert.deepEqual(afterNoop.rows[0], beforeNoop.rows[0]);
    await expectDenied(
      "invalid direct DRAFT to SUBMITTED transition denied",
      async () => transitionSubmission(0, 0, submission, submissionVersion, "SUBMITTED",
        idempotencyKey("INVALID_DRAFT_SUBMIT")),
      /invalid submission mutation|invalid input|state/i,
    );

    const entry = entries[2];
    const initial = await client.query(
      "select status,effective_date,version,supersedes_event_id from public.direct_entry_employment_status_events where entry_id=$1 order by version",
      [entry],
    );
    assert.equal(initial.rows[0].status, "UNCONFIRMED");
    const startVersion = await entryVersion(entry);
    const on = await serviceRpc(
      "select public.direct_entry_apply_employment_status($1,$2,$3,$4,'ON',$5::date,null,$6,$7) as result",
      [manifest.ids.authSubjects[0], manifest.ids.appUsers[0], entry, startVersion,
        "2020-01-18", `${manifest.namespace} status reason`, idempotencyKey("STATUS_ON")],
    );
    await expectDenied(
      "status no-op denied",
      async () => serviceRpc(
        "select public.direct_entry_apply_employment_status($1,$2,$3,$4,'ON','2020-01-18',null,$5,$6) as result",
        [manifest.ids.authSubjects[0], manifest.ids.appUsers[0], entry, on.entry_version,
          `${manifest.namespace} reason`, idempotencyKey("STATUS_NOOP")],
      ),
      /invalid employment status transition/i,
    );
    await expectDenied(
      "status before first work date denied",
      async () => serviceRpc(
        "select public.direct_entry_apply_employment_status($1,$2,$3,$4,'OFF','2020-01-14','leave',$5,$6) as result",
        [manifest.ids.authSubjects[0], manifest.ids.appUsers[0], entry, on.entry_version,
          `${manifest.namespace} reason`, idempotencyKey("STATUS_BEFORE_START")],
      ),
      /status effective date is outside the allowed interval/i,
    );
    await expectDenied(
      "future status effective date denied",
      async () => serviceRpc(
        "select public.direct_entry_apply_employment_status($1,$2,$3,$4,'OFF','2999-01-01','leave',$5,$6) as result",
        [manifest.ids.authSubjects[0], manifest.ids.appUsers[0], entry, on.entry_version,
          `${manifest.namespace} reason`, idempotencyKey("STATUS_FUTURE")],
      ),
      /status transition date must be current or backdated to latest status/i,
    );
    await expectDenied(
      "OFF leave reason trim validation enforced",
      async () => serviceRpc(
        "select public.direct_entry_apply_employment_status($1,$2,$3,$4,'OFF','2020-01-18','   ',$5,$6) as result",
        [manifest.ids.authSubjects[0], manifest.ids.appUsers[0], entry, on.entry_version,
          `${manifest.namespace} reason`, idempotencyKey("STATUS_EMPTY_LEAVE")],
      ),
      /leave reason|status event|employment_status_events/i,
    );
    const off = await serviceRpc(
      "select public.direct_entry_apply_employment_status($1,$2,$3,$4,'OFF','2020-01-18','Synthetic leave',$5,$6) as result",
      [manifest.ids.authSubjects[0], manifest.ids.appUsers[0], entry, on.entry_version,
        `${manifest.namespace} reason`, idempotencyKey("STATUS_OFF")],
    );
    const backdated = await serviceRpc(
      "select public.direct_entry_apply_employment_status($1,$2,$3,$4,'ON','2020-01-18',null,$5,$6) as result",
      [manifest.ids.authSubjects[0], manifest.ids.appUsers[0], entry, off.entry_version,
        `${manifest.namespace} reason`, idempotencyKey("STATUS_BACKDATED_ON")],
    );
    const correction = await serviceRpc(
      "select public.direct_entry_correct_latest_status($1,$2,$3,$4,4,'OFF','2020-01-18','Synthetic corrected leave',$5,$6) as result",
      [manifest.ids.authSubjects[0], manifest.ids.appUsers[0], entry, backdated.entry_version,
        `${manifest.namespace} correction`, idempotencyKey("STATUS_CORRECTION")],
    );
    const events = await client.query(
      "select event_id,status,version,supersedes_event_id from public.direct_entry_employment_status_events where entry_id=$1 order by version",
      [entry],
    );
    assert.equal(events.rows.length, 5);
    assert.equal(events.rows[1].supersedes_event_id, null);
    assert.equal(events.rows[2].status, "OFF");
    assert.equal(events.rows[2].supersedes_event_id, null);
    assert.equal(events.rows[3].status, "ON");
    assert.equal(events.rows[3].supersedes_event_id, null);
    assert.equal(events.rows[4].supersedes_event_id, events.rows[3].event_id);
    assert.equal(correction.status, "OFF");
    await expectDenied(
      "status correction cannot supersede an older non-latest event",
      () => serviceRpc(
        "select public.direct_entry_correct_latest_status($1,$2,$3,$4,3,'ON','2020-01-18',null,$5,$6)",
        [manifest.ids.authSubjects[0], manifest.ids.appUsers[0], entry,
          correction.entry_version, `${manifest.namespace} stale correction`,
          idempotencyKey("STATUS_CORRECT_OLD_EVENT")],
      ),
      /status version conflict/i,
    );
    pass("status matrix, valid backdate, OFF required fields, and latest-only correction");
  } finally {
    await client.query("rollback");
    transactionOpen = false;
  }
}

async function runDocumentProbes() {
  await client.query("begin");
  transactionOpen = true;
  try {
    action = "document retry and metadata";
    const entry = manifest.ownerEntries[0];
    const actor = manifest.ids.authSubjects[0];
    const user = manifest.ids.appUsers[0];
    const paymentBody = {
      state: "provided",
      account_number: `${manifest.namespace}_MASKED_ACCOUNT`,
      bank_id: manifest.ids.bankId,
      account_holder_name: `${manifest.namespace} synthetic holder`,
    };
    const payment = await updatePayment(
      0, 0, entry, await entryVersion(entry), 0, paymentBody,
      `${manifest.namespace} synthetic payment reason`, idempotencyKey("PROJECTION_PAYMENT"),
    );
    await serviceRpc(
      "select public.direct_entry_apply_employment_status($1,$2,$3,$4,'OFF','2020-01-15','Synthetic leave reason',$5,$6)",
      [actor, user, entry, payment.entry_version,
        `${manifest.namespace} synthetic status reason`, idempotencyKey("PROJECTION_STATUS")],
    );
    let version = await entryVersion(entry);
    const revCount = async () => (await client.query(
      "select count(*)::int n from public.direct_entry_revisions where entry_id=$1",
      [entry],
    )).rows[0].n;
    const auditCount = async () => (await client.query(
      "select count(*)::int n from public.direct_entry_audit_events where resource_ref=$1",
      [entry],
    )).rows[0].n;
    const before = { version, revisions: await revCount(), audits: await auditCount() };
    const docKey1 = idempotencyKey("DOC_V1");
    const checksum1 = "a".repeat(64);
    const first = await createDocument(0, 0, entry, version, "CCCD_FRONT", docKey1,
      checksum1, `${manifest.namespace} metadata reason`);
    await saveManifest();
    const entryAfter = await entryVersion(entry);
    const replaySameActor = await createDocument(0, 0, entry, version, "CCCD_FRONT",
      docKey1, checksum1, `${manifest.namespace} metadata reason`);
    assert.deepEqual(replaySameActor, first);
    assert.equal(await entryVersion(entry), entryAfter);
    assert.equal(await revCount(), before.revisions + 1);
    assert.equal(await auditCount(), before.audits + 1);
    const crossActor = await createDocument(1, 1, entry, entryAfter, "CCCD_FRONT",
      docKey1, checksum1, `${manifest.namespace} retry reason`);
    assert.equal(crossActor.reused, true);
    assert.equal(crossActor.entry_version, entryAfter);
    await expectDenied(
      "document retry with different content rejected",
      () => createDocument(0, 0, entry, entryAfter, "CCCD_FRONT", docKey1,
        "9".repeat(64), `${manifest.namespace} changed retry`),
      /idempotency key reused/i,
    );
    pass("same-content same/cross-actor document retry reuses without another mutation");

    const documentRows = await client.query(
      "select candidate_id,storage_key,version,checksum_sha256 from public.direct_entry_document_versions where document_id=$1",
      [first.document_id],
    );
    assert.match(documentRows.rows[0].storage_key,
      new RegExp(`^p1\\.6/${documentRows.rows[0].candidate_id}/CCCD_FRONT/1/[0-9a-f-]{36}$`));
    assert.doesNotMatch(documentRows.rows[0].storage_key, /P16G3R1|filename|CCCD_FRONT_/);
    await createDocument(0, 0, entry, entryAfter, "CCCD_BACK", idempotencyKey("DOC_TYPE"),
      "b".repeat(64), `${manifest.namespace} metadata reason`);
    assert.equal(await entryVersion(entry), entryAfter + 1);
    pass("server-generated opaque document storage key and document-type versioning");

    const maskedProjection = await readProjection(2, 2, entry);
    action = "restricted PII/payment/document projection";
    assert.deepEqual(maskedProjection.worker_details, {});
    assert.notEqual(maskedProjection.payment.account_number, paymentBody.account_number);
    assert.ok(maskedProjection.payment.account_number.endsWith(paymentBody.account_number.slice(-4)));
    assert.equal(maskedProjection.documents.length, 0);
    assert.equal("leave_reason_text" in maskedProjection.employment_status, false);
    assert.equal(JSON.stringify(maskedProjection).includes("storage_key"), false);
    assert.equal(JSON.stringify(maskedProjection).includes("checksum_sha256"), false);
    await expectDenied(
      "out-of-scope user cannot read entry projection",
      () => readProjection(4, 4, entry),
      /draft scope\/capability denied/i,
    );
    pass("restricted projection masks PII, bank value, leave reason, document and storage metadata");
    await client.query("rollback");
    transactionOpen = false;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    transactionOpen = false;
    throw error;
  }

  await client.query("begin");
  transactionOpen = true;
  try {
    action = "document current-version lifecycle";
    const entry = manifest.ownerEntries[1];
    const actor = manifest.ids.authSubjects[0];
    const user = manifest.ids.appUsers[0];
    let v = await entryVersion(entry);
    const first = await createDocument(0, 0, entry, v, "CCCD_FRONT",
      idempotencyKey("DOC_CURRENT_V1"), "c".repeat(64), `${manifest.namespace} reason`);
    v = first.entry_version;
    const sendReady = async (docId, prefix) => {
      for (const [eventV, upload, scan] of [
        [1, "UPLOADING", "PENDING"],
        [2, "QUARANTINED", "PENDING"],
        [3, "SCANNING", "PENDING"],
        [4, "READY", "CLEAN"],
      ]) {
        await appendDocumentEvent(docId, eventV, upload, scan, 0,
          await persistedKey(`${prefix}_${eventV}`));
      }
    };
    await expectDenied(
      "uploader rejects invalid QUEUED to READY transition",
      () => appendDocumentEvent(first.document_id, 1, "READY", "CLEAN", 0,
        idempotencyKey("UPLOADER_INVALID_TRANSITION")),
      /invalid document event transition/i,
    );
    await expectDenied(
      "uploader rejects stale event version",
      () => appendDocumentEvent(first.document_id, 0, "UPLOADING", "PENDING", 0,
        idempotencyKey("UPLOADER_STALE_INITIAL")),
      /document event version conflict/i,
    );
    await sendReady(first.document_id, "EVENT_V1");
    const replacement2 = await createDocument(0, 0, entry, v, "CCCD_FRONT",
      idempotencyKey("DOC_PENDING_V2"), "d".repeat(64), `${manifest.namespace} reason`);
    const lineage2 = await client.query(
      "select version,supersedes_document_id from public.direct_entry_document_versions where document_id=$1",
      [replacement2.document_id],
    );
    assert.equal(lineage2.rows[0].version, 2);
    assert.equal(lineage2.rows[0].supersedes_document_id, first.document_id);
    v = replacement2.entry_version;
    let projection = await serviceRpc(
      "select public.direct_entry_read_projection($1,$2,$3) as result",
      [actor, user, entry],
    );
    assert.deepEqual(projection.documents.map((doc) => doc.version), [1]);
    await sendReady(replacement2.document_id, "EVENT_V2");
    projection = await serviceRpc(
      "select public.direct_entry_read_projection($1,$2,$3) as result",
      [actor, user, entry],
    );
    assert.deepEqual(projection.documents.map((doc) => doc.version), [2]);
    const retryStartKey = idempotencyKey("UPLOADER_RETRY_START");
    const retryEntry = manifest.ownerEntries[2];
    const failedDoc = await createDocument(
      0, 0, retryEntry, await entryVersion(retryEntry),
      "CCCD_BACK", idempotencyKey("DOC_RETRY"), "1".repeat(64),
      `${manifest.namespace} retry metadata`);
    const failedDocId = failedDoc.document_id;
    const started = await appendDocumentEvent(
      failedDocId, 1, "UPLOADING", "PENDING", 0, retryStartKey,
    );
    const startedReplay = await appendDocumentEvent(
      failedDocId, 1, "UPLOADING", "PENDING", 0, retryStartKey,
    );
    assert.equal(started.version, 2);
    assert.equal(startedReplay.reused, true);
    const failed = await appendDocumentEvent(
      failedDocId, 2, "FAILED", "REJECTED", 0, idempotencyKey("UPLOADER_FAIL"),
    );
    const retry = await appendDocumentEvent(
      failedDocId, failed.version, "UPLOADING", "PENDING", 1,
      idempotencyKey("UPLOADER_RETRY"),
    );
    assert.equal(retry.attempts, 1);
    await expectDenied(
      "uploader attempts cannot decrease",
      () => appendDocumentEvent(failedDocId, retry.version,
        "QUARANTINED", "PENDING", 0, idempotencyKey("UPLOADER_DECREASE")),
      /attempts cannot decrease|invalid document event transition/i,
    );
    for (const [upload, scan] of [
      ["QUARANTINED", "PENDING"],
      ["SCANNING", "PENDING"],
      ["READY", "CLEAN"],
    ]) {
      action = `uploader retry transition ${upload}`;
      const latest = (await client.query(
        "select version,attempts from public.direct_entry_document_events where document_id=$1 order by version desc limit 1",
        [failedDocId],
      )).rows[0];
      const appended = await appendDocumentEvent(
        failedDocId, latest.version, upload, scan, latest.attempts,
        idempotencyKey(`UPLOADER_${upload}`),
      );
      assert.equal(appended.version, latest.version + 1);
    }
    const replacement3 = await createDocument(0, 0, entry, v, "CCCD_FRONT",
      idempotencyKey("DOC_REJECT_V3"), "e".repeat(64), `${manifest.namespace} reason`);
    const lineage3 = await client.query(
      "select version,supersedes_document_id from public.direct_entry_document_versions where document_id=$1",
      [replacement3.document_id],
    );
    assert.equal(lineage3.rows[0].version, 3);
    assert.equal(lineage3.rows[0].supersedes_document_id, replacement2.document_id);
    const rejected = await appendDocumentEvent(replacement3.document_id, 1,
      "FAILED", "REJECTED", 0, idempotencyKey("DOC_EVENT_REJECT"));
    assert.equal(rejected.version, 2);
    action = "rejected replacement projection fallback";
    projection = await serviceRpc(
      "select public.direct_entry_read_projection($1,$2,$3) as result",
      [actor, user, entry],
    );
    assert.deepEqual(projection.documents.map((doc) => doc.version), [2]);
    const masked = await readProjection(2, 2, entry);
    assert.deepEqual(masked.documents, []);
    pass("pending/rejected versions preserve current clean doc; ready v2 becomes current; restricted projection");
    await client.query("rollback");
    transactionOpen = false;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    transactionOpen = false;
    throw error;
  }
}

async function installFailureTrigger(table, suffix, condition = "true") {
  const stem = `${manifest.namespace.toLowerCase()}_fi_${suffix}`;
  const trigger = `${stem}_trigger`;
  const fn = `pg_temp.${stem}_fn`;
  await client.query(`
    create function ${fn}() returns trigger language plpgsql as $body$
    begin
      if ${condition} then
        raise exception 'P16G3R1 synthetic injected failure' using errcode = 'P0001';
      end if;
      return new;
    end
    $body$
  `);
  await client.query(
    `create trigger ${trigger} before insert on public.${table} for each row execute function ${fn}()`,
  );
  return async () => {
    await client.query(`drop trigger ${trigger} on public.${table}`);
    await client.query(`drop function ${fn}()`);
    const remaining = await client.query(
      "select count(*)::int n from pg_trigger where tgname=$1",
      [trigger],
    );
    assert.equal(remaining.rows[0].n, 0, "failure-injection trigger survived");
  };
}

async function runFailureInjectionProbes() {
  const entries = manifest.ownerEntries;
  await client.query("begin");
  transactionOpen = true;
  try {
    for (const [label, table, suffix] of [
      ["audit", "direct_entry_audit_events", "payment_audit"],
      ["revision", "direct_entry_revisions", "payment_revision"],
    ]) {
      action = `inject ${label} failure in payment mutation`;
      const entry = entries[2];
      const before = await client.query(`
        select e.version,
          (select count(*)::int from public.direct_entry_payments p where p.entry_id=e.entry_id) payments,
          (select count(*)::int from public.direct_entry_revisions r where r.entry_id=e.entry_id) revisions,
          (select count(*)::int from public.direct_entry_audit_events a where a.resource_ref=e.entry_id::text) audits
        from public.direct_entries e where e.entry_id=$1
      `, [entry]);
      const expectedPaymentVersion = await paymentVersion(entry);
      const key = idempotencyKey(`INJECT_${suffix}`);
      const remove = await installFailureTrigger(table, suffix);
      await expectDenied(
        `${label} insert failure rolls payment back`,
        () => updatePayment(
          0, 0, entry, before.rows[0].version, expectedPaymentVersion,
          { state: "intentionally_blank", account_number: null, bank_id: null, account_holder_name: null },
          `${manifest.namespace} injected failure`, key,
        ),
        /P16G3R1 synthetic injected failure/i,
      );
      await remove();
      const after = await client.query(`
        select e.version,
          (select count(*)::int from public.direct_entry_payments p where p.entry_id=e.entry_id) payments,
          (select count(*)::int from public.direct_entry_revisions r where r.entry_id=e.entry_id) revisions,
          (select count(*)::int from public.direct_entry_audit_events a where a.resource_ref=e.entry_id::text) audits,
          (select count(*)::int from public.direct_entry_rpc_idempotency i where i.idempotency_key=$2) idempotency
        from public.direct_entries e where e.entry_id=$1
      `, [entry, key]);
      for (const field of ["version", "payments", "revisions", "audits"]) {
        assert.equal(after.rows[0][field], before.rows[0][field], `${label} failure changed ${field}`);
      }
      assert.equal(after.rows[0].idempotency, 0);
    }

    const statusEntry = entries[2];
    action = "inject audit failure in employment-status mutation";
    const statusBefore = await client.query(`
      select e.version,
        (select count(*)::int from public.direct_entry_employment_status_events s where s.entry_id=e.entry_id) statuses,
        (select count(*)::int from public.direct_entry_revisions r where r.entry_id=e.entry_id) revisions
      from public.direct_entries e where e.entry_id=$1
    `, [statusEntry]);
    const statusKey = idempotencyKey("INJECT_STATUS_AUDIT");
    const removeStatus = await installFailureTrigger(
      "direct_entry_audit_events", "status_audit",
    );
    await expectDenied(
      "audit failure rolls employment status and current projection back",
      () => serviceRpc(
        "select public.direct_entry_apply_employment_status($1,$2,$3,$4,'ON','2020-01-18',null,$5,$6)",
        [manifest.ids.authSubjects[0], manifest.ids.appUsers[0], statusEntry,
          statusBefore.rows[0].version, `${manifest.namespace} injected status`,
          statusKey],
      ),
      /P16G3R1 synthetic injected failure/i,
    );
    await removeStatus();
    const statusAfter = await client.query(`
      select e.version,
        (select count(*)::int from public.direct_entry_employment_status_events s where s.entry_id=e.entry_id) statuses,
        (select count(*)::int from public.direct_entry_revisions r where r.entry_id=e.entry_id) revisions,
        (select count(*)::int from public.direct_entry_rpc_idempotency i where i.idempotency_key=$2) idempotency
      from public.direct_entries e where e.entry_id=$1
    `, [statusEntry, statusKey]);
    assert.equal(statusAfter.rows[0].version, statusBefore.rows[0].version);
    assert.equal(statusAfter.rows[0].statuses, statusBefore.rows[0].statuses);
    assert.equal(statusAfter.rows[0].revisions, statusBefore.rows[0].revisions);
    assert.equal(statusAfter.rows[0].idempotency, 0);

    action = "submit fixture for atomic approval failure test";
    const submissionVersion = (await client.query(
      "select version from public.direct_entry_submissions where submission_id=$1",
      [manifest.ownerSubmission],
    )).rows[0].version;
    await transitionSubmission(
      0, 0, manifest.ownerSubmission, submissionVersion, "REVIEW",
      idempotencyKey("ATOMIC_REVIEW"),
    );
    await transitionSubmission(
      0, 0, manifest.ownerSubmission, submissionVersion + 1, "SUBMITTED",
      idempotencyKey("ATOMIC_SUBMIT"),
    );
    const ordered = await client.query(
      "select entry_id,version,labor_type from public.direct_entries where entry_id=any($1::uuid[]) order by entry_id",
      [entries.slice(0, 2)],
    );
    const change = await createChangeRequest(ordered.rows.map((row) => ({
      entry_id: row.entry_id,
      target_kind: "ENTRY_FIELD",
      expected_version: row.version,
      proposal: { labor_type: row.labor_type === "TEMPORARY" ? "PERMANENT" : "TEMPORARY" },
    })), idempotencyKey("INJECT_ATOMIC_CREATE"));
    action = "inject one-row revision failure in multi-row approval";
    const failureEntry = ordered.rows.at(-1).entry_id;
    const beforeApproval = await client.query(`
      select e.entry_id,e.version,e.labor_type,
        (select count(*)::int from public.direct_entry_revisions r where r.entry_id=e.entry_id) revisions,
        (select count(*)::int from public.direct_entry_audit_events a where a.resource_ref=e.entry_id::text) audits
      from public.direct_entries e where e.entry_id=any($1::uuid[]) order by e.entry_id
    `, [entries.slice(0, 2)]);
    const approvalKey = idempotencyKey("INJECT_ATOMIC_APPROVAL");
    const removeAtomic = await installFailureTrigger(
      "direct_entry_revisions",
      "atomic_revision",
      `new.entry_id = '${failureEntry}'::uuid`,
    );
    await expectDenied(
      "one-row revision failure rolls back the entire multi-row approval",
      () => serviceRpc(
        "select public.direct_entry_approve_change_request($1,$2,$3,1,$4,$5)",
        [manifest.ids.authSubjects[2], manifest.ids.appUsers[2], change.request_id,
          `${manifest.namespace} injected atomic approval`, approvalKey],
      ),
      /P16G3R1 synthetic injected failure/i,
    );
    await removeAtomic();
    const afterApproval = await client.query(`
      select e.entry_id,e.version,e.labor_type,
        (select count(*)::int from public.direct_entry_revisions r where r.entry_id=e.entry_id) revisions,
        (select count(*)::int from public.direct_entry_audit_events a where a.resource_ref=e.entry_id::text) audits
      from public.direct_entries e where e.entry_id=any($1::uuid[]) order by e.entry_id
    `, [entries.slice(0, 2)]);
    assert.deepEqual(afterApproval.rows, beforeApproval.rows);
    const requestState = await client.query(
      "select state from public.direct_entry_change_requests where request_id=$1",
      [change.request_id],
    );
    assert.equal(requestState.rows[0].state, "PENDING");
    const failedApprovalKey = await client.query(
      "select count(*)::int n from public.direct_entry_rpc_idempotency where idempotency_key=$1",
      [approvalKey],
    );
    assert.equal(failedApprovalKey.rows[0].n, 0);
    pass("audit/revision/status/multi-row failure injection rolled back atomically");
    await client.query("rollback");
    transactionOpen = false;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    transactionOpen = false;
    throw error;
  }
}

async function cleanupCommittedFixtures() {
  if (!fixtureCommitted) return;
  await client.query("begin");
  try {
    for (const table of IMMUTABLE_TABLES) {
      await client.query(`alter table public.${table} disable trigger user`);
    }
    const { ids } = manifest;
    const entries = ids.entries;
    const users = ids.appUsers;
    const requests = ids.changeRequestIds;
    await client.query("delete from public.direct_entry_audit_events where app_user_id=any($1::uuid[])", [users]);
    await client.query("delete from public.direct_entry_rpc_idempotency where app_user_id=any($1::uuid[])", [users]);
    await client.query("delete from public.direct_entry_change_request_items where request_id=any($1::uuid[])", [requests]);
    await client.query("delete from public.direct_entry_change_request_revisions where request_id=any($1::uuid[])", [requests]);
    await client.query("delete from public.direct_entry_change_requests where request_id=any($1::uuid[])", [requests]);
    await client.query("delete from public.direct_entry_document_events where document_id=any($1::uuid[])", [ids.documentIds]);
    for (const documentId of [...ids.documentIds].reverse()) {
      await client.query("delete from public.direct_entry_document_versions where document_id=$1", [documentId]);
    }
    for (const entry of entries) {
      const statusEvents = await client.query(
        "select event_id from public.direct_entry_employment_status_events where entry_id=$1 order by version desc",
        [entry],
      );
      for (const { event_id: eventId } of statusEvents.rows) {
        await client.query(
          "delete from public.direct_entry_employment_status_events where event_id=$1",
          [eventId],
        );
      }
    }
    await client.query("delete from public.direct_entry_payments where entry_id=any($1::uuid[])", [entries]);
    await client.query("delete from public.direct_entry_revisions where entry_id=any($1::uuid[])", [entries]);
    await client.query("delete from public.direct_entry_submission_revisions where submission_id=any($1::uuid[])", [ids.submissions]);
    await client.query("delete from public.direct_entries where entry_id=any($1::uuid[])", [entries]);
    await client.query("delete from public.direct_entry_candidates where candidate_id=any($1::uuid[])", [ids.candidates]);
    await client.query("delete from public.direct_entry_submissions where submission_id=any($1::uuid[])", [ids.submissions]);
    await client.query("delete from public.direct_entry_restricted_reasons where actor_user_id=any($1::uuid[])", [users]);
    await client.query("delete from public.direct_entry_capability_grants where app_user_id=any($1::uuid[])", [users]);
    await client.query("delete from public.direct_entry_scope_grants where app_user_id=any($1::uuid[])", [users]);
    await client.query("delete from public.direct_entry_app_user_recruiter_links where app_user_id=any($1::uuid[])", [users]);
    await client.query("delete from public.direct_entry_app_users where app_user_id=any($1::uuid[])", [users]);
    await client.query("delete from public.recruiter_provider_memberships where recruiter_id=any($1::uuid[])", [ids.recruiters]);
    await client.query("delete from public.recruiter_team_memberships where recruiter_id=any($1::uuid[])", [ids.recruiters]);
    await client.query("delete from public.direct_entry_projects where project_id=$1", [ids.projectId]);
    await client.query("delete from public.direct_entry_banks where bank_id=$1", [ids.bankId]);
    await client.query("delete from public.recruiters where recruiter_id=any($1::uuid[])", [ids.recruiters]);
    await client.query("delete from public.teams where team_id=any($1::uuid[])", [ids.teams]);
    await client.query("delete from auth.users where id=any($1::uuid[])", [ids.authSubjects]);
    for (const table of IMMUTABLE_TABLES) {
      await client.query(`alter table public.${table} enable trigger user`);
    }
    await client.query("commit");
    const residue = await client.query(`
      select
        (select count(*) from auth.users where id=any($1::uuid[])) +
        (select count(*) from public.direct_entry_app_users where app_user_id=any($2::uuid[])) +
        (select count(*) from public.direct_entry_app_user_recruiter_links where app_user_id=any($2::uuid[])) +
        (select count(*) from public.direct_entry_capability_grants where app_user_id=any($2::uuid[])) +
        (select count(*) from public.direct_entry_scope_grants where app_user_id=any($2::uuid[])) +
        (select count(*) from public.direct_entry_restricted_reasons where actor_user_id=any($2::uuid[])) +
        (select count(*) from public.recruiters where recruiter_id=any($3::uuid[])) +
        (select count(*) from public.teams where team_id=any($4::uuid[])) +
        (select count(*) from public.recruiter_provider_memberships where recruiter_id=any($3::uuid[])) +
        (select count(*) from public.recruiter_team_memberships where recruiter_id=any($3::uuid[])) +
        (select count(*) from public.direct_entry_projects where project_id=$5) +
        (select count(*) from public.direct_entry_banks where bank_id=$6) +
        (select count(*) from public.direct_entries where entry_id=any($7::uuid[])) +
        (select count(*) from public.direct_entry_candidates where candidate_id=any($8::uuid[])) +
        (select count(*) from public.direct_entry_submissions where submission_id=any($9::uuid[])) +
        (select count(*) from public.direct_entry_payments where entry_id=any($7::uuid[])) +
        (select count(*) from public.direct_entry_employment_status_events where entry_id=any($7::uuid[])) +
        (select count(*) from public.direct_entry_revisions where entry_id=any($7::uuid[])) +
        (select count(*) from public.direct_entry_submission_revisions where submission_id=any($9::uuid[])) +
        (select count(*) from public.direct_entry_document_versions where document_id=any($10::uuid[])) +
        (select count(*) from public.direct_entry_document_events where document_id=any($10::uuid[])) +
        (select count(*) from public.direct_entry_change_requests where request_id=any($11::uuid[])) +
        (select count(*) from public.direct_entry_change_request_items where request_id=any($11::uuid[])) +
        (select count(*) from public.direct_entry_change_request_revisions where request_id=any($11::uuid[])) +
        (select count(*) from public.direct_entry_audit_events where app_user_id=any($2::uuid[])) +
        (select count(*) from public.direct_entry_rpc_idempotency where idempotency_key=any($12::text[])) as n
    `, [
      ids.authSubjects, ids.appUsers, ids.recruiters, ids.teams, ids.projectId,
      ids.bankId, ids.entries, ids.candidates, ids.submissions, ids.documentIds,
      ids.changeRequestIds, manifest.idempotencyKeys,
    ]);
    assert.equal(Number(residue.rows[0].n), 0);
    const codeResidue = await client.query(
      "select count(*)::int n from public.direct_entries where employee_code=any($1::text[])",
      [[0, 1, 2, 3, 4].map(codeSuffix)],
    );
    assert.equal(codeResidue.rows[0].n, 0);
    fixtureCommitted = false;
    manifest.results.cleanupVerified = true;
    pass("exact manifest cleanup verified zero residue");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function run() {
  const config = await loadSupabaseConfig();
  assert.equal(config.projectRef, manifest.expectedProjectRef, "wrong Supabase project; aborting");
  const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  assert.equal(branch, "feature/p1.6-integration");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const isExpectedBase = head === manifest.baseCommit ||
    (() => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", manifest.baseCommit, head]);
        return true;
      } catch {
        return false;
      }
    })();
  assert.ok(isExpectedBase, "HEAD is not based on the approved W03 acceptance commit");
  client = new pg.Client({ connectionString: config.databaseUrl, ssl: buildSslOptions() });
  await client.connect();
  try {
    await verifyMigrationRegistry();
    action = "sanitized baseline and catalog checks";
    const before = await baseline();
    assert.deepEqual(before, manifest.baseline, "sanitized pre-test baseline changed");
    assert.equal(before.directEntryUsers, 0);
    assert.equal(before.directEntryRows, 0);
    manifest.results.preTestBaseline = before;
    await saveManifest();
    pass("read-only reporting/W03 baseline matches approved manifest");
    await verifyCatalogBoundary();
    phase = "fixtures";
    action = "seed fixtures";
    await seedFixtures();
    phase = "role-boundary";
    action = "role boundary probes";
    await runLiveRoleProbes();
    phase = "authorization";
    action = "authorization and payment probes";
    await runAuthorizationProbes();
    phase = "concurrency";
    action = "OCC and idempotency probes";
    await runConcurrentProbes();
    phase = "lifecycle";
    action = "submission and status probes";
    await runLifecycleAndStatusProbes();
    action = "change request and privileged edit probes";
    await runChangeAndPrivilegedProbes();
    phase = "documents";
    action = "document lifecycle probes";
    await runDocumentProbes();
    phase = "failure-injection";
    action = "rollback failure-injection probes";
    await runFailureInjectionProbes();
  } finally {
    if (client?._connected) {
      const beforeCleanup = { phase, action };
      try {
        phase = "cleanup";
        action = "cleanup exact manifest";
        await cleanupCommittedFixtures();
        const after = await baseline();
        assert.deepEqual(after, manifest.baseline, "post-cleanup reporting/W03 baseline changed");
        manifest.results.postCleanupBaseline = after;
        manifest.results.checks = checks;
        await saveManifest();
        pass("post-cleanup reporting baseline matches pre-test values");
      } catch (error) {
        await client.query("rollback").catch(() => {});
        await saveManifest().catch(() => {});
        console.error(`LIVE_ACCEPTANCE_CLEANUP_FAILED phase=${phase} action=${action} code=${error.code ?? "assertion"}; details suppressed`);
        throw error;
      } finally {
        phase = beforeCleanup.phase;
        action = beforeCleanup.action;
        await client.end().catch(() => {});
      }
    }
  }
}

try {
  await run();
  manifest.results.checks = checks;
  await saveManifest();
  console.log(JSON.stringify({
    namespace: manifest.namespace,
    checksPassed: checks.length,
    checks,
    cleanupVerified: manifest.results.cleanupVerified,
    baselineUnchanged: JSON.stringify(manifest.results.preTestBaseline) ===
      JSON.stringify(manifest.results.postCleanupBaseline),
  }, null, 2));
} catch (error) {
  manifest.results.checks = checks;
  await saveManifest().catch(() => {});
  console.error(`LIVE_ACCEPTANCE_FAILED phase=${phase} action=${action} code=${error.code ?? "assertion"}; sensitive details suppressed`);
  process.exitCode = 1;
}
