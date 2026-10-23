import type { WorkReportField, WorkReportTemplateSchema } from "./contracts.ts";
import { validateWorkReportSchema } from "./schema-validator.ts";

export const WORK_REPORT_READABLE_STATE_LABELS: Readonly<Record<string, string>> = {
  COMPLETED: "Đã nộp",
  PENDING_REVIEW: "Chờ duyệt",
  APPROVED: "Đã duyệt",
  REJECTED: "Bị từ chối",
};

export const WORK_REPORT_READABLE_STATES = Object.keys(WORK_REPORT_READABLE_STATE_LABELS);

export type ReaderListFilters = {
  templateId: string;
  versionId: string;
  from: string;
  to: string;
  teamId: string;
  assigneeId: string;
  state: string;
};

export type ReaderTemplateVersion = {
  version_id: string;
  version_no: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
};

export type ReaderTemplateOption = {
  template_id: string;
  template_code: string;
  display_name: string;
  versions: readonly ReaderTemplateVersion[];
};

export type ReaderTeamOption = { team_id: string; code: string; display_name: string };
export type ReaderAssigneeOption = { app_user_id: string; display_name: string };

export type ReaderFilterOptions = {
  templates: readonly ReaderTemplateOption[];
  teams: readonly ReaderTeamOption[];
  assignees: readonly ReaderAssigneeOption[];
};

export type ReaderListItem = {
  obligation_id: string;
  submission_id: string;
  template_id: string;
  template_name: string;
  template_version_id: string;
  template_version_no: number;
  assignee_app_user_id: string;
  assignee_display_name: string;
  team_id: string | null;
  team_display_name: string | null;
  period_key: string;
  period_start_date: string;
  period_end_date: string;
  state: string;
  latest_submitted_at: string;
  is_late: boolean;
  has_post_deadline_amendment: boolean;
  current_revision_no: number;
};

export type ReaderListPayload = {
  effective_scope: { kind: "all" | "team"; label: string };
  filter_options: ReaderFilterOptions;
  items: readonly ReaderListItem[];
  next_cursor: string | null;
  has_more: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const isIsoTimestamp = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));

export function readerListQuery(filters: ReaderListFilters, cursor: string | null): string {
  const query = new URLSearchParams({ limit: "50" });
  if (filters.templateId) query.set("template_id", filters.templateId);
  if (filters.versionId) query.set("version_id", filters.versionId);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (filters.teamId) query.set("team_id", filters.teamId);
  if (filters.assigneeId) query.set("assignee_id", filters.assigneeId);
  if (filters.state) query.set("state", filters.state);
  if (cursor) query.set("cursor", cursor);
  return "?" + query.toString();
}

export function readerStateLabel(state: string): string {
  return WORK_REPORT_READABLE_STATE_LABELS[state] ?? state;
}

export function formatReaderDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

/**
 * Read-only rendering of one schema field value. Never echoes a raw option key when a
 * label exists, renders booleans as Có/Không, and renders missing values as "—".
 */
export function renderWorkReportFieldValue(field: WorkReportField, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field.field_type === "boolean") {
    if (value === true) return "Có";
    if (value === false) return "Không";
    return "—";
  }
  if (field.field_type === "single_select" || field.field_type === "multi_select") {
    const codes = Array.isArray(value) ? value : [value];
    return codes
      .map((code) => field.options?.find((option) => option.option_key === code)?.label ?? String(code))
      .join(", ");
  }
  if (field.field_type === "integer" || field.field_type === "decimal") {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
  }
  return Array.isArray(value) ? value.map(String).join(", ") : String(value);
}

function isValidTemplateVersion(value: unknown): value is ReaderTemplateVersion {
  return (
    isRecord(value) &&
    typeof value.version_id === "string" &&
    UUID.test(value.version_id) &&
    Number.isInteger(value.version_no) &&
    Number(value.version_no) >= 1 &&
    (value.status === "DRAFT" || value.status === "PUBLISHED" || value.status === "ARCHIVED")
  );
}

function isValidTemplate(value: unknown): value is ReaderTemplateOption {
  return (
    isRecord(value) &&
    typeof value.template_id === "string" &&
    UUID.test(value.template_id) &&
    isNonEmptyString(value.template_code) &&
    isNonEmptyString(value.display_name) &&
    Array.isArray(value.versions) &&
    value.versions.every(isValidTemplateVersion)
  );
}

function isValidTeam(value: unknown): value is ReaderTeamOption {
  return (
    isRecord(value) &&
    typeof value.team_id === "string" &&
    UUID.test(value.team_id) &&
    isNonEmptyString(value.code) &&
    isNonEmptyString(value.display_name)
  );
}

function isValidAssignee(value: unknown): value is ReaderAssigneeOption {
  return (
    isRecord(value) &&
    typeof value.app_user_id === "string" &&
    UUID.test(value.app_user_id) &&
    isNonEmptyString(value.display_name)
  );
}

