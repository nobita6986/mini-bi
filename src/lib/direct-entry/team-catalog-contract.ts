/**
 * P3.1-W01C-A - Strict projections cho team master catalog admin RPC (#69).
 *
 * Payload dung chinh xac theo migration #69
 * (20261009050000_p3_1_w01c_a_team_catalog.sql):
 * - list/get tra 6 key: team_id, code, display_name, active, version, revision_count;
 * - update/set-active tra 6 key (khong co revision_count);
 * - create tra them created: true (7 key).
 *
 * Server la authority: moi projection FAIL-CLOSED. Thieu/thua key, sai kieu hoac
 * gia tri khong hop le => null. KHONG bao gio chua capability/scope grant,
 * app_user, auth_subject, email hay raw reason.
 */

export type AdminTeam = {
  team_id: string;
  code: string;
  display_name: string;
  active: boolean;
  version: number;
  revision_count: number;
};

export type AdminTeamList = {
  authorization_date: string;
  include_inactive: boolean;
  search: string | null;
  page: number;
  page_size: number;
  total: number;
  teams: readonly AdminTeam[];
};

/** update + set_active (6 key). */
export type AdminTeamMutation = {
  team_id: string;
  code: string;
  display_name: string;
  active: boolean;
  version: number;
  revision_id: string;
};

/** create tra them created: true (7 key). */
export type AdminTeamCreateResult = AdminTeamMutation & { created: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
function nullableStr(value: unknown): string | null | undefined {
  return value === null ? null : (str(value) ?? undefined);
}
function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

const ITEM_KEYS = ["team_id", "code", "display_name", "active", "version",
  "revision_count"] as const;
const LIST_KEYS = ["authorization_date", "include_inactive", "search", "page", "page_size",
  "total", "teams"] as const;
const MUTATION_KEYS = ["team_id", "code", "display_name", "active", "version",
  "revision_id"] as const;
const CREATE_KEYS = [...MUTATION_KEYS, "created"] as const;

/** Team row 6 key (list item + get). */
export function teamCatalogItem(value: unknown): AdminTeam | null {
  if (!isRecord(value) || !exactKeys(value, ITEM_KEYS)) return null;
  const team_id = str(value.team_id);
  const code = str(value.code);
  const display_name = str(value.display_name);
  const active = bool(value.active);
  const version = int(value.version);
  const revision_count = int(value.revision_count);
  if (team_id === null || code === null || display_name === null || active === null ||
      version === null || revision_count === null) {
    return null;
  }
  return { team_id, code, display_name, active, version, revision_count };
}

export function teamCatalogList(value: unknown): AdminTeamList | null {
  if (!isRecord(value) || !exactKeys(value, LIST_KEYS)) return null;
  const authorization_date = str(value.authorization_date);
  const include_inactive = bool(value.include_inactive);
  const search = nullableStr(value.search);
  const page = int(value.page);
  const page_size = int(value.page_size);
  const total = int(value.total);
  if (authorization_date === null || include_inactive === null || search === undefined ||
      page === null || page_size === null || total === null || !Array.isArray(value.teams)) {
    return null;
  }
  const teams: AdminTeam[] = [];
  for (const item of value.teams) {
    const row = teamCatalogItem(item);
    if (!row) return null;
    teams.push(row);
  }
  return { authorization_date, include_inactive, search, page, page_size, total, teams };
}

function mutationFields(value: Record<string, unknown>): AdminTeamMutation | null {
  const team_id = str(value.team_id);
  const code = str(value.code);
  const display_name = str(value.display_name);
  const active = bool(value.active);
  const version = int(value.version);
  const revision_id = str(value.revision_id);
  if (team_id === null || code === null || display_name === null || active === null ||
      version === null || revision_id === null) {
    return null;
  }
  return { team_id, code, display_name, active, version, revision_id };
}

/** update/set_active (6 key). */
export function teamCatalogMutation(value: unknown): AdminTeamMutation | null {
  if (!isRecord(value) || !exactKeys(value, MUTATION_KEYS)) return null;
  return mutationFields(value);
}

/** create (7 key, created phai dung bang true). */
export function teamCatalogCreateResult(value: unknown): AdminTeamCreateResult | null {
  if (!isRecord(value) || !exactKeys(value, CREATE_KEYS)) return null;
  const base = mutationFields(value);
  if (!base || value.created !== true) return null;
  return { ...base, created: true };
}
