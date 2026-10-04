#!/usr/bin/env node
/**
 * P1.6-W04-S04C-I02 - live shared-DB acceptance for the own-submission read boundary (migration #32).
 *
 * Everything runs inside ONE outer transaction that is rolled back. Synthetic fixtures only.
 * Afterwards the S01A submission-transition harness is re-run (own transaction + rollback).
 * No R2, no network beyond the shared DB, no deploy.
 *
 * Usage: node --conditions=react-server scripts/p1.6-s04c-submission-read-dev-acceptance.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";

import { expectedDirectEntryFunctions } from "./lib/direct-entry-inventory.mjs";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { readMigrations } from "./lib/migration-validation.mjs";
import {
  ACTORS,
  SUBMISSION_STAMPS,
  createMigratedDatabase,
  listOwnSubmissions,
  readOwnSubmission,
  seedSubmissionReadFixture,
} from "./lib/s04c-submission-read-fixture.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const EXPECTED_SERVICE_RPC_COUNT = 29;
const READ_RPCS = [
  "public.direct_entry_list_own_submissions(uuid,uuid,integer,text,text)",
  "public.direct_entry_read_own_submission(uuid,uuid,uuid)",
];
const TABLES = ["direct_entry_submissions", "direct_entries", "direct_entry_app_users",
  "direct_entry_scope_grants", "direct_entry_capability_grants", "direct_entry_audit_events"];
const checks = [];
const pass = (label) => checks.push(label);

async function baseline(client) {
  const { rows } = await client.query(
    "select" +
    " (select count(*)::int from public.data_sources where active and not is_test) as sources," +
    " (select coalesce(sum(b.recruited_count), 0)::bigint from public.daily_recruitment_breakdown b" +
    "    join public.data_sources s on s.id=b.source_id where s.active and not s.is_test) as total," +
    " (select count(*)::int from public.daily_recruitment_breakdown b" +
    "    join public.data_sources s on s.id=b.source_id where s.active and not s.is_test) as rows",
  );
  return rows[0];
}

const EXEC_SQL =
  "select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig" +
  " from pg_proc p join pg_namespace n on n.oid=p.pronamespace" +
  " where n.nspname='public' and p.proname like 'direct_entry\\_%'" +
  " and has_function_privilege('service_role',p.oid,'EXECUTE') order by 1";

async function assertBoundary(client) {
  const { rows: appliedRows } = await client.query("select version, checksum from public.schema_migrations order by version");
  const local = await readMigrations(path.resolve("supabase/migrations"));
  assert.equal(appliedRows.length, local.length);
  const applied = new Map(appliedRows.map(({ version, checksum }) => [version, checksum]));
  assert.deepEqual(local.filter(({ name }) => !applied.has(name)), []);
  assert.deepEqual(local.filter(({ name, checksum }) => applied.get(name) !== checksum), []);
  pass(local.length + " migrations applied, 0 pending, 0 checksum mismatch");

  const scratch = await createMigratedDatabase();
  assert.equal(scratch.migrationNames.length, local.length);
  const expected = (await scratch.db.query(EXEC_SQL)).rows.map((row) => row.sig);
  await scratch.db.close();
  const live = (await client.query(EXEC_SQL)).rows.map((row) => row.sig);
  assert.deepEqual(live, expected);
  assert.equal(live.length, EXPECTED_SERVICE_RPC_COUNT);
  for (const signature of READ_RPCS) {
    assert.ok(live.includes(signature.replace("public.", "").replace(/\(.*/, "") + "(" +
      (await client.query("select pg_get_function_identity_arguments($1::regprocedure) as a", [signature])).rows[0].a + ")"));
  }
  pass("service_role-executable Direct Entry RPCs = " + live.length + " (27 + 2) and equal the PGlite from-scratch set");

  const { rows: names } = await client.query(
    "select distinct p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace" +
    " where n.nspname='public' and p.proname like 'direct_entry\\_%'");
  assert.deepEqual(names.map((row) => row.proname).sort(), [...expectedDirectEntryFunctions(local)].sort());
  pass("function name inventory matches the migration set exactly");

  for (const signature of READ_RPCS) {
    const { rows } = await client.query(
      "select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as config," +
      " has_function_privilege('anon',p.oid,'EXECUTE') as a, has_function_privilege('authenticated',p.oid,'EXECUTE') as u," +
      " has_function_privilege('service_role',p.oid,'EXECUTE') as s," +
      " exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee=0) as pub" +
      " from pg_proc p where p.oid=$1::regprocedure", [signature]);
    assert.equal(rows[0].prosecdef, true, signature);
    assert.equal(rows[0].config, "search_path=pg_catalog, public", signature);
    assert.deepEqual([rows[0].a, rows[0].u, rows[0].s, rows[0].pub], [false, false, true, false], signature);
  }
  pass("two new RPCs: SECURITY DEFINER, search_path pinned, EXECUTE service_role only (no anon/authenticated/PUBLIC)");

  const { rows: other } = await client.query(
    "select p.oid::regprocedure::text as sig," +
    " has_function_privilege('anon',p.oid,'EXECUTE') as a, has_function_privilege('authenticated',p.oid,'EXECUTE') as u" +
    " from pg_proc p join pg_namespace n on n.oid=p.pronamespace" +
    " where n.nspname='public' and p.proname like 'direct_entry\\_%' and (" +
    " has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))");
  assert.deepEqual(other, []);
  pass("no Direct Entry function (transition, change-request, R2 or read) is executable by anon/authenticated");

  const { rows: tables } = await client.query(
    "select c.relname, c.relrowsecurity, c.relforcerowsecurity," +
    " bool_or(has_table_privilege(r.rolname, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) as any_priv" +
    " from pg_class c join pg_namespace n on n.oid=c.relnamespace" +
    " cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r" +
    " where n.nspname='public' and c.relkind='r' and c.relname like 'direct_entry\\_%' group by 1,2,3");
  assert.ok(tables.length > 0);
  for (const row of tables) {
    assert.deepEqual([row.relrowsecurity, row.relforcerowsecurity, row.any_priv], [true, true, false], row.relname);
  }
  pass(tables.length + " Direct Entry tables: RLS + FORCE RLS, no anon/authenticated/service_role privileges (none added)");
}

