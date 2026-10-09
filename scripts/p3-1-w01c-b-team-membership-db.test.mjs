/**
 * P3.1-W01C-B - Team membership lifecycle backend (#70) DB acceptance.
 *
 * Proves the single catalog guard reused from #68, the membership interval and
 * cancellation-marker semantics, the HRP eligibility boundary, the back-dated
 * attribution protection, and the OCC / idempotency / revision / audit / ACL
 * invariants of migration #70.
 *
 * No Production access, no network, no browser: PGlite applies the real local
 * migrations and the RPCs are called exactly as the service-role repository does.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const NEW_MIGRATION = "20261009060000_p3_1_w01c_b_team_membership.sql";
const PREVIOUS_MIGRATION = "20261009050000_p3_1_w01c_a_team_catalog.sql";

const FULL_ADMIN = { auth: "10000000-0000-4000-8000-0000000000c1", app: "20000000-0000-4000-8000-0000000000c1" };
const CATALOG = { auth: "10000000-0000-4000-8000-0000000000c2", app: "20000000-0000-4000-8000-0000000000c2" };
const ENTRY_ADMIN_ONLY = { auth: "10000000-0000-4000-8000-0000000000c3", app: "20000000-0000-4000-8000-0000000000c3" };
const CATALOG_NO_ALL = { auth: "10000000-0000-4000-8000-0000000000c4", app: "20000000-0000-4000-8000-0000000000c4" };
const LEADER = { auth: "10000000-0000-4000-8000-0000000000c5", app: "20000000-0000-4000-8000-0000000000c5" };
const PROJECT_MANAGER = { auth: "10000000-0000-4000-8000-0000000000c6", app: "20000000-0000-4000-8000-0000000000c6" };
const STAFF = { auth: "10000000-0000-4000-8000-0000000000c7", app: "20000000-0000-4000-8000-0000000000c7" };
const DISABLED_ADMIN = { auth: "10000000-0000-4000-8000-0000000000c8", app: "20000000-0000-4000-8000-0000000000c8" };

const TEAM_A = "94000000-0000-4000-8000-0000000000a1";
const TEAM_B = "94000000-0000-4000-8000-0000000000a2";
const TEAM_INACTIVE = "94000000-0000-4000-8000-0000000000a3";
const RESERVED_CODE = "__system_vendor__";
const MISSING_TEAM = "94000000-0000-4000-8000-0000000000ff";
const MISSING_APP = "20000000-0000-4000-8000-0000000000ff";

const HRP_A = "93000000-0000-4000-8000-0000000000b1";
const HRP_B = "93000000-0000-4000-8000-0000000000b2";
const INACTIVE = "93000000-0000-4000-8000-0000000000b3";
const NO_MEMBERSHIP = "93000000-0000-4000-8000-0000000000b4";
const VENDOR_RECRUITER = "93000000-0000-4000-8000-0000000000b5";
const EXPIRED_HRP = "93000000-0000-4000-8000-0000000000b6";
const FUTURE_HRP = "93000000-0000-4000-8000-0000000000b7";
const ENTRY_SUBJECT = "93000000-0000-4000-8000-0000000000b8";
const HRP_C = "93000000-0000-4000-8000-0000000000b9";
const HRP_D = "93000000-0000-4000-8000-0000000000ba";
const HRP_E = "93000000-0000-4000-8000-0000000000bb";
const HRP_F = "93000000-0000-4000-8000-0000000000bc";
const HRP_G = "93000000-0000-4000-8000-0000000000bd";
const HRP_H = "93000000-0000-4000-8000-0000000000be";

const VENDOR_ID = "vendor.w01cb";
const PROJECT_ID = "membership_proj";
const CANDIDATE_ID = "91000000-0000-4000-8000-0000000000d1";
const SUBMISSION_ID = "91000000-0000-4000-8000-0000000000d2";
const MEMBER_ENTRY_ID = "91000000-0000-4000-8000-0000000000d3";

const PAST = "2026-01-01";
const ENTRY_DATE = "2026-01-10";
const LATER = "2026-02-01";
const FUTURE = "2026-11-01";
const REASON = "Synthetic membership reason";
const KEY = (suffix) => "50000000-0000-4000-8000-0000000000" + suffix;

const RPC_PARAMS = {
  direct_entry_list_team_membership_current: ["p_auth_subject", "p_app_user_id", "p_recruiter_id",
    "p_team_id", "p_search", "p_page", "p_page_size"],
  direct_entry_list_team_membership_scheduled: ["p_auth_subject", "p_app_user_id", "p_recruiter_id",
    "p_team_id", "p_search", "p_page", "p_page_size"],
  direct_entry_list_team_membership_history: ["p_auth_subject", "p_app_user_id", "p_recruiter_id",
    "p_team_id", "p_search", "p_page", "p_page_size"],
  direct_entry_assign_team_membership: ["p_auth_subject", "p_app_user_id", "p_recruiter_id",
    "p_team_id", "p_valid_from", "p_expected_version", "p_reason", "p_idempotency_key"],
  direct_entry_move_team_membership: ["p_auth_subject", "p_app_user_id", "p_recruiter_id",
    "p_team_id", "p_valid_from", "p_expected_version", "p_reason", "p_idempotency_key"],
  direct_entry_unassign_team_membership: ["p_auth_subject", "p_app_user_id", "p_recruiter_id",
    "p_valid_to", "p_expected_version", "p_reason", "p_idempotency_key"],
};

async function database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  for (const name of (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort()) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return db;
}

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
    return { code: error.code, message: error.message };
  }
}

async function addActor(db, actor) {
  await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)"
    + " values ($1::uuid, $2::uuid, $3, $4)",
    [actor.app, actor.auth, actor.enabled !== false, actor.display_name ?? "Synthetic Actor"]);
  for (const capability of actor.capabilities ?? []) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)"
      + " values ($1::uuid, $2, '2020-01-01')", [actor.app, capability]);
  }
  for (const kind of actor.scopes ?? []) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from)"
      + " values ($1::uuid, $2, $3::uuid, '2020-01-01')",
      [actor.app, kind, kind === "team" ? TEAM_A : null]);
  }
}

async function counts(db) {
  const { rows } = await db.query(
    "select (select count(*)::int from public.recruiter_team_memberships) as memberships,"
    + " (select count(*)::int from public.direct_entry_team_membership_revisions) as revisions,"
    + " (select count(*)::int from public.direct_entry_audit_events) as audits,"
    + " (select count(*)::int from public.direct_entry_restricted_reasons) as reasons,"
    + " (select count(*)::int from public.direct_entry_capability_grants) as capability_grants,"
    + " (select count(*)::int from public.direct_entry_scope_grants) as scope_grants,"
    + " (select count(*)::int from public.direct_entry_rpc_idempotency) as idempotency,"
    + " (select count(*)::int from public.recruiters) as recruiters,"
    + " (select count(*)::int from public.teams) as teams,"
    + " (select count(*)::int from public.direct_entries) as entries");
  return rows[0];
}

const PROJECTION_KEYS = ["membership_id", "recruiter_id", "team_id", "team_display_name",
  "valid_from", "valid_to", "recruiter_version", "state"].sort();
const SNAPSHOT_KEYS = ["recruiter_id", "team_id", "valid_from", "valid_to", "version",
  "change"].sort();

function sortedKeys(value) {
  return Object.keys(value).sort().join(",");
}

async function assign(db, actor, { recruiter = HRP_A, team = TEAM_A, from = PAST,
  version = 1, key = KEY("a1"), reason = REASON }) {
  return rpc(db, "direct_entry_assign_team_membership", {
    p_auth_subject: actor.auth, p_app_user_id: actor.app, p_recruiter_id: recruiter,
    p_team_id: team, p_valid_from: from, p_expected_version: version, p_reason: reason,
    p_idempotency_key: key,
  });
}

async function move(db, actor, { recruiter = HRP_A, team = TEAM_B, from = LATER,
  version = 2, key = KEY("m1"), reason = REASON }) {
  return rpc(db, "direct_entry_move_team_membership", {
    p_auth_subject: actor.auth, p_app_user_id: actor.app, p_recruiter_id: recruiter,
    p_team_id: team, p_valid_from: from, p_expected_version: version, p_reason: reason,
    p_idempotency_key: key,
  });
}

async function unassign(db, actor, { recruiter = HRP_A, to = LATER, version = 2,
  key = KEY("u1"), reason = REASON }) {
  return rpc(db, "direct_entry_unassign_team_membership", {
    p_auth_subject: actor.auth, p_app_user_id: actor.app, p_recruiter_id: recruiter,
    p_valid_to: to, p_expected_version: version, p_reason: reason,
    p_idempotency_key: key,
  });
}

async function readMemberships(db, state, args = {}) {
  const name = "direct_entry_list_team_membership_" + state;
  return rpc(db, name, {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_search: null,
    p_page: 1, p_page_size: 25, ...args,
  });
}

const db = await database();

async function recruiterVersion(database_, recruiterId) {
  const { rows } = await database_.query(
    "select version from public.recruiters where recruiter_id = $1::uuid", [recruiterId]);
  return rows[0].version;
}

await db.exec("insert into public.teams (team_id, code, display_name, active) values"
  + " ('" + TEAM_A + "', 'MEM_A', 'Synthetic Membership Team A', true),"
  + " ('" + TEAM_B + "', 'MEM_B', 'Synthetic Membership Team B', true),"
  + " ('" + TEAM_INACTIVE + "', 'MEM_OFF', 'Synthetic Membership Team Off', false)");
// The reserved Vendor system team, created exactly as the canonical #65 helper would.
await db.exec("insert into public.teams (code, display_name, active) values ('"
  + RESERVED_CODE + "', 'Vendor', true)");
await db.exec("insert into public.vendors (vendor_id, display_name, active) values ('"
  + VENDOR_ID + "', 'Synthetic Vendor', true)");

await addActor(db, { ...FULL_ADMIN, display_name: "Synthetic Full Admin",
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"], scopes: ["all"] });
await addActor(db, { ...CATALOG, display_name: "Synthetic Catalog Operator",
  capabilities: ["catalog_master_manage"], scopes: ["all"] });
await addActor(db, { ...ENTRY_ADMIN_ONLY, capabilities: ["entry_admin"], scopes: ["all"] });
await addActor(db, { ...CATALOG_NO_ALL, capabilities: ["catalog_master_manage"], scopes: ["own"] });
await addActor(db, { ...LEADER, capabilities: ["team_manager_assign"], scopes: ["team"] });
await addActor(db, { ...PROJECT_MANAGER, capabilities: ["entry_team", "change_request_create"],
  scopes: ["team"] });
await addActor(db, { ...STAFF, capabilities: ["entry_own"], scopes: ["own"] });
await addActor(db, { ...DISABLED_ADMIN, enabled: false,
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"], scopes: ["all"] });

for (const [recruiterId, displayName, active] of [
  [HRP_A, "Synthetic HRP A", true],
  [HRP_B, "Synthetic HRP B", true],
  [INACTIVE, "Synthetic Inactive Person", false],
  [NO_MEMBERSHIP, "Synthetic No Provider", true],
  [VENDOR_RECRUITER, "Synthetic Vendor Person", true],
  [EXPIRED_HRP, "Synthetic Expired HRP", true],
  [FUTURE_HRP, "Synthetic Future HRP", true],
  [ENTRY_SUBJECT, "Synthetic Entry Subject", true],
  [HRP_C, "Synthetic HRP C", true],
  [HRP_D, "Synthetic HRP D", true],
  [HRP_E, "Synthetic HRP E", true],
  [HRP_F, "Synthetic HRP F", true],
  [HRP_G, "Synthetic HRP G", true],
  [HRP_H, "Synthetic HRP H", true],
]) {
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name, active, version)"
    + " values ($1::uuid, $2, $3, 1)", [recruiterId, displayName, active]);
}
for (const recruiterId of [HRP_A, HRP_B, INACTIVE, ENTRY_SUBJECT, HRP_C, HRP_D, HRP_E, HRP_F, HRP_G,
  HRP_H]) {
  await db.query(
    "insert into public.recruiter_provider_memberships"
    + " (recruiter_id, provider_type, valid_from, valid_to, vendor_id)"
    + " values ($1::uuid, 'hrp', '2020-01-01', null, null)", [recruiterId]);
}
await db.query(
  "insert into public.recruiter_provider_memberships"
  + " (recruiter_id, provider_type, valid_from, valid_to, vendor_id)"
  + " values ($1::uuid, 'hrp', '2020-01-01', '2021-01-01', null)", [EXPIRED_HRP]);
await db.query(
  "insert into public.recruiter_provider_memberships"
  + " (recruiter_id, provider_type, valid_from, valid_to, vendor_id)"
  + " values ($1::uuid, 'hrp', '2099-01-01', null, null)", [FUTURE_HRP]);
await db.query(
  "insert into public.recruiter_provider_memberships"
  + " (recruiter_id, provider_type, valid_from, valid_to, vendor_id)"
  + " values ($1::uuid, 'vendor', '2020-01-01', null, $2)", [VENDOR_RECRUITER, VENDOR_ID]);

test("assigning an eligible HRP person opens one interval with one revision and one audit", async () => {
  const before = await counts(db);
  const version = await recruiterVersion(db, HRP_A);
  const result = await assign(db, CATALOG, { version });

  assert.equal(sortedKeys(result), ["change", "membership_id", "recruiter_id", "recruiter_version",
    "revision_id", "team_id", "valid_from", "valid_to"].sort().join(","));
  assert.equal(result.change, "ASSIGN");
  assert.equal(result.recruiter_id, HRP_A);
  assert.equal(result.team_id, TEAM_A);
  assert.equal(result.valid_from, PAST);
  assert.equal(result.valid_to, null);
  assert.equal(result.recruiter_version, version + 1);

  const after = await counts(db);
  assert.equal(after.memberships, before.memberships + 1);
  assert.equal(after.revisions, before.revisions + 1);
  assert.equal(after.audits, before.audits + 1);
  assert.equal(after.reasons, before.reasons + 1);
  assert.equal(after.scope_grants, before.scope_grants, "no scope grant is created");
  assert.equal(after.capability_grants, before.capability_grants, "no capability grant is created");
  assert.equal(after.recruiters, before.recruiters, "no recruiter is created");

  const revision = (await db.query(
    "select version, before_snapshot, after_snapshot from public.direct_entry_team_membership_revisions"
    + " where recruiter_id = $1::uuid order by version desc limit 1", [HRP_A])).rows[0];
  assert.equal(revision.version, version + 1);
  assert.equal(revision.before_snapshot, null);
  assert.deepEqual(Object.keys(revision.after_snapshot).sort(), SNAPSHOT_KEYS);
  assert.equal(revision.after_snapshot.change, "ASSIGN");
  assert.equal(revision.after_snapshot.team_id, TEAM_A);

  const audit = (await db.query(
    "select action, capability, scope_kind, scope_team_id, changed_fields, outcome,"
    + " team_membership_revision_id from public.direct_entry_audit_events"
    + " where resource_ref = $1 order by created_at desc limit 1", [HRP_A])).rows[0];
  assert.equal(audit.action, "team_membership_assign");
  assert.equal(audit.capability, "catalog_master_manage");
  assert.equal(audit.scope_kind, "all");
  assert.equal(audit.scope_team_id, null);
  assert.equal(audit.outcome, "APPLIED");
  assert.deepEqual(audit.changed_fields.sort(), ["backdated", "team_id", "valid_from"]);
  assert.equal(audit.team_membership_revision_id, result.revision_id);
});

test("the eligibility boundary denies every non-eligible subject with zero residue", async () => {
  const before = await counts(db);
  for (const [recruiter, label] of [
    [NO_MEMBERSHIP, "no provider membership"],
    [VENDOR_RECRUITER, "vendor provider membership"],
    [EXPIRED_HRP, "expired HRP membership"],
    [FUTURE_HRP, "not yet effective HRP membership"],
    [INACTIVE, "inactive recruiter"],
  ]) {
    const error = await rpcError(db, "direct_entry_assign_team_membership", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: recruiter,
      p_team_id: TEAM_A, p_valid_from: PAST, p_expected_version: 1, p_reason: REASON,
      p_idempotency_key: KEY("e1"),
    });
    assert.ok(error, label + " must be denied");
    assert.equal(error.code, "P0002", label);
  }

  // Defense in depth: even a raw insert cannot give a Vendor provider recruiter a
  // business-team membership, independently of the RPC eligibility lock.
  await assert.rejects(
    db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)"
      + " values ($1::uuid, $2::uuid, '2026-01-01')", [VENDOR_RECRUITER, TEAM_A]),
    (error) => error.code === "23514");

  assert.deepEqual(await counts(db), before, "ineligible subjects leave zero residue");
});

test("the reserved Vendor system team rejects membership writes on both paths", async () => {
  const reservedId = (await db.query(
    "select team_id from public.teams where code = $1", [RESERVED_CODE])).rows[0].team_id;
  const before = await counts(db);

  // Raw insert path: the #65 trigger owns the reserved-team boundary.
  await assert.rejects(
    db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)"
      + " values ($1::uuid, $2::uuid, '2026-01-01')", [HRP_B, reservedId]),
    (error) => error.code === "23514");

  // RPC path: the same trigger raises, so the RPC never special-cases the team.
  const error = await rpcError(db, "direct_entry_assign_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: HRP_B,
    p_team_id: reservedId, p_valid_from: PAST, p_expected_version: 1, p_reason: REASON,
    p_idempotency_key: KEY("e2"),
  });
  assert.equal(error.code, "23514");
  assert.deepEqual(await counts(db), before, "the reserved team leaves zero residue");
});

test("target team validation rejects an inactive team and an unknown team", async () => {
  const before = await counts(db);
  const inactive = await rpcError(db, "direct_entry_assign_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: HRP_B,
    p_team_id: TEAM_INACTIVE, p_valid_from: PAST, p_expected_version: 1, p_reason: REASON,
    p_idempotency_key: KEY("e3"),
  });
  assert.equal(inactive.code, "23514");
  const unknown = await rpcError(db, "direct_entry_assign_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: HRP_B,
    p_team_id: MISSING_TEAM, p_valid_from: PAST, p_expected_version: 1, p_reason: REASON,
    p_idempotency_key: KEY("e4"),
  });
  assert.equal(unknown.code, "P0002");
  assert.deepEqual(await counts(db), before);
});

test("a second effective membership for the same person is rejected with 23P01", async () => {
  const before = await counts(db);
  const version = await recruiterVersion(db, HRP_A);
  const error = await rpcError(db, "direct_entry_assign_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: HRP_A,
    p_team_id: TEAM_B, p_valid_from: "2026-03-01", p_expected_version: version,
    p_reason: REASON, p_idempotency_key: KEY("e5"),
  });
  assert.equal(error.code, "23P01");
  assert.deepEqual(await counts(db), before, "an overlapping assign leaves zero residue");
});

test("a move on a later date closes the outgoing interval and opens the incoming one", async () => {
  const before = await counts(db);
  const version = await recruiterVersion(db, HRP_A);
  const result = await move(db, CATALOG, { version });

  assert.equal(result.change, "MOVE");
  assert.equal(result.team_id, TEAM_B);
  assert.equal(result.valid_from, LATER);
  assert.equal(result.valid_to, null);
  assert.equal(result.recruiter_version, version + 1);

  const rows = (await db.query(
    "select team_id, valid_from::text as valid_from, valid_to::text as valid_to"
    + " from public.recruiter_team_memberships where recruiter_id = $1::uuid"
    + " order by valid_from", [HRP_A])).rows;
  assert.equal(rows.length, 2, "the outgoing interval is closed, not deleted");
  assert.deepEqual(rows[0], { team_id: TEAM_A, valid_from: PAST, valid_to: LATER });
  assert.deepEqual(rows[1], { team_id: TEAM_B, valid_from: LATER, valid_to: null });

  const after = await counts(db);
  assert.equal(after.memberships, before.memberships + 1);
  assert.equal(after.revisions, before.revisions + 1, "a move appends exactly one revision");
  assert.equal(after.audits, before.audits + 1);

  const revision = (await db.query(
    "select before_snapshot, after_snapshot, version from public.direct_entry_team_membership_revisions"
    + " where recruiter_id = $1::uuid order by version desc limit 1", [HRP_A])).rows[0];
  assert.deepEqual(Object.keys(revision.before_snapshot).sort(), SNAPSHOT_KEYS);
  assert.deepEqual(Object.keys(revision.after_snapshot).sort(), SNAPSHOT_KEYS);
  assert.equal(revision.before_snapshot.change, "MOVE");
  assert.equal(revision.before_snapshot.team_id, TEAM_A);
  assert.equal(revision.after_snapshot.team_id, TEAM_B);
  assert.equal(revision.after_snapshot.version, revision.version);
});

test("a same-day move leaves the outgoing interval as an inert cancellation marker", async () => {
  const before = await counts(db);
  const version = await recruiterVersion(db, HRP_B);
  await assign(db, CATALOG, { recruiter: HRP_B, team: TEAM_A, from: LATER, version,
    key: KEY("10") });
  const afterAssign = await recruiterVersion(db, HRP_B);
  const result = await move(db, CATALOG, { recruiter: HRP_B, team: TEAM_B, from: LATER,
    version: afterAssign, key: KEY("11") });

  assert.equal(result.change, "MOVE");
  const rows = (await db.query(
    "select team_id, valid_from::text as valid_from, valid_to::text as valid_to"
    + " from public.recruiter_team_memberships where recruiter_id = $1::uuid"
    + " order by valid_from, team_id", [HRP_B])).rows;
  assert.equal(rows.length, 2, "both the marker and the replacement exist");
  const marker = rows.find((row) => row.team_id === TEAM_A);
  const incoming = rows.find((row) => row.team_id === TEAM_B);
  assert.deepEqual(marker, { team_id: TEAM_A, valid_from: LATER, valid_to: LATER });
  assert.deepEqual(incoming, { team_id: TEAM_B, valid_from: LATER, valid_to: null });

  const after = await counts(db);
  assert.equal(after.memberships, before.memberships + 2, "assign plus same-day move");
  assert.equal(after.revisions, before.revisions + 2);

  const audit = (await db.query(
    "select changed_fields from public.direct_entry_audit_events"
    + " where resource_ref = $1 and action = 'team_membership_move' limit 1", [HRP_B])).rows[0];
  assert.deepEqual(audit.changed_fields.sort(),
    ["backdated", "cancellation_marker", "team_id", "valid_to"]);
});

test("a future assign grants nothing before its effective date", async () => {
  const version = await recruiterVersion(db, HRP_C);
  await assign(db, CATALOG, { recruiter: HRP_C, team: TEAM_A, from: FUTURE, version,
    key: KEY("20") });

  const current = await readMemberships(db, "current", { p_recruiter_id: HRP_C });
  assert.equal(current.total, 0, "a future interval is never current");
  const scheduled = await readMemberships(db, "scheduled", { p_recruiter_id: HRP_C });
  assert.equal(scheduled.total, 1);
  assert.equal(scheduled.memberships[0].state, "SCHEDULED");
  assert.equal(scheduled.memberships[0].valid_from, FUTURE);
  assert.equal(scheduled.memberships[0].team_id, TEAM_A);
});

test("cancelling a future interval keeps an inert zero-length marker", async () => {
  const version = await recruiterVersion(db, HRP_C);
  const cancelled = await unassign(db, CATALOG, { recruiter: HRP_C, to: FUTURE, version,
    key: KEY("21") });

  assert.equal(cancelled.change, "CANCEL");
  assert.equal(cancelled.valid_from, FUTURE);
  assert.equal(cancelled.valid_to, FUTURE);

  const rows = (await db.query(
    "select valid_from::text as valid_from, valid_to::text as valid_to"
    + " from public.recruiter_team_memberships where recruiter_id = $1::uuid", [HRP_C])).rows;
  assert.equal(rows.length, 1, "the row survives the cancellation");
  assert.deepEqual(rows[0], { valid_from: FUTURE, valid_to: FUTURE });

  assert.equal((await readMemberships(db, "current", { p_recruiter_id: HRP_C })).total, 0);
  assert.equal((await readMemberships(db, "scheduled", { p_recruiter_id: HRP_C })).total, 0,
    "an inert marker is never scheduled");
  const history = await readMemberships(db, "history", { p_recruiter_id: HRP_C });
  assert.equal(history.total, 1);
  assert.equal(history.memberships[0].state, "HISTORY");

  const audit = (await db.query(
    "select changed_fields from public.direct_entry_audit_events"
    + " where resource_ref = $1 and action = 'team_membership_unassign' limit 1", [HRP_C])).rows[0];
  assert.deepEqual(audit.changed_fields.sort(), ["cancellation_marker", "valid_to"]);
});

test("unassigning a live membership closes it and keeps the history readable", async () => {
  const version = await recruiterVersion(db, HRP_A);
  const result = await unassign(db, CATALOG, { recruiter: HRP_A, to: "2026-03-01", version,
    key: KEY("22") });

  assert.equal(result.change, "UNASSIGN");
  assert.equal(result.team_id, TEAM_B);
  assert.equal(result.valid_from, LATER);
  assert.equal(result.valid_to, "2026-03-01");

  assert.equal((await readMemberships(db, "current", { p_recruiter_id: HRP_A })).total, 0);
  const history = await readMemberships(db, "history", { p_recruiter_id: HRP_A });
  assert.equal(history.total, 2, "the closed interval and the earlier closed one are history");
  for (const row of history.memberships) {
    assert.equal(row.state, "HISTORY");
    assert.equal(row.valid_to !== null, true);
  }
  const revision = (await db.query(
    "select before_snapshot, after_snapshot from public.direct_entry_team_membership_revisions"
    + " where recruiter_id = $1::uuid order by version desc limit 1", [HRP_A])).rows[0];
  assert.deepEqual(Object.keys(revision.before_snapshot).sort(), SNAPSHOT_KEYS);
  assert.deepEqual(Object.keys(revision.after_snapshot).sort(), SNAPSHOT_KEYS);
  assert.equal(revision.before_snapshot.change, "UNASSIGN");
  assert.equal(revision.after_snapshot.valid_to, "2026-03-01");
});

test("a same-day unassign writes an inert cancellation marker", async () => {
  const version = await recruiterVersion(db, HRP_D);
  const assigned = await assign(db, CATALOG, { recruiter: HRP_D, team: TEAM_A, from: PAST,
    version, key: KEY("23") });
  const cancelled = await unassign(db, CATALOG, { recruiter: HRP_D, to: PAST,
    version: assigned.recruiter_version, key: KEY("24") });

  assert.equal(cancelled.change, "CANCEL");
  assert.equal(cancelled.valid_from, PAST);
  assert.equal(cancelled.valid_to, PAST);
  assert.equal((await readMemberships(db, "current", { p_recruiter_id: HRP_D })).total, 0,
    "a marker is never effective");
  assert.equal((await readMemberships(db, "scheduled", { p_recruiter_id: HRP_D })).total, 0);
  assert.equal((await readMemberships(db, "history", { p_recruiter_id: HRP_D })).total, 1);

  // A raw zero-length insert outside the audited mutation path fails closed.
  const before = await counts(db);
  await assert.rejects(
    db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, valid_to)"
      + " values ($1::uuid, $2::uuid, '2026-05-01', '2026-05-01')", [HRP_D, TEAM_A]),
    (error) => error.code === "23514");
  assert.deepEqual(await counts(db), before);
});

test("idempotent replay returns the stored result and a reused key with different input conflicts", async () => {
  const version = await recruiterVersion(db, NO_MEMBERSHIP);
  // NO_MEMBERSHIP is not eligible, so use a fresh eligible person for this test.
  const recruiter = HRP_D;
  const current = await recruiterVersion(db, recruiter);
  const first = await assign(db, CATALOG, { recruiter, team: TEAM_B, from: LATER,
    version: current, key: KEY("30") });
  const before = await counts(db);
  const replay = await assign(db, CATALOG, { recruiter, team: TEAM_B, from: LATER,
    version: current, key: KEY("30") });
  assert.deepEqual(replay, first);
  assert.deepEqual(await counts(db), before, "replay adds no interval, revision, audit or reason");

  const conflict = await rpcError(db, "direct_entry_assign_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: recruiter,
    p_team_id: TEAM_A, p_valid_from: LATER, p_expected_version: current,
    p_reason: REASON, p_idempotency_key: KEY("30"),
  });
  assert.equal(conflict.code, "22023");
  assert.equal(conflict.message, "idempotency key reused with different input");
  assert.deepEqual(await counts(db), before, "a conflicting replay leaves zero residue");
  assert.equal(version >= 1, true);
});

test("a stale expected version is rejected with 40001 and leaves the intervals unchanged", async () => {
  const version = await recruiterVersion(db, HRP_D);
  const before = await counts(db);
  const stale = await rpcError(db, "direct_entry_unassign_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: HRP_D,
    p_valid_to: FUTURE, p_expected_version: version + 9, p_reason: REASON,
    p_idempotency_key: KEY("31"),
  });
  assert.equal(stale.code, "40001");
  assert.deepEqual(await counts(db), before, "a stale version leaves zero residue");
});

test("a back-dated change cannot rewrite an existing worker attribution", async () => {
  // The person is assigned to TEAM_A, then an entry is written for a business date
  // inside that interval; the stored entry team must stay the attribution source.
  const version = await recruiterVersion(db, ENTRY_SUBJECT);
  await assign(db, CATALOG, { recruiter: ENTRY_SUBJECT, team: TEAM_A, from: PAST, version,
    key: KEY("40") });

  await db.query("insert into public.direct_entry_projects (project_id, display_name)"
    + " values ($1, 'Synthetic Membership Project')", [PROJECT_ID]);
  await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1::uuid)",
    [CANDIDATE_ID]);
  // The submission non-empty constraint trigger is DEFERRABLE INITIALLY DEFERRED, so the
  // submission and its first entry must land in the same transaction.
  await db.exec("begin");
  await db.query("insert into public.direct_entry_submissions (submission_id, created_by_user_id)"
    + " values ($1::uuid, $2::uuid)", [SUBMISSION_ID, CATALOG.app]);
  await db.query(
    "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id,"
    + " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id,"
    + " provider_type, labor_type) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::date,"
    + " 'hrp-2026-000123', $7::jsonb, $8::uuid, $9::uuid, 'hrp', 'TEMPORARY')",
    [MEMBER_ENTRY_ID, SUBMISSION_ID, CANDIDATE_ID, CATALOG.app, PROJECT_ID, ENTRY_DATE,
      JSON.stringify({ display_name: "Synthetic Entry Worker",
        date_of_birth: { state: "omitted" },
        national_id: { state: "provided", value: "100000000777" },
        address: { state: "omitted" }, phone: { state: "omitted" } }),
      ENTRY_SUBJECT, TEAM_A]);
  await db.exec("commit");

  const entryBefore = (await db.query(
    "select team_id, first_work_date::text as first_work_date, version from public.direct_entries"
    + " where entry_id = $1::uuid", [MEMBER_ENTRY_ID])).rows[0];
  const before = await counts(db);

  // A move that would resolve a different team on the entry's business date.
  const version2 = await recruiterVersion(db, ENTRY_SUBJECT);
  const blockedMove = await rpcError(db, "direct_entry_move_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: ENTRY_SUBJECT,
    p_team_id: TEAM_B, p_valid_from: "2026-01-05", p_expected_version: version2,
    p_reason: REASON, p_idempotency_key: KEY("41"),
  });
  assert.equal(blockedMove.code, "23514");

  // A back-dated unassign that would leave the entry's business date unattributed.
  const blockedUnassign = await rpcError(db, "direct_entry_unassign_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: ENTRY_SUBJECT,
    p_valid_to: "2026-01-05", p_expected_version: version2, p_reason: REASON,
    p_idempotency_key: KEY("42"),
  });
  assert.equal(blockedUnassign.code, "23514");
  assert.deepEqual(await counts(db), before, "a blocked back-date leaves zero residue");

  // A back-dated change that does NOT alter any used business date is allowed and is
  // recorded as backdated in the bounded changed_fields.
  const allowed = await move(db, CATALOG, { recruiter: ENTRY_SUBJECT, team: TEAM_B,
    from: LATER, version: version2, key: KEY("43") });
  assert.equal(allowed.change, "MOVE");
  const audit = (await db.query(
    "select changed_fields, action from public.direct_entry_audit_events"
    + " where resource_ref = $1 and changed_fields @> array['backdated'] limit 1",
    [ENTRY_SUBJECT])).rows[0];
  assert.equal(audit.action, "team_membership_move");
  assert.equal(audit.changed_fields.includes("backdated"), true);

  const entryAfter = (await db.query(
    "select team_id, first_work_date::text as first_work_date, version from public.direct_entries"
    + " where entry_id = $1::uuid", [MEMBER_ENTRY_ID])).rows[0];
  assert.deepEqual(entryAfter, entryBefore, "the stored entry is never rewritten");
});

test("a failing audit or revision write rolls the whole membership mutation back", async () => {
  const before = await counts(db);
  const version = await recruiterVersion(db, HRP_C);
  await db.exec("create function public.test_w01cb_fail_audit() returns trigger language plpgsql as"
    + " $x$ begin raise exception 'synthetic audit failure' using errcode = '23514'; end $x$;"
    + " create trigger test_w01cb_fail_audit before insert on public.direct_entry_audit_events"
    + " for each row execute function public.test_w01cb_fail_audit();");
  try {
    const error = await rpcError(db, "direct_entry_assign_team_membership", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: HRP_C,
      p_team_id: TEAM_A, p_valid_from: "2026-12-01", p_expected_version: version,
      p_reason: REASON, p_idempotency_key: KEY("50"),
    });
    assert.equal(error.code, "23514");
  } finally {
    await db.exec("drop trigger test_w01cb_fail_audit on public.direct_entry_audit_events;"
      + " drop function public.test_w01cb_fail_audit();");
  }
  assert.deepEqual(await counts(db), before, "audit failure leaves zero residue");
  assert.equal(await recruiterVersion(db, HRP_C), version, "the version is not bumped");

  await db.exec("create function public.test_w01cb_fail_revision() returns trigger language plpgsql as"
    + " $x$ begin raise exception 'synthetic revision failure' using errcode = '23514'; end $x$;"
    + " create trigger test_w01cb_fail_revision before insert"
    + " on public.direct_entry_team_membership_revisions"
    + " for each row execute function public.test_w01cb_fail_revision();");
  try {
    const error = await rpcError(db, "direct_entry_assign_team_membership", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: HRP_C,
      p_team_id: TEAM_A, p_valid_from: "2026-12-01", p_expected_version: version,
      p_reason: REASON, p_idempotency_key: KEY("51"),
    });
    assert.equal(error.code, "23514");
  } finally {
    await db.exec("drop trigger test_w01cb_fail_revision"
      + " on public.direct_entry_team_membership_revisions;"
      + " drop function public.test_w01cb_fail_revision();");
  }
  assert.deepEqual(await counts(db), before, "revision failure leaves zero residue");
  assert.equal(await recruiterVersion(db, HRP_C), version, "the version is not bumped");
});

test("both catalog authority paths are allowed and audit records the real capability", async () => {
  const adminVersion = await recruiterVersion(db, HRP_E);
  await assign(db, FULL_ADMIN, { recruiter: HRP_E, team: TEAM_A, from: PAST,
    version: adminVersion, key: KEY("60") });
  const catalogVersion = await recruiterVersion(db, HRP_F);
  await assign(db, CATALOG, { recruiter: HRP_F, team: TEAM_A, from: PAST,
    version: catalogVersion, key: KEY("61") });

  const rows = (await db.query(
    "select resource_ref, capability, scope_kind, scope_team_id from public.direct_entry_audit_events"
    + " where action = 'team_membership_assign' and resource_ref = any($1::text[])",
    [[HRP_E, HRP_F]])).rows;
  const byResource = Object.fromEntries(rows.map((row) => [row.resource_ref, row]));
  assert.equal(byResource[HRP_E].capability, "entry_admin");
  assert.equal(byResource[HRP_F].capability, "catalog_master_manage");
  for (const row of rows) {
    assert.equal(row.scope_kind, "all");
    assert.equal(row.scope_team_id, null);
  }
});

test("every non-operator authority is denied with zero residue", async () => {
  const before = await counts(db);
  const denied = [
    [ENTRY_ADMIN_ONLY, "entry_admin@all alone"],
    [CATALOG_NO_ALL, "catalog capability without all scope"],
    [LEADER, "team leader"],
    [PROJECT_MANAGER, "project manager"],
    [STAFF, "staff"],
    [DISABLED_ADMIN, "disabled actor"],
    [{ auth: CATALOG.auth, app: STAFF.app }, "forged auth/app pair"],
    [{ auth: CATALOG.auth, app: MISSING_APP }, "unmapped app user"],
  ];
  for (const [actor, label] of denied) {
    const assignError = await rpcError(db, "direct_entry_assign_team_membership", {
      p_auth_subject: actor.auth, p_app_user_id: actor.app, p_recruiter_id: HRP_G,
      p_team_id: TEAM_A, p_valid_from: PAST, p_expected_version: 1, p_reason: REASON,
      p_idempotency_key: KEY("70"),
    });
    assert.equal(assignError.code, "42501", label + " assign");
    const moveError = await rpcError(db, "direct_entry_move_team_membership", {
      p_auth_subject: actor.auth, p_app_user_id: actor.app, p_recruiter_id: HRP_G,
      p_team_id: TEAM_B, p_valid_from: LATER, p_expected_version: 1, p_reason: REASON,
      p_idempotency_key: KEY("71"),
    });
    assert.equal(moveError.code, "42501", label + " move");
    const unassignError = await rpcError(db, "direct_entry_unassign_team_membership", {
      p_auth_subject: actor.auth, p_app_user_id: actor.app, p_recruiter_id: HRP_G,
      p_valid_to: LATER, p_expected_version: 1, p_reason: REASON,
      p_idempotency_key: KEY("72"),
    });
    assert.equal(unassignError.code, "42501", label + " unassign");
    for (const state of ["current", "scheduled", "history"]) {
      const readError = await rpcError(db, "direct_entry_list_team_membership_" + state, {
        p_auth_subject: actor.auth, p_app_user_id: actor.app, p_page: 1, p_page_size: 25,
      });
      assert.equal(readError.code, "42501", label + " read " + state);
    }
  }
  assert.deepEqual(await counts(db), before, "denials leave zero residue");
});

test("the three reads are disjoint, bounded and exactly projected", async () => {
  const version = await recruiterVersion(db, HRP_G);
  const assigned = await assign(db, CATALOG, { recruiter: HRP_G, team: TEAM_A, from: PAST,
    version, key: KEY("80") });
  await move(db, CATALOG, { recruiter: HRP_G, team: TEAM_B, from: FUTURE,
    version: assigned.recruiter_version, key: KEY("81") });

  const current = await readMemberships(db, "current", { p_recruiter_id: HRP_G });
  const scheduled = await readMemberships(db, "scheduled", { p_recruiter_id: HRP_G });
  const history = await readMemberships(db, "history", { p_recruiter_id: HRP_G });
  assert.equal(current.total, 1);
  assert.equal(scheduled.total, 1);
  assert.equal(history.total, 0);
  assert.equal(sortedKeys(current), ["authorization_date", "memberships", "page", "page_size",
    "total"].sort().join(","));
  for (const row of [current.memberships[0], scheduled.memberships[0]]) {
    assert.equal(sortedKeys(row), PROJECTION_KEYS.join(","));
  }
  assert.equal(current.memberships[0].state, "CURRENT");
  assert.equal(current.memberships[0].team_id, TEAM_A);
  assert.equal(current.memberships[0].team_display_name, "Synthetic Membership Team A");
  assert.equal(scheduled.memberships[0].state, "SCHEDULED");
  assert.equal(scheduled.memberships[0].team_id, TEAM_B);
  assert.equal(scheduled.memberships[0].valid_to, null);

  // Nothing sensitive or out of contract leaks.
  const text = JSON.stringify(current) + JSON.stringify(scheduled) + JSON.stringify(history);
  for (const forbidden of [CATALOG.auth, CATALOG.app, REASON, "reason_id", "auth_subject",
    "email", "capabilit", "scope", "app_user_id"]) {
    assert.equal(text.includes(forbidden), false, "projection leaked " + forbidden);
  }

  // Bounded paging and deterministic order.
  const pageOne = await readMemberships(db, "history", { p_recruiter_id: HRP_A, p_page: 1,
    p_page_size: 1 });
  const pageTwo = await readMemberships(db, "history", { p_recruiter_id: HRP_A, p_page: 2,
    p_page_size: 1 });
  assert.equal(pageOne.memberships.length, 1);
  assert.equal(pageTwo.memberships.length, 1);
  assert.notEqual(pageOne.memberships[0].membership_id, pageTwo.memberships[0].membership_id);
  for (const args of [{ p_page: 0 }, { p_page_size: 0 }, { p_page_size: 101 },
    { p_search: "x".repeat(257) }]) {
    const error = await rpcError(db, "direct_entry_list_team_membership_current", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, ...args,
    });
    assert.equal(error.code, "22023", JSON.stringify(args));
  }
});

test("only the membership interval accepts a zero-length marker; scope and capability stay strict", async () => {
  // FIX R1: #70 must not open the scope/capability schema ahead of W01D. A raw
  // zero-length scope or capability interval is still rejected with 23514 exactly as
  // it was before #70, so the authority predicates keep their pre-W01C-B semantics.
  const markerActor = { auth: "10000000-0000-4000-8000-0000000000d9",
    app: "20000000-0000-4000-8000-0000000000d9" };
  await addActor(db, { ...markerActor, display_name: "Synthetic Marker Actor" });

  await assert.rejects(
    db.query("insert into public.direct_entry_capability_grants"
      + " (app_user_id, capability, valid_from, valid_to) values ($1::uuid,"
      + " 'catalog_master_manage', '2026-01-01', '2026-01-01')", [markerActor.app]),
    (error) => error.code === "23514", "a zero-length capability interval stays rejected");
  await assert.rejects(
    db.query("insert into public.direct_entry_scope_grants"
      + " (app_user_id, scope_kind, valid_from, valid_to) values ($1::uuid, 'all',"
      + " '2026-01-01', '2026-01-01')", [markerActor.app]),
    (error) => error.code === "23514", "a zero-length scope interval stays rejected");

  const definitions = (await db.query(
    "select c.conname, pg_get_constraintdef(c.oid) as definition from pg_constraint c"
    + " where c.conname in ('direct_entry_scope_grants_check',"
    + " 'direct_entry_capability_grants_check')")).rows;
  assert.equal(definitions.length, 2);
  for (const row of definitions) {
    assert.equal(row.definition.includes(">="), false, row.conname + " must stay strict");
    assert.equal(row.definition.includes(">"), true, row.conname);
  }
  const membershipCheck = (await db.query(
    "select pg_get_constraintdef(c.oid) as definition from pg_constraint c"
    + " where c.conname = 'recruiter_team_memberships_check'")).rows[0].definition;
  assert.equal(membershipCheck.includes(">="), true,
    "the membership interval is the one CHECK #70 relaxes");

  // The pre-existing effective predicate still authorises a normal operator, so the
  // scope/capability behaviour is unchanged rather than merely un-tested.
  const operator = { auth: "10000000-0000-4000-8000-0000000000db",
    app: "20000000-0000-4000-8000-0000000000db" };
  await addActor(db, { ...operator, display_name: "Synthetic Predicate Operator",
    capabilities: ["catalog_master_manage"], scopes: ["all"] });
  const authorised = await rpc(db, "direct_entry_list_team_membership_current", {
    p_auth_subject: operator.auth, p_app_user_id: operator.app, p_page: 1, p_page_size: 25,
  });
  assert.equal(sortedKeys(authorised), ["authorization_date", "memberships", "page", "page_size",
    "total"].sort().join(","));

  // Membership markers exist (written by the audited RPC) and none is ever effective.
  const markerCount = (await db.query(
    "select count(*)::int as n from public.recruiter_team_memberships"
    + " where valid_to is not null and valid_to = valid_from")).rows[0].n;
  assert.equal(markerCount > 0, true, "the audited RPC writes cancellation markers");
  const effectiveMarkers = (await db.query(
    "select count(*)::int as n from public.recruiter_team_memberships"
    + " where valid_to is not null and valid_to = valid_from"
    + " and valid_from <= public.direct_entry_authorization_date()"
    + " and (valid_to is null or public.direct_entry_authorization_date() < valid_to)")).rows[0].n;
  assert.equal(effectiveMarkers, 0, "a cancellation marker is effective on no date");
});

test("closing an existing membership stays possible after creation eligibility is gone", async () => {
  // FIX R1: revocation must not depend on creation eligibility. Each subject below
  // holds an OPEN membership that was created while it was eligible, and is then made
  // ineligible in one of the three ways T0 named.
  const subjectVersion = async (recruiterId) => recruiterVersion(db, recruiterId);

  // 1. An inactive person with an open membership.
  const inactiveVersion = await subjectVersion(HRP_E);
  const inactiveOpen = (await db.query(
    "select count(*)::int as n from public.recruiter_team_memberships"
    + " where recruiter_id = $1::uuid and valid_to is null", [HRP_E])).rows[0].n;
  assert.equal(inactiveOpen, 1, "the prefix condition is an open membership");
  await db.query("update public.recruiters set active = false where recruiter_id = $1::uuid", [HRP_E]);

  // 2. An HRP provider membership that has since expired.
  const expiredVersion = await subjectVersion(HRP_F);
  await db.query("update public.recruiter_provider_memberships set valid_to = '2021-01-01'"
    + " where recruiter_id = $1::uuid and provider_type = 'hrp'", [HRP_F]);

  // 3. A provider that has since switched to Vendor, with a legacy business membership.
  const vendorVersion = await subjectVersion(HRP_H);
  await assign(db, CATALOG, { recruiter: HRP_H, team: TEAM_A, from: PAST, version: vendorVersion,
    key: KEY("90") });
  const legacyVersion = await subjectVersion(HRP_H);
  await db.query("update public.recruiter_provider_memberships set provider_type = 'vendor',"
    + " vendor_id = $2 where recruiter_id = $1::uuid and provider_type = 'hrp'",
  [HRP_H, VENDOR_ID]);

  const cases = [
    [HRP_E, "inactive person", await subjectVersion(HRP_E)],
    [HRP_F, "expired HRP provider", expiredVersion],
    [HRP_H, "provider switched to Vendor", legacyVersion],
  ];
  let caseIndex = 0;
  for (const [recruiter, label, version] of cases) {
    caseIndex += 1;
    const suffix = String(caseIndex);
    // assign and move are creation paths and must still deny.
    const assignError = await rpcError(db, "direct_entry_assign_team_membership", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: recruiter,
      p_team_id: TEAM_B, p_valid_from: "2026-06-01", p_expected_version: version,
      p_reason: REASON, p_idempotency_key: KEY("f" + suffix),
    });
    assert.equal(assignError.code, "P0002", label + " assign");
    const moveError = await rpcError(db, "direct_entry_move_team_membership", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: recruiter,
      p_team_id: TEAM_B, p_valid_from: "2026-06-01", p_expected_version: version,
      p_reason: REASON, p_idempotency_key: KEY("b" + suffix),
    });
    assert.equal(moveError.code, "P0002", label + " move");

    // A stale version is still rejected without residue on the close path too.
    const beforeStale = await counts(db);
    const stale = await rpcError(db, "direct_entry_unassign_team_membership", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: recruiter,
      p_valid_to: "2026-06-01", p_expected_version: version + 7, p_reason: REASON,
      p_idempotency_key: KEY("c" + suffix),
    });
    assert.equal(stale.code, "40001", label + " stale close");
    assert.deepEqual(await counts(db), beforeStale, label + " stale close residue");

    // Closing the open membership succeeds, without creating anything or re-dating.
    const openBefore = (await db.query(
      "select membership_id, team_id, valid_from::text as valid_from from"
      + " public.recruiter_team_memberships where recruiter_id = $1::uuid and valid_to is null",
      [recruiter])).rows;
    assert.equal(openBefore.length, 1, label + " has exactly one open membership");
    const closed = await unassign(db, CATALOG, { recruiter, to: "2026-06-01", version,
      key: KEY("d" + suffix) });
    assert.equal(closed.change, "UNASSIGN", label);
    assert.equal(closed.membership_id, openBefore[0].membership_id, label + " closes the same row");
    assert.equal(closed.team_id, openBefore[0].team_id, label + " never changes the team");
    assert.equal(closed.valid_from, openBefore[0].valid_from, label + " never re-dates valid_from");
    assert.equal(closed.valid_to, "2026-06-01", label);
    assert.equal(closed.recruiter_version, version + 1, label + " one version bump");

    const after = (await db.query(
      "select count(*)::int as n from public.recruiter_team_memberships"
      + " where recruiter_id = $1::uuid", [recruiter])).rows[0].n;
    assert.equal(after, (await db.query(
      "select count(*)::int as n from public.recruiter_team_memberships"
      + " where recruiter_id = $1::uuid and valid_to is not null", [recruiter])).rows[0].n,
    label + " creates no new membership row");
  }

  // The inactive subject was never re-activated by closing its membership.
  const inactiveRow = (await db.query(
    "select active from public.recruiters where recruiter_id = $1::uuid", [HRP_E])).rows[0];
  assert.equal(inactiveRow.active, false, "unassign never re-activates a person");
  assert.equal(inactiveVersion >= 1 && expiredVersion >= 1, true);
});

test("migration #70 is appended once and migrations #1-#69 are untouched", async () => {
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(names.includes(NEW_MIGRATION), "migration #70 must exist");
  assert.ok(NEW_MIGRATION > PREVIOUS_MIGRATION, "migration #70 applies after #69");
  assert.equal(names.filter((name) => name.startsWith("20261009060000")).length, 1,
    "exactly one migration occupies the #70 slot");
  assert.equal(names.filter((name) => name.startsWith("20261009050000")).length, 1);

  const symbols = [
    "direct_entry_team_membership_revisions",
    "direct_entry_list_team_membership_current",
    "direct_entry_list_team_membership_scheduled",
    "direct_entry_list_team_membership_history",
    "direct_entry_assign_team_membership",
    "direct_entry_move_team_membership",
    "direct_entry_unassign_team_membership",
    "direct_entry_guard_membership_cancel_marker",
    "direct_entry_reject_vendor_provider_team_membership",
    "recruiter_team_memberships_open_start_uidx",
  ];
  for (const name of names) {
    if (name >= NEW_MIGRATION) continue;
    const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
    for (const symbol of symbols) {
      assert.equal(sql.includes(symbol), false, symbol + " must not appear in " + name);
    }
  }
});

test("W01A, W01B and W01C-A contracts keep their semantics", async () => {
  const { rows: capabilityRows } = await db.query(
    "select pg_get_constraintdef(c.oid) as definition from pg_constraint c"
    + " join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace"
    + " where n.nspname = 'public' and t.relname = 'direct_entry_capability_grants'"
    + " and c.conname = 'direct_entry_capability_grants_capability_check'");
  const tokens = [...String(capabilityRows[0].definition).matchAll(/'([^']+)'::text/g)]
    .map((match) => match[1]);
  assert.equal(tokens.length, 23, "the W01A vocabulary is unchanged");

  const personnelSnapshot = (await db.query(
    "select pg_get_function_arguments(p.oid) as args from pg_proc p"
    + " join pg_namespace n on n.oid = p.pronamespace"
    + " where n.nspname = 'public' and p.proname = 'direct_entry_personnel_snapshot'")).rows;
  assert.deepEqual(personnelSnapshot.map((row) => row.args), ["p_recruiter recruiters"]);

  for (const signature of [
    "public.direct_entry_create_team(uuid,uuid,integer,text,text,text,text)",
    "public.direct_entry_set_team_active(uuid,uuid,uuid,boolean,integer,text,text)",
    "public.direct_entry_set_personnel_active(uuid,uuid,uuid,boolean,integer,text,text)",
  ]) {
    const { rows } = await db.query(
      "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_exec,"
      + " has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon_exec"
      + " from pg_proc p where p.oid = $1::regprocedure", [signature]);
    assert.deepEqual([rows[0].service_exec, rows[0].anon_exec], [true, false], signature);
  }

  // The reserved Vendor team still carries no business membership and no team scope.
  assert.equal((await db.query(
    "select count(*)::int as n from public.recruiter_team_memberships m"
    + " join public.teams t on t.team_id = m.team_id where t.code = $1", [RESERVED_CODE])).rows[0].n,
  0);
  assert.equal((await db.query(
    "select count(*)::int as n from public.direct_entry_scope_grants g"
    + " join public.teams t on t.team_id = g.team_id where t.code = $1", [RESERVED_CODE])).rows[0].n,
  0);
});
