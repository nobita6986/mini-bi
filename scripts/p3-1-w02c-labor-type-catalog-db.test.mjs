/**
 * P3.1-W02-C - Dynamic labor type catalog backend (#79) DB acceptance.
 *
 * Proves the retired TEMPORARY/PERMANENT closed set, the canonical dynamic
 * catalog with server-generated reporting keys, the Admin/Accounting authority
 * paths through the single reused catalog-operator guard, reason + OCC +
 * idempotency + immutable revision + audit invariants, the hard restrictive
 * foreign key on direct_entries.labor_type, the active-write guard that keeps
 * historical rows editable and readable, the catalog-following reporting
 * lookups, the bounded active projection consumed by the Direct Entry runtime,
 * the ACL/RLS/search_path posture, and the legacy resolve-and-verify abort.
 *
 * No Production access, no network, no browser: PGlite applies the real local
 * migrations and the RPCs are called exactly as the service-role repository
 * does. Every rejection assertion compares only the SQLSTATE, never a raw
 * message, so no identifier or personal data can leak through a test failure.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE, createMigratedDatabase } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const NEW_MIGRATION = "20261011120000_p3_1_w02c_labor_type_catalog.sql";
const R2_MIGRATION = "20261011130000_p3_1_w02c_r2_labor_type_display_projection.sql";
const R3_MIGRATION = "20261011140000_p3_1_w02c_r3_own_draft_display_projection.sql";

const OPERATOR_FULL_ADMIN = { auth: "10000000-0000-4000-8000-0000000000e1", app: "20000000-0000-4000-8000-0000000000e1" };
const OPERATOR_ACCOUNTING = { auth: "10000000-0000-4000-8000-0000000000e2", app: "20000000-0000-4000-8000-0000000000e2" };
const ENTRY_ADMIN_ALL_ONLY = { auth: "10000000-0000-4000-8000-0000000000e3", app: "20000000-0000-4000-8000-0000000000e3" };
const PROJECT_MANAGER = { auth: "10000000-0000-4000-8000-0000000000e4", app: "20000000-0000-4000-8000-0000000000e4" };
const STAFF = { auth: "10000000-0000-4000-8000-0000000000e5", app: "20000000-0000-4000-8000-0000000000e5" };
const DISABLED_OPERATOR = { auth: "10000000-0000-4000-8000-0000000000e6", app: "20000000-0000-4000-8000-0000000000e6" };
const ENTRY_OPERATOR = { auth: "10000000-0000-4000-8000-0000000000e7", app: "20000000-0000-4000-8000-0000000000e7" };
const UNMAPPED_OPERATOR = { auth: "10000000-0000-4000-8000-0000000000e8", app: "20000000-0000-4000-8000-0000000000e8" };
const MISMATCHED_OPERATOR = { auth: OPERATOR_FULL_ADMIN.auth, app: OPERATOR_ACCOUNTING.app };

const TEAM_ID = "94000000-0000-4000-8000-0000000000f1";
const RECRUITER_ID = "93000000-0000-4000-8000-0000000000f1";
const PROJECT_ID = "w02c_project";
const WORK_DATE = "2026-10-15";
const VALID_FROM = "2020-01-01";
const REASON = "Synthetic labor type catalog reason";
const UNKNOWN_KEY = "W02C_NO_SUCH_LABOR_TYPE";
const KEY = (suffix) => "70000000-0000-4000-8000-0000000000" + suffix;

const SEEDS = [
  { labor_type_key: "TEMPORARY", display_name: "Thời vụ", reporting_key: "thời vụ", sort_order: 10 },
  { labor_type_key: "PERMANENT", display_name: "Chính thức", reporting_key: "chính thức", sort_order: 20 },
  { labor_type_key: "OUTSOURCED", display_name: "Gia công", reporting_key: "gia công", sort_order: 30 },
];

const RPC_PARAMS = {
  direct_entry_list_labor_types_admin: ["p_auth_subject", "p_app_user_id", "p_search",
    "p_include_inactive", "p_page", "p_page_size"],
  direct_entry_get_labor_type_admin: ["p_auth_subject", "p_app_user_id", "p_labor_type_key"],
  direct_entry_create_labor_type: ["p_auth_subject", "p_app_user_id", "p_expected_version",
    "p_labor_type_key", "p_display_name", "p_sort_order", "p_reason", "p_idempotency_key"],
  direct_entry_update_labor_type: ["p_auth_subject", "p_app_user_id", "p_labor_type_key",
    "p_expected_version", "p_display_name", "p_sort_order", "p_reason", "p_idempotency_key"],
  direct_entry_set_labor_type_active: ["p_auth_subject", "p_app_user_id", "p_labor_type_key",
    "p_active", "p_expected_version", "p_reason", "p_idempotency_key"],
  direct_entry_read_projection: ["p_auth_subject", "p_app_user_id", "p_entry_id"],
  direct_entry_input_catalog: ["p_auth_subject", "p_app_user_id", "p_effective_date"],
  direct_entry_list_workers: ["p_auth_subject", "p_app_user_id", "p_scope", "p_project_id",
    "p_recruiter_id", "p_employment_status", "p_cursor", "p_page_size"],
};

const RPC_SIGNATURES = [
  "public.direct_entry_list_labor_types_admin(uuid,uuid,text,boolean,integer,integer)",
  "public.direct_entry_get_labor_type_admin(uuid,uuid,text)",
  "public.direct_entry_create_labor_type(uuid,uuid,integer,text,text,integer,text,text)",
  "public.direct_entry_update_labor_type(uuid,uuid,text,integer,text,integer,text,text)",
  "public.direct_entry_set_labor_type_active(uuid,uuid,text,boolean,integer,text,text)",
];
const HELPER_SIGNATURES = [
  "public.direct_entry_labor_types_immutable_guard()",
  "public.direct_entry_is_active_labor_type(text)",
  "public.direct_entry_labor_type_options()",
  "public.direct_entry_labor_type_snapshot(public.direct_entry_labor_types)",
  "public.direct_entry_labor_type_admin_projection(public.direct_entry_labor_types,integer)",
  "public.direct_entry_lock_labor_type(text,integer)",
  "public.direct_entry_write_labor_type_revision(text,integer,uuid,uuid,jsonb,jsonb)",
  "public.direct_entry_bump_labor_type_version(text,uuid,uuid,jsonb,jsonb)",
  "public.direct_entry_labor_type_write_guard()",
];
const CATALOG_TABLES = ["public.direct_entry_labor_types", "public.direct_entry_labor_type_revisions"];
const CATALOG_FUNCTIONS = RPC_SIGNATURES.concat(HELPER_SIGNATURES)
  .map((signature) => signature.slice("public.".length).split("(")[0]);
const LIST_KEYS = ["authorization_date", "include_inactive", "labor_types", "page", "page_size",
  "search", "total"];
const ITEM_KEYS = ["labor_type_key", "display_name", "reporting_key", "sort_order", "active",
  "version", "revision_count"];
const MUTATION_KEYS = ["labor_type_key", "display_name", "reporting_key", "sort_order", "active",
  "version", "revision_id"];
const CREATE_KEYS = [...MUTATION_KEYS, "created"];
const SNAPSHOT_KEYS = ["labor_type_key", "display_name", "reporting_key", "sort_order", "active",
  "version"].sort();
const OPTION_KEYS = ["labor_type_key", "display_name", "sort_order"];

async function rpc(db, name, args = {}) {
  const order = RPC_PARAMS[name];
  assert.ok(order, "unknown rpc " + name);
  const values = order.map((key) => (key in args ? args[key] : null));
  const signature = order.map((_, index) => "$" + (index + 1)).join(", ");
  const { rows } = await db.query("select public." + name + "(" + signature + ") as result", values);
  return rows[0].result;
}

async function rpcError(db, name, args = {}) {
  try {
    await rpc(db, name, args);
    return null;
  } catch (error) {
    return { code: error.code };
  }
}

/** A denied call must raise AND hand back no payload at all. */
async function rpcOutcome(db, name, args = {}) {
  try {
    return { denied: false, code: null, payload: await rpc(db, name, args) };
  } catch (error) {
    return { denied: true, code: error.code, payload: null };
  }
}

async function addActor(db, actor) {
  await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)"
    + " values ($1::uuid, $2::uuid, $3, $4)",
    [actor.app, actor.auth, actor.enabled !== false, actor.display_name ?? "Synthetic Actor"],
  );
  for (const capability of actor.capabilities ?? []) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)"
      + " values ($1::uuid, $2, '2020-01-01', true)",
      [actor.app, capability],
    );
  }
  for (const kind of actor.scopes ?? []) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)"
      + " values ($1::uuid, $2, $3::uuid, '2020-01-01', true)",
      [actor.app, kind, kind === "team" ? TEAM_ID : null],
    );
  }
}

async function counts(db) {
  const { rows } = await db.query(
    "select (select count(*)::int from public.direct_entry_labor_types) as labor_types,"
    + " (select count(*)::int from public.direct_entry_labor_type_revisions) as revisions,"
    + " (select count(*)::int from public.direct_entries) as entries,"
    + " (select count(*)::int from public.direct_entry_audit_events) as audits,"
    + " (select count(*)::int from public.direct_entry_restricted_reasons) as reasons,"
    + " (select count(*)::int from public.direct_entry_rpc_idempotency) as idempotency,"
    + " (select count(*)::int from public.direct_entry_capability_grants) as capability_grants,"
    + " (select count(*)::int from public.direct_entry_scope_grants) as scope_grants,"
    + " (select count(*)::int from public.direct_entry_app_users) as app_users",
  );
  return rows[0];
}

function sortedKeys(value) {
  return Object.keys(value).sort().join(",");
}

function assertSnapshotShape(snapshot, label) {
  assert.ok(snapshot, label + " snapshot must exist");
  assert.deepEqual(Object.keys(snapshot).sort(), SNAPSHOT_KEYS, label + " snapshot key set");
}

function listLaborTypes(db, actor, options = {}) {
  return rpc(db, "direct_entry_list_labor_types_admin", {
    p_auth_subject: actor.auth,
    p_app_user_id: actor.app,
    p_search: options.search ?? null,
    p_include_inactive: options.includeInactive ?? true,
    p_page: options.page ?? 1,
    p_page_size: options.pageSize ?? 25,
  });
}

function getLaborType(db, actor, laborTypeKey) {
  return rpc(db, "direct_entry_get_labor_type_admin", {
    p_auth_subject: actor.auth, p_app_user_id: actor.app, p_labor_type_key: laborTypeKey,
  });
}

