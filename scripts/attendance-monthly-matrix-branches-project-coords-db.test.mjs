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
} from "../src/lib/attendance/attendance-monthly-matrix-api.ts";
import {
  projectAssignBranchResult,
  projectAttendanceBranchesAdminList,
  projectAttendanceMonthlyMatrixReport,
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
    assert.equal(staffARow.summary.no_checkin_day_count, 28); // 30 - 2 check-in days
    assert.equal(
      staffARow.summary.no_checkin_without_leave_day_count,
      27,
      "30 days - 2 check-in days - 1 leave-only day (Nov 6) = 27 NO_CHECKIN days",
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
    assert.equal(nov07Cell.day_status, "NO_CHECKIN", "unapproved leave must remain NO_CHECKIN");
    assert.equal(nov07Cell.has_approved_leave, false);

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
  } finally {
    await db.close();
  }
});
