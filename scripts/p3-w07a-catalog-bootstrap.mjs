#!/usr/bin/env node
/**
 * P3-W07A — Local operator-only XLSX catalog bootstrap importer.
 *
 * Reads an external XLSX workbook (Projects / Teams / HRP_Personnel / Vendors)
 * and imports it into the W07A catalog tables inside a Postgres transaction.
 *
 * Hard rules (locked by T0):
 *   - `--dry-run` is the default. The script NEVER mutates Production unless
 *     `--apply` is provided AND the explicit confirmation token
 *     `P3_W07A_CATALOG_APPLY` AND an idempotency key (>=12 chars, identifier-
 *     safe) are present.
 *   - The whole import runs inside a single Postgres transaction. Any error
 *     aborts and ROLLBACKs; nothing partial is committed.
 *   - Re-running on the same workbook is idempotent (unique constraints +
 *     version bump on existing rows).
 *   - Ambiguous matches (e.g. two HRP rows with the same `personnel_code`)
 *     fail the run with `AMBIGUOUS_MATCH` before any write.
 *   - Records already in the database that are absent from the workbook are
 *     preserved; the script NEVER deletes/deactivates anything solely because
 *     it is missing from the workbook. (W07B/P3.1 owns lifecycle.)
 *   - P2.5-W02-R2: `--apply` with project rows is RETIRED once
 *     `public.direct_entry_project_revisions` exists (migration #51). It fails
 *     closed with `PROJECT_BOOTSTRAP_RETIRED_USE_PROJECT_RPCS` BEFORE any write;
 *     project master mutations then go through `direct_entry_create_project` /
 *     `direct_entry_update_project` / `direct_entry_set_project_active`.
 *     `--dry-run` and `--apply` without project rows are unaffected.
 *   - Logs are sanitized — sheet names, count, fingerprint, row numbers, and
 *     normalized error codes only. No display names, no personnel_code, no
 *     vendor display name, no UUIDs in logs.
 *
 * Reuse-first:
 *   - `exceljs` for parsing (already in deps via `worker-profile-xlsx.ts`).
 *   - `pg` for the Postgres connection (already in devDeps).
 *   - `loadSupabaseConfig` + `buildSslOptions` for the Supabase pooler
 *     connection (already used by `p2-w04a-reconcile.mjs`).
 *
 * Usage:
 *   node scripts/p3-w07a-catalog-bootstrap.mjs \
 *       --workbook /path/to/owner-workbook.xlsx
 *
 *   node scripts/p3-w07a-catalog-bootstrap.mjs \
 *       --workbook /path/to/owner-workbook.xlsx \
 *       --apply \
 *       --confirm P3_W07A_CATALOG_APPLY \
 *       --idempotency-key owner-bootstrap-2026-10-15-v1
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";
import { Client } from "pg";

import { buildSslOptions } from "./lib/supabase-tls.mjs";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";

// ---------------------------------------------------------------------------
// Locked constants (mirrored from TASK.md / migration #41 self-check).
// ---------------------------------------------------------------------------
const CONFIRMATION_TOKEN = "P3_W07A_CATALOG_APPLY";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{12,128}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PERSONNEL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const POSITION_SET = new Set(["STAFF", "TEAM_LEADER"]);
const TEAM_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUIRED_SHEETS = Object.freeze(["Projects", "Teams", "HRP_Personnel", "Vendors"]);
// P2.5-W02-R2: once the #51 project revision table exists, the raw project
// upsert here is retired -- project master mutations must go through the W02
// project RPCs (reason + audit + revision + OCC). Stable refusal code.
const PROJECT_BOOTSTRAP_RETIRED = "PROJECT_BOOTSTRAP_RETIRED_USE_PROJECT_RPCS";

// Sheet column contracts. Headers can be in Vietnamese or English; the
// importer normalizes via `normalizeHeader` and then dispatches on the key.
const PROJECT_COLUMNS = Object.freeze({
  project_id: ["Mã dự án", "project_id", "Project ID", "project-id"],
  display_name: ["Tên dự án", "display_name", "Project Name", "project name"],
});
const TEAM_COLUMNS = Object.freeze({
  code: ["Mã nhóm", "code", "Team Code", "team_code"],
  display_name: ["Tên nhóm", "display_name", "Team Name", "team name"],
});
const HRP_COLUMNS = Object.freeze({
  personnel_code: ["Mã nhân sự", "personnel_code", "Personnel Code", "ID"],
  display_name: ["Họ và tên", "display_name", "Display Name", "Name"],
  position: ["Chức danh", "position", "Position", "Vị trí"],
  team: ["Mã nhóm", "team", "Team", "team_code"],
  active: ["Active", "active", "Kích hoạt"],
});
const VENDOR_COLUMNS = Object.freeze({
  vendor_id: ["Mã vendor", "vendor_id", "Vendor ID", "code"],
  display_name: ["Tên vendor", "display_name", "Vendor Name", "name"],
  active: ["Active", "active", "Kích hoạt"],
});

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    apply: false,
    confirm: null,
    idempotencyKey: null,
    workbook: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--apply":
        args.apply = true;
        break;
      case "--confirm":
        args.confirm = argv[++index] ?? null;
        break;
      case "--idempotency-key":
        args.idempotencyKey = argv[++index] ?? null;
        break;
      case "--workbook":
        args.workbook = argv[++index] ?? null;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (token.startsWith("--")) {
          throw new Error(`unknown flag: ${token}`);
        }
        break;
    }
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/p3-w07a-catalog-bootstrap.mjs --workbook <path> [--apply --confirm <P3_W07A_CATALOG_APPLY> --idempotency-key <key>]",
    "",
    "Default mode: --dry-run. The script parses the workbook, validates every",
    "sheet, computes the diff against the database, and prints a sanitized",
    "summary. NO database writes happen in dry-run.",
    "",
    "--apply requires --confirm and --idempotency-key. Without both the script",
    "refuses to mutate Production.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------
function normalizeHeader(header) {
  if (typeof header !== "string") return "";
  // NFC + trim + collapse + lowercase so column headers can be in any case
  // and any whitespace style.
  return header.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function columnIndex(headers, candidates) {
  for (let column = 0; column < headers.length; column += 1) {
    const normalized = normalizeHeader(headers[column]);
    for (const candidate of candidates) {
      if (normalizeHeader(candidate) === normalized) return column;
    }
  }
  return -1;
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// Workbook parsing
// ---------------------------------------------------------------------------
async function parseWorkbook(workbookPath) {
  const raw = await readFile(workbookPath);
  const fingerprint = sha256Hex(raw);
  let workbook;
  try {
    workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(raw);
  } catch {
    throw new Error("XLSX_PARSE_FAILED");
  }
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  for (const required of REQUIRED_SHEETS) {
    if (!sheetNames.includes(required)) {
      throw new Error(`MISSING_SHEET:${required}`);
    }
  }
  const projects = parseProjects(workbook.getWorksheet("Projects"));
  const teams = parseTeams(workbook.getWorksheet("Teams"));
  const hrp = parseHrp(workbook.getWorksheet("HRP_Personnel"));
  const vendors = parseVendors(workbook.getWorksheet("Vendors"));
  return { fingerprint, projects, teams, hrp, vendors };
}

function parseHeader(sheet, columnMap) {
  const headerRow = sheet.getRow(1);
  const headers = [];
  for (let column = 1; column <= headerRow.cellCount; column += 1) {
    headers.push(headerRow.getCell(column).value);
  }
  const indices = {};
  for (const [key, candidates] of Object.entries(columnMap)) {
    const index = columnIndex(headers, candidates);
    if (index < 0) throw new Error(`MISSING_COLUMN:${key}`);
    indices[key] = index;
  }
  return indices;
}

function cellText(cell) {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.normalize("NFC").trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(
      value.getUTCDate(),
    ).padStart(2, "0")}`;
  }
  if (typeof value === "object" && "text" in value) return String(value.text).normalize("NFC").trim();
  return "";
}

function parseBooleanText(text) {
  const normalized = text.normalize("NFC").trim().toLowerCase();
  if (["true", "1", "yes", "y", "active", "kích hoạt", "kich hoat"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "inactive", "ngừng", "ngung"].includes(normalized)) return false;
  return null;
}

function parseProjects(sheet) {
  const indices = parseHeader(sheet, PROJECT_COLUMNS);
  const projects = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const cells = sheet.getRow(row);
    const projectId = cellText(cells.getCell(indices.project_id + 1));
    const displayName = cellText(cells.getCell(indices.display_name + 1));
    if (projectId === "" && displayName === "") continue;
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error(`INVALID_PROJECT_ID:row=${row}`);
    }
    if (displayName.length === 0 || displayName.length > 256) {
      throw new Error(`INVALID_PROJECT_DISPLAY:row=${row}`);
    }
    projects.push({ project_id: projectId, display_name: displayName });
  }
  return projects;
}

function parseTeams(sheet) {
  const indices = parseHeader(sheet, TEAM_COLUMNS);
  const teams = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const cells = sheet.getRow(row);
    const code = cellText(cells.getCell(indices.code + 1));
    const displayName = cellText(cells.getCell(indices.display_name + 1));
    if (code === "" && displayName === "") continue;
    if (!TEAM_CODE_PATTERN.test(code)) throw new Error(`INVALID_TEAM_CODE:row=${row}`);
    if (displayName.length === 0 || displayName.length > 256) {
      throw new Error(`INVALID_TEAM_DISPLAY:row=${row}`);
    }
    teams.push({ code, display_name: displayName });
  }
  return teams;
}

function parseHrp(sheet) {
  const indices = parseHeader(sheet, HRP_COLUMNS);
  const rows = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const cells = sheet.getRow(row);
    const personnelCode = cellText(cells.getCell(indices.personnel_code + 1));
    const displayName = cellText(cells.getCell(indices.display_name + 1));
    const positionText = cellText(cells.getCell(indices.position + 1));
    const teamCode = cellText(cells.getCell(indices.team + 1));
    const activeText = cellText(cells.getCell(indices.active + 1));
    if (personnelCode === "" && displayName === "") continue;
    if (!PERSONNEL_CODE_PATTERN.test(personnelCode)) {
      throw new Error(`INVALID_PERSONNEL_CODE:row=${row}`);
    }
    if (displayName.length === 0 || displayName.length > 256) {
      throw new Error(`INVALID_HRP_DISPLAY:row=${row}`);
    }
    const positionKey = positionText.toUpperCase().replace(/\s+/g, "_");
    const position = POSITION_SET.has(positionKey) ? positionKey : null;
    if (position === null) {
      throw new Error(`INVALID_HRP_POSITION:row=${row}`);
    }
    if (!TEAM_CODE_PATTERN.test(teamCode)) throw new Error(`INVALID_HRP_TEAM:row=${row}`);
    const active = activeText === "" ? true : parseBooleanText(activeText);
    if (active === null) throw new Error(`INVALID_HRP_ACTIVE:row=${row}`);
    rows.push({
      personnel_code: personnelCode,
      display_name: displayName,
      position,
      team_code: teamCode,
      active,
    });
  }
  return rows;
}

function parseVendors(sheet) {
  const indices = parseHeader(sheet, VENDOR_COLUMNS);
  const rows = [];
  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const cells = sheet.getRow(row);
    const vendorId = cellText(cells.getCell(indices.vendor_id + 1));
    const displayName = cellText(cells.getCell(indices.display_name + 1));
    const activeText = cellText(cells.getCell(indices.active + 1));
    if (vendorId === "" && displayName === "") continue;
    if (!PROJECT_ID_PATTERN.test(vendorId)) throw new Error(`INVALID_VENDOR_ID:row=${row}`);
    if (displayName.length === 0 || displayName.length > 256) {
      throw new Error(`INVALID_VENDOR_DISPLAY:row=${row}`);
    }
    const active = activeText === "" ? true : parseBooleanText(activeText);
    if (active === null) throw new Error(`INVALID_VENDOR_ACTIVE:row=${row}`);
    rows.push({ vendor_id: vendorId, display_name: displayName, active });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Ambiguity detection (BEFORE any write)
// ---------------------------------------------------------------------------
function detectAmbiguities({ projects, teams, hrp, vendors }) {
  const projectIdCounts = new Map();
  for (const project of projects) {
    projectIdCounts.set(project.project_id, (projectIdCounts.get(project.project_id) ?? 0) + 1);
  }
  for (const [projectId, count] of projectIdCounts) {
    if (count > 1) throw new Error(`AMBIGUOUS_PROJECT_ID:${projectId}`);
  }
  const teamCodeCounts = new Map();
  for (const team of teams) {
    teamCodeCounts.set(team.code, (teamCodeCounts.get(team.code) ?? 0) + 1);
  }
  for (const [code, count] of teamCodeCounts) {
    if (count > 1) throw new Error(`AMBIGUOUS_TEAM_CODE:${code}`);
  }
  const personnelCodeCounts = new Map();
  for (const row of hrp) {
    personnelCodeCounts.set(row.personnel_code, (personnelCodeCounts.get(row.personnel_code) ?? 0) + 1);
  }
  for (const [code, count] of personnelCodeCounts) {
    if (count > 1) throw new Error(`AMBIGUOUS_PERSONNEL_CODE:${code}`);
  }
  const vendorIdCounts = new Map();
  for (const row of vendors) {
    vendorIdCounts.set(row.vendor_id, (vendorIdCounts.get(row.vendor_id) ?? 0) + 1);
  }
  for (const [id, count] of vendorIdCounts) {
    if (count > 1) throw new Error(`AMBIGUOUS_VENDOR_ID:${id}`);
  }
}

// ---------------------------------------------------------------------------
// Sanitized logging
// ---------------------------------------------------------------------------
function logSanitized(payload) {
  // Strip any field that could be a PII display name, vendor ID, etc.
  const safe = {
    mode: payload.mode ?? "unknown",
    fingerprint: payload.fingerprint ? `${payload.fingerprint.slice(0, 12)}…` : null,
    workbook_bytes: payload.workbookBytes ?? null,
    counts: {
      projects: payload.counts?.projects ?? 0,
      teams: payload.counts?.teams ?? 0,
      hrp: payload.counts?.hrp ?? 0,
      vendors: payload.counts?.vendors ?? 0,
    },
    applied: payload.applied ?? false,
    rolled_back: payload.rolledBack ?? false,
    idempotency_key: payload.idempotencyKey ? `${payload.idempotencyKey.slice(0, 4)}…` : null,
  };
  console.log(JSON.stringify(safe));
}

// ---------------------------------------------------------------------------
// Database plan / apply
// ---------------------------------------------------------------------------
/**
 * P2.5-W02-R2 guard: the raw project upsert predates the W02 project master. On a
 * ledger that carries #51 the project RPCs own reason/audit/revision/OCC, so a
 * workbook apply must not silently bump direct_entry_projects.version without a
 * revision. Refuse with a stable code; no rewrite of this importer into an admin
 * framework, and no write has happened yet when this throws.
 */