function createLaborType(db, actor, options) {
  return rpc(db, "direct_entry_create_labor_type", {
    p_auth_subject: actor.auth,
    p_app_user_id: actor.app,
    p_expected_version: options.expectedVersion ?? 0,
    p_labor_type_key: options.laborTypeKey,
    p_display_name: options.displayName,
    p_sort_order: options.sortOrder,
    p_reason: options.reason ?? REASON,
    p_idempotency_key: options.idempotencyKey,
  });
}

function updateLaborType(db, actor, options) {
  return rpc(db, "direct_entry_update_labor_type", {
    p_auth_subject: actor.auth,
    p_app_user_id: actor.app,
    p_labor_type_key: options.laborTypeKey,
    p_expected_version: options.expectedVersion,
    p_display_name: options.displayName,
    p_sort_order: options.sortOrder,
    p_reason: options.reason ?? REASON,
    p_idempotency_key: options.idempotencyKey,
  });
}

function setLaborTypeActive(db, actor, options) {
  return rpc(db, "direct_entry_set_labor_type_active", {
    p_auth_subject: actor.auth,
    p_app_user_id: actor.app,
    p_labor_type_key: options.laborTypeKey,
    p_active: options.active,
    p_expected_version: options.expectedVersion,
    p_reason: options.reason ?? REASON,
    p_idempotency_key: options.idempotencyKey,
  });
}

function setLaborTypeActiveError(db, actor, options) {
  return rpcError(db, "direct_entry_set_labor_type_active", {
    p_auth_subject: actor.auth,
    p_app_user_id: actor.app,
    p_labor_type_key: options.laborTypeKey,
    p_active: options.active,
    p_expected_version: options.expectedVersion,
    p_reason: options.reason ?? REASON,
    p_idempotency_key: options.idempotencyKey,
  });
}

async function currentVersion(db, laborTypeKey) {
  return (await db.query(
    "select version from public.direct_entry_labor_types where labor_type_key = $1",
    [laborTypeKey])).rows[0].version;
}

const WORKER_DETAILS = JSON.stringify({
  display_name: "Synthetic Labor Type Worker",
  gender: { state: "unknown" },
  date_of_birth: { state: "unknown" },
  national_id: { state: "unknown" },
  address: { state: "unknown" },
  phone: { state: "unknown" },
});

let SUBMISSION_ID = null;

async function insertEntry(db, { employeeCode, laborType, submissionId = SUBMISSION_ID,
  firstWorkDate = WORK_DATE }) {
  const candidateId = (await db.query(
    "insert into public.direct_entry_candidates default values returning candidate_id",
  )).rows[0].candidate_id;
  const { rows } = await db.query(
    "insert into public.direct_entries"
    + " (submission_id, candidate_id, created_by_user_id, project_id, first_work_date,"
    + "  employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type)"
    + " values ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6, $7::jsonb, $8::uuid, $9::uuid,"
    + " 'hrp', $10)"
    + " returning entry_id",
    [submissionId, candidateId, ENTRY_OPERATOR.app, PROJECT_ID, firstWorkDate, employeeCode,
      WORKER_DETAILS, RECRUITER_ID, TEAM_ID, laborType],
  );
  return rows[0].entry_id;
}

/** The active-write guard probe: a rejected write reports only its SQLSTATE. */
async function directEntryProbe(db, employeeCode, laborType) {
  try {
    return { code: null, entry_id: await insertEntry(db, { employeeCode, laborType }) };
  } catch (error) {
    return { code: error.code, entry_id: null };
  }
}

async function seedFixture(db) {
  // The team exists before any team-scoped grant is written.
  await db.query("insert into public.teams (team_id, code, display_name, active)"
    + " values ($1::uuid, 'W02C_TEAM', 'Synthetic W02C Team', true)", [TEAM_ID]);

  await addActor(db, { ...OPERATOR_FULL_ADMIN, display_name: "Synthetic Full Admin Operator",
    capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"], scopes: ["all"] });
  await addActor(db, { ...OPERATOR_ACCOUNTING, display_name: "Synthetic Accounting Operator",
    capabilities: ["catalog_master_manage"], scopes: ["all"] });
  await addActor(db, { ...ENTRY_ADMIN_ALL_ONLY, display_name: "Synthetic Entry Admin",
    capabilities: ["entry_admin"], scopes: ["all"] });
  await addActor(db, { ...PROJECT_MANAGER, display_name: "Synthetic Project Manager",
    capabilities: ["entry_create", "entry_own", "change_review"], scopes: ["team"] });
  await addActor(db, { ...STAFF, display_name: "Synthetic Staff",
    capabilities: ["entry_own"], scopes: ["own"] });
  await addActor(db, { ...DISABLED_OPERATOR, display_name: "Synthetic Disabled Operator",
    enabled: false, capabilities: ["catalog_master_manage"], scopes: ["all"] });
  await addActor(db, { ...ENTRY_OPERATOR, display_name: "Synthetic Entry Operator",
    capabilities: ["entry_create", "entry_own", "entry_admin"], scopes: ["all"] });
  // UNMAPPED_OPERATOR intentionally has no direct_entry_app_users row at all.

  await db.query("insert into public.recruiters (recruiter_id, display_name, active, version)"
    + " values ($1::uuid, 'Synthetic W02C Recruiter', true, 1)", [RECRUITER_ID]);
  await db.query("insert into public.recruiter_provider_memberships"
    + " (recruiter_id, provider_type, valid_from, is_current) values ($1::uuid, 'hrp', $2::date, true)",
    [RECRUITER_ID, VALID_FROM]);
  await db.query("insert into public.recruiter_team_memberships"
    + " (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, $3::date, true)",
    [RECRUITER_ID, TEAM_ID, VALID_FROM]);
  await db.query("insert into public.direct_entry_projects (project_id, display_name)"
    + " values ($1, 'Synthetic W02C Project')", [PROJECT_ID]);

  // The submission carries a deferred non-empty constraint trigger, so the
  // submission and its historical rows are written in one transaction.
  await db.query("begin");
  const submissionId = (await db.query(
    "insert into public.direct_entry_submissions (created_by_user_id) values ($1::uuid)"
    + " returning submission_id", [ENTRY_OPERATOR.app])).rows[0].submission_id;
  SUBMISSION_ID = submissionId;
  await insertEntry(db, { employeeCode: "hrp-2026-400001", laborType: "PERMANENT" });
  await insertEntry(db, { employeeCode: "hrp-2026-400002", laborType: "OUTSOURCED" });
  await db.query("commit");
}

const { db } = await createMigratedDatabase();
await seedFixture(db);

const PERMANENT_ENTRY = (await db.query(
  "select entry_id from public.direct_entries where employee_code = 'hrp-2026-400001'")).rows[0].entry_id;
const OUTSOURCED_ENTRY = (await db.query(
  "select entry_id from public.direct_entries where employee_code = 'hrp-2026-400002'")).rows[0].entry_id;

test("1: the catalog starts as exactly the three seed rows with their reporting keys", async () => {
  const rows = (await db.query(
    "select labor_type_key, display_name, reporting_key, sort_order, active, version"
    + " from public.direct_entry_labor_types order by sort_order, labor_type_key")).rows;
  assert.deepEqual(rows, SEEDS.map((seed) => ({ ...seed, active: true, version: 1 })),
    "TEMPORARY/PERMANENT/OUTSOURCED are seed rows only");

  const list = await listLaborTypes(db, OPERATOR_FULL_ADMIN, { pageSize: 100 });
  assert.equal(list.total, 3, "the catalog starts with exactly three rows");
  assert.deepEqual(list.labor_types.map((row) => row.labor_type_key),
    ["TEMPORARY", "PERMANENT", "OUTSOURCED"], "the order is sort_order then key");
  assert.deepEqual(list.labor_types.map((row) => row.reporting_key),
    ["thời vụ", "chính thức", "gia công"]);
  assert.deepEqual(list.labor_types.map((row) => row.sort_order), [10, 20, 30]);
  for (const row of list.labor_types) {
    assert.equal(row.active, true);
    assert.equal(row.version, 1);
  }

  // Ordering is by (sort_order, labor_type_key), not by insertion or key alone.
  const reversed = [...SEEDS].sort((left, right) =>
    right.sort_order - left.sort_order || right.labor_type_key.localeCompare(left.labor_type_key));
  assert.deepEqual(reversed.map((seed) => seed.labor_type_key),
    ["OUTSOURCED", "PERMANENT", "TEMPORARY"], "the seeds intentionally disagree with key order");
});

test("2: the admin list returns the seven-key row, counts the total and hides inactive rows", async () => {
  const list = await listLaborTypes(db, OPERATOR_ACCOUNTING, { pageSize: 100 });
  assert.deepEqual(Object.keys(list).sort(), [...LIST_KEYS].sort());
  assert.equal(list.total, 3);
  assert.equal(list.include_inactive, true);
  assert.equal(list.page, 1);
  assert.equal(list.page_size, 100);
  assert.equal(typeof list.authorization_date, "string");
  for (const row of list.labor_types) {
    assert.equal(sortedKeys(row), [...ITEM_KEYS].sort().join(","));
    assert.equal(row.revision_count, 0, "the seed rows carry no revision yet");
  }
  const byKey = Object.fromEntries(list.labor_types.map((row) => [row.labor_type_key, row]));
  assert.equal(byKey.TEMPORARY.display_name, "Thời vụ");
  assert.equal(byKey.PERMANENT.reporting_key, "chính thức");
  assert.equal(byKey.OUTSOURCED.sort_order, 30);

  // A deactivated row is hidden unless inactive rows are requested.
  const off = await setLaborTypeActive(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "OUTSOURCED", active: false, expectedVersion: 1, idempotencyKey: KEY("02"),
  });
  assert.equal(off.active, false);
  const activeOnly = await listLaborTypes(db, OPERATOR_FULL_ADMIN, { includeInactive: false, pageSize: 100 });
  assert.equal(activeOnly.include_inactive, false);
  assert.equal(activeOnly.total, 2);
  assert.deepEqual(activeOnly.labor_types.map((row) => row.labor_type_key), ["TEMPORARY", "PERMANENT"]);
  const searched = await listLaborTypes(db, OPERATOR_FULL_ADMIN,
    { includeInactive: false, search: "OUTSOURCED", pageSize: 100 });
  assert.equal(searched.total, 0, "an inactive row is not offered unless asked for");
  assert.deepEqual(searched.labor_types, []);
  const withInactive = await listLaborTypes(db, OPERATOR_FULL_ADMIN, { pageSize: 100 });
  assert.equal(withInactive.total, 3);
  assert.equal(withInactive.labor_types.find((row) => row.labor_type_key === "OUTSOURCED").active, false);

  const restored = await setLaborTypeActive(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "OUTSOURCED", active: true, expectedVersion: off.version, idempotencyKey: KEY("03"),
  });
  assert.equal(restored.active, true);

  // Paging is a partition of the deterministic order.
  const first = await listLaborTypes(db, OPERATOR_FULL_ADMIN, { page: 1, pageSize: 1 });
  const second = await listLaborTypes(db, OPERATOR_FULL_ADMIN, { page: 2, pageSize: 1 });
  const third = await listLaborTypes(db, OPERATOR_FULL_ADMIN, { page: 3, pageSize: 1 });
  assert.deepEqual([first.labor_types[0], second.labor_types[0], third.labor_types[0]]
    .map((row) => row.labor_type_key), ["TEMPORARY", "PERMANENT", "OUTSOURCED"]);
  assert.equal(first.total, 3);
  assert.equal(third.total, 3);
});

