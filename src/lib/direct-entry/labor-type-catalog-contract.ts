/**
 * P3.1-W02C - Strict projections cho labor type catalog admin RPC (#79).
 *
 * Payload dung chinh xac theo migration #79
 * (20261011120000_p3_1_w02c_labor_type_catalog.sql):
 * - list/get tra 7 key: labor_type_key, display_name, reporting_key, sort_order,
 *   active, version, revision_count;
 * - create/update/set-active tra 7 key: labor_type_key, display_name,
 *   reporting_key, sort_order, active, version, revision_id;
 * - create tra them created: true (8 key).
 *
 * Server la authority: moi projection FAIL-CLOSED. Thieu/thua key, sai kieu
 * hoac gia tri khong hop le => null (khong bao gio doan y nghia, khong bao gio
 * tra ve doi tuong mot phan). KHONG bao gio chua auth_subject, email,
 * capability/scope, app-user UUID, raw reason, grant id, revision payload hay
 * storage data. reporting_key la catalog-owned: client khong bao gio gui.
 */

/** Canonical labor-type key: chu hoa dau, sau do [A-Z0-9_], toi da 64 ky tu. */
export const LABOR_TYPE_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

export type AdminLaborType = {
  labor_type_key: string;
  display_name: string;
  reporting_key: string;
  sort_order: number;
  active: boolean;
  version: number;
  revision_count: number;
};

export type AdminLaborTypeList = {
  authorization_date: string;
  include_inactive: boolean;
  search: string | null;
  page: number;
  page_size: number;
  total: number;
  labor_types: readonly AdminLaborType[];
};

/** update + set_active (7 key). */
export type AdminLaborTypeMutation = {
  labor_type_key: string;
  display_name: string;
  reporting_key: string;
  sort_order: number;
  active: boolean;
  version: number;
  revision_id: string;
};

/** create tra them created: true (8 key). */
export type AdminLaborTypeCreateResult = AdminLaborTypeMutation & { created: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
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
function key(value: unknown): string | null {
  return typeof value === "string" && LABOR_TYPE_KEY.test(value) ? value : null;
}

const ITEM_KEYS = ["labor_type_key", "display_name", "reporting_key", "sort_order",
  "active", "version", "revision_count"] as const;
const LIST_KEYS = ["authorization_date", "include_inactive", "search", "page", "page_size",
  "total", "labor_types"] as const;
const MUTATION_KEYS = ["labor_type_key", "display_name", "reporting_key", "sort_order",
  "active", "version", "revision_id"] as const;
const CREATE_KEYS = [...MUTATION_KEYS, "created"] as const;

/** Labor type admin row 7 key (list item + get). */
export function laborTypeCatalogItem(value: unknown): AdminLaborType | null {
  if (!isRecord(value) || !exactKeys(value, ITEM_KEYS)) return null;
  const labor_type_key = key(value.labor_type_key);
  const display_name = str(value.display_name);
  const reporting_key = str(value.reporting_key);
  const sort_order = int(value.sort_order);
  const active = bool(value.active);
  const version = int(value.version);
  const revision_count = int(value.revision_count);
  if (labor_type_key === null || display_name === null || reporting_key === null ||
      sort_order === null || active === null || version === null || revision_count === null) {
    return null;
  }
  return { labor_type_key, display_name, reporting_key, sort_order, active, version,
    revision_count };
}

export function laborTypeCatalogList(value: unknown): AdminLaborTypeList | null {
  if (!isRecord(value) || !exactKeys(value, LIST_KEYS)) return null;
  const authorization_date = str(value.authorization_date);
  const include_inactive = bool(value.include_inactive);
  const search = value.search === null ? null : str(value.search);
  const page = int(value.page);
  const page_size = int(value.page_size);
  const total = int(value.total);
  if (authorization_date === null || include_inactive === null || search === undefined ||
      page === null || page_size === null || total === null || !Array.isArray(value.labor_types)) {
    return null;
  }
  const labor_types: AdminLaborType[] = [];
  for (const item of value.labor_types) {
    const row = laborTypeCatalogItem(item);
    if (!row) return null;
    labor_types.push(row);
  }
  return { authorization_date, include_inactive, search, page, page_size, total, labor_types };
}

function mutationFields(value: Record<string, unknown>): AdminLaborTypeMutation | null {
  const labor_type_key = key(value.labor_type_key);
  const display_name = str(value.display_name);
  const reporting_key = str(value.reporting_key);
  const sort_order = int(value.sort_order);
  const active = bool(value.active);
  const version = int(value.version);
  const revision_id = str(value.revision_id);
  if (labor_type_key === null || display_name === null || reporting_key === null ||
      sort_order === null || active === null || version === null || revision_id === null) {
    return null;
  }
  return { labor_type_key, display_name, reporting_key, sort_order, active, version, revision_id };
}

/** update/set_active (7 key). */
export function laborTypeCatalogMutation(value: unknown): AdminLaborTypeMutation | null {
  if (!isRecord(value) || !exactKeys(value, MUTATION_KEYS)) return null;
  return mutationFields(value);
}

/** create (8 key, created phai dung bang true). */
export function laborTypeCatalogCreateResult(value: unknown): AdminLaborTypeCreateResult | null {
  if (!isRecord(value) || !exactKeys(value, CREATE_KEYS)) return null;
  const base = mutationFields(value);
  if (!base || bool(value.created) !== true) return null;
  return { ...base, created: true };
}
