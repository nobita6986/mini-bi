export const ATTENDANCE_BUSINESS_TIMEZONE = "Asia/Ho_Chi_Minh" as const;
export const ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE = 25;
export const ATTENDANCE_REPORT_MAX_PAGE_SIZE = 100;
export const ATTENDANCE_REPORT_MAX_PAGE = 1000;
export const ATTENDANCE_REPORT_MAX_RANGE_DAYS = 366;
export const ATTENDANCE_REPORT_MAX_SEARCH_LENGTH = 120;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

export const ATTENDANCE_REPORT_TIME_SOURCES = [
  "SERVER_ANCHORED",
  "DEVICE_CLOCK_UNVERIFIED",
] as const;

export type AttendanceReportTimeSource = (typeof ATTENDANCE_REPORT_TIME_SOURCES)[number];

export const ATTENDANCE_DISTANCE_STATUSES = [
  "COMPUTED",
  "HQ_NOT_CONFIGURED",
  "INVALID_GPS",
] as const;

export type AttendanceDistanceStatus = (typeof ATTENDANCE_DISTANCE_STATUSES)[number];

export const ATTENDANCE_REPORT_ERROR_CODES = [
  "UNAUTHENTICATED",
  "ACTOR_NOT_AVAILABLE",
  "ATTENDANCE_REPORT_ACCESS_DENIED",
  "ATTENDANCE_HQ_MANAGE_DENIED",
  "CSRF_REJECTED",
  "CONTENT_TYPE_INVALID",
  "BODY_TOO_LARGE",
  "ATTENDANCE_REPORT_QUERY_INVALID",
  "ATTENDANCE_REPORT_RANGE_INVALID",
  "ATTENDANCE_REPORT_PAGINATION_INVALID",
  "ATTENDANCE_REPORT_SEARCH_INVALID",
  "ATTENDANCE_HQ_COORDINATES_INVALID",
  "ATTENDANCE_HQ_VERSION_CONFLICT",
  "IDEMPOTENCY_KEY_INVALID",
  "IDEMPOTENCY_CONFLICT",
  "ATTENDANCE_REPORT_UNAVAILABLE",
] as const;

export type AttendanceReportErrorCode = (typeof ATTENDANCE_REPORT_ERROR_CODES)[number];

const ERROR_HTTP_STATUS: Readonly<Record<AttendanceReportErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  ACTOR_NOT_AVAILABLE: 403,
  ATTENDANCE_REPORT_ACCESS_DENIED: 403,
  ATTENDANCE_HQ_MANAGE_DENIED: 403,
  CSRF_REJECTED: 403,
  CONTENT_TYPE_INVALID: 400,
  BODY_TOO_LARGE: 413,
  ATTENDANCE_REPORT_QUERY_INVALID: 400,
  ATTENDANCE_REPORT_RANGE_INVALID: 400,
  ATTENDANCE_REPORT_PAGINATION_INVALID: 400,
  ATTENDANCE_REPORT_SEARCH_INVALID: 400,
  ATTENDANCE_HQ_COORDINATES_INVALID: 400,
  ATTENDANCE_HQ_VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_INVALID: 400,
  IDEMPOTENCY_CONFLICT: 409,
  ATTENDANCE_REPORT_UNAVAILABLE: 503,
};

export function attendanceReportHttpStatusForError(code: AttendanceReportErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}

export type AttendanceHqLocationProjection = {
  version: number;
  latitude: number;
  longitude: number;
  effective_from: string;
  effective_from_local: string;
  configured_by_display_name: string;
};

export type AttendanceReportOverviewProjection = {
  total_checkins: number;
  unique_employees: number;
  verified_time_count: number;
  unverified_time_count: number;
  distance_computed_count: number;
  distance_unavailable_count: number;
  avg_distance_meters: number | null;
  max_distance_meters: number | null;
};

export type AttendanceReportPaginationProjection = {
  page: number;
  page_size: number;
  total_rows: number;
  total_pages: number;
  has_more: boolean;
};

export type AttendanceReportItemProjection = {
  checkin_id: string;
  employee_display_name: string;
  personnel_code: string | null;
  business_date: string;
  sequence_in_day: number;
  captured_at: string;
  captured_at_local: string;
  received_at: string;
  time_source: AttendanceReportTimeSource;
  time_verified: boolean;
  sync_delay_seconds: number;
  latitude: number | null;
  longitude: number | null;
  accuracy_meters: number | null;
  address_hint: string;
  note: string;
  distance_meters: number | null;
  distance_status: AttendanceDistanceStatus;
  hq_version_used: number | null;
};

