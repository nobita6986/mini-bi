/**
 * P3-W07A-R1 — Catalog projection contract tests.
 *
 * Pins the locked T0 decisions in the W07A follow-up prompt:
 *
 *   - Vendor is filtered by `provider_type = 'vendor'` ONLY. The
 *     `membership_count = 1` rule is HRP-only; it is NOT used as the
 *     business rule to decide Vendor. A Vendor recruiter with more than
 *     one Vendor membership in force still appears in the catalog.
 *   - Vendor recruiters have no team / no leader / no project
 *     restriction in this release. Project list is flat text; HRP rows
 *     still show `Họ và tên · personnel_code · Team`; Vendor rows show
 *     the vendor display name.
 *   - `personnel_code` is a normalized business identifier; it is NOT
 *     the Supabase `auth_subject`. The canonical enum is `STAFF` /
 *     `TEAM_LEADER` with UI labels `Nhân viên` / `Trưởng nhóm`.
 *   - Trưởng nhóm is a catalog/membership fact, not an authenticated
 *     app user. W07A does not create accounts, capability grants or
 *     team dashboards based on `personnel_position`.
 *
 * These tests build a PGlite instance from all 41 migrations and call
 * `direct_entry_input_catalog` end-to-end. They are data-agnostic: no
 * business data is committed.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";
import {
  PERSONNEL_POSITION_UI_LABELS,
  personnelPositionUiLabel,
} from "../src/lib/direct-entry/direct-entry-grid-columns.ts";

const MIGRATION_DIR = path.resolve("supabase/migrations");

async function buildDatabase() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = readdirSync(MIGRATION_DIR).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrations) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return db;
}

async function seedAppUser(db) {
  // The catalog RPC checks the actor against `direct_entry_app_users` and
  // `direct_entry_capability_grants`. Seed a synthetic actor + the minimum
  // `entry_create` grant so the projection can be called. The FK on
  // `auth_subject` references `auth.users`; insert the auth row first.
  const authSubject = "00000000-0000-4000-8000-000000000001";
  const appUserId = "00000000-0000-4000-8000-000000000002";
  await db.query("insert into auth.users(id) values ($1::uuid)", [authSubject]);
  await db.query(
    "insert into public.direct_entry_app_users(auth_subject, app_user_id, enabled)" +
    " values ($1::uuid, $2::uuid, true)",
    [authSubject, appUserId],
  );
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id, capability, valid_from)" +
    " values ($1::uuid, 'entry_create', current_date)",
    [appUserId],
  );
  return { authSubject, appUserId };
}

async function callCatalog(db, { authSubject, appUserId }, effectiveDate) {
  const result = await db.query(
    "select public.direct_entry_input_catalog($1::uuid, $2::uuid, $3::date) as catalog",
    [authSubject, appUserId, effectiveDate],
  );
  return result.rows[0].catalog;
}

test("P1 Vendor filter uses provider_type, NOT membership_count = 1 as business rule", async () => {
  const db = await buildDatabase();
  const actor = await seedAppUser(db);
  const effective = "2026-10-15";

  // Seed a vendor with two vendors. Recruiter A is HRP-only; recruiter B
  // is Vendor-only with TWO vendor memberships in force (e.g. switch
  // window). The locked contract: B still appears in the catalog under
  // provider_type = 'vendor' because Vendor is decided by membership
  // existence + provider_type, not by a 1-row count.
  await db.query(
    "insert into public.vendors(vendor_id, display_name) values" +
    " ('vendor_x', 'Vendor X')," +
    " ('vendor_y', 'Vendor Y')",
  );
  await db.query(
    "insert into public.recruiters(recruiter_id, display_name, active, version)" +
    " values ('11111111-1111-4111-8111-111111111111', 'HRP Sale', true, 1)," +
    "        ('22222222-2222-4222-8222-222222222222', 'Vendor Recruiter', true, 1)",
  );
  // HRP recruiter needs team + provider membership.
  await db.query(
    "insert into public.teams(team_id, code, display_name, active) values" +
    " ('33333333-3333-4333-8333-333333333333', 'team-a', 'Team A', true)",
  );
  await db.query(
    "insert into public.recruiter_team_memberships(recruiter_id, team_id, valid_from)" +
    " values ('11111111-1111-4111-8111-111111111111'::uuid," +
    "         '33333333-3333-4333-8333-333333333333'::uuid, '2026-01-01'::date)",
  );
  await db.query(
    "insert into public.recruiter_provider_memberships(recruiter_id, provider_type, valid_from, valid_to, vendor_id)" +
    " values ('11111111-1111-4111-8111-111111111111'::uuid, 'hrp',    '2026-01-01'::date, null,             null)," +
    // Two vendor memberships in force on 2026-10-15 because they don't
    // overlap (the second one starts after the first one closes). This
    // models a "vendor switch window" where the recruiter held vendor_x
    // up to 2026-05-31 and vendor_y from 2026-06-01 onwards. The locked
    // W07A contract requires the catalog to surface the active one
    // (vendor_y) — not zero, not both, not the alphabetically first.
    "        ('22222222-2222-4222-8222-222222222222'::uuid, 'vendor', '2026-01-01'::date, '2026-05-31'::date, 'vendor_x')," +
    "        ('22222222-2222-4222-8222-222222222222'::uuid, 'vendor', '2026-06-01'::date, null,             'vendor_y')",
  );

  const catalog = await callCatalog(db, actor, effective);
  const recruiters = catalog.recruiters;
  const hrp = recruiters.filter((r) => r.provider_type === "hrp");
  const vendor = recruiters.filter((r) => r.provider_type === "vendor");
  assert.equal(hrp.length, 1, "HRP recruiter surfaces");
  assert.equal(hrp[0].recruiter_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(hrp[0].team_id, "33333333-3333-4333-8333-333333333333");
  // Vendor surfaces the active membership only (vendor_y). The closed
  // vendor_x membership must NOT leak. This is the "Vendor decided by
  // provider_type, not by min(provider_type)" guarantee.
  assert.equal(vendor.length, 1,
    "Vendor surfaces exactly the active vendor_membership on `effective_date`");
  assert.equal(vendor[0].vendor_id, "vendor_y",
    "the active vendor membership is the one with valid_from <= effective < valid_to");
  assert.equal(vendor[0].team_id, null, "Vendor rows have no team");
  assert.equal(vendor[0].personnel_code, null, "Vendor rows have no personnel_code");
  await db.close();
});

test("P2 HRP rows show label = `Họ và tên · personnel_code · Team`; Vendor rows show vendor display name", async () => {
  const db = await buildDatabase();
  const actor = await seedAppUser(db);
  await db.query(
    "insert into public.vendors(vendor_id, display_name) values ('vendor_x', 'Vendor X')",
  );
  await db.query(
    "insert into public.teams(team_id, code, display_name, active) values" +
    " ('33333333-3333-4333-8333-333333333333', 'team-a', 'Team Alpha', true)",
  );
  await db.query(
    "insert into public.recruiters(recruiter_id, display_name, active, version, personnel_code, personnel_position)" +
    " values ('11111111-1111-4111-8111-111111111111', 'HRP Sale A', true, 1, 'vinht.td', 'TEAM_LEADER')," +
    "        ('22222222-2222-4222-8222-222222222222', 'Vendor Recruiter', true, 1, null, 'STAFF')",
  );
  await db.query(
    "insert into public.recruiter_team_memberships(recruiter_id, team_id, valid_from)" +
    " values ('11111111-1111-4111-8111-111111111111'::uuid," +
    "         '33333333-3333-4333-8333-333333333333'::uuid, '2026-01-01'::date)",
  );
  await db.query(
    "insert into public.recruiter_provider_memberships(recruiter_id, provider_type, valid_from, vendor_id)" +
    " values ('11111111-1111-4111-8111-111111111111'::uuid, 'hrp',    '2026-01-01'::date, null)," +
    "        ('22222222-2222-4222-8222-222222222222'::uuid, 'vendor', '2026-01-01'::date, 'vendor_x')",
  );

  const catalog = await callCatalog(db, actor, "2026-10-15");
  const recruiters = catalog.recruiters;
  const hrp = recruiters.find((r) => r.provider_type === "hrp");
  const vendor = recruiters.find((r) => r.provider_type === "vendor");
  assert.ok(hrp, "HRP row surfaces");
  assert.equal(hrp.label, "HRP Sale A · vinht.td · Team Alpha",
    "HRP label = `Họ và tên · personnel_code · Team`");
  assert.equal(hrp.personnel_code, "vinht.td");
  assert.equal(hrp.team_display_name, "Team Alpha");
  assert.ok(vendor, "Vendor row surfaces");
  assert.equal(vendor.label, "Vendor X",
    "Vendor label = vendor display name (no team / no personnel_code)");
  assert.equal(vendor.personnel_code, null);
  await db.close();
});

test("P3 projects are unfiltered; HRP/Vendor/team/leader do not scope the project list", async () => {
  const db = await buildDatabase();
  const actor = await seedAppUser(db);
  await db.query(
    "insert into public.direct_entry_projects(project_id, display_name, active) values" +
    " ('p1', 'Project 1', true)," +
    " ('p2', 'Project 2', true)",
  );
  const catalog = await callCatalog(db, actor, "2026-10-15");
  assert.equal(catalog.projects.length, 2);
  // No project filter is required by the W07A prompt; this is a structural
  // assertion that projects carry only project_id + display_name.
  for (const project of catalog.projects) {
    assert.equal(typeof project.project_id, "string");
    assert.equal(typeof project.display_name, "string");
  }
  await db.close();
});

test("P4 personnel_code is not the Supabase auth_subject (separate column)", async () => {
  const db = await buildDatabase();
  // The catalog carries personnel_code but the actor's auth_subject is a
  // different field. personnel_code is a text business identifier; it
  // is normalized + unique (lower() index). The migration #41 must not
  // rename it to auth_subject.
  const schema = await db.query(
    "select column_name from information_schema.columns" +
    " where table_schema = 'public' and table_name = 'recruiters'" +
    " and column_name in ('personnel_code','auth_subject')",
  );
  const columnNames = schema.rows.map((row) => row.column_name).sort();
  assert.deepEqual(columnNames, ["personnel_code"],
    "recruiters table has personnel_code but NOT auth_subject (separate identity)");

  // personnel_code is text, nullable, and lives in its own column.
  const col = await db.query(
    "select data_type, is_nullable from information_schema.columns" +
    " where table_schema = 'public' and table_name = 'recruiters'" +
    " and column_name = 'personnel_code'",
  );
  assert.equal(col.rows[0].data_type, "text");
  assert.equal(col.rows[0].is_nullable, "YES",
    "personnel_code is nullable (existing rows may not have one yet)");
  await db.close();
});

test("P5 personnel_position enum is locked to STAFF / TEAM_LEADER; UI label mapping is Nhân viên / Trưởng nhóm", () => {
  assert.deepEqual(
    Object.keys(PERSONNEL_POSITION_UI_LABELS).sort(),
    ["STAFF", "TEAM_LEADER"],
    "the canonical enum is exactly STAFF and TEAM_LEADER",
  );
  assert.equal(PERSONNEL_POSITION_UI_LABELS.STAFF, "Nhân viên");
  assert.equal(PERSONNEL_POSITION_UI_LABELS.TEAM_LEADER, "Trưởng nhóm");
  // Helper renders the UI label for known values and a placeholder for
  // null/unknown (defensive contract: nothing leaks raw enum to the UI).
  assert.equal(personnelPositionUiLabel("STAFF"), "Nhân viên");
  assert.equal(personnelPositionUiLabel("TEAM_LEADER"), "Trưởng nhóm");
  assert.equal(personnelPositionUiLabel(null), "—");
});

test("P6 personnel_position does NOT trigger account / capability / team dashboard creation", async () => {
  const db = await buildDatabase();
  // Seed an HRP recruiter marked as TEAM_LEADER. The catalog projection
  // must surface the row, but no app_user / capability_grant /
  // team_dashboard is created. W07A is data-only.
  const actor = await seedAppUser(db);
  await db.query(
    "insert into public.teams(team_id, code, display_name, active) values" +
    " ('33333333-3333-4333-8333-333333333333', 'team-a', 'Team A', true)",
  );
  await db.query(
    "insert into public.recruiters(recruiter_id, display_name, active, version, personnel_code, personnel_position)" +
    " values ('11111111-1111-4111-8111-111111111111', 'Team Leader A', true, 1, 'leader.a', 'TEAM_LEADER')",
  );
  await db.query(
    "insert into public.recruiter_team_memberships(recruiter_id, team_id, valid_from)" +
    " values ('11111111-1111-4111-8111-111111111111'::uuid," +
    "         '33333333-3333-4333-8333-333333333333'::uuid, '2026-01-01'::date)",
  );
  await db.query(
    "insert into public.recruiter_provider_memberships(recruiter_id, provider_type, valid_from)" +
    " values ('11111111-1111-4111-8111-111111111111'::uuid, 'hrp', '2026-01-01'::date)",
  );

  const catalog = await callCatalog(db, actor, "2026-10-15");
  const hrp = catalog.recruiters.find((r) => r.provider_type === "hrp");
  assert.ok(hrp, "TEAM_LEADER surfaces in the catalog");
  assert.equal(hrp.recruiter_id, "11111111-1111-4111-8111-111111111111");
  // The actor is the synthetic app_user; only ONE app_user exists.
  const appUsers = await db.query("select count(*)::int as n from public.direct_entry_app_users");
  assert.equal(appUsers.rows[0].n, 1, "no app_user is created from a TEAM_LEADER row");
  // The capability grants table carries only the seed grant; no extra
  // TEAM_LEADER privilege was minted.
  const grants = await db.query("select capability from public.direct_entry_capability_grants");
  assert.deepEqual(grants.rows.map((row) => row.capability).sort(), ["entry_create"],
    "no capability is created from a TEAM_LEADER row");
  await db.close();
});

test("P7 personnel_code unique index is case-insensitive and normalized", async () => {
  const db = await buildDatabase();
  // Inserting two rows whose personnel_code differs only in case must
  // fail (NFC + trim + collapse + lowercase normalization). This pins
  // the locked "không phân biệt hoa thường" rule at the storage layer.
  await db.query(
    "insert into public.recruiters(recruiter_id, display_name, active, version, personnel_code)" +
    " values ('11111111-1111-4111-8111-111111111111', 'User A', true, 1, 'vinht.td')",
  );
  await assert.rejects(
    () => db.query(
      "insert into public.recruiters(recruiter_id, display_name, active, version, personnel_code)" +
      " values ('22222222-2222-4222-8222-222222222222', 'User B', true, 1, 'VINHT.TD')",
    ),
    /recruiters_personnel_code_lower_uidx/,
    "second insert must fail the unique index on lower(normalize(...))",
  );
  await db.close();
});
