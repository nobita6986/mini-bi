/**
 * PRE-W2-HF Project↔Team authority (T1A) - Repository for the three mapping
 * admin RPCs. service_role only; Full Admin enforced by each RPC.
 */
import "server-only";

import {
  projectBatchGrantResult,
  projectProjectTeamScopeList,
  projectRevokeResult,
} from "./project-team-scope-contract.ts";
import type {
  ProjectTeamScopeBatchGrantResult,
  ProjectTeamScopeList,
  ProjectTeamScopeRevokeResult,
} from "./project-team-scope-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type ActorRef = { auth_subject: string; app_user_id: string };
export type ProjectTeamScopeOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: ProjectTeamScopeErrorKind };
export type ProjectTeamScopeErrorKind =
  | "conflict" | "denied" | "invalid" | "not-found" | "unavailable";

export type ProjectTeamScopeRepository = {
  listScopes(input: ActorRef & {
    project_id: string | null; team_id: string | null; search: string | null;
    include_history: boolean; page: number; page_size: number;
  }): Promise<ProjectTeamScopeOutcome<ProjectTeamScopeList>>;
  grantScope(input: ActorRef & {
    team_id: string; project_ids: readonly string[];
    reason: string | null; idempotency_key: string;
  }): Promise<ProjectTeamScopeOutcome<ProjectTeamScopeBatchGrantResult>>;
  revokeScope(input: ActorRef & {
    mapping_id: string;
    effective_to: string | null; reason: string | null; idempotency_key: string;
  }): Promise<ProjectTeamScopeOutcome<ProjectTeamScopeRevokeResult>>;
};

export function classifyProjectTeamScopeError(
  error: { code?: string; message?: string },
): ProjectTeamScopeErrorKind {
  if (error.code === "PT409" || error.code === "40001" || error.code === "23505" || error.code === "23P01") return "conflict";
  if (error.code === "42501" || error.code === "55000") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "22023" || error.code === "23514") return "invalid";
  return "unavailable";
}

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

export function createProjectTeamScopeRepository(rpc?: Rpc): ProjectTeamScopeRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function call<T>(
    name: string, args: Record<string, unknown>, project: (data: unknown) => T | null,
  ): Promise<ProjectTeamScopeOutcome<T>> {
    try {
      const { data, error } = await callRpc(name, args);
      if (error) return { ok: false, kind: classifyProjectTeamScopeError(error) };
      const projected = project(data);
      return projected === null ? { ok: false, kind: "unavailable" } : { ok: true, data: projected };
    } catch {
      return { ok: false, kind: "unavailable" };
    }
  }

  return {
    listScopes(input) {
      return call("direct_entry_list_project_team_scopes_admin", {
        p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
        p_project_id: input.project_id, p_team_id: input.team_id, p_search: input.search ?? null,
        p_include_history: input.include_history, p_page: input.page, p_page_size: input.page_size,
      }, projectProjectTeamScopeList);
    },
    grantScope(input) {
      return call("direct_entry_grant_project_team_scopes_batch", {
        p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
        p_team_id: input.team_id, p_project_ids: [...input.project_ids],
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, projectBatchGrantResult);
    },
    revokeScope(input) {
      return call("direct_entry_revoke_project_team_scope", {
        p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
        p_mapping_id: input.mapping_id,
        p_effective_to: input.effective_to, p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, projectRevokeResult);
    },
  };
}
