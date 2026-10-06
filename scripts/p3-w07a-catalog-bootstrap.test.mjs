/**
 * P3-W07A — operator importer test.
 *
 * Strategy:
 *   - Use PGlite + all 41 migrations applied to a fresh DB.
 *   - Build a synthetic XLSX workbook (in memory) using exceljs and write
 *     it to a temp file. NEVER touch the repository.
 *   - Invoke `runCatalogBootstrap({ workbookPath, ... })` against a
 *     monkey-patched `pg.Client` whose `connect`/`query`/`end` proxy to the
 *     PGlite instance. That way we exercise the SAME SQL contract the real
 *     Supabase pooler would see, but in-process.
 *   - Cover:
 *       1. dry-run returns a plan and does NOT mutate.
 *       2. apply with explicit confirm + key inserts ALL rows.
 *       3. apply without confirm refuses.
 *       4. apply without idempotency key refuses.
 *       5. second apply on the same workbook is idempotent (no new inserts).
 *       6. ambiguous duplicate in workbook fails BEFORE any write.
 *       7. records absent from the workbook are NOT deactivated.
 *   - All logs are sanitized: no display name leaks.
 */
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync } from "node:fs";

import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";
import { runCatalogBootstrap } from "./p3-w07a-catalog-bootstrap.mjs";

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

async function buildWorkbook(workbookPath, {
  projects = [],
  teams = [],
  hrp = [],
  vendors = [],
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "W07A test";
  const projectsSheet = workbook.addWorksheet("Projects");
  projectsSheet.columns = [
    { header: "Mã dự án", key: "project_id", width: 16 },
    { header: "Tên dự án", key: "display_name", width: 32 },
  ];
  for (const project of projects) projectsSheet.addRow(project);
  const teamsSheet = workbook.addWorksheet("Teams");
  teamsSheet.columns = [
    { header: "Mã nhóm", key: "code", width: 16 },
    { header: "Tên nhóm", key: "display_name", width: 32 },
  ];
  for (const team of teams) teamsSheet.addRow(team);
  const hrpSheet = workbook.addWorksheet("HRP_Personnel");
  hrpSheet.columns = [
    { header: "Mã nhân sự", key: "personnel_code", width: 16 },
    { header: "Họ và tên", key: "display_name", width: 32 },
    { header: "Chức danh", key: "position", width: 12 },
    { header: "Mã nhóm", key: "team", width: 16 },
    { header: "Active", key: "active", width: 8 },
  ];
  for (const row of hrp) hrpSheet.addRow(row);
  const vendorsSheet = workbook.addWorksheet("Vendors");
  vendorsSheet.columns = [
    { header: "Mã vendor", key: "vendor_id", width: 16 },
    { header: "Tên vendor", key: "display_name", width: 32 },
    { header: "Active", key: "active", width: 8 },
  ];
  for (const row of vendors) vendorsSheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  await writeFile(workbookPath, Buffer.from(buffer));
}

/**
 * A minimal `pg.Client` shim that proxies connect/query/end to a PGlite
 * instance. PGlite implements the same query interface as `pg` for our use
 * (`{ rows }`, `client.query(sql, params)`, `client.end()`).
 */
function pgClientFromPglite(pglite) {
  let closed = false;
  return {
    _pglite: pglite,
    async connect() { /* no-op; PGlite is in-memory */ },
    async end() {
      if (closed) return;
      closed = true;
      await pglite.close();
    },
    query(text, params) {
      return pglite.query(text, params);
    },
  };
}

test("T1 dry-run parses the workbook and never mutates the database", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "w07a-"));
  t.after(async () => { try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const workbookPath = path.join(dir, "owner.xlsx");
  await buildWorkbook(workbookPath, {
    projects: [
      { project_id: "proj-alpha", display_name: "Alpha Project" },
      { project_id: "proj-beta", display_name: "Beta Project" },
    ],
    teams: [
      { code: "team-alpha", display_name: "Alpha Team" },
    ],
    hrp: [
      { personnel_code: "vinht.td", display_name: "Test HRP", position: "STAFF", team: "team-alpha", active: true },
    ],
    vendors: [
      { vendor_id: "vendor-x", display_name: "Vendor X", active: true },
    ],
  });

  // Inject a PGlite-backed shim via `externalClient`. This skips the live
  // pg.Client + Supabase pooler code path while exercising the SAME SQL
  // contract.
  const pglite = await buildDatabase();
  const externalClient = pgClientFromPglite(pglite);

  const result = await runCatalogBootstrap({
    workbookPath,
    externalClient,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.counts.projects, 2);
  assert.equal(result.counts.teams, 1);
  assert.equal(result.counts.hrp, 1);
  assert.equal(result.counts.vendors, 1);

  // Database is unchanged.
  const projects = await pglite.query("select count(*)::int as n from public.direct_entry_projects");
  assert.equal(projects.rows[0].n, 0);
  const vendors = await pglite.query("select count(*)::int as n from public.vendors");
  assert.equal(vendors.rows[0].n, 0);
  const recruiters = await pglite.query("select count(*)::int as n from public.recruiters");
  assert.equal(recruiters.rows[0].n, 0);
});

test("T2 apply inserts every sheet once and reports counts", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "w07a-"));
  t.after(async () => { try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const workbookPath = path.join(dir, "owner.xlsx");
  await buildWorkbook(workbookPath, {
    projects: [{ project_id: "proj-1", display_name: "Project 1" }],
    teams: [{ code: "team-1", display_name: "Team 1" }],
    hrp: [{ personnel_code: "user-1", display_name: "User 1", position: "TEAM_LEADER", team: "team-1", active: true }],
    vendors: [{ vendor_id: "v-1", display_name: "Vendor 1", active: true }],
  });

  const pglite = await buildDatabase();
  const externalClient = pgClientFromPglite(pglite);

  const result = await runCatalogBootstrap({
    workbookPath,
    apply: true,
    confirm: "P3_W07A_CATALOG_APPLY",
    idempotencyKey: "owner-bootstrap-2026-10-15-v1",
    externalClient,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "apply");
  assert.equal(result.report.vendors_inserted, 1);
  assert.equal(result.report.projects_inserted, 1);
  assert.equal(result.report.teams_inserted, 1);
  assert.equal(result.report.recruiters_inserted, 1);
  assert.equal(result.report.team_memberships_inserted, 1);
  assert.equal(result.report.provider_memberships_inserted, 1);
});

test("T3 apply WITHOUT confirm token refuses", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "w07a-"));
  t.after(async () => { try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const workbookPath = path.join(dir, "owner.xlsx");
  await buildWorkbook(workbookPath, {
    projects: [{ project_id: "proj-1", display_name: "Project 1" }],
    teams: [],
    hrp: [],
    vendors: [],
  });

  await assert.rejects(
    () => runCatalogBootstrap({
      workbookPath,
      apply: true,
      confirm: "WRONG_TOKEN",
      idempotencyKey: "owner-bootstrap-2026-10-15-v1",
    }),
    /CONFIRMATION_TOKEN_REQUIRED/,
  );
});

