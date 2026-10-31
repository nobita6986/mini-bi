const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURSOR = /^(\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const ACTION_GROUPS = ["NEW_ENTRY", "DUPLICATE_WITHDRAWN", "PROFILE_EDIT", "STATUS_CHANGE", "DOCUMENT_CHANGE"] as const;

export type WorkerEditHistoryActionGroup = (typeof ACTION_GROUPS)[number];
export type WorkerEditHistorySearchQuery = {
  from_date: string;
  to_date: string;
  action_group: WorkerEditHistoryActionGroup | null;
  project_id: string | null;
  recruiter_id: string | null;
  page_size: number;
  cursor: string | null;
};

export type WorkerEditHistoryRow = {
  revision_id: string;
  entry_id: string;
  version: number;
  employee_code: string;
  display_name: string;
  national_id: string | null;
  project_id: string;
  project_name: string;
  recruiter_id: string;
  recruiter_name: string;
  actor_user_id: string | null;
  actor_display_name: string;
  reason_text: string | null;
  created_at: string;
  action_group: WorkerEditHistoryActionGroup;
  changed_fields: string[];
  audit_actions: string[];
  snapshot_state: "COMPLETE" | "LEGACY_LIMITED";
};

export type WorkerEditHistorySearch = {
  rows: WorkerEditHistoryRow[];
  has_more: boolean;
  next_cursor: string | null;
};

export type WorkerEditHistoryRevision = {
  revision_id: string;
  entry_id: string;
  version: number;
  created_at: string;
  actor_user_id: string | null;
  reason_text: string | null;
  snapshot_state: "COMPLETE" | "LEGACY_LIMITED";
  before_snapshot: Record<string, unknown> | null;
  after_snapshot: Record<string, unknown>;
  current_snapshot: Record<string, unknown>;
  audit_events: Record<string, unknown>[];
  employment_status_events: Record<string, unknown>[];
  document_events: Record<string, unknown>[];
};

export type WorkerEditHistoryError =
  | "UNAUTHENTICATED"
  | "ACTOR_NOT_AVAILABLE"
  | "WORKER_EDIT_HISTORY_ACCESS_DENIED"
  | "WORKER_EDIT_HISTORY_QUERY_INVALID"
  | "WORKER_EDIT_HISTORY_NOT_FOUND"
  | "WORKER_EDIT_HISTORY_UNAVAILABLE";

export function isWorkerEditHistoryUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isCalendarDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function calendarDay(value: string): number {
  const match = DATE.exec(value)!;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000;
}

function singleton(search: URLSearchParams, key: string): string | null | undefined {
  const values = search.getAll(key);
  if (values.length > 1) return undefined;
  return values.length ? values[0] : null;
}

export function parseWorkerEditHistorySearchQuery(url: URL):
  | { ok: true; value: WorkerEditHistorySearchQuery }
  | { ok: false; code: "WORKER_EDIT_HISTORY_QUERY_INVALID" } {
  const keys = new Set(["from_date", "to_date", "action_group", "project_id", "recruiter_id", "page_size", "cursor"]);
  if ([...url.searchParams.keys()].some((key) => !keys.has(key))) {
    return { ok: false, code: "WORKER_EDIT_HISTORY_QUERY_INVALID" };
  }
  const values = Object.fromEntries([...keys].map((key) => [key, singleton(url.searchParams, key)]));
  if (Object.values(values).some((value) => value === undefined)) {
    return { ok: false, code: "WORKER_EDIT_HISTORY_QUERY_INVALID" };
  }
  const fromDate = typeof values.from_date === "string" && values.from_date !== "" ? values.from_date : null;
  const toDate = typeof values.to_date === "string" && values.to_date !== "" ? values.to_date : null;
  const rawAction = typeof values.action_group === "string" && values.action_group !== "" ? values.action_group : null;
  const projectId = typeof values.project_id === "string" ? values.project_id.trim() : "";
  const recruiterId = typeof values.recruiter_id === "string" ? values.recruiter_id.trim() : "";
  const rawPageSize = typeof values.page_size === "string" ? values.page_size : "50";
  const pageSize = /^\d+$/.test(rawPageSize) ? Number(rawPageSize) : NaN;
  const cursor = typeof values.cursor === "string" && values.cursor !== "" ? values.cursor : null;
  const cursorMatch = cursor?.match(CURSOR);
  const cursorTimeValid = cursorMatch !== undefined && cursorMatch !== null &&
    isCalendarDate(cursorMatch[1].slice(0, 10)) &&
    Number(cursorMatch[2]) < 24 && Number(cursorMatch[3]) < 60 && Number(cursorMatch[4]) < 60;

  if (fromDate === null || toDate === null ||
      (fromDate !== null && (!isCalendarDate(fromDate) || !isCalendarDate(toDate!) ||
        calendarDay(toDate!) < calendarDay(fromDate) || calendarDay(toDate!) - calendarDay(fromDate) > 92)) ||
      (rawAction !== null && !(ACTION_GROUPS as readonly string[]).includes(rawAction)) ||
      (projectId !== "" && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId)) ||
      (recruiterId !== "" && !UUID.test(recruiterId)) ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      (cursor !== null && (cursor.length > 160 || !cursorTimeValid))) {
    return { ok: false, code: "WORKER_EDIT_HISTORY_QUERY_INVALID" };
  }

  return {
    ok: true,
    value: {
      from_date: fromDate!,
      to_date: toDate!,
      action_group: rawAction as WorkerEditHistoryActionGroup | null,
      project_id: projectId || null,
      recruiter_id: recruiterId || null,
      page_size: pageSize,
      cursor,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNoStorageKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasNoStorageKeys);
  if (!isRecord(value)) return value === null || ["string", "number", "boolean"].includes(typeof value);
  return Object.entries(value).every(([key, nested]) =>
    !["storage_key", "object_key", "storage_path", "object_path", "r2_key", "r2_path", "signed_url", "presigned_url"].includes(key.toLowerCase()) &&
    hasNoStorageKeys(nested));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function projectRow(value: unknown): WorkerEditHistoryRow | null {
  if (!isRecord(value) || !isWorkerEditHistoryUuid(value.revision_id) || !isWorkerEditHistoryUuid(value.entry_id) ||
      !Number.isSafeInteger(value.version) || (value.version as number) < 1 ||
      typeof value.employee_code !== "string" || typeof value.display_name !== "string" ||
      (value.national_id !== null && typeof value.national_id !== "string") ||
      typeof value.project_id !== "string" || value.project_id.trim() === "" || typeof value.project_name !== "string" ||
      !isWorkerEditHistoryUuid(value.recruiter_id) || typeof value.recruiter_name !== "string" ||
      (value.actor_user_id !== null && !isWorkerEditHistoryUuid(value.actor_user_id)) ||
      typeof value.actor_display_name !== "string" || (value.reason_text !== null && typeof value.reason_text !== "string") ||
      typeof value.created_at !== "string" || !(ACTION_GROUPS as readonly unknown[]).includes(value.action_group) ||
      !stringArray(value.changed_fields) || !stringArray(value.audit_actions) ||
      (value.snapshot_state !== "COMPLETE" && value.snapshot_state !== "LEGACY_LIMITED")) return null;
  return value as unknown as WorkerEditHistoryRow;
}

export function projectWorkerEditHistorySearch(value: unknown): WorkerEditHistorySearch | null {
  if (!isRecord(value) || !Array.isArray(value.rows) || typeof value.has_more !== "boolean" ||
      (value.next_cursor !== null && typeof value.next_cursor !== "string")) return null;
  if (value.next_cursor !== null && !CURSOR.test(value.next_cursor)) return null;
  const rows = value.rows.map(projectRow);
  if (rows.some((row) => row === null) || (value.has_more && !value.next_cursor) || (!value.has_more && value.next_cursor !== null)) return null;
  return { rows: rows as WorkerEditHistoryRow[], has_more: value.has_more, next_cursor: value.next_cursor as string | null };
}

export function projectWorkerEditHistoryRevision(value: unknown): WorkerEditHistoryRevision | null {
  if (!isRecord(value) || !isWorkerEditHistoryUuid(value.revision_id) || !isWorkerEditHistoryUuid(value.entry_id) ||
      !Number.isSafeInteger(value.version) || typeof value.created_at !== "string" ||
      (value.actor_user_id !== null && !isWorkerEditHistoryUuid(value.actor_user_id)) ||
      (value.reason_text !== null && typeof value.reason_text !== "string") ||
      (value.snapshot_state !== "COMPLETE" && value.snapshot_state !== "LEGACY_LIMITED") ||
      (value.before_snapshot !== null && !isRecord(value.before_snapshot)) || !isRecord(value.after_snapshot) ||
      !isRecord(value.current_snapshot) ||
      !Array.isArray(value.audit_events) || !value.audit_events.every(isRecord) ||
      !Array.isArray(value.employment_status_events) || !value.employment_status_events.every(isRecord) ||
      !Array.isArray(value.document_events) || !value.document_events.every(isRecord) || !hasNoStorageKeys(value)) return null;
  return value as unknown as WorkerEditHistoryRevision;
}

export function workerEditHistoryHttpStatus(code: WorkerEditHistoryError): number {
  if (code === "UNAUTHENTICATED") return 401;
  if (code === "ACTOR_NOT_AVAILABLE" || code === "WORKER_EDIT_HISTORY_ACCESS_DENIED") return 403;
  if (code === "WORKER_EDIT_HISTORY_QUERY_INVALID") return 400;
  if (code === "WORKER_EDIT_HISTORY_NOT_FOUND") return 404;
  return 503;
}
