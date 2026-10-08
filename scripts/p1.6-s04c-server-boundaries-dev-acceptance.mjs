#!/usr/bin/env node
/**
 * P1.6-W04-S04C-I01 - combined live DEV/shared-DB acceptance for the S04C server boundaries.
 *
 * 1. Fail-closed inventory/ACL/RLS boundary derived from the local migration set (PGlite) and the live DB.
 * 2. Change-request read/list/detail acceptance inside ONE outer transaction that is rolled back.
 * 3. Runs the S01A submission-transition and S02A change-request-mutation DEV harnesses
 *    (each is its own outer transaction + rollback) as child processes.
 *
 * Synthetic fixtures only. No R2, no network beyond the shared DB, no deploy.
 * Usage: node --conditions=react-server scripts/p1.6-s04c-server-boundaries-dev-acceptance.mjs
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
  createMigratedDatabase,
  listChangeRequests,
  readChangeRequest,
  seedChangeRequestFixture,
  seedChangeRequests,
} from "./lib/s04c-read-fixture.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const EXPECTED_SERVICE_RPC_COUNT = 29;
const READ_RPCS = [
  "public.direct_entry_list_change_requests(uuid,uuid,integer,text,text)",
  "public.direct_entry_read_change_request(uuid,uuid,uuid)",
];
const HELPERS = [
  "public.direct_entry_change_request_audience(uuid,uuid,uuid)",
  "public.direct_entry_has_entry_access(uuid,text,uuid,uuid,date)",
  "public.direct_entry_assert_actor_mapping(uuid,uuid)",
];
const CHANGE_REQUEST_TABLES = [
  "direct_entry_change_requests",
  "direct_entry_change_request_items",
  "direct_entry_change_request_revisions",
];
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

const SERVICE_NAMES_SQL =
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

  const fromScratch = await createMigratedDatabase();
  assert.equal(fromScratch.migrationNames.length, local.length);
  const expectedExec = (await fromScratch.db.query(SERVICE_NAMES_SQL)).rows.map((row) => row.sig);
  await fromScratch.db.close();
  const liveExec = (await client.query(SERVICE_NAMES_SQL)).rows.map((row) => row.sig);
  assert.deepEqual(liveExec, expectedExec);
  assert.equal(liveExec.length, EXPECTED_SERVICE_RPC_COUNT);
  pass("service_role-executable Direct Entry RPCs = " + liveExec.length + " and equal the PGlite from-scratch set");

  const { rows: names } = await client.query(
    "select distinct p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace" +
    " where n.nspname='public' and p.proname like 'direct_entry\\_%'");
  assert.deepEqual(names.map((row) => row.proname).sort(), [...expectedDirectEntryFunctions(local)].sort());
  pass("function name inventory matches the migration set exactly (callback dropped, no drift)");

  for (const signature of READ_RPCS) {
    const { rows } = await client.query(
      "select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as config," +
      " has_function_privilege('anon',p.oid,'EXECUTE') as a, has_function_privilege('authenticated',p.oid,'EXECUTE') as u," +
      " has_function_privilege('service_role',p.oid,'EXECUTE') as s," +
      " exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee=0) as pub" +
      " from pg_proc p where p.oid=$1::regprocedure", [signature]);
    assert.equal(rows[0].prosecdef, true, signature);
    assert.ok(rows[0].config.includes("search_path=pg_catalog, public"), signature);
    assert.deepEqual([rows[0].a, rows[0].u, rows[0].s, rows[0].pub], [false, false, true, false], signature);
  }
  pass("read/list RPCs are SECURITY DEFINER, search_path pinned, EXECUTE service_role only");

  for (const signature of HELPERS) {
    const { rows } = await client.query(
      "select has_function_privilege('anon',$1::regprocedure,'EXECUTE') as a," +
      " has_function_privilege('authenticated',$1::regprocedure,'EXECUTE') as u," +
      " has_function_privilege('service_role',$1::regprocedure,'EXECUTE') as s," +
      " exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x" +
      "   where p.oid=$1::regprocedure and x.grantee=0) as pub", [signature]);
    assert.deepEqual(Object.values(rows[0]), [false, false, false, false], signature);
  }
  const { rows: decide } = await client.query(
    "select has_function_privilege('service_role'," +
    "'public.direct_entry_decide_change_request(uuid,uuid,uuid,integer,text,text,text)'::regprocedure,'EXECUTE') as s");
  assert.equal(decide[0].s, false);
  pass("helpers (including decide helper) are not executable by service_role/anon/authenticated/PUBLIC");

  const { rows: legacy } = await client.query(
    "select (select count(*)::int from pg_proc where proname='direct_entry_apply_document_worker_callback') as callback," +
    " has_function_privilege('service_role','public.direct_entry_reserve_document_upload(uuid,uuid,uuid,integer,text,text,text,bigint,text,text)'::regprocedure,'EXECUTE') as reserve");
  assert.deepEqual(legacy[0], { callback: 0, reserve: false });
  pass("legacy worker callback absent and legacy reserve not executable; R2 RPC set intact via inventory");

  const { rows: tables } = await client.query(
    "select c.relname, c.relrowsecurity, c.relforcerowsecurity," +
    " bool_or(has_table_privilege(r.rolname, c.oid, 'SELECT,INSERT,UPDATE,DELETE')) as any_priv" +
    " from pg_class c join pg_namespace n on n.oid=c.relnamespace" +
    " cross join (select rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r" +
    " where n.nspname='public' and c.relkind='r' and c.relname like 'direct_entry\\_%' group by 1,2,3");
  assert.ok(tables.length > 0);
  for (const row of tables) {
    assert.deepEqual([row.relrowsecurity, row.relforcerowsecurity, row.any_priv], [true, true, false], row.relname);
  }
  pass(tables.length + " Direct Entry tables: RLS + FORCE RLS, no anon/authenticated/service_role table privileges");

  const { rows: view } = await client.query(
    "select pg_get_viewdef('public.direct_entry_current_documents'::regclass) as def");
  assert.match(view[0].def, /READY/);
  assert.match(view[0].def, /VALIDATED/);
  assert.match(view[0].def, /NOT_REQUIRED/);
  pass("current-documents view still selects READY + VALIDATED + CLEAN|NOT_REQUIRED");
}

function liveShim(client) {
  let n = 0;
  return {
    async query(sql, values) {
      const sp = "i01_sp_" + (n += 1);
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
      return client.query(sql);
    },
  };
}

async function roleDenied(client, role, sql, values = []) {
  await client.query("savepoint i01_role");
  try {
    await client.query("set local role " + role);
    await client.query(sql, values);
    return null;
  } catch (error) {
    return error.code;
  } finally {
    await client.query("rollback to savepoint i01_role");
    await client.query("release savepoint i01_role");
  }
}

async function runReads(client, before) {
  const db = liveShim(client);
  const fixture = await seedChangeRequestFixture(db);
  const requests = await seedChangeRequests(db, fixture);
  const ours = new Set(Object.values(requests));
  pass("synthetic fixture seeded in the outer transaction (5 actors, 2 SUBMITTED entries, 6 requests)");

  const own = await listChangeRequests(db, ACTORS.proposer, { pageSize: 50 });
  assert.equal(own.error, null);
  assert.equal(own.data.requests.length, 6);
  const byId = new Map(own.data.requests.map((item) => [item.request_id, item]));
  assert.deepEqual([byId.get(requests.single).can_withdraw, byId.get(requests.single).can_decide], [true, false]);
  for (const name of ["withdrawn", "approved", "rejected"]) assert.equal(byId.get(requests[name]).can_withdraw, false);
  pass("proposer sees own 6/6; can_withdraw only when PENDING; proposer holding change_review still cannot decide");

  // P2.5-W05 (#55): the reviewer audience is change_review + effective all scope.
  const team = await listChangeRequests(db, ACTORS.reviewer, { pageSize: 50 });
  assert.deepEqual(team.data.requests, []);
  pass("team-scoped actor sees 0/6: W05 requires change_review + all scope for review");

  const all = await listChangeRequests(db, ACTORS.reviewerAll, { pageSize: 50 });
  assert.equal(all.data.requests.filter((item) => ours.has(item.request_id)).length, 6);
  assert.deepEqual((await listChangeRequests(db, ACTORS.reviewerNoCapability, { pageSize: 50 })).data.requests, []);
  assert.deepEqual((await listChangeRequests(db, ACTORS.outsider, { pageSize: 50 })).data.requests, []);
  pass("scope-all reviewer sees 6/6; missing capability or out-of-scope actor sees nothing");

  const detail = await readChangeRequest(db, ACTORS.reviewerAll, requests.single);
  assert.equal(detail.error, null);
  assert.deepEqual([detail.data.state, detail.data.can_decide, detail.data.can_withdraw], ["PENDING", true, false]);
  assert.deepEqual(Object.keys(detail.data.items[0]).sort(), ["entry_id", "expected_version", "proposal", "target_kind"]);
  const multi = await readChangeRequest(db, ACTORS.reviewerAll, requests.multi);
  assert.equal(multi.data.items.length, 2);
  const hidden = await readChangeRequest(db, ACTORS.reviewer, requests.multi);
  const unknown = await readChangeRequest(db, ACTORS.reviewer, "d1000000-0000-4000-8000-0000000000ff");
  assert.equal(hidden.error.code, "P0002");
  assert.deepEqual(hidden.error, unknown.error);
  pass("detail projection strict; absent and out-of-scope detail return the identical sanitized error");

  const full = await listChangeRequests(db, ACTORS.proposer, { pageSize: 50 });
  const order = full.data.requests.map((item) => item.request_id);
  const walked = [];
  let cursor = null;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await listChangeRequests(db, ACTORS.proposer, { pageSize: 2, cursor });
    walked.push(...page.data.requests.map((item) => item.request_id));
    if (!page.data.has_more) {
      assert.equal(page.data.next_cursor, null);
      break;
    }
    cursor = page.data.next_cursor;
  }
  assert.deepEqual(walked, order);
  assert.equal(new Set(walked).size, 6);
  for (let i = 1; i < full.data.requests.length; i += 1) {
    const a = full.data.requests[i - 1];
    const b = full.data.requests[i];
    assert.ok(a.created_at > b.created_at || (a.created_at === b.created_at && a.request_id > b.request_id));
  }
  pass("keyset pagination is deterministic (created_at DESC, request_id DESC), no duplicate, no gap, final cursor null");

  const pending = await listChangeRequests(db, ACTORS.proposer, { pageSize: 50, state: "PENDING" });
  assert.equal(pending.data.requests.length, 3);
  for (const [label, options] of [["size", { pageSize: 51 }], ["cursor", { cursor: "nope" }], ["state", { state: "pending" }]]) {
    assert.equal((await listChangeRequests(db, ACTORS.proposer, options)).error.code, "22023", label);
  }
  const mapping = await listChangeRequests(db, { auth_subject: ACTORS.proposer.auth_subject,
    app_user_id: ACTORS.reviewer.app_user_id }, {});
  assert.equal(mapping.error.code, "42501");
  pass("state filter vocabulary enforced; malformed page_size/cursor/state -> 22023; actor mapping mismatch -> 42501");

  const body = JSON.stringify([full.data, detail.data, multi.data]);
  for (const forbidden of ["reason", "idempotency", "auth_subject", "app_user_id", "proposer_user_id",
    "decided_by_user_id", "audit", "revision", "account_number", "national_id", "checksum", "storage_key"]) {
    assert.equal(body.includes(forbidden), false, forbidden);
  }
  pass("list/detail expose no reason, identity, audit, revision, idempotency, PII, payment, document or storage fields");

  for (const signature of READ_RPCS) {
    const args = signature.includes("list") ? "($1::uuid,$2::uuid,20,null,null)" : "($1::uuid,$2::uuid,$3::uuid)";
    const name = signature.slice(0, signature.indexOf("("));
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await roleDenied(client, role, "select " + name + args,
        [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id, requests.single].slice(0, args.includes("$3") ? 3 : 2)), "42501");
    }
  }
  for (const table of CHANGE_REQUEST_TABLES) {
    assert.equal(await roleDenied(client, "service_role", "select 1 from public." + table + " limit 1"), "42501", table);
    assert.equal(await roleDenied(client, "authenticated", "select 1 from public." + table + " limit 1"), "42501", table);
  }
  assert.equal(await roleDenied(client, "service_role",
    "select public.direct_entry_decide_change_request($1::uuid,$1::uuid,$1::uuid,1,'x','x','x')", [ACTORS.proposer.auth_subject]), "42501");
  pass("anon/authenticated cannot call read RPCs; service_role cannot SELECT change-request tables or call the helper");

  await client.query("rollback");
  const { rows } = await client.query(
    "select (select count(*)::int from public.direct_entry_app_users where app_user_id = any($1::uuid[])) as actors," +
    " (select count(*)::int from public.direct_entry_capability_grants where app_user_id = any($1::uuid[])) as capability_grants," +
    " (select count(*)::int from public.direct_entry_scope_grants where app_user_id = any($1::uuid[])) as scope_grants," +
    " (select count(*)::int from public.direct_entry_change_requests where request_id = any($2::uuid[])) as requests," +
    " (select count(*)::int from public.direct_entries where employee_code like 'hrp-2026-30000_') as entries," +
    " (select count(*)::int from public.direct_entry_submissions where submission_id=$3) as submissions," +
    " (select count(*)::int from public.teams where code like 's02b\\_%') as teams," +
    " (select count(*)::int from pg_trigger where tgname like 'i01%') as temp_triggers," +
    " (select count(*)::int from pg_proc where proname like 'i01%') as temp_functions",
    [Object.values(ACTORS).map((actor) => actor.app_user_id), [...ours], fixture.submissionId]);
  assert.deepEqual(Object.values(rows[0]), Array(Object.keys(rows[0]).length).fill(0));
  assert.deepEqual(await baseline(client), before);
  pass("rollback leaves zero actors/grants/entries/submissions/requests/teams/temp objects; reporting baseline unchanged");
}

function runChild(script, label) {
  const result = spawnSync(process.execPath, ["--conditions=react-server", script], { encoding: "utf8" });
  const lines = (result.stdout + result.stderr).trim().split("\n");
  assert.equal(result.status, 0, label + " failed:\n" + lines.slice(-8).join("\n"));
  const summary = lines.filter((line) => line.startsWith("PASS ")).length;
  pass(label + " passed (" + summary + " checks, own outer transaction rolled back)");
}

async function main() {
  const { databaseUrl, projectRef, usesPooler } = await loadSupabaseConfig();
  const client = new pg.Client({ connectionString: databaseUrl, ssl: buildSslOptions(),
    application_name: "p1.6-s04c-i01-dev-acceptance" });
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
    runChild("scripts/p1.6-s04c-dev-acceptance.mjs", "S04C-S01A submission transitions");
    runChild("scripts/p1.6-s04c-change-request-dev-acceptance.mjs", "S04C-S02A change-request mutations");
    for (const [index, label] of checks.entries()) console.log("PASS " + (index + 1) + ". " + label);
    console.log("S04C-I01 server boundaries DEV acceptance: " + checks.length + " checks passed.");
  } finally {
    if (open) await client.query("rollback").catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error("S04C-I01 acceptance failed; SQLSTATE=" + (error.code ?? "none") + "; message=" + error.message);
  process.exitCode = 1;
});
