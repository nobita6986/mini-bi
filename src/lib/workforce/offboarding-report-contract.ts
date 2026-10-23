export const OFFBOARDING_HIDE_REASON_MAX_LENGTH = 500;

export type OffboardingReportItem = {
  employee_code: string;
  display_name: string;
  project_id: string;
  project_display: string;
  recruiter_id: string;
  recruiter_display: string;
  off_effective_date: string;
  days_since_off: number;
  /** Only present for the all-scope audiences (Full Admin / BoD); null when worker phone is omitted/unknown. */
  phone?: string | null;
  /** Only present on list items when `can_hide === true`. */
  snapshot_entry_id?: string;
  /** Only present on list items when `can_hide === true`. */
  snapshot_status_event_id?: string;
};

export type OffboardingReportList = {
  scope: "all" | "team";
  authority: string;
  can_export: boolean;
  can_hide: boolean;
  authorization_date: string;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  items: OffboardingReportItem[];
};

export type OffboardingReportExport = {
  authorization_date: string;
  items: OffboardingReportItem[];
};

export type OffboardingHideRequest = {
  snapshot_entry_id: string;
  snapshot_status_event_id: string;
  reason: string;
  idempotency_key: string;
};

export type OffboardingHideResult = {
  suppression_id: string;
  snapshot_entry_id: string;
  snapshot_status_event_id: string;
  hidden_at: string;
  replayed: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const REASON_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const ALLOWED_BASE_ITEM_KEYS = new Set([
  "employee_code",
  "display_name",
  "project_id",
  "project_display",
  "recruiter_id",
  "recruiter_display",
  "off_effective_date",
  "days_since_off",
  "phone",
]);

const ALLOWED_LIST_ITEM_KEYS = new Set([
  ...ALLOWED_BASE_ITEM_KEYS,
  "snapshot_entry_id",
  "snapshot_status_event_id",
]);

const ALLOWED_LIST_KEYS = new Set([
  "scope",
  "authority",
  "can_export",
  "can_hide",
  "authorization_date",
  "page",
  "page_size",
  "total",
  "has_more",
  "items",
]);

const ALLOWED_EXPORT_KEYS = new Set(["authorization_date", "items"]);

const ALLOWED_HIDE_REQUEST_KEYS = new Set([
  "snapshot_entry_id",
  "snapshot_status_event_id",
  "reason",
  "idempotency_key",
]);

const ALLOWED_HIDE_RESULT_KEYS = new Set([
  "suppression_id",
  "snapshot_entry_id",
  "snapshot_status_event_id",
  "hidden_at",
  "replayed",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function hasOnlyAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function projectItem(
  value: unknown,
  options: { allowSnapshotRefs: boolean; requireSnapshotRefs: boolean; forbidPhone: boolean },
): OffboardingReportItem | null {
  if (!isRecord(value)) return null;
  const allowedKeys = options.allowSnapshotRefs ? ALLOWED_LIST_ITEM_KEYS : ALLOWED_BASE_ITEM_KEYS;
  if (!hasOnlyAllowedKeys(value, allowedKeys)) return null;

  if (
    typeof value.employee_code !== "string" ||
    value.employee_code.trim().length === 0 ||
    typeof value.display_name !== "string" ||
    value.display_name.trim().length === 0 ||
    typeof value.project_id !== "string" ||
    value.project_id.length === 0 ||
    typeof value.project_display !== "string" ||
    typeof value.recruiter_id !== "string" ||
    !UUID.test(value.recruiter_id) ||
    typeof value.recruiter_display !== "string" ||
    typeof value.off_effective_date !== "string" ||
    !DATE.test(value.off_effective_date) ||
    !Number.isInteger(value.days_since_off) ||
    Number(value.days_since_off) < 3 ||
    (value.phone !== undefined && value.phone !== null && typeof value.phone !== "string")
  ) {
    return null;
  }

  if (options.forbidPhone && value.phone !== undefined) {
    return null;
  }

  const hasEntryRef = value.snapshot_entry_id !== undefined;
  const hasEventRef = value.snapshot_status_event_id !== undefined;
  if (hasEntryRef !== hasEventRef) {
    return null;
  }

  if (options.requireSnapshotRefs && !hasEntryRef) {
    return null;
  }

  if (hasEntryRef) {
    if (
      typeof value.snapshot_entry_id !== "string" ||
      !UUID.test(value.snapshot_entry_id) ||
      typeof value.snapshot_status_event_id !== "string" ||
      !UUID.test(value.snapshot_status_event_id)
    ) {
      return null;
    }
  }

  const projected: OffboardingReportItem = {
    employee_code: value.employee_code,
    display_name: value.display_name,
    project_id: value.project_id,
    project_display: value.project_display,
    recruiter_id: value.recruiter_id,
    recruiter_display: value.recruiter_display,
    off_effective_date: value.off_effective_date,
    days_since_off: value.days_since_off as number,
  };

  if ("phone" in value && value.phone !== undefined) {
    projected.phone = value.phone;
  }
  if (hasEntryRef) {
    projected.snapshot_entry_id = (value.snapshot_entry_id as string).toLowerCase();
    projected.snapshot_status_event_id = (value.snapshot_status_event_id as string).toLowerCase();
  }

  return projected;
}

export function parseOffboardingReportList(body: unknown): OffboardingReportList | null {
  if (!isRecord(body) || !hasOnlyAllowedKeys(body, ALLOWED_LIST_KEYS)) return null;
  const d = body;
  if (
    (d.scope !== "all" && d.scope !== "team") ||
    typeof d.authority !== "string" ||
    d.authority.trim().length === 0 ||
    typeof d.can_export !== "boolean" ||
    (d.can_hide !== undefined && typeof d.can_hide !== "boolean") ||
    typeof d.authorization_date !== "string" ||
    !DATE.test(d.authorization_date) ||
    !Array.isArray(d.items) ||
    !Number.isInteger(d.page) ||
    Number(d.page) < 1 ||
    !Number.isInteger(d.page_size) ||
    Number(d.page_size) < 1 ||
    !Number.isInteger(d.total) ||
    Number(d.total) < 0 ||
    typeof d.has_more !== "boolean"
  ) {
    return null;
  }

  const canHide = d.can_hide === true;
  if (d.scope === "team" && (d.can_export || canHide)) {
    return null;
  }

  const items: OffboardingReportItem[] = [];
  for (const rawItem of d.items) {
    const item = projectItem(rawItem, {
      allowSnapshotRefs: canHide,
      requireSnapshotRefs: canHide,
      forbidPhone: d.scope === "team",
    });
    if (!item) return null;
    items.push(item);
  }

  return {
    scope: d.scope,
    authority: d.authority,
    can_export: d.can_export,
    can_hide: canHide,
    authorization_date: d.authorization_date,
    page: d.page as number,
    page_size: d.page_size as number,
    total: d.total as number,
    has_more: d.has_more,
    items,
  };
}

export function parseOffboardingReportExport(body: unknown): OffboardingReportExport | null {
  if (!isRecord(body) || !hasOnlyAllowedKeys(body, ALLOWED_EXPORT_KEYS)) return null;
  const d = body;
  if (
    typeof d.authorization_date !== "string" ||
    !DATE.test(d.authorization_date) ||
    !Array.isArray(d.items)
  ) {
    return null;
  }

  const items: OffboardingReportItem[] = [];
  for (const rawItem of d.items) {
    const item = projectItem(rawItem, {
      allowSnapshotRefs: false,
      requireSnapshotRefs: false,
      forbidPhone: false,
    });
    if (!item) return null;
    items.push(item);
  }

  return {
    authorization_date: d.authorization_date,
    items,
  };
}

export function parseOffboardingHideRequest(
  body: unknown,
  headerIdempotencyKey?: string | null,
): OffboardingHideRequest | null {
  if (!isRecord(body) || !hasOnlyAllowedKeys(body, ALLOWED_HIDE_REQUEST_KEYS)) {
    return null;
  }

  if (
    typeof body.snapshot_entry_id !== "string" ||
    !UUID.test(body.snapshot_entry_id.trim()) ||
    typeof body.snapshot_status_event_id !== "string" ||
    !UUID.test(body.snapshot_status_event_id.trim()) ||
    typeof body.reason !== "string"
  ) {
    return null;
  }

  const reason = body.reason.trim();
  if (
    reason.length < 1 ||
    reason.length > OFFBOARDING_HIDE_REASON_MAX_LENGTH ||
    REASON_CONTROL_CHARS.test(reason)
  ) {
    return null;
  }

  const bodyKey =
    typeof body.idempotency_key === "string"
      ? body.idempotency_key.trim()
      : body.idempotency_key === undefined
        ? ""
        : null;
  if (bodyKey === null) {
    return null;
  }

  const headerKey = headerIdempotencyKey?.trim() ?? "";
  if (bodyKey !== "" && headerKey !== "" && bodyKey !== headerKey) {
    return null;
  }

  const resolvedKey = bodyKey || headerKey;
  if (!IDEMPOTENCY_KEY.test(resolvedKey)) {
    return null;
  }

  return {
    snapshot_entry_id: body.snapshot_entry_id.trim().toLowerCase(),
    snapshot_status_event_id: body.snapshot_status_event_id.trim().toLowerCase(),
    reason,
    idempotency_key: resolvedKey,
  };
}

export function parseOffboardingHideResult(body: unknown): OffboardingHideResult | null {
  if (
    !isRecord(body) ||
    !hasOnlyAllowedKeys(body, ALLOWED_HIDE_RESULT_KEYS) ||
    Object.keys(body).length !== ALLOWED_HIDE_RESULT_KEYS.size
  ) {
    return null;
  }

  if (
    typeof body.suppression_id !== "string" ||
    !UUID.test(body.suppression_id) ||
    typeof body.snapshot_entry_id !== "string" ||
    !UUID.test(body.snapshot_entry_id) ||
    typeof body.snapshot_status_event_id !== "string" ||
    !UUID.test(body.snapshot_status_event_id) ||
    typeof body.hidden_at !== "string" ||
    body.hidden_at.trim().length === 0 ||
    typeof body.replayed !== "boolean"
  ) {
    return null;
  }

  return {
    suppression_id: body.suppression_id.toLowerCase(),
    snapshot_entry_id: body.snapshot_entry_id.toLowerCase(),
    snapshot_status_event_id: body.snapshot_status_event_id.toLowerCase(),
    hidden_at: body.hidden_at,
    replayed: body.replayed,
  };
}

export function newOffboardingHideIntentKey(): string {
  return globalThis.crypto.randomUUID();
}
