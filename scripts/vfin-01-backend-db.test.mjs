/**
 * VFIN-01 (Work Package 2) — Vendor Finance & Debt Management Database, Security,
 * Authority Isolation, Ledger Invariants, Opening Batch, Reconciliation, Evidence & ACL Suite.
 *
 * Applies the full 155-migration repository stack on ephemeral PGlite and verifies:
 *   1. Atomic migration rollback on failure + LF/CRLF-deterministic SHA-256 checksum.
 *   2. Zero schema/FK/trigger/RLS/data diff on untouched domains (`teams`,
 *      `recruiter_team_memberships`, `direct_entry_team_leader_assignments`,
 *      `direct_entry_project_team_scopes`, `direct_entry_worker_documents`,
 *      `direct_entry_scope_grants`) + Direct Entry & Work Reports actor parity before/after
 *      VFIN-01 and before/after assigning/ending `ACCOUNTING` department membership.
 *   3. Fail-closed VFIN authority matrix: Full Admin, active `ACCOUNTING` member (via
 *      immutable `system_key = 'ACCOUNTING'`, resilient to display-name rename), BoD
 *      `vendor_finance_view @ all` (view-only), direct `vendor_finance_record @ all`,
 *      Catalog operator `catalog_master_manage @ all` (denied), Team Leader/PM/Staff (denied),
 *      retired `payment_view`/`payment_edit` (denied), `vendor_finance_view @ own` (denied),
 *      ended Accounting member (revoked, while preserving independent direct grant!), and
 *      deactivated Accounting department (denied).
 *   4. Opening balance wizard: preview/apply, zero-amount row skip, batch totals = sum of
 *      entries, single-row error rolls back entire batch, 1-opening-per-vendor, reject
 *      already-initialized vendor, idempotency replay & conflict.
 *   5. Normal ledger entries: all 6 normal types + server-derived sign, lossless `bigint`
 *      above `Number.MAX_SAFE_INTEGER`, `int8` overflow guard, keyset cursor pagination,
 *      company KPI summary, append-only immutability (`UPDATE`/`DELETE`/direct `INSERT` blocked).
 *   6. Reversal-once: exact opposite `balance_delta_minor`, rejects 2nd reversal and rejects
 *      reversing a `REVERSAL` entry.
 *   7. Vendor rename & inactive Vendor: canonical `direct_entry_update_vendor` preserves
 *      historical `vendor_display_name_snapshot` + mandatory Vietnamese internal disclaimer
 *      on existing vouchers; `direct_entry_set_vendor_active(..., false)` blocks new
 *      `DEBT_RECORDED`/`PAYROLL_RECORDED`/`ADVANCE_RECORDED` while permitting view,
 *      `PAYMENT_RECORDED`, `ADJUSTMENT_*`, `REVERSAL`, and reconciliation.
 *   8. Date-anchored reconciliation: computes `system_balance_minor` and `difference_minor`
 *      without mutating ledger; follow-up adjustment is an independent audited ledger entry.
 *   9. Private R2 evidence DB lifecycle: optional on money entries, failed reservation +
 *      cleanup leaves money entry untouched and permits retry, max 1 `READY` image per
 *      entry/reconciliation, XOR target enforcement.
 *  10. Forced RLS + zero direct table privileges for `PUBLIC`/`anon`/`authenticated`/`service_role`
 *      + `EXECUTE` granted strictly to `service_role` on the 15 allowlisted RPCs only.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import {
  computeAssignAccountingMemberFingerprint,
  computeEndAccountingMemberFingerprint,
} from "../src/lib/departments/department-contract.ts";
import {
  VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
  computeApplyOpeningBatchFingerprint,
  computeCreateReconciliationFingerprint,
  computeRecordEntryFingerprint,
  computeReserveEvidenceFingerprint,
  computeReverseEntryFingerprint,
} from "../src/lib/vendor-finance/vendor-finance-contract.ts";
import { createVendorFinanceRepository } from "../src/lib/vendor-finance/vendor-finance-repository.ts";
import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";
import {
  VFIN_01_BACKEND_MIGRATION_NAME,
  VFIN_01_BACKEND_RPC_SIGNATURES,
  migrationChecksum,
  migrationSqlForTransaction,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const TEAM_ALPHA = "99000000-0000-4000-8000-00000000000a";
const PROJECT_CODE = "vfin_01_proj_alpha";

const FULL_ADMIN = {
  auth: "19000000-0000-4000-8000-000000000001",
  app: "29000000-0000-4000-8000-000000000001",
  name: "Quản Trị Toàn Quyền",
};
const ACCOUNTING_USER = {
  auth: "19000000-0000-4000-8000-000000000002",
  app: "29000000-0000-4000-8000-000000000002",
  recruiter: "39000000-0000-4000-8000-000000000002",
  name: "Account Fallback",
  realName: "Trần Thị Kế Toán",
  code: "KT-102",
};
const BOD_VIEW_USER = {
  auth: "19000000-0000-4000-8000-000000000003",
  app: "29000000-0000-4000-8000-000000000003",
  name: "Ban Giám Đốc Xem Công Nợ",
};
const DIRECT_RECORD_USER = {
  auth: "19000000-0000-4000-8000-000000000004",
  app: "29000000-0000-4000-8000-000000000004",
  name: "Ngoại Lệ Direct Record",
};
const CATALOG_ONLY_USER = {
  auth: "19000000-0000-4000-8000-000000000005",
  app: "29000000-0000-4000-8000-000000000005",
  name: "Vận Hành Danh Mục",
};
const TEAM_LEADER = {
  auth: "19000000-0000-4000-8000-000000000006",
  app: "29000000-0000-4000-8000-000000000006",
  recruiter: "39000000-0000-4000-8000-000000000006",
  name: "Trưởng Nhóm Tuyển Dụng",
  code: "TL-106",
};
const PROJECT_MANAGER = {
  auth: "19000000-0000-4000-8000-000000000007",
  app: "29000000-0000-4000-8000-000000000007",
  recruiter: "39000000-0000-4000-8000-000000000007",
  name: "Quản Lý Dự Án",
  code: "PM-107",
};
const STAFF_MEMBER = {
  auth: "19000000-0000-4000-8000-000000000008",
  app: "29000000-0000-4000-8000-000000000008",
  recruiter: "39000000-0000-4000-8000-000000000008",
  name: "Nhân Viên Tuyển Dụng",
  code: "TD-108",
};
const RETIRED_PAYMENT_USER = {
  auth: "19000000-0000-4000-8000-000000000009",
  app: "29000000-0000-4000-8000-000000000009",
  name: "Legacy Payment Token User",
};
const WRONG_SCOPE_VFIN_USER = {
  auth: "19000000-0000-4000-8000-000000000010",
  app: "29000000-0000-4000-8000-000000000010",
  name: "VFIN View Without All Scope",
};
const DISABLED_ADMIN = {
  auth: "19000000-0000-4000-8000-000000000011",
  app: "29000000-0000-4000-8000-000000000011",
  name: "Disabled Admin",
};

let uuidCounter = 0;
function nextUuid() {
  uuidCounter += 1;
  return `79000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function createPreVfinDatabase() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = await loadMigrations();
  const targetIdx = migrations.findIndex((m) => m.name === VFIN_01_BACKEND_MIGRATION_NAME);
  assert.ok(targetIdx >= 0, "VFIN-01 migration must exist in supabase/migrations");
  for (const m of migrations.slice(0, targetIdx)) {
    await db.exec(m.sql);
  }
  return { db, targetMigration: migrations[targetIdx] };
}

const UNTOUCHED_TABLES = [
  "teams",
  "recruiter_team_memberships",
  "direct_entry_team_leader_assignments",
  "direct_entry_project_team_scopes",
  "direct_entry_document_versions",
  "direct_entry_document_objects",
  "direct_entry_scope_grants",
];

async function captureUntouchedSnapshot(db) {
  const { rows: columns } = await db.query(
    `select table_name, ordinal_position::int as pos, column_name, data_type, udt_name, is_nullable
       from information_schema.columns
      where table_schema = 'public' and table_name = any($1::text[])
      order by table_name, ordinal_position`,
    [UNTOUCHED_TABLES],
  );
  const { rows: constraints } = await db.query(
    `select rel.relname as table_name, con.conname, con.contype, pg_get_constraintdef(con.oid, true) as def
       from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       join pg_namespace n on n.oid = rel.relnamespace
      where n.nspname = 'public' and rel.relname = any($1::text[])
      order by rel.relname, con.conname`,
    [UNTOUCHED_TABLES],
  );
  const { rows: triggers } = await db.query(
    `select c.relname as table_name, t.tgname, pg_get_triggerdef(t.oid, true) as def
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal and c.relname = any($1::text[])
      order by c.relname, t.tgname`,
    [UNTOUCHED_TABLES],
  );
  const data = {};
  for (const tbl of UNTOUCHED_TABLES) {
    const { rows } = await db.query(
      `select to_jsonb(r) as row from public.${tbl} r order by to_jsonb(r)::text`,
    );
    data[tbl] = rows;
  }
  return { columns, constraints, triggers, data };
}

async function expectPgError(fn, expectedCode, expectedSubstring) {
  let caught = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `expected PostgreSQL error ${expectedCode} (${expectedSubstring})`);
  if (expectedCode) {
    assert.equal(caught.code, expectedCode, `unexpected SQLSTATE: ${caught.code} (${caught.message})`);
  }
  if (expectedSubstring) {
    assert.match(caught.message, new RegExp(expectedSubstring));
  }
}

test("(#1) VFIN-01 migration rolls back atomically on failure and produces LF/CRLF-identical SHA-256 checksum", async () => {
  const { db, targetMigration } = await createPreVfinDatabase();
  try {
    const checksum = migrationChecksum(targetMigration.sql);
    assert.match(checksum, /^[0-9a-f]{64}$/);
    assert.equal(
      migrationChecksum(targetMigration.sql.replace(/\n/g, "\r\n")),
      checksum,
      "checksum must be identical across LF and CRLF checkouts",
    );

    const failingBody = `${migrationSqlForTransaction(targetMigration.sql)}\nselect 1 / 0;\n`;
    await assert.rejects(
      async () => {
        await db.exec("begin;");
        try {
          await db.exec(failingBody);
          await db.exec("commit;");
        } catch (err) {
          await db.exec("rollback;");
          throw err;
        }
      },
      (err) => err.code === "22012",
    );

    const { rows: leakedTables } = await db.query(
      `select tablename from pg_tables
        where schemaname = 'public' and tablename like 'vendor_finance_%'`,
    );
    assert.equal(leakedTables.length, 0, "failed transaction must leave zero vendor_finance_* tables");

    const { rows: leakedProcs } = await db.query(
      `select p.proname from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'vendor_finance%'`,
    );
    assert.equal(leakedProcs.length, 0, "failed transaction must leave zero vendor_finance* routines");
  } finally {
    await db.close();
  }
});

test("(#2) Full VFIN-01 acceptance: domain isolation, Direct Entry & Work Reports parity, authority matrix, opening batch, ledger sign/overflow/immutability, reversal-once, inactive vendor, reconciliation, R2 evidence DB lifecycle & ACLs", async () => {
  const { db, targetMigration } = await createPreVfinDatabase();
  try {
    // -------------------------------------------------------------------------
    // Seed baseline actors, Team, Team Leader, Project-Team scope & Work Reports
    // BEFORE applying VFIN-01 migration!
    // -------------------------------------------------------------------------
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'TD_ALPHA', 'Nhóm Tuyển Dụng Alpha', true),
              ('99000000-0000-4000-8000-00000000000f'::uuid, '__system_vendor__', 'System Vendor Internal', true)
       on conflict (code) do nothing`,
      [TEAM_ALPHA],
    );

    for (const actor of [
      FULL_ADMIN,
      ACCOUNTING_USER,
      BOD_VIEW_USER,
      DIRECT_RECORD_USER,
      CATALOG_ONLY_USER,
      TEAM_LEADER,
      PROJECT_MANAGER,
      STAFF_MEMBER,
      RETIRED_PAYMENT_USER,
      WRONG_SCOPE_VFIN_USER,
    ]) {
      await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
      await db.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
         values ($1::uuid, $2::uuid, true, $3)`,
        [actor.app, actor.auth, actor.name],
      );
    }
    await db.query("insert into auth.users (id) values ($1::uuid)", [DISABLED_ADMIN.auth]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
       values ($1::uuid, $2::uuid, false, $3)`,
      [DISABLED_ADMIN.app, DISABLED_ADMIN.auth, DISABLED_ADMIN.name],
    );

    // Canonical Full Admin grants
    for (const target of [FULL_ADMIN.app, DISABLED_ADMIN.app]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, 'entry_admin', '2026-01-01', true),
                ($1::uuid, 'recruiter_master_manage', '2026-01-01', true),
                ($1::uuid, 'team_master_manage', '2026-01-01', true),
                ($1::uuid, 'catalog_master_manage', '2026-01-01', true),
                ($1::uuid, 'report_form_manage', '2026-01-01', true),
                ($1::uuid, 'report_assign', '2026-01-01', true),
                ($1::uuid, 'report_analytics_view', '2026-01-01', true),
                ($1::uuid, 'report_view', '2026-01-01', true)`,
        [target],
      );
      await db.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
         values ($1::uuid, 'all', '2026-01-01', true)`,
        [target],
      );
    }

    // Catalog operator only (`catalog_master_manage @ all`)
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'catalog_master_manage', '2026-01-01', true)`,
      [CATALOG_ONLY_USER.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true)`,
      [CATALOG_ONLY_USER.app],
    );

    // Retired payment tokens (`payment_view` / `payment_edit @ all`)
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'payment_view', '2026-01-01', true),
              ($1::uuid, 'payment_edit', '2026-01-01', true)`,
      [RETIRED_PAYMENT_USER.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true)`,
      [RETIRED_PAYMENT_USER.app],
    );

    // PM & Staff baseline grants
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_create', '2026-01-01', true),
              ($2::uuid, 'entry_own', '2026-01-01', true)`,
      [PROJECT_MANAGER.app, STAFF_MEMBER.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'own', '2026-01-01', true),
              ($2::uuid, 'own', '2026-01-01', true)`,
      [PROJECT_MANAGER.app, STAFF_MEMBER.app],
    );

    // Recruiters + Team memberships + links
    for (const [person, displayName] of [
      [ACCOUNTING_USER, ACCOUNTING_USER.realName],
      [TEAM_LEADER, TEAM_LEADER.name],
      [PROJECT_MANAGER, PROJECT_MANAGER.name],
      [STAFF_MEMBER, STAFF_MEMBER.name],
    ]) {
      await db.query(
        `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
         values ($1::uuid, $2, $3, 'STAFF', true)`,
        [person.recruiter, displayName, person.code],
      );
      await db.query(
        `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
         values ($1::uuid, 'hrp', '2026-01-01', true)`,
        [person.recruiter],
      );
      if (person !== ACCOUNTING_USER) {
        await db.query(
          `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
           values ($1::uuid, $2::uuid, '2026-01-01', true)`,
          [person.recruiter, TEAM_ALPHA],
        );
      }
      await db.query(
        `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
         values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
        [person.app, person.recruiter],
      );
    }

    await db.query(
      `select public.direct_entry_designate_team_leader(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-01-15'::date, 1, 'Designate TL', 'vfin_tl_1'
       )`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, TEAM_ALPHA, TEAM_LEADER.app],
    );
    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'Dự Án Kiểm Chứng VFIN-01', true, 1)`,
      [PROJECT_CODE],
    );
    await db.query(
      `select public.direct_entry_grant_project_team_scope(
         $1::uuid, $2::uuid, $3, $4::uuid, 0, '2026-01-15'::date, 'Grant Scope', 'vfin_pts_1'
       )`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, PROJECT_CODE, TEAM_ALPHA],
    );

    // Work Reports baseline fixture
    const wrSchema = RECRUITMENT_DAILY_TEMPLATE_SCHEMA;
    const wrMetrics = buildWorkReportMetricContract(wrSchema);
    const { rows: tplRows } = await db.query(
      `select public.work_report_create_template(
         $1::uuid, $2::uuid, 'VFIN_WR_PARITY', 'Báo cáo ngày', null, 'DAILY',
         $3::jsonb, $4::jsonb, 'vfin_wr_tpl_1'
       ) as result`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, JSON.stringify(wrSchema), JSON.stringify(wrMetrics)],
    );
    const wrTemplateId = tplRows[0].result.template_id;
    const wrVersionId = tplRows[0].result.draft_version_id;
    await db.query(
      `select public.work_report_publish_template(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, 'vfin_wr_pub_1'
       )`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, wrTemplateId, wrVersionId, tplRows[0].result.version],
    );

    // Create canonical Vendors via `direct_entry_create_vendor` BEFORE VFIN-01
    for (const [vid, vname] of [
      ["VND_ALPHA", "Công ty Cung Ứng Alpha"],
      ["VND_BETA", "Công ty Nhân Lực Beta"],
      ["VND_GAMMA", "Công ty Dịch Vụ Gamma"],
      ["VND_ZERO", "Công ty Đầu Kỳ Không Dư"],
      ["VND_OVERFLOW", "Công ty Kiểm Tra Tràn Số"],
    ]) {
      await db.query(
        `select public.direct_entry_create_vendor(
           $1::uuid, $2::uuid, 0, $3, $4, '2026-01-01'::date, 'Seed canonical vendor', $5
         )`,
        [FULL_ADMIN.auth, FULL_ADMIN.app, vid, vname, nextUuid()],
      );
    }

    const parityActors = {
      fullAdmin: FULL_ADMIN,
      accountingUser: ACCOUNTING_USER,
      catalogUser: CATALOG_ONLY_USER,
      teamLeader: TEAM_LEADER,
      projectManager: PROJECT_MANAGER,
      staff: STAFF_MEMBER,
      retiredPayment: RETIRED_PAYMENT_USER,
    };

    const captureContexts = async () => {
      const out = {};
      for (const [k, a] of Object.entries(parityActors)) {
        const { rows } = await db.query(
          "select public.direct_entry_resolve_actor_context($1::uuid) as ctx",
          [a.auth],
        );
        out[k] = rows[0].ctx;
      }
      return out;
    };

    const captureWrTemplatesOutcome = async () => {
      const out = {};
      for (const [k, a] of Object.entries(parityActors)) {
        try {
          const { rows } = await db.query(
            "select public.work_report_list_templates($1::uuid, $2::uuid) as r",
            [a.auth, a.app],
          );
          out[k] = { ok: true, count: rows[0].r.templates.length };
        } catch (err) {
          out[k] = { ok: false, code: err.code };
        }
      }
      return out;
    };

    const preUntouched = await captureUntouchedSnapshot(db);
    const preActorContexts = await captureContexts();
    const preWrOutcome = await captureWrTemplatesOutcome();

    // -------------------------------------------------------------------------
    // Apply VFIN-01 migration (#155)
    // -------------------------------------------------------------------------
    await db.exec(targetMigration.sql);

    const postUntouched = await captureUntouchedSnapshot(db);
    assert.deepEqual(
      postUntouched,
      preUntouched,
      "VFIN-01 must not alter Team, Team membership, Team Leader, Project-Team scope, Worker document, or Scope grant schemas/FKs/triggers/data",
    );

    const postActorContexts = await captureContexts();
    for (const k of Object.keys(parityActors)) {
      assert.deepEqual(
        postActorContexts[k],
        preActorContexts[k],
        `Direct Entry actor context payload for ${k} must remain 100% identical`,
      );
    }
    assert.deepEqual(await captureWrTemplatesOutcome(), preWrOutcome);

    // -------------------------------------------------------------------------
    // Grant direct VFIN capabilities for BoD view-only, Direct Record, and Wrong-Scope test actors
    // -------------------------------------------------------------------------
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'vendor_finance_view', '2026-01-01', true),
              ($2::uuid, 'vendor_finance_record', '2026-01-01', true),
              ($3::uuid, 'vendor_finance_view', '2026-01-01', true)`,
      [BOD_VIEW_USER.app, DIRECT_RECORD_USER.app, WRONG_SCOPE_VFIN_USER.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true),
              ($2::uuid, 'all', '2026-01-01', true),
              ($3::uuid, 'own', '2026-01-01', true)`,
      [BOD_VIEW_USER.app, DIRECT_RECORD_USER.app, WRONG_SCOPE_VFIN_USER.app],
    );

    // Assign ACCOUNTING_USER into immutable `ACCOUNTING` department via ORG-SHELL-01 RPC
    const assignIdem = nextUuid();
    const {
      rows: [assignRes],
    } = await db.query(
      `select public.org_department_assign_accounting_member(
         $1::uuid, $2::uuid, $3::uuid, 0, null, 'Bổ nhiệm Kế toán công nợ', $4::uuid, $5
       ) as result`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        ACCOUNTING_USER.app,
        assignIdem,
        computeAssignAccountingMemberFingerprint({
          actor_app_user_id: FULL_ADMIN.app,
          account_ref: ACCOUNTING_USER.app,
          expected_pair_version: 0,
          effective_from: null,
          reason: "Bổ nhiệm Kế toán công nợ",
        }),
      ],
    );
    const accountingMembershipId = assignRes.result.membership.membership_id;

    // Verify Accounting membership does NOT mutate `direct_entry_resolve_actor_context` or Work Reports!
    const afterAssignContexts = await captureContexts();
    assert.deepEqual(afterAssignContexts.accountingUser, postActorContexts.accountingUser);
    assert.deepEqual(await captureWrTemplatesOutcome(), preWrOutcome);

    // -------------------------------------------------------------------------
    // Authority Matrix Checks (§7.3 & §12.1)
    // -------------------------------------------------------------------------
    const getAccess = async (actor) => {
      const { rows } = await db.query(
        "select public.vendor_finance_get_actor_access($1::uuid, $2::uuid) as access",
        [actor.auth, actor.app],
      );
      return rows[0].access;
    };

    assert.deepEqual(
      { ...(await getAccess(FULL_ADMIN)), authorization_date: "X" },
      { authorization_date: "X", can_view: true, can_record: true, authority_source: "full_admin" },
    );
    assert.deepEqual(
      { ...(await getAccess(ACCOUNTING_USER)), authorization_date: "X" },
      { authorization_date: "X", can_view: true, can_record: true, authority_source: "accounting_department" },
    );
    assert.deepEqual(
      { ...(await getAccess(DIRECT_RECORD_USER)), authorization_date: "X" },
      { authorization_date: "X", can_view: true, can_record: true, authority_source: "direct_grant_record" },
    );
    assert.deepEqual(
      { ...(await getAccess(BOD_VIEW_USER)), authorization_date: "X" },
      { authorization_date: "X", can_view: true, can_record: false, authority_source: "direct_grant_view" },
    );

    for (const deniedActor of [
      CATALOG_ONLY_USER,
      TEAM_LEADER,
      PROJECT_MANAGER,
      STAFF_MEMBER,
      RETIRED_PAYMENT_USER,
      WRONG_SCOPE_VFIN_USER,
    ]) {
      assert.deepEqual(
        { ...(await getAccess(deniedActor)), authorization_date: "X" },
        { authorization_date: "X", can_view: false, can_record: false, authority_source: "none" },
      );
      await expectPgError(
        () =>
          db.query("select public.vendor_finance_list_vendors($1::uuid, $2::uuid)", [
            deniedActor.auth,
            deniedActor.app,
          ]),
        "42501",
        "VENDOR_FINANCE_ACCESS_DENIED",
      );
    }

    // Disabled Full Admin fails actor mapping
    await expectPgError(
      () =>
        db.query("select public.vendor_finance_list_vendors($1::uuid, $2::uuid)", [
          DISABLED_ADMIN.auth,
          DISABLED_ADMIN.app,
        ]),
      "42501",
      "actor mapping denied",
    );

    // Renaming `organization_departments.name` must NOT break `system_key = 'ACCOUNTING'` policy!
    await db.query(
      "update public.organization_departments set name = 'Khối Tài Chính Đổi Tên' where system_key = 'ACCOUNTING'",
    );
    assert.equal((await getAccess(ACCOUNTING_USER)).can_record, true);

    // Deactivating `ACCOUNTING` department (`is_active = false`) revokes department-derived access immediately
    await db.query(
      "update public.organization_departments set is_active = false where system_key = 'ACCOUNTING'",
    );
    assert.equal((await getAccess(ACCOUNTING_USER)).can_view, false);
    await db.query(
      "update public.organization_departments set is_active = true where system_key = 'ACCOUNTING'",
    );
    assert.equal((await getAccess(ACCOUNTING_USER)).can_record, true);

    // BoD view-only can read, but fails closed (`42501 VENDOR_FINANCE_RECORD_DENIED`) on mutations
    await expectPgError(
      () =>
        db.query(
          `select public.vendor_finance_record_entry(
             $1::uuid, $2::uuid, 'VND_ALPHA', 'DEBT_RECORDED', '1000', '2026-10-01'::date,
             'Unauthorized BoD write', $3::uuid, $4
           )`,
          [BOD_VIEW_USER.auth, BOD_VIEW_USER.app, nextUuid(), "a".repeat(64)],
        ),
      "42501",
      "VENDOR_FINANCE_RECORD_DENIED",
    );

    // Assigning + ending Accounting membership on BoD user preserves BoD's independent direct grant!
    const bodAssignIdem = nextUuid();
    const {
      rows: [bodAssignRes],
    } = await db.query(
      `select public.org_department_assign_accounting_member(
         $1::uuid, $2::uuid, $3::uuid, 0, null, 'Tạm gán BoD vào Kế toán', $4::uuid, $5
       ) as result`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        BOD_VIEW_USER.app,
        bodAssignIdem,
        computeAssignAccountingMemberFingerprint({
          actor_app_user_id: FULL_ADMIN.app,
          account_ref: BOD_VIEW_USER.app,
          expected_pair_version: 0,
          effective_from: null,
          reason: "Tạm gán BoD vào Kế toán",
        }),
      ],
    );
    assert.equal((await getAccess(BOD_VIEW_USER)).can_record, true);

    const bodEndIdem = nextUuid();
    await db.query(
      `select public.org_department_end_accounting_member(
         $1::uuid, $2::uuid, $3::uuid, 1, null, 'Kết thúc tạm gán', $4::uuid, $5
       )`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        bodAssignRes.result.membership.membership_id,
        bodEndIdem,
        computeEndAccountingMemberFingerprint({
          actor_app_user_id: FULL_ADMIN.app,
          membership_id: bodAssignRes.result.membership.membership_id,
          expected_pair_version: 1,
          effective_to: null,
          reason: "Kết thúc tạm gán",
        }),
      ],
    );
    const bodAfterLeave = await getAccess(BOD_VIEW_USER);
    assert.equal(bodAfterLeave.can_view, true, "direct vendor_finance_view grant must remain intact after leaving Accounting");
    assert.equal(bodAfterLeave.can_record, false);
    assert.equal(bodAfterLeave.authority_source, "direct_grant_view");

    // -------------------------------------------------------------------------
    // Opening Balance Batch (§4.2 & §12.3)
    // -------------------------------------------------------------------------
    // Deactivate VND_BETA before opening batch to prove inactive Vendor CAN receive opening balance!
    await db.query(
      `select public.direct_entry_set_vendor_active(
         $1::uuid, $2::uuid, 'VND_BETA', false, 1, 'Ngừng hợp tác mới nhưng còn dư ứng đầu kỳ', $3
       )`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, nextUuid()],
    );

    // Single invalid row in batch rolls back the entire batch atomically
    await expectPgError(
      () =>
        db.query(
          `select public.vendor_finance_apply_opening_batch(
             $1::uuid, $2::uuid, '2026-10-01'::date, $3::jsonb, 'Lỗi 1 dòng', $4::uuid, $5
           )`,
          [
            ACCOUNTING_USER.auth,
            ACCOUNTING_USER.app,
            JSON.stringify([
              { vendor_id: "VND_ALPHA", entry_type: "OPENING_PAYABLE", amount_minor: "50000000" },
              { vendor_id: "VND_DOES_NOT_EXIST", entry_type: "OPENING_ADVANCE", amount_minor: "10000000" },
            ]),
            nextUuid(),
            "b".repeat(64),
          ],
        ),
      "P0002",
      "VENDOR_FINANCE_VENDOR_NOT_FOUND",
    );
    const { rows: afterRollbackCount } = await db.query(
      "select count(*)::int as cnt from public.vendor_finance_entries",
    );
    assert.equal(afterRollbackCount[0].cnt, 0, "atomic opening batch error must leave 0 entries");

    const openingItems = [
      { vendor_id: "VND_ALPHA", entry_type: "OPENING_PAYABLE", amount_minor: "50000000" },
      { vendor_id: "VND_BETA", entry_type: "OPENING_ADVANCE", amount_minor: "12000000" },
      { vendor_id: "VND_ZERO", entry_type: "OPENING_PAYABLE", amount_minor: "0" },
    ];

    const {
      rows: [previewRow],
    } = await db.query(
      `select public.vendor_finance_preview_opening_batch(
         $1::uuid, $2::uuid, '2026-10-01'::date, $3::jsonb
       ) as preview`,
      [ACCOUNTING_USER.auth, ACCOUNTING_USER.app, JSON.stringify(openingItems)],
    );
    assert.equal(previewRow.preview.vendor_count, 2);
    assert.equal(previewRow.preview.skipped_zero_count, 1);
    assert.equal(previewRow.preview.total_payable_minor, "50000000");
    assert.equal(previewRow.preview.total_advance_minor, "12000000");
    assert.equal(previewRow.preview.net_balance_minor, "38000000");

    const openIdem = nextUuid();
    const openFp = computeApplyOpeningBatchFingerprint({
      cutoff_date: "2026-10-01",
      items: openingItems,
      reason: "Chốt công nợ đầu kỳ go-live VFIN-01",
    });

    const {
      rows: [appliedOpening],
    } = await db.query(
      `select public.vendor_finance_apply_opening_batch(
         $1::uuid, $2::uuid, '2026-10-01'::date, $3::jsonb,
         'Chốt công nợ đầu kỳ go-live VFIN-01', $4::uuid, $5
       ) as result`,
      [
        ACCOUNTING_USER.auth,
        ACCOUNTING_USER.app,
        JSON.stringify(openingItems),
        openIdem,
        openFp,
      ],
    );
    assert.equal(appliedOpening.result.replayed, false);
    assert.equal(appliedOpening.result.batch.vendor_count, 2);
    assert.equal(appliedOpening.result.batch.skipped_zero_count, 1);
    assert.equal(appliedOpening.result.entries.length, 2);
    assert.equal(appliedOpening.result.entries[0].balance_after_minor, "50000000");
    assert.equal(appliedOpening.result.entries[1].balance_after_minor, "-12000000");
    assert.equal(appliedOpening.result.entries[0].created_by_display_name, "Trần Thị Kế Toán");

    // Idempotent replay returns identical batch + entries with replayed = true
    const {
      rows: [replayedOpening],
    } = await db.query(
      `select public.vendor_finance_apply_opening_batch(
         $1::uuid, $2::uuid, '2026-10-01'::date, $3::jsonb,
         'Chốt công nợ đầu kỳ go-live VFIN-01', $4::uuid, $5
       ) as result`,
      [
        ACCOUNTING_USER.auth,
        ACCOUNTING_USER.app,
        JSON.stringify(openingItems),
        openIdem,
        openFp,
      ],
    );
    assert.equal(replayedOpening.result.replayed, true);
    assert.equal(replayedOpening.result.batch.batch_id, appliedOpening.result.batch.batch_id);

    // Same idempotency_key with different fingerprint -> 23505 VENDOR_FINANCE_IDEMPOTENCY_CONFLICT
    await expectPgError(
      () =>
        db.query(
          `select public.vendor_finance_apply_opening_batch(
             $1::uuid, $2::uuid, '2026-10-01'::date, $3::jsonb,
             'Different reason', $4::uuid, $5
           )`,
          [ACCOUNTING_USER.auth, ACCOUNTING_USER.app, JSON.stringify(openingItems), openIdem, "c".repeat(64)],
        ),
      "23505",
      "VENDOR_FINANCE_IDEMPOTENCY_CONFLICT",
    );

    // Re-initializing VND_ALPHA fails with VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED
    await expectPgError(
      () =>
        db.query(
          `select public.vendor_finance_apply_opening_batch(
             $1::uuid, $2::uuid, '2026-10-01'::date, $3::jsonb,
             'Try duplicate opening', $4::uuid, $5
           )`,
          [
            ACCOUNTING_USER.auth,
            ACCOUNTING_USER.app,
            JSON.stringify([{ vendor_id: "VND_ALPHA", entry_type: "OPENING_PAYABLE", amount_minor: "1000" }]),
            nextUuid(),
            "d".repeat(64),
          ],
        ),
      "23505",
      "VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED",
    );

    // -------------------------------------------------------------------------
    // Normal Entry Sign Matrix, Running Chain & Keyset Pagination (§4.1 & §12.2)
    // -------------------------------------------------------------------------
    const recordNormal = async (actor, vendorId, entryType, amountMinor, effectiveDate, reason) => {
      const idem = nextUuid();
      const fp = computeRecordEntryFingerprint({
        vendor_id: vendorId,
        entry_type: entryType,
        amount_minor: amountMinor,
        effective_date: effectiveDate,
        reason,
      });
      const { rows } = await db.query(
        `select public.vendor_finance_record_entry(
           $1::uuid, $2::uuid, $3, $4, $5, $6::date, $7, $8::uuid, $9
         ) as result`,
        [actor.auth, actor.app, vendorId, entryType, amountMinor, effectiveDate, reason, idem, fp],
      );
      return rows[0].result.entry;
    };

    // VND_ALPHA starts at +50,000,000 from opening
    const eDebt = await recordNormal(ACCOUNTING_USER, "VND_ALPHA", "DEBT_RECORDED", "10000000", "2026-10-05", "Phí tuyển dụng");
    assert.equal(eDebt.balance_delta_minor, "10000000");
    assert.equal(eDebt.balance_after_minor, "60000000");

    const ePayroll = await recordNormal(ACCOUNTING_USER, "VND_ALPHA", "PAYROLL_RECORDED", "40000000", "2026-10-10", "Bảng lương T10");
    assert.equal(ePayroll.balance_delta_minor, "40000000");
    assert.equal(ePayroll.balance_after_minor, "100000000");

    const ePayment = await recordNormal(ACCOUNTING_USER, "VND_ALPHA", "PAYMENT_RECORDED", "30000000", "2026-10-12", "UNC đợt 1");
    assert.equal(ePayment.balance_delta_minor, "-30000000");
    assert.equal(ePayment.balance_after_minor, "70000000");

    const eAdvance = await recordNormal(ACCOUNTING_USER, "VND_ALPHA", "ADVANCE_RECORDED", "5000000", "2026-10-14", "Tạm ứng");
    assert.equal(eAdvance.balance_delta_minor, "-5000000");
    assert.equal(eAdvance.balance_after_minor, "65000000");

    const eAdjInc = await recordNormal(ACCOUNTING_USER, "VND_ALPHA", "ADJUSTMENT_INCREASE", "2000000", "2026-10-15", "Bổ sung phụ cấp");
    assert.equal(eAdjInc.balance_delta_minor, "2000000");
    assert.equal(eAdjInc.balance_after_minor, "67000000");

    const eAdjDec = await recordNormal(ACCOUNTING_USER, "VND_ALPHA", "ADJUSTMENT_DECREASE", "7000000", "2026-10-16", "Giảm trừ phạt SLA");
    assert.equal(eAdjDec.balance_delta_minor, "-7000000");
    assert.equal(eAdjDec.balance_after_minor, "60000000");
    assert.equal(eAdjDec.vendor_sequence, 7);

    // Keyset pagination on VND_ALPHA (7 entries total, page_size = 3)
    const { rows: p1 } = await db.query(
      "select public.vendor_finance_list_vendor_entries($1::uuid, $2::uuid, 'VND_ALPHA', null, null, 3) as page",
      [BOD_VIEW_USER.auth, BOD_VIEW_USER.app],
    );
    assert.equal(p1[0].page.has_more, true);
    assert.deepEqual(
      p1[0].page.entries.map((e) => e.vendor_sequence),
      [7, 6, 5],
    );
    const { rows: p2 } = await db.query(
      "select public.vendor_finance_list_vendor_entries($1::uuid, $2::uuid, 'VND_ALPHA', $3::bigint, null, 3) as page",
      [BOD_VIEW_USER.auth, BOD_VIEW_USER.app, p1[0].page.next_before_sequence],
    );
    assert.deepEqual(
      p2[0].page.entries.map((e) => e.vendor_sequence),
      [4, 3, 2],
    );
    const { rows: p3 } = await db.query(
      "select public.vendor_finance_list_vendor_entries($1::uuid, $2::uuid, 'VND_ALPHA', $3::bigint, null, 3) as page",
      [BOD_VIEW_USER.auth, BOD_VIEW_USER.app, p2[0].page.next_before_sequence],
    );
    assert.equal(p3[0].page.has_more, false);
    assert.deepEqual(
      p3[0].page.entries.map((e) => e.vendor_sequence),
      [1],
    );

    // Lossless `bigint` > Number.MAX_SAFE_INTEGER + `int8` overflow protection
    const eHuge = await recordNormal(
      ACCOUNTING_USER,
      "VND_OVERFLOW",
      "DEBT_RECORDED",
      "9223372036854775800",
      "2026-10-16",
      "Kiểm tra biên trên int8",
    );
    assert.equal(eHuge.balance_after_minor, "9223372036854775800");
    await expectPgError(
      () =>
        recordNormal(
          ACCOUNTING_USER,
          "VND_OVERFLOW",
          "DEBT_RECORDED",
          "100",
          "2026-10-16",
          "Vượt ngưỡng int8",
        ),
      "22003",
      "VENDOR_FINANCE_AMOUNT_OVERFLOW",
    );

    // VND_OVERFLOW already has a normal ledger entry -> opening balance must be rejected!
    await expectPgError(
      () =>
        db.query(
          `select public.vendor_finance_preview_opening_batch(
             $1::uuid, $2::uuid, '2026-10-01'::date,
             '[{"vendor_id":"VND_OVERFLOW","entry_type":"OPENING_PAYABLE","amount_minor":"100"}]'::jsonb
           )`,
          [ACCOUNTING_USER.auth, ACCOUNTING_USER.app],
        ),
      "23505",
      "VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED",
    );

    // -------------------------------------------------------------------------
    // Append-Only Immutability & Direct-Insert Blocking (§4.3 & §12.4)
    // -------------------------------------------------------------------------
    await expectPgError(
      () => db.query("update public.vendor_finance_entries set reason = 'tampered'"),
      "55000",
      "VENDOR_FINANCE_IMMUTABLE",
    );
    await expectPgError(
      () => db.query("delete from public.vendor_finance_entries"),
      "55000",
      "VENDOR_FINANCE_IMMUTABLE",
    );
    await expectPgError(
      () => db.query("delete from public.vendor_finance_audit_events"),
      "55000",
      "VENDOR_FINANCE_IMMUTABLE",
    );
    await expectPgError(
      () =>
        db.query(
          `insert into public.vendor_finance_entries (
             vendor_id, vendor_sequence, entry_type, amount_minor, balance_delta_minor,
             balance_before_minor, balance_after_minor, effective_date, reason, document_no,
             vendor_display_name_snapshot, created_by_user_id, created_by_display_name_snapshot,
             idempotency_key, request_fingerprint
           ) values (
             'VND_GAMMA', 1, 'DEBT_RECORDED', 100, 100, 0, 100, '2026-10-16', 'bypass',
             'VFIN-2026-999999', 'Bypass', $1::uuid, 'Bypass', $2::uuid, $3
           )`,
          [FULL_ADMIN.app, nextUuid(), "e".repeat(64)],
        ),
      "42501",
      "VENDOR_FINANCE_DIRECT_WRITE_FORBIDDEN",
    );

    // -------------------------------------------------------------------------
    // Reversal-Once & Reject Reversing a Reversal (§4.3 & §12.4)
    // -------------------------------------------------------------------------
    const revIdem = nextUuid();
    const revFp = computeReverseEntryFingerprint({
      entry_id: eAdvance.entry_id,
      effective_date: "2026-10-17",
      reason: "Hoàn tác khoản tạm ứng nhập nhầm",
    });
    const {
      rows: [revRes],
    } = await db.query(
      `select public.vendor_finance_reverse_entry(
         $1::uuid, $2::uuid, $3::uuid, '2026-10-17'::date,
         'Hoàn tác khoản tạm ứng nhập nhầm', $4::uuid, $5
       ) as result`,
      [ACCOUNTING_USER.auth, ACCOUNTING_USER.app, eAdvance.entry_id, revIdem, revFp],
    );
    // eAdvance had delta -5,000,000; reversal must have delta +5,000,000 (60M -> 65M)
    assert.equal(revRes.result.reversal_entry.entry_type, "REVERSAL");
    assert.equal(revRes.result.reversal_entry.balance_delta_minor, "5000000");
    assert.equal(revRes.result.reversal_entry.balance_after_minor, "65000000");
    assert.equal(revRes.result.reversal_entry.can_reverse, false);
    assert.equal(revRes.result.reversed_entry.can_reverse, false);
    assert.equal(
      revRes.result.reversed_entry.reversed_by_entry_id,
      revRes.result.reversal_entry.entry_id,
    );

    // Reversing the same entry a second time fails (`23505`)
    await expectPgError(
      () =>
        db.query(
          `select public.vendor_finance_reverse_entry(
             $1::uuid, $2::uuid, $3::uuid, '2026-10-17'::date,
             'Second reversal attempt', $4::uuid, $5
           )`,
          [ACCOUNTING_USER.auth, ACCOUNTING_USER.app, eAdvance.entry_id, nextUuid(), "f".repeat(64)],
        ),
      "23505",
      "VENDOR_FINANCE_ENTRY_ALREADY_REVERSED",
    );

    // Reversing the reversal entry itself fails (`23514`)
    await expectPgError(
      () =>
        db.query(
          `select public.vendor_finance_reverse_entry(
             $1::uuid, $2::uuid, $3::uuid, '2026-10-17'::date,
             'Reverse the reversal', $4::uuid, $5
           )`,
          [
            ACCOUNTING_USER.auth,
            ACCOUNTING_USER.app,
            revRes.result.reversal_entry.entry_id,
            nextUuid(),
            "1".repeat(64),
          ],
        ),
      "23514",
      "VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL",
    );

    // -------------------------------------------------------------------------
    // Vendor Rename Snapshot Preservation & Inactive Vendor Settlement (§3.3, §6, §12.4, §12.5)
    // -------------------------------------------------------------------------
    await db.query(
      `select public.direct_entry_update_vendor(
         $1::uuid, $2::uuid, 'VND_ALPHA', 1, 'Tập Đoàn Alpha Mới (Đã Đổi Tên)',
         'Đổi tên pháp nhân', $3
       )`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, nextUuid()],
    );

    const { rows: currentVendorDetail } = await db.query(
      "select public.vendor_finance_get_vendor($1::uuid, $2::uuid, 'VND_ALPHA') as detail",
      [BOD_VIEW_USER.auth, BOD_VIEW_USER.app],
    );
    assert.equal(
      currentVendorDetail[0].detail.vendor.display_name,
      "Tập Đoàn Alpha Mới (Đã Đổi Tên)",
    );

    const { rows: historicalVoucher } = await db.query(
      "select public.vendor_finance_get_entry($1::uuid, $2::uuid, $3::uuid) as voucher",
      [BOD_VIEW_USER.auth, BOD_VIEW_USER.app, ePayroll.entry_id],
    );
    assert.equal(
      historicalVoucher[0].voucher.entry.vendor_display_name_snapshot,
      "Công ty Cung Ứng Alpha",
      "reprinting historical voucher after Vendor rename must preserve original snapshot name",
    );
    assert.equal(
      historicalVoucher[0].voucher.entry.internal_disclaimer,
      VENDOR_FINANCE_INTERNAL_DISCLAIMER_VI,
    );

    // VND_BETA is inactive (`active = false`, balance = -12,000,000):
    // New operational debt/payroll/advance must be rejected, while adjustment/payment/reconciliation succeed!
    for (const forbiddenInactiveType of ["DEBT_RECORDED", "PAYROLL_RECORDED", "ADVANCE_RECORDED"]) {
      await expectPgError(
        () =>
          recordNormal(
            ACCOUNTING_USER,
            "VND_BETA",
            forbiddenInactiveType,
            "1000000",
            "2026-10-18",
            "Không được ghi nợ/lương/ứng mới cho NCC ngừng hợp tác",
          ),
        "23514",
        "VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN",
      );
    }
    const { rows: inactiveDetail } = await db.query(
      "select public.vendor_finance_get_vendor($1::uuid, $2::uuid, 'VND_BETA') as detail",
      [ACCOUNTING_USER.auth, ACCOUNTING_USER.app],
    );
    assert.deepEqual(inactiveDetail[0].detail.allowed_actions.allowed_entry_types, [
      "PAYMENT_RECORDED",
      "ADJUSTMENT_INCREASE",
      "ADJUSTMENT_DECREASE",
    ]);
    const eBetaSettle = await recordNormal(
      ACCOUNTING_USER,
      "VND_BETA",
      "ADJUSTMENT_INCREASE",
      "12000000",
      "2026-10-18",
      "Cấn trừ hoàn ứng cuối kỳ khi thanh lý hợp đồng",
    );
    assert.equal(eBetaSettle.balance_after_minor, "0");

    // -------------------------------------------------------------------------
    // Reconciliation Never Mutates Ledger (§5 & §12.4)
    // -------------------------------------------------------------------------
    const { rows: preRecLedgerCount } = await db.query(
      "select count(*)::int as cnt from public.vendor_finance_entries where vendor_id = 'VND_ALPHA'",
    );
    const recIdem = nextUuid();
    const recFp = computeCreateReconciliationFingerprint({
      vendor_id: "VND_ALPHA",
      as_of_date: "2026-10-20",
      confirmed_balance_minor: "64500000",
      reason: "Đối soát biên bản tháng 10 với NCC Alpha",
    });
    const {
      rows: [recCreated],
    } = await db.query(
      `select public.vendor_finance_create_reconciliation(
         $1::uuid, $2::uuid, 'VND_ALPHA', '2026-10-20'::date, '64500000',
         'Đối soát biên bản tháng 10 với NCC Alpha', $3::uuid, $4
       ) as result`,
      [ACCOUNTING_USER.auth, ACCOUNTING_USER.app, recIdem, recFp],
    );
    assert.equal(recCreated.result.reconciliation.system_balance_minor, "65000000");
    assert.equal(recCreated.result.reconciliation.confirmed_balance_minor, "64500000");
    assert.equal(recCreated.result.reconciliation.difference_minor, "-500000");

    const { rows: postRecLedgerCount } = await db.query(
      "select count(*)::int as cnt from public.vendor_finance_entries where vendor_id = 'VND_ALPHA'",
    );
    assert.equal(
      postRecLedgerCount[0].cnt,
      preRecLedgerCount[0].cnt,
      "reconciliation must never create or mutate ledger entries",
    );

    // Follow-up manual adjustment is an explicit audited ledger entry
    const ePostRecAdj = await recordNormal(
      ACCOUNTING_USER,
      "VND_ALPHA",
      "ADJUSTMENT_DECREASE",
      "500000",
      "2026-10-21",
      "Điều chỉnh giảm theo biên bản đối soát ngày 2026-10-20",
    );
    assert.equal(ePostRecAdj.balance_after_minor, "64500000");

    // -------------------------------------------------------------------------
    // Evidence DB Lifecycle: Failed Upload Retry + Max 1 READY (§8 & §12.5)
    // -------------------------------------------------------------------------
    const evSha = "2".repeat(64);
    const evRes1Idem = nextUuid();
    const evRes1Fp = computeReserveEvidenceFingerprint({
      target_kind: "ENTRY",
      target_id: ePayment.entry_id,
      mime_type: "image/jpeg",
      size_bytes: 2048,
      checksum_sha256: evSha,
    });
    const {
      rows: [evRes1],
    } = await db.query(
      `select public.vendor_finance_reserve_evidence(
         $1::uuid, $2::uuid, 'ENTRY', $3::uuid, 'image/jpeg', 2048, $4, 300, $5::uuid, $6
       ) as result`,
      [ACCOUNTING_USER.auth, ACCOUNTING_USER.app, ePayment.entry_id, evSha, evRes1Idem, evRes1Fp],
    );
    const evId1 = evRes1.result.reservation.evidence_id;

    // Simulate failed R2 inspection -> complete('FAILED') + mark_evidence_cleaned
    await db.query(
      `select public.vendor_finance_complete_evidence(
         $1::uuid, $2::uuid, $3::uuid, 'FAILED', 'VENDOR_FINANCE_EVIDENCE_CONTENT_INVALID'
       )`,
      [ACCOUNTING_USER.auth, ACCOUNTING_USER.app, evId1],
    );
    await db.query(
      "select public.vendor_finance_mark_evidence_cleaned($1::uuid, $2::uuid, $3::uuid)",
      [ACCOUNTING_USER.auth, ACCOUNTING_USER.app, evId1],
    );

    // Retry reserve on the same entry succeeds cleanly without touching money!
    const evRes2Idem = nextUuid();
    const {
      rows: [evRes2],
    } = await db.query(
      `select public.vendor_finance_reserve_evidence(
         $1::uuid, $2::uuid, 'ENTRY', $3::uuid, 'image/jpeg', 2048, $4, 300, $5::uuid, $6
       ) as result`,
      [ACCOUNTING_USER.auth, ACCOUNTING_USER.app, ePayment.entry_id, evSha, evRes2Idem, evRes1Fp],
    );
    const evId2 = evRes2.result.reservation.evidence_id;
    const {
      rows: [evDone2],
    } = await db.query(
      `select public.vendor_finance_complete_evidence(
         $1::uuid, $2::uuid, $3::uuid, 'READY', null
       ) as result`,
      [ACCOUNTING_USER.auth, ACCOUNTING_USER.app, evId2],
    );
    assert.equal(evDone2.result.evidence.status, "READY");

    // BoD view-only CAN authorize download metadata for READY evidence
    const {
      rows: [dlMeta],
    } = await db.query(
      "select public.vendor_finance_get_evidence_download($1::uuid, $2::uuid, $3::uuid) as dl",
      [BOD_VIEW_USER.auth, BOD_VIEW_USER.app, evId2],
    );
    assert.equal(dlMeta.dl.evidence_id, evId2);

    // Attempting a second READY attachment on the same entry fails (`23505`)
    await expectPgError(
      () =>
        db.query(
          `select public.vendor_finance_reserve_evidence(
             $1::uuid, $2::uuid, 'ENTRY', $3::uuid, 'image/png', 1024, $4, 300, $5::uuid, $6
           )`,
          [
            ACCOUNTING_USER.auth,
            ACCOUNTING_USER.app,
            ePayment.entry_id,
            "3".repeat(64),
            nextUuid(),
            "4".repeat(64),
          ],
        ),
      "23505",
      "VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED",
    );

    // -------------------------------------------------------------------------
    // Evidence Expiry Persistence (PR #155 Blocker 2 DB Regression):
    //   1) `INFO` on expired `RESERVED` row commits `status = 'EXPIRED'`, sets `cleanup_after`,
    //      records `'EVIDENCE_EXPIRED'` audit event, and permits `vendor_finance_mark_evidence_cleaned`.
    //   2) `READY` on expired `RESERVED` row returns committable `{ expired: true, status: 'EXPIRED' }`
    //      WITHOUT `RAISE EXCEPTION` rollback, persists `status = 'EXPIRED'` + `'EVIDENCE_EXPIRED'`
    //      audit event, maps cleanly in `createVendorFinanceRepository`, and permits
    //      `vendor_finance_mark_evidence_cleaned` (`cleaned_up_at IS NOT NULL`).
    // -------------------------------------------------------------------------
    const expFp1 = computeReserveEvidenceFingerprint({
      target_kind: "ENTRY",
      target_id: ePostRecAdj.entry_id,
      mime_type: "image/png",
      size_bytes: 1024,
      checksum_sha256: "5".repeat(64),
    });
    const {
      rows: [evExpInfoRes],
    } = await db.query(
      `select public.vendor_finance_reserve_evidence(
         $1::uuid, $2::uuid, 'ENTRY', $3::uuid, 'image/png', 1024, $4, 1, $5::uuid, $6
       ) as result`,
      [
        ACCOUNTING_USER.auth,
        ACCOUNTING_USER.app,
        ePostRecAdj.entry_id,
        "5".repeat(64),
        nextUuid(),
        expFp1,
      ],
    );
    const evExpInfoId = evExpInfoRes.result.reservation.evidence_id;

    const expFp2 = computeReserveEvidenceFingerprint({
      target_kind: "ENTRY",
      target_id: eHuge.entry_id,
      mime_type: "image/png",
      size_bytes: 1024,
      checksum_sha256: "6".repeat(64),
    });
    const {
      rows: [evExpReadyRes],
    } = await db.query(
      `select public.vendor_finance_reserve_evidence(
         $1::uuid, $2::uuid, 'ENTRY', $3::uuid, 'image/png', 1024, $4, 1, $5::uuid, $6
       ) as result`,
      [
        ACCOUNTING_USER.auth,
        ACCOUNTING_USER.app,
        eHuge.entry_id,
        "6".repeat(64),
        nextUuid(),
        expFp2,
      ],
    );
    const evExpReadyId = evExpReadyRes.result.reservation.evidence_id;

    // Wait > 1s so both reservations cross `expires_at` in real PostgreSQL wall clock
    await new Promise((resolve) => setTimeout(resolve, 1150));

    // Path 1: `INFO` transitions `RESERVED -> EXPIRED` and commits in DB
    const {
      rows: [expInfoOut],
    } = await db.query(
      `select public.vendor_finance_complete_evidence(
         $1::uuid, $2::uuid, $3::uuid, 'INFO', null
       ) as info`,
      [ACCOUNTING_USER.auth, ACCOUNTING_USER.app, evExpInfoId],
    );
    assert.equal(expInfoOut.info.status, "EXPIRED");
    assert.equal(expInfoOut.info.is_expired, true);

    const {
      rows: [expInfoCleaned],
    } = await db.query(
      "select public.vendor_finance_mark_evidence_cleaned($1::uuid, $2::uuid, $3::uuid) as res",
      [ACCOUNTING_USER.auth, ACCOUNTING_USER.app, evExpInfoId],
    );
    assert.equal(expInfoCleaned.res.cleaned, true);

    const {
      rows: [expInfoDbRow],
    } = await db.query(
      `select status, failure_code, cleanup_after is not null as has_cleanup, cleaned_up_at is not null as has_cleaned
         from public.vendor_finance_evidence
        where evidence_id = $1::uuid`,
      [evExpInfoId],
    );
    assert.deepEqual(expInfoDbRow, {
      status: "EXPIRED",
      failure_code: "RESERVATION_TTL_EXPIRED",
      has_cleanup: true,
      has_cleaned: true,
    });

    // Path 2: `READY` race via `createVendorFinanceRepository` against real PGlite commits `EXPIRED` (no rollback!)
    const pgliteRepo = createVendorFinanceRepository(async (fnName, params) => {
      if (fnName === "vendor_finance_complete_evidence") {
        const { rows } = await db.query(
          `select public.vendor_finance_complete_evidence(
             $1::uuid, $2::uuid, $3::uuid, $4, $5
           ) as data`,
          [
            params.p_auth_subject,
            params.p_app_user_id,
            params.p_evidence_id,
            params.p_outcome,
            params.p_failure_code,
          ],
        );
        return { data: rows[0].data, error: null };
      }
      if (fnName === "vendor_finance_mark_evidence_cleaned") {
        const { rows } = await db.query(
          `select public.vendor_finance_mark_evidence_cleaned(
             $1::uuid, $2::uuid, $3::uuid
           ) as data`,
          [params.p_auth_subject, params.p_app_user_id, params.p_evidence_id],
        );
        return { data: rows[0].data, error: null };
      }
      throw new Error(`Unexpected RPC ${fnName}`);
    });

    const readyExpiredResult = await pgliteRepo.finalizeEvidenceReady({
      auth_subject: ACCOUNTING_USER.auth,
      app_user_id: ACCOUNTING_USER.app,
      evidence_id: evExpReadyId,
    });
    assert.deepEqual(readyExpiredResult, {
      ok: false,
      code: "VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED",
    });

    // Idempotent `expireEvidenceReservation` + `markEvidenceCleaned` succeed because `EXPIRED` persisted!
    const expIdemResult = await pgliteRepo.expireEvidenceReservation({
      auth_subject: ACCOUNTING_USER.auth,
      app_user_id: ACCOUNTING_USER.app,
      evidence_id: evExpReadyId,
      failure_code: "RESERVATION_TTL_EXPIRED",
    });
    assert.deepEqual(expIdemResult, {
      ok: true,
      data: { evidence_id: evExpReadyId, status: "EXPIRED" },
    });

    const markCleanedResult = await pgliteRepo.markEvidenceCleaned({
      auth_subject: ACCOUNTING_USER.auth,
      app_user_id: ACCOUNTING_USER.app,
      evidence_id: evExpReadyId,
    });
    assert.deepEqual(markCleanedResult, {
      ok: true,
      data: { evidence_id: evExpReadyId, cleaned: true },
    });

    const {
      rows: [expReadyDbRow],
    } = await db.query(
      `select status, failure_code, cleanup_after is not null as has_cleanup, cleaned_up_at is not null as has_cleaned
         from public.vendor_finance_evidence
        where evidence_id = $1::uuid`,
      [evExpReadyId],
    );
    assert.deepEqual(expReadyDbRow, {
      status: "EXPIRED",
      failure_code: "RESERVATION_TTL_EXPIRED",
      has_cleanup: true,
      has_cleaned: true,
    });

    const {
      rows: [expAuditCount],
    } = await db.query(
      `select count(*)::int as cnt
         from public.vendor_finance_audit_events
        where action = 'EVIDENCE_EXPIRED'
          and evidence_id in ($1::uuid, $2::uuid)`,
      [evExpInfoId, evExpReadyId],
    );
    assert.equal(expAuditCount.cnt, 2, "both expired reservations must persist EVIDENCE_EXPIRED audit events");

    // Ending ACCOUNTING_USER's membership immediately revokes VFIN access on the next call!
    const endAcctIdem = nextUuid();
    await db.query(
      `select public.org_department_end_accounting_member(
         $1::uuid, $2::uuid, $3::uuid, 1, null, 'Chuyển công tác', $4::uuid, $5
       )`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        accountingMembershipId,
        endAcctIdem,
        computeEndAccountingMemberFingerprint({
          actor_app_user_id: FULL_ADMIN.app,
          membership_id: accountingMembershipId,
          expected_pair_version: 1,
          effective_to: null,
          reason: "Chuyển công tác",
        }),
      ],
    );
    assert.equal((await getAccess(ACCOUNTING_USER)).can_view, false);
    await expectPgError(
      () =>
        db.query("select public.vendor_finance_list_vendors($1::uuid, $2::uuid)", [
          ACCOUNTING_USER.auth,
          ACCOUNTING_USER.app,
        ]),
      "42501",
      "VENDOR_FINANCE_ACCESS_DENIED",
    );

    // -------------------------------------------------------------------------
    // Forced RLS, Zero Direct Table Grants & Strict RPC Allowlist (§7 & §12.6)
    // -------------------------------------------------------------------------
    const { rows: tableSec } = await db.query(
      `select c.relname,
              c.relrowsecurity,
              c.relforcerowsecurity,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policy_count,
              has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_priv,
              has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as auth_priv,
              has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as svc_priv
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname like 'vendor_finance_%' and c.relkind = 'r'
        order by c.relname`,
    );
    assert.equal(tableSec.length, 7);
    for (const row of tableSec) {
      assert.equal(row.relrowsecurity, true, `${row.relname} must enable RLS`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} must force RLS`);
      assert.equal(row.policy_count, 0, `${row.relname} must have 0 permissive policies`);
      assert.equal(row.anon_priv, false);
      assert.equal(row.auth_priv, false);
      assert.equal(row.svc_priv, false);
    }

    const { rows: rpcAcl } = await db.query(
      `select format('public.%I(%s)', p.proname, oidvectortypes(p.proargtypes)) as sig,
              has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'vendor_finance%'
        order by 1`,
    );
    const allowlistSet = new Set(VFIN_01_BACKEND_RPC_SIGNATURES);
    const grantedSvc = [];
    for (const r of rpcAcl) {
      assert.equal(r.pub_exec, false, `PUBLIC must not execute ${r.sig}`);
      assert.equal(r.anon_exec, false, `anon must not execute ${r.sig}`);
      assert.equal(r.auth_exec, false, `authenticated must not execute ${r.sig}`);
      if (r.svc_exec) {
        grantedSvc.push(r.sig);
      }
    }
    assert.deepEqual(grantedSvc.sort(), [...allowlistSet].sort());
  } finally {
    await db.close();
  }
});
