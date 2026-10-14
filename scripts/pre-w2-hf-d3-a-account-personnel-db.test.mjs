/**
 * PRE-W2-HF-D3-A - Account/Personnel DB foundation (DB regression, PGlite over the 92-migration ledger).
 *
 * Covers the durable account-operation intent, the narrow RPCs (begin/claim/read/finish,
 * finalize, update display name, create personnel from account, reclassify), the symmetric
 * 1:1 account<->recruiter cardinality, the revision action extension and the
 * no-password / deny-by-default / OCC / idempotency / audit guarantees.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const D3A_MIGRATION = "20261014180000_pre_w2_hf_d3_a_account_personnel_db.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const LONE_AUTH = uuid(32), LONE_APP = uuid(42);   // entry_admin only
const ACC_AUTH = uuid(33), ACC_APP = uuid(43);      // catalog_master_manage only
const DISABLED_AUTH = uuid(34), DISABLED_APP = uuid(44);
const UNMAPPED_AUTH = uuid(35), UNMAPPED_APP = uuid(45);
// Target account used for reset/update/create-personnel scenarios.
const TARGET_AUTH = uuid(51), TARGET_APP = uuid(61);

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`migration ${name} failed to install: ${error.message}`, { cause: error });
    }
  }
  assert.equal(names.length, 92, "the ledger carries the PRE-W2-HF-D3-A migration as #92");
  assert.equal(names[names.length - 1], D3A_MIGRATION, "the D3-A migration is the latest slot");
  return db;
}

async function insertActor(db, auth, app, { capabilities = [], scopes = [], enabled = true } = {}) {
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
    " values ($1,$2,$3,'D3A Account')", [app, auth, enabled]);
  for (const capability of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)" +
      " values ($1,$2,'2020-01-01')", [app, capability]);
  }
  for (const scopeKind of scopes) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from)" +
      " values ($1,$2,$3,'2020-01-01')", [app, scopeKind, null]);
  }
}

const FULL_ADMIN = ["entry_admin", "recruiter_master_manage", "team_master_manage"];

async function seed(db) {
  await insertActor(db, ADMIN_AUTH, ADMIN_APP, { capabilities: FULL_ADMIN, scopes: ["all"] });
  await insertActor(db, LONE_AUTH, LONE_APP, { capabilities: ["entry_admin"], scopes: ["all"] });
  await insertActor(db, ACC_AUTH, ACC_APP, { capabilities: ["catalog_master_manage"], scopes: ["all"] });
  await insertActor(db, DISABLED_AUTH, DISABLED_APP, { capabilities: FULL_ADMIN, scopes: ["all"], enabled: false });
  // UNMAPPED_AUTH never inserted into direct_entry_app_users.
  await insertActor(db, TARGET_AUTH, TARGET_APP, { capabilities: ["entry_create"], scopes: ["own"] });
}

let keySeq = 0;
function idemKey() {
  keySeq += 1;
  return "d3a-key-" + String(900000 + keySeq);
}

async function rpc(db, name, args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(",");
  const res = await db.query(`select ${name}(${placeholders}) as data`, args);
  return res.rows[0].data;
}

const begin = (db, args) => rpc(db, "public.direct_entry_account_operation_begin", args);
const claim = (db, args) => rpc(db, "public.direct_entry_account_operation_claim", args);
const read = (db, args) => rpc(db, "public.direct_entry_account_operation_read", args);
const finish = (db, args) => rpc(db, "public.direct_entry_account_operation_finish", args);
const finalize = (db, args) => rpc(db, "public.direct_entry_account_operation_finalize_create", args);
const updateName = (db, args) => rpc(db, "public.direct_entry_account_operation_update_display_name", args);
const createPersonnel = (db, args) => rpc(db, "public.direct_entry_account_operation_create_personnel", args);
const reclassify = (db, args) => rpc(db, "public.direct_entry_account_operation_reclassify", args);

async function count(db, sql, params = []) {
  const res = await db.query(sql, params);
  return Number(Object.values(res.rows[0])[0]);
}

async function expectDenied(db, fn) {
  await assert.rejects(fn, (error) => error.code === "42501");
}

// ---------------------------------------------------------------------------
// 1. Intent lifecycle: begin -> claim -> read -> finish, idempotent begin.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: begin/claim/read/finish and idempotent begin", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const b = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create account", idemKey()]);
    assert.equal(b.kind, "CREATE_ACCOUNT");
    assert.equal(b.state, "PENDING");
    assert.ok(b.intent_id);
    assert.ok(b.intent_token);

    const c = await claim(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token]);
    assert.equal(c.claimed, true);
    assert.equal(c.state, "IN_FLIGHT");

    // Second claim loses: already IN_FLIGHT.
    const c2 = await claim(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token]);
    assert.equal(c2.claimed, false);
    assert.equal(c2.state, "IN_FLIGHT");

    const r = await read(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id]);
    assert.equal(r.state, "IN_FLIGHT");
    assert.equal(r.login_id, "abc123");
    assert.equal(r.display_name, "Alpha Beta");

    const f = await finish(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, "FAILED", null, null]);
    assert.equal(f.state, "FAILED");
    assert.ok(f.resolved_at);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Idempotent begin: same key returns byte-identical result; different input fails.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: begin is idempotent per key and rejects key reuse with different input", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const key = idemKey();
    const first = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create account", key]);
    const replay = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create account", key]);
    assert.deepEqual(replay, first);

    await assert.rejects(
      () => begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Different Name",
        null, "create account", key]),
      (error) => error.code === "22023");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Two concurrent creates for the same login_id: the unique live-login guard
//    allows only one.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: two concurrent creates for one login_id leave only one live intent", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create account", idemKey()]);
    await assert.rejects(
      () => begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Another Name",
        null, "create account", idemKey()]),
      (error) => error.code === "23505");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_account_operation_intents"), 1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 4. finalize create: correct provenance creates the app user; wrong token blocks.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: finalize creates the app user only with matching provenance", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const b = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create account", idemKey()]);
    await claim(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token]);

    const createdAuth = uuid(70);
    await db.query("insert into auth.users (id) values ($1)", [createdAuth]);

    const f = await finalize(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token,
      createdAuth, idemKey()]);
    assert.equal(f.intent_state, "APPLIED");
    assert.equal(f.auth_subject, createdAuth);
    assert.equal(f.display_name, "Alpha Beta");

    const appUser = (await db.query(
      "select enabled, display_name from public.direct_entry_app_users where app_user_id = $1",
      [f.app_user_id])).rows[0];
    assert.equal(appUser.enabled, true);
    assert.equal(appUser.display_name, "Alpha Beta");

    // No default capability/scope/link was granted.
    assert.equal(await count(db, "select count(*) from public.direct_entry_capability_grants where app_user_id = $1", [f.app_user_id]), 0);
    assert.equal(await count(db, "select count(*) from public.direct_entry_scope_grants where app_user_id = $1", [f.app_user_id]), 0);
    assert.equal(await count(db, "select count(*) from public.direct_entry_app_user_recruiter_links where app_user_id = $1", [f.app_user_id]), 0);

    const revision = (await db.query(
      "select action from public.direct_entry_app_user_revisions where app_user_id = $1", [f.app_user_id])).rows[0];
    assert.equal(revision.action, "account_created");
  } finally {
    await db.close();
  }
});

test("PRE-W2-HF-D3-A: finalize blocks a mismatched provenance token", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const b = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create account", idemKey()]);
    await claim(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token]);

    const createdAuth = uuid(71);
    await db.query("insert into auth.users (id) values ($1)", [createdAuth]);
    const wrongToken = uuid(72);

    const blocked = await finalize(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, wrongToken, createdAuth, idemKey()]);
    assert.equal(blocked.intent_state, "BLOCKED");
    const state = (await db.query(
      "select state from public.direct_entry_account_operation_intents where intent_id = $1",
      [b.intent_id])).rows[0].state;
    assert.equal(state, "BLOCKED");
    assert.equal(await count(db, "select count(*) from public.direct_entry_app_users"), 5);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 5. update display name: unlinked and linked (recruiter sync).
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: update display name updates the app user and its linked recruiter", async () => {
  const db = await buildDb();
  try {
    await seed(db);

    // Unlinked: only the app user changes.
    const u1 = await updateName(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "New Name", 1,
      "rename", idemKey()]);
    assert.equal(u1.version, 2);
    assert.equal(u1.recruiter_id, null);

    // Create personnel from the target account -> links a recruiter.
    const p = await createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "PC-001", "STAFF",
      "2026-01-05", "create personnel", idemKey()]);
    assert.equal(p.display_name, "New Name");

    // Linked: both app user and recruiter change together.
    const u2 = await updateName(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "Renamed Again", 2,
      "rename again", idemKey()]);
    assert.equal(u2.version, 3);
    assert.equal(u2.recruiter_id, p.recruiter_id);
    assert.equal(u2.recruiter_version, 2);

    const recruiter = (await db.query(
      "select display_name from public.recruiters where recruiter_id = $1", [p.recruiter_id])).rows[0];
    assert.equal(recruiter.display_name, "Renamed Again");
  } finally {
    await db.close();
  }
});

test("PRE-W2-HF-D3-A: update display name honours OCC and idempotency", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const key = idemKey();
    const first = await updateName(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "New Name", 1, "rename", key]);
    const replay = await updateName(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "New Name", 1, "rename", key]);
    assert.deepEqual(replay, first);

    await assert.rejects(
      () => updateName(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "Stale", 1, "rename", idemKey()]),
      (error) => error.code === "40001");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 6. create personnel from account: atomic, display_name from account,
//    conflict on personnel_code fails with zero residue.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: create personnel is atomic and rolls back on a code conflict", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const p = await createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "PC-001", "STAFF",
      "2026-01-05", "create personnel", idemKey()]);
    assert.equal(p.display_name, "D3A Account"); // server-side from account
    assert.ok(p.recruiter_id);
    assert.ok(p.link_id);
    assert.ok(p.membership_id);

    assert.equal(await count(db, "select count(*) from public.recruiters"), 1);
    assert.equal(await count(db, "select count(*) from public.recruiter_provider_memberships"), 1);
    assert.equal(await count(db, "select count(*) from public.direct_entry_app_user_recruiter_links"), 1);

    // A second unlinked account for the conflict check.
    const secondAuth = uuid(82), secondApp = uuid(83);
    await insertActor(db, secondAuth, secondApp, { capabilities: ["entry_create"], scopes: ["own"] });

    // Conflict: same personnel_code (on a different unlinked account) fails with no
    // recruiter/membership/link residue.
    const before = await count(db, "select count(*) from public.recruiters");
    await assert.rejects(
      () => createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, secondApp, "PC-001", "STAFF",
        "2026-01-05", "create personnel again", idemKey()]),
      (error) => error.code === "23505");
    assert.equal(await count(db, "select count(*) from public.recruiters"), before);
    assert.equal(await count(db, "select count(*) from public.recruiter_provider_memberships"), 1);
    assert.equal(await count(db, "select count(*) from public.direct_entry_app_user_recruiter_links"), 1);
  } finally {
    await db.close();
  }
});

test("PRE-W2-HF-D3-A: create personnel rejects disabled, already-linked and unknown accounts", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // Unknown account.
    await assert.rejects(
      () => createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, uuid(99), "PC-002", "STAFF", "2026-01-05", "r", idemKey()]),
      (error) => error.code === "P0002");

    // Already-linked account.
    await createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "PC-003", "STAFF", "2026-01-05", "r", idemKey()]);
    await assert.rejects(
      () => createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "PC-004", "STAFF", "2026-01-05", "r", idemKey()]),
      (error) => error.code === "23514");

    // Disabled account.
    await db.query("update public.direct_entry_app_users set enabled = false, version = version + 1 where app_user_id = $1", [TARGET_APP]);
    await assert.rejects(
      () => createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "PC-005", "STAFF", "2026-01-05", "r", idemKey()]),
      (error) => error.code === "23514");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Symmetric 1:1 cardinality: one recruiter -> one verified app-user link.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: a recruiter cannot gain a second verified app-user link", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "PC-001", "STAFF", "2026-01-05", "r", idemKey()]);
    // Create a second account and try to link it to the same recruiter directly.
    const secondAuth = uuid(80), secondApp = uuid(81);
    await insertActor(db, secondAuth, secondApp, { capabilities: ["entry_create"], scopes: ["own"] });
    const recruiter = (await db.query("select recruiter_id from public.recruiters")).rows[0].recruiter_id;

    await assert.rejects(
      () => db.query(
        "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from) values ($1,$2,true,'2026-01-05')",
        [secondApp, recruiter]),
      (error) => error.code === "23P01");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 8. Authority: only Full Admin triple + all scope; disabled / narrower / unmapped denied.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: only the Full Admin triple with all scope may mutate", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const args = [null, null, "CREATE_ACCOUNT", "abc123", "Alpha Beta", null, "create", idemKey()];

    await expectDenied(db, () => begin(db, [LONE_AUTH, LONE_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta", null, "create", idemKey()]));
    await expectDenied(db, () => begin(db, [ACC_AUTH, ACC_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta", null, "create", idemKey()]));
    await expectDenied(db, () => begin(db, [DISABLED_AUTH, DISABLED_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta", null, "create", idemKey()]));
    await expectDenied(db, () => begin(db, [UNMAPPED_AUTH, UNMAPPED_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta", null, "create", idemKey()]));

    await expectDenied(db, () => createPersonnel(db, [LONE_AUTH, LONE_APP, TARGET_APP, "PC-001", "STAFF", "2026-01-05", "r", idemKey()]));
    await expectDenied(db, () => updateName(db, [ACC_AUTH, ACC_APP, TARGET_APP, "X", 1, "r", idemKey()]));
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 9. No password/hash in schema, audit or projection.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: no password or hash is ever stored or projected", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const b = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create account", idemKey()]);
    const serialized = JSON.stringify(b);
    assert.ok(!/password|secret|hash/i.test(serialized));

    // The intent table has no password/hash column.
    const cols = (await db.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='direct_entry_account_operation_intents'"))
      .rows.map((r) => r.column_name);
    assert.equal(cols.some((c) => /password|secret|hash/i.test(c)), false);

    // The begin audit event stores only internal references, never a password.
    const audit = (await db.query(
      "select action, resource_ref from public.direct_entry_audit_events where action = 'account_operation_begin' order by created_at desc limit 1"))
      .rows[0];
    assert.ok(audit.resource_ref);
    assert.ok(!/password|secret|hash/i.test(audit.resource_ref));
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 10. Reclassify: PENDING expires, IN_FLIGHT becomes INDETERMINATE.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: reclassify moves stale intents to their terminal states", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const pending = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create", idemKey()]);
    await db.query("update public.direct_entry_account_operation_intents set created_at = now() - interval '20 minutes' where intent_id = $1", [pending.intent_id]);

    const inFlight = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "xyz789", "Charlie",
      null, "create", idemKey()]);
    await claim(db, [ADMIN_AUTH, ADMIN_APP, inFlight.intent_id, inFlight.intent_token]);
    await db.query("update public.direct_entry_account_operation_intents set claimed_at = now() - interval '20 minutes' where intent_id = $1", [inFlight.intent_id]);

    const result = await reclassify(db, [ADMIN_AUTH, ADMIN_APP]);
    assert.ok(result.reclassified >= 2);

    const s1 = (await db.query("select state from public.direct_entry_account_operation_intents where intent_id = $1", [pending.intent_id])).rows[0].state;
    const s2 = (await db.query("select state from public.direct_entry_account_operation_intents where intent_id = $1", [inFlight.intent_id])).rows[0].state;
    assert.equal(s1, "EXPIRED");
    assert.equal(s2, "INDETERMINATE");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 11. Migration self-check: ACL, search_path, signature posture.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: the migration locks the RPC boundary and revision action vocabulary", async () => {
  const db = await buildDb();
  try {
    const report = (await db.query(
      "select p.prosecdef, p.proconfig::text as config from pg_proc p" +
      " where p.oid = 'public.direct_entry_account_operation_claim(uuid,uuid,uuid,uuid)'::regprocedure")).rows[0];
    assert.equal(report.prosecdef, true);
    assert.ok(report.config.includes("search_path=pg_catalog, public"));

    const acl = (await db.query(
      "select has_function_privilege('service_role', p.oid, 'EXECUTE') as s," +
      " has_function_privilege('anon', p.oid, 'EXECUTE') as a," +
      " has_function_privilege('authenticated', p.oid, 'EXECUTE') as u" +
      " from pg_proc p where p.oid = 'public.direct_entry_account_operation_begin(uuid,uuid,text,text,text,uuid,text,text)'::regprocedure")).rows[0];
    assert.deepEqual(acl, { s: true, a: false, u: false });

    // Revision action vocabulary includes the two new meaningful actions.
    const actions = (await db.query(
      "select pg_get_constraintdef(oid) as d from pg_constraint" +
      " where conname = 'direct_entry_app_user_revisions_action_check'")).rows[0].d;
    assert.ok(actions.includes("account_created"));
    assert.ok(actions.includes("display_name_update"));
  } finally {
    await db.close();
  }
});
