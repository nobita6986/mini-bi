import "server-only";

import type { WorkReportTemplateSchema } from "./contracts.ts";
import type { WorkReportActorRef } from "./assignment-repository.ts";
import { validateWorkReportSchema } from "./schema-validator.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type WorkReportReviewRpcOutcome<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind:
        | "actor-denied"
        | "self-review-denied"
        | "scope-denied"
        | "denied"
        | "reason-required"
        | "invalid"
        | "not-found"
        | "conflict"
        | "unavailable";
    };

export type WorkReportPendingReviewItem = {
  obligation_id: string;
  submission_id: string;
  template_id: string;
  template_code: string;
  template_name: string;
  period_key: string;
  period_start_date: string;
  period_end_date: string;
  due_at: string;
  assignee_app_user_id: string;
  assignee_display_name: string;
  snapshot_team_id: string | null;
  team_display_name: string | null;
  submitted_at: string;
  is_late: boolean;
  has_post_deadline_amendment: boolean;
  submission_version: number;
};

export type WorkReportPendingReviewList = {
  items: readonly WorkReportPendingReviewItem[];
  next_cursor: string | null;
  has_more: boolean;
};

export type WorkReportReviewEventItem = {
  review_event_id: string;
  revision_id: string;
  reviewer_user_id: string;
  decision: "APPROVED" | "REJECTED";
  reason: string | null;
  acting_scope_kind: "all" | "team";
  acting_team_id: string | null;
  delegation_id: string | null;
  created_at: string;
};

export type WorkReportReviewSubmissionDetail = {
  obligation: {
    obligation_id: string;
    assignment_id: string;
    template_id: string;
    template_version_id: string;
    assignee_app_user_id: string;
    assignee_display_name: string;
    snapshot_team_id: string | null;
    team_display_name: string | null;
    period_type: string;
    period_key: string;
    period_start_date: string;
    period_end_date: string;
    due_at: string;
    is_mandatory: boolean;
    obligation_status: string;
    reopened_until: string | null;
    version: number;
  };
  template: {
    template_code: string;
    display_name: string;
    requires_review?: boolean;
    schema_json: WorkReportTemplateSchema;
  };
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
  };
  revisions: ReadonlyArray<{
    revision_id: string;
    revision_no: number;
    payload_json: Record<string, unknown>;
    created_at: string;
  }>;
  review_events?: ReadonlyArray<WorkReportReviewEventItem>;
};

export type WorkReportReviewDecisionResult = {
  obligation_id: string;
  submission_id: string;
  revision_id: string;
  review_event_id: string;
  state: "APPROVED" | "REJECTED";
  version: number;
  acting_scope_kind: "all" | "team";
  acting_team_id: string | null;
  delegation_id: string | null;
};

export type WorkReportReviewRepository = {
  listPending(
    input: WorkReportActorRef & {
      template_id: string | null;
      cursor: string | null;
      page_size: number;
    },
  ): Promise<WorkReportReviewRpcOutcome<WorkReportPendingReviewList>>;
  getSubmission(
    input: WorkReportActorRef & { obligation_id: string },
  ): Promise<WorkReportReviewRpcOutcome<WorkReportReviewSubmissionDetail>>;
  decide(
    input: WorkReportActorRef & {
      obligation_id: string;
      decision: "APPROVED" | "REJECTED";
      reason: string | null;
      expected_version: number;
      idempotency_key: string;
    },
  ): Promise<WorkReportReviewRpcOutcome<WorkReportReviewDecisionResult>>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await client).rpc(name, args);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPendingItem(value: unknown): value is WorkReportPendingReviewItem {
  return (
    isRecord(value) &&
    typeof value.obligation_id === "string" &&
    UUID.test(value.obligation_id) &&
    typeof value.submission_id === "string" &&
    UUID.test(value.submission_id) &&
    typeof value.template_id === "string" &&
    UUID.test(value.template_id) &&
    typeof value.template_code === "string" &&
    typeof value.template_name === "string" &&
    typeof value.period_key === "string" &&
    typeof value.period_start_date === "string" &&
    typeof value.period_end_date === "string" &&
    typeof value.due_at === "string" &&
    typeof value.assignee_app_user_id === "string" &&
    UUID.test(value.assignee_app_user_id) &&
    typeof value.assignee_display_name === "string" &&
    (value.snapshot_team_id === null ||
      (typeof value.snapshot_team_id === "string" && UUID.test(value.snapshot_team_id))) &&
    (value.team_display_name === null || typeof value.team_display_name === "string") &&
    typeof value.submitted_at === "string" &&
    typeof value.is_late === "boolean" &&
    typeof value.has_post_deadline_amendment === "boolean" &&
    Number.isInteger(value.submission_version) &&
    !("payload_json" in value) &&
    !("draft_payload_json" in value)
  );
}

