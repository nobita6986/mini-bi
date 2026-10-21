import "server-only";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type WorkReportActorRef = { auth_subject: string; app_user_id: string };

export type AssignmentCreateInput = WorkReportActorRef & {
  template_id: string;
  target_kind: "USER" | "TEAM" | "USER_SET";
  target_user_id: string | null;
  target_team_id: string | null;
  target_user_ids: string[];
  frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "ONCE";
  is_mandatory: boolean;
  due_day_offset: number;
  due_time_local: string;
  exclude_sundays: boolean;
  effective_from: string;
  effective_to: string | null;
  idempotency_key: string;
};

export type WorkReportRpcOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "conflict" | "denied" | "invalid" | "not-found" | "unavailable" };

export type WorkReportAssignmentOptions = {
  templates: readonly {
    template_id: string; template_code: string; display_name: string;
    default_frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "ONCE";
    current_published_version_id: string;
  }[];
  teams: readonly { team_id: string; code: string; display_name: string }[];
  users: readonly { app_user_id: string; display_name: string }[];
};

export type AssignmentRepository = {
  listOptions(input: WorkReportActorRef & { team_id: string | null }): Promise<WorkReportRpcOutcome<WorkReportAssignmentOptions>>;
  create(input: AssignmentCreateInput): Promise<WorkReportRpcOutcome<{ assignment_id: string; version: number }>>;
  setState(input: WorkReportActorRef & {
    assignment_id: string; expected_version: number; state: "ACTIVE" | "PAUSED" | "REVOKED"; idempotency_key: string;
  }): Promise<WorkReportRpcOutcome<Record<string, unknown>>>;
  changeObligation(input: WorkReportActorRef & {
    obligation_id: string; expected_version: number; action: "EXEMPT" | "REOPEN";
    reason: string; reopened_until: string | null; idempotency_key: string;
  }): Promise<WorkReportRpcOutcome<Record<string, unknown>>>;
  materialize(input: WorkReportActorRef & { business_date: string }): Promise<WorkReportRpcOutcome<Record<string, unknown>>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) => createServiceSupabaseClient());
  return async (name, args) => (await client).rpc(name, args);
}

function classify(error: { code?: string }): "conflict" | "denied" | "invalid" | "not-found" | "unavailable" {
  if (error.code === "40001" || error.code === "23505") return "conflict";
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "22023") return "invalid";
  return "unavailable";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function outcome<T>(data: unknown, error: { code?: string } | null, valid: (value: unknown) => value is T): WorkReportRpcOutcome<T> {
  if (error) return { ok: false, kind: classify(error) };
  return valid(data) ? { ok: true, data } : { ok: false, kind: "unavailable" };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const versioned = (value: unknown): value is Record<string, unknown> => record(value) && Number.isInteger(value.version);

function assignmentOptions(value: unknown): value is WorkReportAssignmentOptions {
  if (!record(value) || !Array.isArray(value.templates) || !Array.isArray(value.teams) || !Array.isArray(value.users)) return false;
  return value.templates.every((item) => record(item) && UUID.test(String(item.template_id)) &&
      typeof item.template_code === "string" && typeof item.display_name === "string" &&
      ["DAILY", "WEEKLY", "MONTHLY", "ONCE"].includes(String(item.default_frequency)) &&
      UUID.test(String(item.current_published_version_id))) &&
    value.teams.every((item) => record(item) && UUID.test(String(item.team_id)) &&
      typeof item.code === "string" && typeof item.display_name === "string") &&
    value.users.every((item) => record(item) && UUID.test(String(item.app_user_id)) &&
      typeof item.display_name === "string");
}

export function createAssignmentRepository(rpc?: Rpc): AssignmentRepository {
  let call = rpc;
  const invoke: Rpc = async (name, args) => {
    call ??= serviceRoleRpc();
    return call(name, args);
  };
  return {
    async listOptions(input) {
      try {
        const { data, error } = await invoke("work_report_list_assignment_options", {
          p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id, p_team_id: input.team_id,
        });
        return outcome(data, error, assignmentOptions);
      } catch {
        console.error("[work-reports] assignment options RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async create(input) {
      try {
        const { data, error } = await invoke("work_report_create_assignment", {
          p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
          p_template_id: input.template_id, p_target_kind: input.target_kind,
          p_target_user_id: input.target_user_id, p_target_team_id: input.target_team_id,
          p_target_user_ids: input.target_user_ids.length ? input.target_user_ids : null,
          p_frequency: input.frequency, p_is_mandatory: input.is_mandatory,
          p_due_day_offset: input.due_day_offset, p_due_time_local: input.due_time_local,
          p_exclude_sundays: input.exclude_sundays, p_effective_from: input.effective_from,
          p_effective_to: input.effective_to, p_idempotency_key: input.idempotency_key,
        });
        return outcome(data, error, (value): value is { assignment_id: string; version: number } =>
          record(value) && typeof value.assignment_id === "string" && UUID.test(value.assignment_id) && value.version === 1);
      } catch {
        console.error("[work-reports] assignment create RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async setState(input) {
      try {
        const { data, error } = await invoke("work_report_set_assignment_state", {
          p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
          p_assignment_id: input.assignment_id, p_expected_version: input.expected_version,
          p_state: input.state, p_idempotency_key: input.idempotency_key,
        });
        return outcome(data, error, versioned);
      } catch {
        console.error("[work-reports] assignment state RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async changeObligation(input) {
      try {
        const { data, error } = await invoke("work_report_change_obligation_status", {
          p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
          p_obligation_id: input.obligation_id, p_expected_version: input.expected_version,
          p_action: input.action, p_reason: input.reason, p_reopened_until: input.reopened_until,
          p_idempotency_key: input.idempotency_key,
        });
        return outcome(data, error, versioned);
      } catch {
        console.error("[work-reports] obligation status RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async materialize(input) {
      try {
        const { data, error } = await invoke("work_report_ensure_obligations_for_window", {
          p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id, p_business_date: input.business_date,
        });
        return outcome(data, error, record);
      } catch {
        console.error("[work-reports] obligation materialization RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
