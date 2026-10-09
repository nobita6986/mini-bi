/**
 * P3.1-W01C-A - Repository boundary cho team master catalog admin (#69).
 *
 * - Chi goi 5 RPC canonical cua migration #69; KHONG doc/ghi table truc tiep.
 * - auth_subject/app_user_id do server context truyen vao, khong bao gio tu client.
 * - DB guard (direct_entry_assert_catalog_operator tu #68) van la authority cuoi.
 * - Response duoc project chat; malformed => unavailable (khong bao gio success).
 */
import "server-only";

import {
  teamCatalogCreateResult,
  teamCatalogItem,
  teamCatalogList,
  teamCatalogMutation,
} from "./team-catalog-contract.ts";
import type {
  AdminTeam,
  AdminTeamCreateResult,
  AdminTeamList,
  AdminTeamMutation,
} from "./team-catalog-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type AdminActorRef = { auth_subject: string; app_user_id: string };

export type TeamCatalogOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: TeamCatalogErrorKind };

export type TeamCatalogErrorKind =
  | "conflict" | "denied" | "invalid" | "not-found" | "unavailable";

export type TeamCatalogRepository = {
  listTeams(input: AdminActorRef & {
    search: string | null; include_inactive: boolean; page: number; page_size: number;
  }): Promise<TeamCatalogOutcome<AdminTeamList>>;
  getTeam(input: AdminActorRef & { team_id: string }): Promise<TeamCatalogOutcome<AdminTeam>>;
  createTeam(input: AdminActorRef & {
    expected_version: number; code: string; display_name: string;
    reason: string; idempotency_key: string;
  }): Promise<TeamCatalogOutcome<AdminTeamCreateResult>>;
  updateTeam(input: AdminActorRef & {
    team_id: string; expected_version: number; display_name: string;
    reason: string; idempotency_key: string;
  }): Promise<TeamCatalogOutcome<AdminTeamMutation>>;
  setTeamActive(input: AdminActorRef & {
    team_id: string; active: boolean; expected_version: number;
    reason: string; idempotency_key: string;
  }): Promise<TeamCatalogOutcome<AdminTeamMutation>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

/**
 * SQLSTATE -> kind. Chi nhan cac ma RPC #69 thuc su dung:
 *   40001 OCC stale (team version)
 *   23505 code trung (unique) hoac idempotency key
 *   42501 catalog operator / all scope denied
 *   P0002 team not found hoac reserved __system_vendor__ team
 *   23514 rang buoc du lieu
 *   22023 input sai; rieng message reuse-khac-payload la conflict
 * Moi ma khac => unavailable (fail-closed).
 */
export function classifyTeamCatalogError(
  error: { code?: string; message?: string },
): TeamCatalogErrorKind {
  if (error.code === "40001" || error.code === "23505") return "conflict";
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "23514") return "invalid";
  if (error.code === "22023") {
    return error.message === "idempotency key reused with different input" ? "conflict" : "invalid";
  }
  return "unavailable";
}

function unavailable(): never {
  console.error("[team-catalog] RPC failed");
  throw new Error("team catalog RPC failed");
}

export function createTeamCatalogRepository(rpc?: Rpc): TeamCatalogRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function call<T>(
    rpcName: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<TeamCatalogOutcome<T>> {
    try {
      const { data, error } = await callRpc(rpcName, args);
      if (error) return { ok: false, kind: classifyTeamCatalogError(error) };
      const projection = project(data);
      return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
    } catch {
      unavailable();
    }
  }

  return {
    listTeams(input) {
      return call("direct_entry_list_teams_admin", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_search: input.search,
        p_include_inactive: input.include_inactive,
        p_page: input.page,
        p_page_size: input.page_size,
      }, teamCatalogList);
    },
    getTeam(input) {
      return call("direct_entry_get_team_admin", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_team_id: input.team_id,
      }, teamCatalogItem);
    },
    createTeam(input) {
      return call("direct_entry_create_team", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_expected_version: input.expected_version,
        p_code: input.code,
        p_display_name: input.display_name,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, teamCatalogCreateResult);
    },
    updateTeam(input) {
      return call("direct_entry_update_team", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_team_id: input.team_id,
        p_expected_version: input.expected_version,
        p_display_name: input.display_name,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, teamCatalogMutation);
    },
    setTeamActive(input) {
      return call("direct_entry_set_team_active", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_team_id: input.team_id,
        p_active: input.active,
        p_expected_version: input.expected_version,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, teamCatalogMutation);
    },
  };
}
