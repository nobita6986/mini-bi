/**
 * P2.5-HF-R5B - importer regression (PGlite + canonical RPC path).
 * Moi assert deu di qua chinh runImport/RPC/transaction cua CLI; khong mock canonical data.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { parseImportArgs, runImport } from "./t0-import-workers.mjs";
import { IMPORT_REQUIRED_MIGRATIONS } from "./lib/t0-operator-import.mjs";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BATCH_A = "00000000-0000-4000-8000-000000009001";
const BATCH_B = "00000000-0000-4000-8000-000000009002";
const BATCH_C = "00000000-0000-4000-8000-000000009003";
const OPERATOR_LOGIN = "t0-ops@example.test";
const CCCD = "012345678901";
const OTHER_CCCD = "999888777666";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_A = "t0_proj_a", PROJ_B = "t0_proj_b";
const REC_A = uuid(21), REC_B = uuid(22);
const OPS_AUTH = uuid(31), OPS_APP = uuid(41);
const MGR_AUTH = uuid(32), MGR_APP = uuid(42);
const MGR_LOGIN = "t0-mgr@example.test";

const MIGRATION_DIR = path.resolve("supabase/migrations");

async function buildDb(ledger = IMPORT_REQUIRED_MIGRATIONS) {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role;" +
    " create schema auth; create table auth.users (id uuid primary key, email text);");
  for (const name of (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort()) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  await db.exec("create table public.schema_migrations (version text primary key, checksum text)");
  for (const version of ledger) {
    await db.query("insert into public.schema_migrations (version, checksum) values ($1,'x')",
      [version]);
  }
  return db;
}

async function insertActor(db, auth, app, email, capabilities, scopeKinds) {
  await db.query("insert into auth.users (id, email) values ($1,$2)", [auth, email]);
  await db.query("insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled)" +
    " values ($1,$2,true)", [app, auth]);
  for (const capability of capabilities) {
    await db.query("insert into public.direct_entry_capability_grants" +
      " (app_user_id, capability, valid_from) values ($1,$2,'2020-01-01')", [app, capability]);
  }
  for (const scopeKind of scopeKinds) {
    await db.query("insert into public.direct_entry_scope_grants" +
      " (app_user_id, scope_kind, valid_from) values ($1,$2,'2020-01-01')", [app, scopeKind]);
  }
}

async function seed(db) {
  await db.query("insert into public.teams (team_id, code, display_name)" +
    " values ($1,'T0OPS','Team T0 Ops')", [TEAM]);
  for (const [project, name] of [[PROJ_A, "T0 Project A"], [PROJ_B, "T0 Project B"]]) {
    await db.query("insert into public.direct_entry_projects (project_id, display_name)" +
      " values ($1,$2)", [project, name]);
  }
  for (const [recruiter, name] of [[REC_A, "Rec A"], [REC_B, "Rec B"]]) {
    await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,$2)",
      [recruiter, name]);
    await db.query("insert into public.recruiter_provider_memberships" +
      " (recruiter_id, provider_type, valid_from) values ($1,'hrp','2020-01-01')", [recruiter]);
    await db.query("insert into public.recruiter_team_memberships" +
      " (recruiter_id, team_id, valid_from) values ($1,$2,'2020-01-01')", [recruiter, TEAM]);
  }
  await insertActor(db, OPS_AUTH, OPS_APP, OPERATOR_LOGIN,
    ["entry_admin", "entry_create", "submission_create"], ["own", "all"]);
  // Manager: assignment authority only, no legacy bundle, no all scope.
  await insertActor(db, MGR_AUTH, MGR_APP, MGR_LOGIN, ["change_request_create"], []);
  await db.query("insert into public.direct_entry_project_manager_assignments" +
    " (project_id, manager_recruiter_id, valid_from) values ($1,$2,'2020-01-01')", [PROJ_B, REC_B]);
  await db.query("insert into public.direct_entry_app_user_recruiter_links" +
    " (app_user_id, recruiter_id, verified, valid_from) values ($1,$2,true,'2020-01-01')",
    [MGR_APP, REC_B]);
}

function clientOf(db, override = null) {
  return {
    query: (sql, params) => (override ? override(sql, params, db) : db.query(sql, params)),
    end: async () => {},
  };
}

function dependenciesFor(db, override = null) {
  const calls = { connect: 0 };
  return {
    calls,
    deps: {
      loadConfig: async () => ({ databaseUrl: "unused" }),
      createClient: () => {
        calls.connect += 1;
        return clientOf(db, override);
      },
    },
  };
}

async function manifestFile(rows, targetState = "DRAFT") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "t0-import-"));
  const file = path.join(directory, "manifest.json");
  await writeFile(file, JSON.stringify({ version: "t0-worker-import/1.0",
    target_state: targetState, rows }, null, 2), "utf8");
  return file;
}

function row(overrides = {}) {
  return {
    source_row_id: "1",
    project_id: PROJ_A,
    recruiter_id: REC_A,
    first_work_date: "2026-10-01",
    labor_type: "TEMPORARY",
    provider_type: "hrp",
    display_name: "T0 Worker",
    national_id: CCCD,
    date_of_birth: "1990-01-01",
    address: "T0 address",
    phone: "0900000000",
    ...overrides,
  };
}

async function options(input, batchId, mode = "apply", confirm = undefined) {
  const base = { mode, input, batchId, operator: OPERATOR_LOGIN, reason: "T0 operator import",
    confirm: confirm ?? null };
  if (mode === "apply" && confirm === undefined) {
    const manifest = await import("./lib/t0-operator-import.mjs").then((m) =>
      m.readImportManifest(path.resolve(input)));
    const m = await import("./lib/t0-operator-import.mjs");
    base.confirm = m.confirmationToken(manifest.fingerprint);
  }
  return base;
}

async function entryCount(db) {
  return Number((await db.query("select count(*)::int as n from public.direct_entries")).rows[0].n);
}

function assertNoLeak(payload, secrets = []) {
  const serialized = JSON.stringify(payload);
  assert.equal(UUID_RE.test(serialized), false, "no UUID in output");
  assert.equal(serialized.includes("@"), false, "no email in output");
  for (const secret of [...secrets, CCCD, OTHER_CCCD, "T0 Worker", "T0 address", "0900000000",
    "violates", "constraint", "direct_entries"]) {
    assert.equal(serialized.includes(secret), false, "leaked: " + secret);
  }
}

test("R5B: arguments and confirmation token are checked before any connection", async () => {
  assert.throws(() => parseImportArgs(["--check", "--input"]), /ARGUMENTS_INVALID/);
  assert.throws(() => parseImportArgs(["--apply", "--input", "x", "--bogus"]), /ARGUMENTS_INVALID/);
  const parsed = parseImportArgs(["--check", "--input", "m.json", "--batch-id", BATCH_A,
    "--operator", OPERATOR_LOGIN, "--reason", "r"]);
  assert.deepEqual(parsed, { mode: "check", input: "m.json", batchId: BATCH_A,
    operator: OPERATOR_LOGIN, reason: "r", confirm: null });

  const db = await buildDb();
  try {
    const input = await manifestFile([row()]);
    const expected = await options(input, BATCH_A, "check");
    const missingToken = dependenciesFor(db);
    const denied = await runImport({ ...expected, mode: "apply", confirm: null },
      missingToken.deps);
    assert.equal(denied.code, "CONFIRMATION_REQUIRED");
    const wrongToken = dependenciesFor(db);
    const wrong = await runImport({ ...expected, mode: "apply", confirm: "T0_WRONG" },
      wrongToken.deps);
    assert.equal(wrong.code, "CONFIRMATION_REQUIRED");
    assert.equal(missingToken.calls.connect + wrongToken.calls.connect, 0,
      "no DB connection may be opened without the token");
    const checkWithConfirm = dependenciesFor(db);
    const rejected = await runImport({ ...expected, mode: "check", confirm: "T0_WRONG" },
      checkWithConfirm.deps);
    assert.equal(rejected.code, "OPERATOR_INPUT_INVALID");
    assert.equal(checkWithConfirm.calls.connect, 0);
  } finally {
    await db.close();
  }
});

test("R5B: manifest validation refuses a bad CMT/CCCD without leaking it", async () => {
  const db = await buildDb();
  try {
    const input = await manifestFile([row({ national_id: "0123 456 78901" })]);
    const deps = dependenciesFor(db);
    const result = await runImport(await options(input, BATCH_A), deps.deps);
    assert.equal(result.code, "MANIFEST_INVALID");
    assert.deepEqual(result.errors, [{ code: "ROW_NATIONAL_ID_INVALID", source_row_id: "1",
      severity: "error" }]);
    assert.equal(await entryCount(db), 0);
    assert.equal(deps.calls.connect, 0, "local validation runs before the DB");
    assertNoLeak(result, ["012345678901", "0123 456 78901"]);
  } finally {
    await db.close();
  }
});

test("R5B: check mode runs the real transaction, post-checks and rolls everything back", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const input = await manifestFile([row(), row({ source_row_id: "2", national_id: OTHER_CCCD,
      display_name: "T0 Worker Two", project_id: PROJ_B, recruiter_id: REC_B })]);
    const deps = dependenciesFor(db);
    const result = await runImport(await options(input, BATCH_A, "check"), deps.deps);
    assert.equal(result.ok, true);
    assert.equal(result.committed, false);
    assert.equal(result.summary.rows, 2);
    assert.equal(result.checks.status_on, 2);
    assert.equal(result.checks.metadata, 2);
    assert.equal(result.checks.audit, 2);
    assert.equal(await entryCount(db), 0, "check mode leaves zero residue");
    assertNoLeak(result);
  } finally {
    await db.close();
  }
});

test("R5B: apply commits, replay is idempotent and a changed payload conflicts", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const input = await manifestFile([row()]);
    const first = await runImport(await options(input, BATCH_A),
      dependenciesFor(db).deps);
    assert.equal(first.ok, true);
    assert.equal(first.committed, true);
    assert.equal(await entryCount(db), 1);
    const created = (await db.query("select e.entry_id::text as id, e.employee_code, e.version," +
      " (select st.status from public.direct_entry_employment_status_events st" +
      "   where st.entry_id = e.entry_id order by st.version desc limit 1) as status," +
      " (select count(*)::int from public.direct_entry_employment_status_events st" +
      "   where st.entry_id = e.entry_id) as events," +
      " worker_details->'national_id'->>'value' as national_id" +
      " from public.direct_entries e")).rows[0];
    assert.equal(created.status, "ON", "#57 default without an extra ON event");
    assert.equal(Number(created.events), 1);
    assert.equal(created.national_id, CCCD, "leading zero preserved");
    assert.match(created.employee_code, /^hrp-\d{4}-\d{6}$/);

    // Replay: same batch id + same payload -> same result, no second write.
    const replay = await runImport(await options(input, BATCH_A), dependenciesFor(db).deps);
    assert.equal(replay.ok, true);
    assert.equal(await entryCount(db), 1, "replay must not duplicate rows");

    // Same batch id, different payload -> conflict, still one row.
    const changed = await manifestFile([row({ display_name: "T0 Worker Changed" })]);
    const conflict = await runImport(await options(changed, BATCH_A), dependenciesFor(db).deps);
    assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(await entryCount(db), 1);
    assertNoLeak(conflict, ["T0 Worker Changed"]);

    // A bad row fails the whole batch with zero residue.
    const mixed = await manifestFile([row({ source_row_id: "1", national_id: "111111111111" }),
      row({ source_row_id: "2", project_id: "t0_missing_project", national_id: "222222222222" })]);
    const failed = await runImport(await options(mixed, BATCH_B), dependenciesFor(db).deps);
    assert.equal(failed.ok, false);
    assert.ok(["PROJECT_NOT_ACTIVE", "ROW_INVALID", "AUTHORITY_DENIED"].includes(failed.code),
      "safe code expected, got " + failed.code);
    assert.equal(await entryCount(db), 1, "mixed batch must not partially write");
    assertNoLeak(failed, ["111111111111", "222222222222", "t0_missing_project"]);
  } finally {
    await db.close();
  }
});

test("R5B: an active episode is refused and a closed episode allows a new one", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const first = await runImport(await options(await manifestFile([row()]), BATCH_A),
      dependenciesFor(db).deps);
    assert.equal(first.ok, true);
    const before = (await db.query("select e.entry_id::text as id, e.employee_code, e.version" +
      " from public.direct_entries e")).rows[0];

    // Same CCCD, another batch, still ON -> the whole batch is refused.
    const blocked = await runImport(await options(await manifestFile([row({ source_row_id: "9" })]),
      BATCH_B), dependenciesFor(db).deps);
    assert.equal(blocked.code, "ACTIVE_EPISODE_EXISTS");
    assert.equal(await entryCount(db), 1);

    // Close the episode through the canonical status path (DRAFT submission), then rehire.
    const reasonId = (await db.query("insert into public.direct_entry_restricted_reasons" +
      " (actor_user_id, reason_text) values ($1,'T0 leave') returning reason_id::text as id",
      [OPS_APP])).rows[0].id;
    await db.query("insert into public.direct_entry_employment_status_events" +
      " (entry_id, status, effective_date, leave_date, leave_reason_text, version, actor_user_id," +
      " reason_id) values ($1::uuid,'OFF','2026-10-05','2026-10-05','T0 synthetic leave',2,$2,$3)",
      [before.id, OPS_APP, reasonId]);
    await db.query("update public.direct_entries set version = version + 1 where entry_id = $1::uuid",
      [before.id]);

    const rehire = await runImport(await options(await manifestFile([row({ source_row_id: "9" })]),
      BATCH_C), dependenciesFor(db).deps);
    assert.equal(rehire.ok, true);
    assert.equal(await entryCount(db), 2, "a new episode is created");
    const rows = (await db.query("select e.entry_id::text as id, e.employee_code," +
      " (select st.status from public.direct_entry_employment_status_events st" +
      "   where st.entry_id = e.entry_id order by st.version desc limit 1) as status" +
      " from public.direct_entries e order by e.employee_code")).rows;
    const old = rows.find((item) => item.id === before.id);
    assert.equal(old.employee_code, before.employee_code, "the old episode is never edited");
    assert.equal(old.status, "OFF", "the old episode keeps its history");
    const fresh = rows.find((item) => item.id !== before.id);
    assert.notEqual(fresh.employee_code, before.employee_code, "a new employee code is issued");
    assert.equal(fresh.status, "ON");
  } finally {
    await db.close();
  }
});

test("R5B: authority and ledger gates fail closed with zero residue", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // A manager of project B may not import into project A.
    const managerOptions = { ...(await options(await manifestFile([row()]), BATCH_A)),
      operator: MGR_LOGIN };
    const denied = await runImport(managerOptions, dependenciesFor(db).deps);
    assert.equal(denied.code, "AUTHORITY_DENIED");
    assert.equal(await entryCount(db), 0);
    assertNoLeak(denied);

    // Unknown operator: no writes, no leak.
    const unknown = await runImport({ ...managerOptions, operator: "nobody@example.test" },
      dependenciesFor(db).deps);
    assert.equal(unknown.code, "OPERATOR_NOT_FOUND");
    assert.equal(await entryCount(db), 0);

    // Expired assignment is not effective either.
    await db.query("update public.direct_entry_project_manager_assignments" +
      " set valid_from = '2020-01-01', valid_to = '2020-06-01' where project_id = $1", [PROJ_B]);
    const expired = await runImport(managerOptions, dependenciesFor(db).deps);
    assert.equal(expired.code, "AUTHORITY_DENIED");
    assert.equal(await entryCount(db), 0);
  } finally {
    await db.close();
  }
});

test("R5B: a missing required migration stops apply and is reported safely", async () => {
  const ledger = IMPORT_REQUIRED_MIGRATIONS.slice(0, -1);
  const db = await buildDb(ledger);
  try {
    await seed(db);
    const input = await manifestFile([row()]);
    const apply = await runImport(await options(input, BATCH_A), dependenciesFor(db).deps);
    assert.equal(apply.code, "MIGRATION_LEDGER_PENDING");
    assert.equal(apply.ledger.required_pending, 1);
    assert.deepEqual(apply.ledger.pending_names, [IMPORT_REQUIRED_MIGRATIONS.at(-1)]);
    assert.equal(await entryCount(db), 0);
    const check = await runImport(await options(input, BATCH_A, "check"),
      dependenciesFor(db).deps);
    assert.equal(check.code, "MIGRATION_LEDGER_PENDING");
    assert.equal(check.ledger.pending_names.length, 1);
    assertNoLeak(apply);
  } finally {
    await db.close();
  }
});

test("R5B: a failing post-check rolls the whole batch back", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const input = await manifestFile([row()]);
    const override = async (sql, params, inner) => {
      const result = await inner.query(sql, params);
      if (sql.includes("as latest_status")) {
        return { rows: result.rows.map((item) => ({ ...item, latest_status: "OFF" })) };
      }
      return result;
    };
    const result = await runImport(await options(input, BATCH_A),
      dependenciesFor(db, override).deps);
    assert.equal(result.code, "POSTCHECK_FAILED");
    assert.deepEqual(result.acceptance.problems, [
      { code: "POSTCHECK_STATUS_NOT_ON", source_row_id: "1", severity: "error" },
    ]);
    assert.equal(await entryCount(db), 0, "post-check failure must roll back");
    assertNoLeak(result);
  } finally {
    await db.close();
  }
});
