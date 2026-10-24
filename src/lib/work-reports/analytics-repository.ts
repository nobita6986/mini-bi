import "server-only";

import type { WorkReportActorRef } from "./assignment-repository.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type WorkReportAnalyticsRpcOutcome<T> =
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

export type WorkReportEffectiveScope = {
  kind: "all" | "team";
  label: string;
};

export type WorkReportComplianceSummary = {
  due_count: number;
  completed_count: number;
  on_time_count: number;
  late_submitted_count: number;
  pending_due_count: number;
  overdue_missing_count: number;
  exempted_count: number;
  pending_review_count: number;
  completion_rate: number | null;
};

export type WorkReportMetricAggregate = {
  metric_key: string;
  label: string;
  unit: string;
  compatible_group: string;
  sum_value: number | null;
  avg_value: number | null;
  min_value: number | null;
  max_value: number | null;
  count_valid: number;
  missing_value_count: number;
};

export type WorkReportRatioAggregate = {
  ratio_key: string;
  label: string;
  numerator_metric_key: string;
  denominator_metric_key: string;
  numerator_sum: number | null;
  denominator_sum: number | null;
  scale_factor: number;
  value: number | null;
};

export type WorkReportAnalyticsOverview = {
  as_of: string;
  effective_scope: WorkReportEffectiveScope;
  compliance: WorkReportComplianceSummary;
  metrics: readonly WorkReportMetricAggregate[];
  ratios?: readonly WorkReportRatioAggregate[];
};

export type WorkReportAnalyticsGroupBy = "team" | "assignee" | "period";

export type WorkReportAnalyticsBreakdownItem = {
  group_id: string | null;
  group_label: string;
  due_count: number;
  completed_count: number;
  on_time_count: number;
  late_submitted_count: number;
  pending_due_count: number;
  overdue_missing_count: number;
  exempted_count: number;
  pending_review_count: number;
  completion_rate: number | null;
  metrics: readonly WorkReportMetricAggregate[];
};

export type WorkReportAnalyticsBreakdown = {
  as_of: string;
  effective_scope: WorkReportEffectiveScope;
  group_by: WorkReportAnalyticsGroupBy;
  page: number;
  page_size: number;
  total_groups: number;
  items: readonly WorkReportAnalyticsBreakdownItem[];
};

export type WorkReportAnalyticsContributionItem = {
  obligation_id: string;
  submission_id: string | null;
  revision_no: number | null;
  assignee_app_user_id: string;
  assignee_display_name: string;
  snapshot_team_id: string | null;
  team_display_name: string | null;
  period_key: string;
  state: string;
  submitted_at: string | null;
  is_late: boolean;
  has_post_deadline_amendment: boolean;
  metric_contribution_value: number | null;
};

export type WorkReportAnalyticsContributions = {
  as_of: string;
  effective_scope: WorkReportEffectiveScope;
  next_cursor: string | null;
  items: readonly WorkReportAnalyticsContributionItem[];
};

export type WorkReportMetricReconciliationIssue = {
  submission_id: string;
  revision_id: string;
  field_key: string;
  option_key: string | null;
  issue_kind: string;
};

export type WorkReportMetricReconciliation = {
  ok: boolean;
  checked_submissions_count: number;
  expected_metric_rows_count: number;
  actual_eligible_rows_count: number;
  missing_projection_count: number;
  extra_current_projection_count: number;
  value_mismatch_count: number;
  flag_mismatch_count: number;
  total_discrepancy_count: number;
  discrepancies: readonly WorkReportMetricReconciliationIssue[];
};

export type WorkReportAnalyticsFinality = "final" | "provisional_included";

export type WorkReportAnalyticsFilterInput = WorkReportActorRef & {
  template_id: string;
  version_id: string | null;
  from: string | null;
  to: string | null;
  team_id: string | null;
  assignee_id: string | null;
  finality: WorkReportAnalyticsFinality;
};

export type WorkReportAnalyticsBreakdownInput = WorkReportAnalyticsFilterInput & {
  group_by: WorkReportAnalyticsGroupBy;
  page: number;
  page_size: number;
};

export type WorkReportAnalyticsContributionsInput = WorkReportAnalyticsFilterInput & {
  metric_key: string | null;
  compatible_group: string | null;
  target_team_id: string | null;
  target_assignee_id: string | null;
  target_period_key: string | null;
  cursor: string | null;
  limit: number;
};