test("3: get returns exactly one row and an unknown key is not found", async () => {
  const detail = await getLaborType(db, OPERATOR_FULL_ADMIN, "TEMPORARY");
  assert.equal(sortedKeys(detail), [...ITEM_KEYS].sort().join(","));
  const stored = (await db.query(
    "select labor_type_key, display_name, reporting_key, sort_order, active, version"
    + " from public.direct_entry_labor_types where labor_type_key = 'TEMPORARY'")).rows[0];
  const { revision_count: revisionCount, ...projected } = detail;
  assert.deepEqual(projected, stored, "the projection mirrors the stored row");
  assert.equal(revisionCount, 0);

  const missing = await rpcError(db, "direct_entry_get_labor_type_admin", {
    p_auth_subject: OPERATOR_FULL_ADMIN.auth, p_app_user_id: OPERATOR_FULL_ADMIN.app,
    p_labor_type_key: UNKNOWN_KEY,
  });
  assert.equal(missing.code, "P0002");
  const empty = await rpcError(db, "direct_entry_get_labor_type_admin", {
    p_auth_subject: OPERATOR_FULL_ADMIN.auth, p_app_user_id: OPERATOR_FULL_ADMIN.app,
    p_labor_type_key: null,
  });
  assert.equal(empty.code, "22023");
});

test("4: both authority paths may create, and the reporting key is server generated", async () => {
  const before = await counts(db);
  const asFullAdmin = await createLaborType(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "PROBATION", displayName: "Thời gian thử việc", sortOrder: 40,
    idempotencyKey: KEY("04"),
  });
  assert.equal(sortedKeys(asFullAdmin), [...CREATE_KEYS].sort().join(","));
  assert.equal(asFullAdmin.created, true);
  assert.equal(asFullAdmin.version, 1);
  assert.equal(asFullAdmin.active, true);
  assert.equal(asFullAdmin.labor_type_key, "PROBATION");
  assert.equal(asFullAdmin.display_name, "Thời gian thử việc");
  assert.equal(asFullAdmin.sort_order, 40);
  assert.equal(asFullAdmin.reporting_key, "probation",
    "reporting_key is the lowercase ASCII of the canonical key");
  assert.equal(typeof asFullAdmin.revision_id, "string");

  const asAccounting = await createLaborType(db, OPERATOR_ACCOUNTING, {
    laborTypeKey: "SHIFT_LEAD", displayName: "Tổ trưởng ca", sortOrder: 50,
    idempotencyKey: KEY("05"),
  });
  assert.equal(asAccounting.created, true);
  assert.equal(asAccounting.reporting_key, "shift_lead");

  // The client can never send reporting_key: it is absent from every RPC.
  const args = (await db.query(
    "select pg_get_function_arguments(p.oid) as args from pg_proc p"
    + " join pg_namespace n on n.oid = p.pronamespace"
    + " where n.nspname = 'public' and p.proname in"
    + " ('direct_entry_create_labor_type', 'direct_entry_update_labor_type')")).rows;
  assert.equal(args.length, 2);
  for (const row of args) {
    assert.equal(row.args.includes("reporting_key"), false,
      "reporting_key is never a client parameter");
  }

  const revision = (await db.query(
    "select version, before_snapshot, after_snapshot, actor_user_id is not null as has_actor,"
    + " reason_id is not null as has_reason from public.direct_entry_labor_type_revisions"
    + " where labor_type_key = 'PROBATION'")).rows;
  assert.equal(revision.length, 1, "create writes exactly one revision row");
  assert.equal(revision[0].version, 1);
  assert.equal(revision[0].before_snapshot, null);
  assert.equal(revision[0].has_actor, true);
  assert.equal(revision[0].has_reason, true);
  assertSnapshotShape(revision[0].after_snapshot, "create after");
  assert.deepEqual(revision[0].after_snapshot, {
    labor_type_key: "PROBATION", display_name: "Thời gian thử việc", reporting_key: "probation",
    sort_order: 40, active: true, version: 1,
  });

  const audit = (await db.query(
    "select action, capability, scope_kind, outcome, changed_fields, resource_ref,"
    + " labor_type_revision_id from public.direct_entry_audit_events"
    + " where resource_ref = 'PROBATION' and action = 'labor_type_create'")).rows[0];
  assert.equal(audit.capability, "entry_admin", "audit records the authority actually exercised");
  assert.equal(audit.scope_kind, "all");
  assert.equal(audit.outcome, "APPLIED");
  assert.equal(audit.labor_type_revision_id, asFullAdmin.revision_id);
  assert.deepEqual(audit.changed_fields.sort(),
    ["active", "display_name", "labor_type_key", "sort_order"]);

  const after = await counts(db);
  assert.equal(after.labor_types, before.labor_types + 2);
  assert.equal(after.revisions, before.revisions + 2);
  assert.equal(after.audits, before.audits + 2);
  assert.equal(after.reasons, before.reasons + 2);
  assert.equal(after.entries, before.entries, "create never touches an entry");
  assert.equal(after.capability_grants, before.capability_grants);
  assert.equal(after.scope_grants, before.scope_grants);
});

test("5: create rejects invalid inputs and accepts a missing action reason", async () => {
  const before = await counts(db);
  let suffix = 0;
  for (const laborTypeKey of ["probation", "PROBATION TYPE", "1PROBATION", "PROBATION-TYPE",
    "PROBATION.", ""]) {
    suffix += 1;
    const error = await rpcError(db, "direct_entry_create_labor_type", {
      p_auth_subject: OPERATOR_FULL_ADMIN.auth, p_app_user_id: OPERATOR_FULL_ADMIN.app,
      p_expected_version: 0, p_labor_type_key: laborTypeKey, p_display_name: "Non Canonical",
      p_sort_order: 90, p_reason: REASON, p_idempotency_key: KEY("1" + suffix),
    });
    assert.equal(error.code, "22023", "key shape " + JSON.stringify(laborTypeKey));
  }
  const missingKey = await rpcError(db, "direct_entry_create_labor_type", {
    p_auth_subject: OPERATOR_FULL_ADMIN.auth, p_app_user_id: OPERATOR_FULL_ADMIN.app,
    p_expected_version: 0, p_labor_type_key: null, p_display_name: "Missing Key",
    p_sort_order: 90, p_reason: REASON, p_idempotency_key: KEY("1a"),
  });
  assert.equal(missingKey.code, "22023");

  const duplicate = await rpcError(db, "direct_entry_create_labor_type", {
    p_auth_subject: OPERATOR_ACCOUNTING.auth, p_app_user_id: OPERATOR_ACCOUNTING.app,
    p_expected_version: 0, p_labor_type_key: "PROBATION", p_display_name: "Duplicate",
    p_sort_order: 91, p_reason: REASON, p_idempotency_key: KEY("1b"),
  });
  assert.equal(duplicate.code, "23505");

  const wrongVersion = await rpcError(db, "direct_entry_create_labor_type", {
    p_auth_subject: OPERATOR_FULL_ADMIN.auth, p_app_user_id: OPERATOR_FULL_ADMIN.app,
    p_expected_version: 1, p_labor_type_key: "W02C_BAD_VERSION", p_display_name: "Bad Version",
    p_sort_order: 92, p_reason: REASON, p_idempotency_key: KEY("1c"),
  });
  assert.equal(wrongVersion.code, "22023", "create always opens the aggregate at version zero");

  const noKey = await rpcError(db, "direct_entry_create_labor_type", {
    p_auth_subject: OPERATOR_FULL_ADMIN.auth, p_app_user_id: OPERATOR_FULL_ADMIN.app,
    p_expected_version: 0, p_labor_type_key: "W02C_NO_KEY", p_display_name: "No Key",
    p_sort_order: 92, p_reason: REASON, p_idempotency_key: null,
  });
  assert.equal(noKey.code, "22023");

  assert.deepEqual(await counts(db), before, "rejected creates leave zero residue");
  const noReason = await rpc(db, "direct_entry_create_labor_type", {
    p_auth_subject: OPERATOR_FULL_ADMIN.auth, p_app_user_id: OPERATOR_FULL_ADMIN.app,
    p_expected_version: 0, p_labor_type_key: "W02C_NO_REASON", p_display_name: "No Reason",
    p_sort_order: 92, p_reason: null, p_idempotency_key: KEY("1d"),
  });
  assert.equal(noReason.labor_type_key, "W02C_NO_REASON");
  assert.equal(noReason.version, 1);
  const reasonRefs = (await db.query(
    "select (select reason_id from public.direct_entry_labor_type_revisions"
    + " where labor_type_key='W02C_NO_REASON' and version=1) as revision_reason_id,"
    + " (select reason_id from public.direct_entry_audit_events"
    + " where resource_ref='W02C_NO_REASON' and action='labor_type_create') as audit_reason_id",
  )).rows[0];
  assert.equal(reasonRefs.revision_reason_id, null);
  assert.equal(reasonRefs.audit_reason_id, null);
  const after = await counts(db);
  assert.equal(after.labor_types, before.labor_types + 1);
  assert.equal(after.revisions, before.revisions + 1);
  assert.equal(after.audits, before.audits + 1);
  assert.equal(after.reasons, before.reasons, "optional reasons do not create restricted-reason placeholders");
  assert.equal(after.idempotency, before.idempotency + 1);
});

