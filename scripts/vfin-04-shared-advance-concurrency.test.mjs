/**
 * VFIN-04 — Real PostgreSQL Shared Vendor Advance & Offset Concurrency Suite.
 *
 * Proves against an isolated local PostgreSQL cluster (`initdb` + `pg_ctl`, zero remote DB):
 *   1. Cross-project offset race on the same Vendor (`shared_advance = 100,000,000`,
 *      `PRJ_1 payable = 80,000,000`, `PRJ_2 payable = 80,000,000`, concurrent offsets of
 *      `60,000,000` each): strictly 1 succeeds, 1 fails with
 *      `VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE`, final `shared_advance_balance_minor = 40,000,000`,
 *      contiguous `vendor_advance_sequence` `1..2`, zero `40P01` deadlocks.
 *   2. Concurrent Cash-Holder refund (`70,000,000`) + Project Accountant offset (`50,000,000`)
 *      against `shared_advance = 100,000,000`: strictly 1 succeeds, 1 fails with
 *      `VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE`, balance never negative, zero deadlocks.
 *   3. Concurrent double offset (`50,000,000` x 2) on the same project sub-ledger with
 *      `shared_advance = 200,000,000` and `subledger payable = 60,000,000`: strictly 1 succeeds,
 *      1 fails with `VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE`, final sub-ledger balance
 *      `10,000,000` and shared advance `150,000,000`.
 *   4. Concurrent idempotency replay & fingerprint conflict on shared advance mutations:
 *      concurrent identical `(actor_user_id, idempotency_key, request_fingerprint)` calls return
 *      1 `replayed: false` + 1 `replayed: true` with a single movement/entry; mismatched
 *      fingerprint fails with `VENDOR_FINANCE_IDEMPOTENCY_CONFLICT` (`23505`).
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
  computeApplySharedAdvanceOffsetFingerprint,
  computeAssignGlobalRoleFingerprint,
  computeAssignProjectAccountantFingerprint,
  computeFundSharedAdvanceFingerprint,
  computeRecordEntryFingerprint,
  computeRecordVendorRefundFingerprint,
} from "../src/lib/vendor-finance/vendor-finance-contract.ts";
import { VFIN_04_SHARED_VENDOR_ADVANCE_MIGRATION_NAME } from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const PRJ_1 = "vfin04_race_prj_1";
const PRJ_2 = "vfin04_race_prj_2";

const ADMIN = {
  auth: "19800000-0000-4000-8000-000000000001",
  app: "29800000-0000-4000-8000-000000000001",
  name: "Full Admin VFIN-04 Race",
};
const ACCT_1 = {
  auth: "19800000-0000-4000-8000-000000000011",
  app: "29800000-0000-4000-8000-000000000011",
  name: "Kế Toán Dự Án 1",
};
const ACCT_2 = {
  auth: "19800000-0000-4000-8000-000000000012",
  app: "29800000-0000-4000-8000-000000000012",
  name: "Kế Toán Dự Án 2",
};
const CASH_HOLDER = {
  auth: "19800000-0000-4000-8000-000000000021",
  app: "29800000-0000-4000-8000-000000000021",
  name: "Người Cầm Tiền (CASH_HOLDER)",
};
const CASH_BEHALF = {
  auth: "19800000-0000-4000-8000-000000000022",
  app: "29800000-0000-4000-8000-000000000022",
  name: "Người Cầm Tiền Nhập Hộ (CASH_HOLDER_RECORD_BEHALF)",
};

let uuidSeq = 0;
function nextUuid() {
  uuidSeq += 1;
  return `89800000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
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

async function connect(port, database = "postgres", applicationName = "vfin-04-race") {
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

async function applyMigrations(client) {
  await client.query(
    "create role anon; create role authenticated; create role service_role;" +
      " create schema auth; create table auth.users (id uuid primary key, email text);",
  );
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql") && name <= VFIN_04_SHARED_VENDOR_ADVANCE_MIGRATION_NAME)
    .sort();
  assert.ok(
    names.includes(VFIN_04_SHARED_VENDOR_ADVANCE_MIGRATION_NAME),
    `migration inventory must include ${VFIN_04_SHARED_VENDOR_ADVANCE_MIGRATION_NAME}`,
  );
  for (const name of names) {
    await client.query(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
}

const RECORD_SQL =
  "select public.vendor_finance_record_entry($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text, $8::date, $9::text, $10::uuid, $11::text) as data";
const FUND_ADVANCE_SQL =
  "select public.vendor_finance_fund_shared_advance($1::uuid, $2::uuid, $3::text, $4::text, $5::date, $6::text, $7::uuid, $8::text) as data";
const REFUND_ADVANCE_SQL =
  "select public.vendor_finance_record_vendor_refund($1::uuid, $2::uuid, $3::text, $4::text, $5::date, $6::text, $7::uuid, $8::text) as data";
const APPLY_OFFSET_SQL =
  "select public.vendor_finance_apply_shared_advance_offset($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::date, $8::text, $9::uuid, $10::text) as data";
const ASSIGN_ACCT_SQL =
  "select public.vendor_finance_assign_project_accountant_admin($1::uuid, $2::uuid, $3::text, $4::uuid, $5::integer, $6::date, $7::text, $8::uuid, $9::text) as data";
const ASSIGN_GLOBAL_ROLE_SQL =
  "select public.vendor_finance_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, $4::text, $5::integer, $6::date, $7::text, $8::uuid, $9::text) as data";

async function seedFixture(client) {
  await client.query(
    `insert into public.teams (team_id, code, display_name, active)
     values ('99800000-0000-4000-8000-00000000000f'::uuid, '__system_vendor__', 'Vendor System', true)
     on conflict (code) do nothing`,
  );

  for (const person of [ADMIN, ACCT_1, ACCT_2, CASH_HOLDER, CASH_BEHALF]) {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [
      person.auth,
      `${person.app}@vfin04.local`,
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
    [ADMIN.app],
  );
  await client.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
     values ($1, 'all', '2026-01-01', true)`,
    [ADMIN.app],
  );

  for (const acct of [ACCT_1, ACCT_2]) {
    const reason = `Cấp quyền phòng Kế toán cho ${acct.name}`;
    await client.query(
      `select public.org_department_assign_accounting_member(
         $1::uuid, $2::uuid, $3::uuid, 0, '2026-01-01'::date, $4::text, $5::uuid, $6::text
       )`,
      [
        ADMIN.auth,
        ADMIN.app,
        acct.app,
        reason,
        nextUuid(),
        computeAssignAccountingMemberFingerprint({
          actor_app_user_id: ADMIN.app,
          account_ref: acct.app,
          expected_pair_version: 0,
          effective_from: "2026-01-01",
          reason,
        }),
      ],
    );
  }

  for (const [user, roleCode] of [
    [CASH_HOLDER, "CASH_HOLDER"],
    [CASH_BEHALF, "CASH_HOLDER_RECORD_BEHALF"],
  ]) {
    const reason = `Cấp vai trò ${roleCode}`;
    await client.query(ASSIGN_GLOBAL_ROLE_SQL, [
      ADMIN.auth,
      ADMIN.app,
      user.app,
      roleCode,
      0,
      "2026-01-01",
      reason,
      nextUuid(),
      computeAssignGlobalRoleFingerprint({
        user_ref: user.app,
        role_code: roleCode,
        expected_version: 0,
        valid_from: "2026-01-01",
        reason,
      }),
    ]);
  }

  await client.query(
    `insert into public.direct_entry_projects (project_id, display_name, active, version)
     values ($1, 'Dự Án Đua 1', true, 1),
            ($2, 'Dự Án Đua 2', true, 1)`,
    [PRJ_1, PRJ_2],
  );

  for (const [prj, acct] of [
    [PRJ_1, ACCT_1],
    [PRJ_2, ACCT_2],
  ]) {
    const reason = `Phân công ${acct.name} phụ trách ${prj}`;
    await client.query(ASSIGN_ACCT_SQL, [
      ADMIN.auth,
      ADMIN.app,
      prj,
      acct.app,
      0,
      "2026-01-01",
      reason,
      nextUuid(),
      computeAssignProjectAccountantFingerprint({
        project_id: prj,
        accountant_ref: acct.app,
        expected_version: 0,
        valid_from: "2026-01-01",
        reason,
      }),
    ]);
  }

  for (const [vid, vname] of [
    ["VND_CONC_CROSS", "NCC Đua Khấu Trừ Hai Dự Án"],
    ["VND_CONC_REFUND", "NCC Đua Hoàn Ứng Và Khấu Trừ"],
    ["VND_CONC_SUB", "NCC Đua Hai Lần Khấu Trừ Cùng Sổ"],
    ["VND_CONC_IDEM", "NCC Đua Idempotency"],
  ]) {
    await client.query(
      `select public.direct_entry_create_vendor(
         $1::uuid, $2::uuid, 0, $3::text, $4::text, '2026-01-01'::date, 'Seed vendor', $5::text
       )`,
      [ADMIN.auth, ADMIN.app, vid, vname, nextUuid()],
    );
  }
}

test("VFIN-04 real PostgreSQL concurrency: cross-project offset race, refund vs offset race, same-subledger double offset race, and idempotency replay/conflict", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    t.skip("PostgreSQL initdb and pg_ctl are required for real concurrency regression");
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vfin-04-race-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const port = await freePort();
  const databaseName = `vfin_04_race_${process.pid}`;
  let serverStarted = false;
  let adminClient;
  let setup;
  let observer;
  const clients = [];

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

    setup = await connect(port, databaseName, "vfin04-setup");
    await applyMigrations(setup);
    await seedFixture(setup);
    await setup.end();
    setup = undefined;

    observer = await connect(port, databaseName, "vfin04-observer");
    for (let i = 0; i < 4; i += 1) {
      const c = await connect(port, databaseName, `vfin04-client-${i}`);
      await c.query("set role service_role");
      clients.push(c);
    }

    // =========================================================================
    // Test 1: Cross-project offset race on `VND_CONC_CROSS`
    //         `shared_advance = 100,000,000`, `PRJ_1 payable = 80,000,000`,
    //         `PRJ_2 payable = 80,000,000`, concurrent offsets of `60,000,000` each.
    // =========================================================================
    const fundCrossReason = "Ứng dùng chung 100tr cho VND_CONC_CROSS";
    await clients[0].query(FUND_ADVANCE_SQL, [
      CASH_HOLDER.auth,
      CASH_HOLDER.app,
      "VND_CONC_CROSS",
      "100000000",
      "2026-10-05",
      fundCrossReason,
      nextUuid(),
      computeFundSharedAdvanceFingerprint({
        vendor_id: "VND_CONC_CROSS",
        amount_minor: "100000000",
        effective_date: "2026-10-05",
        reason: fundCrossReason,
      }),
    ]);

    for (const [acct, prj] of [
      [ACCT_1, PRJ_1],
      [ACCT_2, PRJ_2],
    ]) {
      const debtReason = `Công nợ 80tr trên ${prj}`;
      await clients[0].query(RECORD_SQL, [
        acct.auth,
        acct.app,
        "VND_CONC_CROSS",
        prj,
        "SEASONAL",
        "DEBT_RECORDED",
        "80000000",
        "2026-10-06",
        debtReason,
        nextUuid(),
        computeRecordEntryFingerprint({
          vendor_id: "VND_CONC_CROSS",
          project_id: prj,
          contract_type: "SEASONAL",
          entry_type: "DEBT_RECORDED",
          amount_minor: "80000000",
          effective_date: "2026-10-06",
          reason: debtReason,
        }),
      ]);
    }

    const crossReason1 = "Khấu trừ 60tr vào PRJ_1";
    const crossReason2 = "Khấu trừ 60tr vào PRJ_2";
    const crossOutcomes = await Promise.allSettled([
      clients[0].query(APPLY_OFFSET_SQL, [
        ACCT_1.auth,
        ACCT_1.app,
        "VND_CONC_CROSS",
        PRJ_1,
        "SEASONAL",
        "60000000",
        "2026-10-10",
        crossReason1,
        nextUuid(),
        computeApplySharedAdvanceOffsetFingerprint({
          vendor_id: "VND_CONC_CROSS",
          project_id: PRJ_1,
          contract_type: "SEASONAL",
          amount_minor: "60000000",
          effective_date: "2026-10-10",
          reason: crossReason1,
        }),
      ]),
      clients[1].query(APPLY_OFFSET_SQL, [
        ACCT_2.auth,
        ACCT_2.app,
        "VND_CONC_CROSS",
        PRJ_2,
        "SEASONAL",
        "60000000",
        "2026-10-10",
        crossReason2,
        nextUuid(),
        computeApplySharedAdvanceOffsetFingerprint({
          vendor_id: "VND_CONC_CROSS",
          project_id: PRJ_2,
          contract_type: "SEASONAL",
          amount_minor: "60000000",
          effective_date: "2026-10-10",
          reason: crossReason2,
        }),
      ]),
    ]);

    const crossWinners = crossOutcomes.filter((o) => o.status === "fulfilled");
    const crossLosers = crossOutcomes.filter((o) => o.status === "rejected");
    assert.equal(crossWinners.length, 1, "strictly 1 cross-project offset must succeed");
    assert.equal(crossLosers.length, 1, "contending cross-project offset must fail");
    assert.notEqual(crossLosers[0].reason.code, "40P01", "zero deadlocks allowed");
    assert.equal(crossLosers[0].reason.code, "23514");
    assert.match(
      crossLosers[0].reason.message,
      /VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE/,
    );

    const { rows: crossMovs } = await observer.query(
      `select vendor_advance_sequence::int as seq,
              movement_type,
              balance_before_minor::text as before_minor,
              balance_delta_minor::text as delta_minor,
              balance_after_minor::text as after_minor
         from public.vendor_finance_shared_advance_movements
        where vendor_id = 'VND_CONC_CROSS'
        order by vendor_advance_sequence asc`,
    );
    assert.equal(crossMovs.length, 2);
    assert.deepEqual(
      crossMovs.map((m) => m.seq),
      [1, 2],
      "vendor_advance_sequence must be contiguous 1..2",
    );
    assert.equal(crossMovs[1].after_minor, "40000000");

    // =========================================================================
    // Test 2: Concurrent Vendor Refund (`70,000,000`) + Project Offset (`50,000,000`)
    //         on `VND_CONC_REFUND` (`shared_advance = 100,000,000`)
    // =========================================================================
    const fundRefundReason = "Ứng dùng chung 100tr cho VND_CONC_REFUND";
    await clients[0].query(FUND_ADVANCE_SQL, [
      CASH_HOLDER.auth,
      CASH_HOLDER.app,
      "VND_CONC_REFUND",
      "100000000",
      "2026-10-05",
      fundRefundReason,
      nextUuid(),
      computeFundSharedAdvanceFingerprint({
        vendor_id: "VND_CONC_REFUND",
        amount_minor: "100000000",
        effective_date: "2026-10-05",
        reason: fundRefundReason,
      }),
    ]);

    const refundDebtReason = "Công nợ 80tr trên PRJ_1 cho VND_CONC_REFUND";
    await clients[0].query(RECORD_SQL, [
      ACCT_1.auth,
      ACCT_1.app,
      "VND_CONC_REFUND",
      PRJ_1,
      "SEASONAL",
      "DEBT_RECORDED",
      "80000000",
      "2026-10-06",
      refundDebtReason,
      nextUuid(),
      computeRecordEntryFingerprint({
        vendor_id: "VND_CONC_REFUND",
        project_id: PRJ_1,
        contract_type: "SEASONAL",
        entry_type: "DEBT_RECORDED",
        amount_minor: "80000000",
        effective_date: "2026-10-06",
        reason: refundDebtReason,
      }),
    ]);

    const refundRaceReason = "Vendor hoàn ứng 70tr";
    const offsetRaceReason = "Kế toán PRJ_1 khấu trừ 50tr đồng thời";
    const refundVsOffsetOutcomes = await Promise.allSettled([
      clients[0].query(REFUND_ADVANCE_SQL, [
        CASH_HOLDER.auth,
        CASH_HOLDER.app,
        "VND_CONC_REFUND",
        "70000000",
        "2026-10-12",
        refundRaceReason,
        nextUuid(),
        computeRecordVendorRefundFingerprint({
          vendor_id: "VND_CONC_REFUND",
          amount_minor: "70000000",
          effective_date: "2026-10-12",
          reason: refundRaceReason,
        }),
      ]),
      clients[1].query(APPLY_OFFSET_SQL, [
        ACCT_1.auth,
        ACCT_1.app,
        "VND_CONC_REFUND",
        PRJ_1,
        "SEASONAL",
        "50000000",
        "2026-10-12",
        offsetRaceReason,
        nextUuid(),
        computeApplySharedAdvanceOffsetFingerprint({
          vendor_id: "VND_CONC_REFUND",
          project_id: PRJ_1,
          contract_type: "SEASONAL",
          amount_minor: "50000000",
          effective_date: "2026-10-12",
          reason: offsetRaceReason,
        }),
      ]),
    ]);

    const rvoWinners = refundVsOffsetOutcomes.filter((o) => o.status === "fulfilled");
    const rvoLosers = refundVsOffsetOutcomes.filter((o) => o.status === "rejected");
    assert.equal(rvoWinners.length, 1, "strictly 1 of (refund 70M, offset 50M) must win");
    assert.equal(rvoLosers.length, 1, "contending operation must fail");
    assert.notEqual(rvoLosers[0].reason.code, "40P01", "zero deadlocks allowed");
    assert.equal(rvoLosers[0].reason.code, "23514");
    assert.match(
      rvoLosers[0].reason.message,
      /VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE/,
    );

    const { rows: rvoMovs } = await observer.query(
      `select vendor_advance_sequence::int as seq,
              movement_type,
              balance_after_minor::text as after_minor
         from public.vendor_finance_shared_advance_movements
        where vendor_id = 'VND_CONC_REFUND'
        order by vendor_advance_sequence asc`,
    );
    assert.equal(rvoMovs.length, 2);
    assert.ok(
      BigInt(rvoMovs[1].after_minor) >= 0n,
      "shared_advance_balance_minor must never be negative",
    );
    assert.ok(
      rvoMovs[1].after_minor === "30000000" || rvoMovs[1].after_minor === "50000000",
      "final shared advance balance must be 30M (if refund won) or 50M (if offset won)",
    );

    // =========================================================================
    // Test 3: Concurrent Double Offset on the SAME Project Sub-Ledger (`VND_CONC_SUB`)
    //         `shared_advance = 200,000,000`, `PRJ_1 SEASONAL payable = 60,000,000`,
    //         two concurrent offsets of `50,000,000` each.
    // =========================================================================
    const fundSubReason = "Ứng dùng chung 200tr cho VND_CONC_SUB";
    await clients[0].query(FUND_ADVANCE_SQL, [
      CASH_HOLDER.auth,
      CASH_HOLDER.app,
      "VND_CONC_SUB",
      "200000000",
      "2026-10-05",
      fundSubReason,
      nextUuid(),
      computeFundSharedAdvanceFingerprint({
        vendor_id: "VND_CONC_SUB",
        amount_minor: "200000000",
        effective_date: "2026-10-05",
        reason: fundSubReason,
      }),
    ]);

    const subDebtReason = "Công nợ 60tr trên PRJ_1 SEASONAL cho VND_CONC_SUB";
    await clients[0].query(RECORD_SQL, [
      ACCT_1.auth,
      ACCT_1.app,
      "VND_CONC_SUB",
      PRJ_1,
      "SEASONAL",
      "DEBT_RECORDED",
      "60000000",
      "2026-10-06",
      subDebtReason,
      nextUuid(),
      computeRecordEntryFingerprint({
        vendor_id: "VND_CONC_SUB",
        project_id: PRJ_1,
        contract_type: "SEASONAL",
        entry_type: "DEBT_RECORDED",
        amount_minor: "60000000",
        effective_date: "2026-10-06",
        reason: subDebtReason,
      }),
    ]);

    const subOffsetReasonA = "Khấu trừ 50tr luồng 1";
    const subOffsetReasonB = "Khấu trừ 50tr luồng 2";
    const sameSubOutcomes = await Promise.allSettled([
      clients[0].query(APPLY_OFFSET_SQL, [
        ACCT_1.auth,
        ACCT_1.app,
        "VND_CONC_SUB",
        PRJ_1,
        "SEASONAL",
        "50000000",
        "2026-10-15",
        subOffsetReasonA,
        nextUuid(),
        computeApplySharedAdvanceOffsetFingerprint({
          vendor_id: "VND_CONC_SUB",
          project_id: PRJ_1,
          contract_type: "SEASONAL",
          amount_minor: "50000000",
          effective_date: "2026-10-15",
          reason: subOffsetReasonA,
        }),
      ]),
      clients[1].query(APPLY_OFFSET_SQL, [
        CASH_BEHALF.auth,
        CASH_BEHALF.app,
        "VND_CONC_SUB",
        PRJ_1,
        "SEASONAL",
        "50000000",
        "2026-10-15",
        subOffsetReasonB,
        nextUuid(),
        computeApplySharedAdvanceOffsetFingerprint({
          vendor_id: "VND_CONC_SUB",
          project_id: PRJ_1,
          contract_type: "SEASONAL",
          amount_minor: "50000000",
          effective_date: "2026-10-15",
          reason: subOffsetReasonB,
        }),
      ]),
    ]);

    const sameSubWinners = sameSubOutcomes.filter((o) => o.status === "fulfilled");
    const sameSubLosers = sameSubOutcomes.filter((o) => o.status === "rejected");
    assert.equal(sameSubWinners.length, 1, "strictly 1 offset on the same sub-ledger must succeed");
    assert.equal(sameSubLosers.length, 1, "second 50M offset against 60M payable must fail");
    assert.notEqual(sameSubLosers[0].reason.code, "40P01", "zero deadlocks allowed");
    assert.equal(sameSubLosers[0].reason.code, "23514");
    assert.match(
      sameSubLosers[0].reason.message,
      /VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE/,
    );

    const { rows: subEntries } = await observer.query(
      `select vendor_sequence::int as seq, balance_after_minor::text as after_minor
         from public.vendor_finance_entries
        where vendor_id = 'VND_CONC_SUB' and project_id = $1 and contract_type = 'SEASONAL'
        order by vendor_sequence asc`,
      [PRJ_1],
    );
    assert.equal(subEntries.length, 2);
    assert.equal(subEntries[1].after_minor, "10000000", "final sub-ledger balance must be 10M");

    const { rows: subMovs } = await observer.query(
      `select vendor_advance_sequence::int as seq, balance_after_minor::text as after_minor
         from public.vendor_finance_shared_advance_movements
        where vendor_id = 'VND_CONC_SUB'
        order by vendor_advance_sequence asc`,
    );
    assert.equal(subMovs.length, 2);
    assert.equal(subMovs[1].after_minor, "150000000", "final shared advance balance must be 150M");

    // =========================================================================
    // Test 4: Concurrent Idempotency Replay & Conflict on `VND_CONC_IDEM`
    // =========================================================================
    const sharedIdemKey = nextUuid();
    const idemReason = "Ứng 45tr kiểm tra idempotency song song";
    const idemFp = computeFundSharedAdvanceFingerprint({
      vendor_id: "VND_CONC_IDEM",
      amount_minor: "45000000",
      effective_date: "2026-10-18",
      reason: idemReason,
    });

    const idemReplayResults = await Promise.all([
      clients[0].query(FUND_ADVANCE_SQL, [
        CASH_HOLDER.auth,
        CASH_HOLDER.app,
        "VND_CONC_IDEM",
        "45000000",
        "2026-10-18",
        idemReason,
        sharedIdemKey,
        idemFp,
      ]),
      clients[1].query(FUND_ADVANCE_SQL, [
        CASH_HOLDER.auth,
        CASH_HOLDER.app,
        "VND_CONC_IDEM",
        "45000000",
        "2026-10-18",
        idemReason,
        sharedIdemKey,
        idemFp,
      ]),
    ]);

    const replayedFlags = idemReplayResults.map((r) => r.rows[0].data.replayed).sort();
    assert.deepEqual(
      replayedFlags,
      [false, true],
      "one concurrent call executes (replayed: false) and the other replays (replayed: true)",
    );
    assert.equal(
      idemReplayResults[0].rows[0].data.movement.movement_id,
      idemReplayResults[1].rows[0].data.movement.movement_id,
      "both concurrent calls return the exact same movement_id",
    );

    const { rows: idemMovCount } = await observer.query(
      "select count(*)::int as c from public.vendor_finance_shared_advance_movements where vendor_id = 'VND_CONC_IDEM'",
    );
    assert.equal(idemMovCount[0].c, 1, "only 1 movement row created under concurrent replay");

    // Reuse same idempotency_key with different fingerprint -> 23505 VENDOR_FINANCE_IDEMPOTENCY_CONFLICT
    await assert.rejects(
      () =>
        clients[0].query(FUND_ADVANCE_SQL, [
          CASH_HOLDER.auth,
          CASH_HOLDER.app,
          "VND_CONC_IDEM",
          "99000000",
          "2026-10-18",
          idemReason,
          sharedIdemKey,
          computeFundSharedAdvanceFingerprint({
            vendor_id: "VND_CONC_IDEM",
            amount_minor: "99000000",
            effective_date: "2026-10-18",
            reason: idemReason,
          }),
        ]),
      (err) =>
        err?.code === "23505" &&
        typeof err?.message === "string" &&
        err.message.includes("VENDOR_FINANCE_IDEMPOTENCY_CONFLICT"),
    );
  } finally {
    for (const c of clients) {
      await c.end().catch(() => {});
    }
    await observer?.end().catch(() => {});
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
