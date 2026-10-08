/**
 * P2.5-HF-R1 - hop dong tra cuu episode (ten HOAC CCCD).
 *
 * Pure validator + projection: khong I/O, khong doc session, khong goi DB.
 * Authority (actor mapping, assignment hieu luc o project dich, hoac all-scope admin)
 * do RPC public.direct_entry_lookup_worker_episodes quyet dinh - browser khong bao gio
 * tu khai identity, project hay scope.
 *
 * Fail-closed: dung key, dung kieu, khong fallback [], 0, false; khong type assertion.
 * Projection chi giu tap truong toi thieu da thong nhat (ten, ma NV, project, ngay vao
 * lam, trang thai moi nhat) - khong CCCD day du, DOB, dia chi, dien thoai, ngan hang hay
 * tai lieu.
 */
export const WORKER_EPISODE_LOOKUP_QUERY_KEYS = [
  "project_id", "display_name", "national_id", "page_size", "offset",
] as const;

export const WORKER_EPISODE_LOOKUP_PAGE_KEYS = [
  "match", "project_id", "page_size", "offset", "has_more", "workers", "authorization_date",
] as const;
export const WORKER_EPISODE_LOOKUP_WORKER_KEYS = [
  "display_name", "employee_code", "episode_count", "active_episode_exists", "rehire_allowed",
  "episodes",
] as const;
export const WORKER_EPISODE_LOOKUP_EPISODE_KEYS = [
  "entry_id", "display_name", "employee_code", "project_id", "project_display",
  "first_work_date", "latest_status",
] as const;

export const WORKER_EPISODE_LOOKUP_MATCHES = ["national_id", "display_name"] as const;
export type WorkerEpisodeLookupMatch = (typeof WORKER_EPISODE_LOOKUP_MATCHES)[number];

export const WORKER_EPISODE_LOOKUP_DEFAULT_PAGE_SIZE = 20;
export const WORKER_EPISODE_LOOKUP_MAX_PAGE_SIZE = 50;
export const WORKER_EPISODE_LOOKUP_MAX_OFFSET = 5000;
export const WORKER_EPISODE_LOOKUP_MAX_NAME_LENGTH = 128;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const EMPLOYEE_CODE = /^hrp-[0-9]{4}-[0-9]{6}$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const PAGE_TEXT = /^[1-9][0-9]{0,2}$/;
const OFFSET_TEXT = /^(0|[1-9][0-9]{0,4})$/;
const NATIONAL_ID_TEXT = /^[0-9][0-9 .\-]{4,19}$/;
const STATUSES = ["UNCONFIRMED", "ON", "OFF"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

export type WorkerEpisodeLookupQuery = {
  project_id: string;
  display_name: string | null;
  national_id: string | null;
  page_size: number;
  offset: number;
};

export type WorkerEpisodeLookupEpisode = {
  entry_id: string;
  display_name: string;
  employee_code: string;
  project_id: string;
  project_display: string;
  first_work_date: string;
  latest_status: (typeof STATUSES)[number];
};

export type WorkerEpisodeLookupWorker = {
  display_name: string;
  employee_code: string;
  episode_count: number;
  active_episode_exists: boolean;
  rehire_allowed: boolean;
  episodes: WorkerEpisodeLookupEpisode[];
};

export type WorkerEpisodeLookupPage = {
  match: WorkerEpisodeLookupMatch;
  project_id: string;
  page_size: number;
  offset: number;
  has_more: boolean;
  workers: WorkerEpisodeLookupWorker[];
  authorization_date: string;
};

export type WorkerEpisodeLookupProjection<T> =
  | { ok: true; value: T }
  | { ok: false; code: "WORKER_EPISODE_QUERY_INVALID" };

const QUERY_INVALID = { ok: false, code: "WORKER_EPISODE_QUERY_INVALID" } as const;

/**
 * Query lookup: chi nhan project_id | display_name | national_id | page_size | offset.
 * Phai co it nhat mot trong hai khoa tra cuu; tham so khac (order, limit, sql, identity...)
 * bi tu choi de client khong dieu khien duoc SQL, sort, paging hay quyen.
 */
export function projectWorkerEpisodeLookupQuery(
  searchParams: URLSearchParams,
): WorkerEpisodeLookupProjection<WorkerEpisodeLookupQuery> {
  const keys = [...searchParams.keys()];
  if (keys.length !== new Set(keys).size) return QUERY_INVALID;
  for (const key of keys) {
    if (!(WORKER_EPISODE_LOOKUP_QUERY_KEYS as readonly string[]).includes(key)) return QUERY_INVALID;
  }

  const rawProject = searchParams.get("project_id");
  if (rawProject === null || !PROJECT_ID.test(rawProject)) return QUERY_INVALID;

  const rawName = searchParams.get("display_name");
  let displayName: string | null = null;
  if (rawName !== null) {
    const trimmed = rawName.trim();
    if (trimmed.length === 0 || trimmed.length > WORKER_EPISODE_LOOKUP_MAX_NAME_LENGTH) {
      return QUERY_INVALID;
    }
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) return QUERY_INVALID;
    displayName = trimmed;
  }

  const rawId = searchParams.get("national_id");
  let nationalId: string | null = null;
  if (rawId !== null) {
    if (!NATIONAL_ID_TEXT.test(rawId.trim())) return QUERY_INVALID;
    // Digits only: separators are ignored and a leading zero is preserved as text.
    const digits = rawId.replace(/[^0-9]/g, "");
    if (digits.length < 6 || digits.length > 12) return QUERY_INVALID;
    nationalId = digits;
  }
  if (displayName === null && nationalId === null) return QUERY_INVALID;

  const rawPage = searchParams.get("page_size");
  let pageSize = WORKER_EPISODE_LOOKUP_DEFAULT_PAGE_SIZE;
  if (rawPage !== null) {
    if (!PAGE_TEXT.test(rawPage)) return QUERY_INVALID;
    pageSize = Number(rawPage);
    if (pageSize < 1 || pageSize > WORKER_EPISODE_LOOKUP_MAX_PAGE_SIZE) return QUERY_INVALID;
  }
  const rawOffset = searchParams.get("offset");
  let offset = 0;
  if (rawOffset !== null) {
    if (!OFFSET_TEXT.test(rawOffset)) return QUERY_INVALID;
    offset = Number(rawOffset);
    if (offset > WORKER_EPISODE_LOOKUP_MAX_OFFSET) return QUERY_INVALID;
  }

  return { ok: true, value: { project_id: rawProject, display_name: displayName, national_id: nationalId, page_size: pageSize, offset } };
}

