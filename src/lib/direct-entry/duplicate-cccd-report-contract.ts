/**
 * P3.1-HF-R3 - Hop dong bao cao CCCD trung (read-only, phan trang).
 *
 * Pure projection: khong I/O, khong doc session, khong goi DB. Nguon su that la RPC
 * public.direct_entry_duplicate_cccd_report (#74) - server tu resolve actor; client khong
 * bao gio gui auth_subject/app_user_id/capability/scope.
 *
 * Module nay:
 *   * parse/validate query dung hai key `page` + `page_size` theo bien cua RPC
 *     (page 1..1000, page_size 1..100, mac dinh 25) va fail-closed voi moi key khac;
 *   * xac nhan projection cua RPC theo dung key cua no roi thu ve projection hien thi:
 *     loai bo `authority` (capability) va `project_id` (dinh danh routing noi bo) truoc khi
 *     bat ky byte nao roi khoi server. Khong bao gio tra CCCD day du, UUID, entry_id/worker
 *     ID, auth subject, email, capability/scope hay raw DB error.
 *   * map trang thai canonical ON / UNCONFIRMED / OFF sang nhan tieng Viet cho UI (SQL chi
 *     phat ra enum, khong bao gio so sanh chuoi tieng Viet).
 */
export const DUPLICATE_CCCD_REPORT_DEFAULT_PAGE_SIZE = 25;
export const DUPLICATE_CCCD_REPORT_MAX_PAGE_SIZE = 100;
export const DUPLICATE_CCCD_REPORT_MAX_PAGE = 1000;
/** Lua chon kich thuoc trang cho UI - tat ca deu trong bien cua RPC. */
export const DUPLICATE_CCCD_REPORT_PAGE_SIZE_OPTIONS: readonly number[] = [25, 50, 100];

export const DUPLICATE_CCCD_REPORT_QUERY_KEYS = ["page", "page_size"] as const;

/**
 * Key cua jsonb ma RPC #74 thuc su phat ra. `authority` va `project_id` phai co trong payload
 * de xac nhan dung contract, nhung chung KHONG duoc tra ra client.
 */
export const DUPLICATE_CCCD_REPORT_RPC_KEYS = [
  "authority", "authorization_date", "page", "page_size", "total_groups", "total_entries",
  "has_more", "groups",
] as const;
export const DUPLICATE_CCCD_REPORT_RPC_EPISODE_KEYS = [
  "employee_code", "display_name", "project_id", "project_display", "first_work_date",
  "latest_status", "active",
] as const;

/** Projection hien thi tra ra client: dung cac truong display RPC cho phep. */
export const DUPLICATE_CCCD_REPORT_PAGE_KEYS = [
  "page", "page_size", "total_groups", "total_entries", "has_more", "authorization_date",
  "groups",
] as const;
export const DUPLICATE_CCCD_REPORT_GROUP_KEYS = [
  "cccd_last4", "cccd_length", "profile_count", "project_count", "active_profile_count",
  "first_work_date", "latest_first_work_date", "episodes",
] as const;
export const DUPLICATE_CCCD_REPORT_EPISODE_KEYS = [
  "employee_code", "display_name", "project_display", "first_work_date", "latest_status",
  "active",
] as const;

export const DUPLICATE_CCCD_REPORT_AUTHORITIES = ["business_actor"] as const;
export const DUPLICATE_CCCD_EMPLOYMENT_STATUSES = ["ON", "UNCONFIRMED", "OFF"] as const;

export type DuplicateCccdEmploymentStatus = (typeof DUPLICATE_CCCD_EMPLOYMENT_STATUSES)[number];

export const EMPLOYMENT_STATUS_LABELS: Readonly<Record<DuplicateCccdEmploymentStatus, string>> =
  Object.freeze({
    ON: "Đang làm việc",
    UNCONFIRMED: "Đang chờ việc",
    OFF: "Đã nghỉ",
  });

