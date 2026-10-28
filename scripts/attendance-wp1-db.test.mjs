/**
 * Attendance Backend WP1 — PGlite Database, Migration Rollback, ACL, Immutability,
 * Time Semantics & Idempotency Test Suite.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import {
  ATTENDANCE_MAX_SYNC_WINDOW_MS,
  ATTENDANCE_PHOTO_MIME_TYPE,
  ATTENDANCE_TIME_TOKEN_TTL_MS,
  computeAttendanceRequestFingerprint,
} from "../src/lib/attendance/attendance-contract.ts";
import {
  ATTENDANCE_WP1_MIGRATION_NAME,
  ATTENDANCE_WP1_RPC_SIGNATURES,
  migrationChecksum,
  migrationSqlForTransaction,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const ACTIVE_ACTOR_A = {
  auth: "18000000-0000-4000-8000-000000000001",
  app: "28000000-0000-4000-8000-000000000001",
  name: "Nhân Viên Chấm Công A",
};
const ACTIVE_ACTOR_B = {
  auth: "18000000-0000-4000-8000-000000000002",
  app: "28000000-0000-4000-8000-000000000002",
  name: "Nhân Viên Chấm Công B",
};
const DISABLED_ACTOR = {
  auth: "18000000-0000-4000-8000-000000000003",
  app: "28000000-0000-4000-8000-000000000003",
  name: "Nhân Viên Đã Khóa",
};

const PHOTO_SHA_1 = "a".repeat(64);
const PHOTO_SHA_2 = "b".repeat(64);
const TOKEN_DIGEST_1 = "c".repeat(64);

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function createDatabase({ stopBeforeAttendance = false } = {}) {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = await loadMigrations();
  const targetIndex = migrations.findIndex(
    (m) => m.name === ATTENDANCE_WP1_MIGRATION_NAME,
  );
  assert.ok(
    targetIndex >= 0,
    "Attendance WP1 migration must exist in supabase/migrations",
  );
  const slice = stopBeforeAttendance
    ? migrations.slice(0, targetIndex)
    : migrations;
  for (const m of slice) {
    await db.exec(m.sql);
  }
  return { db, migrations, targetMigration: migrations[targetIndex] };
}

async function seedActors(db) {
  for (const [actor, enabled] of [
    [ACTIVE_ACTOR_A, true],
    [ACTIVE_ACTOR_B, true],
    [DISABLED_ACTOR, false],
  ]) {
    await db.query("insert into auth.users(id) values ($1)", [actor.auth]);
    await db.query(
      "insert into public.direct_entry_app_users(app_user_id, auth_subject, enabled, display_name)" +
        " values ($1, $2, $3, $4)",
      [actor.app, actor.auth, enabled, actor.name],
    );
  }
}

async function callLookupAsServiceRole(db, args) {
  await db.exec("begin; set local role service_role;");
  try {
    const res = await db.query(
      `select public.attendance_lookup_checkin_idempotency(
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::text
      ) as data`,
      [
        args.auth_subject,
        args.app_user_id,
        args.idempotency_key,
        args.request_fingerprint,
      ],
    );
    await db.exec("commit;");
    return res.rows[0].data;
  } catch (err) {
    await db.exec("rollback;");
    throw err;
  }
}

async function callCheckInAsServiceRole(db, args) {
  await db.exec("begin; set local role service_role;");
  try {
    const res = await db.query(
      `select public.attendance_record_checkin(
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::text,
        $5::double precision,
        $6::double precision,
        $7::double precision,
        $8::text,
        $9::text,
        $10::timestamptz,
        $11::text,
        $12::timestamptz,
        $13::bigint,
        $14::text,
        $15::text,
        $16::text,
        $17::integer,
        $18::text,
        $19::timestamptz
      ) as data`,
      [
        args.auth_subject,
        args.app_user_id,
        args.idempotency_key,
        args.request_fingerprint,
        args.latitude,
        args.longitude,
        args.accuracy_meters,
        args.address_hint,
        args.note,
        args.device_claimed_at,
        args.time_source,
        args.time_anchor_issued_at,
        args.elapsed_since_anchor_ms,
        args.time_token_digest,
        args.photo_storage_key,
        args.photo_sha256,
        args.photo_size_bytes,
        args.photo_mime_type,
        args.received_at,
      ],
    );
    await db.exec("commit;");
    return res.rows[0].data;
  } catch (err) {
    await db.exec("rollback;");
    throw err;
  }
}

function buildRpcArgs(overrides = {}) {
  const base = {
    auth_subject: ACTIVE_ACTOR_A.auth,
    app_user_id: ACTIVE_ACTOR_A.app,
    idempotency_key: "e1000000-0000-4000-8000-000000000001",
    latitude: 21.0285,
    longitude: 105.8542,
    accuracy_meters: 8.5,
    address_hint: "Hà Nội",
    note: "Ca hành chính",
    device_claimed_at: "2026-10-23T01:20:12.000Z",
    time_source: "SERVER_ANCHORED",
    time_anchor_issued_at: "2026-10-23T01:15:00.000Z",
    elapsed_since_anchor_ms: 312_000,
    time_token_digest: TOKEN_DIGEST_1,
    photo_storage_key: `preview/attendance-checkins/${ACTIVE_ACTOR_A.app}/e1000000-0000-4000-8000-000000000001.jpg`,
    photo_sha256: PHOTO_SHA_1,
    photo_size_bytes: 4096,
    photo_mime_type: ATTENDANCE_PHOTO_MIME_TYPE,
    received_at: "2026-10-23T12:00:00.000Z",
    ...overrides,
  };

  const request_fingerprint =
    overrides.request_fingerprint ??
    computeAttendanceRequestFingerprint({
      app_user_id: base.app_user_id,
      latitude: base.latitude,
      longitude: base.longitude,
      accuracy_meters: base.accuracy_meters,
      address_hint: base.address_hint.trim(),
      note: base.note.trim(),
      device_claimed_at_ms: Date.parse(base.device_claimed_at),
      time_source: base.time_source,
      time_token_digest: base.time_token_digest,
      elapsed_since_anchor_ms: base.elapsed_since_anchor_ms,
      photo_sha256: base.photo_sha256,
      photo_size_bytes: base.photo_size_bytes,
      photo_mime_type: base.photo_mime_type,
    });

  return { ...base, request_fingerprint };
}

test("migration checksum is LF-stable and transactional rollback leaves zero residue on failure", async () => {
  const { db, targetMigration: target } = await createDatabase({ stopBeforeAttendance: true });
  try {
    const lfDigest = migrationChecksum(target.sql.replace(/\r\n/g, "\n"));
    const crlfDigest = migrationChecksum(target.sql.replace(/\r?\n/g, "\r\n"));
    assert.equal(lfDigest, crlfDigest);
    assert.match(lfDigest, /^[0-9a-f]{64}$/);

    const bodySql = migrationSqlForTransaction(target.sql, target.name);
    await assert.rejects(
      db.exec(`begin;\n${bodySql}\nraise exception 'forced_rollback';\ncommit;`),
    );
    await db.exec("rollback;");

    assert.equal(ATTENDANCE_WP1_RPC_SIGNATURES.length, 2);
    const { rows } = await db.query(
      "select to_regclass('public.attendance_checkins') as tbl," +
        " to_regprocedure($1) as lookup_rpc," +
        " to_regprocedure($2) as record_rpc",
      [ATTENDANCE_WP1_RPC_SIGNATURES[0], ATTENDANCE_WP1_RPC_SIGNATURES[1]],
    );
    assert.equal(rows[0].tbl, null);
    assert.equal(rows[0].lookup_rpc, null);
    assert.equal(rows[0].record_rpc, null);
  } finally {
    await db.close();
  }
});

test("database ACLs deny direct table access to PUBLIC, anon, authenticated, and service_role; only service_role executes RPCs", async () => {
  const { db } = await createDatabase();
  try {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      const { rows } = await db.query(
        "select has_table_privilege($1, 'public.attendance_checkins'::regclass," +
          " 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as table_priv",
        [role],
      );
      assert.equal(
        rows[0].table_priv,
        false,
        `${role} must have zero direct privileges on public.attendance_checkins`,
      );
    }

    for (const rpcSig of ATTENDANCE_WP1_RPC_SIGNATURES) {
      for (const deniedRole of ["public", "anon", "authenticated"]) {
        const { rows } = await db.query(
          "select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as exec_priv",
          [deniedRole, rpcSig],
        );
        assert.equal(rows[0].exec_priv, false, `${deniedRole} must not execute ${rpcSig}`);
      }

      const { rows: serviceExec } = await db.query(
        "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as exec_priv",
        [rpcSig],
      );
      assert.equal(serviceExec[0].exec_priv, true, `service_role must execute ${rpcSig}`);
    }

    // Runtime role verification: service_role cannot SELECT directly from attendance_checkins
    await db.exec("begin; set local role service_role;");
    await assert.rejects(
      db.query("select count(*) from public.attendance_checkins"),
      (err) => err.code === "42501",
    );
    await db.exec("rollback;");

    // Runtime role verification: authenticated cannot call either Attendance WP1 RPC
    await db.exec("begin; set local role authenticated;");
    await assert.rejects(
      db.query("select public.attendance_lookup_checkin_idempotency(null,null,null,null)"),
      (err) => err.code === "42501",
    );
    await db.exec("rollback;");

    await db.exec("begin; set local role authenticated;");
    await assert.rejects(
      db.query(
        "select public.attendance_record_checkin(null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null)",
      ),
      (err) => err.code === "42501",
    );
    await db.exec("rollback;");
  } finally {
    await db.close();
  }
});

test("SERVER_ANCHORED, DEVICE_CLOCK_UNVERIFIED, Asia/Ho_Chi_Minh business_date boundary, immutability trigger, and idempotency work end-to-end", async () => {
  const { db } = await createDatabase();
  try {
    await seedActors(db);

    // 1. Disabled and mismatched actors are rejected with SQLSTATE 42501
    await assert.rejects(
      callCheckInAsServiceRole(
        db,
        buildRpcArgs({
          auth_subject: DISABLED_ACTOR.auth,
          app_user_id: DISABLED_ACTOR.app,
        }),
      ),
      (err) => err.code === "42501",
    );

    await assert.rejects(
      callCheckInAsServiceRole(
        db,
        buildRpcArgs({
          auth_subject: ACTIVE_ACTOR_A.auth,
          app_user_id: ACTIVE_ACTOR_B.app,
        }),
      ),
      (err) => err.code === "42501",
    );

    // 2. SERVER_ANCHORED check-in just after midnight in Asia/Ho_Chi_Minh:
    //    2026-10-22T17:05:00.000Z == 2026-10-23T00:05:00.000+07:00 => business_date MUST be 2026-10-23!
    const hcmAfterMidnightArgs = buildRpcArgs({
      idempotency_key: "e1000000-0000-4000-8000-000000000010",
      time_anchor_issued_at: "2026-10-22T17:00:00.000Z",
      elapsed_since_anchor_ms: 300_000, // +5m => 2026-10-22T17:05:00.000Z
      device_claimed_at: "2026-10-22T17:05:02.000Z", // +2s skew (within 5s)
      photo_storage_key: `preview/attendance-checkins/${ACTIVE_ACTOR_A.app}/e1000000-0000-4000-8000-000000000010.jpg`,
    });
    const first = await callCheckInAsServiceRole(db, hcmAfterMidnightArgs);
    assert.equal(first.business_date, "2026-10-23");
    assert.equal(first.sequence_in_day, 1);
    assert.equal(first.daily_count, 1);
    assert.equal(first.captured_at, "2026-10-22T17:05:00.000Z");
    assert.equal(first.time_source, "SERVER_ANCHORED");
    assert.equal(first.replayed, false);

    // Verify stored evidence columns (both device_claimed_at and server-computed captured_at preserved)
    const { rows: storedAnchored } = await db.query(
      "select time_verified, device_claimed_at, captured_at, time_anchor_issued_at, time_token_digest, sync_delay_seconds" +
        " from public.attendance_checkins where checkin_id = $1",
      [first.checkin_id],
    );
    assert.equal(storedAnchored[0].time_verified, true);
    assert.equal(
      new Date(storedAnchored[0].device_claimed_at).toISOString(),
      "2026-10-22T17:05:02.000Z",
    );
    assert.equal(
      new Date(storedAnchored[0].captured_at).toISOString(),
      "2026-10-22T17:05:00.000Z",
    );
    assert.equal(storedAnchored[0].time_token_digest, TOKEN_DIGEST_1);
    assert.ok(storedAnchored[0].sync_delay_seconds >= 0);

    // 3. Second check-in on the same HCM business_date via DEVICE_CLOCK_UNVERIFIED gets sequence_in_day = 2
    const unverifiedArgs = buildRpcArgs({
      idempotency_key: "e1000000-0000-4000-8000-000000000011",
      time_source: "DEVICE_CLOCK_UNVERIFIED",
      time_anchor_issued_at: null,
      elapsed_since_anchor_ms: null,
      time_token_digest: null,
      device_claimed_at: "2026-10-23T10:30:00.000Z", // 17:30+07:00 on 2026-10-23
      photo_sha256: PHOTO_SHA_2,
      photo_storage_key: `preview/attendance-checkins/${ACTIVE_ACTOR_A.app}/e1000000-0000-4000-8000-000000000011.jpg`,
    });
    const second = await callCheckInAsServiceRole(db, unverifiedArgs);
    assert.equal(second.business_date, "2026-10-23");
    assert.equal(second.sequence_in_day, 2);
    assert.equal(second.daily_count, 2);
    assert.equal(second.time_source, "DEVICE_CLOCK_UNVERIFIED");
    assert.equal(second.replayed, false);

    const { rows: storedUnverified } = await db.query(
      "select time_verified, time_anchor_issued_at, elapsed_since_anchor_ms, time_token_digest" +
        " from public.attendance_checkins where checkin_id = $1",
      [second.checkin_id],
    );
    assert.equal(storedUnverified[0].time_verified, false);
    assert.equal(storedUnverified[0].time_anchor_issued_at, null);
    assert.equal(storedUnverified[0].elapsed_since_anchor_ms, null);
    assert.equal(storedUnverified[0].time_token_digest, null);

    // 4. Idempotent replay of the first check-in returns the same checkin_id, sequence_in_day = 1,
    //    updated daily_count = 2, replayed = true, without creating a third row!
    const replayedFirst = await callCheckInAsServiceRole(db, hcmAfterMidnightArgs);
    assert.equal(replayedFirst.checkin_id, first.checkin_id);
    assert.equal(replayedFirst.sequence_in_day, 1);
    assert.equal(replayedFirst.daily_count, 2);
    assert.equal(replayedFirst.replayed, true);

    const { rows: rowCountAfterReplay } = await db.query(
      "select count(*)::int as cnt from public.attendance_checkins where app_user_id = $1",
      [ACTIVE_ACTOR_A.app],
    );
    assert.equal(rowCountAfterReplay[0].cnt, 2);

    // 5. Reusing idempotency_key with a different request_fingerprint fails with PT409 IDEMPOTENCY_CONFLICT
    await assert.rejects(
      callCheckInAsServiceRole(db, {
        ...hcmAfterMidnightArgs,
        request_fingerprint: "9".repeat(64),
      }),
      (err) => err.code === "PT409" && err.message.includes("IDEMPOTENCY_CONFLICT"),
    );

    // 6. Client skew > 5 seconds in SQL RPC is also blocked fail-closed
    await assert.rejects(
      callCheckInAsServiceRole(
        db,
        buildRpcArgs({
          idempotency_key: "e1000000-0000-4000-8000-000000000012",
          time_anchor_issued_at: "2026-10-23T01:00:00.000Z",
          elapsed_since_anchor_ms: 60_000, // 01:01:00Z
          device_claimed_at: "2026-10-23T01:01:06.000Z", // +6s skew
        }),
      ),
      (err) => err.code === "22023" && err.message.includes("ATTENDANCE_TIME_MISMATCH"),
    );

    // 7. Offline sync grace in SQL RPC:
    //    - Token > 24h old, elapsed = 24h exact, received_at at exact 7-day boundary (604,800,000 ms): ACCEPTED
    const anchorBoundaryMs = Date.parse("2026-10-10T01:00:00.000Z");
    const exactMaxCapturedMs = anchorBoundaryMs + ATTENDANCE_TIME_TOKEN_TTL_MS; // 2026-10-11T01:00:00.000Z
    const exact7dReceivedMs = exactMaxCapturedMs + ATTENDANCE_MAX_SYNC_WINDOW_MS; // 2026-10-18T01:00:00.000Z
    const exact7dRow = await callCheckInAsServiceRole(
      db,
      buildRpcArgs({
        idempotency_key: "e1000000-0000-4000-8000-000000000020",
        time_anchor_issued_at: new Date(anchorBoundaryMs).toISOString(),
        elapsed_since_anchor_ms: ATTENDANCE_TIME_TOKEN_TTL_MS,
        device_claimed_at: new Date(exactMaxCapturedMs).toISOString(),
        received_at: new Date(exact7dReceivedMs).toISOString(),
        photo_storage_key: `preview/attendance-checkins/${ACTIVE_ACTOR_A.app}/e1000000-0000-4000-8000-000000000020.jpg`,
      }),
    );
    assert.equal(exact7dRow.captured_at, "2026-10-11T01:00:00.000Z");
    assert.equal(exact7dRow.received_at, "2026-10-18T01:00:00.000Z");
    assert.equal(exact7dRow.business_date, "2026-10-11");
    assert.equal(exact7dRow.replayed, false);

    //    - 1 millisecond past 7-day sync window for a NEW key:
    //      lookup returns { found: false } and record RPC rejects with 22023 ATTENDANCE_SYNC_WINDOW_EXPIRED
    const staleNewKeyArgs = buildRpcArgs({
      idempotency_key: "e1000000-0000-4000-8000-000000000021",
      time_anchor_issued_at: new Date(anchorBoundaryMs).toISOString(),
      elapsed_since_anchor_ms: ATTENDANCE_TIME_TOKEN_TTL_MS,
      device_claimed_at: new Date(exactMaxCapturedMs).toISOString(),
      received_at: new Date(exact7dReceivedMs + 1).toISOString(),
      photo_storage_key: `preview/attendance-checkins/${ACTIVE_ACTOR_A.app}/e1000000-0000-4000-8000-000000000021.jpg`,
    });
    assert.deepEqual(
      await callLookupAsServiceRole(db, staleNewKeyArgs),
      { found: false },
    );
    await assert.rejects(
      callCheckInAsServiceRole(db, staleNewKeyArgs),
      (err) => err.code === "22023" && err.message.includes("ATTENDANCE_SYNC_WINDOW_EXPIRED"),
    );

    //    - Post-168h idempotency replay & conflict on ALREADY-SAVED SERVER_ANCHORED row:
    //      (a) Disabled/mismatched actor rejected on attendance_lookup_checkin_idempotency
    await assert.rejects(
      callLookupAsServiceRole(db, {
        auth_subject: DISABLED_ACTOR.auth,
        app_user_id: DISABLED_ACTOR.app,
        idempotency_key: "e1000000-0000-4000-8000-000000000020",
        request_fingerprint: PHOTO_SHA_1,
      }),
      (err) => err.code === "42501",
    );
    await assert.rejects(
      callLookupAsServiceRole(db, {
        auth_subject: ACTIVE_ACTOR_A.auth,
        app_user_id: ACTIVE_ACTOR_B.app,
        idempotency_key: "e1000000-0000-4000-8000-000000000020",
        request_fingerprint: PHOTO_SHA_1,
      }),
      (err) => err.code === "42501",
    );

    //      (b) Retry 14 days (336 hours) after captured_at with matching fingerprint replays exact row
    //          in BOTH attendance_lookup_checkin_idempotency and attendance_record_checkin!
    const exact7dSavedArgs = buildRpcArgs({
      idempotency_key: "e1000000-0000-4000-8000-000000000020",
      time_anchor_issued_at: new Date(anchorBoundaryMs).toISOString(),
      elapsed_since_anchor_ms: ATTENDANCE_TIME_TOKEN_TTL_MS,
      device_claimed_at: new Date(exactMaxCapturedMs).toISOString(),
      received_at: new Date(exactMaxCapturedMs + 14 * 86_400_000).toISOString(),
      photo_storage_key: `preview/attendance-checkins/${ACTIVE_ACTOR_A.app}/e1000000-0000-4000-8000-000000000020.jpg`,
    });
    const post7dLookup = await callLookupAsServiceRole(db, exact7dSavedArgs);
    assert.deepEqual(post7dLookup, {
      found: true,
      photo_storage_key: exact7dSavedArgs.photo_storage_key,
      checkin: {
        ...exact7dRow,
        replayed: true,
      },
    });
    const post7dRecordReplay = await callCheckInAsServiceRole(db, exact7dSavedArgs);
    assert.deepEqual(post7dRecordReplay, {
      ...exact7dRow,
      replayed: true,
    });

    //      (c) Retry > 7 days later with same key + different fingerprint fails with PT409 IDEMPOTENCY_CONFLICT
    await assert.rejects(
      callLookupAsServiceRole(db, {
        ...exact7dSavedArgs,
        request_fingerprint: "8".repeat(64),
      }),
      (err) => err.code === "PT409" && err.message.includes("IDEMPOTENCY_CONFLICT"),
    );
    await assert.rejects(
      callCheckInAsServiceRole(db, {
        ...exact7dSavedArgs,
        request_fingerprint: "8".repeat(64),
      }),
      (err) => err.code === "PT409" && err.message.includes("IDEMPOTENCY_CONFLICT"),
    );

    //    - elapsed_since_anchor_ms > 24h (86,400,001 ms) rejected even when received_at - captured_at <= 7d
    await assert.rejects(
      callCheckInAsServiceRole(
        db,
        buildRpcArgs({
          idempotency_key: "e1000000-0000-4000-8000-000000000022",
          time_anchor_issued_at: new Date(anchorBoundaryMs).toISOString(),
          elapsed_since_anchor_ms: ATTENDANCE_TIME_TOKEN_TTL_MS + 1,
          device_claimed_at: new Date(exactMaxCapturedMs + 1).toISOString(),
          received_at: new Date(exactMaxCapturedMs + 3_600_000).toISOString(),
          photo_storage_key: `preview/attendance-checkins/${ACTIVE_ACTOR_A.app}/e1000000-0000-4000-8000-000000000022.jpg`,
        }),
      ),
      (err) => err.code === "22023" && err.message.includes("ATTENDANCE_TIME_ELAPSED_INVALID"),
    );

    //    - Default received_at = null uses live pg_catalog.clock_timestamp() cleanly for 36h-delayed sync
    const { rows: liveClockRows } = await db.query(
      "select pg_catalog.clock_timestamp() as now_ts",
    );
    const liveNowMs = new Date(liveClockRows[0].now_ts).getTime();
    const liveAnchorMs = liveNowMs - 36 * 3_600_000;
    const liveElapsedMs = 3_600_000;
    const liveCapturedMs = liveAnchorMs + liveElapsedMs;
    const liveRow = await callCheckInAsServiceRole(
      db,
      buildRpcArgs({
        app_user_id: ACTIVE_ACTOR_B.app,
        auth_subject: ACTIVE_ACTOR_B.auth,
        idempotency_key: "e1000000-0000-4000-8000-000000000023",
        time_anchor_issued_at: new Date(liveAnchorMs).toISOString(),
        elapsed_since_anchor_ms: liveElapsedMs,
        device_claimed_at: new Date(liveCapturedMs).toISOString(),
        received_at: null,
        photo_storage_key: `preview/attendance-checkins/${ACTIVE_ACTOR_B.app}/e1000000-0000-4000-8000-000000000023.jpg`,
      }),
    );
    assert.equal(liveRow.captured_at, new Date(liveCapturedMs).toISOString());
    assert.equal(liveRow.replayed, false);

    // 8. Append-only immutability trigger blocks UPDATE and DELETE even from table owner / superuser!
    await assert.rejects(
      db.query("update public.attendance_checkins set note = 'tampered' where checkin_id = $1", [
        first.checkin_id,
      ]),
      (err) => err.code === "55000" && err.message.includes("ATTENDANCE_CHECKINS_IMMUTABLE"),
    );

    await assert.rejects(
      db.query("delete from public.attendance_checkins where checkin_id = $1", [
        first.checkin_id,
      ]),
      (err) => err.code === "55000" && err.message.includes("ATTENDANCE_CHECKINS_IMMUTABLE"),
    );
  } finally {
    await db.close();
  }
});