export type AttendanceAdminReportProjection = {
  viewer: {
    can_configure_hq: boolean;
  };
  filters: {
    from_date: string;
    to_date: string;
    search: string | null;
    timezone: typeof ATTENDANCE_BUSINESS_TIMEZONE;
  };
  current_hq: AttendanceHqLocationProjection | null;
  overview: AttendanceReportOverviewProjection;
  pagination: AttendanceReportPaginationProjection;
  items: AttendanceReportItemProjection[];
};

export type SetAttendanceHqLocationProjection = {
  replayed: boolean;
  hq: AttendanceHqLocationProjection;
};

export type ParsedAttendanceReportQuery = {
  from_date: string | null;
  to_date: string | null;
  page: number;
  page_size: number;
  search: string | null;
};

export type ParsedSetHqLocationRequest = {
  latitude: number;
  longitude: number;
  expected_version: number;
  idempotency_key: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== expected.length) return false;
  const set = new Set(expected);
  return actual.every((key) => set.has(key));
}

function isUuidString(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function parseIsoDateToUtcEpochDay(value: string): number | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utcMs = Date.UTC(year, month - 1, day);
  const date = new Date(utcMs);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(utcMs / 86_400_000);
}

export function isValidIsoCalendarDate(value: string): boolean {
  return parseIsoDateToUtcEpochDay(value) !== null;
}

export function parseAttendanceReportQuery(
  url: URL,
):
  | { ok: true; value: ParsedAttendanceReportQuery }
  | { ok: false; code: AttendanceReportErrorCode } {
  const allowedKeys = new Set(["from_date", "to_date", "page", "page_size", "search"]);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key)) {
      return { ok: false, code: "ATTENDANCE_REPORT_QUERY_INVALID" };
    }
  }
  for (const key of allowedKeys) {
    if (url.searchParams.getAll(key).length > 1) {
      return { ok: false, code: "ATTENDANCE_REPORT_QUERY_INVALID" };
    }
  }

  const rawFrom = url.searchParams.get("from_date");
  const rawTo = url.searchParams.get("to_date");
  const fromDate = rawFrom !== null && rawFrom.trim() !== "" ? rawFrom.trim() : null;
  const toDate = rawTo !== null && rawTo.trim() !== "" ? rawTo.trim() : null;

  const fromDay = fromDate !== null ? parseIsoDateToUtcEpochDay(fromDate) : null;
  if (fromDate !== null && fromDay === null) {
    return { ok: false, code: "ATTENDANCE_REPORT_RANGE_INVALID" };
  }
  const toDay = toDate !== null ? parseIsoDateToUtcEpochDay(toDate) : null;
  if (toDate !== null && toDay === null) {
    return { ok: false, code: "ATTENDANCE_REPORT_RANGE_INVALID" };
  }
  if (fromDay !== null && toDay !== null) {
    if (fromDay > toDay || toDay - fromDay > ATTENDANCE_REPORT_MAX_RANGE_DAYS) {
      return { ok: false, code: "ATTENDANCE_REPORT_RANGE_INVALID" };
    }
  }

  const rawPage = url.searchParams.get("page") ?? "1";
  const rawPageSize =
    url.searchParams.get("page_size") ?? String(ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE);
  if (!/^\d{1,6}$/.test(rawPage) || !/^\d{1,6}$/.test(rawPageSize)) {
    return { ok: false, code: "ATTENDANCE_REPORT_PAGINATION_INVALID" };
  }
  const page = Number(rawPage);
  const pageSize = Number(rawPageSize);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > ATTENDANCE_REPORT_MAX_PAGE ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > ATTENDANCE_REPORT_MAX_PAGE_SIZE
  ) {
    return { ok: false, code: "ATTENDANCE_REPORT_PAGINATION_INVALID" };
  }

  const rawSearch = url.searchParams.get("search");
  let search: string | null = null;
  if (rawSearch !== null) {
    const trimmed = rawSearch.trim();
    if (
      trimmed.length > ATTENDANCE_REPORT_MAX_SEARCH_LENGTH ||
      CONTROL_CHAR_PATTERN.test(trimmed)
    ) {
      return { ok: false, code: "ATTENDANCE_REPORT_SEARCH_INVALID" };
    }
    search = trimmed.length > 0 ? trimmed : null;
  }

  return {
    ok: true,
    value: {
      from_date: fromDate,
      to_date: toDate,
      page,
      page_size: pageSize,
      search,
    },
  };
}