function liveShim(client) {
  let n = 0;
  return {
    async query(sql, values) {
      const sp = "i02_sp_" + (n += 1);
      await client.query("savepoint " + sp);
      try {
        const result = await client.query(sql, values);
        await client.query("release savepoint " + sp);
        return result;
      } catch (error) {
        await client.query("rollback to savepoint " + sp);
        await client.query("release savepoint " + sp);
        throw error;
      }
    },
    async exec(sql) {
      if (/^\s*(begin|commit)\s*$/i.test(sql)) return undefined;
      if (/^\s*alter table/i.test(sql)) await client.query("set constraints all immediate");
      return client.query(sql);
    },
  };
}

async function roleCode(client, role, sql, values = []) {
  await client.query("savepoint i02_role");
  try {
    await client.query("set local role " + role);
    await client.query(sql, values);
    return null;
  } catch (error) {
    return error.code;
  } finally {
    await client.query("rollback to savepoint i02_role");
    await client.query("release savepoint i02_role");
  }
}

async function runReads(client, before) {
  const db = liveShim(client);
  const fixture = await seedSubmissionReadFixture(db);
  const subs = fixture.submissions;
  const ours = Object.values(subs);
  pass("synthetic fixture seeded in the outer transaction (5 actors, 4 submissions across DRAFT/REVIEW/SUBMITTED)");

  const own = await listOwnSubmissions(db, ACTORS.owner, { pageSize: 50 });
  assert.equal(own.error, null);
  assert.equal(own.data.items.length, 4);
  const byId = new Map(own.data.items.map((item) => [item.submission_id, item]));
  assert.deepEqual(new Set(own.data.items.map((item) => item.state)), new Set(["DRAFT", "REVIEW", "SUBMITTED"]));
  pass("owner (submission_create + exactly one own grant) sees DRAFT, REVIEW and SUBMITTED");

  for (const actor of [ACTORS.noCapability, ACTORS.noScope, ACTORS.teamScopeOnly]) {
    assert.equal((await listOwnSubmissions(db, actor, { pageSize: 20 })).error.code, "42501");
  }
  assert.deepEqual((await listOwnSubmissions(db, ACTORS.otherOwner, { pageSize: 50 })).data.items, []);
  const otherDetail = await readOwnSubmission(db, ACTORS.otherOwner, subs.draft);
  assert.equal(otherDetail.error.code, "P0002");
  pass("team-scope-only, missing capability and missing own grant are denied (42501); another owner sees nothing");

  const absent = await readOwnSubmission(db, ACTORS.otherOwner, "1f000000-0000-4000-8000-0000000000ff");
  assert.deepEqual(absent.error, otherDetail.error);
  pass("absent and out-of-scope detail return the identical sanitized error");

  assert.deepEqual((await listOwnSubmissions(db, ACTORS.owner, { pageSize: 50, state: "REVIEW" })).data.items
    .map((item) => item.submission_id), [subs.review]);
  assert.equal((await listOwnSubmissions(db, ACTORS.owner, { pageSize: 50, state: "DRAFT" })).data.items.length, 2);
  assert.deepEqual((await listOwnSubmissions(db, ACTORS.owner, { pageSize: 50, state: "SUBMITTED" })).data.items
    .map((item) => item.submission_id), [subs.submitted]);
  pass("state filter returns the exact subset for each state");

  assert.deepEqual(byId.get(subs.draft).allowed_transitions, ["REVIEW"]);
  assert.deepEqual(byId.get(subs.review).allowed_transitions, ["DRAFT", "SUBMITTED"]);
  assert.deepEqual(byId.get(subs.submitted).allowed_transitions, []);
  assert.notEqual(byId.get(subs.submitted).submitted_at, null);
  assert.equal(byId.get(subs.draft).submitted_at, null);
  assert.equal(byId.get(subs.review).submitted_at, null);
  pass("allowed_transitions follow the state matrix; submitted_at is set only for SUBMITTED");

  const detail = await readOwnSubmission(db, ACTORS.owner, subs.submitted);
  assert.equal(detail.error, null);
  assert.equal(detail.data.entry_count, 2);
  assert.equal(detail.data.entry_count, detail.data.entry_ids.length);
  assert.deepEqual([...detail.data.entry_ids].sort(), detail.data.entry_ids);
  assert.equal(new Set(detail.data.entry_ids).size, 2);
  assert.equal((await readOwnSubmission(db, ACTORS.owner, subs.draft)).data.entry_count, 1);
  pass("entry_count equals entry_ids length; entry_ids are unique and deterministically sorted");

  const full = await listOwnSubmissions(db, ACTORS.owner, { pageSize: 50 });
  const order = full.data.items.map((item) => item.submission_id);
  const walked = [];
  let cursor = null;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await listOwnSubmissions(db, ACTORS.owner, { pageSize: 1, cursor });
    walked.push(...page.data.items.map((item) => item.submission_id));
    if (!page.data.has_more) {
      assert.equal(page.data.next_cursor, null);
      break;
    }
    cursor = page.data.next_cursor;
  }
  assert.deepEqual(walked, order);
  assert.equal(new Set(walked).size, 4);
  assert.equal(SUBMISSION_STAMPS.draft, SUBMISSION_STAMPS.draftTied);
  assert.equal(Math.abs(order.indexOf(subs.draft) - order.indexOf(subs.draftTied)), 1);
  pass("keyset pagination with equal created_at: no duplicate, no gap, final cursor null");

  for (const [label, options] of [["size 51", { pageSize: 51 }], ["size 0", { pageSize: 0 }],
    ["cursor", { cursor: "nope" }], ["state", { state: "SUBMIT" }]]) {
    assert.equal((await listOwnSubmissions(db, ACTORS.owner, options)).error.code, "22023", label);
  }
  const mapping = await listOwnSubmissions(db, { auth_subject: ACTORS.owner.auth_subject,
    app_user_id: ACTORS.otherOwner.app_user_id }, {});
  assert.equal(mapping.error.code, "42501");
  pass("invalid cursor/state/page_size rejected (22023); actor mapping mismatch rejected (42501)");

  const body = JSON.stringify([full.data, detail.data]);
  for (const forbidden of ["created_by_user_id", "auth_subject", "app_user_id", "worker_details", "payment",
    "audit", "revision", "idempotency", "reason", "scope_kind", "account_number", "checksum", "storage_key"]) {
    assert.equal(body.includes(forbidden), false, forbidden);
  }
  pass("projection exposes no identity, grants, PII, payment, document, audit, reason or idempotency data");

  for (const signature of READ_RPCS) {
    const isList = signature.includes("list");
    const name = signature.slice(0, signature.indexOf("("));
    const sql = "select " + name + (isList ? "($1::uuid,$2::uuid,20,null,null)" : "($1::uuid,$2::uuid,$3::uuid)");
    const values = [ACTORS.owner.auth_subject, ACTORS.owner.app_user_id, subs.draft].slice(0, isList ? 2 : 3);
    for (const role of ["anon", "authenticated"]) assert.equal(await roleCode(client, role, sql, values), "42501");
  }
  pass("anon and authenticated cannot call either RPC");

  for (const table of TABLES) {
    assert.equal(await roleCode(client, "service_role", "select 1 from public." + table + " limit 1"), "42501", table);
  }
  pass("service_role cannot SELECT the underlying tables directly");

  await client.query("rollback");
  const { rows } = await client.query(
    "select (select count(*)::int from public.direct_entry_app_users where app_user_id = any($1::uuid[])) as actors," +
    " (select count(*)::int from public.direct_entry_capability_grants where app_user_id = any($1::uuid[])) as capability_grants," +
    " (select count(*)::int from public.direct_entry_scope_grants where app_user_id = any($1::uuid[])) as scope_grants," +
    " (select count(*)::int from public.direct_entry_submissions where submission_id = any($2::uuid[])) as submissions," +
    " (select count(*)::int from public.direct_entries where employee_code like 'hrp-2026-40000_') as entries," +
    " (select count(*)::int from public.teams where code = 's02c_team') as teams," +
    " (select count(*)::int from public.direct_entry_projects where project_id = 's02c_project') as projects," +
    " (select count(*)::int from pg_trigger where tgname like 'i02%') as temp_triggers," +
    " (select count(*)::int from pg_proc where proname like 'i02%') as temp_functions",
    [Object.values(ACTORS).map((actor) => actor.app_user_id), ours]);
  assert.deepEqual(Object.values(rows[0]), Array(Object.keys(rows[0]).length).fill(0));
  assert.deepEqual(await baseline(client), before);
  pass("rollback leaves 0 actors, grants, submissions, entries, teams, projects and temp objects; reporting baseline unchanged");
}