test("T4 apply WITHOUT idempotency key refuses", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "w07a-"));
  t.after(async () => { try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const workbookPath = path.join(dir, "owner.xlsx");
  await buildWorkbook(workbookPath, {
    projects: [{ project_id: "proj-1", display_name: "Project 1" }],
    teams: [],
    hrp: [],
    vendors: [],
  });

  await assert.rejects(
    () => runCatalogBootstrap({
      workbookPath,
      apply: true,
      confirm: "P3_W07A_CATALOG_APPLY",
      idempotencyKey: "short",
    }),
    /IDEMPOTENCY_KEY_INVALID/,
  );
});

test("T5 second apply on the same workbook is idempotent", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "w07a-"));
  t.after(async () => { try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const workbookPath = path.join(dir, "owner.xlsx");
  await buildWorkbook(workbookPath, {
    projects: [{ project_id: "proj-1", display_name: "Project 1" }],
    teams: [{ code: "team-1", display_name: "Team 1" }],
    hrp: [{ personnel_code: "user-1", display_name: "User 1", position: "STAFF", team: "team-1", active: true }],
    vendors: [{ vendor_id: "v-1", display_name: "Vendor 1", active: true }],
  });

  const pglite = await buildDatabase();
  const externalClient = pgClientFromPglite(pglite);

  const first = await runCatalogBootstrap({
    workbookPath,
    apply: true,
    confirm: "P3_W07A_CATALOG_APPLY",
    idempotencyKey: "owner-bootstrap-2026-10-15-v1",
    externalClient,
  });
  assert.equal(first.report.recruiters_inserted, 1);

  // Second run on the same workbook: every insert should be 0.
  const second = await runCatalogBootstrap({
    workbookPath,
    apply: true,
    confirm: "P3_W07A_CATALOG_APPLY",
    idempotencyKey: "owner-bootstrap-2026-10-15-v1",
    externalClient,
  });
  assert.equal(second.report.vendors_inserted, 0);
  assert.equal(second.report.projects_inserted, 0);
  assert.equal(second.report.teams_inserted, 0);
  assert.equal(second.report.recruiters_inserted, 0);

  // Row counts in the DB are still 1 each.
  const recruiters = await pglite.query("select count(*)::int as n from public.recruiters");
  assert.equal(recruiters.rows[0].n, 1);
});