export function parseSetHqLocationBody(
  body: unknown,
  headerIdempotencyKey?: string | null,
):
  | { ok: true; value: ParsedSetHqLocationRequest }
  | { ok: false; code: AttendanceReportErrorCode } {
  if (!isRecord(body)) {
    return { ok: false, code: "ATTENDANCE_HQ_COORDINATES_INVALID" };
  }

  const keys = Object.keys(body);
  const allowedKeys = new Set(["latitude", "longitude", "expected_version", "idempotency_key"]);
  if (
    keys.some((key) => !allowedKeys.has(key)) ||
    !("latitude" in body) ||
    !("longitude" in body) ||
    !("expected_version" in body)
  ) {
    return { ok: false, code: "ATTENDANCE_HQ_COORDINATES_INVALID" };
  }

  const rawLat = body.latitude;
  const rawLon = body.longitude;
  if (
    !isFiniteNumber(rawLat) ||
    rawLat < -90 ||
    rawLat > 90 ||
    !isFiniteNumber(rawLon) ||
    rawLon < -180 ||
    rawLon > 180
  ) {
    return { ok: false, code: "ATTENDANCE_HQ_COORDINATES_INVALID" };
  }

  const rawExpectedVersion = body.expected_version;
  if (
    typeof rawExpectedVersion !== "number" ||
    !Number.isSafeInteger(rawExpectedVersion) ||
    rawExpectedVersion < 0
  ) {
    return { ok: false, code: "ATTENDANCE_HQ_COORDINATES_INVALID" };
  }

  const trimmedHeaderKey = headerIdempotencyKey?.trim() ?? "";
  const bodyKey =
    typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";

  const resolvedKey = bodyKey || trimmedHeaderKey;
  if (!isUuidString(resolvedKey)) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }
  if (
    trimmedHeaderKey !== "" &&
    (!isUuidString(trimmedHeaderKey) ||
      (bodyKey !== "" && trimmedHeaderKey.toLowerCase() !== bodyKey.toLowerCase()))
  ) {
    return { ok: false, code: "IDEMPOTENCY_KEY_INVALID" };
  }

  return {
    ok: true,
    value: {
      latitude: normalizeZero(rawLat),
      longitude: normalizeZero(rawLon),
      expected_version: rawExpectedVersion,
      idempotency_key: resolvedKey.toLowerCase(),
    },
  };
}

export function projectHqLocation(value: unknown): AttendanceHqLocationProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "latitude",
      "longitude",
      "effective_from",
      "effective_from_local",
      "configured_by_display_name",
    ])
  ) {
    return null;
  }

  if (
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !isFiniteNumber(value.latitude) ||
    value.latitude < -90 ||
    value.latitude > 90 ||
    !isFiniteNumber(value.longitude) ||
    value.longitude < -180 ||
    value.longitude > 180 ||
    typeof value.effective_from !== "string" ||
    value.effective_from.length === 0 ||
    typeof value.effective_from_local !== "string" ||
    value.effective_from_local.length === 0 ||
    typeof value.configured_by_display_name !== "string" ||
    value.configured_by_display_name.trim().length === 0
  ) {
    return null;
  }

  return {
    version: value.version,
    latitude: normalizeZero(value.latitude),
    longitude: normalizeZero(value.longitude),
    effective_from: value.effective_from,
    effective_from_local: value.effective_from_local,
    configured_by_display_name: value.configured_by_display_name,
  };
}

function projectOverview(value: unknown): AttendanceReportOverviewProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "total_checkins",
      "unique_employees",
      "verified_time_count",
      "unverified_time_count",
      "distance_computed_count",
      "distance_unavailable_count",
      "avg_distance_meters",
      "max_distance_meters",
    ])
  ) {
    return null;
  }

  const intKeys = [
    "total_checkins",
    "unique_employees",
    "verified_time_count",
    "unverified_time_count",
    "distance_computed_count",
    "distance_unavailable_count",
  ] as const;
  for (const key of intKeys) {
    const num = value[key];
    if (typeof num !== "number" || !Number.isSafeInteger(num) || num < 0) {
      return null;
    }
  }

  if (
    value.avg_distance_meters !== null &&
    (!isFiniteNumber(value.avg_distance_meters) || value.avg_distance_meters < 0)
  ) {
    return null;
  }
  if (
    value.max_distance_meters !== null &&
    (!isFiniteNumber(value.max_distance_meters) || value.max_distance_meters < 0)
  ) {
    return null;
  }

  return {
    total_checkins: value.total_checkins as number,
    unique_employees: value.unique_employees as number,
    verified_time_count: value.verified_time_count as number,
    unverified_time_count: value.unverified_time_count as number,
    distance_computed_count: value.distance_computed_count as number,
    distance_unavailable_count: value.distance_unavailable_count as number,
    avg_distance_meters:
      value.avg_distance_meters === null ? null : normalizeZero(value.avg_distance_meters),
    max_distance_meters:
      value.max_distance_meters === null ? null : normalizeZero(value.max_distance_meters),
  };
}

