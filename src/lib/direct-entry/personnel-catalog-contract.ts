/**
 * P3.1-W01B - Strict projections cho personnel catalog admin RPC (#68).
 *
 * Payload dung chinh xac theo migration #68
 * (20261009040000_p3_1_w01b_personnel_catalog.sql):
 * - list/get tra 8 key: recruiter_id, display_name, personnel_code,
 *   personnel_position, active, version, hrp_valid_from, revision_count;
 * - create tra them hrp_valid_from + created (9 key);
 * - update/set-active tra 7 key (khong co hrp_valid_from).
 *
 * Server la authority: moi projection FAIL-CLOSED. Thieu/thua key, sai kieu
 * hoac gia tri khong hop le => null (khong bao gio doan y nghia, khong bao gio
 * tra ve doi tuong mot phan). KHONG bao gio chua auth_subject, email,
 * capability/scope, app-user UUID, raw reason hay storage data.
 */

export type PersonnelPosition = "STAFF" | "TEAM_LEADER";

export type AdminPersonnel = {
  recruiter_id: string;
  display_name: string;
  personnel_code: string | null;
  personnel_position: PersonnelPosition | null;
  active: boolean;
  version: number;
  hrp_valid_from: string | null;
  revision_count: number;
};

export type AdminPersonnelList = {
  authorization_date: string;
  include_inactive: boolean;
  search: string | null;
  page: number;
  page_size: number;
  total: number;
  personnel: readonly AdminPersonnel[];
};

/** update + set_active (7 key). */
export type AdminPersonnelMutation = {
  recruiter_id: string;
  display_name: string;
  personnel_code: string | null;
  personnel_position: PersonnelPosition | null;
  active: boolean;
  version: number;
  revision_id: string;
};

/** create tra them hrp_valid_from + created: true (9 key). */
export type AdminPersonnelCreateResult = AdminPersonnelMutation & {
  hrp_valid_from: string;
  created: true;
};

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
function position(value: unknown): PersonnelPosition | null | undefined {
  if (value === null) return null;
  return value === "STAFF" || value === "TEAM_LEADER" ? value : undefined;
}
function day(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

const ITEM_KEYS = ["recruiter_id", "display_name", "personnel_code", "personnel_position",
  "active", "version", "hrp_valid_from", "revision_count"] as const;
const LIST_KEYS = ["authorization_date", "include_inactive", "search", "page", "page_size",
  "total", "personnel"] as const;
const MUTATION_KEYS = ["recruiter_id", "display_name", "personnel_code", "personnel_position",
  "active", "version", "revision_id"] as const;
const CREATE_KEYS = [...MUTATION_KEYS, "hrp_valid_from", "created"] as const;

/** Personnel row 8 key (list item + get). */
export function personnelCatalogItem(value: unknown): AdminPersonnel | null {
  if (!isRecord(value) || !exactKeys(value, ITEM_KEYS)) return null;
  const recruiter_id = str(value.recruiter_id);
  const display_name = str(value.display_name);
  const personnel_code = nullableStr(value.personnel_code);
  const personnel_position = position(value.personnel_position);
  const active = bool(value.active);
  const version = int(value.version);
  const hrp_valid_from = day(value.hrp_valid_from);
  const revision_count = int(value.revision_count);
  if (recruiter_id === null || display_name === null || personnel_code === undefined ||
      personnel_position === undefined || active === null || version === null ||
      hrp_valid_from === undefined || revision_count === null) {
    return null;
  }
  return { recruiter_id, display_name, personnel_code, personnel_position, active, version,
    hrp_valid_from, revision_count };
}

export function personnelCatalogList(value: unknown): AdminPersonnelList | null {
  if (!isRecord(value) || !exactKeys(value, LIST_KEYS)) return null;
  const authorization_date = str(value.authorization_date);
  const include_inactive = bool(value.include_inactive);
  const search = nullableStr(value.search);
  const page = int(value.page);
  const page_size = int(value.page_size);
  const total = int(value.total);
  if (authorization_date === null || include_inactive === null || search === undefined ||
      page === null || page_size === null || total === null || !Array.isArray(value.personnel)) {
    return null;
  }
  const personnel: AdminPersonnel[] = [];
  for (const item of value.personnel) {
    const row = personnelCatalogItem(item);
    if (!row) return null;
    personnel.push(row);
  }
  return { authorization_date, include_inactive, search, page, page_size, total, personnel };
}

function mutationFields(value: Record<string, unknown>): AdminPersonnelMutation | null {
  const recruiter_id = str(value.recruiter_id);
  const display_name = str(value.display_name);
  const personnel_code = nullableStr(value.personnel_code);
  const personnel_position = position(value.personnel_position);
  const active = bool(value.active);
  const version = int(value.version);
  const revision_id = str(value.revision_id);
  if (recruiter_id === null || display_name === null || personnel_code === undefined ||
      personnel_position === undefined || active === null || version === null ||
      revision_id === null) {
    return null;
  }
  return { recruiter_id, display_name, personnel_code, personnel_position, active, version,
    revision_id };
}

/** update/set_active (7 key). */
export function personnelCatalogMutation(value: unknown): AdminPersonnelMutation | null {
  if (!isRecord(value) || !exactKeys(value, MUTATION_KEYS)) return null;
  return mutationFields(value);
}

/** create (9 key, created phai dung bang true). */
export function personnelCatalogCreateResult(value: unknown): AdminPersonnelCreateResult | null {
  if (!isRecord(value) || !exactKeys(value, CREATE_KEYS)) return null;
  const base = mutationFields(value);
  const hrp_valid_from = day(value.hrp_valid_from);
  const created = bool(value.created);
  if (!base || hrp_valid_from === null || hrp_valid_from === undefined || created !== true) {
    return null;
  }
  return { ...base, hrp_valid_from, created: true };
}