function isPendingList(value: unknown): value is WorkReportPendingReviewList {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isPendingItem) &&
    (value.next_cursor === null || typeof value.next_cursor === "string") &&
    typeof value.has_more === "boolean"
  );
}

function isReviewDetail(value: unknown): value is WorkReportReviewSubmissionDetail {
  return (
    isRecord(value) &&
    isRecord(value.obligation) &&
    typeof value.obligation.obligation_id === "string" &&
    UUID.test(value.obligation.obligation_id) &&
    isRecord(value.template) &&
    typeof value.template.template_code === "string" &&
    typeof value.template.display_name === "string" &&
    validateWorkReportSchema(value.template.schema_json).ok &&
    isRecord(value.submission) &&
    typeof value.submission.submission_id === "string" &&
    UUID.test(value.submission.submission_id) &&
    typeof value.submission.state === "string" &&
    Number.isInteger(value.submission.version) &&
    Array.isArray(value.revisions) &&
    value.revisions.every(
      (rev) =>
        isRecord(rev) &&
        typeof rev.revision_id === "string" &&
        UUID.test(rev.revision_id) &&
        Number.isInteger(rev.revision_no) &&
        isRecord(rev.payload_json) &&
        typeof rev.created_at === "string",
    )
  );
}

function isDecisionResult(value: unknown): value is WorkReportReviewDecisionResult {
  return (
    isRecord(value) &&
    typeof value.obligation_id === "string" &&
    UUID.test(value.obligation_id) &&
    typeof value.submission_id === "string" &&
    UUID.test(value.submission_id) &&
    typeof value.revision_id === "string" &&
    UUID.test(value.revision_id) &&
    typeof value.review_event_id === "string" &&
    UUID.test(value.review_event_id) &&
    (value.state === "APPROVED" || value.state === "REJECTED") &&
    Number.isInteger(value.version) &&
    (value.acting_scope_kind === "all" || value.acting_scope_kind === "team") &&
    (value.acting_team_id === null ||
      (typeof value.acting_team_id === "string" && UUID.test(value.acting_team_id))) &&
    (value.delegation_id === null ||
      (typeof value.delegation_id === "string" && UUID.test(value.delegation_id)))
  );
}

function classify(error: { code?: string; message?: string }): WorkReportReviewRpcOutcome<never> {
  const msg = error.message ?? "";
  if (error.code === "42501") {
    if (msg.includes("WORK_REPORT_ACTOR_DENIED")) {
      return { ok: false, kind: "actor-denied" };
    }
    if (msg.includes("WORK_REPORT_SELF_REVIEW_FORBIDDEN")) {
      return { ok: false, kind: "self-review-denied" };
    }
    if (msg.includes("WORK_REPORT_SCOPE_DENIED")) {
      return { ok: false, kind: "scope-denied" };
    }
    return { ok: false, kind: "denied" };
  }
  if (error.code === "40001" || error.code === "23505") {
    return { ok: false, kind: "conflict" };
  }
  if (error.code === "P0002") {
    return { ok: false, kind: "not-found" };
  }
  if (error.code === "22023" || error.code === "23514") {
    if (msg.includes("WORK_REPORT_REVIEW_REASON_REQUIRED")) {
      return { ok: false, kind: "reason-required" };
    }
    return { ok: false, kind: "invalid" };
  }
  return { ok: false, kind: "unavailable" };
}

export function createReviewRepository(rpc?: Rpc): WorkReportReviewRepository {
  let call = rpc;
  const invoke: Rpc = async (name, args) => {
    call ??= serviceRoleRpc();
    return call(name, args);
  };
  const run = async <T>(
    name: string,
    args: Record<string, unknown>,
    valid: (value: unknown) => value is T,
  ): Promise<WorkReportReviewRpcOutcome<T>> => {
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
    listPending(input) {
      return run(
        "work_report_list_pending_reviews",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_template_id: input.template_id,
          p_cursor: input.cursor,
          p_page_size: input.page_size,
        },
        isPendingList,
      );
    },
    getSubmission(input) {
      return run(
        "work_report_get_review_submission",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_obligation_id: input.obligation_id,
        },
        isReviewDetail,
      );
    },
    decide(input) {
      return run(
        "work_report_decide_review",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_obligation_id: input.obligation_id,
          p_decision: input.decision,
          p_reason: input.reason,
          p_expected_version: input.expected_version,
          p_idempotency_key: input.idempotency_key,
        },
        isDecisionResult,
      );
    },
  };
}
