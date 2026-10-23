import "server-only";

import { parseOffboardingReportExport, parseOffboardingReportList, type OffboardingReportExport, type OffboardingReportList } from "./offboarding-report-contract";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type OffboardingActorRef = { auth_subject: string; app_user_id: string };
export type OffboardingOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "denied" | "invalid" | "unavailable" };

export type OffboardingReportRepository = {
  list(input: OffboardingActorRef & { page: number; page_size: number }): Promise<OffboardingOutcome<OffboardingReportList>>;
  export(input: OffboardingActorRef): Promise<OffboardingOutcome<OffboardingReportExport>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("@/lib/supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient(),
  );
  return async (name, args) => (await client).rpc(name, args);
}

function classify(error: { code?: string; message?: string }): "denied" | "invalid" | "unavailable" {
  if (error?.code === "42501") return "denied";
  if (error?.code === "22023") return "invalid";
  return "unavailable";
}

export function createOffboardingReportRepository(rpc?: Rpc): OffboardingReportRepository {
  let call = rpc;
  const invoke: Rpc = async (name, args) => {
    call ??= serviceRoleRpc();
    return call(name, args);
  };

  async function run<T>(
    name: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<OffboardingOutcome<T>> {
    try {
      const { data, error } = await invoke(name, args);
      if (error) return { ok: false, kind: classify(error) };
      const parsed = project(data);
      return parsed === null ? { ok: false, kind: "unavailable" } : { ok: true, data: parsed };
    } catch {
      return { ok: false, kind: "unavailable" };
    }
  }

  return {
    list(input) {
      return run("direct_entry_offboarding_report", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_page: input.page,
        p_page_size: input.page_size,
      }, parseOffboardingReportList);
    },
    export(input) {
      return run("direct_entry_offboarding_report_export", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
      }, parseOffboardingReportExport);
    },
  };
}
