/**
 * VFIN-04 — Controlled Transaction Reset, Shared Vendor Advance Ledger,
 * Project Sub-Ledger Offset ("Khấu trừ ứng"), Role Authority Matrix,
 * Monthly Debt Report Offset Reconciliation & Excel Export DB Suite.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { computeAssignAccountingMemberFingerprint } from "../src/lib/departments/department-contract.ts";
import {
  computeApplyOpeningBatchFingerprint,
  computeApplySharedAdvanceOffsetFingerprint,
  computeAssignGlobalRoleFingerprint,
  computeAssignProjectAccountantFingerprint,
  computeFundSharedAdvanceFingerprint,
  computeRecordEntryFingerprint,
  computeRecordVendorRefundFingerprint,
  computeReserveEvidenceFingerprint,
  computeReverseEntryFingerprint,
  computeReverseSharedAdvanceMovementFingerprint,
} from "../src/lib/vendor-finance/vendor-finance-contract.ts";
import { createVendorFinanceRepository } from "../src/lib/vendor-finance/vendor-finance-repository.ts";
import {
  parseMonthlyReportEnvelope,
  parseVendorDetailEnvelope,
} from "../src/lib/vendor-finance/ui-model.ts";
import {
  VFIN_03_CONTRACT_TYPE_LEDGERS_MIGRATION_NAME,
  VFIN_04_SHARED_VENDOR_ADVANCE_MIGRATION_NAME,
  VFIN_04_SHARED_VENDOR_ADVANCE_RPC_SIGNATURES,
  migrationChecksum,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";
import { cleanupVendorFinanceResetEvidence } from "./vfin-reset-evidence-cleanup.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const PRJ_A = "vfin04_prj_north";
const PRJ_B = "vfin04_prj_south";

const FULL_ADMIN = {
  auth: "19700000-0000-4000-8000-000000000001",
  app: "29700000-0000-4000-8000-000000000001",
  name: "Quản Trị Toàn Quyền VFIN-04",
};
const ACCT_A = {
  auth: "19700000-0000-4000-8000-000000000002",
  app: "29700000-0000-4000-8000-000000000002",
  name: "Kế Toán Dự Án A",
};
const ACCT_B = {
  auth: "19700000-0000-4000-8000-000000000003",
  app: "29700000-0000-4000-8000-000000000003",
  name: "Kế Toán Dự Án B",
};
const CASH_HOLDER_ONLY = {
  auth: "19700000-0000-4000-8000-000000000004",
  app: "29700000-0000-4000-8000-000000000004",
  name: "Người Cầm Tiền (CASH_HOLDER)",
};
const CASH_HOLDER_BEHALF = {
  auth: "19700000-0000-4000-8000-000000000005",
  app: "29700000-0000-4000-8000-000000000005",
  name: "Người Cầm Tiền Nhập Hộ (CASH_HOLDER_RECORD_BEHALF)",
};
const BOD_VIEWER = {
  auth: "19700000-0000-4000-8000-000000000006",
  app: "29700000-0000-4000-8000-000000000006",
  name: "Ban Giám Đốc Chỉ Xem",
};

let uuidSeq = 0;
function nextUuid() {
  uuidSeq += 1;
  return `79700000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
}

async function loadMigrationsThroughVfin04() {
  const names = (await readdir(MIGRATION_DIR))
    .filter((n) => n.endsWith(".sql") && n <= VFIN_04_SHARED_VENDOR_ADVANCE_MIGRATION_NAME)
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function createPreVfin04Database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = await loadMigrationsThroughVfin04();
  const targetIdx = migrations.findIndex(
    (m) => m.name === VFIN_04_SHARED_VENDOR_ADVANCE_MIGRATION_NAME,
  );
  assert.ok(targetIdx >= 0, "VFIN-04 migration must exist in supabase/migrations");
  for (const m of migrations.slice(0, targetIdx)) {
    await db.exec(m.sql);
  }
  return {
    db,
    vfin04Migration: migrations[targetIdx],
  };
}

const VFIN_04_RPC_BINDINGS = {
  vendor_finance_get_actor_access: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
  ],
  vendor_finance_list_actor_context_options: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
  ],
  vendor_finance_list_vendors: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_search", "text"],
    ["p_active_filter", "text"],
    ["p_balance_filter", "text"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_ledger_scope", "text"],
    ["p_contract_type", "text"],
    ["p_page", "integer"],
    ["p_page_size", "integer"],
  ],
  vendor_finance_export_vendors: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_search", "text"],
    ["p_active_filter", "text"],
    ["p_balance_filter", "text"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_ledger_scope", "text"],
    ["p_contract_type", "text"],
  ],
  vendor_finance_get_vendor: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_ledger_scope", "text"],
    ["p_contract_type", "text"],
  ],
  vendor_finance_list_vendor_entries: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_before_sequence", "bigint"],
    ["p_entry_type", "text"],
    ["p_page_size", "integer"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_ledger_scope", "text"],
    ["p_month", "text"],
    ["p_contract_type", "text"],
  ],
  vendor_finance_get_entry: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_entry_id", "uuid"],
  ],
  vendor_finance_list_vendor_reconciliations: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_page", "integer"],
    ["p_page_size", "integer"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_ledger_scope", "text"],
    ["p_contract_type", "text"],
  ],
  vendor_finance_record_entry: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_project_id", "text"],
    ["p_contract_type", "text"],
    ["p_entry_type", "text"],
    ["p_amount_minor", "text"],
    ["p_effective_date", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_reverse_entry: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_entry_id", "uuid"],
    ["p_effective_date", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_list_shared_advance_movements: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_before_sequence", "bigint"],
    ["p_movement_type", "text"],
    ["p_page_size", "integer"],
  ],
  vendor_finance_fund_shared_advance: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_amount_minor", "text"],
    ["p_effective_date", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_record_vendor_refund: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_amount_minor", "text"],
    ["p_effective_date", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_apply_shared_advance_offset: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_project_id", "text"],
    ["p_contract_type", "text"],
    ["p_amount_minor", "text"],
    ["p_effective_date", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_reverse_shared_advance_movement: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_movement_id", "uuid"],
    ["p_effective_date", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_preview_opening_batch: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_project_id", "text"],
    ["p_contract_type", "text"],
    ["p_cutoff_date", "date"],
    ["p_items", "jsonb"],
  ],
  vendor_finance_apply_opening_batch: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_project_id", "text"],
    ["p_contract_type", "text"],
    ["p_cutoff_date", "date"],
    ["p_items", "jsonb"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_create_reconciliation: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_contract_type", "text"],
    ["p_as_of_date", "date"],
    ["p_confirmed_balance_minor", "text"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_classify_unclassified_subledger: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_target_contract_type", "text"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_get_monthly_report: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_month", "text"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_contract_type", "text"],
  ],
  vendor_finance_list_project_accountants_admin: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_search", "text"],
    ["p_include_history", "boolean"],
    ["p_page", "integer"],
    ["p_page_size", "integer"],
  ],
  vendor_finance_assign_project_accountant_admin: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_valid_from", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_end_project_accountant_admin: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_assignment_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_valid_to", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_list_global_roles_admin: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_search", "text"],
    ["p_include_history", "boolean"],
    ["p_page", "integer"],
    ["p_page_size", "integer"],
  ],
  vendor_finance_assign_global_role_admin: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_target_user_id", "uuid"],
    ["p_role_code", "text"],
    ["p_expected_version", "integer"],
    ["p_valid_from", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_end_global_role_admin: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_role_grant_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_valid_to", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_reserve_evidence: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_target_kind", "text"],
    ["p_target_id", "uuid"],
    ["p_mime_type", "text"],
    ["p_size_bytes", "integer"],
    ["p_checksum_sha256", "text"],
    ["p_ttl_seconds", "integer"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_complete_evidence: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_evidence_id", "uuid"],
    ["p_outcome", "text"],
    ["p_failure_code", "text"],
  ],
  vendor_finance_get_evidence_download: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_evidence_id", "uuid"],
  ],
  vendor_finance_mark_evidence_cleaned: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_evidence_id", "uuid"],
  ],
};

function createPgliteVfinRepo(db) {
  return createVendorFinanceRepository(async (fnName, params) => {
    const spec = VFIN_04_RPC_BINDINGS[fnName];
    assert.ok(spec, `Unbound RPC in PGlite adapter: ${fnName}`);
    const placeholders = spec.map(([, pgType], idx) => `$${idx + 1}::${pgType}`).join(", ");
    const values = spec.map(([paramName, pgType]) => {
      const val = params[paramName];
      if (val === undefined || val === null) return null;
      return pgType === "jsonb" ? JSON.stringify(val) : val;
    });
    try {
      const { rows } = await db.query(
        `select public.${fnName}(${placeholders}) as data`,
        values,
      );
      return { data: rows[0]?.data ?? null, error: null };
    } catch (err) {
      return {
        data: null,
        error: {
          code: err.code ?? null,
          message: err.message ?? String(err),
          details: err.detail ?? null,
        },
      };
    }
  });
}

test("VFIN-04 Controlled Reset, Shared Vendor Advance, Multi-Project/Multi-Contract Offset, Role Authority Matrix, Monthly Report & Export Cap", async () => {
  const { db, vfin04Migration } = await createPreVfin04Database();
  try {
    // 1. Seed canonical users, projects, vendors, governance assignments, and pre-reset transactions
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ('99700000-0000-4000-8000-00000000000f'::uuid, '__system_vendor__', 'System Vendor Internal', true)
       on conflict (code) do nothing`,
    );

    for (const actor of [
      FULL_ADMIN,
      ACCT_A,
      ACCT_B,
      CASH_HOLDER_ONLY,
      CASH_HOLDER_BEHALF,
      BOD_VIEWER,
    ]) {
      await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
      await db.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
         values ($1::uuid, $2::uuid, true, $3)`,
        [actor.app, actor.auth, actor.name],
      );
    }

    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_admin', '2026-01-01', true),
              ($1::uuid, 'recruiter_master_manage', '2026-01-01', true),
              ($1::uuid, 'team_master_manage', '2026-01-01', true),
              ($1::uuid, 'catalog_master_manage', '2026-01-01', true)`,
      [FULL_ADMIN.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true)`,
      [FULL_ADMIN.app],
    );

    // Assign ACCT_A and ACCT_B to ACCOUNTING department
    for (const acct of [ACCT_A, ACCT_B]) {
      const reason = `Bổ nhiệm ${acct.name} vào phòng Kế toán`;
      await db.query(
        `select public.org_department_assign_accounting_member(
           $1::uuid, $2::uuid, $3::uuid, 0, '2026-01-01'::date, $4::text, $5::uuid, $6::text
         )`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          acct.app,
          reason,
          nextUuid(),
          computeAssignAccountingMemberFingerprint({
            actor_app_user_id: FULL_ADMIN.app,
            account_ref: acct.app,
            expected_pair_version: 0,
            effective_from: "2026-01-01",
            reason,
          }),
        ],
      );
    }

    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'Dự Án Miền Bắc (PRJ_A)', true, 1),
              ($2, 'Dự Án Miền Nam (PRJ_B)', true, 1)`,
      [PRJ_A, PRJ_B],
    );

    for (const [vid, vname] of [
      ["vnd_shared_x", "Công Ty Cung Ứng X"],
      ["vnd_shared_y", "Công Ty Cung Ứng Y"],
    ]) {
      await db.query(
        `select public.direct_entry_create_vendor(
           $1::uuid, $2::uuid, 0, $3::text, $4::text, '2026-01-01'::date, 'Tạo NCC chuẩn', $5::text
         )`,
        [FULL_ADMIN.auth, FULL_ADMIN.app, vid, vname, nextUuid()],
      );
    }

    // Assign ACCT_A -> PRJ_A and ACCT_B -> PRJ_B
    for (const [prj, acct] of [
      [PRJ_A, ACCT_A],
      [PRJ_B, ACCT_B],
    ]) {
      const fp = computeAssignProjectAccountantFingerprint({
        project_id: prj,
        accountant_ref: acct.app,
        expected_version: 0,
        valid_from: "2026-01-01",
        reason: "Phân công kế toán dự án",
      });
      await db.query(
        `select public.vendor_finance_assign_project_accountant_admin(
           $1::uuid, $2::uuid, $3::text, $4::uuid, 0, '2026-01-01'::date, 'Phân công kế toán dự án', $5::uuid, $6::text
         )`,
        [FULL_ADMIN.auth, FULL_ADMIN.app, prj, acct.app, nextUuid(), fp],
      );
    }

    // Assign Global Roles: CASH_HOLDER_ONLY -> CASH_HOLDER, CASH_HOLDER_BEHALF -> CASH_HOLDER_RECORD_BEHALF, BOD_VIEWER -> GLOBAL_VIEWER
    for (const [user, roleCode] of [
      [CASH_HOLDER_ONLY, "CASH_HOLDER"],
      [CASH_HOLDER_BEHALF, "CASH_HOLDER_RECORD_BEHALF"],
      [BOD_VIEWER, "GLOBAL_VIEWER"],
    ]) {
      const fp = computeAssignGlobalRoleFingerprint({
        user_ref: user.app,
        role_code: roleCode,
        expected_version: 0,
        valid_from: "2026-01-01",
        reason: `Cấp quyền ${roleCode}`,
      });
      await db.query(
        `select public.vendor_finance_assign_global_role_admin(
           $1::uuid, $2::uuid, $3::uuid, $4::text, 0, '2026-01-01'::date, $5::text, $6::uuid, $7::text
         )`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          user.app,
          roleCode,
          `Cấp quyền ${roleCode}`,
          nextUuid(),
          fp,
        ],
      );
    }

    // Seed pre-reset VFIN-03 transactional rows: opening batch, normal entry, reconciliation, evidence (uncleaned)
    const preOpeningItems = [
      { vendor_id: "vnd_shared_x", entry_type: "OPENING_PAYABLE", amount_minor: "50000000" },
    ];
    const preOpeningFp = computeApplyOpeningBatchFingerprint({
      project_id: PRJ_A,
      contract_type: "SEASONAL",
      cutoff_date: "2026-10-01",
      items: preOpeningItems,
      reason: "Số dư đầu kỳ trước reset",
    });
    const { rows: preOpenRows } = await db.query(
      `select public.vendor_finance_apply_opening_batch(
         $1::uuid, $2::uuid, $3::text, 'SEASONAL', '2026-10-01'::date, $4::jsonb, 'Số dư đầu kỳ trước reset', $5::uuid, $6::text
       ) as data`,
      [
        ACCT_A.auth,
        ACCT_A.app,
        PRJ_A,
        JSON.stringify(preOpeningItems),
        nextUuid(),
        preOpeningFp,
      ],
    );
    const preEntryId = preOpenRows[0].data.entries[0].entry_id;

    // Reserve evidence on preEntryId (leaves cleaned_up_at = null)
    const evChecksum = "a".repeat(64);
    const evFp = computeReserveEvidenceFingerprint({
      target_type: "ENTRY",
      target_id: preEntryId,
      mime_type: "image/png",
      size_bytes: 2048,
      checksum_sha256: evChecksum,
    });
    await db.query(
      `select public.vendor_finance_reserve_evidence(
         $1::uuid, $2::uuid, 'ENTRY', $3::uuid, 'image/png', 2048, $4::text, 600, $5::uuid, $6::text
       )`,
      [ACCT_A.auth, ACCT_A.app, preEntryId, evChecksum, nextUuid(), evFp],
    );

    const { rows: preCounters } = await db.query(
      `select doc_year, last_seq::int as last_seq from public.vendor_finance_document_counters`,
    );
    assert.ok(preCounters.length > 0 && preCounters[0].last_seq >= 1);
    const preResetMaxSeq = preCounters[0].last_seq;

    // 2. Prove VFIN-04 migration FAILS CLOSED when uncleaned evidence exists (`cleaned_up_at is null`)
    await assert.rejects(
      async () => {
        await db.exec("begin;");
        try {
          await db.exec(vfin04Migration.sql);
          await db.exec("commit;");
        } catch (err) {
          await db.exec("rollback;");
          throw err;
        }
      },
      (err) =>
        typeof err?.message === "string" &&
        err.message.includes("VENDOR_FINANCE_RESET_EVIDENCE_NOT_CLEANED"),
      "VFIN-04 migration must fail closed when uncleaned evidence rows exist",
    );

    // Verify pre-reset entry still exists after rollback
    const { rows: stillThere } = await db.query(
      "select count(*)::int as c from public.vendor_finance_entries",
    );
    assert.equal(stillThere[0].c, 1);

    // 3. Run pre-migration R2 evidence cleanup script (`--dry-run` then `--execute --confirm-reset`)
    const deletedKeys = [];
    const mockStorage = {
      available: () => true,
      deleteStaged: async (key) => {
        deletedKeys.push(`staged:${key}`);
      },
      deleteFinal: async (key) => {
        deletedKeys.push(`final:${key}`);
      },
    };
    const dryRunSummary = await cleanupVendorFinanceResetEvidence({
      dbClient: db,
      storage: mockStorage,
      execute: false,
      confirmReset: false,
    });
    assert.equal(dryRunSummary.mode, "dry-run");
    assert.equal(dryRunSummary.pending_count, 1);
    assert.equal(deletedKeys.length, 0, "dry-run must not delete R2 objects");

    const execSummary = await cleanupVendorFinanceResetEvidence({
      dbClient: db,
      storage: mockStorage,
      execute: true,
      confirmReset: true,
    });
    assert.equal(execSummary.mode, "execute");
    assert.equal(execSummary.cleaned_count, 1);
    assert.equal(deletedKeys.length, 2, "both staged and final R2 keys are deleted idempotently");

    // 4. Apply VFIN-04 migration and verify controlled reset invariants
    assert.match(migrationChecksum(vfin04Migration.sql), /^[0-9a-f]{64}$/);
    await db.exec(vfin04Migration.sql);

    for (const emptyTable of [
      "vendor_finance_entries",
      "vendor_finance_shared_advance_movements",
      "vendor_finance_opening_batches",
      "vendor_finance_reconciliations",
      "vendor_finance_subledger_classifications",
      "vendor_finance_evidence",
    ]) {
      const { rows } = await db.query(`select count(*)::int as c from public.${emptyTable}`);
      assert.equal(rows[0].c, 0, `${emptyTable} must be 0 after controlled reset`);
    }

    // Governance & master data preserved
    const { rows: keptAccountants } = await db.query(
      "select count(*)::int as c from public.vendor_finance_project_accountants where valid_to is null",
    );
    assert.equal(keptAccountants[0].c, 2, "active project accountant assignments preserved");

    const { rows: keptRoles } = await db.query(
      "select count(*)::int as c from public.vendor_finance_global_roles where valid_to is null",
    );
    assert.equal(keptRoles[0].c, 3, "active global roles preserved");

    const { rows: postCounters } = await db.query(
      "select doc_year, last_seq::int as last_seq from public.vendor_finance_document_counters",
    );
    assert.equal(
      postCounters[0].last_seq,
      preResetMaxSeq,
      "document counter last_seq must NEVER be reset or decreased",
    );

    const { rows: keptAudit } = await db.query(
      "select distinct action from public.vendor_finance_audit_events order by action",
    );
    assert.deepEqual(
      keptAudit.map((r) => r.action),
      ["GLOBAL_ROLE_ASSIGNED", "PROJECT_ACCOUNTANT_ASSIGNED"],
      "only governance audit events are preserved after controlled reset",
    );

    const { rows: keptIdem } = await db.query(
      "select distinct action from public.vendor_finance_idempotency order by action",
    );
    assert.deepEqual(
      keptIdem.map((r) => r.action),
      ["ASSIGN_GLOBAL_ROLE", "ASSIGN_PROJECT_ACCOUNTANT"],
      "only governance idempotency keys are preserved after controlled reset",
    );

    // Verify all 8 immutable triggers are enabled ('O')
    const { rows: enabledTriggers } = await db.query(
      `select tgname, tgenabled
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and not t.tgisinternal
          and tgname in (
            'vendor_finance_evidence_lifecycle_guard',
            'vendor_finance_reconciliations_immutable',
            'vendor_finance_subledger_classifications_immutable',
            'vendor_finance_shared_advance_movements_immutable',
            'vendor_finance_entries_immutable',
            'vendor_finance_opening_batches_immutable',
            'vendor_finance_audit_events_immutable',
            'vendor_finance_idempotency_immutable'
          )
        order by tgname`,
    );
    assert.equal(enabledTriggers.length, 8, "all 8 immutable triggers must exist");
    for (const trig of enabledTriggers) {
      assert.equal(trig.tgenabled, "O", `trigger ${trig.tgname} must be enabled after reset`);
    }

    // 5. Exercise VFIN-04 through canonical TypeScript repository (`createVendorFinanceRepository`)
    const repo = createPgliteVfinRepo(db);

    // 5.0 Immediately after reset (zero ledger entries), sub-ledger filters (accountant_ref, contract_type, ledger_scope)
    //     still return active Vendors via active project accountant assignments (Must-Fix #2)
    for (const filterCase of [
      { accountant_ref: ACCT_A.app, project_id: null, ledger_scope: "all", contract_type: "all" },
      { accountant_ref: null, project_id: null, ledger_scope: "all", contract_type: "SEASONAL" },
      { accountant_ref: null, project_id: null, ledger_scope: "PROJECT_ACCOUNTANT", contract_type: "all" },
    ]) {
      const postResetList = await repo.listVendors({
        auth_subject: BOD_VIEWER.auth,
        app_user_id: BOD_VIEWER.app,
        search: null,
        active: "active",
        balance_filter: "all",
        ...filterCase,
        page: 1,
        page_size: 25,
      });
      assert.equal(postResetList.ok, true);
      assert.equal(
        postResetList.data.total,
        2,
        `post-reset listVendors must return 2 active vendors for filter ${JSON.stringify(filterCase)}`,
      );

      const postResetExport = await repo.exportVendors({
        auth_subject: BOD_VIEWER.auth,
        app_user_id: BOD_VIEWER.app,
        search: null,
        active: "active",
        balance_filter: "all",
        ...filterCase,
      });
      assert.equal(postResetExport.ok, true);
      assert.equal(
        postResetExport.data.total,
        2,
        `post-reset exportVendors must return 2 active vendors for filter ${JSON.stringify(filterCase)}`,
      );
    }

    const postResetDetailByAcct = await repo.getVendor({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      vendor_id: "vnd_shared_x",
      project_id: null,
      accountant_ref: ACCT_A.app,
      ledger_scope: null,
      contract_type: null,
    });
    assert.equal(postResetDetailByAcct.ok, true);
    assert.equal(postResetDetailByAcct.data.sub_ledgers.length, 2, "SEASONAL + OFFICIAL candidate sub-ledgers for ACCT_A");
    assert.ok(
      parseVendorDetailEnvelope({ ok: true, data: postResetDetailByAcct.data }),
      "parseVendorDetailEnvelope must accept post-reset getVendor payload with can_apply_vendor_advance",
    );

    // 5a. Role & Authority Matrix checks
    const cashHolderAccess = await repo.getActorAccess({
      auth_subject: CASH_HOLDER_ONLY.auth,
      app_user_id: CASH_HOLDER_ONLY.app,
    });
    assert.equal(cashHolderAccess.ok, true);
    assert.equal(cashHolderAccess.data.visibility_scope, "ALL");
    assert.equal(cashHolderAccess.data.can_record, false);
    assert.equal(cashHolderAccess.data.can_fund_vendor_advance, true);
    assert.equal(cashHolderAccess.data.can_record_vendor_refund, true);
    assert.equal(cashHolderAccess.data.can_apply_vendor_advance, false);

    const acctAAccess = await repo.getActorAccess({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
    });
    assert.equal(acctAAccess.ok, true);
    assert.equal(acctAAccess.data.visibility_scope, "PROJECT_SCOPED");
    assert.equal(acctAAccess.data.can_record, true);
    assert.equal(acctAAccess.data.can_view_shared_advance, true);
    assert.equal(acctAAccess.data.can_fund_vendor_advance, false);
    assert.equal(acctAAccess.data.can_record_vendor_refund, false);
    assert.equal(acctAAccess.data.can_apply_vendor_advance, true);

    // Project Accountant cannot call fundSharedAdvance or recordVendorRefund
    const deniedFundByAcct = await repo.fundSharedAdvance({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "vnd_shared_x",
      amount_minor: "100000000",
      effective_date: "2026-10-10",
      reason: "Kế toán dự án thử ứng tiền",
      idempotency_key: nextUuid(),
      request_fingerprint: computeFundSharedAdvanceFingerprint({
        vendor_id: "vnd_shared_x",
        amount_minor: "100000000",
        effective_date: "2026-10-10",
        reason: "Kế toán dự án thử ứng tiền",
      }),
    });
    assert.equal(deniedFundByAcct.ok, false);
    assert.equal(deniedFundByAcct.code, "VENDOR_FINANCE_RECORD_DENIED");

    // No actor (including PROJECT_SCOPED, CASH_HOLDER_RECORD_BEHALF, and FULL_ADMIN) can record ADVANCE_RECORDED or OPENING_ADVANCE at DB boundary
    for (const actor of [ACCT_A, CASH_HOLDER_BEHALF, FULL_ADMIN]) {
      await assert.rejects(
        () =>
          db.query(
            `select public.vendor_finance_record_entry(
               $1::uuid, $2::uuid, 'vnd_shared_x', $3::text, 'SEASONAL', 'ADVANCE_RECORDED',
               '10000000', '2026-10-10'::date, 'Cố tạo ADVANCE_RECORDED', $4::uuid, $5::text
             )`,
            [actor.auth, actor.app, PRJ_A, nextUuid(), "1".repeat(64)],
          ),
        (err) => err?.message?.includes("VENDOR_FINANCE_RECORD_DENIED"),
      );

      await assert.rejects(
        () =>
          db.query(
            `select public.vendor_finance_preview_opening_batch(
               $1::uuid, $2::uuid, $3::text, 'SEASONAL', '2026-10-01'::date,
               '[{"vendor_id":"vnd_shared_x","entry_type":"OPENING_ADVANCE","amount_minor":"10000000"}]'::jsonb
             )`,
            [actor.auth, actor.app, PRJ_A],
          ),
        (err) => err?.message?.includes("VENDOR_FINANCE_RECORD_DENIED"),
      );

      await assert.rejects(
        () =>
          db.query(
            `select public.vendor_finance_apply_opening_batch(
               $1::uuid, $2::uuid, $3::text, 'SEASONAL', '2026-10-01'::date,
               '[{"vendor_id":"vnd_shared_x","entry_type":"OPENING_ADVANCE","amount_minor":"10000000"}]'::jsonb,
               'Cố tạo OPENING_ADVANCE', $4::uuid, $5::text
             )`,
            [actor.auth, actor.app, PRJ_A, nextUuid(), "2".repeat(64)],
          ),
        (err) => err?.message?.includes("VENDOR_FINANCE_RECORD_DENIED"),
      );

      const detailForActor = await repo.getVendor({
        auth_subject: actor.auth,
        app_user_id: actor.app,
        vendor_id: "vnd_shared_x",
        project_id: PRJ_A,
        accountant_ref: null,
        ledger_scope: null,
        contract_type: "SEASONAL",
      });
      assert.equal(detailForActor.ok, true);
      assert.equal(
        detailForActor.data.allowed_actions.allowed_entry_types.includes("ADVANCE_RECORDED"),
        false,
        `allowed_entry_types must not include ADVANCE_RECORDED for ${actor.name}`,
      );
    }

    // CASH_HOLDER cannot write project sub-ledgers
    const deniedProjectWriteByCashHolder = await repo.recordEntry({
      auth_subject: CASH_HOLDER_ONLY.auth,
      app_user_id: CASH_HOLDER_ONLY.app,
      vendor_id: "vnd_shared_x",
      project_id: PRJ_A,
      contract_type: "SEASONAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "60000000",
      effective_date: "2026-10-10",
      reason: "CASH_HOLDER cố ghi sổ dự án",
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        vendor_id: "vnd_shared_x",
        project_id: PRJ_A,
        contract_type: "SEASONAL",
        entry_type: "DEBT_RECORDED",
        amount_minor: "60000000",
        effective_date: "2026-10-10",
        reason: "CASH_HOLDER cố ghi sổ dự án",
      }),
    });
    assert.equal(deniedProjectWriteByCashHolder.ok, false);
    assert.equal(deniedProjectWriteByCashHolder.code, "VENDOR_FINANCE_RECORD_DENIED");

    // 5b. CASH_HOLDER funds 100,000,000 shared advance for Vendor X
    const fundKey = nextUuid();
    const fundFp = computeFundSharedAdvanceFingerprint({
      vendor_id: "vnd_shared_x",
      amount_minor: "100000000",
      effective_date: "2026-10-05",
      reason: "Ứng tiền dùng chung đợt 1 cho Vendor X",
    });
    const funded = await repo.fundSharedAdvance({
      auth_subject: CASH_HOLDER_ONLY.auth,
      app_user_id: CASH_HOLDER_ONLY.app,
      vendor_id: "vnd_shared_x",
      amount_minor: "100000000",
      effective_date: "2026-10-05",
      reason: "Ứng tiền dùng chung đợt 1 cho Vendor X",
      idempotency_key: fundKey,
      request_fingerprint: fundFp,
    });
    assert.equal(funded.ok, true);
    assert.equal(funded.data.replayed, false);
    assert.equal(funded.data.shared_advance_balance_minor, "100000000");
    assert.equal(funded.data.movement.movement_type, "ADVANCE_FUNDED");
    assert.equal(funded.data.movement.balance_before_minor, "0");
    assert.equal(funded.data.movement.balance_delta_minor, "100000000");
    assert.equal(funded.data.movement.balance_after_minor, "100000000");

    // Verify document number continued above preResetMaxSeq
    const postFundSeq = Number(funded.data.movement.document_no.split("-").pop());
    assert.ok(
      postFundSeq > preResetMaxSeq,
      `new document seq ${postFundSeq} must be strictly > pre-reset seq ${preResetMaxSeq}`,
    );

    // Verify immutable trigger blocks UPDATE/DELETE on vendor_finance_shared_advance_movements
    await assert.rejects(
      () =>
        db.query(
          "update public.vendor_finance_shared_advance_movements set reason = 'tamper' where movement_id = $1::uuid",
          [funded.data.movement.movement_id],
        ),
      (err) => err?.message?.includes("VENDOR_FINANCE_IMMUTABLE_RECORD"),
    );

    // 5c. ACCT_A records 60,000,000 SEASONAL debt on PRJ_A; ACCT_B records 50,000,000 OFFICIAL debt on PRJ_B
    const debtAFp = computeRecordEntryFingerprint({
      vendor_id: "vnd_shared_x",
      project_id: PRJ_A,
      contract_type: "SEASONAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "60000000",
      effective_date: "2026-10-08",
      reason: "Công nợ thời vụ tháng 10 tại PRJ_A",
    });
    const debtA = await repo.recordEntry({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "vnd_shared_x",
      project_id: PRJ_A,
      contract_type: "SEASONAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "60000000",
      effective_date: "2026-10-08",
      reason: "Công nợ thời vụ tháng 10 tại PRJ_A",
      idempotency_key: nextUuid(),
      request_fingerprint: debtAFp,
    });
    assert.equal(debtA.ok, true);
    assert.equal(debtA.data.entry.balance_after_minor, "60000000");

    const debtBFp = computeRecordEntryFingerprint({
      vendor_id: "vnd_shared_x",
      project_id: PRJ_B,
      contract_type: "OFFICIAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "50000000",
      effective_date: "2026-10-09",
      reason: "Công nợ chính thức tháng 10 tại PRJ_B",
    });
    const debtB = await repo.recordEntry({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      vendor_id: "vnd_shared_x",
      project_id: PRJ_B,
      contract_type: "OFFICIAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "50000000",
      effective_date: "2026-10-09",
      reason: "Công nợ chính thức tháng 10 tại PRJ_B",
      idempotency_key: nextUuid(),
      request_fingerprint: debtBFp,
    });
    assert.equal(debtB.ok, true);
    assert.equal(debtB.data.entry.balance_after_minor, "50000000");

    // 5d. ACCT_A applies 40,000,000 shared advance offset to PRJ_A (SEASONAL)
    const offsetAFp = computeApplySharedAdvanceOffsetFingerprint({
      vendor_id: "vnd_shared_x",
      project_id: PRJ_A,
      contract_type: "SEASONAL",
      amount_minor: "40000000",
      effective_date: "2026-10-12",
      reason: "Khấu trừ ứng dùng chung vào công nợ thời vụ PRJ_A",
    });
    const offsetA = await repo.applySharedAdvanceOffset({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "vnd_shared_x",
      project_id: PRJ_A,
      contract_type: "SEASONAL",
      amount_minor: "40000000",
      effective_date: "2026-10-12",
      reason: "Khấu trừ ứng dùng chung vào công nợ thời vụ PRJ_A",
      idempotency_key: nextUuid(),
      request_fingerprint: offsetAFp,
    });
    assert.equal(offsetA.ok, true);
    assert.equal(offsetA.data.shared_advance_balance_minor, "60000000");
    assert.equal(offsetA.data.movement.movement_type, "PROJECT_OFFSET_APPLIED");
    assert.equal(offsetA.data.movement.balance_before_minor, "100000000");
    assert.equal(offsetA.data.movement.balance_delta_minor, "-40000000");
    assert.equal(offsetA.data.movement.balance_after_minor, "60000000");
    assert.equal(offsetA.data.entry.entry_type, "ADVANCE_OFFSET_RECORDED");
    assert.equal(offsetA.data.entry.balance_before_minor, "60000000");
    assert.equal(offsetA.data.entry.balance_delta_minor, "-40000000");
    assert.equal(offsetA.data.entry.balance_after_minor, "20000000");
    assert.equal(offsetA.data.movement.project_entry_id, offsetA.data.entry.entry_id);

    // 5e. ACCT_B applies 35,000,000 shared advance offset to PRJ_B (OFFICIAL)
    const offsetBFp = computeApplySharedAdvanceOffsetFingerprint({
      vendor_id: "vnd_shared_x",
      project_id: PRJ_B,
      contract_type: "OFFICIAL",
      amount_minor: "35000000",
      effective_date: "2026-10-13",
      reason: "Khấu trừ ứng dùng chung vào công nợ chính thức PRJ_B",
    });
    const offsetB = await repo.applySharedAdvanceOffset({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      vendor_id: "vnd_shared_x",
      project_id: PRJ_B,
      contract_type: "OFFICIAL",
      amount_minor: "35000000",
      effective_date: "2026-10-13",
      reason: "Khấu trừ ứng dùng chung vào công nợ chính thức PRJ_B",
      idempotency_key: nextUuid(),
      request_fingerprint: offsetBFp,
    });
    assert.equal(offsetB.ok, true);
    assert.equal(offsetB.data.shared_advance_balance_minor, "25000000");
    assert.equal(offsetB.data.entry.balance_after_minor, "15000000");

    // 5f. CASH_HOLDER_BEHALF records 10,000,000 vendor refund -> shared advance = 15,000,000
    const refundFp = computeRecordVendorRefundFingerprint({
      vendor_id: "vnd_shared_x",
      amount_minor: "10000000",
      effective_date: "2026-10-14",
      reason: "Vendor X hoàn ứng tiền mặt",
    });
    const refunded = await repo.recordVendorRefund({
      auth_subject: CASH_HOLDER_BEHALF.auth,
      app_user_id: CASH_HOLDER_BEHALF.app,
      vendor_id: "vnd_shared_x",
      amount_minor: "10000000",
      effective_date: "2026-10-14",
      reason: "Vendor X hoàn ứng tiền mặt",
      idempotency_key: nextUuid(),
      request_fingerprint: refundFp,
    });
    assert.equal(refunded.ok, true);
    assert.equal(refunded.data.shared_advance_balance_minor, "15000000");
    assert.equal(refunded.data.movement.movement_type, "VENDOR_REFUND_RECORDED");

    // 5g. Guardrail: Refund > 15,000,000 fails with VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE
    const overRefund = await repo.recordVendorRefund({
      auth_subject: CASH_HOLDER_ONLY.auth,
      app_user_id: CASH_HOLDER_ONLY.app,
      vendor_id: "vnd_shared_x",
      amount_minor: "15000001",
      effective_date: "2026-10-15",
      reason: "Hoàn ứng vượt số dư",
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordVendorRefundFingerprint({
        vendor_id: "vnd_shared_x",
        amount_minor: "15000001",
        effective_date: "2026-10-15",
        reason: "Hoàn ứng vượt số dư",
      }),
    });
    assert.equal(overRefund.ok, false);
    assert.equal(overRefund.code, "VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE");

    // 5h. Guardrail: Offset > shared_advance_balance_minor (15,000,001 > 15,000,000 while PRJ_A payable is 20,000,000)
    const overSharedOffset = await repo.applySharedAdvanceOffset({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "vnd_shared_x",
      project_id: PRJ_A,
      contract_type: "SEASONAL",
      amount_minor: "15000001",
      effective_date: "2026-10-15",
      reason: "Khấu trừ vượt số dư ứng dùng chung",
      idempotency_key: nextUuid(),
      request_fingerprint: computeApplySharedAdvanceOffsetFingerprint({
        vendor_id: "vnd_shared_x",
        project_id: PRJ_A,
        contract_type: "SEASONAL",
        amount_minor: "15000001",
        effective_date: "2026-10-15",
        reason: "Khấu trừ vượt số dư ứng dùng chung",
      }),
    });
    assert.equal(overSharedOffset.ok, false);
    assert.equal(overSharedOffset.code, "VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE");

    // 5i. Guardrail: Offset > sub-ledger payable (PRJ_B payable is 15,000,000; fund +10M so shared advance = 25M, then try 15,000,001 on PRJ_B)
    const extraFund = await repo.fundSharedAdvance({
      auth_subject: CASH_HOLDER_ONLY.auth,
      app_user_id: CASH_HOLDER_ONLY.app,
      vendor_id: "vnd_shared_x",
      amount_minor: "10000000",
      effective_date: "2026-10-15",
      reason: "Ứng thêm 10M để test trần phải trả dự án",
      idempotency_key: nextUuid(),
      request_fingerprint: computeFundSharedAdvanceFingerprint({
        vendor_id: "vnd_shared_x",
        amount_minor: "10000000",
        effective_date: "2026-10-15",
        reason: "Ứng thêm 10M để test trần phải trả dự án",
      }),
    });
    assert.equal(extraFund.ok, true);
    assert.equal(extraFund.data.shared_advance_balance_minor, "25000000");

    const overPayableOffset = await repo.applySharedAdvanceOffset({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      vendor_id: "vnd_shared_x",
      project_id: PRJ_B,
      contract_type: "OFFICIAL",
      amount_minor: "15000001",
      effective_date: "2026-10-15",
      reason: "Khấu trừ vượt công nợ phải trả của sổ con PRJ_B",
      idempotency_key: nextUuid(),
      request_fingerprint: computeApplySharedAdvanceOffsetFingerprint({
        vendor_id: "vnd_shared_x",
        project_id: PRJ_B,
        contract_type: "OFFICIAL",
        amount_minor: "15000001",
        effective_date: "2026-10-15",
        reason: "Khấu trừ vượt công nợ phải trả của sổ con PRJ_B",
      }),
    });
    assert.equal(overPayableOffset.ok, false);
    assert.equal(overPayableOffset.code, "VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE");

    // 5j. Guardrail: Reversing initial 100M ADVANCE_FUNDED when remaining shared advance is 25M (< 100M) fails
    const deniedReverseFund = await repo.reverseSharedAdvanceMovement({
      auth_subject: CASH_HOLDER_ONLY.auth,
      app_user_id: CASH_HOLDER_ONLY.app,
      movement_id: funded.data.movement.movement_id,
      effective_date: "2026-10-16",
      reason: "Đảo bút toán ứng 100M khi đã dùng 75M",
      idempotency_key: nextUuid(),
      request_fingerprint: computeReverseSharedAdvanceMovementFingerprint({
        movement_id: funded.data.movement.movement_id,
        effective_date: "2026-10-16",
        reason: "Đảo bút toán ứng 100M khi đã dùng 75M",
      }),
    });
    assert.equal(deniedReverseFund.ok, false);
    assert.equal(deniedReverseFund.code, "VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE");

    // 5k. Coupled Reversal: Reversing PROJECT_OFFSET_APPLIED on PRJ_B via reverseSharedAdvanceMovement
    //     atomically reverses both shared advance movement (+35M -> 60M) and PRJ_B sub-ledger entry (+35M -> 50M),
    //     then re-applying 35M offset restores shared advance = 25M and PRJ_B payable = 15M.
    const revOffsetB = await repo.reverseSharedAdvanceMovement({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      movement_id: offsetB.data.movement.movement_id,
      effective_date: "2026-10-16",
      reason: "Đảo bút toán khấu trừ ứng PRJ_B để kiểm tra tính nguyên tử",
      idempotency_key: nextUuid(),
      request_fingerprint: computeReverseSharedAdvanceMovementFingerprint({
        movement_id: offsetB.data.movement.movement_id,
        effective_date: "2026-10-16",
        reason: "Đảo bút toán khấu trừ ứng PRJ_B để kiểm tra tính nguyên tử",
      }),
    });
    assert.equal(revOffsetB.ok, true);
    assert.equal(revOffsetB.data.shared_advance_balance_minor, "60000000");
    assert.ok(revOffsetB.data.reversal_entry);
    assert.equal(revOffsetB.data.reversal_entry.balance_after_minor, "50000000");

    // Re-apply 35M offset on PRJ_B and reverse the extra 10M fund so shared advance = 15M, PRJ_A = 20M, PRJ_B = 15M
    const offsetB2 = await repo.applySharedAdvanceOffset({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      vendor_id: "vnd_shared_x",
      project_id: PRJ_B,
      contract_type: "OFFICIAL",
      amount_minor: "35000000",
      effective_date: "2026-10-16",
      reason: "Khấu trừ lại 35M cho PRJ_B",
      idempotency_key: nextUuid(),
      request_fingerprint: computeApplySharedAdvanceOffsetFingerprint({
        vendor_id: "vnd_shared_x",
        project_id: PRJ_B,
        contract_type: "OFFICIAL",
        amount_minor: "35000000",
        effective_date: "2026-10-16",
        reason: "Khấu trừ lại 35M cho PRJ_B",
      }),
    });
    assert.equal(offsetB2.ok, true);
    assert.equal(offsetB2.data.shared_advance_balance_minor, "25000000");

    const revExtraFund = await repo.reverseSharedAdvanceMovement({
      auth_subject: CASH_HOLDER_ONLY.auth,
      app_user_id: CASH_HOLDER_ONLY.app,
      movement_id: extraFund.data.movement.movement_id,
      effective_date: "2026-10-16",
      reason: "Đảo khoản ứng test 10M",
      idempotency_key: nextUuid(),
      request_fingerprint: computeReverseSharedAdvanceMovementFingerprint({
        movement_id: extraFund.data.movement.movement_id,
        effective_date: "2026-10-16",
        reason: "Đảo khoản ứng test 10M",
      }),
    });
    assert.equal(revExtraFund.ok, true);
    assert.equal(revExtraFund.data.shared_advance_balance_minor, "15000000");

    // 5l. Filter Invariance & Project Redaction on Shared Advance Movements
    // ACCT_A lists shared advance movements of Vendor X: sees all movements, but PRJ_B project details are redacted (null)
    const movPageAcctA = await repo.listSharedAdvanceMovements({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "vnd_shared_x",
      before_sequence: null,
      movement_type: null,
      page_size: 25,
    });
    assert.equal(movPageAcctA.ok, true);
    assert.equal(movPageAcctA.data.shared_advance_balance_minor, "15000000");
    const prjAMovForAcctA = movPageAcctA.data.movements.find(
      (m) => m.movement_id === offsetA.data.movement.movement_id,
    );
    assert.equal(prjAMovForAcctA.project_id, PRJ_A);
    assert.equal(prjAMovForAcctA.contract_type, "SEASONAL");

    const prjBMovForAcctA = movPageAcctA.data.movements.find(
      (m) => m.movement_id === offsetB2.data.movement.movement_id,
    );
    assert.ok(prjBMovForAcctA, "ACCT_A sees PRJ_B offset deduction on shared advance ledger");
    assert.equal(
      prjBMovForAcctA.project_id,
      null,
      "PRJ_B project_id is redacted for ACCT_A",
    );
    assert.equal(
      prjBMovForAcctA.reason,
      null,
      "PRJ_B free-text reason is redacted for ACCT_A",
    );
    assert.equal(
      prjBMovForAcctA.created_by_display_name,
      null,
      "PRJ_B created_by_display_name is redacted for ACCT_A",
    );
    assert.equal(prjBMovForAcctA.can_attach_evidence, false);
    assert.equal(prjBMovForAcctA.evidence, null);

    // Filter invariance on listVendors & getVendor across project_id / contract_type filters
    const listAll = await repo.listVendors({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      search: "vnd_shared_x",
      active: "all",
      balance_filter: "all",
      project_id: null,
      accountant_ref: null,
      ledger_scope: "all",
      contract_type: "all",
      page: 1,
      page_size: 25,
    });
    assert.equal(listAll.ok, true);
    assert.equal(listAll.data.vendors[0].payable_total_minor, "35000000"); // 20M + 15M
    assert.equal(listAll.data.vendors[0].shared_advance_balance_minor, "15000000");

    const listPrjA = await repo.listVendors({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      search: "vnd_shared_x",
      active: "all",
      balance_filter: "all",
      project_id: PRJ_A,
      accountant_ref: null,
      ledger_scope: "all",
      contract_type: "SEASONAL",
      page: 1,
      page_size: 25,
    });
    assert.equal(listPrjA.ok, true);
    assert.equal(listPrjA.data.vendors[0].payable_total_minor, "20000000"); // Filtered to PRJ_A
    assert.equal(
      listPrjA.data.vendors[0].shared_advance_balance_minor,
      "15000000",
      "shared_advance_balance_minor is invariant across project/contract_type filters",
    );

    // 5m. Monthly Report reconciles closing_balance_minor with advance_offset_in_month_minor separate from paid_in_month_minor
    const monthlyReport = await repo.getMonthlyReport({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      month: "2026-10",
      project_id: null,
      accountant_ref: null,
      vendor_id: "vnd_shared_x",
      contract_type: "all",
    });
    assert.equal(monthlyReport.ok, true);
    assert.equal(monthlyReport.data.totals.obligations_in_month_minor, "110000000"); // 60M + 50M
    assert.equal(monthlyReport.data.totals.paid_in_month_minor, "0"); // zero cash paid
    assert.equal(monthlyReport.data.totals.advance_offset_in_month_minor, "75000000"); // 40M + 35M net offset
    assert.equal(monthlyReport.data.totals.closing_payable_minor, "35000000"); // 110M - 75M = 35M
    const parsedMonthlyUi = parseMonthlyReportEnvelope({ ok: true, data: monthlyReport.data });
    assert.ok(
      parsedMonthlyUi,
      "parseMonthlyReportEnvelope must accept real DB monthly report output without returning null",
    );
    assert.equal(parsedMonthlyUi.totals.advance_offset_in_month_minor, "75000000");

    // 5n. Export Vendors parity + 10,000 row cap enforcement (cap + 1 = 10,001)
    const exported = await repo.exportVendors({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      search: "vnd_shared_x",
      active: "all",
      balance_filter: "all",
      project_id: PRJ_A,
      accountant_ref: null,
      ledger_scope: "all",
      contract_type: "SEASONAL",
    });
    assert.equal(exported.ok, true);
    assert.equal(exported.data.total, 1);
    assert.equal(exported.data.vendors[0].vendor_id, "vnd_shared_x");
    assert.equal(exported.data.vendors[0].payable_total_minor, "20000000");
    assert.equal(exported.data.vendors[0].shared_advance_balance_minor, "15000000");

    // Seed 10,000 more vendors (total 10,002 > 10,000 cap) and verify VENDOR_FINANCE_EXPORT_ROW_CAP_EXCEEDED
    await db.query(
      `insert into public.vendors (vendor_id, display_name, active, version)
       select 'vnd_bulk_' || lpad(i::text, 5, '0'),
              'Vendor Bulk ' || lpad(i::text, 5, '0'),
              true,
              1
         from generate_series(1, 10000) as g(i)`,
    );

    const capExceeded = await repo.exportVendors({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      search: null,
      active: "all",
      balance_filter: "all",
      project_id: null,
      accountant_ref: null,
      ledger_scope: "all",
      contract_type: "all",
    });
    assert.equal(capExceeded.ok, false);
    assert.equal(capExceeded.code, "VENDOR_FINANCE_EXPORT_ROW_CAP_EXCEEDED");
  } finally {
    await db.close();
  }
});