function projectPagination(value: unknown): AttendanceReportPaginationProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["page", "page_size", "total_rows", "total_pages", "has_more"])
  ) {
    return null;
  }
  if (
    typeof value.page !== "number" ||
    !Number.isSafeInteger(value.page) ||
    value.page < 1 ||
    typeof value.page_size !== "number" ||
    !Number.isSafeInteger(value.page_size) ||
    value.page_size < 1 ||
    typeof value.total_rows !== "number" ||
    !Number.isSafeInteger(value.total_rows) ||
    value.total_rows < 0 ||
    typeof value.total_pages !== "number" ||
    !Number.isSafeInteger(value.total_pages) ||
    value.total_pages < 1 ||
    typeof value.has_more !== "boolean"
  ) {
    return null;
  }
  return {
    page: value.page,
    page_size: value.page_size,
    total_rows: value.total_rows,
    total_pages: value.total_pages,
    has_more: value.has_more,
  };
}

function projectReportItem(value: unknown): AttendanceReportItemProjection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "checkin_id",
      "employee_display_name",
      "personnel_code",
      "business_date",
      "sequence_in_day",
      "captured_at",
      "captured_at_local",
      "received_at",
      "time_source",
      "time_verified",
      "sync_delay_seconds",
      "latitude",
      "longitude",
      "accuracy_meters",
      "address_hint",
      "note",
      "distance_meters",
      "distance_status",
      "hq_version_used",
    ])
  ) {
    return null;
  }

  if (
    !isUuidString(value.checkin_id) ||
    typeof value.employee_display_name !== "string" ||
    value.employee_display_name.trim().length === 0 ||
    (value.personnel_code !== null && typeof value.personnel_code !== "string") ||
    typeof value.business_date !== "string" ||
    !isValidIsoCalendarDate(value.business_date) ||
    typeof value.sequence_in_day !== "number" ||
    !Number.isSafeInteger(value.sequence_in_day) ||
    value.sequence_in_day < 1 ||
    typeof value.captured_at !== "string" ||
    value.captured_at.length === 0 ||
    typeof value.captured_at_local !== "string" ||
    value.captured_at_local.length === 0 ||
    typeof value.received_at !== "string" ||
    value.received_at.length === 0 ||
    (value.time_source !== "SERVER_ANCHORED" &&
      value.time_source !== "DEVICE_CLOCK_UNVERIFIED") ||
    typeof value.time_verified !== "boolean" ||
    typeof value.sync_delay_seconds !== "number" ||
    !Number.isSafeInteger(value.sync_delay_seconds) ||
    value.sync_delay_seconds < 0 ||
    typeof value.address_hint !== "string" ||
    typeof value.note !== "string"
  ) {
    return null;
  }

  if (
    value.latitude !== null &&
    (!isFiniteNumber(value.latitude) || value.latitude < -90 || value.latitude > 90)
  ) {
    return null;
  }
  if (
    value.longitude !== null &&
    (!isFiniteNumber(value.longitude) || value.longitude < -180 || value.longitude > 180)
  ) {
    return null;
  }
  if (
    value.accuracy_meters !== null &&
    (!isFiniteNumber(value.accuracy_meters) ||
      value.accuracy_meters < 0 ||
      value.accuracy_meters > 100_000)
  ) {
    return null;
  }

  const distanceStatus = value.distance_status;
  if (
    distanceStatus !== "COMPUTED" &&
    distanceStatus !== "HQ_NOT_CONFIGURED" &&
    distanceStatus !== "INVALID_GPS"
  ) {
    return null;
  }

  if (distanceStatus === "COMPUTED") {
    if (
      !isFiniteNumber(value.distance_meters) ||
      value.distance_meters < 0 ||
      typeof value.hq_version_used !== "number" ||
      !Number.isSafeInteger(value.hq_version_used) ||
      value.hq_version_used < 1
    ) {
      return null;
    }
  } else if (value.distance_meters !== null || value.hq_version_used !== null) {
    return null;
  }

  return {
    checkin_id: value.checkin_id,
    employee_display_name: value.employee_display_name,
    personnel_code: value.personnel_code,
    business_date: value.business_date,
    sequence_in_day: value.sequence_in_day,
    captured_at: value.captured_at,
    captured_at_local: value.captured_at_local,
    received_at: value.received_at,
    time_source: value.time_source,
    time_verified: value.time_verified,
    sync_delay_seconds: value.sync_delay_seconds,
    latitude: value.latitude === null ? null : normalizeZero(value.latitude),
    longitude: value.longitude === null ? null : normalizeZero(value.longitude),
    accuracy_meters:
      value.accuracy_meters === null ? null : normalizeZero(value.accuracy_meters),
    address_hint: value.address_hint,
    note: value.note,
    distance_meters:
      value.distance_meters === null
        ? null
        : normalizeZero(value.distance_meters as number),
    distance_status: distanceStatus,
    hq_version_used: value.hq_version_used as number | null,
  };
}

