/**
 * P1.6-W04-S04C-S02C - Hop dong doc/list own submission.
 *
 * Pure validator + projection: khong I/O, khong doc session, khong goi DB.
 * Authority (mapping actor, capability submission_create, own scope, owner) do RPC
 * public.direct_entry_list_own_submissions / direct_entry_read_own_submission quyet dinh.
 *
 * Fail-closed: dung key, dung kieu, khong fallback [], 0, false; khong type assertion.
 * allowed_transitions chi la display hint server-derived; mutation RPC van la authority cuoi.
 */
import {
  SUBMISSION_TRANSITIONS,
  isSubmissionState,
  type SubmissionState,
} from "./submission-transition-contract.ts";

export const LIST_DEFAULT_PAGE_SIZE = 20;
export const LIST_MAX_PAGE_SIZE = 50;
export const LIST_MAX_ENTRIES = 500;
export const LIST_QUERY_KEYS = ["page_size", "cursor", "state"] as const;

export const LIST_PAGE_KEYS = ["items", "page_size", "has_more", "next_cursor"] as const;
export const LIST_ITEM_KEYS = [
  "submission_id", "state", "version", "entry_count",
  "created_at", "updated_at", "submitted_at", "allowed_transitions", "project_scoped",
] as const;
export const DETAIL_KEYS = [...LIST_ITEM_KEYS, "entry_ids"] as const;

/** Cursor opaque do DB sinh: <yyyyMMddHH24MISSUS UTC>:<submission_id>. */
const CURSOR = /^[0-9]{20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_UTC_MICROS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE_TEXT = /^[1-9][0-9]{0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

function isPositiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isEntryCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= LIST_MAX_ENTRIES;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC_MICROS.test(value) && !Number.isNaN(Date.parse(value));
}

function matchesTransitionMatrix(state: SubmissionState, value: unknown): value is SubmissionState[] {
  const expected = SUBMISSION_TRANSITIONS[state];
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  return value.every((entry, index) => entry === expected[index]);
}

export type SubmissionReadQuery = {
  page_size: number;
  cursor: string | null;
  state: SubmissionState | null;
};

export type SubmissionReadProjection<T> =
  | { ok: true; value: T }
  | { ok: false; code: "SUBMISSION_QUERY_INVALID" };

const QUERY_INVALID = { ok: false, code: "SUBMISSION_QUERY_INVALID" } as const;

/**
 * Query list: chi nhan dung page_size | cursor | state. Tham so khac (order, column, offset,
 * limit, sql...) bi tu choi de client khong dieu khien duoc SQL/sort.
 */
export function projectSubmissionListQuery(
  searchParams: URLSearchParams,
): SubmissionReadProjection<SubmissionReadQuery> {
  if ([...searchParams.keys()].length !== new Set(searchParams.keys()).size) return QUERY_INVALID;
  for (const key of searchParams.keys()) {
    if (!(LIST_QUERY_KEYS as readonly string[]).includes(key)) return QUERY_INVALID;
  }

  const rawPageSize = searchParams.get("page_size");
  let pageSize = LIST_DEFAULT_PAGE_SIZE;
  if (rawPageSize !== null) {
    if (!PAGE_SIZE_TEXT.test(rawPageSize)) return QUERY_INVALID;
    pageSize = Number(rawPageSize);
    if (pageSize < 1 || pageSize > LIST_MAX_PAGE_SIZE) return QUERY_INVALID;
  }

  const rawCursor = searchParams.get("cursor");
  if (rawCursor !== null && !CURSOR.test(rawCursor)) return QUERY_INVALID;

  const rawState = searchParams.get("state");
  if (rawState !== null && !isSubmissionState(rawState)) return QUERY_INVALID;

  return {
    ok: true,
    value: {
      page_size: pageSize,
      cursor: rawCursor,
      state: rawState as SubmissionState | null,
    },
  };
}

export type SubmissionReadItem = {
  submission_id: string;
  state: SubmissionState;
  version: number;
  entry_count: number;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  allowed_transitions: SubmissionState[];
  /** True when the server exposed only entries in the actor's current project assignments. */
  project_scoped: boolean;
};

export type SubmissionReadListPage = {
  items: SubmissionReadItem[];
  page_size: number;
  has_more: boolean;
  next_cursor: string | null;
};

export type SubmissionReadDetail = SubmissionReadItem & { entry_ids: string[] };

function projectItem(value: unknown, keys: readonly string[]): SubmissionReadItem | null {
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  if (typeof value.submission_id !== "string" || !UUID.test(value.submission_id)) return null;
  if (!isSubmissionState(value.state)) return null;
  if (!isPositiveVersion(value.version)) return null;
  if (!isEntryCount(value.entry_count)) return null;
  if (!isCanonicalTimestamp(value.created_at)) return null;
  if (!isCanonicalTimestamp(value.updated_at)) return null;
  if (value.state === "SUBMITTED") {
    if (!isCanonicalTimestamp(value.submitted_at)) return null;
  } else if (value.submitted_at !== null) {
    return null;
  }
  if (!matchesTransitionMatrix(value.state, value.allowed_transitions)) return null;
  if (typeof value.project_scoped !== "boolean") return null;
  return {
    submission_id: value.submission_id,
    state: value.state,
    version: value.version,
    entry_count: value.entry_count,
    created_at: value.created_at,
    updated_at: value.updated_at,
    submitted_at: value.submitted_at,
    allowed_transitions: [...value.allowed_transitions],
    project_scoped: value.project_scoped,
  };
}

export function projectSubmissionListPage(
  value: unknown,
  expected: { page_size: number },
): SubmissionReadListPage | null {
  if (!isRecord(value) || !hasExactKeys(value, LIST_PAGE_KEYS)) return null;
  if (!Array.isArray(value.items) || value.items.length > expected.page_size) return null;
  if (typeof value.page_size !== "number" || value.page_size !== expected.page_size) return null;
  if (typeof value.has_more !== "boolean") return null;
  const items: SubmissionReadItem[] = [];
  for (const raw of value.items) {
    const item = projectItem(raw, LIST_ITEM_KEYS);
    if (!item) return null;
    items.push(item);
  }
  const cursor = value.next_cursor;
  if (value.has_more) {
    if (typeof cursor !== "string" || !CURSOR.test(cursor)) return null;
  } else if (cursor !== null) {
    return null;
  }
  return {
    items,
    page_size: value.page_size,
    has_more: value.has_more,
    next_cursor: value.has_more ? (cursor as string) : null,
  };
}

export function projectSubmissionDetail(
  value: unknown,
  expected: { submission_id: string },
): SubmissionReadDetail | null {
  const item = projectItem(value, DETAIL_KEYS);
  if (!item || !isRecord(value)) return null;
  if (item.submission_id !== expected.submission_id) return null;
  const rawEntryIds = value.entry_ids;
  if (!Array.isArray(rawEntryIds) || rawEntryIds.length > LIST_MAX_ENTRIES) return null;
  const entryIds: string[] = [];
  const seen = new Set<string>();
  for (const entryId of rawEntryIds) {
    if (typeof entryId !== "string" || !UUID.test(entryId)) return null;
    if (seen.has(entryId)) return null;
    seen.add(entryId);
    entryIds.push(entryId);
  }
  if (entryIds.length !== item.entry_count) return null;
  return { ...item, entry_ids: entryIds };
}