test("6: update changes display_name and sort_order under OCC with one revision", async () => {
  const created = await createLaborType(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "ROTATION", displayName: "Luân chuyển", sortOrder: 60,
    idempotencyKey: KEY("06"),
  });
  const before = await counts(db);

  const updated = await updateLaborType(db, OPERATOR_ACCOUNTING, {
    laborTypeKey: "ROTATION", expectedVersion: created.version, displayName: "Luân chuyển ca",
    sortOrder: 65, idempotencyKey: KEY("07"),
  });
  assert.equal(sortedKeys(updated), [...MUTATION_KEYS].sort().join(","));
  assert.equal(updated.labor_type_key, "ROTATION", "the key is immutable");
  assert.equal(updated.display_name, "Luân chuyển ca");
  assert.equal(updated.sort_order, 65);
  assert.equal(updated.reporting_key, "rotation", "the reporting key is immutable");
  assert.equal(updated.active, true, "update never flips active");
  assert.equal(updated.version, created.version + 1);

  const after = await counts(db);
  assert.equal(after.labor_types, before.labor_types);
  assert.equal(after.revisions, before.revisions + 1);
  assert.equal(after.audits, before.audits + 1);
  assert.equal(after.reasons, before.reasons + 1);

  const revisions = (await db.query(
    "select version, before_snapshot, after_snapshot from public.direct_entry_labor_type_revisions"
    + " where labor_type_key = 'ROTATION' order by version")).rows;
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].before_snapshot, null);
  assertSnapshotShape(revisions[1].before_snapshot, "update before");
  assertSnapshotShape(revisions[1].after_snapshot, "update after");
  assert.deepEqual(revisions[1].before_snapshot, {
    labor_type_key: "ROTATION", display_name: "Luân chuyển", reporting_key: "rotation",
    sort_order: 60, active: true, version: 1,
  });
  // Mirrors the W01B personnel / W02-B vendor convention: the bump helper
  // stamps the after-snapshot with the version the catalog row now carries, so
  // a revision can never record a version the row does not have.
  assert.deepEqual(revisions[1].after_snapshot, {
    labor_type_key: "ROTATION", display_name: "Luân chuyển ca", reporting_key: "rotation",
    sort_order: 65, active: true, version: updated.version,
  });
  assert.equal(revisions[1].version, updated.version, "the revision is filed at the new version");
  assert.equal(await currentVersion(db, "ROTATION"), updated.version);

  const audit = (await db.query(
    "select capability, changed_fields, labor_type_revision_id from public.direct_entry_audit_events"
    + " where resource_ref = 'ROTATION' and action = 'labor_type_update'")).rows[0];
  assert.equal(audit.capability, "catalog_master_manage");
  assert.deepEqual(audit.changed_fields, ["display_name", "sort_order"]);
  assert.equal(audit.labor_type_revision_id, updated.revision_id);

  const stale = await rpcError(db, "direct_entry_update_labor_type", {
    p_auth_subject: OPERATOR_FULL_ADMIN.auth, p_app_user_id: OPERATOR_FULL_ADMIN.app,
    p_labor_type_key: "ROTATION", p_expected_version: created.version,
    p_display_name: "Stale Rename", p_sort_order: 66, p_reason: REASON,
    p_idempotency_key: KEY("08"),
  });
  assert.equal(stale.code, "PT409", "a stale expected_version is a conflict, never a silent write");

  const unchanged = await rpcError(db, "direct_entry_update_labor_type", {
    p_auth_subject: OPERATOR_FULL_ADMIN.auth, p_app_user_id: OPERATOR_FULL_ADMIN.app,
    p_labor_type_key: "ROTATION", p_expected_version: updated.version,
    p_display_name: "Luân chuyển ca", p_sort_order: 65, p_reason: REASON,
    p_idempotency_key: KEY("09"),
  });
  assert.equal(unchanged.code, "22023", "an unchanged update is not a mutation");

  const unknown = await rpcError(db, "direct_entry_update_labor_type", {
    p_auth_subject: OPERATOR_FULL_ADMIN.auth, p_app_user_id: OPERATOR_FULL_ADMIN.app,
    p_labor_type_key: UNKNOWN_KEY, p_expected_version: 1, p_display_name: "Unknown Rename",
    p_sort_order: 66, p_reason: REASON, p_idempotency_key: KEY("0a"),
  });
  assert.equal(unknown.code, "P0002");

  const afterRejections = await counts(db);
  assert.equal(afterRejections.revisions, after.revisions);
  assert.equal(afterRejections.audits, after.audits);
});

test("7: the labor type key and the reporting key are immutable", async () => {
  const before = (await db.query(
    "select labor_type_key, display_name, reporting_key, sort_order, active, version"
    + " from public.direct_entry_labor_types where labor_type_key = 'PROBATION'")).rows[0];

  let keyCode = null;
  try {
    await db.query("update public.direct_entry_labor_types set labor_type_key = 'PROBATION_RENAMED'"
      + " where labor_type_key = 'PROBATION'");
  } catch (error) {
    keyCode = error.code;
  }
  assert.equal(keyCode, "55000", "the key is immutable at the storage layer");

  let reportingCode = null;
  try {
    await db.query("update public.direct_entry_labor_types set reporting_key = 'thu_viec'"
      + " where labor_type_key = 'PROBATION'");
  } catch (error) {
    reportingCode = error.code;
  }
  assert.equal(reportingCode, "55000", "the reporting key is immutable at the storage layer");

  assert.deepEqual((await db.query(
    "select labor_type_key, display_name, reporting_key, sort_order, active, version"
    + " from public.direct_entry_labor_types where labor_type_key = 'PROBATION'")).rows[0], before,
    "a rejected direct update leaves the row untouched");

  // No RPC exposes a rename of either key either.
  const args = (await db.query(
    "select p.proname, pg_get_function_arguments(p.oid) as args from pg_proc p"
    + " join pg_namespace n on n.oid = p.pronamespace"
    + " where n.nspname = 'public' and p.proname = 'direct_entry_update_labor_type'")).rows;
  assert.equal(args[0].args.includes("reporting_key"), false);
  assert.equal(args[0].args.includes("new_key"), false);
});

test("8: set-active deactivates and re-activates without ever deleting the row", async () => {
  const created = await createLaborType(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "SEASONAL", displayName: "Thời vụ cao điểm", sortOrder: 70,
    idempotencyKey: KEY("0b"),
  });
  const before = await counts(db);

  const off = await setLaborTypeActive(db, OPERATOR_ACCOUNTING, {
    laborTypeKey: "SEASONAL", active: false, expectedVersion: created.version,
    idempotencyKey: KEY("0c"),
  });
  assert.equal(sortedKeys(off), [...MUTATION_KEYS].sort().join(","));
  assert.equal(off.active, false);
  assert.equal(off.version, created.version + 1);
  assert.equal(off.labor_type_key, "SEASONAL");
  assert.equal(off.reporting_key, "seasonal");

  const afterOff = await counts(db);
  assert.equal(afterOff.labor_types, before.labor_types, "deactivation keeps the row");
  assert.equal(afterOff.revisions, before.revisions + 1);
  assert.equal(afterOff.audits, before.audits + 1);

  const revision = (await db.query(
    "select version, before_snapshot, after_snapshot from public.direct_entry_labor_type_revisions"
    + " where labor_type_key = 'SEASONAL' and version = 2")).rows[0];
  assert.equal(revision.before_snapshot.active, true);
  assert.equal(revision.after_snapshot.active, false);
  assert.equal(revision.after_snapshot.version, off.version,
    "the after-snapshot carries the version the catalog row now has");
  assert.equal(revision.version, off.version, "the revision is filed at the bumped version");

  const audit = (await db.query(
    "select action, changed_fields from public.direct_entry_audit_events"
    + " where resource_ref = 'SEASONAL' and action = 'labor_type_set_active'")).rows[0];
  assert.deepEqual(audit.changed_fields, ["active"]);
  assert.equal((await db.query(
    "select count(*)::int as n from public.direct_entry_labor_types where labor_type_key = 'SEASONAL'"
  )).rows[0].n, 1, "there is no hard delete");

  const unchanged = await setLaborTypeActiveError(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "SEASONAL", active: false, expectedVersion: off.version, idempotencyKey: KEY("0d"),
  });
  assert.equal(unchanged.code, "22023");
  const stale = await setLaborTypeActiveError(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "SEASONAL", active: true, expectedVersion: created.version, idempotencyKey: KEY("0e"),
  });
  assert.equal(stale.code, "PT409");
  const missingFlag = await setLaborTypeActiveError(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "SEASONAL", active: null, expectedVersion: off.version, idempotencyKey: KEY("0f"),
  });
  assert.equal(missingFlag.code, "22023");

  const on = await setLaborTypeActive(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "SEASONAL", active: true, expectedVersion: off.version, idempotencyKey: KEY("10"),
  });
  assert.equal(on.active, true);
  assert.equal(on.version, created.version + 2);
  const afterOn = await counts(db);
  assert.equal(afterOn.labor_types, before.labor_types);
  assert.equal(afterOn.revisions, afterOff.revisions + 1);
  assert.equal(afterOn.audits, afterOff.audits + 1);
});

test("9: direct_entries.labor_type is a validated restrictive foreign key", async () => {
  const fk = (await db.query(
    "select conname, convalidated, pg_get_constraintdef(oid) as definition from pg_constraint"
    + " where conrelid = 'public.direct_entries'::regclass"
    + "   and conname = 'direct_entries_labor_type_fkey'")).rows;
  assert.equal(fk.length, 1, "the hard labor-type foreign key exists");
  assert.equal(fk[0].convalidated, true, "the foreign key is validated, not merely declared");
  assert.match(fk[0].definition, /FOREIGN KEY \(labor_type\)/);
  assert.match(fk[0].definition, /REFERENCES direct_entry_labor_types\(labor_type_key\)/);
  assert.match(fk[0].definition, /ON UPDATE RESTRICT/);
  assert.match(fk[0].definition, /ON DELETE RESTRICT/);

  let deleteCode = null;
  try {
    await db.query("delete from public.direct_entry_labor_types where labor_type_key = 'PERMANENT'");
  } catch (error) {
    deleteCode = error.code;
  }
  // ON DELETE RESTRICT reports restrict_violation, not a deferred FK violation.
  assert.equal(deleteCode, "23001", "a referenced catalog row can never be deleted");
  assert.equal((await db.query(
    "select count(*)::int as n from public.direct_entry_labor_types where labor_type_key = 'PERMANENT'"
  )).rows[0].n, 1);
  assert.equal((await db.query(
    "select labor_type from public.direct_entries where entry_id = $1::uuid",
    [PERMANENT_ENTRY])).rows[0].labor_type, "PERMANENT", "the referencing entry is intact");
});

