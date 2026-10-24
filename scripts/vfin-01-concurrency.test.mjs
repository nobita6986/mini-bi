/**
 * VFIN-01 (Work Package 2) — Real PostgreSQL Concurrency Regression Suite.
 *
 * Proves against an isolated local PostgreSQL cluster (`initdb` + `pg_ctl`, zero remote DB):
 *   1. Deterministic lock-hold race + 4-connection parallel burst on the same Vendor
 *      (`vendor_finance_record_entry`): gapless `vendor_sequence` `1..N`, strict running
 *      balance chain (`balance_before_minor + balance_delta_minor === balance_after_minor`),
 *      final balance === `SUM(balance_delta_minor)`, and globally unique `document_no`.
 *   2. Concurrent reversal race (`vendor_finance_reverse_entry`): deterministic lock-hold
 *      race + 4-connection parallel burst produce strictly 1 reversal winner and `23505`
 *      (`VENDOR_FINANCE_ENTRY_ALREADY_REVERSED`) on every contender.
 *   3. Concurrent opening balance batch race (`vendor_finance_apply_opening_batch`):
 *      - Overlapping Vendor across concurrent batches -> strictly 1 winner, 1 `23505`
 *        (`VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED`).
 *      - Multi-Vendor batches submitted in opposite order (`[VND_LOCK_Y, VND_LOCK_X]` vs
 *        `[VND_LOCK_X, VND_LOCK_Y]`) -> zero deadlocks (`40P01`) thanks to deterministic
 *        `vendor_id ASC` lock acquisition.
 *   4. Concurrent idempotent retry: 2 concurrent transactions with identical
 *      `(actor, idempotency_key, request_fingerprint)` serialize cleanly, write strictly
 *      1 ledger entry + 1 audit event, and replay the identical `entry_id` & `document_no`
 *      (`replayed: true`).
 *   5. Concurrent evidence attachment guard: at most 1 `READY` attachment per target.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import { computeAssignAccountingMemberFingerprint } from "../src/lib/departments/department-contract.ts";
import {
  computeApplyOpeningBatchFingerprint,
  computeRecordEntryFingerprint,
  computeReserveEvidenceFingerprint,
  computeReverseEntryFingerprint,
} from "../src/lib/vendor-finance/vendor-finance-contract.ts";
import { VFIN_01_BACKEND_MIGRATION_NAME } from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const ADMIN_1 = {
  auth: "19200000-0000-4000-8000-000000000001",
  app: "29200000-0000-4000-8000-000000000001",
  name: "Full Admin VFIN Race",
};
const ACCT_1 = {
  auth: "19200000-0000-4000-8000-000000000011",
  app: "29200000-0000-4000-8000-000000000011",
  name: "Kế Toán Công Nợ Một",
};
const ACCT_2 = {
  auth: "19200000-0000-4000-8000-000000000012",
  app: "29200000-0000-4000-8000-000000000012",
  name: "Kế Toán Công Nợ Hai",
};

let uuidSeq = 0;
function nextUuid() {
  uuidSeq += 1;
  return `89000000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
}

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

async function connect(port, database = "postgres", applicationName = "vfin-01-race") {
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
  assert.fail(`session ${applicationName} did not block on PostgreSQL lock`);
}

async function applyMigrations(client) {
  await client.query(
    "create role anon; create role authenticated; create role service_role;" +
      " create schema auth; create table auth.users (id uuid primary key, email text);",
  );
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const targetIndex = names.indexOf(VFIN_01_BACKEND_MIGRATION_NAME);
  assert.ok(
    targetIndex >= 0,
    `migration inventory must include ${VFIN_01_BACKEND_MIGRATION_NAME}`,
  );
  for (const name of names.slice(0, targetIndex + 1)) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

async function seedFixture(client) {
  await client.query(
    `insert into public.teams (team_id, code, display_name, active)
     values ('99200000-0000-4000-8000-00000000000f'::uuid, '__system_vendor__', 'Vendor System', true)
     on conflict (code) do nothing`,
  );

  for (const person of [ADMIN_1, ACCT_1, ACCT_2]) {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      person.auth,
      `${person.app}@vfin.local`,
    ]);
    await client.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1, $2, $3, true)",
      [person.app, person.auth, person.name],
    );
  }

  await client.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
     values ($1, 'entry_admin', '2026-01-01', true),
            ($1, 'recruiter_master_manage', '2026-01-01', true),
            ($1, 'team_master_manage', '2026-01-01', true),
            ($1, 'catalog_master_manage', '2026-01-01', true)`,
    [ADMIN_1.app],
  );
  await client.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
     values ($1, 'all', '2026-01-01', true)`,
    [ADMIN_1.app],
  );

  // Assign ACCT_1 and ACCT_2 into immutable `ACCOUNTING` department
  for (const acct of [ACCT_1, ACCT_2]) {
    const reason = `Assign ${acct.name}`;
    const fp = computeAssignAccountingMemberFingerprint({
      actor_app_user_id: ADMIN_1.app,
      account_ref: acct.app,
      expected_pair_version: 0,
      effective_from: null,
      reason,
    });
    await client.query(
      `select public.org_department_assign_accounting_member(
         $1::uuid, $2::uuid, $3::uuid, 0, null, $4::text, $5::uuid, $6::text
       )`,
      [ADMIN_1.auth, ADMIN_1.app, acct.app, reason, nextUuid(), fp],
    );
  }

  // Create canonical Vendors via canonical `direct_entry_create_vendor`
  for (const [vid, vname] of [
    ["VND_RACE_LEDGER", "NCC Đua Ghi Sổ Cái"],
    ["VND_RACE_OPEN_OVERLAP", "NCC Đua Số Dư Đầu Kỳ"],
    ["VND_LOCK_X", "NCC Thứ Tự Khóa X"],
    ["VND_LOCK_Y", "NCC Thứ Tự Khóa Y"],
    ["VND_IDEM", "NCC Idempotency Đồng Thời"],
  ]) {
    await client.query(
      `select public.direct_entry_create_vendor(
         $1::uuid, $2::uuid, 0, $3::text, $4::text, '2026-01-01'::date, 'Seed vendor', $5::text
       )`,
      [ADMIN_1.auth, ADMIN_1.app, vid, vname, nextUuid()],
    );
  }
}

const RECORD_SQL =
  "select public.vendor_finance_record_entry($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::date, $7::text, $8::uuid, $9::text) as data";
const REVERSE_SQL =
  "select public.vendor_finance_reverse_entry($1::uuid, $2::uuid, $3::uuid, $4::date, $5::text, $6::uuid, $7::text) as data";
const APPLY_OPENING_SQL =
  "select public.vendor_finance_apply_opening_batch($1::uuid, $2::uuid, $3::date, $4::jsonb, $5::text, $6::uuid, $7::text) as data";
const RESERVE_EVIDENCE_SQL =
  "select public.vendor_finance_reserve_evidence($1::uuid, $2::uuid, $3::text, $4::uuid, $5::text, $6::int, $7::text, $8::int, $9::uuid, $10::text) as data";
const COMPLETE_EVIDENCE_SQL =
  "select public.vendor_finance_complete_evidence($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text) as data";

test("VFIN-01 real PostgreSQL concurrency: per-vendor ledger serialization, reversal-once race, deadlock-free multi-vendor opening batches, idempotent retry, and READY evidence uniqueness", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL initdb and pg_ctl are required for real concurrency regression");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vfin-01-race-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  const databaseName = `vfin_01_race_${process.pid}`;
  let serverStarted = false;
  let adminClient;
  let setup;
  let observer;
  let worker1;
  let worker2;
  const burstClients = [];

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

    adminClient = await connect(port);
    await adminClient.query(`create database ${databaseName}`);

    setup = await connect(port, databaseName, "vfin-setup");
    await applyMigrations(setup);
    await seedFixture(setup);
    await setup.end();
    setup = undefined;

    observer = await connect(port, databaseName, "vfin-observer");
    worker1 = await connect(port, databaseName, "vfin-worker-1");
    worker2 = await connect(port, databaseName, "vfin-worker-2");
    for (let i = 0; i < 4; i += 1) {
      const c = await connect(port, databaseName, `vfin-burst-${i}`);
      await c.query("set role service_role");
      burstClients.push(c);
    }

    // =========================================================================
    // Stage 1: Deterministic Lock-Hold Race + 4-Connection Parallel Burst on
    //          Same Vendor (`VND_RACE_LEDGER`)
    // =========================================================================
    const r1Reason = "Ghi nhận phí dịch vụ đợt 1";
    const r1Fp = computeRecordEntryFingerprint({
      vendor_id: "VND_RACE_LEDGER",
      entry_type: "DEBT_RECORDED",
      amount_minor: "25000000",
      effective_date: "2026-10-10",
      reason: r1Reason,
    });
    const r2Reason = "Thanh toán đợt 1 đang chờ lock";
    const r2Fp = computeRecordEntryFingerprint({
      vendor_id: "VND_RACE_LEDGER",
      entry_type: "PAYMENT_RECORDED",
      amount_minor: "5000000",
      effective_date: "2026-10-10",
      reason: r2Reason,
    });

    await worker1.query("begin");
    await worker1.query("set local role service_role");
    const w1EntryRes = await worker1.query(RECORD_SQL, [
      ACCT_1.auth,
      ACCT_1.app,
      "VND_RACE_LEDGER",
      "DEBT_RECORDED",
      "25000000",
      "2026-10-10",
      r1Reason,
      nextUuid(),
      r1Fp,
    ]);
    const entry1 = w1EntryRes.rows[0].data.entry;
    assert.equal(entry1.vendor_sequence, 1);
    assert.equal(entry1.balance_after_minor, "25000000");

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const w2Pending = worker2.query(RECORD_SQL, [
      ACCT_2.auth,
      ACCT_2.app,
      "VND_RACE_LEDGER",
      "PAYMENT_RECORDED",
      "5000000",
      "2026-10-10",
      r2Reason,
      nextUuid(),
      r2Fp,
    ]);

    await waitUntilBlocked(observer, "vfin-worker-2");
    await worker1.query("commit");

    const w2EntryRes = await w2Pending;
    await worker2.query("commit");
    const entry2 = w2EntryRes.rows[0].data.entry;
    assert.equal(entry2.vendor_sequence, 2);
    assert.equal(entry2.balance_before_minor, "25000000");
    assert.equal(entry2.balance_delta_minor, "-5000000");
    assert.equal(entry2.balance_after_minor, "20000000");

    // 4-connection parallel burst on `VND_RACE_LEDGER`
    const burstSpecs = [
      { actor: ACCT_1, type: "PAYROLL_RECORDED", amount: "40000000", reason: "Burst lương" },
      { actor: ACCT_2, type: "ADVANCE_RECORDED", amount: "10000000", reason: "Burst tạm ứng" },
      { actor: ACCT_1, type: "ADJUSTMENT_INCREASE", amount: "3000000", reason: "Burst tăng" },
      { actor: ACCT_2, type: "ADJUSTMENT_DECREASE", amount: "8000000", reason: "Burst giảm" },
    ];
    const burstLedgerResults = await Promise.all(
      burstSpecs.map((spec, idx) => {
        const fp = computeRecordEntryFingerprint({
          vendor_id: "VND_RACE_LEDGER",
          entry_type: spec.type,
          amount_minor: spec.amount,
          effective_date: "2026-10-11",
          reason: spec.reason,
        });
        return burstClients[idx].query(RECORD_SQL, [
          spec.actor.auth,
          spec.actor.app,
          "VND_RACE_LEDGER",
          spec.type,
          spec.amount,
          "2026-10-11",
          spec.reason,
          nextUuid(),
          fp,
        ]);
      }),
    );
    assert.equal(burstLedgerResults.length, 4);

    const { rows: ledgerChain } = await observer.query(
      `select vendor_sequence::int as seq,
              balance_before_minor::text as before_m,
              balance_delta_minor::text as delta_m,
              balance_after_minor::text as after_m,
              document_no
         from public.vendor_finance_entries
        where vendor_id = 'VND_RACE_LEDGER'
        order by vendor_sequence asc`,
    );
    assert.equal(ledgerChain.length, 6);
    assert.deepEqual(
      ledgerChain.map((r) => r.seq),
      [1, 2, 3, 4, 5, 6],
      "vendor_sequence must be gapless 1..6 under concurrency",
    );
    let expectedRunning = 0n;
    const seenDocNos = new Set();
    for (const r of ledgerChain) {
      assert.equal(BigInt(r.before_m), expectedRunning);
      expectedRunning += BigInt(r.delta_m);
      assert.equal(BigInt(r.after_m), expectedRunning);
      seenDocNos.add(r.document_no);
    }
    assert.equal(expectedRunning, 45000000n, "25M - 5M + 40M - 10M + 3M - 8M === 45M");
    assert.equal(seenDocNos.size, 6, "every concurrent entry must receive a unique document_no");

    // =========================================================================
    // Stage 2: Concurrent Reversal Race (Lock-Hold + 4-Way Parallel Burst)
    // =========================================================================
    const rev1ReasonA = "Kế toán 1 hoàn tác bút toán #1";
    const rev1FpA = computeReverseEntryFingerprint({
      entry_id: entry1.entry_id,
      effective_date: "2026-10-12",
      reason: rev1ReasonA,
    });
    const rev1ReasonB = "Kế toán 2 hoàn tác cùng bút toán #1";
    const rev1FpB = computeReverseEntryFingerprint({
      entry_id: entry1.entry_id,
      effective_date: "2026-10-12",
      reason: rev1ReasonB,
    });

    await worker1.query("begin");
    await worker1.query("set local role service_role");
    const winRev1 = await worker1.query(REVERSE_SQL, [
      ACCT_1.auth,
      ACCT_1.app,
      entry1.entry_id,
      "2026-10-12",
      rev1ReasonA,
      nextUuid(),
      rev1FpA,
    ]);
    assert.equal(winRev1.rows[0].data.reversal_entry.vendor_sequence, 7);
    assert.equal(winRev1.rows[0].data.reversal_entry.balance_delta_minor, "-25000000");

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const loseRev1Pending = worker2.query(REVERSE_SQL, [
      ACCT_2.auth,
      ACCT_2.app,
      entry1.entry_id,
      "2026-10-12",
      rev1ReasonB,
      nextUuid(),
      rev1FpB,
    ]);

    await waitUntilBlocked(observer, "vfin-worker-2");
    await worker1.query("commit");

    await assert.rejects(
      loseRev1Pending,
      (err) =>
        err.code === "23505" &&
        err.message.includes("VENDOR_FINANCE_ENTRY_ALREADY_REVERSED"),
      "second concurrent reversal must fail closed with 23505 VENDOR_FINANCE_ENTRY_ALREADY_REVERSED",
    );
    await worker2.query("rollback");

    // 4-connection parallel burst reversing `entry2`
    const burstReversals = await Promise.allSettled(
      burstClients.map((client, idx) => {
        const actor = idx % 2 === 0 ? ACCT_1 : ACCT_2;
        const reason = `Burst reverse #${idx}`;
        const fp = computeReverseEntryFingerprint({
          entry_id: entry2.entry_id,
          effective_date: "2026-10-12",
          reason,
        });
        return client.query(REVERSE_SQL, [
          actor.auth,
          actor.app,
          entry2.entry_id,
          "2026-10-12",
          reason,
          nextUuid(),
          fp,
        ]);
      }),
    );
    const revFulfilled = burstReversals.filter((o) => o.status === "fulfilled");
    const revRejected = burstReversals.filter((o) => o.status === "rejected");
    assert.equal(revFulfilled.length, 1, "strictly 1 parallel reversal must win");
    assert.equal(revRejected.length, 3, "other 3 parallel reversals must fail");
    for (const r of revRejected) {
      assert.equal(r.reason.code, "23505");
      assert.match(r.reason.message, /VENDOR_FINANCE_ENTRY_ALREADY_REVERSED/);
    }

    // =========================================================================
    // Stage 3: Concurrent Opening Batch Overlap & Opposite-Order Lock Ordering
    // =========================================================================
    // 3a: Overlapping Vendor (`VND_RACE_OPEN_OVERLAP`) across 2 concurrent batches
    const overlapItems1 = [
      { vendor_id: "VND_RACE_OPEN_OVERLAP", entry_type: "OPENING_PAYABLE", amount_minor: "15000000" },
    ];
    const overlapItems2 = [
      { vendor_id: "VND_RACE_OPEN_OVERLAP", entry_type: "OPENING_ADVANCE", amount_minor: "9000000" },
    ];
    const overlapOutcomes = await Promise.allSettled([
      burstClients[0].query(APPLY_OPENING_SQL, [
        ACCT_1.auth,
        ACCT_1.app,
        "2026-10-01",
        JSON.stringify(overlapItems1),
        "Opening race A",
        nextUuid(),
        computeApplyOpeningBatchFingerprint({
          cutoff_date: "2026-10-01",
          items: overlapItems1,
          reason: "Opening race A",
        }),
      ]),
      burstClients[1].query(APPLY_OPENING_SQL, [
        ACCT_2.auth,
        ACCT_2.app,
        "2026-10-01",
        JSON.stringify(overlapItems2),
        "Opening race B",
        nextUuid(),
        computeApplyOpeningBatchFingerprint({
          cutoff_date: "2026-10-01",
          items: overlapItems2,
          reason: "Opening race B",
        }),
      ]),
    ]);
    assert.equal(overlapOutcomes.filter((o) => o.status === "fulfilled").length, 1);
    const overlapLosers = overlapOutcomes.filter((o) => o.status === "rejected");
    assert.equal(overlapLosers.length, 1);
    assert.equal(overlapLosers[0].reason.code, "23505");
    assert.match(overlapLosers[0].reason.message, /VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED/);

    // 3b: Multi-Vendor batches submitted in OPPOSITE order (`[VND_LOCK_Y, VND_LOCK_X]`
    //     vs `[VND_LOCK_X, VND_LOCK_Y]`) must NEVER deadlock (`40P01`)!
    const itemsYX = [
      { vendor_id: "VND_LOCK_Y", entry_type: "OPENING_PAYABLE", amount_minor: "10000000" },
      { vendor_id: "VND_LOCK_X", entry_type: "OPENING_PAYABLE", amount_minor: "20000000" },
    ];
    const itemsXY = [
      { vendor_id: "VND_LOCK_X", entry_type: "OPENING_ADVANCE", amount_minor: "5000000" },
      { vendor_id: "VND_LOCK_Y", entry_type: "OPENING_ADVANCE", amount_minor: "7000000" },
    ];
    const lockOrderOutcomes = await Promise.allSettled([
      burstClients[0].query(APPLY_OPENING_SQL, [
        ACCT_1.auth,
        ACCT_1.app,
        "2026-10-01",
        JSON.stringify(itemsYX),
        "Opposite order Y->X",
        nextUuid(),
        computeApplyOpeningBatchFingerprint({
          cutoff_date: "2026-10-01",
          items: itemsYX,
          reason: "Opposite order Y->X",
        }),
      ]),
      burstClients[1].query(APPLY_OPENING_SQL, [
        ACCT_2.auth,
        ACCT_2.app,
        "2026-10-01",
        JSON.stringify(itemsXY),
        "Opposite order X->Y",
        nextUuid(),
        computeApplyOpeningBatchFingerprint({
          cutoff_date: "2026-10-01",
          items: itemsXY,
          reason: "Opposite order X->Y",
        }),
      ]),
    ]);
    for (const o of lockOrderOutcomes) {
      if (o.status === "rejected") {
        assert.notEqual(o.reason.code, "40P01", "must never deadlock (40P01) on opposite-order batches");
        assert.equal(o.reason.code, "23505");
        assert.match(o.reason.message, /VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED/);
      }
    }
    assert.equal(lockOrderOutcomes.filter((o) => o.status === "fulfilled").length, 1);

    // =========================================================================
    // Stage 4: Concurrent Idempotent Retry (Same Actor + Key + Fingerprint)
    // =========================================================================
    const idemKey = nextUuid();
    const idemReason = "Ghi nhận công nợ idempotent đồng thời";
    const idemFp = computeRecordEntryFingerprint({
      vendor_id: "VND_IDEM",
      entry_type: "DEBT_RECORDED",
      amount_minor: "33000000",
      effective_date: "2026-10-15",
      reason: idemReason,
    });

    await worker1.query("begin");
    await worker1.query("set local role service_role");
    const firstIdem = await worker1.query(RECORD_SQL, [
      ACCT_1.auth,
      ACCT_1.app,
      "VND_IDEM",
      "DEBT_RECORDED",
      "33000000",
      "2026-10-15",
      idemReason,
      idemKey,
      idemFp,
    ]);
    assert.equal(firstIdem.rows[0].data.replayed, false);

    await worker2.query("begin");
    await worker2.query("set local role service_role");
    const secondIdemPending = worker2.query(RECORD_SQL, [
      ACCT_1.auth,
      ACCT_1.app,
      "VND_IDEM",
      "DEBT_RECORDED",
      "33000000",
      "2026-10-15",
      idemReason,
      idemKey,
      idemFp,
    ]);

    await waitUntilBlocked(observer, "vfin-worker-2");
    await worker1.query("commit");

    const secondIdem = await secondIdemPending;
    await worker2.query("commit");
    assert.equal(secondIdem.rows[0].data.replayed, true);
    assert.equal(secondIdem.rows[0].data.entry.entry_id, firstIdem.rows[0].data.entry.entry_id);
    assert.equal(
      secondIdem.rows[0].data.entry.document_no,
      firstIdem.rows[0].data.entry.document_no,
    );

    const { rows: idemCounts } = await observer.query(
      `select (select count(*)::int from public.vendor_finance_entries where vendor_id = 'VND_IDEM') as entry_n,
              (select count(*)::int from public.vendor_finance_audit_events where vendor_id = 'VND_IDEM') as audit_n`,
    );
    assert.deepEqual(idemCounts[0], { entry_n: 1, audit_n: 1 });

    // =========================================================================
    // Stage 5: Concurrent Evidence Finalize Uniqueness (<= 1 READY per Entry)
    // =========================================================================
    const targetEntryId = firstIdem.rows[0].data.entry.entry_id;
    const shaA = "a".repeat(64);
    const shaB = "b".repeat(64);
    const [resEvA, resEvB] = await Promise.all([
      burstClients[0].query(RESERVE_EVIDENCE_SQL, [
        ACCT_1.auth,
        ACCT_1.app,
        "ENTRY",
        targetEntryId,
        "image/jpeg",
        2048,
        shaA,
        300,
        nextUuid(),
        computeReserveEvidenceFingerprint({
          target_kind: "ENTRY",
          target_id: targetEntryId,
          mime_type: "image/jpeg",
          size_bytes: 2048,
          checksum_sha256: shaA,
        }),
      ]),
      burstClients[1].query(RESERVE_EVIDENCE_SQL, [
        ACCT_2.auth,
        ACCT_2.app,
        "ENTRY",
        targetEntryId,
        "image/png",
        2048,
        shaB,
        300,
        nextUuid(),
        computeReserveEvidenceFingerprint({
          target_kind: "ENTRY",
          target_id: targetEntryId,
          mime_type: "image/png",
          size_bytes: 2048,
          checksum_sha256: shaB,
        }),
      ]),
    ]);

    const finalizeOutcomes = await Promise.allSettled([
      burstClients[0].query(COMPLETE_EVIDENCE_SQL, [
        ACCT_1.auth,
        ACCT_1.app,
        resEvA.rows[0].data.reservation.evidence_id,
        "READY",
        null,
      ]),
      burstClients[1].query(COMPLETE_EVIDENCE_SQL, [
        ACCT_2.auth,
        ACCT_2.app,
        resEvB.rows[0].data.reservation.evidence_id,
        "READY",
        null,
      ]),
    ]);
    assert.equal(
      finalizeOutcomes.filter((o) => o.status === "fulfilled").length,
      1,
      "strictly 1 concurrent READY evidence completion may succeed per entry",
    );
    const finalizeRejected = finalizeOutcomes.filter((o) => o.status === "rejected");
    assert.equal(finalizeRejected.length, 1);
    assert.equal(finalizeRejected[0].reason.code, "40900");
    assert.match(
      finalizeRejected[0].reason.message,
      /VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED/,
    );

    // Once READY is committed, any further concurrent reservation rejects with 23505
    const shaC = "c".repeat(64);
    await assert.rejects(
      burstClients[2].query(RESERVE_EVIDENCE_SQL, [
        ACCT_1.auth,
        ACCT_1.app,
        "ENTRY",
        targetEntryId,
        "image/png",
        1024,
        shaC,
        300,
        nextUuid(),
        computeReserveEvidenceFingerprint({
          target_kind: "ENTRY",
          target_id: targetEntryId,
          mime_type: "image/png",
          size_bytes: 1024,
          checksum_sha256: shaC,
        }),
      ]),
      (err) =>
        err.code === "23505" &&
        err.message.includes("VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED"),
    );

    const { rows: readyEvCount } = await observer.query(
      "select count(*)::int as n from public.vendor_finance_evidence where entry_id = $1 and status = 'READY'",
      [targetEntryId],
    );
    assert.equal(readyEvCount[0].n, 1);
  } finally {
    await worker1?.query("rollback").catch(() => {});
    await worker2?.query("rollback").catch(() => {});
    for (const c of burstClients) {
      await c.end().catch(() => {});
    }
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