function isValidItem(value: unknown): value is ReaderListItem {
  return (
    isRecord(value) &&
    typeof value.obligation_id === "string" &&
    UUID.test(value.obligation_id) &&
    typeof value.submission_id === "string" &&
    UUID.test(value.submission_id) &&
    typeof value.template_id === "string" &&
    UUID.test(value.template_id) &&
    isNonEmptyString(value.template_name) &&
    typeof value.template_version_id === "string" &&
    UUID.test(value.template_version_id) &&
    Number.isInteger(value.template_version_no) &&
    Number(value.template_version_no) >= 1 &&
    typeof value.assignee_app_user_id === "string" &&
    UUID.test(value.assignee_app_user_id) &&
    isNonEmptyString(value.assignee_display_name) &&
    (value.team_id === null || (typeof value.team_id === "string" && UUID.test(value.team_id))) &&
    (value.team_display_name === null || typeof value.team_display_name === "string") &&
    isNonEmptyString(value.period_key) &&
    isNonEmptyString(value.period_start_date) &&
    isNonEmptyString(value.period_end_date) &&
    isNonEmptyString(value.state) &&
    isIsoTimestamp(value.latest_submitted_at) &&
    typeof value.is_late === "boolean" &&
    typeof value.has_post_deadline_amendment === "boolean" &&
    Number.isInteger(value.current_revision_no) &&
    Number(value.current_revision_no) >= 1
  );
}

/**
 * The API repeats a few top-level keys (`effective_scope`, `filter_options`, `items`,
 * `next_cursor`, `has_more`) and also returns the full payload under `body.data`. This
 * reads ONLY `body.data` and fail-closes on a malformed envelope.
 */
export function parseReaderList(body: unknown): ReaderListPayload | null {
  if (!isRecord(body) || body.ok !== true) return null;
  const data = body.data;
  if (!isRecord(data)) return null;
  if (
    !isRecord(data.effective_scope) ||
    (data.effective_scope.kind !== "all" && data.effective_scope.kind !== "team") ||
    !isNonEmptyString(data.effective_scope.label) ||
    !isRecord(data.filter_options) ||
    !Array.isArray(data.filter_options.templates) ||
    !data.filter_options.templates.every(isValidTemplate) ||
    !Array.isArray(data.filter_options.teams) ||
    !data.filter_options.teams.every(isValidTeam) ||
    !Array.isArray(data.filter_options.assignees) ||
    !data.filter_options.assignees.every(isValidAssignee) ||
    !Array.isArray(data.items) ||
    !data.items.every(isValidItem) ||
    typeof data.has_more !== "boolean" ||
    !(data.has_more ? typeof data.next_cursor === "string" && data.next_cursor.length > 0 : data.next_cursor === null)
  ) {
    return null;
  }
  return {
    effective_scope: data.effective_scope as ReaderListPayload["effective_scope"],
    filter_options: {
      templates: data.filter_options.templates as readonly ReaderTemplateOption[],
      teams: data.filter_options.teams as readonly ReaderTeamOption[],
      assignees: data.filter_options.assignees as readonly ReaderAssigneeOption[],
    },
    items: data.items as readonly ReaderListItem[],
    next_cursor: data.next_cursor as string | null,
    has_more: data.has_more as boolean,
  };
}

export function mergeReaderItems(
  current: readonly ReaderListItem[],
  incoming: readonly ReaderListItem[],
): ReaderListItem[] {
  const seen = new Set(current.map((item) => item.obligation_id));
  const next = [...current];
  for (const item of incoming) {
    if (seen.has(item.obligation_id)) continue;
    seen.add(item.obligation_id);
    next.push(item);
  }
  return next;
}

export type ReaderRevision = {
  revision_id: string;
  revision_no: number;
  payload_json: Record<string, unknown>;
  created_at: string;
};

export function findCurrentRevision(
  revisions: readonly ReaderRevision[],
  currentRevisionId: string | null,
): ReaderRevision | null {
  if (revisions.length === 0) return null;
  if (currentRevisionId) {
    const match = revisions.find((revision) => revision.revision_id === currentRevisionId);
    if (match) return match;
  }
  // The reader RPC returns revisions ordered revision_no DESC; the head is current.
  return revisions[0];
}

export type ReaderDetail = {
  obligation: {
    period_key: string;
    period_start_date: string;
    period_end_date: string;
    due_at: string;
    snapshot_team_display_name: string | null;
    snapshot_team_code: string | null;
    obligation_status: string;
  };
  template: { template_code: string; display_name: string; schema_json: WorkReportTemplateSchema };
  submission: {
    submission_id: string;
    state: string;
    draft_payload_json: Record<string, unknown> | null;
    first_submitted_at: string | null;
    latest_submitted_at: string | null;
    is_late: boolean;
    has_post_deadline_amendment: boolean;
    current_revision_id: string | null;
    version: number;
  } | null;
  latest_review_event: { decision: string; reason: string | null; reviewed_at: string; revision_no?: number } | null;
  revisions: ReaderRevision[];
};