test("10: the active-write guard rejects inactive and unknown keys but keeps history editable", async () => {
  const created = await createLaborType(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "GUARDED", displayName: "Đã khoá", sortOrder: 80, idempotencyKey: KEY("11"),
  });
  const off = await setLaborTypeActive(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "GUARDED", active: false, expectedVersion: created.version, idempotencyKey: KEY("12"),
  });
  assert.equal(off.active, false);

  const inactive = await directEntryProbe(db, "hrp-2026-410001", "GUARDED");
  assert.equal(inactive.code, "23514", "an inactive key is never an acceptable new write");
  assert.equal(inactive.entry_id, null);

  const unknown = await directEntryProbe(db, "hrp-2026-410002", UNKNOWN_KEY);
  assert.equal(unknown.code, "23514", "an unknown key is never an acceptable new write");

  const active = await directEntryProbe(db, "hrp-2026-410003", "TEMPORARY");
  assert.equal(active.code, null, "an active catalog key is accepted");
  assert.equal(typeof active.entry_id, "string");

  assert.equal((await db.query(
    "select count(*)::int as n from public.direct_entries where employee_code in"
    + " ('hrp-2026-410001', 'hrp-2026-410002')")).rows[0].n, 0,
  "a rejected write stores nothing");

  // Historical rows stay editable: an update that does not change the value is
  // not re-validated against the active catalog.
  const retiredVersion = await currentVersion(db, "OUTSOURCED");
  const retire = await setLaborTypeActive(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "OUTSOURCED", active: false, expectedVersion: retiredVersion,
    idempotencyKey: KEY("13"),
  });
  assert.equal(retire.active, false);
  const edited = await db.query(
    "update public.direct_entries set labor_type = 'OUTSOURCED', version = version + 1,"
    + " general_note = $2 where entry_id = $1::uuid",
    [OUTSOURCED_ENTRY, "Synthetic historical edit"]);
  assert.equal(edited.affectedRows, 1, "a historical row whose key was deactivated stays editable");

  let switchCode = null;
  try {
    await db.query("update public.direct_entries set labor_type = 'GUARDED', version = version + 1"
      + " where entry_id = $1::uuid", [PERMANENT_ENTRY]);
  } catch (error) {
    switchCode = error.code;
  }
  assert.equal(switchCode, "23514", "switching TO an inactive key is still rejected");
  assert.equal((await db.query(
    "select labor_type from public.direct_entries where entry_id = $1::uuid",
    [PERMANENT_ENTRY])).rows[0].labor_type, "PERMANENT");
});

test("11: an entry stored under a deactivated key stays readable", async () => {
  const stored = (await db.query(
    "select labor_type from public.direct_entries where entry_id = $1::uuid",
    [OUTSOURCED_ENTRY])).rows[0];
  assert.equal(stored.labor_type, "OUTSOURCED");
  const catalog = (await db.query(
    "select active from public.direct_entry_labor_types where labor_type_key = 'OUTSOURCED'")).rows[0];
  assert.equal(catalog.active, false, "the key is inactive: not choosable");

  const projection = await rpc(db, "direct_entry_read_projection", {
    p_auth_subject: ENTRY_OPERATOR.auth, p_app_user_id: ENTRY_OPERATOR.app,
    p_entry_id: OUTSOURCED_ENTRY,
  });
  assert.equal(projection.labor_type, "OUTSOURCED",
    "readable: an inactive key is still returned for a stored row");
  assert.equal(projection.entry_id, OUTSOURCED_ENTRY);

  // The admin surface keeps returning the inactive row, and reporting keeps
  // resolving its dimension key.
  const detail = await getLaborType(db, OPERATOR_FULL_ADMIN, "OUTSOURCED");
  assert.equal(detail.active, false);
  assert.equal(detail.reporting_key, "gia công");
  const reporting = (await db.query(
    "select public.direct_entry_reporting_employment_key('OUTSOURCED') as k,"
    + " public.direct_entry_reporting_employment_display('OUTSOURCED') as d")).rows[0];
  assert.equal(reporting.k, "gia công");
  assert.equal(reporting.d, "Gia công");

  // But it is no longer offered to the runtime.
  const options = (await db.query("select public.direct_entry_labor_type_options() as d")).rows[0].d;
  assert.equal(options.some((row) => row.labor_type_key === "OUTSOURCED"), false);

  // Restore the seed for the remaining assertions.
  const restore = await setLaborTypeActive(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "OUTSOURCED", active: true,
    expectedVersion: await currentVersion(db, "OUTSOURCED"), idempotencyKey: KEY("14"),
  });
  assert.equal(restore.active, true);
});

test("12: idempotent replays return the stored result and a reused key with other input conflicts", async () => {
  const created = await createLaborType(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "IDEMPOTENT", displayName: "Bất biến", sortOrder: 90, idempotencyKey: KEY("15"),
  });
  const afterCreate = await counts(db);
  const createReplay = await createLaborType(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "IDEMPOTENT", displayName: "Bất biến", sortOrder: 90, idempotencyKey: KEY("15"),
  });
  assert.deepEqual(createReplay, created, "the replay returns the stored result");
  assert.deepEqual(await counts(db), afterCreate, "the replay writes no second revision");
  // Documented contract for this exact case: 'idempotency key reused with
  // different input'. Rejections are compared by SQLSTATE only, so the raw
  // message is deliberately never read.
  const createConflict = await rpcError(db, "direct_entry_create_labor_type", {
    p_auth_subject: OPERATOR_FULL_ADMIN.auth, p_app_user_id: OPERATOR_FULL_ADMIN.app,
    p_expected_version: 0, p_labor_type_key: "IDEMPOTENT", p_display_name: "Khác hẳn",
    p_sort_order: 90, p_reason: REASON, p_idempotency_key: KEY("15"),
  });
  assert.equal(createConflict.code, "22023");
  assert.deepEqual(await counts(db), afterCreate, "a conflicting replay leaves zero residue");

  const updated = await updateLaborType(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "IDEMPOTENT", expectedVersion: created.version, displayName: "Bất biến đổi",
    sortOrder: 91, idempotencyKey: KEY("16"),
  });
  const afterUpdate = await counts(db);
  const updateReplay = await updateLaborType(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "IDEMPOTENT", expectedVersion: created.version, displayName: "Bất biến đổi",
    sortOrder: 91, idempotencyKey: KEY("16"),
  });
  assert.deepEqual(updateReplay, updated);
  assert.deepEqual(await counts(db), afterUpdate);
  const updateConflict = await rpcError(db, "direct_entry_update_labor_type", {
    p_auth_subject: OPERATOR_FULL_ADMIN.auth, p_app_user_id: OPERATOR_FULL_ADMIN.app,
    p_labor_type_key: "IDEMPOTENT", p_expected_version: created.version,
    p_display_name: "Khác hẳn nữa", p_sort_order: 91, p_reason: REASON,
    p_idempotency_key: KEY("16"),
  });
  assert.equal(updateConflict.code, "22023");
  assert.deepEqual(await counts(db), afterUpdate);

  const off = await setLaborTypeActive(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "IDEMPOTENT", active: false, expectedVersion: updated.version,
    idempotencyKey: KEY("17"),
  });
  const afterOff = await counts(db);
  const setActiveReplay = await setLaborTypeActive(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "IDEMPOTENT", active: false, expectedVersion: updated.version,
    idempotencyKey: KEY("17"),
  });
  assert.deepEqual(setActiveReplay, off);
  assert.deepEqual(await counts(db), afterOff);
  const setActiveConflict = await setLaborTypeActiveError(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "IDEMPOTENT", active: true, expectedVersion: updated.version,
    idempotencyKey: KEY("17"),
  });
  assert.equal(setActiveConflict.code, "22023");
  assert.deepEqual(await counts(db), afterOff);

  const revisions = (await db.query(
    "select version from public.direct_entry_labor_type_revisions where labor_type_key = 'IDEMPOTENT'"
    + " order by version")).rows.map((row) => row.version);
  assert.deepEqual(revisions, [1, 2, 3], "exactly one revision per version, no replay duplicate");
});

test("13: only the two catalog-operator authority paths are accepted, every other actor is denied", async () => {
  const before = await counts(db);
  const denied = [
    [ENTRY_ADMIN_ALL_ONLY, "entry_admin with all scope alone"],
    [PROJECT_MANAGER, "project manager on a team scope"],
    [STAFF, "staff on an own scope"],
    [DISABLED_OPERATOR, "disabled catalog operator"],
    [UNMAPPED_OPERATOR, "actor with no app-user row"],
    [MISMATCHED_OPERATOR, "mismatched app_user/auth pair"],
  ];
  const calls = [
    ["direct_entry_list_labor_types_admin", { p_include_inactive: true, p_page: 1, p_page_size: 25 }],
    ["direct_entry_get_labor_type_admin", { p_labor_type_key: "TEMPORARY" }],
    ["direct_entry_create_labor_type", { p_expected_version: 0, p_labor_type_key: "W02C_DENIED",
      p_display_name: "Denied", p_sort_order: 95, p_reason: REASON, p_idempotency_key: KEY("18") }],
    ["direct_entry_update_labor_type", { p_labor_type_key: "TEMPORARY", p_expected_version: 1,
      p_display_name: "Denied Rename", p_sort_order: 10, p_reason: REASON,
      p_idempotency_key: KEY("19") }],
    ["direct_entry_set_labor_type_active", { p_labor_type_key: "TEMPORARY", p_active: false,
      p_expected_version: 1, p_reason: REASON, p_idempotency_key: KEY("1a") }],
  ];

  for (const [actor, label] of denied) {
    for (const [name, args] of calls) {
      const outcome = await rpcOutcome(db, name, {
        p_auth_subject: actor.auth, p_app_user_id: actor.app, ...args,
      });
      assert.equal(outcome.denied, true, label + " / " + name + " must be denied");
      assert.equal(outcome.code, "42501", label + " / " + name);
      assert.equal(outcome.payload, null, label + " / " + name + " must carry no usable payload");
    }
  }
  assert.deepEqual(await counts(db), before, "every denial leaves zero residue");

  // The two authority paths still work after every denial above.
  const listAsFullAdmin = await listLaborTypes(db, OPERATOR_FULL_ADMIN, { pageSize: 1 });
  assert.equal(listAsFullAdmin.total >= 3, true);
  const listAsAccounting = await listLaborTypes(db, OPERATOR_ACCOUNTING, { pageSize: 1 });
  assert.equal(listAsAccounting.total >= 3, true);

  const beforeInput = await rpcOutcome(db, "direct_entry_input_catalog", {
    p_auth_subject: UNMAPPED_OPERATOR.auth, p_app_user_id: UNMAPPED_OPERATOR.app,
    p_effective_date: WORK_DATE,
  });
  assert.equal(beforeInput.denied, true);
  assert.equal(beforeInput.code, "42501");

  // A denied actor never learns the payload shape, even with a malformed one.
  const shapeLeak = await rpcOutcome(db, "direct_entry_create_labor_type", {
    p_auth_subject: STAFF.auth, p_app_user_id: STAFF.app, p_expected_version: null,
    p_labor_type_key: null, p_display_name: null, p_sort_order: null, p_reason: null,
    p_idempotency_key: null,
  });
  assert.equal(shapeLeak.denied, true);
  assert.equal(shapeLeak.code, "42501", "authorization precedes payload validation");
});