test("T6 ambiguous duplicate personnel_code fails BEFORE any write", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "w07a-"));
  t.after(async () => { try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const workbookPath = path.join(dir, "owner.xlsx");
  await buildWorkbook(workbookPath, {
    projects: [{ project_id: "proj-1", display_name: "Project 1" }],
    teams: [{ code: "team-1", display_name: "Team 1" }],
    hrp: [
      { personnel_code: "user-1", display_name: "User 1", position: "STAFF", team: "team-1", active: true },
      { personnel_code: "user-1", display_name: "User 1 dup", position: "STAFF", team: "team-1", active: true },
    ],
    vendors: [],
  });

  const pglite = await buildDatabase();
  const externalClient = pgClientFromPglite(pglite);

  await assert.rejects(
    () => runCatalogBootstrap({ workbookPath, externalClient }),
    /AMBIGUOUS_PERSONNEL_CODE/,
  );

  // Database unchanged.
  const recruiters = await pglite.query("select count(*)::int as n from public.recruiters");
  assert.equal(recruiters.rows[0].n, 0);
});

test("T7 records absent from workbook are preserved (no delete / no deactivate)", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "w07a-"));
  t.after(async () => { try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const workbookPath = path.join(dir, "owner.xlsx");
  await buildWorkbook(workbookPath, {
    projects: [{ project_id: "proj-1", display_name: "Project 1" }],
    teams: [{ code: "team-1", display_name: "Team 1" }],
    hrp: [{ personnel_code: "user-1", display_name: "User 1", position: "STAFF", team: "team-1", active: true }],
    vendors: [{ vendor_id: "v-1", display_name: "Vendor 1", active: true }],
  });

  const pglite = await buildDatabase();
  const externalClient = pgClientFromPglite(pglite);

  // Seed an unrelated project / vendor / recruiter that the workbook does
  // NOT carry. The import must not touch them.
  await pglite.query(
    "insert into public.direct_entry_projects(project_id, display_name) values ($1, $2)",
    ["legacy-project", "Legacy project (must survive)"],
  );
  await pglite.query(
    "insert into public.vendors(vendor_id, display_name) values ($1, $2)",
    ["legacy-vendor", "Legacy vendor (must survive)"],
  );

  await runCatalogBootstrap({
    workbookPath,
    apply: true,
    confirm: "P3_W07A_CATALOG_APPLY",
    idempotencyKey: "owner-bootstrap-2026-10-15-v1",
    externalClient,
  });

  const legacy = await pglite.query(
    "select count(*)::int as n from public.direct_entry_projects where project_id = 'legacy-project'",
  );
  assert.equal(legacy.rows[0].n, 1);
  const legacyVendor = await pglite.query(
    "select count(*)::int as n from public.vendors where vendor_id = 'legacy-vendor'",
  );
  assert.equal(legacyVendor.rows[0].n, 1);
});

test("T8 missing required sheet fails with sanitized error", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "w07a-"));
  t.after(async () => { try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const workbookPath = path.join(dir, "incomplete.xlsx");
  // Build a workbook missing the Vendors sheet.
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Projects").columns = [
    { header: "Mã dự án", key: "project_id" },
    { header: "Tên dự án", key: "display_name" },
  ];
  workbook.addWorksheet("Teams").columns = [
    { header: "Mã nhóm", key: "code" },
    { header: "Tên nhóm", key: "display_name" },
  ];
  workbook.addWorksheet("HRP_Personnel").columns = [
    { header: "Mã nhân sự", key: "personnel_code" },
    { header: "Họ và tên", key: "display_name" },
    { header: "Chức danh", key: "position" },
    { header: "Mã nhóm", key: "team" },
    { header: "Active", key: "active" },
  ];
  const buffer = await workbook.xlsx.writeBuffer();
  await writeFile(workbookPath, Buffer.from(buffer));

  await assert.rejects(
    () => runCatalogBootstrap({ workbookPath }),
    /MISSING_SHEET:Vendors/,
  );
});