function projectEpisode(value: unknown): WorkerEpisodeLookupEpisode | null {
  if (!isRecord(value) || !hasExactKeys(value, WORKER_EPISODE_LOOKUP_EPISODE_KEYS)) return null;
  if (typeof value.entry_id !== "string" || !UUID.test(value.entry_id)) return null;
  if (typeof value.display_name !== "string" || value.display_name.trim().length === 0) return null;
  if (typeof value.employee_code !== "string" || !EMPLOYEE_CODE.test(value.employee_code)) return null;
  if (typeof value.project_id !== "string" || !PROJECT_ID.test(value.project_id)) return null;
  if (typeof value.project_display !== "string" || value.project_display.trim().length === 0) return null;
  if (typeof value.first_work_date !== "string" || !ISO_DATE.test(value.first_work_date)) return null;
  if (typeof value.latest_status !== "string" ||
      !(STATUSES as readonly string[]).includes(value.latest_status)) return null;
  return {
    entry_id: value.entry_id,
    display_name: value.display_name,
    employee_code: value.employee_code,
    project_id: value.project_id,
    project_display: value.project_display,
    first_work_date: value.first_work_date,
    latest_status: value.latest_status as WorkerEpisodeLookupEpisode["latest_status"],
  };
}

function projectWorker(value: unknown): WorkerEpisodeLookupWorker | null {
  if (!isRecord(value) || !hasExactKeys(value, WORKER_EPISODE_LOOKUP_WORKER_KEYS)) return null;
  if (typeof value.display_name !== "string" || value.display_name.trim().length === 0) return null;
  if (typeof value.employee_code !== "string" || !EMPLOYEE_CODE.test(value.employee_code)) return null;
  if (typeof value.episode_count !== "number" || !Number.isInteger(value.episode_count) ||
      value.episode_count < 0) return null;
  if (typeof value.active_episode_exists !== "boolean") return null;
  if (typeof value.rehire_allowed !== "boolean") return null;
  if (value.rehire_allowed === value.active_episode_exists) return null;
  if (!Array.isArray(value.episodes) || value.episodes.length === 0) return null;
  const episodes: WorkerEpisodeLookupEpisode[] = [];
  for (const candidate of value.episodes) {
    const episode = projectEpisode(candidate);
    if (episode === null) return null;
    episodes.push(episode);
  }
  return {
    display_name: value.display_name,
    employee_code: value.employee_code,
    episode_count: value.episode_count,
    active_episode_exists: value.active_episode_exists,
    rehire_allowed: value.rehire_allowed,
    episodes,
  };
}

/**
 * Project ket qua RPC: shape la, dung key, dung kieu; bat ky sai lech => null va
 * repository tra unavailable (khong bao gio success voi du lieu do dang).
 */
export function projectWorkerEpisodeLookupPage(
  value: unknown,
  expected: { page_size: number; offset: number },
): WorkerEpisodeLookupPage | null {
  if (!isRecord(value) || !hasExactKeys(value, WORKER_EPISODE_LOOKUP_PAGE_KEYS)) return null;
  if (typeof value.match !== "string" ||
      !(WORKER_EPISODE_LOOKUP_MATCHES as readonly string[]).includes(value.match)) return null;
  if (typeof value.project_id !== "string" || !PROJECT_ID.test(value.project_id)) return null;
  if (typeof value.page_size !== "number" || value.page_size !== expected.page_size) return null;
  if (typeof value.offset !== "number" || value.offset !== expected.offset) return null;
  if (typeof value.has_more !== "boolean") return null;
  if (typeof value.authorization_date !== "string" || !ISO_DATE.test(value.authorization_date)) return null;
  if (!Array.isArray(value.workers) || value.workers.length > expected.page_size) return null;
  const workers: WorkerEpisodeLookupWorker[] = [];
  for (const candidate of value.workers) {
    const worker = projectWorker(candidate);
    if (worker === null) return null;
    workers.push(worker);
  }
  return {
    match: value.match as WorkerEpisodeLookupMatch,
    project_id: value.project_id,
    page_size: value.page_size,
    offset: value.offset,
    has_more: value.has_more,
    workers,
    authorization_date: value.authorization_date,
  };
}
