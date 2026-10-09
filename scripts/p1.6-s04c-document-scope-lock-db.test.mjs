import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { expectedDirectEntryFunctions } from "./lib/direct-entry-inventory.mjs";
import {
  AUTH_PROLOGUE,
  ACTORS,
  createMigratedDatabase,
  createChangeRequest,
  item,
  seedChangeRequestFixture,
} from "./lib/s04c-read-fixture.mjs";
import { DOCUMENT_PROPOSAL } from "./lib/s04c-policy-fixture.mjs";

const migrationDir = path.resolve("supabase/migrations");
const scopeMigration = "20261005040000_p1_6_w04_s04c_document_change_request_scope_lock.sql";

async function readLocalMigrations() {
  const names = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(names.map(async (name) => ({
    name,
    sql: await readFile(path.join(migrationDir, name), "utf8"),
  })));
}

async function snapshot(db) {
  const { rows } = await db.query(
    "select" +
    " (select count(*)::int from public.direct_entry_change_requests) as requests," +
    " (select count(*)::int from public.direct_entry_change_request_items) as items," +
    " (select count(*)::int from public.direct_entry_change_request_revisions) as request_revisions," +
    " (select count(*)::int from public.direct_entry_revisions) as revisions," +
    " (select count(*)::int from public.direct_entry_audit_events) as audits," +
    " (select count(*)::int from public.direct_entry_rpc_idempotency) as idempotency",
  );
  return rows[0];
}

async function assertConstraintError(db, savepoint, run, expectedCodes = ["23514"]) {
  await db.query("savepoint " + savepoint);
  let error;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  // P2.5-W02 (#51) closes the creator/team/date proposer fallback, so the RPC
  // path may now refuse a DOCUMENT target at the policy layer (42501) before the
  // table constraint (23514) is reached. Both are fail-closed; the residue
  // assertions below stay unchanged.
  assert.ok(expectedCodes.includes(error?.code),
    "expected " + expectedCodes.join("|") + ", got " + error?.code);
  await db.query("rollback to savepoint " + savepoint);
  await db.query("release savepoint " + savepoint);
  return error;
}

test("migration #34 refuses existing DOCUMENT items before changing schema", async () => {
  const migrations = await readLocalMigrations();
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  for (const migration of migrations.filter(({ name }) => name < scopeMigration)) {
    await db.exec(migration.sql);
  }
  assert.equal(migrations.filter(({ name }) => name < scopeMigration).length, 33);

  const fixture = await seedChangeRequestFixture(db);
  const created = await createChangeRequest(db, ACTORS.proposer,
    [item(fixture.entryA.entry_id, fixture.entryA.version, DOCUMENT_PROPOSAL, "DOCUMENT")],
    "synthetic legacy document request", "legacy_document_request");
  assert.equal(created.error, null);
  const documentRowsBefore = await db.query(
    "select count(*)::int as total from public.direct_entry_change_request_items" +
    " where target_kind = 'DOCUMENT'");
  assert.equal(documentRowsBefore.rows[0].total, 1);

  await assert.rejects(db.exec(migrations.find(({ name }) => name === scopeMigration).sql),
    (error) => error.code === "23514");
  const constraint = await db.query(
    "select count(*)::int as total from pg_constraint" +
    " where conname = 'direct_entry_change_request_items_document_scope_lock'");
  assert.equal(constraint.rows[0].total, 0);
  const documentRowsAfter = await db.query(
    "select count(*)::int as total from public.direct_entry_change_request_items" +
    " where target_kind = 'DOCUMENT'");
  assert.equal(documentRowsAfter.rows[0].total, 1);
  await db.close();
});