test("T9 logs do not contain display names, vendor names, or personnel codes", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "w07a-"));
  t.after(async () => { try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const workbookPath = path.join(dir, "owner.xlsx");
  await buildWorkbook(workbookPath, {
    projects: [{ project_id: "proj-1", display_name: "SECRET-DISPLAY-PROJECT" }],
    teams: [{ code: "team-1", display_name: "Team 1" }],
    hrp: [{ personnel_code: "SECRET-PERSONNEL-CODE", display_name: "SECRET-DISPLAY-USER", position: "STAFF", team: "team-1", active: true }],
    vendors: [{ vendor_id: "v-1", display_name: "SECRET-VENDOR-NAME", active: true }],
  });

  const pglite = await buildDatabase();
  const externalClient = pgClientFromPglite(pglite);

  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(line);
  try {
    await runCatalogBootstrap({ workbookPath, externalClient });
  } finally {
    console.log = originalLog;
  }
  const joined = logs.join("\n");
  assert.equal(joined.includes("SECRET-DISPLAY-PROJECT"), false);
  assert.equal(joined.includes("SECRET-DISPLAY-USER"), false);
  assert.equal(joined.includes("SECRET-PERSONNEL-CODE"), false);
  assert.equal(joined.includes("SECRET-VENDOR-NAME"), false);
});

test("T10 workbook change updates name/team/position/active for an existing HRP row", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "w07a-"));
  t.after(async () => { try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const workbookPath = path.join(dir, "owner.xlsx");
  await buildWorkbook(workbookPath, {
    projects: [{ project_id: "proj-1", display_name: "Project 1" }],
    teams: [
      { code: "team-1", display_name: "Team 1" },
      { code: "team-2", display_name: "Team 2" },
    ],
    hrp: [{
      personnel_code: "user-1",
      display_name: "User 1 (initial)",
      position: "STAFF",
      team: "team-1",
      active: true,
    }],
    vendors: [{ vendor_id: "v-1", display_name: "Vendor 1", active: true }],
  });
  const pglite = await buildDatabase();
  const externalClient = pgClientFromPglite(pglite);

  await runCatalogBootstrap({
    workbookPath,
    apply: true,
    confirm: "P3_W07A_CATALOG_APPLY",
    idempotencyKey: "owner-bootstrap-merge-2026-10-15-v1",
    externalClient,
  });
  // Re-run with the SAME workbook, just to make sure idempotency still holds.
  await runCatalogBootstrap({
    workbookPath,
    apply: true,
    confirm: "P3_W07A_CATALOG_APPLY",
    idempotencyKey: "owner-bootstrap-merge-2026-10-15-v2",
    externalClient,
  });
  // Now rewrite the workbook with the SAME personnel_code but new name,
  // team, position and active=false.
  await buildWorkbook(workbookPath, {
    projects: [{ project_id: "proj-1", display_name: "Project 1" }],
    teams: [
      { code: "team-1", display_name: "Team 1" },
      { code: "team-2", display_name: "Team 2" },
    ],
    hrp: [{
      personnel_code: "user-1",
      display_name: "User 1 (renamed)",
      position: "TEAM_LEADER",
      team: "team-2",
      active: false,
    }],
    vendors: [{ vendor_id: "v-1", display_name: "Vendor 1 renamed", active: false }],
  });
  const second = await runCatalogBootstrap({
    workbookPath,
    apply: true,
    confirm: "P3_W07A_CATALOG_APPLY",
    idempotencyKey: "owner-bootstrap-merge-2026-10-15-v3",
    externalClient,
  });
  assert.equal(second.report.recruiters_inserted, 0,
    "personnel_code matches an existing recruiter; no new insert");
  assert.ok(second.report.recruiters_updated >= 1,
    "the renamed HRP row must be reported as updated");

  // Recruiter row is updated in place: same recruiter_id (UUID), new name,
  // new position, active flipped.
  const recruiter = await pglite.query(
    "select display_name, personnel_position, active, version" +
    " from public.recruiters where personnel_code = 'user-1'",
  );
  assert.equal(recruiter.rows.length, 1);
  assert.equal(recruiter.rows[0].display_name, "User 1 (renamed)");
  assert.equal(recruiter.rows[0].personnel_position, "TEAM_LEADER");
  assert.equal(recruiter.rows[0].active, false);

  // Vendor row updated in place.
  const vendor = await pglite.query(
    "select display_name, active, version from public.vendors where vendor_id = 'v-1'",
  );
  assert.equal(vendor.rows.length, 1);
  assert.equal(vendor.rows[0].display_name, "Vendor 1 renamed");
  assert.equal(vendor.rows[0].active, false);
});

