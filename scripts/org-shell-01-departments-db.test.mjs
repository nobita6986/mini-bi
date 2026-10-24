/**
 * ORG-SHELL-01 (Work Package 1 of VFIN-01) — Safe Department Shell & Accounting
 * Membership Database, Authority Isolation, Pre/Post Schema-Data Snapshot & ACL Suite.
 *
 * Covers mandatory verification items #1–#16 on ephemeral PGlite across the full
 * repository migration chain (`supabase/migrations/*.sql`):
 *   1. Clean migration apply + atomic transaction rollback on failure + ledger checksum.
 *   2. Idempotent system department seed (`RECRUITMENT`, `ACCOUNTING`, exact count = 2).
 *   3. Immutable `system_key` (`55000`), while `name`/`code` remain display metadata only.
 *   4. Hard-delete protection on system departments (`55000`).
 *   5. Canonical Full Admin is the sole authority to read departments and mutate memberships.
 *   6. Non-Full-Admin & invalid actors fail closed (`42501`) before reading/writing.
 *   7. Effective-dated memberships (`valid_from`/`valid_to`), candidate search without UUID/PII leak,
 *      no duplicate/overlapping active rows, append-only history & immutable audit, same-day re-assign.
 *   8. Idempotent retry returns `replayed: true` with zero duplicate membership/audit rows.
 *   9. Same idempotency key with different payload fingerprint raises `23505` (`IDEMPOTENCY_CONFLICT`).
 *  10. Ending Accounting membership never deletes or alters independent direct grants/scopes.
 *  11. Active Accounting membership creates zero `all` scope, zero extra capabilities, opens zero
 *      Worker/Project/Catalog/Admin/Work Reports surfaces, and satisfies only the internal VFIN
 *      default authority primitive (`Full Admin` OR active `system_key = 'ACCOUNTING'`).
 *  12. Pre- vs post-migration & post-mutation snapshot proof that Team, Team membership,
 *      Team Leader, Project-Team scope, and capability/scope grant schemas, FKs, triggers, RLS,
 *      ACLs, and row data are 100% unchanged.
 *  13. Pre- vs post-migration & post-mutation `direct_entry_resolve_actor_context` parity.
 *  14. Pre- vs post-migration & post-mutation Work Reports authority parity.
 *  15. `RECRUITMENT` strictly projects `public.teams` (excluding `__system_vendor__`) read-only
 *      and rejects membership rows (`22023` `DEPARTMENT_MEMBERSHIP_UNSUPPORTED`).
 *  16. Zero direct table privileges for `PUBLIC`/`anon`/`authenticated`/`service_role`, and
 *      `EXECUTE` granted strictly to `service_role` on the 7 allowlisted server RPCs only.
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
import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";
import {
  migrationChecksum,
  migrationSqlForTransaction,
  ORG_SHELL_01_DEPARTMENTS_MIGRATION_NAME,
  ORG_SHELL_01_DEPARTMENTS_RPC_SIGNATURES,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const TEAM_ALPHA = "98000000-0000-4000-8000-00000000000a";
const TEAM_INACTIVE = "98000000-0000-4000-8000-00000000000b";
const SYSTEM_VENDOR_TEAM = "98000000-0000-4000-8000-0000000000ff";
const PROJECT_CODE = "org_shell_proj_01";

const FULL_ADMIN = {
  auth: "18000000-0000-4000-8000-000000000001",
  app: "28000000-0000-4000-8000-000000000001",
  email: "admin.goc@company.local",
  name: "Quản Trị Toàn Quyền",
};
const ACCOUNTING_USER = {
  auth: "18000000-0000-4000-8000-000000000002",
  app: "28000000-0000-4000-8000-000000000002",
  recruiter: "38000000-0000-4000-8000-000000000002",
  email: "tran.ketoan@company.local",
  name: "Account Fallback Name",
  realName: "Trần Thị Kế Toán",
  personnelCode: "KT-002",
};
const BOD_DIRECT_GRANT_USER = {
  auth: "18000000-0000-4000-8000-000000000003",
  app: "28000000-0000-4000-8000-000000000003",
  email: "bod.analytics@company.local",
  name: "Ban Giám Đốc Direct Grant",
};
const TEAM_LEADER = {
  auth: "18000000-0000-4000-8000-000000000004",
  app: "28000000-0000-4000-8000-000000000004",
  recruiter: "38000000-0000-4000-8000-000000000004",
  email: "leader.alpha@company.local",
  name: "Lê Trưởng Nhóm Alpha",
  personnelCode: "TL-ALPHA",
};
const PROJECT_MANAGER = {
  auth: "18000000-0000-4000-8000-000000000005",
  app: "28000000-0000-4000-8000-000000000005",
  recruiter: "38000000-0000-4000-8000-000000000005",
  email: "pm.alpha@company.local",
  name: "Phạm Quản Lý Dự Án",
  personnelCode: "PM-005",
};
const STAFF_MEMBER = {
  auth: "18000000-0000-4000-8000-000000000006",
  app: "28000000-0000-4000-8000-000000000006",
  recruiter: "38000000-0000-4000-8000-000000000006",
  email: null, // Explicitly verifies accounts without email work cleanly without runtime error
  name: "Nguyễn Nhân Viên Tuyển Dụng",
  personnelCode: "TD-006",
};
const RETIRED_PAYMENT_TOKEN_USER = {
  auth: "18000000-0000-4000-8000-000000000007",
  app: "28000000-0000-4000-8000-000000000007",
  email: "legacy.payment@company.local",
  name: "Tài Khoản Legacy Payment Token",
};
const DISABLED_ADMIN = {
  auth: "18000000-0000-4000-8000-000000000008",
  app: "28000000-0000-4000-8000-000000000008",
  email: "disabled.admin@company.local",
  name: "Tài Khoản Đã Vô Hiệu Hóa",
};

const IDEM_ASSIGN_1 = "78000000-0000-4000-8000-000000000001";
const IDEM_ASSIGN_DUP = "78000000-0000-4000-8000-000000000002";
const IDEM_END_1 = "78000000-0000-4000-8000-000000000003";
const IDEM_ASSIGN_RE = "78000000-0000-4000-8000-000000000004";
const IDEM_ASSIGN_BOD = "78000000-0000-4000-8000-000000000006";
const IDEM_END_BOD = "78000000-0000-4000-8000-000000000007";
const IDEM_ASSIGN_FUTURE = "78000000-0000-4000-8000-000000000008";
const IDEM_END_FUTURE = "78000000-0000-4000-8000-000000000009";

let wrSeq = 0;
const nextWrKey = (prefix) => `org_shell_wr_${prefix}_${++wrSeq}`;

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function createPreOrgShellDatabase({ withAuthEmailColumn = true } = {}) {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  if (withAuthEmailColumn) {
    await db.exec("alter table auth.users add column email text;");
  }
  const migrations = await loadMigrations();
  const targetIndex = migrations.findIndex(
    (m) => m.name === ORG_SHELL_01_DEPARTMENTS_MIGRATION_NAME,
  );
  assert.ok(targetIndex >= 0, "ORG-SHELL-01 migration must exist in supabase/migrations");
  for (const migration of migrations.slice(0, targetIndex)) {
    await db.exec(migration.sql);
  }
  return { db, targetMigration: migrations[targetIndex] };
}

const UNTOUCHED_TABLES = [
  "teams",
  "recruiter_team_memberships",
  "direct_entry_team_leader_assignments",
  "direct_entry_project_team_scopes",
  "direct_entry_capability_grants",
  "direct_entry_scope_grants",
];

async function captureUntouchedDomainSnapshot(db) {
  const { rows: columns } = await db.query(
    `select table_name, ordinal_position::int as pos, column_name, data_type, udt_name, is_nullable
       from information_schema.columns
      where table_schema = 'public'
        and table_name = any($1::text[])
      order by table_name, ordinal_position`,
    [UNTOUCHED_TABLES],
  );

  const { rows: constraints } = await db.query(
    `select rel.relname as table_name,
            con.conname,
            con.contype,
            pg_get_constraintdef(con.oid, true) as def
       from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       join pg_namespace n on n.oid = rel.relnamespace
      where n.nspname = 'public'
        and rel.relname = any($1::text[])
      order by rel.relname, con.conname`,
    [UNTOUCHED_TABLES],
  );

  const { rows: triggers } = await db.query(
    `select c.relname as table_name,
            t.tgname,
            pg_get_triggerdef(t.oid, true) as def
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and not t.tgisinternal
        and c.relname = any($1::text[])
      order by c.relname, t.tgname`,
    [UNTOUCHED_TABLES],
  );

  const { rows: rlsAndPolicies } = await db.query(
    `select c.relname as table_name,
            c.relrowsecurity,
            c.relforcerowsecurity,
            coalesce(c.relacl::text, '') as relacl,
            coalesce(
              (select jsonb_agg(
                        jsonb_build_object(
                          'polname', p.polname,
                          'polcmd', p.polcmd,
                          'qual', pg_get_expr(p.polqual, p.polrelid),
                          'check', pg_get_expr(p.polwithcheck, p.polrelid)
                        )
                        order by p.polname
                      )
                 from pg_policy p
                where p.polrelid = c.oid),
              '[]'::jsonb
            ) as policies
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = any($1::text[])
      order by c.relname`,
    [UNTOUCHED_TABLES],
  );

  const { rows: teamsRows } = await db.query(
    "select to_jsonb(t) as row from public.teams t order by to_jsonb(t)::text",
  );
  const { rows: teamMembershipRows } = await db.query(
    "select to_jsonb(m) as row from public.recruiter_team_memberships m order by to_jsonb(m)::text",
  );
  const { rows: teamLeaderRows } = await db.query(
    "select to_jsonb(a) as row from public.direct_entry_team_leader_assignments a order by to_jsonb(a)::text",
  );
  const { rows: projectTeamRows } = await db.query(
    "select to_jsonb(s) as row from public.direct_entry_project_team_scopes s order by to_jsonb(s)::text",
  );
  const { rows: capabilityRows } = await db.query(
    "select to_jsonb(g) as row from public.direct_entry_capability_grants g order by to_jsonb(g)::text",
  );
  const { rows: scopeRows } = await db.query(
    "select to_jsonb(g) as row from public.direct_entry_scope_grants g order by to_jsonb(g)::text",
  );

  return {
    columns,
    constraints,
    triggers,
    rlsAndPolicies,
    data: {
      teamsRows,
      teamMembershipRows,
      teamLeaderRows,
      projectTeamRows,
      capabilityRows,
      scopeRows,
    },
  };
}

async function captureActorContexts(db, actors) {
  const result = {};
  for (const [key, actor] of Object.entries(actors)) {
    const { rows } = await db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as ctx",
      [actor.auth],
    );
    result[key] = rows[0].ctx;
  }
  return result;
}

async function callOutcome(db, sql, params) {
  try {
    const { rows } = await db.query(sql, params);
    return { ok: true, data: rows[0]?.result ?? null };
  } catch (error) {
    return { ok: false, code: error.code ?? "UNKNOWN" };
  }
}

async function captureWorkReportsAuthoritySnapshot(db, templateId, versionId, actors) {
  const snapshot = {};
  for (const [key, actor] of Object.entries(actors)) {
    const templates = await callOutcome(
      db,
      "select public.work_report_list_templates($1::uuid, $2::uuid) as result",
      [actor.auth, actor.app],
    );
    const obligations = await callOutcome(
      db,
      "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ALL') as result",
      [actor.auth, actor.app],
    );
    const readable = await callOutcome(
      db,
      `select public.work_report_list_readable_submissions(
         $1::uuid, $2::uuid, $3::uuid, null, '2026-10-01'::date, '2026-10-31'::date,
         null, null, null, null, 20
       ) as result`,
      [actor.auth, actor.app, templateId],
    );
    const analytics = await callOutcome(
      db,
      `select public.work_report_analytics_overview(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-10-01'::date, '2026-10-31'::date,
         null, null, 'APPROVED_OR_COMPLETED'
       ) as result`,
      [actor.auth, actor.app, templateId, versionId],
    );

    snapshot[key] = {
      templates: templates.ok
        ? { ok: true, count: templates.data.templates?.length ?? 0 }
        : templates,
      obligations: obligations.ok
        ? { ok: true, count: obligations.data.obligations?.length ?? 0 }
        : obligations,
      readable: readable.ok
        ? { ok: true, count: readable.data.items?.length ?? 0 }
        : readable,
      analytics: analytics.ok
        ? {
            ok: true,
            obligations_total: analytics.data.completion?.obligations_total ?? null,
            submitted_total: analytics.data.completion?.submitted_total ?? null,
          }
        : analytics,
    };
  }
  return snapshot;
}

test("(#1) ORG-SHELL-01 migration rolls back atomically on failure, applies cleanly on minimal auth.users, and records LF-stable checksum", async () => {
  // Minimal AUTH_PROLOGUE without auth.users.email proves compatibility with all PGlite harnesses
  const { db, targetMigration } = await createPreOrgShellDatabase({
    withAuthEmailColumn: false,
  });
  try {
    const checksum = migrationChecksum(targetMigration.sql);
    assert.match(checksum, /^[0-9a-f]{64}$/);
    assert.equal(
      migrationChecksum(targetMigration.sql.replace(/\n/g, "\r\n")),
      checksum,
      "checksum must be identical across LF and CRLF checkouts",
    );

    await db.exec(`
      create table if not exists public.schema_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      );
    `);

    const failingBody = `${migrationSqlForTransaction(targetMigration.sql)}\nselect 1 / 0;\n`;
    await assert.rejects(
      async () => {
        await db.exec("begin;");
        try {
          await db.exec(failingBody);
          await db.query(
            "insert into public.schema_migrations (version, checksum) values ($1, $2)",
            [targetMigration.name, checksum],
          );
          await db.exec("commit;");
        } catch (error) {
          await db.exec("rollback;");
          throw error;
        }
      },
      (error) => error.code === "22012",
    );

    const { rows: leakedTables } = await db.query(
      `select count(*)::int as n
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname like 'organization_department%'`,
    );
    assert.equal(leakedTables[0].n, 0, "rollback leaves zero organization_department* tables");

    const { rows: leakedFuncs } = await db.query(
      `select count(*)::int as n
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname like 'org_department_%'`,
    );
    assert.equal(leakedFuncs[0].n, 0, "rollback leaves zero org_department_* functions");

    await db.exec("begin;");
    await db.exec(migrationSqlForTransaction(targetMigration.sql));
    await db.query(
      "insert into public.schema_migrations (version, checksum) values ($1, $2)",
      [targetMigration.name, checksum],
    );
    await db.exec("commit;");

    const { rows: seeded } = await db.query(
      "select system_key, code, name, is_active from public.organization_departments order by system_key",
    );
    assert.deepEqual(seeded, [
      { system_key: "ACCOUNTING", code: "ACCOUNTING", name: "Phòng Kế toán", is_active: true },
      { system_key: "RECRUITMENT", code: "RECRUITMENT", name: "Phòng Tuyển dụng", is_active: true },
    ]);
  } finally {
    await db.close();
  }
});

test("(#2–#16) ORG-SHELL-01 full invariants, RBAC matrix, effective-dated lifecycle, idempotency, VFIN primitive, ACLs, and zero-touch Team/DirectEntry/WorkReports parity", async () => {
  const { db, targetMigration } = await createPreOrgShellDatabase({
    withAuthEmailColumn: true,
  });
  try {
    // -------------------------------------------------------------------------
    // Pre-migration seed of live Go-Live domains (Teams, Team Memberships,
    // Team Leader, Project-Team Scope, Direct Entry Grants, Work Reports)
    // -------------------------------------------------------------------------
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'TD_ALPHA', 'Nhóm Tuyển Dụng Alpha', true),
              ($2::uuid, 'TD_ARCHIVE', 'Nhóm Tuyển Dụng Tạm Ngưng', false),
              ($3::uuid, '__system_vendor__', 'System Vendor Internal', true)
       on conflict (code) do nothing`,
      [TEAM_ALPHA, TEAM_INACTIVE, SYSTEM_VENDOR_TEAM],
    );

    const allPersonas = [
      FULL_ADMIN,
      ACCOUNTING_USER,
      BOD_DIRECT_GRANT_USER,
      TEAM_LEADER,
      PROJECT_MANAGER,
      STAFF_MEMBER,
      RETIRED_PAYMENT_TOKEN_USER,
      DISABLED_ADMIN,
    ];
    for (const actor of allPersonas) {
      await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
        actor.auth,
        actor.email,
      ]);
      await db.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
         values ($1::uuid, $2::uuid, $3, $4)`,
        [actor.app, actor.auth, actor.name, actor !== DISABLED_ADMIN],
      );
    }

    // Canonical Full Admin grants (active + disabled admin to verify disabled rejection)
    for (const admin of [FULL_ADMIN, DISABLED_ADMIN]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, 'entry_admin', '2026-01-01', true),
                ($1::uuid, 'recruiter_master_manage', '2026-01-01', true),
                ($1::uuid, 'team_master_manage', '2026-01-01', true)`,
        [admin.app],
      );
      await db.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
         values ($1::uuid, 'all', '2026-01-01', true)`,
        [admin.app],
      );
    }

    // Accounting user starts with ordinary own-scope entry_own only
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_own', '2026-01-01', true)`,
      [ACCOUNTING_USER.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'own', '2026-01-01', true)`,
      [ACCOUNTING_USER.app],
    );

    // BoD / direct-grant user has company-wide analytics + catalog + privileged edit (still NOT Full Admin)
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'report_analytics_view', '2026-01-01', true),
              ($1::uuid, 'report_view', '2026-01-01', true),
              ($1::uuid, 'entry_privileged_edit', '2026-01-01', true),
              ($1::uuid, 'catalog_master_manage', '2026-01-01', true)`,
      [BOD_DIRECT_GRANT_USER.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true)`,
      [BOD_DIRECT_GRANT_USER.app],
    );

    // Retired payment_view / payment_edit holder in DB (must NEVER satisfy VFIN or department admin!)
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'payment_view', '2026-01-01', true),
              ($1::uuid, 'payment_edit', '2026-01-01', true)`,
      [RETIRED_PAYMENT_TOKEN_USER.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true)`,
      [RETIRED_PAYMENT_TOKEN_USER.app],
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

    // Seed recruiters + team memberships + recruiter links
    for (const [person, displayName] of [
      [ACCOUNTING_USER, ACCOUNTING_USER.realName],
      [TEAM_LEADER, TEAM_LEADER.name],
      [PROJECT_MANAGER, PROJECT_MANAGER.name],
      [STAFF_MEMBER, STAFF_MEMBER.name],
    ]) {
      await db.query(
        `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
         values ($1::uuid, $2, $3, 'STAFF', true)`,
        [person.recruiter, displayName, person.personnelCode],
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

    // Designate Team Leader + Project + Project<->Team mapping
    await db.query(
      `select public.direct_entry_designate_team_leader(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-01-15'::date, 1, 'Designate Alpha Leader', 'org_shell_tl_1'
       )`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, TEAM_ALPHA, TEAM_LEADER.app],
    );
    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'Dự Án Kiểm Chứng ORG-SHELL-01', true, 1)`,
      [PROJECT_CODE],
    );
    await db.query(
      `select public.direct_entry_grant_project_team_scope(
         $1::uuid, $2::uuid, $3, $4::uuid, 0, '2026-01-15'::date, 'Grant Alpha Scope', 'org_shell_pts_1'
       )`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, PROJECT_CODE, TEAM_ALPHA],
    );

    // Seed Work Reports template, assignment, obligation & submission
    const wrSchema = RECRUITMENT_DAILY_TEMPLATE_SCHEMA;
    const wrMetrics = buildWorkReportMetricContract(wrSchema);
    const { rows: tplRows } = await db.query(
      `select public.work_report_create_template(
         $1::uuid, $2::uuid, 'ORG_SHELL_WR_DAILY', 'Báo cáo tuyển dụng ngày', null, 'DAILY',
         $3::jsonb, $4::jsonb, $5
       ) as result`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        JSON.stringify(wrSchema),
        JSON.stringify(wrMetrics),
        nextWrKey("tpl"),
      ],
    );
    const wrTemplateId = tplRows[0].result.template_id;
    const wrVersionId = tplRows[0].result.draft_version_id;
    await db.query(
      `select public.work_report_publish_template(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, $6
       )`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        wrTemplateId,
        wrVersionId,
        tplRows[0].result.version,
        nextWrKey("pub"),
      ],
    );
    const { rows: wrAsgRows } = await db.query(
      `select public.work_report_create_assignment(
         $1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null,
         'DAILY', true, 30, '23:59:59'::time, false, '2026-10-01'::date, null, $5
       ) as result`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, wrTemplateId, TEAM_ALPHA, nextWrKey("asg")],
    );
    const wrObligationId = "88000000-0000-4000-8000-000000000001";
    await db.query(
      `insert into public.work_report_obligations
         (obligation_id, template_id, template_version_id, assignment_id, assignee_app_user_id,
          snapshot_team_id, snapshot_team_code, snapshot_team_display_name,
          period_type, period_key, period_start_date, period_end_date, due_at, is_mandatory, obligation_status)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
               $6::uuid, 'TD_ALPHA', 'Nhóm Tuyển Dụng Alpha',
               'DAILY', '2026-10-20', '2026-10-20'::date, '2026-10-20'::date, '2099-12-31T16:59:59Z'::timestamptz, true, 'ACTIVE')`,
      [
        wrObligationId,
        wrTemplateId,
        wrVersionId,
        wrAsgRows[0].result.assignment_id,
        STAFF_MEMBER.app,
        TEAM_ALPHA,
      ],
    );
    await db.query(
      `select public.work_report_submit(
         $1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5
       )`,
      [
        STAFF_MEMBER.auth,
        STAFF_MEMBER.app,
        wrObligationId,
        JSON.stringify({
          calls_made: 15,
          interested_candidates: 4,
          workers_started: 2,
          notes: "Báo cáo mẫu trước ORG-SHELL-01",
        }),
        nextWrKey("sub"),
      ],
    );

    const trackedActors = {
      fullAdmin: FULL_ADMIN,
      accountingUser: ACCOUNTING_USER,
      bodUser: BOD_DIRECT_GRANT_USER,
      teamLeader: TEAM_LEADER,
      projectManager: PROJECT_MANAGER,
      staff: STAFF_MEMBER,
      retiredPaymentUser: RETIRED_PAYMENT_TOKEN_USER,
    };

    // Capture pre-migration snapshots (#12, #13, #14)
    const preDomainSnapshot = await captureUntouchedDomainSnapshot(db);
    const preActorContexts = await captureActorContexts(db, trackedActors);
    const preWorkReportsSnapshot = await captureWorkReportsAuthoritySnapshot(
      db,
      wrTemplateId,
      wrVersionId,
      trackedActors,
    );

    // -------------------------------------------------------------------------
    // Apply ORG-SHELL-01 migration (#1)
    // -------------------------------------------------------------------------
    await db.exec(targetMigration.sql);

    const {
      rows: [{ today, tomorrow }],
    } = await db.query(
      `select public.direct_entry_authorization_date()::text as today,
              (public.direct_entry_authorization_date() + 1)::text as tomorrow`,
    );

    // -------------------------------------------------------------------------
    // (#2) Seed idempotency: re-running seed insert produces zero duplicates
    // -------------------------------------------------------------------------
    await db.exec(`
      insert into public.organization_departments (system_key, code, name, is_active)
      values
        ('RECRUITMENT', 'RECRUITMENT', 'Phòng Tuyển dụng', true),
        ('ACCOUNTING', 'ACCOUNTING', 'Phòng Kế toán', true)
      on conflict (system_key) do nothing;
    `);
    const { rows: deptRows } = await db.query(
      "select department_id, system_key, code, name, is_active from public.organization_departments order by system_key",
    );
    assert.equal(deptRows.length, 2, "must have exact 2 system departments");
    const accountingDept = deptRows.find((d) => d.system_key === "ACCOUNTING");
    const recruitmentDept = deptRows.find((d) => d.system_key === "RECRUITMENT");
    assert.ok(accountingDept && recruitmentDept);

    // Verify zero foreign keys exist between `teams` and `organization_departments`
    const { rows: teamDeptFks } = await db.query(
      `select con.conname
         from pg_constraint con
        where con.contype = 'f'
          and (
            (con.conrelid = 'public.teams'::regclass and con.confrelid = 'public.organization_departments'::regclass)
            or
            (con.conrelid = 'public.organization_departments'::regclass and con.confrelid = 'public.teams'::regclass)
          )`,
    );
    assert.deepEqual(teamDeptFks, [], "teams and organization_departments must have zero FK coupling");

    // -------------------------------------------------------------------------
    // (#3 & #4) Immutability of `system_key` and non-deletable system departments
    // -------------------------------------------------------------------------
    await assert.rejects(
      () =>
        db.query(
          "update public.organization_departments set system_key = 'FINANCE_NEW' where department_id = $1::uuid",
          [accountingDept.department_id],
        ),
      (err) => err.code === "55000",
      "system_key must be immutable",
    );
    await assert.rejects(
      () =>
        db.query("delete from public.organization_departments where department_id = $1::uuid", [
          accountingDept.department_id,
        ]),
      (err) => err.code === "55000",
      "ACCOUNTING system department cannot be hard-deleted",
    );
    await assert.rejects(
      () =>
        db.query("delete from public.organization_departments where department_id = $1::uuid", [
          recruitmentDept.department_id,
        ]),
      (err) => err.code === "55000",
      "RECRUITMENT system department cannot be hard-deleted",
    );

    // -------------------------------------------------------------------------
    // (#16) Direct table ACL & RPC EXECUTE boundary checks under runtime roles
    // -------------------------------------------------------------------------
    for (const runtimeRole of ["anon", "authenticated", "service_role"]) {
      for (const tbl of [
        "organization_departments",
        "organization_department_memberships",
        "organization_department_audit_events",
        "organization_department_idempotency",
      ]) {
        await db.exec(`set role ${runtimeRole};`);
        try {
          await assert.rejects(
            () => db.query(`select count(*) from public.${tbl}`),
            (err) => err.code === "42501",
            `${runtimeRole} must be denied direct SELECT on ${tbl}`,
          );
        } finally {
          await db.exec("reset role;");
        }
      }
    }

    for (const clientRole of ["anon", "authenticated"]) {
      await db.exec(`set role ${clientRole};`);
      try {
        await assert.rejects(
          () =>
            db.query("select public.org_department_list_departments_admin($1::uuid, $2::uuid)", [
              FULL_ADMIN.auth,
              FULL_ADMIN.app,
            ]),
          (err) => err.code === "42501",
          `${clientRole} must be denied EXECUTE on org_department RPCs`,
        );
      } finally {
        await db.exec("reset role;");
      }
    }

    await db.exec("set role service_role;");
    try {
      await assert.rejects(
        () =>
          db.query(
            "select public.org_department__internal_resolve_vfin_default_authority($1::uuid, $2::uuid, $3::date)",
            [FULL_ADMIN.auth, FULL_ADMIN.app, today],
          ),
        (err) => err.code === "42501",
        "service_role must NOT have EXECUTE on internal helper functions",
      );
    } finally {
      await db.exec("reset role;");
    }

    for (const sig of ORG_SHELL_01_DEPARTMENTS_RPC_SIGNATURES) {
      const { rows } = await db.query(
        `select has_function_privilege('public', $1::regprocedure, 'EXECUTE') as pub_exec,
                has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon_exec,
                has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth_exec,
                has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as svc_exec`,
        [sig],
      );
      assert.deepEqual(rows[0], {
        pub_exec: false,
        anon_exec: false,
        auth_exec: false,
        svc_exec: true,
      });
    }

    // -------------------------------------------------------------------------
    // (#5 & #6) Only Full Admin succeeds; all other personas fail closed (`42501`)
    // -------------------------------------------------------------------------
    const nonAdminCalls = [
      ACCOUNTING_USER,
      BOD_DIRECT_GRANT_USER,
      TEAM_LEADER,
      PROJECT_MANAGER,
      STAFF_MEMBER,
      RETIRED_PAYMENT_TOKEN_USER,
      DISABLED_ADMIN,
      { auth: FULL_ADMIN.auth, app: ACCOUNTING_USER.app, name: "Mismatched Mapping" },
    ];

    const probeFp = buildAssignAccountingMemberFingerprint({
      accountRef: ACCOUNTING_USER.app,
      expectedPairVersion: 0,
      effectiveFrom: null,
      reason: "Unauthorized probe",
    });

    await db.exec("set role service_role;");
    try {
      for (const unauthorized of nonAdminCalls) {
        for (const [label, fnSql, params] of [
          [
            "list_departments",
            "select public.org_department_list_departments_admin($1::uuid, $2::uuid)",
            [unauthorized.auth, unauthorized.app],
          ],
          [
            "get_department",
            "select public.org_department_get_department_admin($1::uuid, $2::uuid, $3::uuid)",
            [unauthorized.auth, unauthorized.app, accountingDept.department_id],
          ],
          [
            "list_memberships",
            "select public.org_department_list_accounting_memberships_admin($1::uuid, $2::uuid, null, true, 1, 25)",
            [unauthorized.auth, unauthorized.app],
          ],
          [
            "list_candidates",
            "select public.org_department_list_accounting_candidates_admin($1::uuid, $2::uuid, null, 1, 25)",
            [unauthorized.auth, unauthorized.app],
          ],
          [
            "assign_member",
            "select public.org_department_assign_accounting_member($1::uuid, $2::uuid, $3::uuid, 0, null, 'Unauthorized probe', $4::uuid, $5)",
            [unauthorized.auth, unauthorized.app, ACCOUNTING_USER.app, IDEM_ASSIGN_1, probeFp],
          ],
          [
            "end_member",
            "select public.org_department_end_accounting_member($1::uuid, $2::uuid, $3::uuid, 1, null, 'Unauthorized probe', $4::uuid, $5)",
            [unauthorized.auth, unauthorized.app, accountingDept.department_id, IDEM_END_1, probeFp],
          ],
          [
            "list_recruitment_teams",
            "select public.org_department_list_recruitment_teams_admin($1::uuid, $2::uuid, null, true, 1, 25)",
            [unauthorized.auth, unauthorized.app],
          ],
        ]) {
          await assert.rejects(
            () => db.query(fnSql, params),
            (err) => err.code === "42501",
            `${unauthorized.name} must be rejected with 42501 on ${label}`,
          );
        }
      }

      // -----------------------------------------------------------------------
      // (#5, #7, #15) Full Admin read projections: departments, candidates, teams
      // -----------------------------------------------------------------------
      const {
        rows: [{ data: deptList }],
      } = await db.query(
        "select public.org_department_list_departments_admin($1::uuid, $2::uuid) as data",
        [FULL_ADMIN.auth, FULL_ADMIN.app],
      );
      assert.equal(deptList.departments.length, 2);
      assert.equal(deptList.departments[0].system_key, "RECRUITMENT");
      assert.equal(deptList.departments[0].membership_mode, "READ_ONLY_TEAMS_PROJECTION");
      assert.equal(deptList.departments[0].team_count, 2); // excludes __system_vendor__!
      assert.equal(deptList.departments[0].active_team_count, 1);
      assert.equal(deptList.departments[1].system_key, "ACCOUNTING");
      assert.equal(deptList.departments[1].membership_mode, "MANAGED_MEMBERSHIP");
      assert.equal(deptList.departments[1].active_member_count, 0);

      // Candidate search by real recruiter name, login_id, and personnel_code (never leaks email or auth_subject)
      for (const queryTerm of ["Trần Thị Kế Toán", "tran.ketoan", "KT-002"]) {
        const {
          rows: [{ data: candRes }],
        } = await db.query(
          "select public.org_department_list_accounting_candidates_admin($1::uuid, $2::uuid, $3, 1, 25) as data",
          [FULL_ADMIN.auth, FULL_ADMIN.app, queryTerm],
        );
        assert.equal(candRes.total, 1, `candidate search for "${queryTerm}" should match 1 account`);
        const cand = candRes.candidates[0];
        assert.equal(cand.account_ref, ACCOUNTING_USER.app);
        assert.equal(cand.display_name, ACCOUNTING_USER.realName);
        assert.equal(cand.login_id, "tran.ketoan");
        assert.equal(cand.personnel_code, "KT-002");
        assert.equal(cand.has_active_membership, false);
        assert.equal(cand.pair_version, 0);
        assert.equal("email" in cand, false);
        assert.equal("auth_subject" in cand, false);
        assert.equal(JSON.stringify(cand).includes("@company.local"), false);
      }

      // Disabled accounts never appear in assignable candidates
      const {
        rows: [{ data: disabledCandRes }],
      } = await db.query(
        "select public.org_department_list_accounting_candidates_admin($1::uuid, $2::uuid, 'disabled.admin', 1, 25) as data",
        [FULL_ADMIN.auth, FULL_ADMIN.app],
      );
      assert.equal(disabledCandRes.total, 0);

      // Recruitment teams projection excludes __system_vendor__ and honors include_inactive
      const {
        rows: [{ data: allRecTeams }],
      } = await db.query(
        "select public.org_department_list_recruitment_teams_admin($1::uuid, $2::uuid, null, true, 1, 25) as data",
        [FULL_ADMIN.auth, FULL_ADMIN.app],
      );
      assert.equal(allRecTeams.total, 2);
      assert.deepEqual(
        allRecTeams.teams.map((t) => t.code),
        ["TD_ALPHA", "TD_ARCHIVE"],
      );

      const {
        rows: [{ data: activeRecTeams }],
      } = await db.query(
        "select public.org_department_list_recruitment_teams_admin($1::uuid, $2::uuid, null, false, 1, 25) as data",
        [FULL_ADMIN.auth, FULL_ADMIN.app],
      );
      assert.equal(activeRecTeams.total, 1);
      assert.equal(activeRecTeams.teams[0].code, "TD_ALPHA");

      // -----------------------------------------------------------------------
      // (#7, #8, #9) Assign Accounting membership, idempotency replay & conflict,
      // overlap prevention, end membership, history retention, same-day re-assign
      // -----------------------------------------------------------------------
      const assignReason = "Bổ nhiệm nhân sự Phòng Kế toán đợt 1";
      const assignFp = buildAssignAccountingMemberFingerprint({
        accountRef: ACCOUNTING_USER.app,
        expectedPairVersion: 0,
        effectiveFrom: null,
        reason: assignReason,
      });

      const {
        rows: [{ data: assigned1 }],
      } = await db.query(
        `select public.org_department_assign_accounting_member(
           $1::uuid, $2::uuid, $3::uuid, 0, null, $4, $5::uuid, $6
         ) as data`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          ACCOUNTING_USER.app,
          assignReason,
          IDEM_ASSIGN_1,
          assignFp,
        ],
      );
      assert.equal(assigned1.replayed, false);
      assert.equal(assigned1.membership.account_ref, ACCOUNTING_USER.app);
      assert.equal(assigned1.membership.state, "CURRENT");
      assert.equal(assigned1.membership.effective, true);
      assert.equal(assigned1.membership.version, 1);
      assert.equal(assigned1.membership.pair_version, 1);
      const firstMembershipId = assigned1.membership.membership_id;

      // (#8) Idempotent retry with identical key + fingerprint -> replayed: true, no extra row
      const {
        rows: [{ data: assignedReplay }],
      } = await db.query(
        `select public.org_department_assign_accounting_member(
           $1::uuid, $2::uuid, $3::uuid, 0, null, $4, $5::uuid, $6
         ) as data`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          ACCOUNTING_USER.app,
          assignReason,
          IDEM_ASSIGN_1,
          assignFp,
        ],
      );
      assert.equal(assignedReplay.replayed, true);
      assert.equal(assignedReplay.membership.membership_id, firstMembershipId);

      // (#9) Same idempotency key with different payload fingerprint -> 23505 IDEMPOTENCY_CONFLICT
      const diffFp = buildAssignAccountingMemberFingerprint({
        accountRef: ACCOUNTING_USER.app,
        expectedPairVersion: 0,
        effectiveFrom: null,
        reason: "Lý do khác trên cùng idempotency_key",
      });
      await assert.rejects(
        () =>
          db.query(
            `select public.org_department_assign_accounting_member(
               $1::uuid, $2::uuid, $3::uuid, 0, null, 'Lý do khác trên cùng idempotency_key', $4::uuid, $5
             )`,
            [FULL_ADMIN.auth, FULL_ADMIN.app, ACCOUNTING_USER.app, IDEM_ASSIGN_1, diffFp],
          ),
        (err) => err.code === "23505" && err.message.includes("IDEMPOTENCY_CONFLICT"),
      );

      // (#7) Duplicate active membership with fresh idempotency key rejected (OCC 40001 & overlap 23P01)
      await assert.rejects(
        () =>
          db.query(
            `select public.org_department_assign_accounting_member(
               $1::uuid, $2::uuid, $3::uuid, 0, null, 'Thử gán trùng stale version', $4::uuid, $5
             )`,
            [FULL_ADMIN.auth, FULL_ADMIN.app, ACCOUNTING_USER.app, IDEM_ASSIGN_DUP, assignFp],
          ),
        (err) => err.code === "40001",
      );
      const dupVersion1Fp = buildAssignAccountingMemberFingerprint({
        accountRef: ACCOUNTING_USER.app,
        expectedPairVersion: 1,
        effectiveFrom: null,
        reason: "Thử gán chồng khi đang mở",
      });
      await assert.rejects(
        () =>
          db.query(
            `select public.org_department_assign_accounting_member(
               $1::uuid, $2::uuid, $3::uuid, 1, null, 'Thử gán chồng khi đang mở', $4::uuid, $5
             )`,
            [FULL_ADMIN.auth, FULL_ADMIN.app, ACCOUNTING_USER.app, IDEM_ASSIGN_DUP, dupVersion1Fp],
          ),
        (err) => err.code === "23P01",
      );

      // (#11) Active ACCOUNTING member still cannot access department admin RPCs (`42501`),
      // Worker directory (`42501`), Admin account directory (`42501`), or Work Reports (`42501`)!
      await assert.rejects(
        () =>
          db.query("select public.org_department_list_departments_admin($1::uuid, $2::uuid)", [
            ACCOUNTING_USER.auth,
            ACCOUNTING_USER.app,
          ]),
        (err) => err.code === "42501",
      );
      await assert.rejects(
        () =>
          db.query(
            "select public.direct_entry_list_app_users_admin($1::uuid, $2::uuid, null, 'all', 1, 25)",
            [ACCOUNTING_USER.auth, ACCOUNTING_USER.app],
          ),
        (err) => err.code === "42501",
      );
      await assert.rejects(
        () =>
          db.query(
            "select public.direct_entry_list_projects_admin($1::uuid, $2::uuid, false)",
            [ACCOUNTING_USER.auth, ACCOUNTING_USER.app],
          ),
        (err) => err.code === "42501",
      );
      await assert.rejects(
        () =>
          db.query(
            "select public.direct_entry_list_vendors_admin($1::uuid, $2::uuid, null, false, 1, 25)",
            [ACCOUNTING_USER.auth, ACCOUNTING_USER.app],
          ),
        (err) => err.code === "42501",
      );
      await assert.rejects(
        () =>
          db.query(
            "select public.direct_entry_list_workers($1::uuid, $2::uuid, 'all', null, null, null, null, 25, null)",
            [ACCOUNTING_USER.auth, ACCOUNTING_USER.app],
          ),
        (err) => err.code === "42501",
      );
    } finally {
      await db.exec("reset role;");
    }

    // -------------------------------------------------------------------------
    // (#3 & #11) Verify internal VFIN default authority primitive in DB
    // (`Full Admin` OR active `system_key = 'ACCOUNTING'`, immune to department rename)
    // -------------------------------------------------------------------------
    const checkVfin = async (actor, asOf = today) => {
      const { rows } = await db.query(
        "select public.org_department__internal_resolve_vfin_default_authority($1::uuid, $2::uuid, $3::date) as res",
        [actor.auth, actor.app, asOf],
      );
      return rows[0].res;
    };

    assert.deepEqual(await checkVfin(FULL_ADMIN), {
      allowed: true,
      authority_source: "full_admin",
      can_view: true,
      can_record: true,
    });
    assert.deepEqual(await checkVfin(ACCOUNTING_USER), {
      allowed: true,
      authority_source: "accounting_department",
      can_view: true,
      can_record: true,
    });
    for (const deniedPersona of [
      BOD_DIRECT_GRANT_USER,
      TEAM_LEADER,
      PROJECT_MANAGER,
      STAFF_MEMBER,
      RETIRED_PAYMENT_TOKEN_USER,
    ]) {
      assert.deepEqual(
        await checkVfin(deniedPersona),
        {
          allowed: false,
          authority_source: "none",
          can_view: false,
          can_record: false,
        },
        `${deniedPersona.name} must NOT receive default VFIN authority`,
      );
    }
    await assert.rejects(
      () => checkVfin(DISABLED_ADMIN),
      (err) => err.code === "42501",
      "disabled admin fails actor mapping assertion",
    );

    // (#3) Rename department `name` & `code` temporarily -> authority stays anchored on `system_key = 'ACCOUNTING'`
    await db.query(
      "update public.organization_departments set code = 'ACC_RENAMED', name = 'Ban Tài Chính Đổi Tên' where system_key = 'ACCOUNTING'",
    );
    assert.equal((await checkVfin(ACCOUNTING_USER)).authority_source, "accounting_department");
    await db.query(
      "update public.organization_departments set code = 'ACCOUNTING', name = 'Phòng Kế toán' where system_key = 'ACCOUNTING'",
    );

    // (#15) Direct DB insert of membership into `RECRUITMENT` is rejected by trigger (`22023`)
    await assert.rejects(
      () =>
        db.query(
          `insert into public.organization_department_memberships
             (department_id, app_user_id, valid_from, valid_to, version, granted_by_user_id, grant_reason)
           values ($1::uuid, $2::uuid, $3::date, null, 1, $4::uuid, 'Forbidden Recruitment membership')`,
          [recruitmentDept.department_id, STAFF_MEMBER.app, today, FULL_ADMIN.app],
        ),
      (err) => err.code === "22023" && err.message.includes("DEPARTMENT_MEMBERSHIP_UNSUPPORTED"),
    );

    // -------------------------------------------------------------------------
    // (#7, #8, #9, #10) End membership, verify history/audit immutability,
    // same-day re-assign, future-scheduled membership, and direct-grant preservation
    // -------------------------------------------------------------------------
    await db.exec("set role service_role;");
    let endedMembershipId;
    let bodEndedMembershipId;
    try {
      const endReason = "Kết thúc đợt điều động 1";
      const endFp = buildEndAccountingMemberFingerprint({
        membershipId: assignedMembershipIdFromList(
          await db.query(
            "select public.org_department_list_accounting_memberships_admin($1::uuid, $2::uuid, null, false, 1, 25) as data",
            [FULL_ADMIN.auth, FULL_ADMIN.app],
          ),
        ),
        expectedPairVersion: 1,
        effectiveTo: null,
        reason: endReason,
      });
      endedMembershipId = (
        await db.query(
          "select public.org_department_list_accounting_memberships_admin($1::uuid, $2::uuid, null, false, 1, 25) as data",
          [FULL_ADMIN.auth, FULL_ADMIN.app],
        )
      ).rows[0].data.memberships[0].membership_id;

      const {
        rows: [{ data: ended1 }],
      } = await db.query(
        `select public.org_department_end_accounting_member(
           $1::uuid, $2::uuid, $3::uuid, 1, null, $4, $5::uuid, $6
         ) as data`,
        [FULL_ADMIN.auth, FULL_ADMIN.app, endedMembershipId, endReason, IDEM_END_1, endFp],
      );
      assert.equal(ended1.replayed, false);
      assert.equal(ended1.membership.state, "HISTORY");
      assert.equal(ended1.membership.effective, false);
      assert.equal(ended1.membership.version, 2);
      assert.equal(ended1.membership.pair_version, 2);
      assert.equal(ended1.membership.valid_to, today);

      // (#8) Idempotent end replay -> replayed: true
      const {
        rows: [{ data: endedReplay }],
      } = await db.query(
        `select public.org_department_end_accounting_member(
           $1::uuid, $2::uuid, $3::uuid, 1, null, $4, $5::uuid, $6
         ) as data`,
        [FULL_ADMIN.auth, FULL_ADMIN.app, endedMembershipId, endReason, IDEM_END_1, endFp],
      );
      assert.equal(endedReplay.replayed, true);
      assert.equal(endedReplay.membership.version, 2);

      // (#9) Same end idempotency key with different fingerprint -> 23505 IDEMPOTENCY_CONFLICT
      const endDiffFp = buildEndAccountingMemberFingerprint({
        membershipId: endedMembershipId,
        expectedPairVersion: 1,
        effectiveTo: null,
        reason: "Khác lý do thu hồi",
      });
      await assert.rejects(
        () =>
          db.query(
            `select public.org_department_end_accounting_member(
               $1::uuid, $2::uuid, $3::uuid, 1, null, 'Khác lý do thu hồi', $4::uuid, $5
             )`,
            [FULL_ADMIN.auth, FULL_ADMIN.app, endedMembershipId, IDEM_END_1, endDiffFp],
          ),
        (err) => err.code === "23505" && err.message.includes("IDEMPOTENCY_CONFLICT"),
      );

      // Listing with include_history = false returns 0 active; include_history = true returns 1 HISTORY row
      const {
        rows: [{ data: activeAfterEnd }],
      } = await db.query(
        "select public.org_department_list_accounting_memberships_admin($1::uuid, $2::uuid, null, false, 1, 25) as data",
        [FULL_ADMIN.auth, FULL_ADMIN.app],
      );
      assert.equal(activeAfterEnd.total, 0);

      const {
        rows: [{ data: historyAfterEnd }],
      } = await db.query(
        "select public.org_department_list_accounting_memberships_admin($1::uuid, $2::uuid, null, true, 1, 25) as data",
        [FULL_ADMIN.auth, FULL_ADMIN.app],
      );
      assert.equal(historyAfterEnd.total, 1);
      assert.equal(historyAfterEnd.memberships[0].state, "HISTORY");

      // (#7) Same-day re-assign (`expected_pair_version = 2` -> `version = 3`) succeeds cleanly!
      const reReason = "Bổ nhiệm lại cùng ngày sau kiểm tra";
      const reFp = buildAssignAccountingMemberFingerprint({
        accountRef: ACCOUNTING_USER.app,
        expectedPairVersion: 2,
        effectiveFrom: null,
        reason: reReason,
      });
      const {
        rows: [{ data: reassigned }],
      } = await db.query(
        `select public.org_department_assign_accounting_member(
           $1::uuid, $2::uuid, $3::uuid, 2, null, $4, $5::uuid, $6
         ) as data`,
        [FULL_ADMIN.auth, FULL_ADMIN.app, ACCOUNTING_USER.app, reReason, IDEM_ASSIGN_RE, reFp],
      );
      assert.equal(reassigned.membership.version, 3);
      assert.equal(reassigned.membership.state, "CURRENT");
      assert.equal(reassigned.membership.effective, true);

      // Future-scheduled membership on STAFF_MEMBER (`valid_from = tomorrow`) is SCHEDULED, not effective today
      const futureReason = "Lịch điều động từ ngày mai";
      const futureFp = buildAssignAccountingMemberFingerprint({
        accountRef: STAFF_MEMBER.app,
        expectedPairVersion: 0,
        effectiveFrom: tomorrow,
        reason: futureReason,
      });
      const {
        rows: [{ data: futureAssigned }],
      } = await db.query(
        `select public.org_department_assign_accounting_member(
           $1::uuid, $2::uuid, $3::uuid, 0, $4::date, $5, $6::uuid, $7
         ) as data`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          STAFF_MEMBER.app,
          tomorrow,
          futureReason,
          IDEM_ASSIGN_FUTURE,
          futureFp,
        ],
      );
      assert.equal(futureAssigned.membership.state, "SCHEDULED");
      assert.equal(futureAssigned.membership.effective, false);
      assert.equal(futureAssigned.membership.login_id, null); // STAFF_MEMBER has null email!

      // Cancel future-scheduled membership cleanly (`effectiveTo = null` -> `greatest(today, valid_from) = valid_from` marker)
      const endFutureReason = "Hủy lịch điều động tương lai";
      const endFutureFp = buildEndAccountingMemberFingerprint({
        membershipId: futureAssigned.membership.membership_id,
        expectedPairVersion: 1,
        effectiveTo: null,
        reason: endFutureReason,
      });
      const {
        rows: [{ data: futureEnded }],
      } = await db.query(
        `select public.org_department_end_accounting_member(
           $1::uuid, $2::uuid, $3::uuid, 1, null, $4, $5::uuid, $6
         ) as data`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          futureAssigned.membership.membership_id,
          endFutureReason,
          IDEM_END_FUTURE,
          endFutureFp,
        ],
      );
      assert.equal(futureEnded.membership.state, "HISTORY");
      assert.equal(futureEnded.membership.effective, false);

      // (#10) Assign & end BOD_DIRECT_GRANT_USER in Accounting -> direct grants/scopes remain untouched!
      const bodAssignReason = "Kiểm tra bảo toàn direct grants khi vào/rời Phòng Kế toán";
      const bodAssignFp = buildAssignAccountingMemberFingerprint({
        accountRef: BOD_DIRECT_GRANT_USER.app,
        expectedPairVersion: 0,
        effectiveFrom: null,
        reason: bodAssignReason,
      });
      const {
        rows: [{ data: bodAssigned }],
      } = await db.query(
        `select public.org_department_assign_accounting_member(
           $1::uuid, $2::uuid, $3::uuid, 0, null, $4, $5::uuid, $6
         ) as data`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          BOD_DIRECT_GRANT_USER.app,
          bodAssignReason,
          IDEM_ASSIGN_BOD,
          bodAssignFp,
        ],
      );
      bodEndedMembershipId = bodAssigned.membership.membership_id;
      const bodEndReason = "Rời Phòng Kế toán nhưng giữ nguyên direct grants BoD";
      const bodEndFp = buildEndAccountingMemberFingerprint({
        membershipId: bodEndedMembershipId,
        expectedPairVersion: 1,
        effectiveTo: null,
        reason: bodEndReason,
      });
      await db.query(
        `select public.org_department_end_accounting_member(
           $1::uuid, $2::uuid, $3::uuid, 1, null, $4, $5::uuid, $6
         )`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          bodEndedMembershipId,
          bodEndReason,
          IDEM_END_BOD,
          bodEndFp,
        ],
      );
    } finally {
      await db.exec("reset role;");
    }

    // Verify membership history, overlap, & audit append-only triggers (`23P01` & `55000`)
    await assert.rejects(
      () =>
        db.query("delete from public.organization_department_memberships where membership_id = $1::uuid", [
          endedMembershipId,
        ]),
      (err) => err.code === "55000",
      "membership history cannot be deleted",
    );
    await assert.rejects(
      () =>
        db.query(
          "update public.organization_department_memberships set valid_to = null where membership_id = $1::uuid",
          [endedMembershipId],
        ),
      (err) => err.code === "23P01",
      "reopening an ended membership while another membership is active is blocked by overlap trigger",
    );
    await assert.rejects(
      () =>
        db.query(
          "update public.organization_department_memberships set valid_to = null where membership_id = $1::uuid",
          [bodEndedMembershipId],
        ),
      (err) => err.code === "55000",
      "ended membership cannot be reopened even when no active membership exists",
    );
    await assert.rejects(
      () => db.query("delete from public.organization_department_audit_events"),
      (err) => err.code === "55000",
      "audit events table is append-only",
    );

    const { rows: auditCountRows } = await db.query(
      "select count(*)::int as n from public.organization_department_audit_events",
    );
    assert.equal(auditCountRows[0].n, 7, "exact 1 audit row per non-replayed mutation");

    // -------------------------------------------------------------------------
    // (#10, #11, #12, #13, #14) Post-migration & post-mutation snapshot parity!
    // Proves Team, Team Membership, Team Leader, Project-Team Scope, Grants,
    // Direct Entry actor contexts (even while ACCOUNTING_USER holds active
    // membership v3!), and Work Reports authority are 100% IDENTICAL!
    // -------------------------------------------------------------------------
    const postDomainSnapshot = await captureUntouchedDomainSnapshot(db);
    const postActorContexts = await captureActorContexts(db, trackedActors);
    const postWorkReportsSnapshot = await captureWorkReportsAuthoritySnapshot(
      db,
      wrTemplateId,
      wrVersionId,
      trackedActors,
    );

    assert.deepEqual(
      postDomainSnapshot,
      preDomainSnapshot,
      "Schema, constraints, triggers, RLS, ACLs, and row data of Team/Leader/ProjectTeam/Grants must remain 100% untouched",
    );
    assert.deepEqual(
      postActorContexts,
      preActorContexts,
      "direct_entry_resolve_actor_context must remain 100% identical before and after ORG-SHELL-01 migration and Accounting mutations",
    );
    assert.deepEqual(
      postWorkReportsSnapshot,
      preWorkReportsSnapshot,
      "Work Reports authority outcomes must remain 100% identical before and after ORG-SHELL-01 migration and Accounting mutations",
    );
  } finally {
    await db.close();
  }
});

function assignedMembershipIdFromList(queryResult) {
  const rows = queryResult.rows[0]?.data?.memberships ?? [];
  assert.equal(rows.length, 1);
  return rows[0].membership_id;
}

function buildAssignAccountingMemberFingerprint({
  actorAppUserId = FULL_ADMIN.app,
  accountRef,
  expectedPairVersion,
  effectiveFrom,
  reason,
}) {
  return computeAssignAccountingMemberFingerprint({
    actor_app_user_id: actorAppUserId,
    account_ref: accountRef,
    expected_pair_version: expectedPairVersion,
    effective_from: effectiveFrom,
    reason,
  });
}

function buildEndAccountingMemberFingerprint({
  actorAppUserId = FULL_ADMIN.app,
  membershipId,
  expectedPairVersion,
  effectiveTo,
  reason,
}) {
  return computeEndAccountingMemberFingerprint({
    actor_app_user_id: actorAppUserId,
    membership_id: membershipId,
    expected_pair_version: expectedPairVersion,
    effective_to: effectiveTo,
    reason,
  });
}