const DETAIL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isReaderRevision(value: unknown): value is ReaderRevision {
  return (
    isRecord(value) &&
    typeof value.revision_id === "string" &&
    DETAIL_UUID.test(value.revision_id) &&
    Number.isInteger(value.revision_no) &&
    Number(value.revision_no) >= 1 &&
    isRecord(value.payload_json) &&
    typeof value.created_at === "string" &&
    value.created_at.length > 0
  );
}

/**
 * Fail-closed detail parser: reuses the existing schema validator and mirrors the
 * submission/revision contract, so a malformed `schema_json` (e.g. `{}`) or an invalid
 * revision never reaches the renderer.
 */
export function parseReaderDetail(body: unknown): ReaderDetail | null {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.data)) return null;
  const d = body.data;
  if (!isRecord(d.obligation) || !isRecord(d.template)) return null;

  const obligation = d.obligation;
  if (
    typeof obligation.period_key !== "string" ||
    typeof obligation.period_start_date !== "string" ||
    typeof obligation.period_end_date !== "string" ||
    typeof obligation.due_at !== "string" ||
    typeof obligation.obligation_status !== "string" ||
    (obligation.snapshot_team_display_name !== null && typeof obligation.snapshot_team_display_name !== "string") ||
    (obligation.snapshot_team_code !== null && typeof obligation.snapshot_team_code !== "string")
  ) {
    return null;
  }

  const template = d.template;
  if (typeof template.display_name !== "string" || typeof template.template_code !== "string") return null;
  if (!validateWorkReportSchema(template.schema_json).ok) return null;

  if (!Array.isArray(d.revisions) || !d.revisions.every(isReaderRevision)) return null;

  const submission = d.submission === null
    ? null
    : isRecord(d.submission) &&
        typeof d.submission.submission_id === "string" && DETAIL_UUID.test(d.submission.submission_id) &&
        typeof d.submission.state === "string" &&
        Number.isInteger(d.submission.version) &&
        (d.submission.draft_payload_json === null || isRecord(d.submission.draft_payload_json)) &&
        (d.submission.first_submitted_at === null || typeof d.submission.first_submitted_at === "string") &&
        (d.submission.latest_submitted_at === null || typeof d.submission.latest_submitted_at === "string") &&
        typeof d.submission.is_late === "boolean" &&
        typeof d.submission.has_post_deadline_amendment === "boolean" &&
        (d.submission.current_revision_id === null ||
          (typeof d.submission.current_revision_id === "string" && DETAIL_UUID.test(d.submission.current_revision_id)))
      ? d.submission
      : undefined;
  if (submission === undefined) return null;

  const latest = d.latest_review_event === undefined || d.latest_review_event === null
    ? null
    : isRecord(d.latest_review_event) &&
        typeof d.latest_review_event.decision === "string" &&
        (d.latest_review_event.reason === null || typeof d.latest_review_event.reason === "string") &&
        typeof d.latest_review_event.reviewed_at === "string" &&
        (d.latest_review_event.revision_no === undefined || typeof d.latest_review_event.revision_no === "number")
      ? d.latest_review_event
      : undefined;
  if (latest === undefined) return null;

  return {
    obligation: {
      period_key: obligation.period_key,
      period_start_date: obligation.period_start_date,
      period_end_date: obligation.period_end_date,
      due_at: obligation.due_at,
      snapshot_team_display_name: obligation.snapshot_team_display_name as string | null,
      snapshot_team_code: obligation.snapshot_team_code as string | null,
      obligation_status: obligation.obligation_status,
    },
    template: {
      template_code: template.template_code,
      display_name: template.display_name,
      schema_json: template.schema_json as WorkReportTemplateSchema,
    },
    submission: submission === null ? null : {
      submission_id: String(submission.submission_id),
      state: String(submission.state),
      draft_payload_json: submission.draft_payload_json as Record<string, unknown> | null,
      first_submitted_at: submission.first_submitted_at as string | null,
      latest_submitted_at: submission.latest_submitted_at as string | null,
      is_late: submission.is_late as boolean,
      has_post_deadline_amendment: submission.has_post_deadline_amendment as boolean,
      current_revision_id: submission.current_revision_id as string | null,
      version: Number(submission.version),
    },
    latest_review_event: latest === null ? null : {
      decision: String(latest.decision),
      reason: latest.reason as string | null,
      reviewed_at: String(latest.reviewed_at),
      ...(typeof latest.revision_no === "number" ? { revision_no: latest.revision_no } : {}),
    },
    revisions: d.revisions as ReaderRevision[],
  };
}
