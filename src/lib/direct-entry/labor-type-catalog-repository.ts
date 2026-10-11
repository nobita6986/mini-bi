/**
 * P3.1-W02C - Repository boundary cho labor type catalog admin (#79).
 *
 * - Chi goi 5 RPC canonical cua migration #79; KHONG doc/ghi table truc tiep.
 * - auth_subject/app_user_id do server context truyen vao, khong bao gio tu client.
 * - DB guard (direct_entry_assert_catalog_operator) van la authority cuoi.
 * - Response duoc project chat; malformed => unavailable (khong bao gio success).
 */
import "server-only";

import {
  laborTypeCatalogCreateResult,
  laborTypeCatalogItem,
  laborTypeCatalogList,
  laborTypeCatalogMutation,
} from "./labor-type-catalog-contract.ts";
import type {
  AdminLaborType,
  AdminLaborTypeCreateResult,
  AdminLaborTypeList,
  AdminLaborTypeMutation,
} from "./labor-type-catalog-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type AdminActorRef = { auth_subject: string; app_user_id: string };

export type LaborTypeCatalogOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: LaborTypeCatalogErrorKind };

export type LaborTypeCatalogErrorKind =
  | "conflict" | "denied" | "invalid" | "not-found" | "unavailable";

export type LaborTypeCatalogRepository = {
  listLaborTypes(input: AdminActorRef & {
    search: string | null; include_inactive: boolean; page: number; page_size: number;
  }): Promise<LaborTypeCatalogOutcome<AdminLaborTypeList>>;
  getLaborType(input: AdminActorRef & { labor_type_key: string }):
    Promise<LaborTypeCatalogOutcome<AdminLaborType>>;
  createLaborType(input: AdminActorRef & {
    expected_version: number; labor_type_key: string; display_name: string;
    sort_order: number; reason: string; idempotency_key: string;
  }): Promise<LaborTypeCatalogOutcome<AdminLaborTypeCreateResult>>;
  updateLaborType(input: AdminActorRef & {
    labor_type_key: string; expected_version: number; display_name: string;
    sort_order: number; reason: string; idempotency_key: string;
  }): Promise<LaborTypeCatalogOutcome<AdminLaborTypeMutation>>;
  setLaborTypeActive(input: AdminActorRef & {
    labor_type_key: string; active: boolean; expected_version: number;
    reason: string; idempotency_key: string;
  }): Promise<LaborTypeCatalogOutcome<AdminLaborTypeMutation>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

/**
 * SQLSTATE -> kind. Chi nhan cac ma RPC #79 thuc su dung:
 *   40001 OCC stale (labor type version)
 *   23505 labor_type_key/reporting_key trung, hoac idempotency key
 *   42501 catalog operator / all scope denied
 *   P0002 labor type not found
 *   23514 key khong ton tai hoac dang inactive (active-write guard)
 *   23503 vi pham FK labor_type (du phong; guard chay truoc)
 *   22023 input sai; rieng message reuse-khac-payload la conflict
 * Moi ma khac => unavailable (fail-closed).
 */
export function classifyLaborTypeCatalogError(
  error: { code?: string; message?: string },
): LaborTypeCatalogErrorKind {
  if (error.code === "40001" || error.code === "23505") return "conflict";
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "23514" || error.code === "23503") return "invalid";
  if (error.code === "22023") {
    return error.message === "idempotency key reused with different input" ? "conflict" : "invalid";
  }
  return "unavailable";
}

function unavailable(): never {
  console.error("[labor-type-catalog] RPC failed");
  throw new Error("labor type catalog RPC failed");
}

export function createLaborTypeCatalogRepository(rpc?: Rpc): LaborTypeCatalogRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function call<T>(
    rpcName: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<LaborTypeCatalogOutcome<T>> {
    try {
      const { data, error } = await callRpc(rpcName, args);
      if (error) return { ok: false, kind: classifyLaborTypeCatalogError(error) };
      const projection = project(data);
      return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
    } catch {
      unavailable();
    }
  }

  return {
    listLaborTypes(input) {
      return call("direct_entry_list_labor_types_admin", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_search: input.search,
        p_include_inactive: input.include_inactive,
        p_page: input.page,
        p_page_size: input.page_size,
      }, laborTypeCatalogList);
    },
    getLaborType(input) {
      return call("direct_entry_get_labor_type_admin", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_labor_type_key: input.labor_type_key,
      }, laborTypeCatalogItem);
    },
    createLaborType(input) {
      return call("direct_entry_create_labor_type", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_expected_version: input.expected_version,
        p_labor_type_key: input.labor_type_key,
        p_display_name: input.display_name,
        p_sort_order: input.sort_order,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, laborTypeCatalogCreateResult);
    },
    updateLaborType(input) {
      return call("direct_entry_update_labor_type", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_labor_type_key: input.labor_type_key,
        p_expected_version: input.expected_version,
        p_display_name: input.display_name,
        p_sort_order: input.sort_order,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, laborTypeCatalogMutation);
    },
    setLaborTypeActive(input) {
      return call("direct_entry_set_labor_type_active", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_labor_type_key: input.labor_type_key,
        p_active: input.active,
        p_expected_version: input.expected_version,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, laborTypeCatalogMutation);
    },
  };
}