export type WorkReportAnalyticsFilterTemplateVersionOption = {
  version_id: string;
  version_no: number;
  status: string;
};

export type WorkReportAnalyticsFilterTemplateOption = {
  template_id: string;
  template_code: string;
  display_name: string;
  status: string;
  versions: readonly WorkReportAnalyticsFilterTemplateVersionOption[];
};

export type WorkReportAnalyticsFilterTeamOption = {
  team_id: string;
  code: string;
  display_name: string;
};

export type WorkReportAnalyticsFilterAssigneeOption = {
  app_user_id: string;
  display_name: string;
  team_ids: readonly string[];
};

export type WorkReportAnalyticsFilterOptions = {
  effective_scope: WorkReportEffectiveScope;
  templates: readonly WorkReportAnalyticsFilterTemplateOption[];
  teams: readonly WorkReportAnalyticsFilterTeamOption[];
  assignees: readonly WorkReportAnalyticsFilterAssigneeOption[];
};

export type AnalyticsRepository = {
  options(input: WorkReportActorRef): Promise<WorkReportAnalyticsRpcOutcome<WorkReportAnalyticsFilterOptions>>;
  overview(input: WorkReportAnalyticsFilterInput): Promise<WorkReportAnalyticsRpcOutcome<WorkReportAnalyticsOverview>>;
  breakdown(input: WorkReportAnalyticsBreakdownInput): Promise<WorkReportAnalyticsRpcOutcome<WorkReportAnalyticsBreakdown>>;
  contributions(input: WorkReportAnalyticsContributionsInput): Promise<WorkReportAnalyticsRpcOutcome<WorkReportAnalyticsContributions>>;
  reconcile(input: WorkReportActorRef & { template_id: string | null }): Promise<WorkReportAnalyticsRpcOutcome<WorkReportMetricReconciliation>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) => createServiceSupabaseClient());
  return async (name, args) => (await client).rpc(name, args);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYSET_CURSOR =
  /^(?:null|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))\|\d{4}-\d{2}-\d{2}\|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isNonNegativeInt(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isEffectiveScope(value: unknown): value is WorkReportEffectiveScope {
  return (
    isRecord(value) &&
    (value.kind === "all" || value.kind === "team") &&
    typeof value.label === "string" &&
    value.label.trim().length > 0
  );
}

function isComplianceSummary(value: unknown): value is WorkReportComplianceSummary {
  return (
    isRecord(value) &&
    isNonNegativeInt(value.due_count) &&
    isNonNegativeInt(value.completed_count) &&
    isNonNegativeInt(value.on_time_count) &&
    isNonNegativeInt(value.late_submitted_count) &&
    isNonNegativeInt(value.pending_due_count) &&
    isNonNegativeInt(value.overdue_missing_count) &&
    isNonNegativeInt(value.exempted_count) &&
    isNonNegativeInt(value.pending_review_count) &&
    isNullableFiniteNumber(value.completion_rate)
  );
}

function isMetricAggregate(value: unknown): value is WorkReportMetricAggregate {
  return (
    isRecord(value) &&
    typeof value.metric_key === "string" &&
    typeof value.label === "string" &&
    typeof value.unit === "string" &&
    typeof value.compatible_group === "string" &&
    isNullableFiniteNumber(value.sum_value) &&
    isNullableFiniteNumber(value.avg_value) &&
    isNullableFiniteNumber(value.min_value) &&
    isNullableFiniteNumber(value.max_value) &&
    isNonNegativeInt(value.count_valid) &&
    isNonNegativeInt(value.missing_value_count)
  );
}

function isRatioAggregate(value: unknown): value is WorkReportRatioAggregate {
  return (
    isRecord(value) &&
    typeof value.ratio_key === "string" &&
    typeof value.label === "string" &&
    typeof value.numerator_metric_key === "string" &&
    typeof value.denominator_metric_key === "string" &&
    isNullableFiniteNumber(value.numerator_sum) &&
    isNullableFiniteNumber(value.denominator_sum) &&
    typeof value.scale_factor === "number" &&
    isNullableFiniteNumber(value.value)
  );
}

function isOverview(value: unknown): value is WorkReportAnalyticsOverview {
  return (
    isRecord(value) &&
    isIsoTimestamp(value.as_of) &&
    isEffectiveScope(value.effective_scope) &&
    isComplianceSummary(value.compliance) &&
    Array.isArray(value.metrics) &&
    value.metrics.every(isMetricAggregate) &&
    (value.ratios === undefined || (Array.isArray(value.ratios) && value.ratios.every(isRatioAggregate)))
  );
}

function isBreakdownItem(value: unknown): value is WorkReportAnalyticsBreakdownItem {
  return (
    isRecord(value) &&
    (value.group_id === null || typeof value.group_id === "string") &&
    typeof value.group_label === "string" &&
    isNonNegativeInt(value.due_count) &&
    isNonNegativeInt(value.completed_count) &&
    isNonNegativeInt(value.on_time_count) &&
    isNonNegativeInt(value.late_submitted_count) &&
    isNonNegativeInt(value.pending_due_count) &&
    isNonNegativeInt(value.overdue_missing_count) &&
    isNonNegativeInt(value.exempted_count) &&
    isNonNegativeInt(value.pending_review_count) &&
    isNullableFiniteNumber(value.completion_rate) &&
    Array.isArray(value.metrics) &&
    value.metrics.every(isMetricAggregate)
  );
}

function isBreakdown(value: unknown): value is WorkReportAnalyticsBreakdown {
  return (
    isRecord(value) &&
    isIsoTimestamp(value.as_of) &&
    isEffectiveScope(value.effective_scope) &&
    ["team", "assignee", "period"].includes(String(value.group_by)) &&
    Number.isInteger(value.page) &&
    Number(value.page) >= 1 &&
    Number.isInteger(value.page_size) &&
    Number(value.page_size) >= 1 &&
    isNonNegativeInt(value.total_groups) &&
    Array.isArray(value.items) &&
    value.items.every(isBreakdownItem)
  );
}

function isContributionItem(value: unknown): value is WorkReportAnalyticsContributionItem {
  return (
    isRecord(value) &&
    typeof value.obligation_id === "string" &&
    UUID.test(value.obligation_id) &&
    (value.submission_id === null || (typeof value.submission_id === "string" && UUID.test(value.submission_id))) &&
    (value.revision_no === null || isNonNegativeInt(value.revision_no)) &&
    typeof value.assignee_app_user_id === "string" &&
    UUID.test(value.assignee_app_user_id) &&
    typeof value.assignee_display_name === "string" &&
    (value.snapshot_team_id === null || (typeof value.snapshot_team_id === "string" && UUID.test(value.snapshot_team_id))) &&
    (value.team_display_name === null || typeof value.team_display_name === "string") &&
    typeof value.period_key === "string" &&
    typeof value.state === "string" &&
    (value.submitted_at === null || typeof value.submitted_at === "string") &&
    typeof value.is_late === "boolean" &&
    typeof value.has_post_deadline_amendment === "boolean" &&
    isNullableFiniteNumber(value.metric_contribution_value)
  );
}

function isContributions(value: unknown): value is WorkReportAnalyticsContributions {
  return (
    isRecord(value) &&
    isIsoTimestamp(value.as_of) &&
    isEffectiveScope(value.effective_scope) &&
    (value.next_cursor === null || (typeof value.next_cursor === "string" && KEYSET_CURSOR.test(value.next_cursor))) &&
    Array.isArray(value.items) &&
    value.items.every(isContributionItem)
  );
}

function isAnalyticsFilterOptions(value: unknown): value is WorkReportAnalyticsFilterOptions {
  return (
    isRecord(value) &&
    isEffectiveScope(value.effective_scope) &&
    Array.isArray(value.templates) &&
    value.templates.every(
      (tpl) =>
        isRecord(tpl) &&
        typeof tpl.template_id === "string" &&
        UUID.test(tpl.template_id) &&
        typeof tpl.template_code === "string" &&
        typeof tpl.display_name === "string" &&
        typeof tpl.status === "string" &&
        Array.isArray(tpl.versions) &&
        tpl.versions.every(
          (ver) =>
            isRecord(ver) &&
            typeof ver.version_id === "string" &&
            UUID.test(ver.version_id) &&
            Number.isInteger(ver.version_no) &&
            Number(ver.version_no) >= 1 &&
            typeof ver.status === "string",
        ),
    ) &&
    Array.isArray(value.teams) &&
    value.teams.every(
      (team) =>
        isRecord(team) &&
        typeof team.team_id === "string" &&
        UUID.test(team.team_id) &&
        typeof team.code === "string" &&
        typeof team.display_name === "string",
    ) &&
    Array.isArray(value.assignees) &&
    value.assignees.every(
      (user) =>
        isRecord(user) &&
        typeof user.app_user_id === "string" &&
        UUID.test(user.app_user_id) &&
        typeof user.display_name === "string" &&
        Array.isArray(user.team_ids) &&
        user.team_ids.every((tid) => typeof tid === "string" && UUID.test(tid)),
    )
  );
}

function isReconciliation(value: unknown): value is WorkReportMetricReconciliation {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    isNonNegativeInt(value.checked_submissions_count) &&
    isNonNegativeInt(value.expected_metric_rows_count) &&
    isNonNegativeInt(value.actual_eligible_rows_count) &&
    isNonNegativeInt(value.missing_projection_count) &&
    isNonNegativeInt(value.extra_current_projection_count) &&
    isNonNegativeInt(value.value_mismatch_count) &&
    isNonNegativeInt(value.flag_mismatch_count) &&
    isNonNegativeInt(value.total_discrepancy_count) &&
    Array.isArray(value.discrepancies)
  );
}