test("T11 team change on the same effective date updates the membership in place", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "w07a-"));
  t.after(async () => { try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const workbookPath = path.join(dir, "owner.xlsx");
  await buildWorkbook(workbookPath, {
    projects: [{ project_id: "proj-1", display_name: "Project 1" }],
    teams: [
      { code: "team-1", display_name: "Team 1" },
      { code: "team-2", display_name: "Team 2" },
    ],
    hrp: [{
      personnel_code: "user-1", display_name: "User 1", position: "STAFF",
      team: "team-1", active: true,
    }],
    vendors: [],
  });
  const pglite = await buildDatabase();
  const externalClient = pgClientFromPglite(pglite);
  await runCatalogBootstrap({
    workbookPath,
    apply: true,
    confirm: "P3_W07A_CATALOG_APPLY",
    idempotencyKey: "owner-bootstrap-team-2026-10-15-v1",
    externalClient,
  });
  // Now switch the user to team-2 in a fresh workbook. The W07A importer
  // runs at IMPORT_EFFECTIVE = today, so the existing membership's
  // valid_from matches the new run's valid_from; the merge semantic is
  // "update in place, do not destroy history".
  await buildWorkbook(workbookPath, {
    projects: [{ project_id: "proj-1", display_name: "Project 1" }],
    teams: [
      { code: "team-1", display_name: "Team 1" },
      { code: "team-2", display_name: "Team 2" },
    ],
    hrp: [{
      personnel_code: "user-1", display_name: "User 1", position: "STAFF",
      team: "team-2", active: true,
    }],
    vendors: [],
  });
  const second = await runCatalogBootstrap({
    workbookPath,
    apply: true,
    confirm: "P3_W07A_CATALOG_APPLY",
    idempotencyKey: "owner-bootstrap-team-2026-10-15-v2",
    externalClient,
  });
  assert.equal(second.report.recruiters_inserted, 0,
    "no new recruiter row; the existing one is updated");
  // A new team_membership row was NOT inserted on the same effective date.
  assert.equal(second.report.team_memberships_inserted, 0,
    "same-effective-date re-import: the existing membership is updated in place");
  // Exactly one membership row remains, with the NEW team_id.
  const memberships = await pglite.query(
    "select team_id::text as team_id, valid_to from public.recruiter_team_memberships" +
    " order by valid_from asc",
  );
  assert.equal(memberships.rows.length, 1,
    "exactly one membership row (no history duplication on same-day re-import)");
  // The new team_id is team-2; valid_to is null (open-ended).
  const teamRow = await pglite.query("select code from public.teams where team_id = $1::uuid",
    [memberships.rows[0].team_id]);
  assert.equal(teamRow.rows[0].code, "team-2");
  assert.equal(memberships.rows[0].valid_to, null,
    "membership is still open-ended after in-place update");
});