test("14: every projection is a strict, documented key set", async () => {
  const created = await createLaborType(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "STRICT", displayName: "Nghiêm ngặt", sortOrder: 100, idempotencyKey: KEY("1b"),
  });
  const list = await listLaborTypes(db, OPERATOR_FULL_ADMIN, { search: "STRICT", pageSize: 25 });
  const detail = await getLaborType(db, OPERATOR_FULL_ADMIN, "STRICT");
  const updated = await updateLaborType(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "STRICT", expectedVersion: created.version, displayName: "Nghiêm ngặt hơn",
    sortOrder: 101, idempotencyKey: KEY("1c"),
  });
  const active = await setLaborTypeActive(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "STRICT", active: false, expectedVersion: updated.version, idempotencyKey: KEY("1d"),
  });

  assert.deepEqual(Object.keys(list).sort(), [...LIST_KEYS].sort());
  assert.equal(sortedKeys(list.labor_types[0]), [...ITEM_KEYS].sort().join(","));
  assert.equal(sortedKeys(detail), [...ITEM_KEYS].sort().join(","));
  assert.equal(sortedKeys(created), [...CREATE_KEYS].sort().join(","));
  assert.equal(sortedKeys(updated), [...MUTATION_KEYS].sort().join(","));
  assert.equal(sortedKeys(active), [...MUTATION_KEYS].sort().join(","));

  const keys = [
    ...Object.keys(list), ...Object.keys(detail), ...Object.keys(created),
    ...Object.keys(updated), ...Object.keys(active), ...Object.keys(list.labor_types[0]),
  ].map((key) => key.toLowerCase());
  for (const forbidden of ["auth_subject", "email", "grant_id", "reason", "idempotency",
    "capability", "scope"]) {
    for (const key of keys) {
      assert.equal(key.includes(forbidden), false, "projection key leaked " + forbidden);
    }
  }

  const text = JSON.stringify({ list, detail, created, updated, active });
  for (const forbidden of [OPERATOR_FULL_ADMIN.auth, OPERATOR_FULL_ADMIN.app, OPERATOR_ACCOUNTING.app,
    "auth_subject", "app_user_id", "email", "grant_id", "reason_id", "idempotency",
    "capability", "scope_kind", REASON]) {
    assert.equal(text.includes(forbidden), false, "projection leaked " + forbidden);
  }
  assert.equal(text.includes("revision_id"), true, "the mutation row still carries its revision id");

  const restore = await setLaborTypeActive(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "STRICT", active: true, expectedVersion: active.version, idempotencyKey: KEY("1e"),
  });
  assert.equal(restore.active, true);
});

test("15: the catalog carries no Vendor, provider or team meaning", async () => {
  const columns = (await db.query(
    "select column_name from information_schema.columns where table_schema = 'public'"
    + " and table_name in ('direct_entry_labor_types', 'direct_entry_labor_type_revisions')"
  )).rows.map((row) => row.column_name);
  assert.equal(columns.length > 0, true);
  for (const forbidden of ["vendor", "provider", "team", "recruiter", "project", "bank"]) {
    assert.equal(columns.some((column) => column.includes(forbidden)), false,
      "no catalog column carries " + forbidden + " meaning");
  }

  const definitions = (await db.query(
    "select p.proname, pg_get_functiondef(p.oid) as definition from pg_proc p"
    + " join pg_namespace n on n.oid = p.pronamespace"
    + " where n.nspname = 'public' and p.proname = any($1::text[])", [CATALOG_FUNCTIONS])).rows;
  assert.equal(definitions.length, CATALOG_FUNCTIONS.length);
  for (const row of definitions) {
    for (const forbidden of ["public.vendors", "public.recruiters", "public.teams",
      "vendor_id", "provider_type", "team_id"]) {
      assert.equal(row.definition.includes(forbidden), false,
        row.proname + " reads " + forbidden);
    }
  }
});

test("16: reporting follows the catalog through the reporting key and the display name", async () => {
  const mapping = (await db.query(
    "select t.labor_type_key,"
    + " public.direct_entry_reporting_employment_key(t.labor_type_key) as key,"
    + " public.direct_entry_reporting_employment_display(t.labor_type_key) as display"
    + " from public.direct_entry_labor_types t order by t.sort_order, t.labor_type_key")).rows;
  const byKey = Object.fromEntries(mapping.map((row) => [row.labor_type_key, row]));
  assert.equal(byKey.TEMPORARY.key, "thời vụ");
  assert.equal(byKey.PERMANENT.key, "chính thức");
  assert.equal(byKey.OUTSOURCED.key, "gia công");
  assert.equal(byKey.TEMPORARY.display, "Thời vụ");
  assert.equal(byKey.PERMANENT.display, "Chính thức");
  assert.equal(byKey.OUTSOURCED.display, "Gia công");

  const unknown = (await db.query(
    "select public.direct_entry_reporting_employment_key($1) as key,"
    + " public.direct_entry_reporting_employment_display($1) as display",
    [UNKNOWN_KEY])).rows[0];
  assert.equal(unknown.key, "__unknown__", "an unknown key stays fail closed");
  assert.equal(unknown.display, "Không xác định");
  const blank = (await db.query(
    "select public.direct_entry_reporting_employment_key($1) as key,"
    + " public.direct_entry_reporting_employment_display($1) as display", [null])).rows[0];
  assert.equal(blank.key, "__unknown__", "a null labor type never resolves to a label");
  assert.equal(blank.display, "Không xác định");

  // The stored entry key is the canonical key, never the reporting key.
  assert.equal((await db.query(
    "select labor_type from public.direct_entries order by employee_code limit 1")).rows[0].labor_type,
  "PERMANENT");

  // Renaming the display label changes what is shown, nothing else.
  const before = await getLaborType(db, OPERATOR_FULL_ADMIN, "PERMANENT");
  const renamed = await updateLaborType(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "PERMANENT", expectedVersion: before.version,
    displayName: "Chính thức (đổi tên)", sortOrder: before.sort_order, idempotencyKey: KEY("1f"),
  });
  assert.equal(renamed.display_name, "Chính thức (đổi tên)");
  assert.equal(renamed.reporting_key, "chính thức", "a rename never touches the reporting key");
  const afterRename = (await db.query(
    "select public.direct_entry_reporting_employment_key('PERMANENT') as key,"
    + " public.direct_entry_reporting_employment_display('PERMANENT') as display")).rows[0];
  assert.equal(afterRename.key, "chính thức");
  assert.equal(afterRename.display, "Chính thức (đổi tên)", "the display follows the rename");
  assert.equal((await db.query(
    "select labor_type from public.direct_entries where entry_id = $1::uuid",
    [PERMANENT_ENTRY])).rows[0].labor_type, "PERMANENT",
  "the stored entry key never changes");

  const restored = await updateLaborType(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "PERMANENT", expectedVersion: renamed.version, displayName: "Chính thức",
    sortOrder: before.sort_order, idempotencyKey: KEY("20"),
  });
  assert.equal(restored.display_name, "Chính thức");
  const afterRestore = (await db.query(
    "select public.direct_entry_reporting_employment_display('PERMANENT') as display")).rows[0];
  assert.equal(afterRestore.display, "Chính thức");
});

test("17: the four duplicated label CASE sites are gone", async () => {
  const facts = (await db.query(
    "select pg_get_viewdef('public.direct_entry_reporting_facts_v01'::regclass) as definition")).rows[0].definition;
  const options = (await db.query(
    "select coalesce(pg_get_viewdef('public.direct_entry_reporting_dimension_options_v01'::regclass), '')"
    + " as definition")).rows[0].definition;
  const scoped = (await db.query(
    "select pg_get_functiondef("
    + "'public.direct_entry_reporting_de_options_scoped(uuid,uuid)'::regprocedure) as definition"
  )).rows[0].definition;

  for (const [label, definition] of [["facts_v01", facts], ["dimension_options_v01", options],
    ["de_options_scoped", scoped]]) {
    for (const literal of ["Thời vụ", "Chính thức", "TEMPORARY", "PERMANENT", "OUTSOURCED"]) {
      assert.equal(definition.includes(literal), false,
        label + " still hard-codes the retired label " + literal);
    }
  }
  assert.equal(facts.includes("direct_entry_reporting_employment_key"), true);
  assert.equal(facts.includes("direct_entry_reporting_employment_display"), true);
  assert.equal(options.includes("direct_entry_reporting_employment_key"), true);
  assert.equal(options.includes("direct_entry_reporting_employment_display"), true);
  assert.equal(scoped.includes("employment_type_key"), true);
  assert.equal(scoped.includes("employment_type_display"), true);
});