const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const LAST4 = /^[0-9]{4}$/;
const PAGE_TEXT = /^[1-9][0-9]{0,3}$/;
const PAGE_SIZE_TEXT = /^[1-9][0-9]{0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isNullableText(value: unknown, max: number): value is string | null {
  return value === null || isBoundedText(value, max);
}

function isNullableIsoDate(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && ISO_DATE.test(value));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type DuplicateCccdReportQuery = { page: number; page_size: number };

export type DuplicateCccdReportQueryProjection =
  | { ok: true; value: DuplicateCccdReportQuery }
  | { ok: false; code: "DUPLICATE_CCCD_REPORT_QUERY_INVALID" };

const QUERY_INVALID = { ok: false, code: "DUPLICATE_CCCD_REPORT_QUERY_INVALID" } as const;

/**
 * Query chi nhan dung `page` | `page_size`. Tham so khac (order, offset, limit, scope,
 * auth_subject, app_user_id...) bi tu choi: client khong dieu khien duoc paging ngoai bien
 * cua RPC va khong tu khai identity/authority.
 */
export function projectDuplicateCccdReportQuery(
  searchParams: URLSearchParams,
): DuplicateCccdReportQueryProjection {
  if ([...searchParams.keys()].length !== new Set(searchParams.keys()).size) return QUERY_INVALID;
  for (const key of searchParams.keys()) {
    if (!(DUPLICATE_CCCD_REPORT_QUERY_KEYS as readonly string[]).includes(key)) return QUERY_INVALID;
  }

  const rawPage = searchParams.get("page");
  let page = 1;
  if (rawPage !== null) {
    if (!PAGE_TEXT.test(rawPage)) return QUERY_INVALID;
    page = Number(rawPage);
    if (page < 1 || page > DUPLICATE_CCCD_REPORT_MAX_PAGE) return QUERY_INVALID;
  }

  const rawPageSize = searchParams.get("page_size");
  let pageSize = DUPLICATE_CCCD_REPORT_DEFAULT_PAGE_SIZE;
  if (rawPageSize !== null) {
    if (!PAGE_SIZE_TEXT.test(rawPageSize)) return QUERY_INVALID;
    pageSize = Number(rawPageSize);
    if (pageSize < 1 || pageSize > DUPLICATE_CCCD_REPORT_MAX_PAGE_SIZE) return QUERY_INVALID;
  }

  return { ok: true, value: { page, page_size: pageSize } };
}

/** Query string do client dung de goi API. Vuot bien => null (khong gui request sai). */
export function buildDuplicateCccdReportQuery(
  input: DuplicateCccdReportQuery,
): URLSearchParams | null {
  if (!Number.isSafeInteger(input.page) || input.page < 1 ||
      input.page > DUPLICATE_CCCD_REPORT_MAX_PAGE) {
    return null;
  }
  if (!Number.isSafeInteger(input.page_size) || input.page_size < 1 ||
      input.page_size > DUPLICATE_CCCD_REPORT_MAX_PAGE_SIZE) {
    return null;
  }
  return new URLSearchParams({
    page: String(input.page),
    page_size: String(input.page_size),
  });
}

/**
 * Trang ke tiep cho nut "Trang sau". Tra null khi het ket qua HOAC khi da cham tran cua RPC
 * (page > 1000) - nen tai page 1000 du RPC con `has_more: true` thi van KHONG goi page 1001.
 */
export function nextDuplicateCccdReportPage(page: number, hasMore: boolean): number | null {
  if (!hasMore) return null;
  if (!Number.isSafeInteger(page) || page < 1) return null;
  if (page >= DUPLICATE_CCCD_REPORT_MAX_PAGE) return null;
  return page + 1;
}

export type DuplicateCccdReportEpisode = {
  employee_code: string | null;
  display_name: string | null;
  project_display: string | null;
  first_work_date: string | null;
  latest_status: DuplicateCccdEmploymentStatus;
  active: boolean;
};

export type DuplicateCccdReportGroup = {
  cccd_last4: string;
  cccd_length: number;
  profile_count: number;
  project_count: number;
  active_profile_count: number;
  first_work_date: string | null;
  latest_first_work_date: string | null;
  episodes: DuplicateCccdReportEpisode[];
};

export type DuplicateCccdReportPage = {
  page: number;
  page_size: number;
  total_groups: number;
  total_entries: number;
  has_more: boolean;
  authorization_date: string;
  groups: DuplicateCccdReportGroup[];
};

function isEmploymentStatus(value: unknown): value is DuplicateCccdEmploymentStatus {
  return (DUPLICATE_CCCD_EMPLOYMENT_STATUSES as readonly string[]).includes(value as string);
}

function projectEpisodeFields(value: Record<string, unknown>): DuplicateCccdReportEpisode | null {
  if (!isNullableText(value.employee_code, 64)) return null;
  if (!isNullableText(value.display_name, 256)) return null;
  if (!isNullableText(value.project_display, 256)) return null;
  if (!isNullableIsoDate(value.first_work_date)) return null;
  if (!isEmploymentStatus(value.latest_status)) return null;
  if (typeof value.active !== "boolean") return null;
  if (value.latest_status !== "ON" || value.active !== true) return null;
  return {
    employee_code: value.employee_code,
    display_name: value.display_name,
    project_display: value.project_display,
    first_work_date: value.first_work_date,
    latest_status: value.latest_status,
    active: value.active,
  };
}

/** Episode o dang RPC: co `project_id` (dinh danh noi bo, bi loai bo khi tra ra). */
function projectEpisodeRpc(value: unknown): DuplicateCccdReportEpisode | null {
  if (!isRecord(value) || !hasExactKeys(value, DUPLICATE_CCCD_REPORT_RPC_EPISODE_KEYS)) return null;
  if (!isBoundedText(value.project_id, 128)) return null;
  return projectEpisodeFields(value);
}

/** Episode o dang da project (khong con `project_id`). */
function projectEpisodeView(value: unknown): DuplicateCccdReportEpisode | null {
  if (!isRecord(value) || !hasExactKeys(value, DUPLICATE_CCCD_REPORT_EPISODE_KEYS)) return null;
  return projectEpisodeFields(value);
}

function projectGroup(
  value: unknown,
  projectEpisode: (raw: unknown) => DuplicateCccdReportEpisode | null,
): DuplicateCccdReportGroup | null {
  if (!isRecord(value) || !hasExactKeys(value, DUPLICATE_CCCD_REPORT_GROUP_KEYS)) return null;
  if (typeof value.cccd_last4 !== "string" || !LAST4.test(value.cccd_last4)) return null;
  if (value.cccd_length !== 9 && value.cccd_length !== 12) return null;
  if (!isCount(value.profile_count) || value.profile_count < 2) return null;
  if (!isCount(value.project_count)) return null;
  if (!isCount(value.active_profile_count)) return null;
  if (value.project_count > value.profile_count) return null;
  if (value.active_profile_count !== value.profile_count) return null;
  if (!isNullableIsoDate(value.first_work_date)) return null;
  if (!isNullableIsoDate(value.latest_first_work_date)) return null;
  if (!Array.isArray(value.episodes)) return null;
  const episodes: DuplicateCccdReportEpisode[] = [];
  for (const raw of value.episodes) {
    const episode = projectEpisode(raw);
    if (episode === null) return null;
    episodes.push(episode);
  }
  if (episodes.length !== value.profile_count) return null;
  return {
    cccd_last4: value.cccd_last4,
    cccd_length: value.cccd_length,
    profile_count: value.profile_count,
    project_count: value.project_count,
    active_profile_count: value.active_profile_count,
    first_work_date: value.first_work_date,
    latest_first_work_date: value.latest_first_work_date,
    episodes,
  };
}

function projectPageBody(
  value: Record<string, unknown>,
  expected: DuplicateCccdReportQuery,
  projectGroup: (raw: unknown) => DuplicateCccdReportGroup | null,
): DuplicateCccdReportPage | null {
  if (typeof value.authorization_date !== "string" || !ISO_DATE.test(value.authorization_date)) {
    return null;
  }
  if (typeof value.page !== "number" || value.page !== expected.page) return null;
  if (typeof value.page_size !== "number" || value.page_size !== expected.page_size) return null;
  if (!isCount(value.total_groups) || !isCount(value.total_entries)) return null;
  if (typeof value.has_more !== "boolean") return null;
  if (!Array.isArray(value.groups)) return null;
  if (value.groups.length > expected.page_size) return null;
  // RPC chi cat con page_size phan tu khi con trang sau; mot trang cuoi vua day la hop le.
  if (value.has_more && value.groups.length !== expected.page_size) return null;
  const groups: DuplicateCccdReportGroup[] = [];
  for (const raw of value.groups) {
    const group = projectGroup(raw);
    if (group === null) return null;
    groups.push(group);
  }
  return {
    page: value.page,
    page_size: value.page_size,
    total_groups: value.total_groups,
    total_entries: value.total_entries,
    has_more: value.has_more,
    authorization_date: value.authorization_date,
    groups,
  };
}

/**
 * Xac nhan payload RPC #74 (dung key RPC) roi tra ve projection hien thi: bo `authority`
 * (capability) va `project_id` (dinh danh noi bo). Bat ky sai khac nao => null de caller
 * fail-closed (khong bao gio render mot trang voi du lieu khong ro nguon).
 */
export function projectDuplicateCccdReportRpcPage(
  value: unknown,
  expected: DuplicateCccdReportQuery,
): DuplicateCccdReportPage | null {
  if (!isRecord(value) || !hasExactKeys(value, DUPLICATE_CCCD_REPORT_RPC_KEYS)) return null;
  if (typeof value.authority !== "string" ||
      !(DUPLICATE_CCCD_REPORT_AUTHORITIES as readonly string[]).includes(value.authority)) {
    return null;
  }
  return projectPageBody(value, expected, (raw) => projectGroup(raw, projectEpisodeRpc));
}

/** Xac nhan projection hien thi (khong con authority/project_id) do API tra ve. */
export function projectDuplicateCccdReportViewPage(
  value: unknown,
  expected: DuplicateCccdReportQuery,
): DuplicateCccdReportPage | null {
  if (!isRecord(value) || !hasExactKeys(value, DUPLICATE_CCCD_REPORT_PAGE_KEYS)) return null;
  return projectPageBody(value, expected, (raw) => projectGroup(raw, projectEpisodeView));
}

/** Projection cua ca response `{ ok: true, ...page }` do API/RouteHandler tra ve. */
export function projectDuplicateCccdReportResponse(
  payload: unknown,
  expected: DuplicateCccdReportQuery,
): DuplicateCccdReportPage | null {
  if (!isRecord(payload) || !hasExactKeys(payload, ["ok", ...DUPLICATE_CCCD_REPORT_PAGE_KEYS]) ||
      payload.ok !== true) {
    return null;
  }
  return projectPageBody(payload, expected, (raw) => projectGroup(raw, projectEpisodeView));
}

/** CCCD da che: chi 4 chu so cuoi hien ra, phan con lai la placeholder. */
export function maskedCccd(last4: string, length: number): string {
  const hidden = Math.max(0, Math.min(length, 12) - last4.length);
  return "•".repeat(hidden) + last4;
}

export function employmentStatusLabel(status: DuplicateCccdEmploymentStatus): string {
  return EMPLOYMENT_STATUS_LABELS[status];
}
