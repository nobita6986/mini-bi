import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import {
  ATTENDANCE_PHOTO_MIME_TYPE,
  computeAttendanceRequestFingerprint,
} from "../src/lib/attendance/attendance-contract.ts";
import {
  computeBranchAssignRequestFingerprint,
  computeBranchUnassignRequestFingerprint,
  computeBranchUpsertRequestFingerprint,
  computeExplanationDecideRequestFingerprint,
  computeExplanationSubmitRequestFingerprint,
  computeSlotPolicyCreateRequestFingerprint,
} from "../src/lib/attendance/attendance-monthly-matrix-api.ts";
import {
  projectAssignBranchResult,
  projectAttendanceBranchesAdminList,
  projectAttendanceExplanationApprovalInbox,
  projectAttendanceMonthlyMatrixReport,
  projectAttendanceSlotPoliciesAdminList,
  projectCreateSlotPolicyResult,
  projectDecideAttendanceExplanationResult,
  projectMyAttendanceExplanationsOverview,
  projectSubmitAttendanceExplanationResult,
  projectUnassignBranchResult,
  projectUpsertBranchResult,
} from "../src/lib/attendance/attendance-monthly-matrix-contract.ts";
import { computeHqLocationRequestFingerprint } from "../src/lib/attendance/attendance-report-api.ts";
import { projectAttendanceAdminReport } from "../src/lib/attendance/attendance-report-contract.ts";
import {
  projectAdminList,
  projectAdminLocationMutation,
  projectAdminProject,
} from "../src/lib/direct-entry/project-admin-contract.ts";
import { projectHrpSyncCatalog } from "../src/lib/integrations/hrp/catalog-contract.ts";
import {
  ATTENDANCE_EXPLANATIONS_WAVE2_MIGRATION_NAME,
  ATTENDANCE_EXPLANATIONS_WAVE2_RPC_SIGNATURES,
  ATTENDANCE_FLEXIBLE_SLOT_POLICY_MIGRATION_NAME,
  ATTENDANCE_FLEXIBLE_SLOT_POLICY_RPC_SIGNATURES,
  ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_MIGRATION_NAME,
  ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_RPC_SIGNATURES,
  migrationChecksum,
  migrationSqlForTransaction,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const TEAM_ALPHA = "99000000-0000-4000-8000-0000000000a1";

const ACTORS = {
  FULL_ADMIN: {
    auth: "19100000-0000-4000-8000-000000000001",
    app: "29100000-0000-4000-8000-000000000001",
    name: "Quản Trị Toàn Hệ Thống",
  },
  BOD_PRIVILEGED: {
    auth: "19100000-0000-4000-8000-000000000002",
    app: "29100000-0000-4000-8000-000000000002",
    name: "Ban Giám Đốc (Direct Entry)",
  },
  PROJECT_ADMIN: {
    auth: "19100000-0000-4000-8000-000000000006",
    app: "29100000-0000-4000-8000-000000000006",
    name: "Quản Trị Dự Án",
  },
  TEAM_LEADER: {
    auth: "19100000-0000-4000-8000-000000000004",
    app: "29100000-0000-4000-8000-000000000004",
    name: "Trưởng Nhóm Alpha",
  },
  STAFF_A: {
    auth: "19100000-0000-4000-8000-000000000011",
    app: "29100000-0000-4000-8000-000000000011",
    recruiter: "39100000-0000-4000-8000-000000000011",
    code: "NV_MAT_01",
    name: "Nhân Viên Chi Nhánh A",
  },
  STAFF_B: {
    auth: "19100000-0000-4000-8000-000000000012",
    app: "29100000-0000-4000-8000-000000000012",
    recruiter: "39100000-0000-4000-8000-000000000012",
    code: "NV_MAT_02",
    name: "Nhân Viên Trụ Sở HQ B",
  },
  DISABLED_STAFF: {
    auth: "19100000-0000-4000-8000-000000000015",
    app: "29100000-0000-4000-8000-000000000015",
    name: "Nhân Viên Ngừng Hoạt Động",
  },
};

const PHOTO_SHA = "c".repeat(64);
const TOKEN_DIGEST = "d".repeat(64);

const HQ_HANOI = { latitude: 21.028511, longitude: 105.804817 };
const BRANCH_BAC_NINH_V1 = { latitude: 21.186082, longitude: 106.076314 };
const BRANCH_BAC_NINH_V2 = { latitude: 10.776889, longitude: 106.700806 };

let uuidSeq = 0;
function nextUuid() {
  uuidSeq += 1;
  return `f9100000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
}

function haversineMetersOracle(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const meters = 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(Math.max(0, a))));
  return Math.round(meters * 10) / 10;
}

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

async function createDatabase({
  stopBeforeTarget = false,
  targetMigrationName = ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_MIGRATION_NAME,
} = {}) {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = await loadMigrations();
  const targetIndex = migrations.findIndex((m) => m.name === targetMigrationName);
  assert.ok(targetIndex >= 0, "Target migration must exist");
  const slice = stopBeforeTarget ? migrations.slice(0, targetIndex) : migrations;
  for (const m of slice) {
    await db.exec(m.sql);
  }
  return { db, migrations, targetMigration: migrations[targetIndex] };
}

async function seedActorsAndCatalog(db) {
  await db.query(
    `insert into public.teams (team_id, code, display_name, active)
     values ($1::uuid, 'MAT_ALPHA', 'Nhóm Tuyển Dụng Alpha', true)`,
    [TEAM_ALPHA],
  );

  for (const actor of Object.values(ACTORS)) {
    await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
       values ($1::uuid, $2::uuid, $3, $4)`,
      [actor.app, actor.auth, actor.name, actor !== ACTORS.DISABLED_STAFF],
    );
  }

  const grantCaps = async (actor, caps) => {
    for (const cap of caps) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, $2, '2026-01-01', true)`,
        [actor.app, cap],
      );
    }
  };

  const grantScope = async (actor, scopeKind, teamId = null) => {
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, $2, $3::uuid, '2026-01-01', true)`,
      [actor.app, scopeKind, teamId],
    );
  };

  await grantCaps(ACTORS.FULL_ADMIN, [
    "entry_admin",
    "recruiter_master_manage",
    "team_master_manage",
  ]);
  await grantScope(ACTORS.FULL_ADMIN, "all");

  await grantCaps(ACTORS.BOD_PRIVILEGED, ["entry_privileged_edit"]);
  await grantScope(ACTORS.BOD_PRIVILEGED, "all");

  await grantCaps(ACTORS.PROJECT_ADMIN, ["entry_admin"]);
  await grantScope(ACTORS.PROJECT_ADMIN, "all");

  await grantCaps(ACTORS.TEAM_LEADER, [
    "team_manager_assign",
    "report_view",
    "report_analytics_view",
  ]);
  await grantScope(ACTORS.TEAM_LEADER, "team", TEAM_ALPHA);

  await grantCaps(ACTORS.STAFF_A, ["entry_create", "entry_own", "submission_create"]);
  await grantScope(ACTORS.STAFF_A, "own");

  await grantCaps(ACTORS.STAFF_B, ["entry_create", "entry_own", "submission_create"]);
  await grantScope(ACTORS.STAFF_B, "own");

  for (const staff of [ACTORS.STAFF_A, ACTORS.STAFF_B]) {
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
       values ($1::uuid, $2, $3, 'STAFF', true)`,
      [staff.recruiter, staff.name, staff.code],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
       values ($1::uuid, 'hrp', '2026-01-01', true)`,
      [staff.recruiter],
    );
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, '2026-01-01', true)`,
      [staff.recruiter, TEAM_ALPHA],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
      [staff.app, staff.recruiter],
    );
  }

  await db.query(
    `insert into public.direct_entry_projects (project_id, display_name, active, version)
     values ('luxshare-bn', 'Luxshare Bắc Ninh', true, 1),
            ('goertek-bn', 'Goertek Bắc Ninh', true, 1)`,
  );
}

async function callAsServiceRole(db, sql, params = []) {
  await db.exec("begin; set local role service_role;");
  try {
    const res = await db.query(sql, params);
    await db.exec("commit;");
    return res.rows[0]?.data;
  } catch (err) {
    await db.exec("rollback;");
    throw err;
  }
}

async function recordCheckInAsServiceRole(db, input) {
  const idempotencyKey = input.idempotency_key ?? nextUuid();
  const timeSource = input.time_source ?? "SERVER_ANCHORED";
  const capturedIso = input.captured_at;
  const receivedIso = input.received_at ?? input.captured_at;
  const anchorIssuedIso = timeSource === "SERVER_ANCHORED" ? capturedIso : null;
  const elapsedMs = timeSource === "SERVER_ANCHORED" ? 0 : null;
  const tokenDigest = timeSource === "SERVER_ANCHORED" ? TOKEN_DIGEST : null;
  const addressHint = input.address_hint ?? "Địa chỉ thử nghiệm";
  const note = input.note ?? "";
  const accuracyMeters = input.accuracy_meters ?? 12.0;

  const fingerprint = computeAttendanceRequestFingerprint({
    app_user_id: input.actor.app,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracy_meters: accuracyMeters,
    address_hint: addressHint,
    note,
    client_captured_at_ms: Date.parse(capturedIso),
    time_source: timeSource,
    time_token_digest: tokenDigest,
    elapsed_since_anchor_ms: elapsedMs,
    photo_sha256: PHOTO_SHA,
  });

  return callAsServiceRole(
    db,
    `select public.attendance_record_checkin(
      $1::uuid, $2::uuid, $3::uuid, $4::text,
      $5::double precision, $6::double precision, $7::double precision,
      $8::text, $9::text, $10::timestamptz, $11::text, $12::timestamptz,
      $13::bigint, $14::text, $15::text, $16::text, $17::integer, $18::text, $19::timestamptz
    ) as data`,
    [
      input.actor.auth,
      input.actor.app,
      idempotencyKey,
      fingerprint,
      input.latitude,
      input.longitude,
      accuracyMeters,
      addressHint,
      note,
      capturedIso,
      timeSource,
      anchorIssuedIso,
      elapsedMs,
      tokenDigest,
      `preview/attendance/2026-10-05/${input.actor.app}/${idempotencyKey}.jpg`,
      PHOTO_SHA,
      4096,
      ATTENDANCE_PHOTO_MIME_TYPE,
      receivedIso,
    ],
  );
}

test("Migration 20261102120000 rolls back atomically on error and exposes only service_role RPCs", async () => {
  const { db, targetMigration } = await createDatabase({ stopBeforeTarget: true });
  try {
    assert.equal(
      targetMigration.name,
      ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_MIGRATION_NAME,
    );
    const checksum = migrationChecksum(targetMigration.sql);
    assert.match(checksum, /^[0-9a-f]{64}$/);
    assert.equal(
      migrationChecksum(targetMigration.sql.replace(/\n/g, "\r\n")),
      checksum,
    );

    const failingSql = `${migrationSqlForTransaction(targetMigration.sql)}\nselect 1 / 0;\n`;
    await assert.rejects(
      async () => {
        await db.exec("begin;");
        try {
          await db.exec(failingSql);
          await db.exec("commit;");
        } catch (err) {
          await db.exec("rollback;");
          throw err;
        }
      },
      (err) => err.code === "22012",
    );

    const { rows: leftoverTables } = await db.query(
      `select count(*)::int as n
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in (
            'attendance_branches',
            'attendance_branch_revisions',
            'attendance_branch_assignments'
          )`,
    );
    assert.equal(leftoverTables[0].n, 0, "rollback leaves zero branch tables");

    await db.exec("begin;");
    await db.exec(migrationSqlForTransaction(targetMigration.sql));
    await db.exec("commit;");

    for (const sig of ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_RPC_SIGNATURES) {
      const { rows } = await db.query("select to_regprocedure($1)::text as oid_name", [sig]);
      assert.ok(rows[0].oid_name, `RPC ${sig} must exist after commit`);
    }
  } finally {
    await db.close();
  }
});

test("Migration 20261103120000 upgrades untouched Stage 1 default to 5 slots and never overwrites Admin-customized policies", async () => {
  const { db, targetMigration } = await createDatabase({
    stopBeforeTarget: true,
    targetMigrationName: ATTENDANCE_FLEXIBLE_SLOT_POLICY_MIGRATION_NAME,
  });
  try {
    await seedActorsAndCatalog(db);
    // Simulate an Admin having created a custom Stage 1 policy v2 before 20261103120000 runs
    await callAsServiceRole(
      db,
      `select public.attendance_create_slot_policy_admin(
        $1::uuid, $2::uuid, '2026-12-01'::date,
        '07:45', 10, 10, '11:45', 10, 10, '13:15', 10, 10, '17:15', 10, 10,
        1, $3::uuid, $4::text
      ) as data`,
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, nextUuid(), "e".repeat(64)],
    );

    // Apply Stage 1.5 migration
    await db.exec("begin;");
    await db.exec(migrationSqlForTransaction(targetMigration.sql));
    await db.exec("commit;");

    for (const sig of ATTENDANCE_FLEXIBLE_SLOT_POLICY_RPC_SIGNATURES) {
      const { rows } = await db.query("select to_regprocedure($1)::text as oid_name", [sig]);
      assert.ok(rows[0].oid_name, `RPC ${sig} must exist after Stage 1.5 commit`);
    }

    const policiesRaw = await callAsServiceRole(
      db,
      "select public.attendance_get_slot_policies_admin($1::uuid, $2::uuid) as data",
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
    );
    const policies = projectAttendanceSlotPoliciesAdminList(policiesRaw);
    assert.ok(policies, "Admin-customized policies project cleanly after Stage 1.5 upgrade");
    assert.equal(policies.versions.length, 2);

    const v2 = policies.versions.find((v) => v.version === 2);
    const v1 = policies.versions.find((v) => v.version === 1);
    assert.ok(v1 && v2);
    // Neither v1 nor Admin-created v2 was overwritten with 5 slots because Admin had already configured v2!
    assert.deepEqual(
      v1.slots.map((s) => s.target_time),
      ["08:00", "11:00", "13:00", "17:00"],
    );
    assert.deepEqual(
      v2.slots.map((s) => s.target_time),
      ["07:45", "11:45", "13:15", "17:15"],
    );
  } finally {
    await db.close();
  }
});

test("HRP Branches, Branch Check-In Distance Snapshot Immutability, Project Coordinates, HRP Sync Catalog & Monthly Attendance Matrix Report", async () => {
  const { db } = await createDatabase();
  try {
    await seedActorsAndCatalog(db);

    // -------------------------------------------------------------------------
    // 1. Direct table and helper ACL checks
    // -------------------------------------------------------------------------
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const table of [
        "attendance_branches",
        "attendance_branch_revisions",
        "attendance_branch_assignments",
      ]) {
        await assert.rejects(
          async () => {
            await db.exec(`begin; set local role ${role};`);
            try {
              await db.query(`select * from public.${table}`);
              await db.exec("commit;");
            } catch (err) {
              await db.exec("rollback;");
              throw err;
            }
          },
          (err) => err.code === "42501",
          `${role} must not have direct SELECT on ${table}`,
        );
      }
    }

    // -------------------------------------------------------------------------
    // 2. Configure HQ v1 and HRP Branches (with & without coordinates)
    // -------------------------------------------------------------------------
    const hqKey = nextUuid();
    const hqFp = computeHqLocationRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      expected_version: 0,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
    });
    await callAsServiceRole(
      db,
      "select public.attendance_set_hq_location($1::uuid, $2::uuid, $3::double precision, $4::double precision, $5::integer, $6::uuid, $7::text) as data",
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        HQ_HANOI.latitude,
        HQ_HANOI.longitude,
        0,
        hqKey,
        hqFp,
      ],
    );

    // BoD reader cannot write branches
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          "select public.attendance_upsert_branch_admin($1::uuid, $2::uuid, null, 'BN_01', 'Chi nhánh Bắc Ninh', 'KCN VSIP', 21.18, 106.07, true, 0, $3::uuid, $4::text) as data",
          [ACTORS.BOD_PRIVILEGED.auth, ACTORS.BOD_PRIVILEGED.app, nextUuid(), "a".repeat(64)],
        ),
      (err) => err.code === "42501" && String(err.message).includes("ATTENDANCE_BRANCH_WRITE_DENIED"),
    );

    // Create Branch 1 (with coordinates): BN_01 v1
    const bnCreateKey = nextUuid();
    const bnCreateFp = computeBranchUpsertRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      branch_id: null,
      branch_code: "BN_01",
      display_name: "Chi nhánh Bắc Ninh",
      address: "KCN VSIP Bắc Ninh",
      latitude: BRANCH_BAC_NINH_V1.latitude,
      longitude: BRANCH_BAC_NINH_V1.longitude,
      active: true,
      expected_version: 0,
    });
    const bnCreatedRaw = await callAsServiceRole(
      db,
      `select public.attendance_upsert_branch_admin(
        $1::uuid, $2::uuid, null, 'BN_01', 'Chi nhánh Bắc Ninh', 'KCN VSIP Bắc Ninh',
        $3::double precision, $4::double precision, true, 0, $5::uuid, $6::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        BRANCH_BAC_NINH_V1.latitude,
        BRANCH_BAC_NINH_V1.longitude,
        bnCreateKey,
        bnCreateFp,
      ],
    );
    const bnCreated = projectUpsertBranchResult(bnCreatedRaw);
    assert.ok(bnCreated, "strict projection passes for branch create");
    assert.equal(bnCreated.replayed, false);
    assert.equal(bnCreated.branch.branch_code, "BN_01");
    assert.equal(bnCreated.branch.version, 1);
    const bnBranchId = bnCreated.branch.branch_id;

    // Idempotent replay of branch create returns replayed = true
    const bnReplayRaw = await callAsServiceRole(
      db,
      `select public.attendance_upsert_branch_admin(
        $1::uuid, $2::uuid, null, 'BN_01', 'Chi nhánh Bắc Ninh', 'KCN VSIP Bắc Ninh',
        $3::double precision, $4::double precision, true, 0, $5::uuid, $6::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        BRANCH_BAC_NINH_V1.latitude,
        BRANCH_BAC_NINH_V1.longitude,
        bnCreateKey,
        bnCreateFp,
      ],
    );
    assert.equal(bnReplayRaw.replayed, true);
    assert.equal(bnReplayRaw.branch.branch_id, bnBranchId);

    // Create Branch 2 (without coordinates): DN_NO_GPS v1
    const dnCreateKey = nextUuid();
    const dnCreateFp = computeBranchUpsertRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      branch_id: null,
      branch_code: "DN_NO_GPS",
      display_name: "Chi nhánh Đà Nẵng (Chưa gắn GPS)",
      address: "Hải Châu, Đà Nẵng",
      latitude: null,
      longitude: null,
      active: true,
      expected_version: 0,
    });
    const dnCreatedRaw = await callAsServiceRole(
      db,
      `select public.attendance_upsert_branch_admin(
        $1::uuid, $2::uuid, null, 'DN_NO_GPS', 'Chi nhánh Đà Nẵng (Chưa gắn GPS)', 'Hải Châu, Đà Nẵng',
        null, null, true, 0, $3::uuid, $4::text
      ) as data`,
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, dnCreateKey, dnCreateFp],
    );
    const dnCreated = projectUpsertBranchResult(dnCreatedRaw);
    assert.ok(dnCreated);
    assert.equal(dnCreated.branch.latitude, null);
    assert.equal(dnCreated.branch.longitude, null);
    const dnBranchId = dnCreated.branch.branch_id;

    // Append-only immutability on attendance_branch_revisions
    await assert.rejects(
      () => db.query("delete from public.attendance_branch_revisions"),
      (err) => String(err.message).includes("ATTENDANCE_CHECKINS_IMMUTABLE"),
    );

    // -------------------------------------------------------------------------
    // 3. Employee Branch Assignment by app_user_id & Overlap Guard
    // -------------------------------------------------------------------------
    const assign1Key = nextUuid();
    const assign1Fp = computeBranchAssignRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      target_app_user_id: ACTORS.STAFF_A.app,
      branch_id: bnBranchId,
      valid_from: "2026-11-01",
      expected_version: 1,
    });
    const assign1Raw = await callAsServiceRole(
      db,
      `select public.attendance_assign_employee_branch_admin(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-11-01'::date, 1, $5::uuid, $6::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        ACTORS.STAFF_A.app,
        bnBranchId,
        assign1Key,
        assign1Fp,
      ],
    );
    const assign1 = projectAssignBranchResult(assign1Raw);
    assert.ok(assign1);
    assert.equal(assign1.assignment.app_user_id, ACTORS.STAFF_A.app);
    assert.equal(assign1.assignment.branch_id, bnBranchId);
    assert.equal(assign1.assignment.valid_from, "2026-11-01");
    assert.equal(assign1.assignment.valid_to, null);

    // Overlapping assignment for STAFF_A must fail with ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_assign_employee_branch_admin(
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-11-10'::date, 1, $5::uuid, $6::text
          ) as data`,
          [
            ACTORS.FULL_ADMIN.auth,
            ACTORS.FULL_ADMIN.app,
            ACTORS.STAFF_A.app,
            dnBranchId,
            nextUuid(),
            "e".repeat(64),
          ],
        ),
      (err) =>
        (err.code === "PT409" || err.code === "23505") &&
        String(err.message).includes("ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP"),
    );

    // Assigning disabled user must fail with ATTENDANCE_BRANCH_TARGET_USER_INVALID
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_assign_employee_branch_admin(
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-11-01'::date, 1, $5::uuid, $6::text
          ) as data`,
          [
            ACTORS.FULL_ADMIN.auth,
            ACTORS.FULL_ADMIN.app,
            ACTORS.DISABLED_STAFF.app,
            bnBranchId,
            nextUuid(),
            "f".repeat(64),
          ],
        ),
      (err) =>
        err.code === "22023" &&
        String(err.message).includes("ATTENDANCE_BRANCH_TARGET_USER_INVALID"),
    );

    // -------------------------------------------------------------------------
    // 4. Check-In Distance by Branch vs HQ & Snapshot Immutability
    // -------------------------------------------------------------------------
    // 4a. STAFF_A (assigned to BN_01 v1) checks in on 2026-11-05 (08:15 VN = 01:15 UTC)
    const staffACheckin1Lat = 21.187;
    const staffACheckin1Lon = 106.077;
    const expectedBranchDist1 = haversineMetersOracle(
      staffACheckin1Lat,
      staffACheckin1Lon,
      BRANCH_BAC_NINH_V1.latitude,
      BRANCH_BAC_NINH_V1.longitude,
    );

    const checkin1 = await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_A,
      latitude: staffACheckin1Lat,
      longitude: staffACheckin1Lon,
      captured_at: "2026-11-05T01:15:00.000Z",
    });
    assert.equal(checkin1.replayed, false);

    // 4b. STAFF_A second check-in on 2026-11-05 (17:30 VN = 10:30 UTC)
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_A,
      latitude: staffACheckin1Lat,
      longitude: staffACheckin1Lon,
      captured_at: "2026-11-05T10:30:00.000Z",
    });

    // 4c. Now update BN_01 coordinates to v2 (~1,150 km away in HCMC)
    const bnUpdateKey = nextUuid();
    const bnUpdateFp = computeBranchUpsertRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      branch_id: bnBranchId,
      branch_code: "BN_01",
      display_name: "Chi nhánh Bắc Ninh (Đổi Tọa Độ)",
      address: "KCN VSIP Bắc Ninh",
      latitude: BRANCH_BAC_NINH_V2.latitude,
      longitude: BRANCH_BAC_NINH_V2.longitude,
      active: true,
      expected_version: 1,
    });
    const bnUpdatedRaw = await callAsServiceRole(
      db,
      `select public.attendance_upsert_branch_admin(
        $1::uuid, $2::uuid, $3::uuid, 'BN_01', 'Chi nhánh Bắc Ninh (Đổi Tọa Độ)', 'KCN VSIP Bắc Ninh',
        $4::double precision, $5::double precision, true, 1, $6::uuid, $7::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        bnBranchId,
        BRANCH_BAC_NINH_V2.latitude,
        BRANCH_BAC_NINH_V2.longitude,
        bnUpdateKey,
        bnUpdateFp,
      ],
    );
    assert.equal(bnUpdatedRaw.branch.version, 2);

    // 4d. Unassign STAFF_A from BN_01 on 2026-11-15 and assign to DN_NO_GPS from 2026-11-16
    const unassign1Key = nextUuid();
    const unassign1Fp = computeBranchUnassignRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      assignment_id: assign1.assignment.assignment_id,
      valid_to: "2026-11-15",
      expected_version: 1,
    });
    const unassign1Raw = await callAsServiceRole(
      db,
      `select public.attendance_unassign_employee_branch_admin(
        $1::uuid, $2::uuid, $3::uuid, '2026-11-15'::date, 1, $4::uuid, $5::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        assign1.assignment.assignment_id,
        unassign1Key,
        unassign1Fp,
      ],
    );
    const unassign1 = projectUnassignBranchResult(unassign1Raw);
    assert.ok(unassign1);
    assert.equal(unassign1.assignment.valid_to, "2026-11-15");
    assert.equal(unassign1.assignment.version, 2);

    const assign2Key = nextUuid();
    const assign2Fp = computeBranchAssignRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      target_app_user_id: ACTORS.STAFF_A.app,
      branch_id: dnBranchId,
      valid_from: "2026-11-16",
      expected_version: 1,
    });
    await callAsServiceRole(
      db,
      `select public.attendance_assign_employee_branch_admin(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-11-16'::date, 1, $5::uuid, $6::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        ACTORS.STAFF_A.app,
        dnBranchId,
        assign2Key,
        assign2Fp,
      ],
    );

    // 4e. STAFF_A checks in on 2026-11-17 while assigned to DN_NO_GPS (missing branch coordinates)
    // Must succeed, record BRANCH_NOT_CONFIGURED with distance_meters = null, and NOT fallback to HQ!
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_A,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-11-17T01:00:00.000Z",
    });

    // 4f. STAFF_B (unassigned to any branch) checks in on 2026-11-05 near HQ_HANOI
    const staffBCheckinLat = 21.029;
    const staffBCheckinLon = 105.805;
    const expectedHqDist = haversineMetersOracle(
      staffBCheckinLat,
      staffBCheckinLon,
      HQ_HANOI.latitude,
      HQ_HANOI.longitude,
    );
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_B,
      latitude: staffBCheckinLat,
      longitude: staffBCheckinLon,
      captured_at: "2026-11-05T01:20:00.000Z",
    });

    // Verify attendance_admin_report preserves historical BN_01 v1 snapshot & DN_NO_GPS status
    const adminReportRaw = await callAsServiceRole(
      db,
      `select public.attendance_admin_report(
        $1::uuid, $2::uuid, '2026-11-01'::date, '2026-11-30'::date, 1, 25, null, null
      ) as data`,
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
    );
    const adminReport = projectAttendanceAdminReport(adminReportRaw);
    assert.ok(adminReport, "attendance_admin_report strict projection passes with branch fields");

    const nov17Item = adminReport.items.find(
      (i) => i.employee_display_name === ACTORS.STAFF_A.name && i.business_date === "2026-11-17",
    );
    assert.ok(nov17Item);
    assert.equal(nov17Item.distance_status, "BRANCH_NOT_CONFIGURED");
    assert.equal(nov17Item.distance_meters, null);
    assert.equal(nov17Item.hq_version_used, null);
    assert.equal(nov17Item.branch_code_used, "DN_NO_GPS");
    assert.equal(nov17Item.branch_version_used, 1);

    const nov05StaffAItems = adminReport.items.filter(
      (i) => i.employee_display_name === ACTORS.STAFF_A.name && i.business_date === "2026-11-05",
    );
    assert.equal(nov05StaffAItems.length, 2);
    for (const item of nov05StaffAItems) {
      assert.equal(item.distance_status, "COMPUTED");
      assert.equal(item.distance_meters, expectedBranchDist1);
      assert.equal(item.branch_id_used, bnBranchId);
      assert.equal(item.branch_code_used, "BN_01");
      assert.equal(item.branch_name_used, "Chi nhánh Bắc Ninh");
      assert.equal(
        item.branch_version_used,
        1,
        "historical check-in must keep branch_version_used = 1 after BN_01 is updated to v2",
      );
      assert.equal(item.hq_version_used, null);
    }

    const nov05StaffBItem = adminReport.items.find(
      (i) => i.employee_display_name === ACTORS.STAFF_B.name && i.business_date === "2026-11-05",
    );
    assert.ok(nov05StaffBItem);
    assert.equal(nov05StaffBItem.distance_status, "COMPUTED");
    assert.equal(nov05StaffBItem.distance_meters, expectedHqDist);
    assert.equal(nov05StaffBItem.hq_version_used, 1);
    assert.equal(nov05StaffBItem.branch_id_used, null);

    // Verify attendance_list_branches_admin
    const branchListRaw = await callAsServiceRole(
      db,
      "select public.attendance_list_branches_admin($1::uuid, $2::uuid, true) as data",
      [ACTORS.BOD_PRIVILEGED.auth, ACTORS.BOD_PRIVILEGED.app],
    );
    const branchList = projectAttendanceBranchesAdminList(branchListRaw);
    assert.ok(branchList, "attendance_list_branches_admin strict projection passes");
    assert.equal(branchList.viewer.can_manage_branches, false);
    assert.equal(branchList.branches.length, 2);
    assert.equal(branchList.assignments.length, 2);

    // -------------------------------------------------------------------------
    // 5. Approved Leaves & Monthly Attendance Matrix Report
    // -------------------------------------------------------------------------
    const leaveReqId1 = nextUuid();
    const leaveReqId2 = nextUuid();
    await db.query(
      `insert into public.leave_requests (
         request_id, app_user_id, status, employment_status_snapshot, unit_kind_snapshot,
         profile_configured_at_submit, requested_units, reason, route_kind,
         submitted_at, decided_at, decided_by_app_user_id, row_version
       ) values
       ($1::uuid, $2::uuid, 'APPROVED', 'OFFICIAL', 'RECRUITMENT', true, 3, 'Nghỉ phép tháng 11', 'TEAM_LEADER', now(), now(), $3::uuid, 2),
       ($4::uuid, $5::uuid, 'PENDING', 'OFFICIAL', 'RECRUITMENT', true, 2, 'Chưa duyệt', 'TEAM_LEADER', now(), null, null, 1)`,
      [
        leaveReqId1,
        ACTORS.STAFF_A.app,
        ACTORS.FULL_ADMIN.app,
        leaveReqId2,
        ACTORS.STAFF_A.app,
      ],
    );

    await db.query(
      `insert into public.leave_request_days (
         request_id, app_user_id, leave_date, session_code,
         leave_type, half_day_units, is_active
       ) values
       ($1::uuid, $2::uuid, '2026-11-06'::date, 'FULL', 'ANNUAL', 2, true),
       ($1::uuid, $2::uuid, '2026-11-05'::date, 'PM', 'UNPAID', 1, true),
       ($3::uuid, $2::uuid, '2026-11-07'::date, 'FULL', 'ANNUAL', 2, true)`,
      [leaveReqId1, ACTORS.STAFF_A.app, leaveReqId2],
    );

    const matrixRaw = await callAsServiceRole(
      db,
      `select public.attendance_monthly_matrix_report(
        $1::uuid, $2::uuid, '2026-11', null, null, null, 1, 25
      ) as data`,
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
    );
    const matrix = projectAttendanceMonthlyMatrixReport(matrixRaw);
    assert.ok(matrix, "attendance_monthly_matrix_report strict projection passes");
    assert.equal(matrix.filters.year_month, "2026-11");
    assert.equal(matrix.days_in_month, 30);
    assert.equal(matrix.calendar_days.length, 30);

    const staffARow = matrix.items.find((r) => r.app_user_id === ACTORS.STAFF_A.app);
    assert.ok(staffARow, "STAFF_A row present in monthly matrix");
    assert.equal(staffARow.personnel_code, "NV_MAT_01");
    assert.equal(staffARow.summary.checkin_day_count, 2); // Nov 5 and Nov 17
    assert.equal(staffARow.summary.total_checkins, 3); // 2 on Nov 5 + 1 on Nov 17
    assert.equal(staffARow.summary.approved_leave_day_count, 2); // Nov 5 (PM) and Nov 6 (FULL); Nov 7 SUBMITTED is excluded
    assert.equal(staffARow.summary.approved_leave_units, 1.5); // 3 half-day units = 1.5 days
    assert.equal(staffARow.summary.checkin_and_leave_day_count, 1); // Nov 5 has both check-in and PM leave
    const { rows: businessDateRows } = await db.query(
      "select to_char(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as today_vn",
    );
    const [todayYear, todayMonth, todayDay] = businessDateRows[0].today_vn
      .split("-")
      .map(Number);
    const todayMonthKey = todayYear * 12 + todayMonth;
    const reportMonthKey = 2026 * 12 + 11;
    const completedDayCount = Math.min(
      30,
      Math.max(
        0,
        todayMonthKey > reportMonthKey
          ? 30
          : todayMonthKey === reportMonthKey
            ? todayDay - 1
            : 0,
      ),
    );
    const elapsedCheckinDays = [5, 17].filter((day) => day <= completedDayCount).length;
    const elapsedLeaveDays = [5, 6].filter((day) => day <= completedDayCount).length;
    const elapsedOverlapDays = [5].filter((day) => day <= completedDayCount).length;
    assert.equal(staffARow.summary.no_checkin_day_count, completedDayCount - elapsedCheckinDays);
    assert.equal(
      staffARow.summary.no_checkin_without_leave_day_count,
      completedDayCount - elapsedCheckinDays - (elapsedLeaveDays - elapsedOverlapDays),
      "Only completed calendar days contribute to missing-attendance totals",
    );

    const nov05Cell = staffARow.days.find((d) => d.business_date === "2026-11-05");
    assert.ok(nov05Cell);
    assert.equal(nov05Cell.day_status, "CHECKED_IN_AND_LEAVE");
    assert.equal(nov05Cell.checkin_count, 2);
    assert.equal(nov05Cell.first_time_local, "08:15");
    assert.equal(nov05Cell.last_time_local, "17:30");
    assert.equal(nov05Cell.distance_target_kind, "BRANCH");
    assert.equal(nov05Cell.branch_code_used, "BN_01");
    assert.equal(nov05Cell.branch_version_used, 1);
    assert.equal(nov05Cell.distance_meters, expectedBranchDist1);
    assert.equal(nov05Cell.has_approved_leave, true);
    assert.equal(nov05Cell.approved_leave_units, 0.5);
    assert.equal(nov05Cell.approved_leaves.length, 1);
    assert.equal(nov05Cell.approved_leaves[0].session_code, "PM");
    assert.equal(nov05Cell.approved_leaves[0].leave_type, "UNPAID");

    const nov06Cell = staffARow.days.find((d) => d.business_date === "2026-11-06");
    assert.ok(nov06Cell);
    assert.equal(nov06Cell.day_status, "APPROVED_LEAVE");
    assert.equal(nov06Cell.has_checkin, false);
    assert.equal(nov06Cell.has_approved_leave, true);
    assert.equal(nov06Cell.approved_leave_units, 1);
    assert.equal(nov06Cell.approved_leaves[0].session_code, "FULL");
    assert.equal(nov06Cell.approved_leaves[0].leave_type, "ANNUAL");

    const nov07Cell = staffARow.days.find((d) => d.business_date === "2026-11-07");
    assert.ok(nov07Cell);
    assert.ok(
      ["UPCOMING", "NO_CHECKIN"].includes(nov07Cell.day_status),
      "unapproved leave does not cover attendance; the day is upcoming until slots are due",
    );
    assert.equal(nov07Cell.has_approved_leave, false);
    assert.ok(nov07Cell.slots.every((slot) => slot.slot_status !== "LEAVE_COVERED"));

    const nov17Cell = staffARow.days.find((d) => d.business_date === "2026-11-17");
    assert.ok(nov17Cell);
    assert.equal(nov17Cell.day_status, "CHECKED_IN");
    assert.equal(nov17Cell.distance_target_kind, "BRANCH");
    assert.equal(nov17Cell.distance_status, "BRANCH_NOT_CONFIGURED");
    assert.equal(nov17Cell.distance_meters, null);

    // Filter monthly matrix by historical branch_id_used (bnBranchId)
    const bnFilteredRaw = await callAsServiceRole(
      db,
      `select public.attendance_monthly_matrix_report(
        $1::uuid, $2::uuid, '2026-11', $3::uuid, null, null, 1, 25
      ) as data`,
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, bnBranchId],
    );
    const bnFiltered = projectAttendanceMonthlyMatrixReport(bnFilteredRaw);
    assert.ok(bnFiltered);
    assert.equal(bnFiltered.items.length, 1);
    assert.equal(bnFiltered.items[0].app_user_id, ACTORS.STAFF_A.app);

    // Snapshot token consistency across paginated RPC calls & change detection when data mutates with identical total_rows
    const page1BeforeEdit = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-11', null, null, null, 1, 1
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
      ),
    );
    const page2BeforeEdit = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-11', null, null, null, 2, 1
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
      ),
    );
    assert.ok(page1BeforeEdit && page2BeforeEdit);
    assert.match(page1BeforeEdit.pagination.snapshot_token, /^[0-9a-f]{32}$/);
    assert.equal(
      page2BeforeEdit.pagination.snapshot_token,
      page1BeforeEdit.pagination.snapshot_token,
      "snapshot_token must match across pages when reading the same dataset state",
    );

    // Approve leaveReqId2 (Nov 7) mid-export: total_rows remains identical, but dataset snapshot changes
    await db.query(
      "update public.leave_requests set status = 'APPROVED', decided_at = now(), decided_by_app_user_id = $2::uuid where request_id = $1::uuid",
      [leaveReqId2, ACTORS.FULL_ADMIN.app],
    );
    const page2AfterEdit = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-11', null, null, null, 2, 1
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
      ),
    );
    assert.ok(page2AfterEdit);
    assert.equal(
      page2AfterEdit.pagination.total_rows,
      page1BeforeEdit.pagination.total_rows,
      "total_rows stays identical after mid-export edit",
    );
    assert.notEqual(
      page2AfterEdit.pagination.snapshot_token,
      page1BeforeEdit.pagination.snapshot_token,
      "snapshot_token must change when underlying attendance/leave data changes with identical row count",
    );

    // -------------------------------------------------------------------------
    // 6. Project Coordinates Admin CRUD & HRP Sync Catalog RPC
    // -------------------------------------------------------------------------
    // Team leader cannot update project coordinates
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.direct_entry_update_project_location(
            $1::uuid, $2::uuid, 'luxshare-bn', 1, 'KCN Quang Châu', 21.2581234, 106.1534567, 250, false, 'Cập nhật tọa độ', 'idem-proj-loc-denied'
          ) as data`,
          [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app],
        ),
      (err) => err.code === "42501",
    );

    const updatedLocRaw = await callAsServiceRole(
      db,
      `select public.direct_entry_update_project_location(
        $1::uuid, $2::uuid, 'luxshare-bn', 1, 'KCN Quang Châu, Việt Yên, Bắc Giang',
        21.2581234, 106.1534567, 250, false, 'Xác nhận tọa độ cổng chính', 'idem-proj-loc-1'
      ) as data`,
      [ACTORS.PROJECT_ADMIN.auth, ACTORS.PROJECT_ADMIN.app],
    );
    const updatedLoc = projectAdminLocationMutation(updatedLocRaw);
    assert.equal(updatedLoc.project_id, "luxshare-bn");
    assert.equal(updatedLoc.version, 2);
    assert.deepEqual(updatedLoc.location, {
      address: "KCN Quang Châu, Việt Yên, Bắc Giang",
      latitude: 21.2581234,
      longitude: 106.1534567,
      radius_meters: 250,
      confirmed_at: updatedLoc.location.confirmed_at,
    });

    // List & Get projects admin include location
    const listedProjectsRaw = await callAsServiceRole(
      db,
      "select public.direct_entry_list_projects_admin($1::uuid, $2::uuid, true) as data",
      [ACTORS.PROJECT_ADMIN.auth, ACTORS.PROJECT_ADMIN.app],
    );
    const listedProjects = projectAdminList(listedProjectsRaw);
    const luxProject = listedProjects.projects.find((p) => p.project_id === "luxshare-bn");
    assert.ok(luxProject);
    assert.equal(luxProject.version, 2);
    assert.equal(luxProject.location?.latitude, 21.2581234);
    assert.equal(luxProject.location?.radius_meters, 250);

    const gotProjectRaw = await callAsServiceRole(
      db,
      "select public.direct_entry_get_project_admin($1::uuid, $2::uuid, 'goertek-bn') as data",
      [ACTORS.PROJECT_ADMIN.auth, ACTORS.PROJECT_ADMIN.app],
    );
    const gotProject = projectAdminProject(gotProjectRaw);
    assert.equal(gotProject.location, null);

    // HRP Sync Catalog RPC
    const requestId = nextUuid();
    const hrpCatalogRaw = await callAsServiceRole(
      db,
      "select public.hrp_sync_catalog($1::uuid, null, $2::uuid) as data",
      [ACTORS.PROJECT_ADMIN.auth, requestId],
    );
    const hrpCatalog = projectHrpSyncCatalog(hrpCatalogRaw);
    assert.ok(hrpCatalog, "hrp_sync_catalog matches BI-HRP-WORKER-SYNC-CONTRACT.md §3.1");
    assert.equal(hrpCatalog.ok, true);
    const hrpLux = hrpCatalog.projects.find((p) => p.projectId === "luxshare-bn");
    assert.ok(hrpLux);
    assert.equal(hrpLux.version, 2);
    assert.deepEqual(hrpLux.location, {
      address: "KCN Quang Châu, Việt Yên, Bắc Giang",
      latitude: 21.2581234,
      longitude: 106.1534567,
      radiusMeters: 250,
      confirmedAt: hrpLux.location?.confirmedAt ?? null,
    });
    const hrpGoertek = hrpCatalog.projects.find((p) => p.projectId === "goertek-bn");
    assert.ok(hrpGoertek);
    assert.equal(hrpGoertek.location, null);

    // Verify audit event written for hrp_sync_catalog_read
    const { rows: auditRows } = await db.query(
      `select action, capability, resource_ref, outcome, changed_fields
         from public.direct_entry_audit_events
        where action = 'hrp_sync_catalog_read'
          and resource_ref = $1`,
      [`hrp_v1_catalog:${requestId}`],
    );
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].outcome, "ALLOW");
    assert.equal(auditRows[0].capability, "integration_hrp_catalog");

    // Clear project coordinates
    const clearedLocRaw = await callAsServiceRole(
      db,
      `select public.direct_entry_update_project_location(
        $1::uuid, $2::uuid, 'luxshare-bn', 2, null, null, null, null, true, 'Xóa tọa độ tạm', 'idem-proj-loc-clear'
      ) as data`,
      [ACTORS.PROJECT_ADMIN.auth, ACTORS.PROJECT_ADMIN.app],
    );
    const clearedLoc = projectAdminLocationMutation(clearedLocRaw);
    assert.equal(clearedLoc.version, 3);
    assert.equal(clearedLoc.location, null);

    // -------------------------------------------------------------------------
    // 7. Flexible Slot Monthly Attendance Matrix & Date-Effective Slot Policy Configuration
    // -------------------------------------------------------------------------
    // 7a. Default seeded slot policy version 1 (5 slots: 07:30, 10:00, 13:00, 15:00, 16:30, ±15m)
    const slotPoliciesRaw1 = await callAsServiceRole(
      db,
      "select public.attendance_get_slot_policies_admin($1::uuid, $2::uuid) as data",
      [ACTORS.BOD_PRIVILEGED.auth, ACTORS.BOD_PRIVILEGED.app],
    );
    const slotPolicies1 = projectAttendanceSlotPoliciesAdminList(slotPoliciesRaw1);
    assert.ok(slotPolicies1, "attendance_get_slot_policies_admin strict projection passes");
    assert.equal(slotPolicies1.viewer.can_manage_slot_policy, false);
    assert.equal(slotPolicies1.current_policy.version, 1);
    assert.equal(slotPolicies1.current_policy.effective_from_date, "2000-01-01");
    assert.deepEqual(
      slotPolicies1.current_policy.slots.map((s) => s.target_time),
      ["07:30", "10:00", "13:00", "15:00", "16:30"],
    );
    assert.deepEqual(
      slotPolicies1.current_policy.slots.map((s) => s.slot_label),
      ["Time 1", "Time 2", "Time 3", "Time 4", "Time 5"],
    );

    // 7b. BoD cannot create a slot policy version
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_create_slot_policy_admin(
            $1::uuid, $2::uuid, '2026-12-15'::date,
            '07:30', 15, 15, '11:30', 15, 15, '13:00', 15, 15, '17:00', 15, 15,
            1, $3::uuid, $4::text
          ) as data`,
          [ACTORS.BOD_PRIVILEGED.auth, ACTORS.BOD_PRIVILEGED.app, nextUuid(), "a".repeat(64)],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_WRITE_DENIED/.test(err.message),
    );

    // 7c. Past effective_from_date is rejected to protect historical reports
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_create_slot_policy_admin(
            $1::uuid, $2::uuid, '2000-06-01'::date,
            '07:30', 15, 15, '11:30', 15, 15, '13:00', 15, 15, '17:00', 15, 15,
            1, $3::uuid, $4::text
          ) as data`,
          [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, nextUuid(), "b".repeat(64)],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST/.test(err.message),
    );

    // 7d. Create date-effective winter schedule v2 starting 2026-12-15 (4 slots: 08:30, 12:00, 13:30, 17:30, ±15m)
    const createPolicyKey = nextUuid();
    const createPolicyInput = {
      effective_from_date: "2026-12-15",
      slot_1_time: "08:30",
      slot_1_grace_before_minutes: 15,
      slot_1_grace_after_minutes: 15,
      slot_2_time: "12:00",
      slot_2_grace_before_minutes: 15,
      slot_2_grace_after_minutes: 15,
      slot_3_time: "13:30",
      slot_3_grace_before_minutes: 15,
      slot_3_grace_after_minutes: 15,
      slot_4_time: "17:30",
      slot_4_grace_before_minutes: 15,
      slot_4_grace_after_minutes: 15,
      expected_version: 1,
      idempotency_key: createPolicyKey,
    };
    const createPolicyFp = computeSlotPolicyCreateRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      ...createPolicyInput,
    });
    const createdPolicyRaw = await callAsServiceRole(
      db,
      `select public.attendance_create_slot_policy_admin(
        $1::uuid, $2::uuid, '2026-12-15'::date,
        '08:30', 15, 15, '12:00', 15, 15, '13:30', 15, 15, '17:30', 15, 15,
        1, $3::uuid, $4::text
      ) as data`,
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, createPolicyKey, createPolicyFp],
    );
    const createdPolicy = projectCreateSlotPolicyResult(createdPolicyRaw);
    assert.ok(createdPolicy, "attendance_create_slot_policy_admin strict projection passes");
    assert.equal(createdPolicy.replayed, false);
    assert.equal(createdPolicy.policy.version, 2);
    assert.equal(createdPolicy.policy.effective_from_date, "2026-12-15");
    assert.equal(createdPolicy.policy.slots.length, 4);

    // 7d-bis. Create flexible 6-slot schedule v3 starting 2026-12-22 via 7-arg JSONB RPC
    const createPolicyV3Key = nextUuid();
    const v3Slots = [
      { slot_label: "Time 1", target_time: "07:00", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 2", target_time: "09:30", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 3", target_time: "11:30", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 4", target_time: "13:30", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 5", target_time: "15:30", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 6", target_time: "17:30", grace_before_minutes: 15, grace_after_minutes: 15 },
    ];
    const createPolicyV3Fp = computeSlotPolicyCreateRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      effective_from_date: "2026-12-22",
      slots: v3Slots,
      expected_version: 2,
    });
    const createdPolicyV3Raw = await callAsServiceRole(
      db,
      `select public.attendance_create_slot_policy_admin(
        $1::uuid, $2::uuid, '2026-12-22'::date, $3::jsonb, 2, $4::uuid, $5::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        JSON.stringify(v3Slots),
        createPolicyV3Key,
        createPolicyV3Fp,
      ],
    );
    const createdPolicyV3 = projectCreateSlotPolicyResult(createdPolicyV3Raw);
    assert.ok(createdPolicyV3, "6-slot policy v3 strict projection passes");
    assert.equal(createdPolicyV3.policy.version, 3);
    assert.equal(createdPolicyV3.policy.slots.length, 6);
    assert.deepEqual(
      createdPolicyV3.policy.slots.map((s) => s.target_time),
      ["07:00", "09:30", "11:30", "13:30", "15:30", "17:30"],
    );

    // 7e. Overlapping/earlier effective_from_date (<= 2026-12-22) and stale expected_version are rejected
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_create_slot_policy_admin(
            $1::uuid, $2::uuid, '2026-12-22'::date,
            '08:00', 15, 15, '11:00', 15, 15, '13:00', 15, 15, '17:00', 15, 15,
            3, $3::uuid, $4::text
          ) as data`,
          [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, nextUuid(), "c".repeat(64)],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_OVERLAP/.test(err.message),
    );
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_create_slot_policy_admin(
            $1::uuid, $2::uuid, '2026-12-28'::date,
            '08:00', 15, 15, '11:00', 15, 15, '13:00', 15, 15, '17:00', 15, 15,
            1, $3::uuid, $4::text
          ) as data`,
          [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, nextUuid(), "d".repeat(64)],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT/.test(err.message),
    );

    // 7f. Verify immutability trigger on public.attendance_slot_policy_versions
    await assert.rejects(
      () =>
        db.query(
          "update public.attendance_slot_policy_versions set slot_1_time = '09:00' where version = 1",
        ),
      (err) => /ATTENDANCE_CHECKINS_IMMUTABLE/.test(err.message),
    );

    // 7g. Record December 2026 check-ins for STAFF_B across v1 (5 slots), v2 (4 slots), and v3 (6 slots):
    // On 2026-12-10 (uses v1 5-slot: 07:30, 10:00, 13:00, 15:00, 16:30 ±15m):
    // - 07:15 VN (00:15 UTC): exact boundary (-15m from 07:30) -> SLOT_1, ON_TIME
    // - 07:45 VN (00:45 UTC): exact boundary (+15m from 07:30) -> SLOT_1, ON_TIME (2nd check-in in SLOT_1!)
    // - 08:45 VN (01:45 UTC): equidistant tie-break between 07:30 (450m) and 10:00 (600m) -> SLOT_1, LATE (+75m)
    // - 11:30 VN (04:30 UTC): equidistant tie-break between 10:00 (600m) and 13:00 (780m) -> SLOT_2, LATE (+90m)
    // - 14:00 VN (07:00 UTC): equidistant tie-break between 13:00 (780m) and 15:00 (900m) -> SLOT_3, LATE (+60m)
    for (const utcTime of [
      "2026-12-10T00:15:00.000Z",
      "2026-12-10T00:45:00.000Z",
      "2026-12-10T01:45:00.000Z",
      "2026-12-10T04:30:00.000Z",
      "2026-12-10T07:00:00.000Z",
    ]) {
      await recordCheckInAsServiceRole(db, {
        actor: ACTORS.STAFF_B,
        latitude: HQ_HANOI.latitude,
        longitude: HQ_HANOI.longitude,
        captured_at: utcTime,
      });
    }

    // On 2026-12-16 (uses v2 4-slot: 08:30, 12:00, 13:30, 17:30 ±15m):
    // - 08:30 VN (01:30 UTC): under v2, 08:30 is exact ON_TIME for SLOT_1
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_B,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-12-16T01:30:00.000Z",
    });

    // On 2026-12-24 (uses v3 6-slot: 07:00, 09:30, 11:30, 13:30, 15:30, 17:30 ±15m):
    // - 17:30 VN (10:30 UTC): assigned to SLOT_6 (17:30), ON_TIME
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_B,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-12-24T10:30:00.000Z",
    });

    const decMatrixRaw = await callAsServiceRole(
      db,
      `select public.attendance_monthly_matrix_report(
        $1::uuid, $2::uuid, '2026-12', null, $3::uuid, null, 1, 25
      ) as data`,
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, ACTORS.STAFF_B.app],
    );
    const decMatrix = projectAttendanceMonthlyMatrixReport(decMatrixRaw);
    assert.ok(decMatrix, "December matrix strict projection passes");
    assert.deepEqual(
      decMatrix.slot_policy.month_policies.map((p) => p.version),
      [1, 2, 3],
      "December 2026 report must report v1 (5 slots), v2 (4 slots), and v3 (6 slots) in month_policies",
    );
    assert.deepEqual(
      decMatrix.slot_policy.month_policies.map((p) => p.slots.length),
      [5, 4, 6],
    );

    const staffBDecRow = decMatrix.items[0];
    assert.ok(staffBDecRow);

    const dec10Cell = staffBDecRow.days.find((d) => d.business_date === "2026-12-10");
    assert.ok(dec10Cell);
    assert.equal(dec10Cell.policy_version_used, 1);
    assert.equal(dec10Cell.slots.length, 5);
    assert.equal(dec10Cell.slots[0].target_time, "07:30");
    assert.deepEqual(
      dec10Cell.slots[0].checkins.map((c) => c.time_local),
      ["07:15", "07:45", "08:45"],
    );
    assert.equal(dec10Cell.slots[0].checkins[0].deviation_status, "ON_TIME");
    assert.equal(dec10Cell.slots[0].checkins[1].deviation_status, "ON_TIME");
    assert.equal(dec10Cell.slots[0].checkins[2].deviation_status, "LATE");
    assert.deepEqual(
      dec10Cell.slots[1].checkins.map((c) => c.time_local),
      ["11:30"],
    );
    assert.deepEqual(
      dec10Cell.slots[2].checkins.map((c) => c.time_local),
      ["14:00"],
    );
    assert.equal(dec10Cell.slots[3].slot_status, "UPCOMING");
    assert.equal(dec10Cell.slots[4].slot_status, "UPCOMING");
    assert.equal(dec10Cell.day_status, "CHECKED_IN");
    assert.equal(dec10Cell.missing_slot_count, 0);

    const dec16Cell = staffBDecRow.days.find((d) => d.business_date === "2026-12-16");
    assert.ok(dec16Cell);
    assert.equal(dec16Cell.policy_version_used, 2);
    assert.equal(dec16Cell.slots.length, 4);
    assert.equal(dec16Cell.slots[0].target_time, "08:30");
    assert.equal(dec16Cell.slots[0].slot_status, "ON_TIME");
    assert.equal(dec16Cell.slots[0].checkins[0].time_local, "08:30");
    assert.equal(dec16Cell.slots[0].checkins[0].deviation_status, "ON_TIME");
    assert.equal(dec16Cell.slots[0].checkins[0].delta_minutes, 0);

    const dec24Cell = staffBDecRow.days.find((d) => d.business_date === "2026-12-24");
    assert.ok(dec24Cell);
    assert.equal(dec24Cell.policy_version_used, 3);
    assert.equal(dec24Cell.slots.length, 6);
    assert.equal(dec24Cell.slots[5].slot_code, "SLOT_6");
    assert.equal(dec24Cell.slots[5].target_time, "17:30");
    assert.equal(dec24Cell.slots[5].slot_status, "ON_TIME");
    assert.equal(dec24Cell.slots[5].checkins[0].time_local, "17:30");

    // -------------------------------------------------------------------------
    // 8. Wave 2: Attendance Explanations (Employee Submit, Leave-Aligned Approver Routing, Approve/Reject & Report Projection)
    // -------------------------------------------------------------------------
    // Configure TEAM_LEADER as active leader of TEAM_ALPHA so Leave & Attendance Explanation routing resolves TEAM_LEADER
    const teamLeaderRecruiterId = "39100000-0000-4000-8000-000000000004";
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
       values ($1::uuid, $2, 'NV_TL_01', 'TEAM_LEADER', true)
       on conflict do nothing`,
      [teamLeaderRecruiterId, ACTORS.TEAM_LEADER.name],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2026-01-01', true)
       on conflict do nothing`,
      [ACTORS.TEAM_LEADER.app, teamLeaderRecruiterId],
    );
    await db.query(
      `insert into public.direct_entry_team_leader_assignments
         (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-01'::date, true)
       on conflict do nothing`,
      [TEAM_ALPHA, ACTORS.TEAM_LEADER.app, teamLeaderRecruiterId],
    );

    // Seed past check-ins on 2026-10-10 (which is <= today in Asia/Ho_Chi_Minh):
    // - 00:30 UTC -> 07:30 local -> SLOT_1 (07:30) ON_TIME
    // - 04:30 UTC -> 11:30 local -> SLOT_2 (10:00) OUT_OF_GRACE (+90p)
    // - SLOT_4 (15:00) -> MISSING
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_B,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-10-10T00:30:00.000Z",
    });
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_B,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-10-10T04:30:00.000Z",
    });

    const { rows: checkinCountBeforeRows } = await db.query(
      `select count(*)::int as cnt
         from public.attendance_checkins
        where app_user_id = $1::uuid
          and business_date = '2026-10-10'::date`,
      [ACTORS.STAFF_B.app],
    );
    assert.equal(checkinCountBeforeRows[0].cnt, 2);

    // 8a. STAFF_B loads personal explanation overview for 2026-10-10
    const overviewRaw = await callAsServiceRole(
      db,
      "select public.attendance_get_my_explanations_overview($1::uuid, $2::uuid, '2026-10-10'::date) as data",
      [ACTORS.STAFF_B.auth, ACTORS.STAFF_B.app],
    );
    const overview = projectMyAttendanceExplanationsOverview(overviewRaw);
    assert.ok(overview, "attendance_get_my_explanations_overview strict projection passes");
    assert.equal(overview.viewer.can_submit_explanation, true);
    assert.equal(overview.routing.route_kind, "TEAM_LEADER");
    assert.equal(overview.routing.primary_approver?.app_user_id, ACTORS.TEAM_LEADER.app);

    // 8b. Submitting an explanation for a future date is rejected as ATTENDANCE_EXPLANATION_FUTURE_DATE_NOT_ALLOWED
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_submit_explanation(
            $1::uuid, $2::uuid, '2026-12-16'::date, 'SLOT_1', 'Ngày tương lai', $3::text, $4::text
          ) as data`,
          [ACTORS.STAFF_B.auth, ACTORS.STAFF_B.app, nextUuid(), "0".repeat(64)],
        ),
      (err) => /ATTENDANCE_EXPLANATION_FUTURE_DATE_NOT_ALLOWED/.test(err.message),
    );

    // On 2026-10-10, SLOT_1 is ON_TIME (07:30 vs 07:30) -> must be rejected as ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE!
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_submit_explanation(
            $1::uuid, $2::uuid, '2026-10-10'::date, 'SLOT_1', 'Khung giờ đã đúng giờ', $3::text, $4::text
          ) as data`,
          [ACTORS.STAFF_B.auth, ACTORS.STAFF_B.app, nextUuid(), "1".repeat(64)],
        ),
      (err) => /ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE/.test(err.message),
    );

    // Submit explanation for 2026-10-10 SLOT_2 (OUT_OF_GRACE, check-in at 11:30 vs 10:00)
    const expSlot2Key = nextUuid();
    const expSlot2Body = {
      app_user_id: ACTORS.STAFF_B.app,
      business_date: "2026-10-10",
      slot_code: "SLOT_2",
      reason: "Kẹt xe khi di chuyển giữa hai điểm phỏng vấn",
    };
    const expSlot2Fp = computeExplanationSubmitRequestFingerprint(expSlot2Body);
    const expSlot2Raw = await callAsServiceRole(
      db,
      `select public.attendance_submit_explanation(
        $1::uuid, $2::uuid, '2026-10-10'::date, 'SLOT_2', $3::text, $4::text, $5::text
      ) as data`,
      [
        ACTORS.STAFF_B.auth,
        ACTORS.STAFF_B.app,
        expSlot2Body.reason,
        expSlot2Key,
        expSlot2Fp,
      ],
    );
    const expSlot2 = projectSubmitAttendanceExplanationResult(expSlot2Raw);
    assert.ok(expSlot2, "submit explanation SLOT_2 projection passes");
    assert.equal(expSlot2.replayed, false);
    assert.equal(expSlot2.explanation.status, "PENDING");
    assert.equal(expSlot2.explanation.original_slot_status, "OUT_OF_GRACE");
    assert.equal(expSlot2.explanation.route_kind, "TEAM_LEADER");
    assert.equal(expSlot2.explanation.primary_approver?.app_user_id, ACTORS.TEAM_LEADER.app);
    assert.equal(expSlot2.explanation.related_checkins.length, 1);
    assert.equal(expSlot2.explanation.related_checkins[0].time_local, "11:30");

    // Submit explanation for 2026-10-10 SLOT_4 (MISSING, target 15:00)
    const expSlot4Key = nextUuid();
    const expSlot4Body = {
      app_user_id: ACTORS.STAFF_B.app,
      business_date: "2026-10-10",
      slot_code: "SLOT_4",
      reason: "Đi gặp ứng viên tại khu công nghiệp không có sóng",
    };
    const expSlot4Fp = computeExplanationSubmitRequestFingerprint(expSlot4Body);
    const expSlot4Raw = await callAsServiceRole(
      db,
      `select public.attendance_submit_explanation(
        $1::uuid, $2::uuid, '2026-10-10'::date, 'SLOT_4', $3::text, $4::text, $5::text
      ) as data`,
      [
        ACTORS.STAFF_B.auth,
        ACTORS.STAFF_B.app,
        expSlot4Body.reason,
        expSlot4Key,
        expSlot4Fp,
      ],
    );
    const expSlot4 = projectSubmitAttendanceExplanationResult(expSlot4Raw);
    assert.ok(expSlot4, "submit explanation SLOT_4 projection passes");
    assert.equal(expSlot4.explanation.original_slot_status, "MISSING");
    assert.equal(expSlot4.explanation.related_checkins.length, 0);

    // Future slots must not be submittable before their configured time window.
    const futureExplanationBody = {
      app_user_id: ACTORS.STAFF_B.app,
      business_date: "2099-12-31",
      slot_code: "SLOT_1",
      reason: "Không thể chấm công ở thời điểm tương lai",
    };
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_submit_explanation(
            $1::uuid, $2::uuid, '2099-12-31'::date, 'SLOT_1', $3::text, $4::text, $5::text
          ) as data`,
          [
            ACTORS.STAFF_B.auth,
            ACTORS.STAFF_B.app,
            futureExplanationBody.reason,
            nextUuid(),
            computeExplanationSubmitRequestFingerprint(futureExplanationBody),
          ],
        ),
      (err) => /ATTENDANCE_EXPLANATION_FUTURE_DATE_NOT_ALLOWED/.test(err.message),
    );

    // Duplicate explanation for same employee + date + slot with new idempotency key is rejected
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_submit_explanation(
            $1::uuid, $2::uuid, '2026-10-10'::date, 'SLOT_4', 'Gửi trùng lần 2', $3::text, $4::text
          ) as data`,
          [ACTORS.STAFF_B.auth, ACTORS.STAFF_B.app, nextUuid(), "2".repeat(64)],
        ),
      (err) => /ATTENDANCE_EXPLANATION_ALREADY_EXISTS/.test(err.message),
    );

    // Self-approval by STAFF_B is denied
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_decide_explanation(
            $1::uuid, $2::uuid, $3::uuid, 'APPROVE', 1, 'Tự duyệt', $4::text, $5::text
          ) as data`,
          [
            ACTORS.STAFF_B.auth,
            ACTORS.STAFF_B.app,
            expSlot4.explanation.explanation_id,
            nextUuid(),
            "3".repeat(64),
          ],
        ),
      (err) =>
        /ATTENDANCE_EXPLANATION_DECIDE_DENIED|ATTENDANCE_EXPLANATION_SELF_APPROVAL_FORBIDDEN/.test(
          err.message,
        ),
    );

    // 8c. TEAM_LEADER lists explanation approval inbox and sees both PENDING items
    const inboxRaw = await callAsServiceRole(
      db,
      "select public.attendance_list_explanation_approval_inbox($1::uuid, $2::uuid, 'PENDING', 20, 0) as data",
      [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app],
    );
    const inbox = projectAttendanceExplanationApprovalInbox(inboxRaw);
    assert.ok(inbox, "attendance_list_explanation_approval_inbox strict projection passes");
    assert.equal(inbox.pagination.total_rows, 2);
    assert.equal(inbox.pagination.pending_count, 2);

    // 8d. TEAM_LEADER approves SLOT_4 (MISSING -> EXPLAINED_APPROVED) and rejects SLOT_2 (OUT_OF_GRACE -> keeps OUT_OF_GRACE + REJECTED)
    const approveKey = nextUuid();
    const approveBody = {
      app_user_id: ACTORS.TEAM_LEADER.app,
      explanation_id: expSlot4.explanation.explanation_id,
      decision: "APPROVE",
      expected_row_version: 1,
      decision_note: "Xác nhận lịch đi tuyển dụng thực tế",
    };
    const approveFp = computeExplanationDecideRequestFingerprint(approveBody);
    const approvedRaw = await callAsServiceRole(
      db,
      `select public.attendance_decide_explanation(
        $1::uuid, $2::uuid, $3::uuid, 'APPROVE', 1, $4::text, $5::text, $6::text
      ) as data`,
      [
        ACTORS.TEAM_LEADER.auth,
        ACTORS.TEAM_LEADER.app,
        expSlot4.explanation.explanation_id,
        approveBody.decision_note,
        approveKey,
        approveFp,
      ],
    );
    const approvedRes = projectDecideAttendanceExplanationResult(approvedRaw);
    assert.ok(approvedRes);
    assert.equal(approvedRes.explanation.status, "APPROVED");
    assert.equal(approvedRes.explanation.effective_slot_status, "EXPLAINED_APPROVED");

    const rejectKey = nextUuid();
    const rejectBody = {
      app_user_id: ACTORS.TEAM_LEADER.app,
      explanation_id: expSlot2.explanation.explanation_id,
      decision: "REJECT",
      expected_row_version: 1,
      decision_note: "Không báo trước cho trưởng nhóm",
    };
    const rejectFp = computeExplanationDecideRequestFingerprint(rejectBody);
    const rejectedRaw = await callAsServiceRole(
      db,
      `select public.attendance_decide_explanation(
        $1::uuid, $2::uuid, $3::uuid, 'REJECT', 1, $4::text, $5::text, $6::text
      ) as data`,
      [
        ACTORS.TEAM_LEADER.auth,
        ACTORS.TEAM_LEADER.app,
        expSlot2.explanation.explanation_id,
        rejectBody.decision_note,
        rejectKey,
        rejectFp,
      ],
    );
    const rejectedRes = projectDecideAttendanceExplanationResult(rejectedRaw);
    assert.ok(rejectedRes);
    assert.equal(rejectedRes.explanation.status, "REJECTED");
    assert.equal(rejectedRes.explanation.effective_slot_status, "OUT_OF_GRACE");

    // 8e. Verify original attendance_checkins are completely untouched (no synthetic check-ins created)
    const { rows: checkinCountAfterRows } = await db.query(
      `select count(*)::int as cnt
         from public.attendance_checkins
        where app_user_id = $1::uuid
          and business_date = '2026-10-10'::date`,
      [ACTORS.STAFF_B.app],
    );
    assert.equal(
      checkinCountAfterRows[0].cnt,
      2,
      "Approving/rejecting explanations must never create or mutate attendance_checkins rows",
    );

    // 8f. Verify Monthly Report reflects EXPLAINED_APPROVED on SLOT_4 and REJECTED on SLOT_2
    const octMatrixAfterExp = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-10', null, $3::uuid, null, 1, 25
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, ACTORS.STAFF_B.app],
      ),
    );
    assert.ok(octMatrixAfterExp);
    const oct10After = octMatrixAfterExp.items[0].days.find(
      (d) => d.business_date === "2026-10-10",
    );
    assert.ok(oct10After);
    // SLOT_4 (index 3) is now EXPLAINED_APPROVED and no longer counted as MISSING!
    assert.equal(oct10After.slots[3].slot_code, "SLOT_4");
    assert.equal(oct10After.slots[3].slot_status, "EXPLAINED_APPROVED");
    assert.equal(oct10After.slots[3].explanation?.status, "APPROVED");
    assert.equal(oct10After.slots[3].checkins.length, 0);
    // SLOT_2 (index 1) retains OUT_OF_GRACE and carries explanation.status === "REJECTED"
    assert.equal(oct10After.slots[1].slot_code, "SLOT_2");
    assert.equal(oct10After.slots[1].slot_status, "OUT_OF_GRACE");
    assert.equal(oct10After.slots[1].explanation?.status, "REJECTED");
    // Only SLOT_3 and SLOT_5 (2 slots) remain MISSING -> missing_slot_count decreased from 3 to 2
    assert.equal(oct10After.missing_slot_count, 2);

    // 8g. Verify Employee Full Name Resolution across attendance_admin_report, attendance_monthly_matrix_report, and attendance_list_branches_admin
    const loginStaffMatchedAuth = "19100000-0000-4000-8000-000000000021";
    const loginStaffMatchedApp = "29100000-0000-4000-8000-000000000021";
    const loginStaffMatchedRecruiter = "39100000-0000-4000-8000-000000000021";
    const loginStaffUnmatchedAuth = "19100000-0000-4000-8000-000000000022";
    const loginStaffUnmatchedApp = "29100000-0000-4000-8000-000000000022";
    const singleWordNameStaffAuth = "19100000-0000-4000-8000-000000000023";
    const singleWordNameStaffApp = "29100000-0000-4000-8000-000000000023";

    await db.query(
      "insert into auth.users (id) values ($1::uuid), ($2::uuid), ($3::uuid)",
      [loginStaffMatchedAuth, loginStaffUnmatchedAuth, singleWordNameStaffAuth],
    );
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
       values
         ($1::uuid, $2::uuid, 'anhhn.td', true),
         ($3::uuid, $4::uuid, 'loginonly.td', true),
         ($5::uuid, $6::uuid, 'nam', true)`,
      [
        loginStaffMatchedApp,
        loginStaffMatchedAuth,
        loginStaffUnmatchedApp,
        loginStaffUnmatchedAuth,
        singleWordNameStaffApp,
        singleWordNameStaffAuth,
      ],
    );
    // Unambiguous active recruiter matching code 'anhhn.td' -> full name 'Nguyễn Thị Huệ' (even without verified link row)
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, active)
       values ($1::uuid, 'Nguyễn Thị Huệ', 'anhhn.td', true)`,
      [loginStaffMatchedRecruiter],
    );

    const branchesWithIdentity = projectAttendanceBranchesAdminList(
      await callAsServiceRole(
        db,
        "select public.attendance_list_branches_admin($1::uuid, $2::uuid) as data",
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
      ),
    );
    assert.ok(branchesWithIdentity);
    const matchedOpt = branchesWithIdentity.employee_options.find(
      (opt) => opt.app_user_id === loginStaffMatchedApp,
    );
    assert.ok(matchedOpt);
    assert.equal(matchedOpt.display_name, "Nguyễn Thị Huệ");
    assert.equal(matchedOpt.personnel_code, "anhhn.td");

    const unmatchedOpt = branchesWithIdentity.employee_options.find(
      (opt) => opt.app_user_id === loginStaffUnmatchedApp,
    );
    assert.ok(unmatchedOpt);
    assert.equal(unmatchedOpt.display_name, "Chưa cập nhật họ tên");
    assert.equal(unmatchedOpt.personnel_code, "loginonly.td");

    const singleWordOpt = branchesWithIdentity.employee_options.find(
      (opt) => opt.app_user_id === singleWordNameStaffApp,
    );
    assert.ok(singleWordOpt);
    assert.equal(singleWordOpt.display_name, "nam");
    assert.equal(singleWordOpt.personnel_code, null);

    const matrixMatched = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-10', null, $3::uuid, null, 1, 25
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, loginStaffMatchedApp],
      ),
    );
    assert.ok(matrixMatched);
    assert.equal(matrixMatched.items[0].employee_display_name, "Nguyễn Thị Huệ");
    assert.equal(matrixMatched.items[0].personnel_code, "anhhn.td");

    const matrixUnmatched = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-10', null, $3::uuid, null, 1, 25
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, loginStaffUnmatchedApp],
      ),
    );
    assert.ok(matrixUnmatched);
    assert.equal(matrixUnmatched.items[0].employee_display_name, "Chưa cập nhật họ tên");
    assert.equal(matrixUnmatched.items[0].personnel_code, "loginonly.td");

    const matrixSingleWord = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-10', null, $3::uuid, null, 1, 25
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, singleWordNameStaffApp],
      ),
    );
    assert.ok(matrixSingleWord);
    assert.equal(matrixSingleWord.items[0].employee_display_name, "nam");
    assert.equal(matrixSingleWord.items[0].personnel_code, null);

    await recordCheckInAsServiceRole(db, {
      actor: { auth: loginStaffMatchedAuth, app: loginStaffMatchedApp },
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-10-15T01:00:00.000Z",
    });
    await recordCheckInAsServiceRole(db, {
      actor: { auth: singleWordNameStaffAuth, app: singleWordNameStaffApp },
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-10-15T01:05:00.000Z",
    });
    const adminReportIdentity = projectAttendanceAdminReport(
      await callAsServiceRole(
        db,
        `select public.attendance_admin_report(
          $1::uuid, $2::uuid, '2026-10-15'::date, '2026-10-15'::date, 1, 25, null, null
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
      ),
    );
    assert.ok(adminReportIdentity);
    const matchedDetailRow = adminReportIdentity.items.find(
      (item) => item.employee_display_name === "Nguyễn Thị Huệ",
    );
    assert.ok(matchedDetailRow);
    assert.equal(matchedDetailRow.personnel_code, "anhhn.td");
    const singleWordDetailRow = adminReportIdentity.items.find(
      (item) => item.employee_display_name === "nam",
    );
    assert.ok(singleWordDetailRow);
    assert.equal(singleWordDetailRow.personnel_code, null);
    assert.ok(
      adminReportIdentity.employee_options.some(
        (opt) => opt.app_user_id === loginStaffMatchedApp && opt.display_name === "Nguyễn Thị Huệ",
      ),
    );
    assert.ok(
      adminReportIdentity.employee_options.some(
        (opt) => opt.app_user_id === singleWordNameStaffApp && opt.display_name === "nam",
      ),
    );

    for (const sig of ATTENDANCE_EXPLANATIONS_WAVE2_RPC_SIGNATURES) {
      const { rows } = await db.query("select to_regprocedure($1)::text as oid_name", [sig]);
      assert.ok(rows[0].oid_name, `RPC ${sig} must exist`);
    }
    assert.ok(ATTENDANCE_EXPLANATIONS_WAVE2_MIGRATION_NAME.endsWith(".sql"));
  } finally {
    await db.close();
  }
});