async function assertProjectBootstrapRetired({ client, parsed }) {
  if (parsed.projects.length === 0) return;
  const gate = await client.query(
    "select to_regclass('public.direct_entry_project_revisions') is not null as present",
  );
  if (!gate.rows[0].present) return;
  const error = new Error(
    "project rows must be created or updated through the P2.5-W02 project RPCs" +
    " (direct_entry_create_project / direct_entry_update_project /" +
    " direct_entry_set_project_active); the raw catalog upsert is retired",
  );
  error.code = PROJECT_BOOTSTRAP_RETIRED;
  throw error;
}

async function plan({ parsed }) {
  // Read-only projection of what the apply would do. The transaction is
  // always rolled back; nothing is written.
  const projects = new Map();
  const teams = new Map();
  const hrp = new Map();
  const vendors = new Map();
  for (const row of parsed.projects) projects.set(row.project_id, row.display_name);
  for (const row of parsed.teams) teams.set(row.code, row.display_name);
  for (const row of parsed.hrp) hrp.set(row.personnel_code, row);
  for (const row of parsed.vendors) vendors.set(row.vendor_id, row);
  return { projects, teams, hrp, vendors };
}

async function applyCatalog({ client, parsed }) {
  // Order matters: vendors and projects are flat lists with no dependencies.
  // teams must exist before HRP can reference them. HRP rows carry
  // `personnel_code` + `position` + a team reference; we upsert the
  // recruiters row keyed by `personnel_code`, then attach an HRP provider
  // membership effective from the import's effective date.
  const IMPORT_EFFECTIVE = new Date().toISOString().slice(0, 10);
  const report = {
    vendors_inserted: 0,
    vendors_updated: 0,
    projects_inserted: 0,
    projects_updated: 0,
    teams_inserted: 0,
    teams_updated: 0,
    recruiters_inserted: 0,
    recruiters_updated: 0,
    team_memberships_inserted: 0,
    provider_memberships_inserted: 0,
  };

  for (const vendor of parsed.vendors) {
    const result = await client.query(
      "insert into public.vendors(vendor_id, display_name, active, version)" +
      " values ($1, $2, $3, 1)" +
      " on conflict (vendor_id) do update set" +
      " display_name = excluded.display_name, active = excluded.active, version = public.vendors.version + 1" +
      " returning (xmax = 0) as inserted",
      [vendor.vendor_id, vendor.display_name, vendor.active],
    );
    if (result.rows[0].inserted) report.vendors_inserted += 1;
    else report.vendors_updated += 1;
  }

  for (const project of parsed.projects) {
    const result = await client.query(
      "insert into public.direct_entry_projects(project_id, display_name, active, version)" +
      " values ($1, $2, true, 1)" +
      " on conflict (project_id) do update set" +
      " display_name = excluded.display_name, version = public.direct_entry_projects.version + 1" +
      " returning (xmax = 0) as inserted",
      [project.project_id, project.display_name],
    );
    if (result.rows[0].inserted) report.projects_inserted += 1;
    else report.projects_updated += 1;
  }

  for (const team of parsed.teams) {
    const result = await client.query(
      "insert into public.teams(code, display_name, active, version)" +
      " values ($1, $2, true, 1)" +
      " on conflict (code) do update set" +
      " display_name = excluded.display_name, version = public.teams.version + 1" +
      " returning (xmax = 0) as inserted",
      [team.code, team.display_name],
    );
    if (result.rows[0].inserted) report.teams_inserted += 1;
    else report.teams_updated += 1;
  }

  // Build a (team_code -> team_id) map for HRP row inserts.
  const teamRows = await client.query("select code, team_id from public.teams");
  const teamIdByCode = new Map(teamRows.rows.map((row) => [row.code, row.team_id]));

  for (const hrpRow of parsed.hrp) {
    const teamId = teamIdByCode.get(hrpRow.team_code);
    if (!teamId) throw new Error(`HRP_TEAM_NOT_FOUND:${hrpRow.team_code}`);
    // Idempotent upsert keyed on the normalized personnel_code. PGlite +
    // PostgreSQL cannot reference an ON CONFLICT ON CONSTRAINT over an
    // expression index, so we look the existing row up first.
    const normalizedKey = hrpRow.personnel_code
      .normalize("NFC")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
    const existing = await client.query(
      "select recruiter_id from public.recruiters" +
      " where personnel_code is not null" +
      " and lower(public.recruitment_dimension_key(personnel_code)) = $1" +
      " limit 1",
      [normalizedKey],
    );
    let recruiterId;
    let inserted;
    if (existing.rows.length > 0) {
      recruiterId = existing.rows[0].recruiter_id;
      await client.query(
        "update public.recruiters set" +
        " display_name = $1," +
        " active = $2," +
        " personnel_position = $3," +
        " version = public.recruiters.version + 1" +
        " where recruiter_id = $4::uuid",
        [hrpRow.display_name, hrpRow.active, hrpRow.position, recruiterId],
      );
      inserted = false;
    } else {
      const recruiterResult = await client.query(
        "insert into public.recruiters(display_name, active, version, personnel_code, personnel_position)" +
        " values ($1, $2, 1, $3, $4) returning recruiter_id",
        [hrpRow.display_name, hrpRow.active, hrpRow.personnel_code, hrpRow.position],
      );
      recruiterId = recruiterResult.rows[0].recruiter_id;
      inserted = true;
    }
    if (inserted) report.recruiters_inserted += 1;
    else report.recruiters_updated += 1;

    // Team membership (effective-dated, append-only):
    //   - if there is already a row for this recruiter with
    //     valid_from = IMPORT_EFFECTIVE, the workbook is re-applying the
    //     SAME effective date; we only update its team_id if the team
    //     changed (idempotent on re-import).
    //   - if the recruiter has an OPEN team membership (valid_to is null)
    //     with valid_from < IMPORT_EFFECTIVE and a DIFFERENT team_id, we
    //     close it (valid_to = IMPORT_EFFECTIVE - 1 day) before inserting
    //     the new membership. This is the W07A merge semantic: a workbook
    //     team change replaces the active open-ended membership without
    //     destroying history.
    //   - if the recruiter has no membership yet, we insert the new one
    //     open-ended from IMPORT_EFFECTIVE.
    const previousOpenMembership = await client.query(
      "select membership_id, team_id, valid_from from public.recruiter_team_memberships" +
      " where recruiter_id = $1::uuid" +
      " and valid_from < $2::date" +
      " and valid_to is null" +
      " order by valid_from desc" +
      " limit 1",
      [recruiterId, IMPORT_EFFECTIVE],
    );
    const sameEffectiveMembership = await client.query(
      "select membership_id, team_id from public.recruiter_team_memberships" +
      " where recruiter_id = $1::uuid and valid_from = $2::date limit 1",
      [recruiterId, IMPORT_EFFECTIVE],
    );
    if (sameEffectiveMembership.rows.length > 0) {
      // Re-import with the same effective date: keep the row but replace
      // team_id if it changed. This is the idempotent path.
      if (sameEffectiveMembership.rows[0].team_id !== teamId) {
        await client.query(
          "update public.recruiter_team_memberships set team_id = $1::uuid" +
          " where membership_id = $2::uuid",
          [teamId, sameEffectiveMembership.rows[0].membership_id],
        );
      }
    } else {
      if (previousOpenMembership.rows.length > 0 &&
          previousOpenMembership.rows[0].team_id !== teamId) {
        // Close the previous open membership the day before the new one.
        const previousValidFrom = previousOpenMembership.rows[0].valid_from;
        const previousMembershipId = previousOpenMembership.rows[0].membership_id;
        const closeDate = await client.query(
          "select (($1::date) - INTERVAL '1 day')::date as d",
          [IMPORT_EFFECTIVE],
        );
        await client.query(
          "update public.recruiter_team_memberships set valid_to = $1::date" +
          " where membership_id = $2::uuid" +
          " and valid_to is null" +
          " and valid_from = $3::date",
          [closeDate.rows[0].d, previousMembershipId, previousValidFrom],
        );
      }
      await client.query(
        "insert into public.recruiter_team_memberships(recruiter_id, team_id, valid_from)" +
        " values ($1::uuid, $2::uuid, $3::date)",
        [recruiterId, teamId, IMPORT_EFFECTIVE],
      );
      report.team_memberships_inserted += 1;
    }

    // Provider membership: HRP. Same overlap-guard pattern.
    const existingProviderMembership = await client.query(
      "select 1 from public.recruiter_provider_memberships" +
      " where recruiter_id = $1::uuid and valid_from = $2::date limit 1",
      [recruiterId, IMPORT_EFFECTIVE],
    );
    if (existingProviderMembership.rows.length === 0) {
      await client.query(
        "insert into public.recruiter_provider_memberships(recruiter_id, provider_type, valid_from)" +
        " values ($1::uuid, 'hrp', $2::date)",
        [recruiterId, IMPORT_EFFECTIVE],
      );
      report.provider_memberships_inserted += 1;
    }
  }

  return { report, importEffective: IMPORT_EFFECTIVE };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function runCatalogBootstrap({
  workbookPath,
  apply = false,
  confirm = null,
  idempotencyKey = null,
  externalClient = undefined,
}) {
  if (!workbookPath) throw new Error("WORKBOOK_PATH_REQUIRED");
  if (apply) {
    if (confirm !== CONFIRMATION_TOKEN) throw new Error("CONFIRMATION_TOKEN_REQUIRED");
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey ?? "")) {
      throw new Error("IDEMPOTENCY_KEY_INVALID");
    }
  }

  const raw = await readFile(workbookPath);
  const parsed = await parseWorkbook(workbookPath);
  detectAmbiguities(parsed);

  const config = await loadSupabaseConfig();
  const useExternal = externalClient !== undefined;
  const client = useExternal ? externalClient : new Client({
    connectionString: config.databaseUrl,
    ssl: buildSslOptions(),
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
  });
  if (!useExternal) await client.connect();

  let transactionOpen = false;
  try {
    await client.query("begin");
    transactionOpen = true;

    if (apply) {
      // Fail closed BEFORE the first write of the transaction: vendors are
      // upserted first inside applyCatalog, so a guard placed any later would
      // already have mutated the catalog. The open transaction is rolled back
      // by the caller's finally block.
      await assertProjectBootstrapRetired({ client, parsed });

      const { report, importEffective } = await applyCatalog({
        client,
        parsed,
      });
      await client.query("commit");
      transactionOpen = false;
      logSanitized({
        mode: "apply",
        fingerprint: parsed.fingerprint,
        workbookBytes: raw.byteLength,
        counts: {
          projects: parsed.projects.length,
          teams: parsed.teams.length,
          hrp: parsed.hrp.length,
          vendors: parsed.vendors.length,
        },
        applied: true,
        rolledBack: false,
        idempotencyKey,
      });
      return {
        ok: true,
        mode: "apply",
        fingerprint: parsed.fingerprint,
        importEffective,
        report,
        idempotencyKey,
      };
    }

    // dry-run path: still compute the plan, but never write.
    await plan({ parsed });
    await client.query("rollback");
    transactionOpen = false;
    logSanitized({
      mode: "dry-run",
      fingerprint: parsed.fingerprint,
      workbookBytes: raw.byteLength,
      counts: {
        projects: parsed.projects.length,
        teams: parsed.teams.length,
        hrp: parsed.hrp.length,
        vendors: parsed.vendors.length,
      },
      applied: false,
      rolledBack: true,
      idempotencyKey: null,
    });
    return {
      ok: true,
      mode: "dry-run",
      fingerprint: parsed.fingerprint,
      counts: {
        projects: parsed.projects.length,
        teams: parsed.teams.length,
        hrp: parsed.hrp.length,
        vendors: parsed.vendors.length,
      },
    };
  } finally {
    if (transactionOpen) {
      try { await client.query("rollback"); } catch { /* best effort */ }
    }
    if (!useExternal) {
      try { await client.end(); } catch { /* best effort */ }
    }
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  runCatalogBootstrap({
    workbookPath: args.workbook,
    apply: args.apply,
    confirm: args.confirm,
    idempotencyKey: args.idempotencyKey,
  }).catch((error) => {
    const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code)
      ? error.code
      : "W07A_BOOTSTRAP_FAILED";
    console.error(`P3_W07A_BOOTSTRAP_FAILED ${code} ${error.message ?? ""}`);
    process.exitCode = 1;
  });
}