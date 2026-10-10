/**
 * P3.1-W02-B - Strict projections cho vendor master catalog admin RPC (#75).
 *
 * Payload dung chinh xac theo migration #75
 * (20261009110000_p3_1_w02b_vendor_lifecycle.sql):
 * - list/get tra 6 key: vendor_id, display_name, active, version, revision_count,
 *   recruiter_id (recruiter_id la canonical representation recruiter, co the NULL
 *   tren vendor legacy khong co representation);
 * - update/set-active tra 6 key (khong co revision_count);
 * - create tra them created: true (7 key).
 *
 * Server la authority: moi projection FAIL-CLOSED. Thieu/thua key, sai kieu hoac
 * gia tri khong hop le => null. KHONG bao gio chua capability/scope grant,
 * app_user, auth_subject, email hay raw reason.
 */

export type AdminVendor = {
  vendor_id: string;
  display_name: string;
  active: boolean;
  version: number;
  revision_count: number;
  recruiter_id: string | null;
};

export type AdminVendorList = {
  authorization_date: string;
  include_inactive: boolean;
  search: string | null;
  page: number;
  page_size: number;
  total: number;
  vendors: readonly AdminVendor[];
};

/** update + set_active (6 key). */
export type AdminVendorMutation = {
  vendor_id: string;
  display_name: string;
  active: boolean;
  version: number;
  revision_id: string;
  recruiter_id: string | null;
};

/** create tra them created: true (7 key). */
export type AdminVendorCreateResult = AdminVendorMutation & { created: true };

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

const ITEM_KEYS = ["vendor_id", "display_name", "active", "version", "revision_count",
  "recruiter_id"] as const;
const LIST_KEYS = ["authorization_date", "include_inactive", "search", "page", "page_size",
  "total", "vendors"] as const;
const MUTATION_KEYS = ["vendor_id", "display_name", "active", "version", "revision_id",
  "recruiter_id"] as const;
const CREATE_KEYS = [...MUTATION_KEYS, "created"] as const;

/** Vendor row 6 key (list item + get). */
export function vendorCatalogItem(value: unknown): AdminVendor | null {
  if (!isRecord(value) || !exactKeys(value, ITEM_KEYS)) return null;
  const vendor_id = str(value.vendor_id);
  const display_name = str(value.display_name);
  const active = bool(value.active);
  const version = int(value.version);
  const revision_count = int(value.revision_count);
  const recruiter_id = nullableStr(value.recruiter_id);
  if (vendor_id === null || display_name === null || active === null ||
      version === null || revision_count === null || recruiter_id === undefined) {
    return null;
  }
  return { vendor_id, display_name, active, version, revision_count, recruiter_id };
}

export function vendorCatalogList(value: unknown): AdminVendorList | null {
  if (!isRecord(value) || !exactKeys(value, LIST_KEYS)) return null;
  const authorization_date = str(value.authorization_date);
  const include_inactive = bool(value.include_inactive);
  const search = nullableStr(value.search);
  const page = int(value.page);
  const page_size = int(value.page_size);
  const total = int(value.total);
  if (authorization_date === null || include_inactive === null || search === undefined ||
      page === null || page_size === null || total === null || !Array.isArray(value.vendors)) {
    return null;
  }
  const vendors: AdminVendor[] = [];
  for (const item of value.vendors) {
    const row = vendorCatalogItem(item);
    if (!row) return null;
    vendors.push(row);
  }
  if (total < vendors.length) return null;
  return { authorization_date, include_inactive, search, page, page_size, total, vendors };
}

function mutationFields(value: Record<string, unknown>): AdminVendorMutation | null {
  const vendor_id = str(value.vendor_id);
  const display_name = str(value.display_name);
  const active = bool(value.active);
  const version = int(value.version);
  const revision_id = str(value.revision_id);
  const recruiter_id = nullableStr(value.recruiter_id);
  if (vendor_id === null || display_name === null || active === null ||
      version === null || revision_id === null || recruiter_id === undefined) {
    return null;
  }
  return { vendor_id, display_name, active, version, revision_id, recruiter_id };
}

/** update/set_active (6 key). */
export function vendorCatalogMutation(value: unknown): AdminVendorMutation | null {
  if (!isRecord(value) || !exactKeys(value, MUTATION_KEYS)) return null;
  return mutationFields(value);
}

/** create (7 key, created phai dung bang true). */
export function vendorCatalogCreateResult(value: unknown): AdminVendorCreateResult | null {
  if (!isRecord(value) || !exactKeys(value, CREATE_KEYS)) return null;
  const base = mutationFields(value);
  if (!base || value.created !== true) return null;
  return { ...base, created: true };
}