function classify(error: { code?: string; message?: string }): WorkReportAnalyticsRpcOutcome<never> {
  if (error.code === "42501") {
    const msg = error.message ?? "";
    if (msg.includes("WORK_REPORT_ACTOR_DENIED")) {
      return { ok: false, kind: "actor-denied" };
    }
    if (msg.includes("WORK_REPORT_SCOPE_DENIED")) {
      return { ok: false, kind: "scope-denied" };
    }
    return { ok: false, kind: "denied" };
  }
  if (error.code === "P0002") return { ok: false, kind: "not-found" };
  if (error.code === "22023") return { ok: false, kind: "invalid" };
  return { ok: false, kind: "unavailable" };
}

export function computeWorkReportWeightedRatio(
  numeratorSum: number | null,
  denominatorSum: number | null,
  scaleFactor = 100,
): number | null {
  if (numeratorSum === null || denominatorSum === null || !Number.isFinite(numeratorSum) || !Number.isFinite(denominatorSum) || denominatorSum <= 0) {
    return null;
  }
  return Math.round(((numeratorSum / denominatorSum) * scaleFactor) * 100) / 100;
}

export function createAnalyticsRepository(rpc?: Rpc): AnalyticsRepository {
  let call = rpc;
  const invoke: Rpc = async (name, args) => {
    call ??= serviceRoleRpc();
    return call(name, args);
  };
  const run = async <T>(
    name: string,
    args: Record<string, unknown>,
    valid: (value: unknown) => value is T,
  ): Promise<WorkReportAnalyticsRpcOutcome<T>> => {
    try {
      const { data, error } = await invoke(name, args);
      if (error) return classify(error);
      return valid(data) ? { ok: true, data } : { ok: false, kind: "unavailable" };
    } catch {
      console.error(`[work-reports] ${name} RPC failed`);
      return { ok: false, kind: "unavailable" };
    }
  };

  return {
    options(input) {
      return run(
        "work_report_analytics_filter_options",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
        },
        isAnalyticsFilterOptions,
      );
    },
    overview(input) {
      return run(
        "work_report_analytics_overview",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_template_id: input.template_id,
          p_version_id: input.version_id,
          p_from: input.from,
          p_to: input.to,
          p_team_id: input.team_id,
          p_assignee_id: input.assignee_id,
          p_finality: input.finality,
        },
        isOverview,
      );
    },
    breakdown(input) {
      return run(
        "work_report_analytics_breakdown",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_template_id: input.template_id,
          p_version_id: input.version_id,
          p_from: input.from,
          p_to: input.to,
          p_team_id: input.team_id,
          p_assignee_id: input.assignee_id,
          p_finality: input.finality,
          p_group_by: input.group_by,
          p_page: input.page,
          p_page_size: input.page_size,
        },
        isBreakdown,
      );
    },
    contributions(input) {
      return run(
        "work_report_analytics_contributions",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_template_id: input.template_id,
          p_version_id: input.version_id,
          p_from: input.from,
          p_to: input.to,
          p_team_id: input.team_id,
          p_assignee_id: input.assignee_id,
          p_finality: input.finality,
          p_metric_key: input.metric_key,
          p_compatible_group: input.compatible_group,
          p_target_team_id: input.target_team_id,
          p_target_assignee_id: input.target_assignee_id,
          p_target_period_key: input.target_period_key,
          p_cursor: input.cursor,
          p_limit: input.limit,
        },
        isContributions,
      );
    },
    reconcile(input) {
      return run(
        "work_report_reconcile_metric_projection",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_template_id: input.template_id,
        },
        isReconciliation,
      );
    },
  };
}
