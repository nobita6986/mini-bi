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