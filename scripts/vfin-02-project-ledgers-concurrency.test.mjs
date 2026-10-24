/**
 * VFIN-02 — Real PostgreSQL Project-Scoped Sub-Ledger Concurrency Regression Suite.
 *
 * Proves against an isolated local PostgreSQL cluster (`initdb` + `pg_ctl`, zero remote DB):
 *   1. Deterministic lock-hold race + 4-connection parallel burst on the same
 *      `(VND_RACE_SHARED, PRJ_1, ACCT_1)` sub-ledger (mixing direct `ACCT_1` writes and
 *      `CASH_BEHALF` record-on-behalf writes): gapless per-sub-ledger `vendor_sequence` `1..N`,
 *      exact running balance chain, `responsible_accountant_user_id` preserved on `ACCT_1`,
 *      and globally unique `document_no`.
 *   2. Simultaneous parallel burst on the SAME Vendor across two distinct project sub-ledgers
 *      (`(VND_RACE_SHARED, PRJ_1, ACCT_1)` vs `(VND_RACE_SHARED, PRJ_2, ACCT_2)`): independent
 *      gapless `vendor_sequence` chains, zero cross-netting (`bù trừ`) of balances, and zero
 *      `40P01` deadlocks.
 *   3. Concurrent OCC project accountant assignment race (`vendor_finance_assign_project_accountant_admin`
 *      with `expected_version = 0` on `PRJ_RACE_ASSIGN` from 2 simultaneous Full Admin sessions):
 *      strictly 1 winner (`version = 1`) and 1 conflict (`40900`/`23505`), preserving
 *      `1 dự án = 1 kế toán phụ trách đang hiệu lực`.
 *   4. Concurrent project-scoped opening balance batches:
 *      - Overlapping Vendor on `PRJ_1` -> strictly 1 winner, 1 `23505`
 *        (`VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED`), while the SAME Vendor remains
 *        independently initializable on `PRJ_2`.
 *      - Multi-Vendor batches submitted in opposite order (`[VND_LOCK_Y, VND_LOCK_X]` vs
 *        `[VND_LOCK_X, VND_LOCK_Y]`) -> zero deadlocks (`40P01`).
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
  computeAssignGlobalRoleFingerprint,
  computeAssignProjectAccountantFingerprint,
  computeRecordEntryFingerprint,
  computeSetProjectVendorLinkFingerprint,
} from "../src/lib/vendor-finance/vendor-finance-contract.ts";
import { VFIN_02_PROJECT_LEDGERS_MIGRATION_NAME } from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const PRJ_1 = "vfin02_race_prj_1";
const PRJ_2 = "vfin02_race_prj_2";
const PRJ_RACE_ASSIGN = "vfin02_race_prj_assign";

const ADMIN_1 = {
  auth: "19600000-0000-4000-8000-000000000001",
  app: "29600000-0000-4000-8000-000000000001",
  name: "Full Admin VFIN-02 Race 1",
};
const ADMIN_2 = {
  auth: "19600000-0000-4000-8000-000000000002",
  app: "29600000-0000-4000-8000-000000000002",
  name: "Full Admin VFIN-02 Race 2",
};
const ACCT_1 = {
  auth: "19600000-0000-4000-8000-000000000011",
  app: "29600000-0000-4000-8000-000000000011",
  name: "Kế Toán Dự Án 1",
};
const ACCT_2 = {
  auth: "19600000-0000-4000-8000-000000000012",
  app: "29600000-0000-4000-8000-000000000012",
  name: "Kế Toán Dự Án 2",
};
const CASH_BEHALF = {
  auth: "19600000-0000-4000-8000-000000000021",
  app: "29600000-0000-4000-8000-000000000021",
  name: "Kế Toán Cầm Tiền Nhập Hộ",
};

let uuidSeq = 0;
function nextUuid() {
  uuidSeq += 1;
  return `89600000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
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

async function connect(port, database = "postgres", applicationName = "vfin-02-race") {
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
  const targetIndex = names.indexOf(VFIN_02_PROJECT_LEDGERS_MIGRATION_NAME);
  assert.ok(
    targetIndex >= 0,
    `migration inventory must include ${VFIN_02_PROJECT_LEDGERS_MIGRATION_NAME}`,
  );
  for (const name of names.slice(0, targetIndex + 1)) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

const RECORD_SQL =
  "select public.vendor_finance_record_entry($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::date, $8::text, $9::uuid, $10::text) as data";
const APPLY_OPENING_SQL =
  "select public.vendor_finance_apply_opening_batch($1::uuid, $2::uuid, $3::text, $4::date, $5::jsonb, $6::text, $7::uuid, $8::text) as data";
const ASSIGN_ACCT_SQL =
  "select public.vendor_finance_assign_project_accountant_admin($1::uuid, $2::uuid, $3::text, $4::uuid, $5::integer, $6::date, $7::text, $8::uuid, $9::text) as data";
const LINK_VENDOR_SQL =
  "select public.vendor_finance_set_project_vendor_link_admin($1::uuid, $2::uuid, $3::text, $4::text, $5::boolean, $6::integer, $7::text, $8::uuid, $9::text) as data";
const ASSIGN_GLOBAL_ROLE_SQL =
  "select public.vendor_finance_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, $4::text, $5::integer, $6::date, $7::text, $8::uuid, $9::text) as data";

async function seedFixture(client) {
  await client.query(
    `insert into public.teams (team_id, code, display_name, active)
     values ('99600000-0000-4000-8000-00000000000f'::uuid, '__system_vendor__', 'Vendor System', true)
     on conflict (code) do nothing`,
  );

  for (const person of [ADMIN_1, ADMIN_2, ACCT_1, ACCT_2, CASH_BEHALF]) {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      person.auth,
      `${person.app}@vfin02.local`,
    ]);
    await client.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1, $2, $3, true)",
      [person.app, person.auth, person.name],
    );
  }

  for (const admin of [ADMIN_1, ADMIN_2]) {
    await client.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1, 'entry_admin', '2026-01-01', true),
              ($1, 'recruiter_master_manage', '2026-01-01', true),
              ($1, 'team_master_manage', '2026-01-01', true),
              ($1, 'catalog_master_manage', '2026-01-01', true)`,
      [admin.app],
    );
    await client.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1, 'all', '2026-01-01', true)`,
      [admin.app],
    );
  }

  await client.query(
    `insert into public.direct_entry_projects (project_id, display_name, active, version)
     values ($1, 'Dự Án Đua Bút Toán 1', true, 1),
            ($2, 'Dự Án Đua Bút Toán 2', true, 1),
            ($3, 'Dự Án Đua Phân Công OCC', true, 1)`,
    [PRJ_1, PRJ_2, PRJ_RACE_ASSIGN],
  );

  // Assign ACCT_1 and ACCT_2 to ACCOUNTING department
  for (const acct of [ACCT_1, ACCT_2]) {
    const reason = `Assign ${acct.name}`;
    const fp = computeAssignAccountingMemberFingerprint({
      actor_app_user_id: ADMIN_1.app,
      account_ref: acct.app,
      expected_pair_version: 0,
      effective_from: "2026-01-01",
      reason,
    });
    await client.query(
      `select public.org_department_assign_accounting_member(
         $1::uuid, $2::uuid, $3::uuid, 0, '2026-01-01'::date, $4::text, $5::uuid, $6::text
       )`,
      [ADMIN_1.auth, ADMIN_1.app, acct.app, reason, nextUuid(), fp],
    );
  }

  // Designate CASH_BEHALF as CASH_HOLDER_RECORD_BEHALF
  const roleReason = "Chỉ định kế toán cầm tiền nhập hộ toàn cục";
  await client.query(ASSIGN_GLOBAL_ROLE_SQL, [
    ADMIN_1.auth,
    ADMIN_1.app,
    CASH_BEHALF.app,
    "CASH_HOLDER_RECORD_BEHALF",
    0,
    "2026-01-01",
    roleReason,
    nextUuid(),
    computeAssignGlobalRoleFingerprint({
      account_ref: CASH_BEHALF.app,
      role_code: "CASH_HOLDER_RECORD_BEHALF",
      valid_from: "2026-01-01",
      expected_version: 0,
      reason: roleReason,
    }),
  ]);

  // Assign PRJ_1 -> ACCT_1 and PRJ_2 -> ACCT_2 (leave PRJ_RACE_ASSIGN unassigned for Stage 3!)
  for (const [prj, acct] of [
    [PRJ_1, ACCT_1],
    [PRJ_2, ACCT_2],
  ]) {
    const reason = `Phân công ${acct.name} phụ trách ${prj}`;
    await client.query(ASSIGN_ACCT_SQL, [
      ADMIN_1.auth,
      ADMIN_1.app,
      prj,
      acct.app,
      0,
      "2026-01-01",
      reason,
      nextUuid(),
      computeAssignProjectAccountantFingerprint({
        project_id: prj,
        accountant_ref: acct.app,
        valid_from: "2026-01-01",
        expected_version: 0,
        reason,
      }),
    ]);
  }

  // Create canonical Vendors & controlled Vendor-Project links on PRJ_1 and PRJ_2
  const vendors = [
    ["VND_RACE_SHARED", "NCC Đua Song Song Hai Dự Án"],
    ["VND_RACE_OPEN_OVERLAP", "NCC Đua Số Dư Đầu Kỳ Theo Dự Án"],
    ["VND_LOCK_X", "NCC Khóa Thứ Tự X"],
    ["VND_LOCK_Y", "NCC Khóa Thứ Tự Y"],
  ];
  for (const [vid, vname] of vendors) {
    await client.query(
      `select public.direct_entry_create_vendor(
         $1::uuid, $2::uuid, 0, $3::text, $4::text, '2026-01-01'::date, 'Seed vendor', $5::text
       )`,
      [ADMIN_1.auth, ADMIN_1.app, vid, vname, nextUuid()],
    );
    for (const prj of [PRJ_1, PRJ_2]) {
      const linkReason = `Liên kết có kiểm soát ${vid} vào ${prj}`;
      await client.query(LINK_VENDOR_SQL, [
        ADMIN_1.auth,
        ADMIN_1.app,
        prj,
        vid,
        true,
        0,
        linkReason,
        nextUuid(),
        computeSetProjectVendorLinkFingerprint({
          project_id: prj,
          vendor_id: vid,
          active: true,
          expected_version: 0,
          reason: linkReason,
        }),
      ]);
    }
  }
}

test("VFIN-02 real PostgreSQL concurrency: per-sub-ledger serialization, zero cross-project netting under parallel burst, OCC project accountant assignment race, and deadlock-free project opening batches", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL initdb and pg_ctl are required for real concurrency regression");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vfin-02-race-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  const databaseName = `vfin_02_race_${process.pid}`;
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

    setup = await connect(port, databaseName, "vfin02-setup");
    await applyMigrations(setup);
    await seedFixture(setup);
    await setup.end();
    setup = undefined;

    observer = await connect(port, databaseName, "vfin02-observer");
    worker1 = await connect(port, databaseName, "vfin02-worker-1");
    worker2 = await connect(port, databaseName, "vfin02-worker-2");
    for (let i = 0; i < 6; i += 1) {
      const c = await connect(port, databaseName, `vfin02-burst-${i}`);
      await c.query("set role service_role");
      burstClients.push(c);
    }

    // =========================================================================
    // Stage 1: Deterministic Lock-Hold Race on `(VND_RACE_SHARED, PRJ_1, ACCT_1)`
    //          (`ACCT_1` holds lock while `CASH_BEHALF` records on behalf of `PRJ_1`)
    // =========================================================================
    const r1Reason = "Ghi nhận công nợ PRJ_1 đợt 1";
    const r1Fp = computeRecordEntryFingerprint({
      project_id: PRJ_1,
      vendor_id: "VND_RACE_SHARED",
      entry_type: "DEBT_RECORDED",
      amount_minor: "25000000",
      effective_date: "2026-10-10",
      reason: r1Reason,
    });
    const r2Reason = "Kế toán cầm tiền nhập hộ thanh toán PRJ_1 đang chờ lock";
    const r2Fp = computeRecordEntryFingerprint({
      project_id: PRJ_1,
      vendor_id: "VND_RACE_SHARED",
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
      "VND_RACE_SHARED",
      PRJ_1,
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
      CASH_BEHALF.auth,
      CASH_BEHALF.app,
      "VND_RACE_SHARED",
      PRJ_1,
      "PAYMENT_RECORDED",
      "5000000",
      "2026-10-10",
      r2Reason,
      nextUuid(),
      r2Fp,
    ]);

    await waitUntilBlocked(observer, "vfin02-worker-2");
    await worker1.query("commit");

    const w2EntryRes = await w2Pending;
    await worker2.query("commit");
    const entry2 = w2EntryRes.rows[0].data.entry;
    assert.equal(entry2.vendor_sequence, 2);
    assert.equal(entry2.balance_before_minor, "25000000");
    assert.equal(entry2.balance_delta_minor, "-5000000");
    assert.equal(entry2.balance_after_minor, "20000000");
    assert.equal(entry2.accountant_ref, ACCT_1.app);

    // =========================================================================
    // Stage 2: 6-Connection Parallel Burst Mixing `PRJ_1` (`ACCT_1` + `CASH_BEHALF`)
    //          and `PRJ_2` (`ACCT_2` + `CASH_BEHALF`) on the SAME Vendor `VND_RACE_SHARED`
    // =========================================================================
    const parallelSpecs = [
      { prj: PRJ_1, actor: ACCT_1, type: "DEBT_RECORDED", amount: "4000000" },
      { prj: PRJ_2, actor: ACCT_2, type: "DEBT_RECORDED", amount: "30000000" },
      { prj: PRJ_1, actor: CASH_BEHALF, type: "PAYMENT_RECORDED", amount: "2000000" },
      { prj: PRJ_2, actor: CASH_BEHALF, type: "ADVANCE_RECORDED", amount: "7000000" },
      { prj: PRJ_1, actor: ACCT_1, type: "PAYROLL_RECORDED", amount: "6000000" },
      { prj: PRJ_2, actor: ACCT_2, type: "ADJUSTMENT_INCREASE", amount: "3000000" },
    ];

    const burstOutcomes = await Promise.all(
      parallelSpecs.map((spec, idx) => {
        const reason = `Burst đa dự án #${idx + 1} trên ${spec.prj}`;
        return burstClients[idx].query(RECORD_SQL, [
          spec.actor.auth,
          spec.actor.app,
          "VND_RACE_SHARED",
          spec.prj,
          spec.type,
          spec.amount,
          "2026-10-11",
          reason,
          nextUuid(),
          computeRecordEntryFingerprint({
            project_id: spec.prj,
            vendor_id: "VND_RACE_SHARED",
            entry_type: spec.type,
            amount_minor: spec.amount,
            effective_date: "2026-10-11",
            reason,
          }),
        ]);
      }),
    );
    assert.equal(burstOutcomes.length, 6);

    // Verify PRJ_1 chain (`1..5`, owned strictly by ACCT_1, closing = 25M - 5M + 4M - 2M + 6M = 28,000,000)
    const { rows: prj1Chain } = await observer.query(
      `select vendor_sequence::int as seq,
              responsible_accountant_user_id::text as owner_id,
              balance_before_minor::text as before_minor,
              balance_delta_minor::text as delta_minor,
              balance_after_minor::text as after_minor,
              document_no
         from public.vendor_finance_entries
        where vendor_id = 'VND_RACE_SHARED' and project_id = $1
        order by vendor_sequence asc`,
      [PRJ_1],
    );
    assert.equal(prj1Chain.length, 5);
    let runningPrj1 = 0n;
    for (let i = 0; i < prj1Chain.length; i += 1) {
      const row = prj1Chain[i];
      assert.equal(row.seq, i + 1, "PRJ_1 vendor_sequence must be gapless 1..5");
      assert.equal(row.owner_id, ACCT_1.app, "PRJ_1 entries must all stay owned by ACCT_1");
      assert.equal(BigInt(row.before_minor), runningPrj1);
      runningPrj1 += BigInt(row.delta_minor);
      assert.equal(BigInt(row.after_minor), runningPrj1);
    }
    assert.equal(runningPrj1, 28000000n);

    // Verify PRJ_2 chain (`1..3`, owned strictly by ACCT_2, closing = 30M - 7M + 3M = 26,000,000)
    const { rows: prj2Chain } = await observer.query(
      `select vendor_sequence::int as seq,
              responsible_accountant_user_id::text as owner_id,
              balance_before_minor::text as before_minor,
              balance_delta_minor::text as delta_minor,
              balance_after_minor::text as after_minor,
              document_no
         from public.vendor_finance_entries
        where vendor_id = 'VND_RACE_SHARED' and project_id = $1
        order by vendor_sequence asc`,
      [PRJ_2],
    );
    assert.equal(prj2Chain.length, 3);
    let runningPrj2 = 0n;
    for (let i = 0; i < prj2Chain.length; i += 1) {
      const row = prj2Chain[i];
      assert.equal(row.seq, i + 1, "PRJ_2 vendor_sequence must be gapless 1..3 independently of PRJ_1");
      assert.equal(row.owner_id, ACCT_2.app, "PRJ_2 entries must all stay owned by ACCT_2");
      assert.equal(BigInt(row.before_minor), runningPrj2);
      runningPrj2 += BigInt(row.delta_minor);
      assert.equal(BigInt(row.after_minor), runningPrj2);
    }
    assert.equal(runningPrj2, 26000000n);

    // Document numbers across both project books must be globally unique
    const allDocNos = [...prj1Chain, ...prj2Chain].map((r) => r.document_no);
    assert.equal(new Set(allDocNos).size, 8);

    // =========================================================================
    // Stage 3: Concurrent OCC Project Accountant Assignment Race on `PRJ_RACE_ASSIGN`
    //          (`1 dự án = 1 kế toán phụ trách đang hiệu lực`)
    // =========================================================================
    const assignReason1 = "Admin 1 phân công Kế toán 1 vào PRJ_RACE_ASSIGN";
    const assignReason2 = "Admin 2 đồng thời phân công Kế toán 2 vào PRJ_RACE_ASSIGN";
    const assignOutcomes = await Promise.allSettled([
      burstClients[0].query(ASSIGN_ACCT_SQL, [
        ADMIN_1.auth,
        ADMIN_1.app,
        PRJ_RACE_ASSIGN,
        ACCT_1.app,
        0,
        "2026-10-01",
        assignReason1,
        nextUuid(),
        computeAssignProjectAccountantFingerprint({
          project_id: PRJ_RACE_ASSIGN,
          accountant_ref: ACCT_1.app,
          valid_from: "2026-10-01",
          expected_version: 0,
          reason: assignReason1,
        }),
      ]),
      burstClients[1].query(ASSIGN_ACCT_SQL, [
        ADMIN_2.auth,
        ADMIN_2.app,
        PRJ_RACE_ASSIGN,
        ACCT_2.app,
        0,
        "2026-10-01",
        assignReason2,
        nextUuid(),
        computeAssignProjectAccountantFingerprint({
          project_id: PRJ_RACE_ASSIGN,
          accountant_ref: ACCT_2.app,
          valid_from: "2026-10-01",
          expected_version: 0,
          reason: assignReason2,
        }),
      ]),
    ]);

    const assignWinners = assignOutcomes.filter((o) => o.status === "fulfilled");
    const assignLosers = assignOutcomes.filter((o) => o.status === "rejected");
    assert.equal(assignWinners.length, 1, "strictly 1 concurrent assignment may win");
    assert.equal(assignLosers.length, 1, "contending concurrent assignment must reject");
    assert.ok(
      assignLosers[0].reason.code === "40900" || assignLosers[0].reason.code === "23505",
      `Unexpected assignment race error: ${assignLosers[0].reason.code} ${assignLosers[0].reason.message}`,
    );

    const { rows: activeAssignRows } = await observer.query(
      `select count(*)::int as n
         from public.vendor_finance_project_accountants
        where project_id = $1 and valid_to is null`,
      [PRJ_RACE_ASSIGN],
    );
    assert.equal(activeAssignRows[0].n, 1);

    // =========================================================================
    // Stage 4: Project-Scoped Opening Balance Batch Races & Deadlock Freedom
    // =========================================================================
    // 4a. Overlapping Vendor on `PRJ_1` -> strictly 1 winner, 1 `23505`
    //     while `PRJ_2` can initialize the SAME Vendor concurrently without conflict!
    const openItemsOverlap = [
      { vendor_id: "VND_RACE_OPEN_OVERLAP", entry_type: "OPENING_PAYABLE", amount_minor: "9000000" },
    ];
    const openReason1 = "Khởi tạo đầu kỳ PRJ_1 luồng A";
    const openReason2 = "Khởi tạo đầu kỳ PRJ_1 luồng B";
    const openReasonPrj2 = "Khởi tạo đầu kỳ PRJ_2 độc lập cho cùng NCC";

    const openRaceOutcomes = await Promise.allSettled([
      burstClients[0].query(APPLY_OPENING_SQL, [
        ACCT_1.auth,
        ACCT_1.app,
        PRJ_1,
        "2026-10-01",
        JSON.stringify(openItemsOverlap),
        openReason1,
        nextUuid(),
        computeApplyOpeningBatchFingerprint({
          project_id: PRJ_1,
          cutoff_date: "2026-10-01",
          items: openItemsOverlap,
          reason: openReason1,
        }),
      ]),
      burstClients[1].query(APPLY_OPENING_SQL, [
        CASH_BEHALF.auth,
        CASH_BEHALF.app,
        PRJ_1,
        "2026-10-01",
        JSON.stringify(openItemsOverlap),
        openReason2,
        nextUuid(),
        computeApplyOpeningBatchFingerprint({
          project_id: PRJ_1,
          cutoff_date: "2026-10-01",
          items: openItemsOverlap,
          reason: openReason2,
        }),
      ]),
      burstClients[2].query(APPLY_OPENING_SQL, [
        ACCT_2.auth,
        ACCT_2.app,
        PRJ_2,
        "2026-10-01",
        JSON.stringify(openItemsOverlap),
        openReasonPrj2,
        nextUuid(),
        computeApplyOpeningBatchFingerprint({
          project_id: PRJ_2,
          cutoff_date: "2026-10-01",
          items: openItemsOverlap,
          reason: openReasonPrj2,
        }),
      ]),
    ]);

    assert.equal(
      openRaceOutcomes[2].status,
      "fulfilled",
      "PRJ_2 opening batch for the same Vendor must succeed independently",
    );
    const prj1OpenOutcomes = openRaceOutcomes.slice(0, 2);
    assert.equal(prj1OpenOutcomes.filter((o) => o.status === "fulfilled").length, 1);
    const prj1OpenRejected = prj1OpenOutcomes.filter((o) => o.status === "rejected");
    assert.equal(prj1OpenRejected.length, 1);
    assert.equal(prj1OpenRejected[0].reason.code, "23505");
    assert.match(prj1OpenRejected[0].reason.message, /VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED/);

    // 4b. Opposite-order multi-Vendor opening batches (`[Y, X]` vs `[X, Y]`) -> ZERO `40P01` deadlocks
    const itemsYX = [
      { vendor_id: "VND_LOCK_Y", entry_type: "OPENING_PAYABLE", amount_minor: "5000000" },
      { vendor_id: "VND_LOCK_X", entry_type: "OPENING_ADVANCE", amount_minor: "2000000" },
    ];
    const itemsXY = [
      { vendor_id: "VND_LOCK_X", entry_type: "OPENING_PAYABLE", amount_minor: "8000000" },
      { vendor_id: "VND_LOCK_Y", entry_type: "OPENING_PAYABLE", amount_minor: "3000000" },
    ];
    const lockReasonA = "Đầu kỳ đa NCC thứ tự Y -> X";
    const lockReasonB = "Đầu kỳ đa NCC thứ tự X -> Y";
    const lockOrderOutcomes = await Promise.allSettled([
      burstClients[3].query(APPLY_OPENING_SQL, [
        ACCT_1.auth,
        ACCT_1.app,
        PRJ_1,
        "2026-10-01",
        JSON.stringify(itemsYX),
        lockReasonA,
        nextUuid(),
        computeApplyOpeningBatchFingerprint({
          project_id: PRJ_1,
          cutoff_date: "2026-10-01",
          items: itemsYX,
          reason: lockReasonA,
        }),
      ]),
      burstClients[4].query(APPLY_OPENING_SQL, [
        CASH_BEHALF.auth,
        CASH_BEHALF.app,
        PRJ_1,
        "2026-10-01",
        JSON.stringify(itemsXY),
        lockReasonB,
        nextUuid(),
        computeApplyOpeningBatchFingerprint({
          project_id: PRJ_1,
          cutoff_date: "2026-10-01",
          items: itemsXY,
          reason: lockReasonB,
        }),
      ]),
    ]);

    for (const o of lockOrderOutcomes) {
      if (o.status === "rejected") {
        assert.notEqual(o.reason.code, "40P01", "opposite vendor order must never deadlock");
        assert.equal(o.reason.code, "23505");
      }
    }
    assert.equal(lockOrderOutcomes.filter((o) => o.status === "fulfilled").length, 1);
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