test("T11b team change on a LATER effective date closes the previous open membership and opens a new one", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "w07a-"));
  t.after(async () => { try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const workbookPath = path.join(dir, "owner.xlsx");
  await buildWorkbook(workbookPath, {
    projects: [{ project_id: "proj-1", display_name: "Project 1" }],
    teams: [
      { code: "team-1", display_name: "Team 1" },
      { code: "team-2", display_name: "Team 2" },
    ],
    hrp: [{
      personnel_code: "user-1", display_name: "User 1", position: "STAFF",
      team: "team-1", active: true,
    }],
    vendors: [],
  });
  const pglite = await buildDatabase();
  const externalClient = pgClientFromPglite(pglite);
  await runCatalogBootstrap({
    workbookPath,
    apply: true,
    confirm: "P3_W07A_CATALOG_APPLY",
    idempotencyKey: "owner-bootstrap-team-2026-10-15-v1",
    externalClient,
  });
  // The first import left an OPEN membership at IMPORT_EFFECTIVE. Now
  // back-date that membership to 30 days before IMPORT_EFFECTIVE and clear
  // valid_to, simulating a previous-day import. Then switch the user to
  // team-2 and re-run. The importer must close the old row and insert a
  // new one open-ended at IMPORT_EFFECTIVE.
  const todayIso = new Date().toISOString().slice(0, 10);
  const pastIso = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  await pglite.query(
    "update public.recruiter_team_memberships set valid_from = $1::date, valid_to = null" +
    " where valid_from = $2::date",
    [pastIso, todayIso],
  );
  // Switch the user to team-2 and re-run on a fresh workbook.
  await buildWorkbook(workbookPath, {
    projects: [{ project_id: "proj-1", display_name: "Project 1" }],
    teams: [
      { code: "team-1", display_name: "Team 1" },
      { code: "team-2", display_name: "Team 2" },
    ],
    hrp: [{
      personnel_code: "user-1", display_name: "User 1", position: "STAFF",
      team: "team-2", active: true,
    }],
    vendors: [],
  });
  const second = await runCatalogBootstrap({
    workbookPath,
    apply: true,
    confirm: "P3_W07A_CATALOG_APPLY",
    idempotencyKey: "owner-bootstrap-team-2026-10-15-v2",
    externalClient,
  });
  assert.equal(second.report.recruiters_inserted, 0);
  assert.ok(second.report.team_memberships_inserted >= 1,
    "a new open membership is inserted at IMPORT_EFFECTIVE");

  // History is preserved: two rows. Older one is closed; newer one is open.
  const memberships = await pglite.query(
    "select team_id::text as team_id, valid_from, valid_to from public.recruiter_team_memberships" +
    " order by valid_from asc",
  );
  assert.equal(memberships.rows.length, 2,
    "exactly 2 rows: the back-dated closed one and the new open one");
  const open = memberships.rows.filter((row) => row.valid_to === null);
  const closed = memberships.rows.filter((row) => row.valid_to !== null);
  assert.equal(open.length, 1, "exactly one open membership remains");
  assert.equal(closed.length, 1, "the previous membership is closed");
  // The new open membership's team_id is team-2.
  const newOpen = open[0];
  const newOpenTeam = await pglite.query(
    "select code from public.teams where team_id = $1::uuid",
    [newOpen.team_id],
  );
  assert.equal(newOpenTeam.rows[0].code, "team-2");
  // The closed membership closes the day before the new one opens.
  const closedRow = closed[0];
  const closedDate = new Date(closedRow.valid_to);
  const newOpenDate = new Date(newOpen.valid_from);
  assert.ok(newOpenDate.getTime() > closedDate.getTime(),
    "open membership must start strictly after the closed one ends");
});

test("T12 row removed from workbook is NOT deactivated nor deleted", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "w07a-"));
  t.after(async () => { try { await rm(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const workbookPath = path.join(dir, "owner.xlsx");
  await buildWorkbook(workbookPath, {
    projects: [{ project_id: "proj-1", display_name: "Project 1" }],
    teams: [{ code: "team-1", display_name: "Team 1" }],
    hrp: [{ personnel_code: "user-1", display_name: "User 1", position: "STAFF", team: "team-1", active: true }],
    vendors: [{ vendor_id: "v-1", display_name: "Vendor 1", active: true }],
  });
  const pglite = await buildDatabase();
  const externalClient = pgClientFromPglite(pglite);
  await runCatalogBootstrap({
    workbookPath,
    apply: true,
    confirm: "P3_W07A_CATALOG_APPLY",
    idempotencyKey: "owner-bootstrap-absent-2026-10-15-v1",
    externalClient,
  });
  // Re-import an EMPTY workbook (no projects/teams/HRP/vendors rows). The
  // existing rows must NOT be deactivated nor deleted.
  await buildWorkbook(workbookPath, {
    projects: [],
    teams: [],
    hrp: [],
    vendors: [],
  });
  await runCatalogBootstrap({
    workbookPath,
    apply: true,
    confirm: "P3_W07A_CATALOG_APPLY",
    idempotencyKey: "owner-bootstrap-absent-2026-10-15-v2",
    externalClient,
  });
  const recruiter = await pglite.query(
    "select count(*)::int as n from public.recruiters where personnel_code = 'user-1'",
  );
  assert.equal(recruiter.rows[0].n, 1, "recruiter preserved");
  const vendor = await pglite.query(
    "select count(*)::int as n, max(active::int)::int as active" +
    " from public.vendors where vendor_id = 'v-1'",
  );
  assert.equal(vendor.rows[0].n, 1, "vendor preserved");
  assert.equal(vendor.rows[0].active, 1, "vendor still active; absence is NOT a deactivation");
});