/**
 * Attendance Backend WP1 — Real PostgreSQL Concurrency Regression Suite.
 *
 * Proves against isolated local PostgreSQL (no remote DB):
 *   1. Two concurrent check-ins for the same actor & business_date serialize via
 *      per-actor transaction advisory lock and receive distinct sequence_in_day (1, 2)
 *      without unique-violation races.
 *   2. Two concurrent retries with the same actor, idempotency_key, and fingerprint
 *      serialize cleanly, create exactly 1 row, and return the identical checkin_id.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import {
  ATTENDANCE_PHOTO_MIME_TYPE,
  computeAttendanceRequestFingerprint,
} from "../src/lib/attendance/attendance-contract.ts";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const ACTOR = {
  auth: "19000000-0000-4000-8000-000000000001",
  app: "29000000-0000-4000-8000-000000000001",
};

function binary(name) {
  const binDir =
    process.env.P3_1_W02A_PG_BIN ??
    (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  return result.error ? null : candidate;
}

function run(file, args, { ignoreOutput = false } = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(ignoreOutput ? { stdio: "ignore" } : {}),
  });
  assert.equal(
    result.status,
    0,
    `${path.basename(file)} failed:\n${result.stderr || result.stdout}`,
  );
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function connect(port, database = "postgres", applicationName = "attendance-wp1-race") {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    application_name: applicationName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function waitUntilBlocked(observer, applicationName) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      "select wait_event_type from pg_stat_activity where application_name = $1",
      [applicationName],
    );
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`session ${applicationName} did not block on advisory lock`);
}

async function applyMigrations(client) {
  await client.query(
    "create role anon; create role authenticated; create role service_role;" +
      " create schema auth; create table auth.users (id uuid primary key);",
  );
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(
    names.includes("20261023180000_attendance_wp1_checkin_sync.sql"),
    "migration inventory must include 20261023180000_attendance_wp1_checkin_sync.sql",
  );
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

function buildParams({ idempotencyKey, capturedIso, shaChar }) {
  const photoSha256 = shaChar.repeat(64);
  const fingerprint = computeAttendanceRequestFingerprint({
    app_user_id: ACTOR.app,
    latitude: 10.7769,
    longitude: 106.7009,
    accuracy_meters: 9.0,
    address_hint: "TP.HCM",
    note: "",
    device_claimed_at_ms: Date.parse(capturedIso),
    time_source: "DEVICE_CLOCK_UNVERIFIED",
    time_token_digest: null,
    elapsed_since_anchor_ms: null,
    photo_sha256: photoSha256,
    photo_size_bytes: 2048,
    photo_mime_type: ATTENDANCE_PHOTO_MIME_TYPE,
  });

  return [
    ACTOR.auth,
    ACTOR.app,
    idempotencyKey,
    fingerprint,
    10.7769,
    106.7009,
    9.0,
    "TP.HCM",
    "",
    capturedIso,
    "DEVICE_CLOCK_UNVERIFIED",
    null,
    null,
    null,
    `preview/attendance-checkins/${ACTOR.app}/${idempotencyKey}.jpg`,
    photoSha256,
    2048,
    ATTENDANCE_PHOTO_MIME_TYPE,
  ];
}

const CALL_RPC_SQL = `
  select public.attendance_record_checkin(
    $1::uuid, $2::uuid, $3::uuid, $4::text,
    $5::double precision, $6::double precision, $7::double precision,
    $8::text, $9::text, $10::timestamptz, $11::text,
    $12::timestamptz, $13::bigint, $14::text,
    $15::text, $16::text, $17::integer, $18::text
  ) as data
`;

test("concurrent check-ins allocate distinct sequence_in_day and concurrent same-key retries return one checkin_id", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL initdb and pg_ctl are required for the real concurrency regression");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "attendance-wp1-concurrency-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  let serverStarted = false;
  let adminClient;
  let setup;
  let worker1;
  let worker2;
  let observer;
  let databaseName;

  try {
    run(initdb, [
      "--username=postgres",
      "--auth-local=trust",
      "--auth-host=trust",
      "--no-locale",
      "--encoding=UTF8",
      "--pgdata",
      dataDir,
    ]);
    run(
      pgCtl,
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "-o",
        `-h 127.0.0.1 -p ${port}${process.platform === "win32" ? "" : ` -k ${tempDir}`}`,
        "-w",
        "start",
      ],
      { ignoreOutput: process.platform === "win32" },
    );
    serverStarted = true;
    databaseName = `attendance_wp1_${process.pid}`;
    adminClient = await connect(port);
    await adminClient.query(`create database ${databaseName}`);

    setup = await connect(port, databaseName, "att-wp1-setup");
    await applyMigrations(setup);
    await setup.query("insert into auth.users(id) values ($1)", [ACTOR.auth]);
    await setup.query(
      "insert into public.direct_entry_app_users(app_user_id, auth_subject, enabled, display_name)" +
        " values ($1, $2, true, 'Concurrent Actor')",
      [ACTOR.app, ACTOR.auth],
    );
    await setup.end();
    setup = undefined;

    worker1 = await connect(port, databaseName, "att-wp1-worker-1");
    worker2 = await connect(port, databaseName, "att-wp1-worker-2");
    observer = await connect(port, databaseName, "att-wp1-observer");

    // -------------------------------------------------------------------------
    // Race 1: Two concurrent check-ins on the same HCM business_date (2026-10-20)
    // -------------------------------------------------------------------------
    const keyA = "f1000000-0000-4000-8000-000000000001";
    const keyB = "f1000000-0000-4000-8000-000000000002";

    await worker1.query("begin");
    await worker1.query("set local role service_role");
    const firstInsertRes = await worker1.query(
      CALL_RPC_SQL,
      buildParams({
        idempotencyKey: keyA,
        capturedIso: "2026-10-20T01:00:00.000Z",
        shaChar: "1",
      }),
    );
    const firstCheckin = firstInsertRes.rows[0].data;
    assert.equal(firstCheckin.sequence_in_day, 1);
    assert.equal(firstCheckin.replayed, false);

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const waitingSecondPromise = worker2.query(
      CALL_RPC_SQL,
      buildParams({
        idempotencyKey: keyB,
        capturedIso: "2026-10-20T02:00:00.000Z",
        shaChar: "2",
      }),
    );

    await waitUntilBlocked(observer, "att-wp1-worker-2");
    await worker1.query("commit");

    const secondInsertRes = await waitingSecondPromise;
    await worker2.query("commit");
    const secondCheckin = secondInsertRes.rows[0].data;
    assert.equal(secondCheckin.business_date, "2026-10-20");
    assert.equal(secondCheckin.sequence_in_day, 2);
    assert.equal(secondCheckin.daily_count, 2);
    assert.equal(secondCheckin.replayed, false);
    assert.notEqual(secondCheckin.checkin_id, firstCheckin.checkin_id);

    // -------------------------------------------------------------------------
    // Race 2: Two concurrent retries with the SAME idempotency_key (`keySame`)
    // -------------------------------------------------------------------------
    const keySame = "f1000000-0000-4000-8000-000000000003";
    const sameParams = buildParams({
      idempotencyKey: keySame,
      capturedIso: "2026-10-20T03:00:00.000Z",
      shaChar: "3",
    });

    await worker1.query("begin");
    await worker1.query("set local role service_role");
    const leaderRes = await worker1.query(CALL_RPC_SQL, sameParams);
    const leaderCheckin = leaderRes.rows[0].data;
    assert.equal(leaderCheckin.sequence_in_day, 3);
    assert.equal(leaderCheckin.replayed, false);

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const followerPromise = worker2.query(CALL_RPC_SQL, sameParams);

    await waitUntilBlocked(observer, "att-wp1-worker-2");
    await worker1.query("commit");

    const followerRes = await followerPromise;
    await worker2.query("commit");
    const followerCheckin = followerRes.rows[0].data;

    assert.equal(followerCheckin.checkin_id, leaderCheckin.checkin_id);
    assert.equal(followerCheckin.sequence_in_day, 3);
    assert.equal(followerCheckin.daily_count, 3);
    assert.equal(followerCheckin.replayed, true);

    const { rows: finalRows } = await observer.query(
      "select sequence_in_day, idempotency_key from public.attendance_checkins" +
        " where app_user_id = $1 order by sequence_in_day asc",
      [ACTOR.app],
    );
    assert.deepEqual(
      finalRows.map((r) => ({ seq: r.sequence_in_day, key: r.idempotency_key })),
      [
        { seq: 1, key: keyA },
        { seq: 2, key: keyB },
        { seq: 3, key: keySame },
      ],
    );
  } finally {
    await worker1?.query("rollback").catch(() => {});
    await worker2?.query("rollback").catch(() => {});
    await observer?.end().catch(() => {});
    await worker1?.end().catch(() => {});
    await worker2?.end().catch(() => {});
    await setup?.end().catch(() => {});
    await adminClient?.query(`drop database if exists ${databaseName}`).catch(() => {});
    await adminClient?.end().catch(() => {});
    if (serverStarted) {
      spawnSync(pgCtl, ["-D", dataDir, "-m", "fast", "-w", "stop"], {
        encoding: "utf8",
        windowsHide: true,
      });
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