test("18: the ACL posture is service-role only, with revoked helpers and forced RLS", async () => {
  for (const signature of RPC_SIGNATURES) {
    const { rows } = await db.query(
      "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_exec,"
      + " has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon_exec,"
      + " has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth_exec,"
      + " p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as config,"
      + " coalesce(p.proacl is null, true) as acl_is_default"
      + " from pg_proc p where p.oid = $1::regprocedure", [signature]);
    assert.equal(rows.length, 1, signature);
    assert.deepEqual([rows[0].service_exec, rows[0].anon_exec, rows[0].auth_exec], [true, false, false],
      signature);
    assert.equal(rows[0].prosecdef, true, signature + " must be SECURITY DEFINER");
    assert.equal(rows[0].config.includes("search_path=pg_catalog, public"), true, signature);
    const publicExec = (await db.query(
      "select count(*)::int as n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a"
      + " where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'",
      [signature])).rows[0].n;
    assert.equal(publicExec, 0, signature + " must not be executable by PUBLIC");
  }

  for (const signature of HELPER_SIGNATURES) {
    const { rows } = await db.query(
      "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_exec,"
      + " has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon_exec,"
      + " has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth_exec"
      + " from pg_proc p where p.oid = $1::regprocedure", [signature]);
    assert.equal(rows.length, 1, signature);
    assert.deepEqual([rows[0].service_exec, rows[0].anon_exec, rows[0].auth_exec], [false, false, false],
      signature + " must be executable by no role");
    const publicExec = (await db.query(
      "select count(*)::int as n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a"
      + " where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'",
      [signature])).rows[0].n;
    assert.equal(publicExec, 0, signature + " must not be executable by PUBLIC");
  }

  for (const table of CATALOG_TABLES) {
    const { rows } = await db.query(
      "select c.relrowsecurity, c.relforcerowsecurity,"
      + " has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as service_dml,"
      + " has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as anon_dml,"
      + " has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as auth_dml"
      + " from pg_class c join pg_namespace n on n.oid = c.relnamespace"
      + " where n.nspname = 'public' and c.oid = $1::regclass", [table]);
    assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity], [true, true],
      table + " must enable and force RLS");
    assert.deepEqual([rows[0].service_dml, rows[0].anon_dml, rows[0].auth_dml], [false, false, false],
      table + " must grant nothing to any role");
    const granted = (await db.query(
      "select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace"
      + " left join lateral aclexplode(c.relacl) a on true"
      + " where n.nspname = 'public' and c.oid = $1::regclass"
      + "   and (c.relacl is null or (a.grantee <> c.relowner and a.privilege_type is not null))",
      [table])).rows[0].n;
    assert.equal(granted, 0, table + " must carry no non-owner grant");
  }

  const triggers = (await db.query(
    "select tg.tgname from pg_trigger tg join pg_class c on c.oid = tg.tgrelid"
    + " join pg_namespace n on n.oid = c.relnamespace"
    + " where n.nspname = 'public' and c.relname = 'direct_entry_labor_type_revisions'"
    + "   and not tg.tgisinternal")).rows.map((row) => row.tgname);
  assert.deepEqual(triggers, ["direct_entry_labor_type_revisions_immutable"]);

  await assert.rejects(
    db.exec("update public.direct_entry_labor_type_revisions set version = version"),
    (error) => error.code === "55000");
  await assert.rejects(
    db.exec("delete from public.direct_entry_labor_type_revisions"),
    (error) => error.code === "55000");

  await db.query("begin");
  await db.query("set local role service_role");
  let revisionRead = null;
  try {
    await db.query("select count(*) from public.direct_entry_labor_type_revisions");
  } catch (error) {
    revisionRead = error.code;
  }
  await db.query("rollback");
  assert.equal(revisionRead, "42501", "the revision history stays unreadable to service_role");

  await db.query("begin");
  await db.query("set local role service_role");
  let catalogRead = null;
  try {
    await db.query("select count(*) from public.direct_entry_labor_types");
  } catch (error) {
    catalogRead = error.code;
  }
  await db.query("rollback");
  assert.equal(catalogRead, "42501", "the catalog table stays unreadable to service_role");

  await db.query("begin");
  await db.query("set local role anon");
  let anonCall = null;
  try {
    await db.query("select public.direct_entry_list_labor_types_admin($1::uuid, $2::uuid, null, true, 1, 25)",
      [OPERATOR_FULL_ADMIN.auth, OPERATOR_FULL_ADMIN.app]);
  } catch (error) {
    anonCall = error.code;
  }
  await db.query("rollback");
  assert.equal(anonCall, "42501", "anon never reaches a labor type RPC");
});

test("19: the retired closed set is gone and a legacy value aborts migration #79", async () => {
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.equal(names.indexOf(NEW_MIGRATION), 78, "#79 stays the catalog migration");
  assert.equal(names.indexOf(R2_MIGRATION), 79, "#80 stays the display projection migration");
  assert.equal(names.indexOf(R3_MIGRATION), 80, "#81 remains before W03A");
  assert.equal(names.indexOf("20261011150000_p3_1_w03a_app_user_lifecycle.sql"), 81, "#82 is the W03A migration");
  assert.equal(names.indexOf("20261011160000_p3_1_w03a_r2_account_read.sql"), 82, "#83 is the W03A-R2 read migration");
  assert.equal(names.indexOf("20261011170000_p3_1_w03a_r2_r1_account_read_repair.sql"), 83, "#84 repairs the W03A-R2 read contract");
  assert.equal(new Set(names).size, names.length, "the ledger carries no duplicate slot");

  const closedSetQuery =
    "select count(*)::int as n from pg_constraint c"
    + " join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace"
    + " where n.nspname = 'public' and t.relname = 'direct_entries' and c.contype = 'c'"
    + "   and pg_get_constraintdef(c.oid) like '%labor_type%'"
    + "   and pg_get_constraintdef(c.oid) like '%TEMPORARY%'";
  assert.equal((await db.query(closedSetQuery)).rows[0].n, 0,
    "a normal full migration retires the closed-set CHECK");

  // A separate database that carries every migration EXCEPT #79 and the #80 display
  // projection that builds on it.
  const legacy = new PGlite();
  await legacy.exec(AUTH_PROLOGUE);
  for (const name of names.slice(0, names.indexOf(NEW_MIGRATION))) {
    await legacy.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }

  const check = (await legacy.query(
    "select c.conname, pg_get_constraintdef(c.oid) as definition from pg_constraint c"
    + " join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace"
    + " where n.nspname = 'public' and t.relname = 'direct_entries' and c.contype = 'c'"
    + "   and pg_get_constraintdef(c.oid) like '%labor_type%'"
    + "   and pg_get_constraintdef(c.oid) like '%TEMPORARY%'")).rows;
  assert.equal(check.length, 1, "the closed-set CHECK is real before #79");
  assert.match(check[0].definition, /TEMPORARY/);

  // Legacy storage fixture: an actor, an active team, an HRP recruiter with
  // its memberships, a project, and one entry written by hand.
  await legacy.query("insert into auth.users (id) values ($1::uuid)", [ENTRY_OPERATOR.auth]);
  await legacy.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)"
    + " values ($1::uuid, $2::uuid, true, 'Synthetic Legacy Actor')",
    [ENTRY_OPERATOR.app, ENTRY_OPERATOR.auth]);
  await legacy.query("insert into public.teams (team_id, code, display_name, active)"
    + " values ($1::uuid, 'W02C_LEGACY', 'Synthetic Legacy Team', true)", [TEAM_ID]);
  await legacy.query("insert into public.recruiters (recruiter_id, display_name, active, version)"
    + " values ($1::uuid, 'Synthetic Legacy Recruiter', true, 1)", [RECRUITER_ID]);
  await legacy.query("insert into public.recruiter_provider_memberships"
    + " (recruiter_id, provider_type, valid_from) values ($1::uuid, 'hrp', $2::date)",
    [RECRUITER_ID, VALID_FROM]);
  await legacy.query("insert into public.recruiter_team_memberships"
    + " (recruiter_id, team_id, valid_from) values ($1::uuid, $2::uuid, $3::date)",
    [RECRUITER_ID, TEAM_ID, VALID_FROM]);
  await legacy.query("insert into public.direct_entry_projects (project_id, display_name)"
    + " values ($1, 'Synthetic Legacy Project')", [PROJECT_ID]);

  // The closed set is dropped by hand, exactly as the migration would, so a
  // legacy value that the catalog cannot resolve can be stored.
  await legacy.query("alter table public.direct_entries drop constraint " + check[0].conname);
  assert.equal((await legacy.query(closedSetQuery)).rows[0].n, 0);

  await legacy.query("begin");
  const legacySubmission = (await legacy.query(
    "insert into public.direct_entry_submissions (created_by_user_id) values ($1::uuid)"
    + " returning submission_id", [ENTRY_OPERATOR.app])).rows[0].submission_id;
  const legacyCandidate = (await legacy.query(
    "insert into public.direct_entry_candidates default values returning candidate_id",
  )).rows[0].candidate_id;
  await legacy.query(
    "insert into public.direct_entries"
    + " (submission_id, candidate_id, created_by_user_id, project_id, first_work_date,"
    + "  employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type)"
    + " values ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6, $7::jsonb, $8::uuid, $9::uuid,"
    + " 'hrp', 'LEGACY_UNKNOWN')",
    [legacySubmission, legacyCandidate, ENTRY_OPERATOR.app, PROJECT_ID, WORK_DATE,
      "hrp-2026-420001", WORKER_DETAILS, RECRUITER_ID, TEAM_ID]);
  await legacy.query("commit");
  assert.equal((await legacy.query(
    "select labor_type from public.direct_entries where employee_code = 'hrp-2026-420001'"
  )).rows[0].labor_type, "LEGACY_UNKNOWN");

  // Applying #79 must abort: the resolve-and-verify step refuses to orphan the
  // legacy value instead of backfilling or guessing.
  const migrationSql = await readFile(path.join(MIGRATION_DIR, NEW_MIGRATION), "utf8");
  let migrationCode = null;
  try {
    await legacy.exec(migrationSql);
  } catch (error) {
    migrationCode = error.code;
  }
  try {
    await legacy.exec("rollback");
  } catch {
    // the failed script already closed its transaction
  }
  assert.equal(migrationCode, "55000", "a legacy labor_type aborts migration #79");

  assert.equal((await legacy.query(
    "select to_regclass('public.direct_entry_labor_types') is null as absent")).rows[0].absent, true,
  "the aborted migration created no catalog table");
  assert.equal((await legacy.query(
    "select to_regclass('public.direct_entry_labor_type_revisions') is null as absent"
  )).rows[0].absent, true, "the aborted migration created no revision table");
  assert.equal((await legacy.query(
    "select count(*)::int as n from pg_constraint where conrelid = 'public.direct_entries'::regclass"
    + " and conname = 'direct_entries_labor_type_fkey'")).rows[0].n, 0,
  "the aborted migration added no foreign key");
  assert.equal((await legacy.query(
    "select labor_type from public.direct_entries where employee_code = 'hrp-2026-420001'"
  )).rows[0].labor_type, "LEGACY_UNKNOWN", "the legacy row is untouched");
});