function runTransitionHarness() {
  const result = spawnSync(process.execPath, ["--conditions=react-server", "scripts/p1.6-s04c-dev-acceptance.mjs"],
    { encoding: "utf8" });
  const lines = (result.stdout + result.stderr).trim().split("\n");
  assert.equal(result.status, 0, "S01A harness failed:\n" + lines.slice(-8).join("\n"));
  pass("submission transition harness (S01A) still passes after the read migration ("
    + lines.filter((line) => line.startsWith("PASS ")).length + " checks, own rollback)");
}

async function main() {
  const { databaseUrl, projectRef, usesPooler } = await loadSupabaseConfig();
  const client = new pg.Client({ connectionString: databaseUrl, ssl: buildSslOptions(),
    application_name: "p1.6-s04c-i02-dev-acceptance" });
  await client.connect();
  let open = false;
  try {
    console.log("Shared DB project: " + projectRef.slice(0, 4) + "***; pooler=" + (usesPooler ? "yes" : "no"));
    await client.query("begin");
    open = true;
    await assertBoundary(client);
    const before = await baseline(client);
    await runReads(client, before);
    open = false;
    runTransitionHarness();
    for (const [index, label] of checks.entries()) console.log("PASS " + (index + 1) + ". " + label);
    console.log("S04C-I02 submission read DEV acceptance: " + checks.length + " checks passed.");
  } finally {
    if (open) await client.query("rollback").catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error("S04C-I02 acceptance failed; SQLSTATE=" + (error.code ?? "none") + "; message=" + error.message);
  process.exitCode = 1;
});
