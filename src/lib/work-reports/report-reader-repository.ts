import "server-only";

import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import type { WorkReportActorRef } from "./assignment-repository.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export const WORK_REPORT_READABLE_STATES = [
  "COMPLETED",
  "PENDING_REVIEW",
  "APPROVED",
  "REJECTED",
] as const;

export type WorkReportReadableState = (typeof WORK_REPORT_READABLE_STATES)[number];

export type WorkReportReaderRpcOutcome<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind:
        | "actor-denied"
        | "scope-denied"
        | "denied"
        | "invalid"
        | "not-found"
        | "unavailable";
    };

export type WorkReportReaderEffectiveScope = {
  kind: "all" | "team";
  label: string;
};

export type WorkReportReaderTemplateVersionOption = {
  version_id: string;
  version_no: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
};

export type WorkReportReaderTemplateOption = {
  template_id: string;
  template_code: string;
  display_name: string;
  versions: readonly WorkReportReaderTemplateVersionOption[];
};

export type WorkReportReaderTeamOption = {
  team_id: string;
  code: string;
  display_name: string;
};

export type WorkReportReaderAssigneeOption = {
  app_user_id: string;
  display_name: string;
};

export type WorkReportReaderFilterOptions = {
  templates: readonly WorkReportReaderTemplateOption[];
  teams: readonly WorkReportReaderTeamOption[];
  assignees: readonly WorkReportReaderAssigneeOption[];
};

export type WorkReportReadableSubmissionItem = {
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
  state: WorkReportReadableState;
  latest_submitted_at: string;
  is_late: boolean;
  has_post_deadline_amendment: boolean;
  current_revision_no: number;
};

export type WorkReportReadableSubmissionList = {
  effective_scope: WorkReportReaderEffectiveScope;
  filter_options: WorkReportReaderFilterOptions;
  items: readonly WorkReportReadableSubmissionItem[];
  next_cursor: string | null;
  has_more: boolean;
};

/**
 * Filter input for `public.work_report_list_readable_submissions`.
 *
 * Reporting-period semantics (`from` / `to`):
 *   Inclusive bounds on `work_report_obligations.period_start_date` (`YYYY-MM-DD`
 *   in the `Asia/Ho_Chi_Minh` reporting calendar), matching Work Reports analytics:
 *     - `from !== null` => `period_start_date >= from`
 *     - `to !== null`   => `period_start_date <= to`
 */
export type WorkReportReaderFilterInput = WorkReportActorRef & {
  template_id: string | null;
  version_id: string | null;
  from: string | null;
  to: string | null;
  team_id: string | null;
  assignee_id: string | null;
  state: WorkReportReadableState | null;
  cursor: string | null;
  limit: number;
};

export type ReportReaderRepository = {
  listReadable(
    input: WorkReportReaderFilterInput,
  ): Promise<WorkReportReaderRpcOutcome<WorkReportReadableSubmissionList>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYSET_CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))\|([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const READABLE_STATE_SET = new Set<string>(WORK_REPORT_READABLE_STATES);
const VERSION_STATUS_SET = new Set<string>(["DRAFT", "PUBLISHED", "ARCHIVED"]);

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await client).rpc(name, args);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isKeysetCursor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = KEYSET_CURSOR.exec(value);
  return Boolean(match && !Number.isNaN(Date.parse(match[1])));
}

function isEffectiveScope(value: unknown): value is WorkReportReaderEffectiveScope {
  return (
    isRecord(value) &&
    (value.kind === "all" || value.kind === "team") &&
    typeof value.label === "string" &&
    value.label.trim().length > 0
  );
}

function isTemplateVersionOption(value: unknown): value is WorkReportReaderTemplateVersionOption {
  return (
    isRecord(value) &&
    typeof value.version_id === "string" &&
    UUID.test(value.version_id) &&
    isPositiveInt(value.version_no) &&
    typeof value.status === "string" &&
    VERSION_STATUS_SET.has(value.status)
  );
}

function isTemplateOption(value: unknown): value is WorkReportReaderTemplateOption {
  return (
    isRecord(value) &&
    typeof value.template_id === "string" &&
    UUID.test(value.template_id) &&
    typeof value.template_code === "string" &&
    value.template_code.trim().length > 0 &&
    typeof value.display_name === "string" &&
    value.display_name.trim().length > 0 &&
    Array.isArray(value.versions) &&
    value.versions.every(isTemplateVersionOption)
  );
}

function isTeamOption(value: unknown): value is WorkReportReaderTeamOption {
  return (
    isRecord(value) &&
    typeof value.team_id === "string" &&
    UUID.test(value.team_id) &&
    typeof value.code === "string" &&
    value.code.trim().length > 0 &&
    typeof value.display_name === "string" &&
    value.display_name.trim().length > 0
  );
}