test("20: the active projection exposes only active rows and only three keys", async () => {
  const optionsQuery = "select public.direct_entry_labor_type_options() as definition";
  const options = (await db.query(optionsQuery)).rows[0].definition;
  assert.ok(Array.isArray(options));
  assert.equal(options.length >= 3, true);
  for (const row of options) {
    assert.deepEqual(Object.keys(row).sort(), [...OPTION_KEYS].sort(),
      "the operational projection is exactly key, display name and sort order");
  }
  assert.equal(JSON.stringify(options).includes("reporting_key"), false,
    "the runtime projection never exposes the reporting key");

  const expected = (await db.query(
    "select labor_type_key, display_name, sort_order from public.direct_entry_labor_types"
    + " where active order by sort_order, labor_type_key")).rows;
  assert.deepEqual(options, expected.map((row) => ({
    labor_type_key: row.labor_type_key, display_name: row.display_name, sort_order: row.sort_order,
  })), "the projection is exactly the active rows in catalog order");
  assert.equal(options.some((row) => row.labor_type_key === "GUARDED"), false,
    "an inactive key is never offered");

  const created = await createLaborType(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "PEAK", displayName: "Cao điểm", sortOrder: 5, idempotencyKey: KEY("21"),
  });
  const withPeak = (await db.query(optionsQuery)).rows[0].definition;
  assert.equal(withPeak[0].labor_type_key, "PEAK", "the new type is ordered by sort order");
  const liveOrder = (await db.query(
    "select labor_type_key from public.direct_entry_labor_types where active"
    + " order by sort_order, labor_type_key")).rows.map((row) => row.labor_type_key);
  assert.deepEqual(withPeak.map((row) => row.labor_type_key), liveOrder);

  const off = await setLaborTypeActive(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "PEAK", active: false, expectedVersion: created.version, idempotencyKey: KEY("22"),
  });
  const withoutPeak = (await db.query(optionsQuery)).rows[0].definition;
  assert.equal(withoutPeak.some((row) => row.labor_type_key === "PEAK"), false,
    "deactivation removes the option immediately");

  const on = await setLaborTypeActive(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "PEAK", active: true, expectedVersion: off.version, idempotencyKey: KEY("23"),
  });
  assert.equal(on.active, true);
  assert.equal((await db.query(optionsQuery)).rows[0].definition
    .some((row) => row.labor_type_key === "PEAK"), true);
});

test("21: the Direct Entry runtime receives the active catalog through the input catalog", async () => {
  const catalog = await rpc(db, "direct_entry_input_catalog", {
    p_auth_subject: ENTRY_OPERATOR.auth, p_app_user_id: ENTRY_OPERATOR.app,
    p_effective_date: WORK_DATE,
  });
  assert.equal("labor_types" in catalog, true, "the input catalog exposes the active labor types");
  const options = (await db.query("select public.direct_entry_labor_type_options() as definition"))
    .rows[0].definition;
  assert.deepEqual(catalog.labor_types, options,
    "the runtime receives exactly the canonical active projection");

  const activeKeys = (await db.query(
    "select labor_type_key from public.direct_entry_labor_types where active")).rows
    .map((row) => row.labor_type_key);
  assert.equal(catalog.labor_types.length, activeKeys.length);
  for (const row of catalog.labor_types) {
    assert.equal(activeKeys.includes(row.labor_type_key), true, "every option is an active key");
    assert.deepEqual(Object.keys(row).sort(), [...OPTION_KEYS].sort());
  }
  assert.equal(JSON.stringify(catalog.labor_types).includes("reporting_key"), false);

  // No parallel route and no second label map: the catalog key is resolved by
  // the one shared projection function. The projection returned above is the
  // behavioural assertion; this one pins WHERE the key is attached, so the
  // wrapper that enforces per-actor project scope stays byte-untouched.
  const definition = (await db.query(
    "select pg_get_functiondef("
    + "'public.direct_entry_input_catalog_unscoped_v42(uuid,uuid,date)'::regprocedure)"
    + " as definition")).rows[0].definition;
  assert.equal(definition.includes("direct_entry_labor_type_options"), true);
  const surface = (await db.query(
    "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace"
    + " where n.nspname = 'public' and p.proname like '%labor_type%' order by p.proname")).rows
    .map((row) => row.proname);
  assert.deepEqual(surface, CATALOG_FUNCTIONS.slice().sort(),
    "the labor-type surface is exactly the reviewed functions, with no parallel route");

  const denied = await rpcOutcome(db, "direct_entry_input_catalog", {
    p_auth_subject: UNMAPPED_OPERATOR.auth, p_app_user_id: UNMAPPED_OPERATOR.app,
    p_effective_date: WORK_DATE,
  });
  assert.equal(denied.denied, true);
  assert.equal(denied.code, "42501");
  assert.equal(denied.payload, null);
});

// ---------------------------------------------------------------------------
// P3.1-W02C-R1: the catalog is only DYNAMIC if a key created after the fact
// survives every backend boundary. These three tests create PROBATION through
// the admin RPC and prove the write path, the entry read projection, the runtime
// catalog and the worker directory all carry it; then that deactivating it fails
// closed for new writes with zero residue while history stays readable and the
// key silently leaves the choosable options.
// ---------------------------------------------------------------------------

let PROBATION_ENTRY = null;

test("22: the dynamically created PROBATION key reaches a write, the entry read and the runtime catalog", async () => {
  // PROBATION is not a seed row and not a source constant: it was created through
  // the admin RPC earlier in this file. Everything below proves that a key only
  // the runtime catalog knows about survives the whole backend - the blocker this
  // revision exists to close.
  const created = await getLaborType(db, OPERATOR_FULL_ADMIN, "PROBATION");
  assert.equal(created.labor_type_key, "PROBATION");
  assert.equal(created.active, true, "the dynamic key is active before the write");
  assert.equal(created.reporting_key, "probation", "the reporting key stays server generated");

  // The retired closed set used to answer here, before the database guard saw
  // the key at all. Now the catalog decides and PROBATION is an ordinary write.
  const probe = await directEntryProbe(db, "hrp-2026-420001", "PROBATION");
  assert.equal(probe.code, null, "a newly created ACTIVE key is an acceptable new write");
  assert.equal(typeof probe.entry_id, "string");
  PROBATION_ENTRY = probe.entry_id;

  const projection = await rpc(db, "direct_entry_read_projection", {
    p_auth_subject: ENTRY_OPERATOR.auth, p_app_user_id: ENTRY_OPERATOR.app,
    p_entry_id: PROBATION_ENTRY,
  });
  assert.equal(projection.labor_type, "PROBATION", "the entry read returns the dynamic key");

  const catalog = await rpc(db, "direct_entry_input_catalog", {
    p_auth_subject: ENTRY_OPERATOR.auth, p_app_user_id: ENTRY_OPERATOR.app,
    p_effective_date: WORK_DATE,
  });
  const option = catalog.labor_types.find((row) => row.labor_type_key === "PROBATION");
  assert.ok(option, "the Direct Entry runtime receives the dynamic key with no source change");
  assert.equal(sortedKeys(option), "display_name,labor_type_key,sort_order");
  assert.equal(option.display_name, "Thời gian thử việc");
});

test("23: the worker directory projects a SUBMITTED row carrying PROBATION", async () => {
  // The submission carries a deferred non-empty constraint trigger, so the row
  // and its submission are written in one transaction, exactly like the fixture.
  await db.query("begin");
  const submissionId = (await db.query(
    "insert into public.direct_entry_submissions (created_by_user_id) values ($1::uuid)"
    + " returning submission_id", [ENTRY_OPERATOR.app])).rows[0].submission_id;
  const entryId = await insertEntry(db, { employeeCode: "hrp-2026-420002",
    laborType: "PROBATION", submissionId });
  await db.query("commit");
  // New batches submit directly from DRAFT; REVIEW remains only for legacy batches.
  await db.query("update public.direct_entry_submissions set state = 'SUBMITTED',"
    + " version = version + 1 where submission_id = $1::uuid", [submissionId]);

  const page = await rpc(db, "direct_entry_list_workers", {
    p_auth_subject: ENTRY_OPERATOR.auth, p_app_user_id: ENTRY_OPERATOR.app,
    p_scope: "all", p_page_size: 50,
  });
  const row = page.items.find((item) => item.entry_id === entryId);
  assert.ok(row, "the dynamic-key worker is listed");
  assert.equal(row.labor_type, "PROBATION", "the worker directory returns the dynamic key");
});

test("24: deactivating PROBATION fails closed for new writes with zero residue", async () => {
  const version = await currentVersion(db, "PROBATION");
  const off = await setLaborTypeActive(db, OPERATOR_FULL_ADMIN, {
    laborTypeKey: "PROBATION", active: false, expectedVersion: version, idempotencyKey: KEY("32"),
  });
  assert.equal(off.active, false);

  const before = await counts(db);
  const inactive = await directEntryProbe(db, "hrp-2026-420003", "PROBATION");
  assert.equal(inactive.code, "23514", "a deactivated key is never an acceptable new write");
  assert.equal(inactive.entry_id, null);
  const unknown = await directEntryProbe(db, "hrp-2026-420004", UNKNOWN_KEY);
  assert.equal(unknown.code, "23514", "an unknown canonical key fails closed at the same guard");
  assert.deepEqual(await counts(db), before,
    "no entry, revision, audit or idempotency residue is left behind");

  // History keeps resolving: the stored row is still readable and still editable,
  // because the guard only judges a CHANGE to a new key.
  const projection = await rpc(db, "direct_entry_read_projection", {
    p_auth_subject: ENTRY_OPERATOR.auth, p_app_user_id: ENTRY_OPERATOR.app,
    p_entry_id: PROBATION_ENTRY,
  });
  assert.equal(projection.labor_type, "PROBATION", "a stored row stays readable");
  const edited = await db.query(
    "update public.direct_entries set labor_type = 'PROBATION', version = version + 1,"
    + " general_note = $2 where entry_id = $1::uuid",
    [PROBATION_ENTRY, "Synthetic post-deactivation edit"]);
  assert.equal(edited.affectedRows, 1, "a stored row under a deactivated key stays editable");

  // Choosable and stored are different questions: the options drop the key.
  const catalog = await rpc(db, "direct_entry_input_catalog", {
    p_auth_subject: ENTRY_OPERATOR.auth, p_app_user_id: ENTRY_OPERATOR.app,
    p_effective_date: WORK_DATE,
  });
  assert.equal(catalog.labor_types.some((row) => row.labor_type_key === "PROBATION"), false,
    "a deactivated key silently leaves the runtime options");
});