export function projectAttendanceAdminReport(
  raw: unknown,
): AttendanceAdminReportProjection | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "viewer",
      "filters",
      "current_hq",
      "overview",
      "pagination",
      "items",
    ])
  ) {
    return null;
  }

  if (
    !isRecord(raw.viewer) ||
    !hasExactKeys(raw.viewer, ["can_configure_hq"]) ||
    typeof raw.viewer.can_configure_hq !== "boolean"
  ) {
    return null;
  }

  if (
    !isRecord(raw.filters) ||
    !hasExactKeys(raw.filters, ["from_date", "to_date", "search", "timezone"]) ||
    typeof raw.filters.from_date !== "string" ||
    !isValidIsoCalendarDate(raw.filters.from_date) ||
    typeof raw.filters.to_date !== "string" ||
    !isValidIsoCalendarDate(raw.filters.to_date) ||
    (raw.filters.search !== null && typeof raw.filters.search !== "string") ||
    raw.filters.timezone !== ATTENDANCE_BUSINESS_TIMEZONE
  ) {
    return null;
  }

  const currentHq = raw.current_hq === null ? null : projectHqLocation(raw.current_hq);
  if (raw.current_hq !== null && currentHq === null) {
    return null;
  }

  const overview = projectOverview(raw.overview);
  const pagination = projectPagination(raw.pagination);
  if (!overview || !pagination || !Array.isArray(raw.items)) {
    return null;
  }

  const items: AttendanceReportItemProjection[] = [];
  for (const entry of raw.items) {
    const projected = projectReportItem(entry);
    if (!projected) return null;
    items.push(projected);
  }

  return {
    viewer: { can_configure_hq: raw.viewer.can_configure_hq },
    filters: {
      from_date: raw.filters.from_date,
      to_date: raw.filters.to_date,
      search: raw.filters.search,
      timezone: ATTENDANCE_BUSINESS_TIMEZONE,
    },
    current_hq: currentHq,
    overview,
    pagination,
    items,
  };
}

export function projectSetHqLocationResult(
  raw: unknown,
): SetAttendanceHqLocationProjection | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ["replayed", "hq"])) {
    return null;
  }
  if (typeof raw.replayed !== "boolean") {
    return null;
  }
  const hq = projectHqLocation(raw.hq);
  if (!hq) {
    return null;
  }
  return {
    replayed: raw.replayed,
    hq,
  };
}

export function getVietnamTodayIsoDate(now: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export function shiftIsoDateDays(isoDate: string, deltaDays: number): string {
  const match = ISO_DATE_PATTERN.exec(isoDate);
  if (!match) return isoDate;
  const utc = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + deltaDays),
  );
  const year = String(utc.getUTCFullYear()).padStart(4, "0");
  const month = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utc.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function firstDayOfIsoMonth(isoDate: string): string {
  const match = ISO_DATE_PATTERN.exec(isoDate);
  if (!match) return isoDate;
  return `${match[1]}-${match[2]}-01`;
}

const VI_DECIMAL_ONE = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const VI_DECIMAL_TWO = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatDistanceMeters(distanceMeters: number | null): string {
  if (distanceMeters === null || !Number.isFinite(distanceMeters)) {
    return "Không tính được";
  }
  if (distanceMeters >= 1000) {
    return `${VI_DECIMAL_TWO.format(distanceMeters / 1000)} km (${VI_DECIMAL_ONE.format(distanceMeters)} m)`;
  }
  return `${VI_DECIMAL_ONE.format(distanceMeters)} m`;
}

export function formatCoordinatePair(
  latitude: number | null,
  longitude: number | null,
): string {
  if (
    latitude === null ||
    longitude === null ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return "Tọa độ GPS thiếu hoặc không hợp lệ";
  }
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

export function newAttendanceHqIntentKey(): string {
  return globalThis.crypto.randomUUID();
}