function isAssigneeOption(value: unknown): value is WorkReportReaderAssigneeOption {
  return (
    isRecord(value) &&
    typeof value.app_user_id === "string" &&
    UUID.test(value.app_user_id) &&
    typeof value.display_name === "string" &&
    value.display_name.trim().length > 0
  );
}

function isFilterOptions(value: unknown): value is WorkReportReaderFilterOptions {
  return (
    isRecord(value) &&
    Array.isArray(value.templates) &&
    value.templates.every(isTemplateOption) &&
    Array.isArray(value.teams) &&
    value.teams.every(isTeamOption) &&
    Array.isArray(value.assignees) &&
    value.assignees.every(isAssigneeOption)
  );
}

function isReadableSubmissionItem(value: unknown): value is WorkReportReadableSubmissionItem {
  return (
    isRecord(value) &&
    typeof value.obligation_id === "string" &&
    UUID.test(value.obligation_id) &&
    typeof value.submission_id === "string" &&
    UUID.test(value.submission_id) &&
    typeof value.template_id === "string" &&
    UUID.test(value.template_id) &&
    typeof value.template_name === "string" &&
    value.template_name.trim().length > 0 &&
    typeof value.template_version_id === "string" &&
    UUID.test(value.template_version_id) &&
    isPositiveInt(value.template_version_no) &&
    typeof value.assignee_app_user_id === "string" &&
    UUID.test(value.assignee_app_user_id) &&
    typeof value.assignee_display_name === "string" &&
    value.assignee_display_name.trim().length > 0 &&
    (value.team_id === null || (typeof value.team_id === "string" && UUID.test(value.team_id))) &&
    (value.team_display_name === null || typeof value.team_display_name === "string") &&
    typeof value.period_key === "string" &&
    value.period_key.length > 0 &&
    typeof value.period_start_date === "string" &&
    isRealCalendarDate(value.period_start_date) &&
    typeof value.period_end_date === "string" &&
    isRealCalendarDate(value.period_end_date) &&
    typeof value.state === "string" &&
    READABLE_STATE_SET.has(value.state) &&
    isIsoTimestamp(value.latest_submitted_at) &&
    typeof value.is_late === "boolean" &&
    typeof value.has_post_deadline_amendment === "boolean" &&
    isPositiveInt(value.current_revision_no) &&
    !("payload_json" in value) &&
    !("draft_payload_json" in value)
  );
}

function isReadableSubmissionList(value: unknown): value is WorkReportReadableSubmissionList {
  if (!isRecord(value)) return false;
  if (!isEffectiveScope(value.effective_scope)) return false;
  if (!isFilterOptions(value.filter_options)) return false;
  if (!Array.isArray(value.items) || !value.items.every(isReadableSubmissionItem)) return false;
  if (typeof value.has_more !== "boolean") return false;
  if (value.has_more) {
    return isKeysetCursor(value.next_cursor);
  }
  return value.next_cursor === null;
}

function classify(error: { code?: string; message?: string }): WorkReportReaderRpcOutcome<never> {
  const msg = error.message ?? "";
  if (error.code === "42501") {
    if (msg.includes("WORK_REPORT_ACTOR_DENIED")) {
      return { ok: false, kind: "actor-denied" };
    }
    if (msg.includes("WORK_REPORT_SCOPE_DENIED")) {
      return { ok: false, kind: "scope-denied" };
    }
    return { ok: false, kind: "denied" };
  }
  if (error.code === "P0002") {
    return { ok: false, kind: "not-found" };
  }
  if (error.code === "22023") {
    return { ok: false, kind: "invalid" };
  }
  return { ok: false, kind: "unavailable" };
}

export function createReportReaderRepository(rpc?: Rpc): ReportReaderRepository {
  let call = rpc;
  const invoke: Rpc = async (name, args) => {
    call ??= serviceRoleRpc();
    return call(name, args);
  };

  return {
    async listReadable(input) {
      try {
        const { data, error } = await invoke("work_report_list_readable_submissions", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_template_id: input.template_id,
          p_version_id: input.version_id,
          p_from: input.from,
          p_to: input.to,
          p_team_id: input.team_id,
          p_assignee_id: input.assignee_id,
          p_state: input.state,
          p_cursor: input.cursor,
          p_limit: input.limit,
        });
        if (error) return classify(error);
        return isReadableSubmissionList(data)
          ? { ok: true, data }
          : { ok: false, kind: "unavailable" };
      } catch {
        console.error("[work-reports] work_report_list_readable_submissions RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
