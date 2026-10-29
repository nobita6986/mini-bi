/**
 * W2S2 Salary Advance (Ứng lương) WP1 — Comprehensive PGlite DB & Repository Suite.
 *
 * Covers all 7 mandatory verification areas:
 *   1. Authorization matrix (QLDA project/creator scope, Project Accountant scope,
 *      Project Accountant handover A -> B, Full Admin & Canonical BoD supervisory
 *      read-only access, and VFIN permission/role non-escalation guard).
 *   2. Separate `request_state` and `evidence_review_state` state machines.
 *   3. Cash-receipt evidence versioning (v1 -> RETAKE_REQUIRED -> v2 -> REVIEWED)
 *      and 4-way worker portrait OCC lock (`expected_version`, `evidence_version`,
 *      `expected_worker_portrait_document_id`, `expected_worker_portrait_version`).
 *   4. Positive integer VND amounts (`bigint`, no business cap) & zero duplicated
 *      worker PII snapshot columns in `salary_advance_*` tables.
 *   5. OCC version conflicts, idempotent replay/conflict, and superseded upload
 *      race protection.
 *   6. Evidence preview & worker portrait context scoping (including portrait
 *      rotation conflict check).
 *   7. RLS + FORCE RLS, zero anon/authenticated table grants, `service_role`-only
 *      RPC execute ACLs, and append-only `salary_advance_events` triggers.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { computeAssignAccountingMemberFingerprint } from "../src/lib/departments/department-contract.ts";
import {
  MAX_PG_BIGINT,
  computeCreateRequestFingerprint,
  computeFinalizeEvidenceFingerprint,
  computeReserveEvidenceFingerprint,
  computeReviewEvidenceFingerprint,
  computeTransitionRequestFingerprint,
} from "../src/lib/salary-advance/salary-advance-contract.ts";
import { createSalaryAdvanceRepository } from "../src/lib/salary-advance/salary-advance-repository.ts";
import {
   computeAssignGlobalRoleFingerprint,
  computeAssignProjectAccountantFingerprint,
  computeEndProjectAccountantFingerprint,
} from "../src/lib/vendor-finance/vendor-finance-contract.ts";
import {
  SALARY_ADVANCE_WP1_MIGRATION_NAME,
  SALARY_ADVANCE_WP1_RPC_SIGNATURES,
  migrationChecksum,
  migrationSqlForTransaction,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const TEAM_ALPHA = "99800000-0000-4000-8000-00000000000a";
const PRJ_1 = "sal_adv_prj_north";
const PRJ_2 = "sal_adv_prj_south";
const PRJ_NO_ACCT = "sal_adv_prj_no_acct";

const FULL_ADMIN = {
  auth: "19800000-0000-4000-8000-000000000001",
  app: "29800000-0000-4000-8000-000000000001",
  name: "Quản Trị Toàn Quyền Ứng Lương",
};
const CANONICAL_BOD = {
  auth: "19800000-0000-4000-8000-000000000002",
  app: "29800000-0000-4000-8000-000000000002",
  name: "Ban Giám Đốc Chuẩn (BoD)",
};
const PM_1 = {
  auth: "19800000-0000-4000-8000-000000000003",
  app: "29800000-0000-4000-8000-000000000003",
  recruiter: "39800000-0000-4000-8000-000000000003",
  name: "QLDA Dự Án Bắc 01",
  code: "PM-801",
};
const PM_1B = {
  auth: "19800000-0000-4000-8000-000000000004",
  app: "29800000-0000-4000-8000-000000000004",
  recruiter: "39800000-0000-4000-8000-000000000004",
  name: "QLDA Dự Án Bắc 02",
  code: "PM-802",
};
const PM_2 = {
  auth: "19800000-0000-4000-8000-000000000005",
  app: "29800000-0000-4000-8000-000000000005",
  recruiter: "39800000-0000-4000-8000-000000000005",
  name: "QLDA Dự Án Nam",
  code: "PM-803",
};
const ACCT_A = {
  auth: "19800000-0000-4000-8000-000000000006",
  app: "29800000-0000-4000-8000-000000000006",
  recruiter: "39800000-0000-4000-8000-000000000006",
  name: "Kế Toán Dự Án A",
  code: "KT-806",
};
const ACCT_B = {
  auth: "19800000-0000-4000-8000-000000000007",
  app: "29800000-0000-4000-8000-000000000007",
  recruiter: "39800000-0000-4000-8000-000000000007",
  name: "Kế Toán Dự Án B",
  code: "KT-807",
};
const VFIN_ONLY_ACTOR = {
  auth: "19800000-0000-4000-8000-000000000008",
  app: "29800000-0000-4000-8000-000000000008",
  recruiter: "39800000-0000-4000-8000-000000000008",
  name: "Tài Khoản Chỉ Có Quyền VFIN Reconciler",
  code: "VF-808",
};
const VFIN_CASH_HOLDER_ACTOR = {
  auth: "19800000-0000-4000-8000-000000000009",
  app: "29800000-0000-4000-8000-000000000009",
  recruiter: "39800000-0000-4000-8000-000000000009",
  name: "Tài Khoản Chỉ Có Quyền VFIN Cash Holder",
  code: "VF-809",
};

let uuidSeq = 0;
function nextUuid() {
  uuidSeq += 1;
  return `79800000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
}

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIR))
    .filter((n) => n.endsWith(".sql"))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function createPreWp1Database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = await loadMigrations();
  const targetIdx = migrations.findIndex(
    (m) => m.name === SALARY_ADVANCE_WP1_MIGRATION_NAME,
  );
  assert.ok(
    targetIdx >= 0,
    `${SALARY_ADVANCE_WP1_MIGRATION_NAME} must exist in supabase/migrations`,
  );
  for (const m of migrations.slice(0, targetIdx)) {
    await db.exec(m.sql);
  }
  return {
    db,
    targetMigration: migrations[targetIdx],
    restMigrations: migrations.slice(targetIdx + 1),
  };
}

const SALARY_ADVANCE_RPC_BINDINGS = {
  salary_advance_get_actor_context: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
  ],
  salary_advance_list_project_workers: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_project_id", "text"],
    ["p_search", "text"],
    ["p_cursor", "text"],
    ["p_page_size", "integer"],
  ],
  salary_advance_list_requests: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_queue", "text"],
    ["p_project_id", "text"],
    ["p_request_state", "text"],
    ["p_evidence_review_state", "text"],
    ["p_search", "text"],
    ["p_cursor", "text"],
    ["p_page_size", "integer"],
  ],
  salary_advance_get_request_detail: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
  ],
  salary_advance_create_request: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_project_id", "text"],
    ["p_worker_entry_id", "uuid"],
    ["p_requested_amount_vnd", "text"],
    ["p_initial_content", "text"],
    ["p_idempotency_key", "text"],
    ["p_request_fingerprint", "text"],
    ["p_payment_method", "text"],
  ],
  salary_advance_post_message: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_message_text", "text"],
    ["p_idempotency_key", "text"],
    ["p_request_fingerprint", "text"],
  ],
  salary_advance_transition_request: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_action", "text"],
    ["p_expected_version", "integer"],
    ["p_message_text", "text"],
    ["p_idempotency_key", "text"],
    ["p_request_fingerprint", "text"],
  ],
  salary_advance_reserve_evidence: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_mime_type", "text"],
    ["p_size_bytes", "integer"],
    ["p_checksum_sha256", "text"],
    ["p_caption_note", "text"],
    ["p_idempotency_key", "text"],
    ["p_request_fingerprint", "text"],
  ],
  salary_advance_get_evidence_finalize_context: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_upload_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_idempotency_key", "text"],
    ["p_request_fingerprint", "text"],
  ],
  salary_advance_finalize_evidence: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_upload_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_idempotency_key", "text"],
    ["p_request_fingerprint", "text"],
  ],
  salary_advance_review_evidence: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_evidence_version", "integer"],
    ["p_decision", "text"],
    ["p_expected_worker_portrait_document_id", "uuid"],
    ["p_expected_worker_portrait_version", "integer"],
    ["p_note", "text"],
    ["p_idempotency_key", "text"],
    ["p_request_fingerprint", "text"],
  ],
  salary_advance_get_evidence_preview_context: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_evidence_version", "integer"],
  ],
  salary_advance_get_worker_portrait_context: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_expected_document_id", "uuid"],
  ],
};

function createPgliteSalaryAdvanceRepo(db) {
  return createSalaryAdvanceRepository(async (fnName, params) => {
    const spec = SALARY_ADVANCE_RPC_BINDINGS[fnName];
    assert.ok(spec, `Unbound RPC in PGlite adapter: ${fnName}`);
    const placeholders = spec
      .map(([, pgType], idx) => `$${idx + 1}::${pgType}`)
      .join(", ");
    const values = spec.map(([paramName]) => {
      const val = params[paramName];
      return val === undefined ? null : val;
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
          code: err.code ?? undefined,
          message: err.message ?? String(err),
        },
      };
    }
  });
}

function makeWorkerDetails(displayName) {
  const unknown = { state: "unknown" };
  return {
    display_name: displayName,
    date_of_birth: unknown,
    national_id: unknown,
    address: unknown,
    phone: unknown,
  };
}

async function seedWorkerPortraitVersion(db, actor, entryId, shaChar = "a") {
  const { rows: entryRows } = await db.query(
    "select version from public.direct_entries where entry_id = $1::uuid",
    [entryId],
  );
  const reserveKey = `portrait-reserve-${nextUuid()}`;
  const reserved = await db.query(
    `select public.direct_entry_reserve_document_direct_upload(
       $1::uuid, $2::uuid, $3::uuid, $4::integer, 'WORKER_PORTRAIT',
       $5::text, 512, 'image/jpeg', null
     ) as data`,
    [
      actor.auth,
      actor.app,
      entryId,
      entryRows[0].version,
      reserveKey,
    ],
  );
  const reservation = reserved.rows[0].data;
  const finalizeKey = `portrait-finalize-${nextUuid()}`;
  const finalized = await db.query(
    `select public.direct_entry_finalize_document_direct_upload(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer,
       $6::text, 'validated', $7::text, 512, 'image/jpeg'
     ) as data`,
    [
      actor.auth,
      actor.app,
      entryId,
      reservation.document_id,
      reservation.entry_version,
      finalizeKey,
      shaChar.repeat(64),
    ],
  );
  return finalized.rows[0].data;
}

test("(#1) W2S2 Salary Advance WP1 migration rolls back atomically on failure and has LF/CRLF-identical SHA-256 checksum", async () => {
  const { db, targetMigration } = await createPreWp1Database();
  try {
    const checksum = migrationChecksum(targetMigration.sql);
    assert.match(checksum, /^[0-9a-f]{64}$/);
    assert.equal(
      migrationChecksum(targetMigration.sql.replace(/\n/g, "\r\n")),
      checksum,
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

    const { rows: leaked } = await db.query(
      `select tablename from pg_tables
        where schemaname = 'public'
          and tablename like 'salary_advance_%'`,
    );
    assert.equal(leaked.length, 0);
  } finally {
    await db.close();
  }
});

test("(#2) Full W2S2 Salary Advance WP1 acceptance across all 7 mandatory verification areas", async () => {
  const { db, targetMigration, restMigrations } = await createPreWp1Database();
  try {
    await db.exec(targetMigration.sql);
    for (const m of restMigrations) {
      await db.exec(m.sql);
    }

    const repo = createPgliteSalaryAdvanceRepo(db);

    // =========================================================================
    // AREA 7: Database RLS / FORCE RLS / Zero PII Columns / RPC ACL / Triggers
    // =========================================================================
    for (const table of [
      "salary_advance_requests",
      "salary_advance_events",
      "salary_advance_idempotency",
    ]) {
      const { rows: rlsRows } = await db.query(
        `select c.relrowsecurity, c.relforcerowsecurity
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = $1`,
        [table],
      );
      assert.deepEqual(rlsRows[0], {
        relrowsecurity: true,
        relforcerowsecurity: true,
      });

      const { rows: polRows } = await db.query(
        `select count(*)::int as cnt from pg_policies
          where schemaname = 'public' and tablename = $1`,
        [table],
      );
      assert.equal(polRows[0].cnt, 0);

      for (const role of ["anon", "authenticated"]) {
        for (const priv of [
          "SELECT",
          "INSERT",
          "UPDATE",
          "DELETE",
          "TRUNCATE",
          "REFERENCES",
          "TRIGGER",
        ]) {
          const { rows: privRows } = await db.query(
            `select has_table_privilege($1, $2, $3) as allowed`,
            [role, `public.${table}`, priv],
          );
          assert.equal(
            privRows[0].allowed,
            false,
            `${role} must not have ${priv} on ${table}`,
          );
        }
      }
    }

    // Zero duplicated worker PII columns in salary_advance_requests & salary_advance_events
    const { rows: piiCols } = await db.query(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name in ('salary_advance_requests', 'salary_advance_events')
          and (
            column_name ilike '%worker_name%'
            or column_name ilike '%display_name%'
            or column_name ilike '%employee_code%'
            or column_name ilike '%national_id%'
            or column_name ilike '%cccd%'
            or column_name ilike '%phone%'
            or column_name ilike '%address%'
            or column_name ilike '%bank%'
          )`,
    );
    assert.deepEqual(
      piiCols,
      [],
      "salary_advance tables must store zero duplicated worker PII snapshot columns",
    );

    // RPC ACLs: all 13 public RPCs granted ONLY to service_role
    for (const sig of SALARY_ADVANCE_WP1_RPC_SIGNATURES) {
      const { rows } = await db.query(
        `select p.prosecdef,
                has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
                has_function_privilege('service_role', p.oid, 'EXECUTE') as srv_exec
           from pg_proc p
          where p.oid = $1::regprocedure`,
        [sig],
      );
      assert.deepEqual(rows[0], {
        prosecdef: true,
        pub_exec: false,
        anon_exec: false,
        auth_exec: false,
        srv_exec: true,
      });
    }

    // =========================================================================
    // SEED ACTORS, PROJECTS, PROJECT MANAGERS, ACCOUNTANTS & WORKERS
    // =========================================================================
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'TD_SAL_ADV_ALPHA', 'Nhóm Tuyển Dụng Alpha', true)
       on conflict (code) do nothing`,
      [TEAM_ALPHA],
    );

    for (const actor of [
      FULL_ADMIN,
      CANONICAL_BOD,
      PM_1,
      PM_1B,
      PM_2,
      ACCT_A,
      ACCT_B,
      VFIN_ONLY_ACTOR,
      VFIN_CASH_HOLDER_ACTOR,
    ]) {
      await db.query("insert into auth.users (id) values ($1::uuid)", [
        actor.auth,
      ]);
      await db.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
         values ($1::uuid, $2::uuid, true, $3)`,
        [actor.app, actor.auth, actor.name],
      );
    }

    // Full Admin grants
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_admin', '2026-01-01', true),
              ($1::uuid, 'recruiter_master_manage', '2026-01-01', true),
              ($1::uuid, 'team_master_manage', '2026-01-01', true),
              ($1::uuid, 'catalog_master_manage', '2026-01-01', true),
              ($1::uuid, 'document_upload', '2026-01-01', true),
              ($1::uuid, 'document_view', '2026-01-01', true)`,
      [FULL_ADMIN.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true)`,
      [FULL_ADMIN.app],
    );

    // Canonical BoD grants (`all` scope + `report_analytics_view` + `report_view`)
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'report_analytics_view', '2026-01-01', true),
              ($1::uuid, 'report_view', '2026-01-01', true)`,
      [CANONICAL_BOD.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true)`,
      [CANONICAL_BOD.app],
    );

    // VFIN-only actor grants (`vendor_finance_view`, `vendor_finance_record` @ `all` scope)
    // Must NEVER be misclassified as BoD or granted Salary Advance access!
    for (const vfinActor of [VFIN_ONLY_ACTOR, VFIN_CASH_HOLDER_ACTOR]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, 'vendor_finance_view', '2026-01-01', true),
                ($1::uuid, 'vendor_finance_record', '2026-01-01', true)`,
        [vfinActor.app],
      );
      await db.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
         values ($1::uuid, 'all', '2026-01-01', true)`,
        [vfinActor.app],
      );
    }

    // PMs capabilities for Direct Entry worker creation & portrait upload
    for (const pm of [PM_1, PM_1B, PM_2]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, 'entry_create', '2026-01-01', true),
                ($1::uuid, 'submission_create', '2026-01-01', true),
                ($1::uuid, 'entry_own', '2026-01-01', true),
                ($1::uuid, 'document_upload', '2026-01-01', true),
                ($1::uuid, 'document_view', '2026-01-01', true)`,
        [pm.app],
      );
      await db.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
         values ($1::uuid, 'own', '2026-01-01', true)`,
        [pm.app],
      );
    }

    // Recruiters & verified links
    for (const person of [
      PM_1,
      PM_1B,
      PM_2,
      ACCT_A,
      ACCT_B,
      VFIN_ONLY_ACTOR,
      VFIN_CASH_HOLDER_ACTOR,
    ]) {
      await db.query(
        `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
         values ($1::uuid, $2, $3, 'STAFF', true)`,
        [person.recruiter, person.name, person.code],
      );
      await db.query(
        `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
         values ($1::uuid, 'hrp', '2026-01-01', true)`,
        [person.recruiter],
      );
      await db.query(
        `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
         values ($1::uuid, $2::uuid, '2026-01-01', true)`,
        [person.recruiter, TEAM_ALPHA],
      );
      await db.query(
        `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
         values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
        [person.app, person.recruiter],
      );
    }

    // Projects
    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'Dự Án Miền Bắc', true, 1),
              ($2, 'Dự Án Miền Nam', true, 1),
              ($3, 'Dự Án Chưa Có Kế Toán', true, 1)`,
      [PRJ_1, PRJ_2, PRJ_NO_ACCT],
    );

    // Assign Project Managers:
    // PM_1 and PM_1B on PRJ_1; PM_1 on PRJ_NO_ACCT; PM_2 on PRJ_2
    await db.query(
      `insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current)
       values ($1, $2::uuid, '2026-01-01', true),
              ($1, $3::uuid, '2026-01-01', true),
              ($4, $2::uuid, '2026-01-01', true),
              ($5, $6::uuid, '2026-01-01', true)`,
      [PRJ_1, PM_1.recruiter, PM_1B.recruiter, PRJ_NO_ACCT, PRJ_2, PM_2.recruiter],
    );

    // Assign ACCT_A, ACCT_B, VFIN_ONLY_ACTOR, and VFIN_CASH_HOLDER_ACTOR to ACCOUNTING department
    for (const acct of [
      ACCT_A,
      ACCT_B,
      VFIN_ONLY_ACTOR,
      VFIN_CASH_HOLDER_ACTOR,
    ]) {
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

    // Grant VFIN_ONLY_ACTOR (`GLOBAL_RECONCILER`) and VFIN_CASH_HOLDER_ACTOR (`CASH_HOLDER`)
    for (const [targetActor, roleCode] of [
      [VFIN_ONLY_ACTOR, "GLOBAL_RECONCILER"],
      [VFIN_CASH_HOLDER_ACTOR, "CASH_HOLDER"],
    ]) {
      const reason = `Cấp quyền VFIN ${roleCode}`;
      await db.query(
        `select public.vendor_finance_assign_global_role_admin(
           $1::uuid, $2::uuid, $3::uuid, $4::text, 0, '2026-01-01'::date, $5::text, $6::uuid, $7::text
         )`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          targetActor.app,
          roleCode,
          reason,
          nextUuid(),
          computeAssignGlobalRoleFingerprint({
            account_ref: targetActor.app,
            role_code: roleCode,
            valid_from: "2026-01-01",
            expected_version: 0,
            reason,
          }),
        ],
      );
    }

    // Assign ACCT_A as Project Accountant for PRJ_1
    const assignAcctAReason = "Phân công Kế toán A phụ trách PRJ_1";
    const assignAcctARes = await db.query(
      `select public.vendor_finance_assign_project_accountant_admin(
         $1::uuid, $2::uuid, $3::text, $4::uuid, 0, '2026-01-01'::date, $5::text, $6::uuid, $7::text
       ) as data`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        PRJ_1,
        ACCT_A.app,
        assignAcctAReason,
        nextUuid(),
        computeAssignProjectAccountantFingerprint({
          project_id: PRJ_1,
          accountant_ref: ACCT_A.app,
          valid_from: "2026-01-01",
          expected_version: 0,
          reason: assignAcctAReason,
        }),
      ],
    );
    const acctAAssignmentId = assignAcctARes.rows[0].data.assignment_id;

    // Assign ACCT_B as Project Accountant for PRJ_2
    const assignAcctBPrj2Reason = "Phân công Kế toán B phụ trách PRJ_2";
    await db.query(
      `select public.vendor_finance_assign_project_accountant_admin(
         $1::uuid, $2::uuid, $3::text, $4::uuid, 0, '2026-01-01'::date, $5::text, $6::uuid, $7::text
       )`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        PRJ_2,
        ACCT_B.app,
        assignAcctBPrj2Reason,
        nextUuid(),
        computeAssignProjectAccountantFingerprint({
          project_id: PRJ_2,
          accountant_ref: ACCT_B.app,
          valid_from: "2026-01-01",
          expected_version: 0,
          reason: assignAcctBPrj2Reason,
        }),
      ],
    );

    // Seed SUBMITTED workers on PRJ_1 and PRJ_2, plus a DRAFT worker on PRJ_1
    const prj1Batch = await db.query(
      `select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as data`,
      [
        PM_1.auth,
        PM_1.app,
        JSON.stringify([
          {
            project_id: PRJ_1,
            first_work_date: "2026-10-01",
            employee_code: "hrp-2026-800001",
            worker_details: makeWorkerDetails("Nguyễn Công Nhân Bắc 1"),
            recruiter_id: PM_1.recruiter,
            labor_type: "TEMPORARY",
          },
          {
            project_id: PRJ_1,
            first_work_date: "2026-10-02",
            employee_code: "hrp-2026-800002",
            worker_details: makeWorkerDetails("Trần Công Nhân Bắc 2"),
            recruiter_id: PM_1.recruiter,
            labor_type: "TEMPORARY",
          },
        ]),
        "sal_adv_batch_prj1",
      ],
    );
    const prj1SubmissionId = prj1Batch.rows[0].data.submission_id;
    await db.query(
      `select public.direct_entry_transition_submission($1::uuid, $2::uuid, $3::uuid, 1, 'SUBMITTED', 'sal_adv_submit_prj1')`,
      [PM_1.auth, PM_1.app, prj1SubmissionId],
    );

    const { rows: prj1Entries } = await db.query(
      `select entry_id, employee_code from public.direct_entries
        where submission_id = $1::uuid order by employee_code`,
      [prj1SubmissionId],
    );
    const workerPrj1A = prj1Entries[0].entry_id;
    const workerPrj1B = prj1Entries[1].entry_id;

    // DRAFT worker on PRJ_1 (not yet SUBMITTED)
    const draftBatch = await db.query(
      `select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as data`,
      [
        PM_1.auth,
        PM_1.app,
        JSON.stringify([
          {
            project_id: PRJ_1,
            first_work_date: "2026-10-05",
            employee_code: "hrp-2026-800099",
            worker_details: makeWorkerDetails("Lê Công Nhân Nháp"),
            recruiter_id: PM_1.recruiter,
            labor_type: "TEMPORARY",
          },
        ]),
        "sal_adv_batch_draft",
      ],
    );
    const { rows: draftEntries } = await db.query(
      `select entry_id from public.direct_entries where submission_id = $1::uuid`,
      [draftBatch.rows[0].data.submission_id],
    );
    const draftWorkerPrj1 = draftEntries[0].entry_id;

    // SUBMITTED worker on PRJ_2
    const prj2Batch = await db.query(
      `select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as data`,
      [
        PM_2.auth,
        PM_2.app,
        JSON.stringify([
          {
            project_id: PRJ_2,
            first_work_date: "2026-10-03",
            employee_code: "hrp-2026-800003",
            worker_details: makeWorkerDetails("Phạm Công Nhân Nam 1"),
            recruiter_id: PM_2.recruiter,
            labor_type: "TEMPORARY",
          },
        ]),
        "sal_adv_batch_prj2",
      ],
    );
    await db.query(
      `select public.direct_entry_transition_submission($1::uuid, $2::uuid, $3::uuid, 1, 'SUBMITTED', 'sal_adv_submit_prj2')`,
      [PM_2.auth, PM_2.app, prj2Batch.rows[0].data.submission_id],
    );
    const { rows: prj2Entries } = await db.query(
      `select entry_id from public.direct_entries where submission_id = $1::uuid`,
      [prj2Batch.rows[0].data.submission_id],
    );
    const workerPrj2 = prj2Entries[0].entry_id;

    // =========================================================================
    // AREA 1: Authorization Matrix & VFIN Non-Escalation Guard
    // =========================================================================
    for (const vfinActor of [VFIN_ONLY_ACTOR, VFIN_CASH_HOLDER_ACTOR]) {
      const { rows: internalAuthRows } = await db.query(
        `select public.salary_advance__internal_resolve_authority($1::uuid, $2::uuid) as auth`,
        [vfinActor.auth, vfinActor.app],
      );
      assert.deepEqual(
        {
          allowed: internalAuthRows[0].auth.allowed,
          is_project_manager: internalAuthRows[0].auth.is_project_manager,
          is_project_accountant: internalAuthRows[0].auth.is_project_accountant,
          is_supervisory_viewer: internalAuthRows[0].auth.is_supervisory_viewer,
          is_full_admin: internalAuthRows[0].auth.is_full_admin,
          is_bod: internalAuthRows[0].auth.is_bod,
        },
        {
          allowed: false,
          is_project_manager: false,
          is_project_accountant: false,
          is_supervisory_viewer: false,
          is_full_admin: false,
          is_bod: false,
        },
      );

      const vfinOnlyCtx = await repo.getActorContext({
        auth_subject: vfinActor.auth,
        app_user_id: vfinActor.app,
      });
      assert.deepEqual(vfinOnlyCtx, {
        ok: false,
        code: "SALARY_ADVANCE_ACCESS_DENIED",
      });

      const vfinOnlyList = await repo.listRequests({
        auth_subject: vfinActor.auth,
        app_user_id: vfinActor.app,
        queue: "ALL",
        project_id: null,
        request_state: null,
        evidence_review_state: null,
        search: null,
        cursor: null,
        page_size: 25,
      });
      assert.deepEqual(vfinOnlyList, {
        ok: false,
        code: "SALARY_ADVANCE_ACCESS_DENIED",
      });
    }

    // PM_1 can list SUBMITTED workers on PRJ_1 (excluding DRAFT worker)
    const pm1Workers = await repo.listProjectWorkers({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      search: null,
      cursor: null,
      page_size: 25,
    });
    assert.equal(pm1Workers.ok, true);
    if (pm1Workers.ok) {
      assert.equal(pm1Workers.data.workers.length, 2);
      assert.deepEqual(
        pm1Workers.data.workers.map((w) => w.worker_entry_id),
        [workerPrj1A, workerPrj1B],
      );
    }

    // PM_1 denied listing workers on PRJ_2
    const pm1WrongPrjWorkers = await repo.listProjectWorkers({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_2,
      search: null,
      cursor: null,
      page_size: 25,
    });
    assert.deepEqual(pm1WrongPrjWorkers, {
      ok: false,
      code: "SALARY_ADVANCE_ACCESS_DENIED",
    });

    // PM_1 denied creating request on PRJ_2
    const createWrongPrj = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_2,
      worker_entry_id: workerPrj2,
      requested_amount_vnd: "2000000",
      initial_content: "Ứng lương trái dự án",
      idempotency_key: "idem-wrong-prj-01",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_2,
        worker_entry_id: workerPrj2,
        requested_amount_vnd: "2000000",
        initial_content: "Ứng lương trái dự án",
      }),
    });
    assert.deepEqual(createWrongPrj, {
      ok: false,
      code: "SALARY_ADVANCE_ACCESS_DENIED",
    });

    // PM_1 denied creating request on PRJ_1 for worker belonging to PRJ_2
    const createMismatchWorker = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj2,
      requested_amount_vnd: "2000000",
      initial_content: "Ứng lương sai NLĐ",
      idempotency_key: "idem-mismatch-worker-01",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj2,
        requested_amount_vnd: "2000000",
        initial_content: "Ứng lương sai NLĐ",
      }),
    });
    assert.deepEqual(createMismatchWorker, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_PROJECT_MISMATCH",
    });

    // PM_1 denied creating request for DRAFT worker
    const createDraftWorker = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: draftWorkerPrj1,
      requested_amount_vnd: "2000000",
      initial_content: "Ứng lương NLĐ nháp",
      idempotency_key: "idem-draft-worker-01",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: draftWorkerPrj1,
        requested_amount_vnd: "2000000",
        initial_content: "Ứng lương NLĐ nháp",
      }),
    });
    assert.deepEqual(createDraftWorker, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_NOT_FOUND",
    });

    // PM_1 denied creating request on PRJ_NO_ACCT (no active project accountant)
    const createNoAcctPrj = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_NO_ACCT,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "2000000",
      initial_content: "Dự án chưa có kế toán",
      idempotency_key: "idem-no-acct-prj-01",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_NO_ACCT,
        worker_entry_id: workerPrj1A,
        requested_amount_vnd: "2000000",
        initial_content: "Dự án chưa có kế toán",
      }),
    });
    assert.deepEqual(createNoAcctPrj, {
      ok: false,
      code: "SALARY_ADVANCE_PROJECT_ACCOUNTANT_UNASSIGNED",
    });

    // =========================================================================
    // AREA 4: Positive Integer VND Amounts (No Business Cap) & Idempotency
    // =========================================================================
    for (const badAmount of ["0", "-500000", "12.34", "9223372036854775808"]) {
      const badRes = await repo.createRequest({
        auth_subject: PM_1.auth,
        app_user_id: PM_1.app,
        project_id: PRJ_1,
        worker_entry_id: workerPrj1A,
        requested_amount_vnd: badAmount,
        initial_content: "Số tiền không hợp lệ",
        idempotency_key: `idem-bad-amt-${badAmount}`,
        request_fingerprint: computeCreateRequestFingerprint({
          project_id: PRJ_1,
          worker_entry_id: workerPrj1A,
          requested_amount_vnd: badAmount,
          initial_content: "Số tiền không hợp lệ",
        }),
      });
      assert.deepEqual(badRes, {
        ok: false,
        code: "SALARY_ADVANCE_AMOUNT_INVALID",
      });
    }

    // Create main request with large positive amount (e.g. 250,000,000 VND — no business cap)
    const createFp1 = computeCreateRequestFingerprint({
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "250000000",
      initial_content: "Ứng lương đợt 1 cho công nhân Bắc 1",
    });
    const created1 = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "250000000",
      initial_content: "Ứng lương đợt 1 cho công nhân Bắc 1",
      idempotency_key: "idem-create-req-001",
      request_fingerprint: createFp1,
    });
    assert.equal(created1.ok, true);
    assert.equal(created1.data.replayed, false);
    assert.equal(created1.data.request.requested_amount_vnd, "250000000");
    assert.equal(created1.data.request.request_state, "OPEN");
    assert.equal(created1.data.request.evidence_review_state, "NOT_UPLOADED");
    assert.equal(created1.data.request.version, 1);
    assert.equal(created1.data.request.worker_employee_code, "hrp-2026-800001");
    assert.equal(
      created1.data.request.worker_display_name,
      "Nguyễn Công Nhân Bắc 1",
    );
    const req1Id = created1.data.request.request_id;

    // Idempotent replay with same key & payload returns replayed: true
    const created1Replay = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "250000000",
      initial_content: "Ứng lương đợt 1 cho công nhân Bắc 1",
      idempotency_key: "idem-create-req-001",
      request_fingerprint: createFp1,
    });
    assert.equal(created1Replay.ok, true);
    assert.equal(created1Replay.data.replayed, true);
    assert.equal(created1Replay.data.request.request_id, req1Id);

    // Same idempotency key with different payload -> 409 SALARY_ADVANCE_IDEMPOTENCY_CONFLICT
    const created1Conflict = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "300000000",
      initial_content: "Ứng lương đợt 1 cho công nhân Bắc 1",
      idempotency_key: "idem-create-req-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1A,
        requested_amount_vnd: "300000000",
        initial_content: "Ứng lương đợt 1 cho công nhân Bắc 1",
      }),
    });
    assert.deepEqual(created1Conflict, {
      ok: false,
      code: "SALARY_ADVANCE_IDEMPOTENCY_CONFLICT",
    });

    // PM_1B (another manager on PRJ_1, not creator of req1Id) cannot view or mutate req1Id
    const pm1bRead = await repo.getRequestDetail({
      auth_subject: PM_1B.auth,
      app_user_id: PM_1B.app,
      request_id: req1Id,
    });
    assert.deepEqual(pm1bRead, {
      ok: false,
      code: "SALARY_ADVANCE_ACCESS_DENIED",
    });

    // Supervisory viewers (FULL_ADMIN & CANONICAL_BOD) can view req1Id, but CANNOT mutate/approve
    for (const sup of [FULL_ADMIN, CANONICAL_BOD]) {
      const supCtx = await repo.getActorContext({
        auth_subject: sup.auth,
        app_user_id: sup.app,
      });
      assert.equal(supCtx.ok, true);
      assert.equal(supCtx.data.is_supervisory_viewer, true);

      const supDetail = await repo.getRequestDetail({
        auth_subject: sup.auth,
        app_user_id: sup.app,
        request_id: req1Id,
      });
      assert.equal(supDetail.ok, true);
      assert.deepEqual(supDetail.data.request.allowed_actions, {
        can_post_message: false,
        can_provide_info: false,
        can_withdraw: false,
        can_upload_evidence: false,
        can_request_info: false,
        can_approve: false,
        can_reject: false,
        can_mark_handled_externally: false,
        can_review_evidence: false,
      });

      const supApprove = await repo.transitionRequest({
        auth_subject: sup.auth,
        app_user_id: sup.app,
        request_id: req1Id,
        action: "APPROVE",
        expected_version: 1,
        message_text: null,
        idempotency_key: `idem-sup-approve-${sup.app}`,
        request_fingerprint: computeTransitionRequestFingerprint({
          request_id: req1Id,
          action: "APPROVE",
          expected_version: 1,
          message_text: null,
        }),
      });
      assert.deepEqual(supApprove, {
        ok: false,
        code: "SALARY_ADVANCE_ACCESS_DENIED",
      });
    }

    // =========================================================================
    // AREA 2: State Machine (OPEN -> NEEDS_INFO -> OPEN -> APPROVED)
    // =========================================================================
    // Evidence upload BEFORE APPROVED must be rejected
    const earlyReserve = await repo.reserveEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      expected_version: 1,
      mime_type: "image/jpeg",
      size_bytes: 1024,
      checksum_sha256: "a".repeat(64),
      caption_note: null,
      idempotency_key: "idem-early-reserve-01",
      request_fingerprint: computeReserveEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 1,
        mime_type: "image/jpeg",
        size_bytes: 1024,
        checksum_sha256: "a".repeat(64),
        caption_note: null,
      }),
    });
    assert.deepEqual(earlyReserve, {
      ok: false,
      code: "SALARY_ADVANCE_STATE_CONFLICT",
    });

    // ACCT_A requests info (OPEN -> NEEDS_INFO, version 1 -> 2)
    const reqInfoRes = await repo.transitionRequest({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      request_id: req1Id,
      action: "REQUEST_INFO",
      expected_version: 1,
      message_text: "Đề nghị QLDA xác nhận lại bảng chấm công tuần 1",
      idempotency_key: "idem-acct-a-req-info-01",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req1Id,
        action: "REQUEST_INFO",
        expected_version: 1,
        message_text: "Đề nghị QLDA xác nhận lại bảng chấm công tuần 1",
      }),
    });
    assert.equal(reqInfoRes.ok, true);
    assert.equal(reqInfoRes.data.request.request_state, "NEEDS_INFO");
    assert.equal(reqInfoRes.data.request.version, 2);

    // PM_1 provides info (NEEDS_INFO -> OPEN, version 2 -> 3)
    const provideInfoRes = await repo.transitionRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      action: "PROVIDE_INFO",
      expected_version: 2,
      message_text: "Đã đối chiếu đủ 6 công tuần 1",
      idempotency_key: "idem-pm1-provide-info-01",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req1Id,
        action: "PROVIDE_INFO",
        expected_version: 2,
        message_text: "Đã đối chiếu đủ 6 công tuần 1",
      }),
    });
    assert.equal(provideInfoRes.ok, true);
    assert.equal(provideInfoRes.data.request.request_state, "OPEN");
    assert.equal(provideInfoRes.data.request.version, 3);

    // =========================================================================
    // AREA 1 (cont.): Project Accountant Handover (ACCT_A -> ACCT_B on PRJ_1)
    // =========================================================================
    const endAcctAReason = "Bàn giao dự án Bắc từ Kế toán A sang Kế toán B";
    await db.query(
      `select public.vendor_finance_end_project_accountant_admin(
         $1::uuid, $2::uuid, $3::uuid, 1, '2026-06-01'::date, $4::text, $5::uuid, $6::text
       )`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        acctAAssignmentId,
        endAcctAReason,
        nextUuid(),
        computeEndProjectAccountantFingerprint({
          assignment_id: acctAAssignmentId,
          expected_version: 1,
          valid_to: "2026-06-01",
          reason: endAcctAReason,
        }),
      ],
    );

    const assignAcctBPrj1Reason = "Phân công Kế toán B tiếp nhận PRJ_1";
    await db.query(
      `select public.vendor_finance_assign_project_accountant_admin(
         $1::uuid, $2::uuid, $3::text, $4::uuid, 1, '2026-06-01'::date, $5::text, $6::uuid, $7::text
       )`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        PRJ_1,
        ACCT_B.app,
        assignAcctBPrj1Reason,
        nextUuid(),
        computeAssignProjectAccountantFingerprint({
          project_id: PRJ_1,
          accountant_ref: ACCT_B.app,
          valid_from: "2026-06-01",
          expected_version: 1,
          reason: assignAcctBPrj1Reason,
        }),
      ],
    );

    // ACCT_A immediately loses access to PRJ_1 requests
    const acctADenied = await repo.getRequestDetail({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      request_id: req1Id,
    });
    assert.deepEqual(acctADenied, {
      ok: false,
      code: "SALARY_ADVANCE_ACCESS_DENIED",
    });

    // ACCT_B now sees and approves req1Id (OPEN -> APPROVED, version 3 -> 4),
    // while ACCT_A's historical INFO_REQUESTED event still preserves ACCT_A's identity!
    const approveRes = await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      action: "APPROVE",
      expected_version: 3,
      message_text: null,
      idempotency_key: "idem-acct-b-approve-01",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req1Id,
        action: "APPROVE",
        expected_version: 3,
        message_text: null,
      }),
    });
    assert.equal(approveRes.ok, true);
    assert.equal(approveRes.data.request.request_state, "APPROVED");
    assert.equal(approveRes.data.request.evidence_review_state, "NOT_UPLOADED");
    assert.equal(approveRes.data.request.version, 4);
    assert.equal(approveRes.data.request.decided_by_user_id, ACCT_B.app);

    const infoRequestedEvent = approveRes.data.events.find(
      (ev) => ev.event_type === "INFO_REQUESTED",
    );
    assert.ok(infoRequestedEvent);
    assert.equal(infoRequestedEvent.actor_user_id, ACCT_A.app);
    assert.equal(infoRequestedEvent.actor_display_name, ACCT_A.name);

    // After APPROVED, QLDA cannot withdraw
    const withdrawAfterApproved = await repo.transitionRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      action: "WITHDRAW",
      expected_version: 4,
      message_text: "Muốn rút sau khi đã duyệt",
      idempotency_key: "idem-withdraw-after-approve",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req1Id,
        action: "WITHDRAW",
        expected_version: 4,
        message_text: "Muốn rút sau khi đã duyệt",
      }),
    });
    assert.deepEqual(withdrawAfterApproved, {
      ok: false,
      code: "SALARY_ADVANCE_STATE_CONFLICT",
    });

    // =========================================================================
    // AREA 3, 5 & 6: Cash-Receipt Evidence Versioning, Superseded Race & 4-Way Portrait Lock
    // =========================================================================
    // Reserve Attempt 1 (will be superseded by Attempt 2 before finalizing)
    const reserve1 = await repo.reserveEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      expected_version: 4,
      mime_type: "image/jpeg",
      size_bytes: 2048,
      checksum_sha256: "1".repeat(64),
      caption_note: "Ảnh lần 1 (bị thay thế)",
      idempotency_key: "idem-reserve-ev-01",
      request_fingerprint: computeReserveEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 4,
        mime_type: "image/jpeg",
        size_bytes: 2048,
        checksum_sha256: "1".repeat(64),
        caption_note: "Ảnh lần 1 (bị thay thế)",
      }),
    });
    assert.equal(reserve1.ok, true);
    assert.equal(reserve1.data.superseded_storage_key, null);

    // Reserve Attempt 2 on same version 4 -> supersedes Attempt 1
    const reserve2 = await repo.reserveEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      expected_version: 4,
      mime_type: "image/jpeg",
      size_bytes: 4096,
      checksum_sha256: "2".repeat(64),
      caption_note: "Ảnh nhận tiền đợt 1 (v1)",
      idempotency_key: "idem-reserve-ev-02",
      request_fingerprint: computeReserveEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 4,
        mime_type: "image/jpeg",
        size_bytes: 4096,
        checksum_sha256: "2".repeat(64),
        caption_note: "Ảnh nhận tiền đợt 1 (v1)",
      }),
    });
    assert.equal(reserve2.ok, true);
    assert.equal(
      reserve2.data.superseded_storage_key,
      reserve1.data.storage_key,
    );

    // Attempt 1 tries to finalize -> rejected with 409 SALARY_ADVANCE_UPLOAD_SUPERSEDED
    const finalizeSuperseded = await repo.getEvidenceFinalizeContext({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      upload_id: reserve1.data.upload_id,
      expected_version: 4,
      idempotency_key: "idem-finalize-ev-01",
      request_fingerprint: computeFinalizeEvidenceFingerprint({
        request_id: req1Id,
        upload_id: reserve1.data.upload_id,
        expected_version: 4,
      }),
    });
    assert.deepEqual(finalizeSuperseded, {
      ok: false,
      code: "SALARY_ADVANCE_UPLOAD_SUPERSEDED",
    });

    // Attempt 2 finalizes -> commits evidence_version = 1, version 4 -> 5,
    // evidence_review_state = 'PENDING_REVIEW', request_state stays 'APPROVED'
    const finalize2Fp = computeFinalizeEvidenceFingerprint({
      request_id: req1Id,
      upload_id: reserve2.data.upload_id,
      expected_version: 4,
    });
    const finalize2Res = await repo.finalizeEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      upload_id: reserve2.data.upload_id,
      expected_version: 4,
      idempotency_key: "idem-finalize-ev-02",
      request_fingerprint: finalize2Fp,
    });
    assert.equal(finalize2Res.ok, true);
    assert.equal(finalize2Res.data.request.request_state, "APPROVED");
    assert.equal(
      finalize2Res.data.request.evidence_review_state,
      "PENDING_REVIEW",
    );
    assert.equal(finalize2Res.data.request.version, 5);
    assert.equal(
      finalize2Res.data.request.current_evidence?.evidence_version,
      1,
    );
    assert.equal(finalize2Res.data.evidence_versions.length, 1);

    // ACCT_B marks evidence RETAKE_REQUIRED with optional note = null (version 5 -> 6)
    // request_state stays APPROVED!
    const retakeRes = await repo.reviewEvidence({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      expected_version: 5,
      evidence_version: 1,
      decision: "RETAKE_REQUIRED",
      expected_worker_portrait_document_id: null,
      expected_worker_portrait_version: null,
      note: null,
      idempotency_key: "idem-review-retake-01",
      request_fingerprint: computeReviewEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 5,
        evidence_version: 1,
        decision: "RETAKE_REQUIRED",
        expected_worker_portrait_document_id: null,
        expected_worker_portrait_version: null,
        note: null,
      }),
    });
    assert.equal(retakeRes.ok, true);
    assert.equal(retakeRes.data.request.request_state, "APPROVED");
    assert.equal(
      retakeRes.data.request.evidence_review_state,
      "RETAKE_REQUIRED",
    );
    assert.equal(retakeRes.data.request.version, 6);

    // PM_1 uploads replacement evidence -> creates evidence_version = 2, preserves version 1 in history!
    const reserveV2 = await repo.reserveEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      expected_version: 6,
      mime_type: "image/png",
      size_bytes: 5120,
      checksum_sha256: "3".repeat(64),
      caption_note: "Ảnh chụp lại rõ mặt NLĐ (v2)",
      idempotency_key: "idem-reserve-ev-v2",
      request_fingerprint: computeReserveEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 6,
        mime_type: "image/png",
        size_bytes: 5120,
        checksum_sha256: "3".repeat(64),
        caption_note: "Ảnh chụp lại rõ mặt NLĐ (v2)",
      }),
    });
    assert.equal(reserveV2.ok, true);

    const finalizeV2 = await repo.finalizeEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      upload_id: reserveV2.data.upload_id,
      expected_version: 6,
      idempotency_key: "idem-finalize-ev-v2",
      request_fingerprint: computeFinalizeEvidenceFingerprint({
        request_id: req1Id,
        upload_id: reserveV2.data.upload_id,
        expected_version: 6,
      }),
    });
    assert.equal(finalizeV2.ok, true);
    assert.equal(finalizeV2.data.request.request_state, "APPROVED");
    assert.equal(
      finalizeV2.data.request.evidence_review_state,
      "PENDING_REVIEW",
    );
    assert.equal(finalizeV2.data.request.version, 7);
    assert.equal(
      finalizeV2.data.request.current_evidence?.evidence_version,
      2,
    );
    assert.deepEqual(
      finalizeV2.data.evidence_versions.map((v) => v.evidence_version),
      [2, 1],
    );

    // Both version 1 and version 2 can be previewed by ACCT_B
    const previewV1 = await repo.getEvidencePreviewContext({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      evidence_version: 1,
    });
    assert.equal(previewV1.ok, true);
    assert.equal(previewV1.data.storage_key, reserve2.data.storage_key);

    const previewV2 = await repo.getEvidencePreviewContext({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      evidence_version: 2,
    });
    assert.equal(previewV2.ok, true);
    assert.equal(previewV2.data.storage_key, reserveV2.data.storage_key);

    // Reviewing as REVIEWED when worker has NO portrait yet -> 409 SALARY_ADVANCE_WORKER_PORTRAIT_MISSING
    const dummyPortraitId = nextUuid();
    const reviewNoPortrait = await repo.reviewEvidence({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      expected_version: 7,
      evidence_version: 2,
      decision: "REVIEWED",
      expected_worker_portrait_document_id: dummyPortraitId,
      expected_worker_portrait_version: 1,
      note: null,
      idempotency_key: "idem-review-no-portrait",
      request_fingerprint: computeReviewEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 7,
        evidence_version: 2,
        decision: "REVIEWED",
        expected_worker_portrait_document_id: dummyPortraitId,
        expected_worker_portrait_version: 1,
        note: null,
      }),
    });
    assert.deepEqual(reviewNoPortrait, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_PORTRAIT_MISSING",
    });

    // Upload worker portrait v1 for workerPrj1A
    const portraitV1 = await seedWorkerPortraitVersion(
      db,
      PM_1,
      workerPrj1A,
      "b",
    );
    assert.equal(portraitV1.version, 1);

    // Rotate worker portrait to v2 BEFORE ACCT_B submits REVIEWED with v1 lock
    const portraitV2 = await seedWorkerPortraitVersion(
      db,
      PM_1,
      workerPrj1A,
      "c",
    );
    assert.equal(portraitV2.version, 2);

    // ACCT_B tries to review with stale portrait v1 lock -> 409 SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT
    const reviewStalePortrait = await repo.reviewEvidence({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      expected_version: 7,
      evidence_version: 2,
      decision: "REVIEWED",
      expected_worker_portrait_document_id: portraitV1.document_id,
      expected_worker_portrait_version: 1,
      note: null,
      idempotency_key: "idem-review-stale-portrait",
      request_fingerprint: computeReviewEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 7,
        evidence_version: 2,
        decision: "REVIEWED",
        expected_worker_portrait_document_id: portraitV1.document_id,
        expected_worker_portrait_version: 1,
        note: null,
      }),
    });
    assert.deepEqual(reviewStalePortrait, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT",
    });

    // Worker portrait context with stale expected_document_id also returns 409 conflict
    const portraitCtxStale = await repo.getWorkerPortraitContext({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      expected_document_id: portraitV1.document_id,
    });
    assert.deepEqual(portraitCtxStale, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT",
    });

    // Worker portrait context with current portraitV2 succeeds for ACCT_B
    const portraitCtxOk = await repo.getWorkerPortraitContext({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      expected_document_id: portraitV2.document_id,
    });
    assert.equal(portraitCtxOk.ok, true);
    assert.equal(portraitCtxOk.data.document_id, portraitV2.document_id);
    assert.equal(portraitCtxOk.data.version, 2);

    // ACCT_B reviews evidence v2 with matching portraitV2 lock (note = null) -> REVIEWED!
    // request_state stays APPROVED!
    const reviewedOk = await repo.reviewEvidence({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      expected_version: 7,
      evidence_version: 2,
      decision: "REVIEWED",
      expected_worker_portrait_document_id: portraitV2.document_id,
      expected_worker_portrait_version: 2,
      note: null,
      idempotency_key: "idem-review-ok-v2",
      request_fingerprint: computeReviewEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 7,
        evidence_version: 2,
        decision: "REVIEWED",
        expected_worker_portrait_document_id: portraitV2.document_id,
        expected_worker_portrait_version: 2,
        note: null,
      }),
    });
    assert.equal(reviewedOk.ok, true);
    assert.equal(reviewedOk.data.request.request_state, "APPROVED");
    assert.equal(reviewedOk.data.request.evidence_review_state, "REVIEWED");
    assert.equal(reviewedOk.data.request.version, 8);
    assert.equal(
      reviewedOk.data.request.current_evidence
        ?.reviewed_worker_portrait_document_id,
      portraitV2.document_id,
    );
    assert.equal(
      reviewedOk.data.request.current_evidence
        ?.reviewed_worker_portrait_version,
      2,
    );

    // ACCT_B marks request HANDLED_EXTERNALLY (APPROVED -> HANDLED_EXTERNALLY, version 8 -> 9)
    const handledRes = await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      action: "MARK_HANDLED_EXTERNALLY",
      expected_version: 8,
      message_text: "Đã tất toán trên phần mềm kế toán ngoài BI",
      idempotency_key: "idem-handled-ext-01",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req1Id,
        action: "MARK_HANDLED_EXTERNALLY",
        expected_version: 8,
        message_text: "Đã tất toán trên phần mềm kế toán ngoài BI",
      }),
    });
    assert.equal(handledRes.ok, true);
    assert.equal(handledRes.data.request.request_state, "HANDLED_EXTERNALLY");
    assert.equal(handledRes.data.request.evidence_review_state, "REVIEWED");
    assert.equal(handledRes.data.request.version, 9);

    // Additional requests to test REJECT (requires reason) and WITHDRAW (before decision)
    // plus MAX_PG_BIGINT amount support
    const created2 = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1B,
      requested_amount_vnd: MAX_PG_BIGINT.toString(),
      initial_content: "Ứng lương kiểm tra số tiền lớn nhất bigint",
      idempotency_key: "idem-create-req-002",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1B,
        requested_amount_vnd: MAX_PG_BIGINT.toString(),
        initial_content: "Ứng lương kiểm tra số tiền lớn nhất bigint",
      }),
    });
    assert.equal(created2.ok, true);
    assert.equal(
      created2.data.request.requested_amount_vnd,
      MAX_PG_BIGINT.toString(),
    );
    const req2Id = created2.data.request.request_id;

    // REJECT without reason fails with SALARY_ADVANCE_REASON_REQUIRED
    const rejectNoReason = await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req2Id,
      action: "REJECT",
      expected_version: 1,
      message_text: null,
      idempotency_key: "idem-reject-no-reason",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req2Id,
        action: "REJECT",
        expected_version: 1,
        message_text: null,
      }),
    });
    assert.deepEqual(rejectNoReason, {
      ok: false,
      code: "SALARY_ADVANCE_REASON_REQUIRED",
    });

    // REJECT with reason transitions OPEN -> REJECTED
    const rejectOk = await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req2Id,
      action: "REJECT",
      expected_version: 1,
      message_text: "Chưa đủ ngày công thực tế trong kỳ",
      idempotency_key: "idem-reject-ok-01",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req2Id,
        action: "REJECT",
        expected_version: 1,
        message_text: "Chưa đủ ngày công thực tế trong kỳ",
      }),
    });
    assert.equal(rejectOk.ok, true);
    assert.equal(rejectOk.data.request.request_state, "REJECTED");

    // Request 3: QLDA withdraws before decision (OPEN -> WITHDRAWN)
    const created3 = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1B,
      requested_amount_vnd: "3000000",
      initial_content: "Ứng lương sẽ rút trước khi duyệt",
      idempotency_key: "idem-create-req-003",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1B,
        requested_amount_vnd: "3000000",
        initial_content: "Ứng lương sẽ rút trước khi duyệt",
      }),
    });
    assert.equal(created3.ok, true);
    const req3Id = created3.data.request.request_id;

    // Accountant cannot withdraw
    const acctWithdraw = await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req3Id,
      action: "WITHDRAW",
      expected_version: 1,
      message_text: null,
      idempotency_key: "idem-acct-withdraw-denied",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req3Id,
        action: "WITHDRAW",
        expected_version: 1,
        message_text: null,
      }),
    });
    assert.deepEqual(acctWithdraw, {
      ok: false,
      code: "SALARY_ADVANCE_ACCESS_DENIED",
    });

    // Creating QLDA withdraws before decision -> WITHDRAWN
    const pmWithdraw = await repo.transitionRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req3Id,
      action: "WITHDRAW",
      expected_version: 1,
      message_text: "NLĐ báo không cần ứng nữa",
      idempotency_key: "idem-pm-withdraw-ok",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req3Id,
        action: "WITHDRAW",
        expected_version: 1,
        message_text: "NLĐ báo không cần ứng nữa",
      }),
    });
    assert.equal(pmWithdraw.ok, true);
    assert.equal(pmWithdraw.data.request.request_state, "WITHDRAWN");

    // =========================================================================
    // HOTFIX VERIFICATION: Unified Actor Display Name Resolution
    //   1. Verified current linked recruiter display_name wins over login-id in
    //      direct_entry_app_users.display_name (e.g. 'yenlh.td' -> 'QLDA Dự Án Bắc 01').
    //   2. Unlinked account falls back to direct_entry_app_users.display_name.
    //   3. Blank or UUID direct_entry_app_users.display_name falls back to
    //      auth.users email local-part login_id (and never raw UUID).
    // =========================================================================
    await db.exec("alter table auth.users add column if not exists email text;");
    await db.query(
      "update auth.users set email = 'yenlh.td@hrpvietnam.com' where id = $1::uuid",
      [PM_1.auth],
    );
    await db.query(
      "update public.direct_entry_app_users set display_name = 'yenlh.td' where app_user_id = $1::uuid",
      [PM_1.app],
    );
    await db.query(
      "update auth.users set email = 'ketoan.b@hrpvietnam.com' where id = $1::uuid",
      [ACCT_B.auth],
    );
    await db.query(
      "update public.direct_entry_app_users set display_name = 'ketoan.b' where app_user_id = $1::uuid",
      [ACCT_B.app],
    );

    const pm1ContextAfterLoginId = await repo.getActorContext({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
    });
    assert.equal(pm1ContextAfterLoginId.ok, true);
    assert.equal(
      pm1ContextAfterLoginId.data.display_name,
      PM_1.name,
      "Actor context must resolve verified current linked recruiter name instead of account login-id display_name",
    );
    const prj1InContext = pm1ContextAfterLoginId.data.managed_projects.find(
      (p) => p.project_id === PRJ_1,
    );
    assert.equal(
      prj1InContext?.accountant_display_name,
      ACCT_B.name,
      "Managed project accountant_display_name must resolve verified current linked recruiter name",
    );

    const detailAfterLoginId = await repo.getRequestDetail({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
    });
    assert.equal(detailAfterLoginId.ok, true);
    assert.equal(
      detailAfterLoginId.data.request.created_by_display_name,
      PM_1.name,
      "Request created_by_display_name must resolve verified current linked recruiter name instead of 'yenlh.td'",
    );
    assert.equal(
      detailAfterLoginId.data.request.current_project_accountant?.display_name,
      ACCT_B.name,
      "Request current_project_accountant.display_name must resolve verified current linked recruiter name",
    );
    assert.equal(
      detailAfterLoginId.data.request.current_evidence?.uploaded_by_display_name,
      PM_1.name,
      "Evidence uploaded_by_display_name must resolve verified current linked recruiter name",
    );
    assert.equal(
      detailAfterLoginId.data.request.current_evidence?.reviewed_by_display_name,
      ACCT_B.name,
      "Evidence reviewed_by_display_name must resolve verified current linked recruiter name",
    );
    assert.ok(
      detailAfterLoginId.data.events.every(
        (ev) =>
          ev.actor_display_name === PM_1.name ||
          ev.actor_display_name === ACCT_A.name ||
          ev.actor_display_name === ACCT_B.name,
      ),
      "Timeline events must resolve verified current linked recruiter names consistently",
    );

    // Fallback tier 2 & 3 check on unlinked account (FULL_ADMIN has no recruiter link)
    await db.query(
      "update auth.users set email = 'admin.bi@hrpvietnam.com' where id = $1::uuid",
      [FULL_ADMIN.auth],
    );
    await db.query(
      "update public.direct_entry_app_users set display_name = $1 where app_user_id = $1::uuid",
      [FULL_ADMIN.app],
    );
    const adminCtxWithUuidDisplayName = await repo.getActorContext({
      auth_subject: FULL_ADMIN.auth,
      app_user_id: FULL_ADMIN.app,
    });
    assert.equal(adminCtxWithUuidDisplayName.ok, true);
    assert.equal(
      adminCtxWithUuidDisplayName.data.display_name,
      "admin.bi",
      "When unlinked and u.display_name is a raw UUID, actor display name must fall back to auth.users login_id ('admin.bi')",
    );

    // =========================================================================
    // HOTFIX VERIFICATION: Payment Method (CASH vs BANK_TRANSFER), Self-Owned
    // Bank Account Validation, Snapshot Immutability & Receipt Review
    // =========================================================================
    await db.query(
      `insert into public.direct_entry_banks (bank_id, display_name, active)
       values ('VCB_SAL_ADV', 'Vietcombank', true)
       on conflict (bank_id) do nothing`,
    );

    // 1. Creating BANK_TRANSFER when worker has no bank account fails with SALARY_ADVANCE_BANK_ACCOUNT_MISSING
    const bankMissingRes = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1B,
      requested_amount_vnd: "2000000",
      payment_method: "BANK_TRANSFER",
      initial_content: "Ứng lương chuyển khoản khi chưa có TK",
      idempotency_key: "idem-bank-missing-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1B,
        requested_amount_vnd: "2000000",
        payment_method: "BANK_TRANSFER",
        initial_content: "Ứng lương chuyển khoản khi chưa có TK",
      }),
    });
    assert.deepEqual(bankMissingRes, {
      ok: false,
      code: "SALARY_ADVANCE_BANK_ACCOUNT_MISSING",
    });

    // 2. Non-self-owned bank account (holder name != worker display_name) fails with SALARY_ADVANCE_BANK_ACCOUNT_NOT_SELF_OWNED
    await db.query(
      `insert into public.direct_entry_payments (entry_id, state, account_number, bank_id, account_holder_name, version)
       values ($1::uuid, 'provided', '0123456789', 'VCB_SAL_ADV', 'NGUYEN VAN NGUOI KHAC', 1)
       on conflict (entry_id) do update
         set state = 'provided',
             account_number = excluded.account_number,
             bank_id = excluded.bank_id,
             account_holder_name = excluded.account_holder_name,
             version = public.direct_entry_payments.version + 1`,
      [workerPrj1B],
    );

    const bankNotSelfOwnedRes = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1B,
      requested_amount_vnd: "2000000",
      payment_method: "BANK_TRANSFER",
      initial_content: "Ứng lương chuyển khoản không chính chủ",
      idempotency_key: "idem-bank-not-self-owned-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1B,
        requested_amount_vnd: "2000000",
        payment_method: "BANK_TRANSFER",
        initial_content: "Ứng lương chuyển khoản không chính chủ",
      }),
    });
    assert.deepEqual(bankNotSelfOwnedRes, {
      ok: false,
      code: "SALARY_ADVANCE_BANK_ACCOUNT_NOT_SELF_OWNED",
    });

    // 3. Self-owned bank account (normalized 'TRAN CONG NHAN BAC 2' matches 'Trần Công Nhân Bắc 2') succeeds
    await db.query(
      `update public.direct_entry_payments
          set account_holder_name = '  tran   cong nhan bac 2 ',
              version = version + 1
        where entry_id = $1::uuid`,
      [workerPrj1B],
    );

    const bankCreateOk = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1B,
      requested_amount_vnd: "4500000",
      payment_method: "BANK_TRANSFER",
      initial_content: "Ứng lương chuyển khoản chính chủ",
      idempotency_key: "idem-bank-ok-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1B,
        requested_amount_vnd: "4500000",
        payment_method: "BANK_TRANSFER",
        initial_content: "Ứng lương chuyển khoản chính chủ",
      }),
    });
    assert.equal(bankCreateOk.ok, true);
    assert.equal(bankCreateOk.data.request.payment_method, "BANK_TRANSFER");
    assert.equal(
      bankCreateOk.data.request.payment_destination_snapshot?.institution_name,
      "Vietcombank",
    );
    assert.equal(
      bankCreateOk.data.request.payment_destination_snapshot?.account_number,
      "0123456789",
    );
    const bankReqId = bankCreateOk.data.request.request_id;

    // Modify worker's bank account in direct_entry_payments afterwards -> existing request snapshot remains intact!
    await db.query(
      `update public.direct_entry_payments
          set account_number = '9999999999',
              version = version + 1
        where entry_id = $1::uuid`,
      [workerPrj1B],
    );
    const bankDetailAfterProfileChange = await repo.getRequestDetail({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: bankReqId,
    });
    assert.equal(bankDetailAfterProfileChange.ok, true);
    assert.equal(
      bankDetailAfterProfileChange.data.request.payment_destination_snapshot
        ?.account_number,
      "0123456789",
      "Existing BANK_TRANSFER request must preserve immutable payment_destination_snapshot when worker profile bank account changes",
    );

    // Approve BANK_TRANSFER request, upload transfer receipt, and review WITHOUT worker portrait (workerPrj1B has no portrait!)
    const approveBankReq = await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: bankReqId,
      action: "APPROVE",
      expected_version: 1,
      message_text: "Chấp thuận chuyển khoản",
      idempotency_key: "idem-approve-bank-001",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: bankReqId,
        action: "APPROVE",
        expected_version: 1,
        message_text: "Chấp thuận chuyển khoản",
      }),
    });
    assert.equal(approveBankReq.ok, true);
    assert.equal(approveBankReq.data.request.request_state, "APPROVED");

    const bankReceiptSha = "e".repeat(64);
    const reserveBankReceipt = await repo.reserveEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: bankReqId,
      expected_version: 2,
      mime_type: "image/png",
      size_bytes: 2048,
      checksum_sha256: bankReceiptSha,
      caption_note: "Bill chuyển khoản VCB FT123456",
      idempotency_key: "idem-reserve-bank-receipt-001",
      request_fingerprint: computeReserveEvidenceFingerprint({
        request_id: bankReqId,
        expected_version: 2,
        mime_type: "image/png",
        size_bytes: 2048,
        checksum_sha256: bankReceiptSha,
        caption_note: "Bill chuyển khoản VCB FT123456",
      }),
    });
    assert.equal(reserveBankReceipt.ok, true);

    const finalizeBankReceipt = await repo.finalizeEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: bankReqId,
      upload_id: reserveBankReceipt.data.upload_id,
      expected_version: 2,
      idempotency_key: "idem-finalize-bank-receipt-001",
      request_fingerprint: computeFinalizeEvidenceFingerprint({
        request_id: bankReqId,
        upload_id: reserveBankReceipt.data.upload_id,
        expected_version: 2,
      }),
    });
    assert.equal(finalizeBankReceipt.ok, true);
    assert.equal(
      finalizeBankReceipt.data.request.current_evidence?.evidence_kind,
      "BANK_TRANSFER_RECEIPT",
    );

    const reviewBankReceipt = await repo.reviewEvidence({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: bankReqId,
      expected_version: 3,
      evidence_version: 1,
      decision: "REVIEWED",
      expected_worker_portrait_document_id: null,
      expected_worker_portrait_version: null,
      note: "Đã đối chiếu bill chuyển khoản khớp số tài khoản chính chủ",
      idempotency_key: "idem-review-bank-receipt-001",
      request_fingerprint: computeReviewEvidenceFingerprint({
        request_id: bankReqId,
        expected_version: 3,
        evidence_version: 1,
        decision: "REVIEWED",
        expected_worker_portrait_document_id: null,
        expected_worker_portrait_version: null,
        note: "Đã đối chiếu bill chuyển khoản khớp số tài khoản chính chủ",
      }),
    });
    assert.equal(reviewBankReceipt.ok, true);
    assert.equal(
      reviewBankReceipt.data.request.evidence_review_state,
      "REVIEWED",
      "BANK_TRANSFER_RECEIPT must allow REVIEWED confirmation without worker portrait lock",
    );

    // =========================================================================
    // HOTFIX VERIFICATION: Worker Eligibility Blocking in Picker, Create & Approve
    //   - OFF / UNCONFIRMED blocked
    //   - Active ON in >= 2 distinct projects blocked
    //   - Duplicate CCCD cluster (same_project_day_count >= 2) blocked
    //   - Raw CCCD never returned in worker picker or request projections
    //   - Existing requests never auto-deleted/cancelled when worker becomes ineligible,
    //     but APPROVE is blocked with clear error code
    // =========================================================================
    // Create an OPEN request for workerPrj1B while still eligible
    const openBeforeIneligible = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1B,
      requested_amount_vnd: "1200000",
      payment_method: "CASH",
      initial_content: "Yêu cầu tạo khi NLĐ đang đủ điều kiện",
      idempotency_key: "idem-open-before-ineligible-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1B,
        requested_amount_vnd: "1200000",
        payment_method: "CASH",
        initial_content: "Yêu cầu tạo khi NLĐ đang đủ điều kiện",
      }),
    });
    assert.equal(openBeforeIneligible.ok, true);
    const openReqBeforeIneligibleId =
      openBeforeIneligible.data.request.request_id;

    // Case A: Transition workerPrj1B to OFF -> blocked in picker, create, and APPROVE of existing request
    await db.query(
      `insert into public.direct_entry_employment_status_events
         (entry_id, status, effective_date, leave_date, leave_reason_text, version, actor_user_id, reason_id)
       select entry_id, 'OFF', '2026-10-20'::date, '2026-10-20'::date, 'Nghỉ việc tự nguyện',
              version + 1, $2::uuid, reason_id
         from public.direct_entry_employment_status_events
        where entry_id = $1::uuid
        order by version desc
        limit 1`,
      [workerPrj1B, PM_1.app],
    );

    const pickerAfterOff = await repo.listProjectWorkers({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      search: "hrp-2026-800002",
      cursor: null,
      page_size: 20,
    });
    assert.equal(pickerAfterOff.ok, true);
    const pickedOffWorker = pickerAfterOff.data.workers.find(
      (w) => w.worker_entry_id === workerPrj1B,
    );
    assert.equal(pickedOffWorker?.employment_status, "OFF");
    assert.equal(pickedOffWorker?.is_eligible, false);
    assert.ok(
      pickedOffWorker?.ineligible_reasons?.includes("WORKER_STATUS_OFF"),
    );

    const createWhenOff = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1B,
      requested_amount_vnd: "1000000",
      payment_method: "CASH",
      initial_content: "Thử tạo khi NLĐ đã OFF",
      idempotency_key: "idem-create-when-off-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1B,
        requested_amount_vnd: "1000000",
        payment_method: "CASH",
        initial_content: "Thử tạo khi NLĐ đã OFF",
      }),
    });
    assert.deepEqual(createWhenOff, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_INELIGIBLE_STATUS",
    });

    // Existing OPEN request is NOT auto-deleted or auto-cancelled, but APPROVE is blocked!
    const approveWhenOff = await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: openReqBeforeIneligibleId,
      action: "APPROVE",
      expected_version: 1,
      message_text: null,
      idempotency_key: "idem-approve-when-off-001",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: openReqBeforeIneligibleId,
        action: "APPROVE",
        expected_version: 1,
        message_text: null,
      }),
    });
    assert.deepEqual(approveWhenOff, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_INELIGIBLE_STATUS",
    });

    // Case B: Multi-project ON (worker active ON in >= 2 distinct projects)
    const multiCccd = "079099009911";
    await db.query(
      `update public.direct_entries
          set worker_details = jsonb_set(
                worker_details,
                '{national_id}',
                jsonb_build_object('state', 'provided', 'value', $1::text)
              ),
              version = version + 1
        where entry_id in ($2::uuid, $3::uuid)`,
      [multiCccd, workerPrj1A, workerPrj2],
    );

    const createWhenMultiProjectOn = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "1000000",
      payment_method: "CASH",
      initial_content: "Thử tạo khi NLĐ đang ON ở 2 dự án",
      idempotency_key: "idem-create-multi-prj-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1A,
        requested_amount_vnd: "1000000",
        payment_method: "CASH",
        initial_content: "Thử tạo khi NLĐ đang ON ở 2 dự án",
      }),
    });
    assert.deepEqual(createWhenMultiProjectOn, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_MULTI_PROJECT_ON",
    });

    // Set workerPrj2 to OFF so workerPrj1A is only ON in 1 project, then test Case C: Duplicate CCCD cluster (same_project_day_count >= 2)
    await db.query(
      `insert into public.direct_entry_employment_status_events
         (entry_id, status, effective_date, leave_date, leave_reason_text, version, actor_user_id, reason_id)
       select entry_id, 'OFF', '2026-10-21'::date, '2026-10-21'::date, 'Kết thúc đợt',
              version + 1, $2::uuid, reason_id
         from public.direct_entry_employment_status_events
        where entry_id = $1::uuid
        order by version desc
        limit 1`,
      [workerPrj2, PM_2.app],
    );

    // Put draftWorkerPrj1 on the same project + same first_work_date ('2026-10-01') + same CCCD as workerPrj1A
    await db.query(
      `update public.direct_entries
          set first_work_date = '2026-10-01'::date,
              worker_details = jsonb_set(
                worker_details,
                '{national_id}',
                jsonb_build_object('state', 'provided', 'value', $1::text)
              ),
              version = version + 1
        where entry_id = $2::uuid`,
      [multiCccd, draftWorkerPrj1],
    );

    const pickerWithDupCccd = await repo.listProjectWorkers({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      search: "hrp-2026-800001",
      cursor: null,
      page_size: 20,
    });
    assert.equal(pickerWithDupCccd.ok, true);
    assert.equal(
      JSON.stringify(pickerWithDupCccd.data).includes(multiCccd),
      false,
      "Worker picker response must NEVER expose raw CCCD",
    );
    const pickedDupWorker = pickerWithDupCccd.data.workers.find(
      (w) => w.worker_entry_id === workerPrj1A,
    );
    assert.equal(pickedDupWorker?.has_duplicate_cccd, true);
    assert.equal(pickedDupWorker?.is_eligible, false);
    assert.ok(
      pickedDupWorker?.ineligible_reasons?.includes("WORKER_DUPLICATE_CCCD"),
    );

    const createWhenDupCccd = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "1000000",
      payment_method: "CASH",
      initial_content: "Thử tạo khi NLĐ thuộc nhóm trùng CCCD",
      idempotency_key: "idem-create-dup-cccd-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1A,
        requested_amount_vnd: "1000000",
        payment_method: "CASH",
        initial_content: "Thử tạo khi NLĐ thuộc nhóm trùng CCCD",
      }),
    });
    assert.deepEqual(createWhenDupCccd, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_DUPLICATE_CCCD",
    });

    // Append-only trigger on salary_advance_events blocks UPDATE and DELETE even with write_marker
    await assert.rejects(
      async () => {
        await db.exec("begin;");
        try {
          await db.exec(
            "select pg_catalog.set_config('salary_advance.write_marker', 'on', true);",
          );
          await db.exec(
            "update public.salary_advance_events set message_text = 'tampered';",
          );
          await db.exec("commit;");
        } catch (err) {
          await db.exec("rollback;");
          throw err;
        }
      },
      /SALARY_ADVANCE_APPEND_ONLY_VIOLATION/,
    );

    await assert.rejects(
      async () => {
        await db.exec("begin;");
        try {
          await db.exec(
            "select pg_catalog.set_config('salary_advance.write_marker', 'on', true);",
          );
          await db.exec("delete from public.salary_advance_events;");
          await db.exec("commit;");
        } catch (err) {
          await db.exec("rollback;");
          throw err;
        }
      },
      /SALARY_ADVANCE_APPEND_ONLY_VIOLATION/,
    );
  } finally {
    await db.close();
  }
});