test("39-migration DB rejects DOCUMENT RPC and table inserts without residue", async () => {
  const { db, migrationNames } = await createMigratedDatabase();
  // P3-W07B migration #43 adds project-manager scope enforcement.
  // P2-W04B migration #44 rebaselines the cutoff to 2026-10-06.
  // Main carries W07C-R2 (#45), W07C-R3 (#46) and P2-W04C (#47); W05A appends
  // as #49 after W07C-R7; W07E #50, P2.5-W02 #51 and P2.5-W03 #52.
  assert.equal(migrationNames.length, 66);
  assert.ok(migrationNames.includes(scopeMigration));

  const fixture = await seedChangeRequestFixture(db);
  // P2.5-W05-R1: a worker_details proposal must satisfy the canonical contract at
  // CREATE (complete object with the stored display_name), so build it from the row.
  const storedDetails = (await db.query(
    "select worker_details from public.direct_entries where entry_id = $1",
    [fixture.entryA.entry_id])).rows[0].worker_details;
  const parent = await createChangeRequest(db, ACTORS.proposer,
    [item(fixture.entryA.entry_id, fixture.entryA.version,
      { worker_details: { ...storedDetails, address: { state: "provided", value: "W04 address" } } })],
    "synthetic parent request", "scope_lock_parent");
  assert.equal(parent.error, null);
  const before = await snapshot(db);

  await db.exec("begin");
  const rpcError = await assertConstraintError(db, "document_rpc", async () => {
    await db.query(
      "select public.direct_entry_create_change_request($1::uuid,$2::uuid,$3::jsonb,$4::text,$5::text)",
      [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id,
        JSON.stringify([item(fixture.entryB.entry_id, fixture.entryB.version,
          DOCUMENT_PROPOSAL, "DOCUMENT")]),
        "synthetic direct DOCUMENT RPC", "scope_lock_document_rpc"]);
  }, ["23514", "42501"]);
  if (rpcError.code === "42501") {
    assert.match(String(rpcError.message), /document change requests are not supported/);
  } else {
    assert.equal(rpcError.constraint, "direct_entry_change_request_items_document_scope_lock");
  }
  assert.deepEqual(await snapshot(db), before);

  const insertError = await assertConstraintError(db, "document_insert", () => db.query(
    "insert into public.direct_entry_change_request_items" +
    " (request_id,entry_id,target_kind,expected_version,proposal) values ($1,$2,'DOCUMENT',1,$3::jsonb)",
    [parent.data.request_id, fixture.entryB.entry_id, JSON.stringify(DOCUMENT_PROPOSAL)]));
  assert.equal(insertError.constraint, "direct_entry_change_request_items_document_scope_lock");
  assert.deepEqual(await snapshot(db), before);
  await db.exec("rollback");
  await db.close();
});

test("full migration set preserves the derived direct-entry function and RPC inventory", async () => {
  const migrations = await readLocalMigrations();
  const expected = expectedDirectEntryFunctions(migrations);
  const { db } = await createMigratedDatabase();
  const { rows } = await db.query(
    "select p.proname, has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec" +
    " from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
    " where n.nspname = 'public' and p.proname like 'direct_entry_%'");
  const actual = new Set(rows.map((row) => row.proname));
  assert.deepEqual(actual, expected);
  const serviceRpcs = rows.filter((row) => row.service_exec).length;
  // P2-W04A migration #40 added 8 new public.direct_entry_reporting_*
  // helpers (cutoff, source_id, dim_key, recruiter_alias_key,
  // recruiter_provider_key, employment_key, pre_cutover_blocker_count,
  // reconciliation_totals). All are GRANT EXECUTE to service_role so the
  // runtime can use them (no public RPC exposure). W07B adds three internal
  // helpers/wrapped implementations while preserving 39 service boundaries.
  // P3-W07C-R2 redefines existing validators/RPCs only; no date-conversion
  // helper is added and the prior function inventory stays unchanged.
  // P3-W05A (#47) adds six service-role-only scoped reporting helpers
  // (resolve_audience, authorized_entries, scoped_facts, de_options_scoped,
  // scoped_options, seed_team_scope_grants) with no public RPC exposure.
  // P3-W07C-R7 adds one internal draft-scope resolver, not exposed to any role.
  // P3-W07E adds four private scope/proposal helpers, also not executable by roles.
  // P2.5-W02 (#51) adds five internal helpers/trigger functions plus three
  // service-role-only administration RPCs (list/assign/unassign assignments);
  // its R1 successor adds four internal project-master helpers (row lock/OCC,
  // snapshot, revision writer, version bump) and five service-role-only project
  // RPCs (list/get/create/update/set-active), still with no anon surface.
  // P2.5-W03 (#52) adds one internal worker-directory audience guard and one
  // service-role-only directory RPC.
  // P2.5-W04 (#53) adds two service-role-only worker_details guards.
  // P2.5-W06A (#54) adds one service-role-only manager-candidate RPC.
  // P2.5-W05 (#55) adds one internal scope reader and one service-role-only
  // reviewer-bundle reader.
  assert.deepEqual([actual.size, serviceRpcs, actual.size - serviceRpcs], [125, 60, 65]);
  await db.close();
});
