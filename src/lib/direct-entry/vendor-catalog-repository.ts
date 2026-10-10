/**
 * P3.1-W02-B - Repository boundary cho vendor master catalog admin (#75).
 *
 * - Chi goi 5 RPC canonical cua migration #75; KHONG doc/ghi table truc tiep.
 * - auth_subject/app_user_id do server context truyen vao, khong bao gio tu client.
 * - DB guard (direct_entry_assert_catalog_operator tu #68) van la authority cuoi.
 * - Response duoc project chat; malformed => unavailable (khong bao gio success).
 */
import "server-only";

import {
  vendorCatalogCreateResult,
  vendorCatalogItem,
  vendorCatalogList,
  vendorCatalogMutation,
} from "./vendor-catalog-contract.ts";
import type {
  AdminVendor,
  AdminVendorCreateResult,
  AdminVendorList,
  AdminVendorMutation,
} from "./vendor-catalog-contract.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type AdminActorRef = { auth_subject: string; app_user_id: string };

export type VendorCatalogOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: VendorCatalogErrorKind };

export type VendorCatalogErrorKind =
  | "conflict" | "denied" | "invalid" | "not-found" | "unavailable";

export type VendorCatalogRepository = {
  listVendors(input: AdminActorRef & {
    search: string | null; include_inactive: boolean; page: number; page_size: number;
  }): Promise<VendorCatalogOutcome<AdminVendorList>>;
  getVendor(input: AdminActorRef & { vendor_id: string }): Promise<VendorCatalogOutcome<AdminVendor>>;
  createVendor(input: AdminActorRef & {
    expected_version: 0; vendor_id: string; display_name: string; valid_from: string;
    reason: string; idempotency_key: string;
  }): Promise<VendorCatalogOutcome<AdminVendorCreateResult>>;
  updateVendor(input: AdminActorRef & {
    vendor_id: string; expected_version: number; display_name: string;
    reason: string; idempotency_key: string;
  }): Promise<VendorCatalogOutcome<AdminVendorMutation>>;
  setVendorActive(input: AdminActorRef & {
    vendor_id: string; active: boolean; expected_version: number;
    reason: string; idempotency_key: string;
  }): Promise<VendorCatalogOutcome<AdminVendorMutation>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (name, args) => (await client).rpc(name, args);
}

/**
 * SQLSTATE -> kind. Chi nhan cac ma RPC #75 thuc su dung:
 *   40001 OCC stale (vendor version)
 *   23505 vendor_id trung (unique) hoac idempotency key
 *   42501 catalog operator / all scope denied
 *   P0002 vendor not found hoac reserved __system_vendor__
 *   23514 rang buoc du lieu
 *   22023 input sai; rieng message reuse-khac-payload la conflict
 * Moi ma khac => unavailable (fail-closed).
 */
export function classifyVendorCatalogError(
  error: { code?: string; message?: string },
): VendorCatalogErrorKind {
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
  console.error("[vendor-catalog] RPC failed");
  throw new Error("vendor catalog RPC failed");
}

export function createVendorCatalogRepository(rpc?: Rpc): VendorCatalogRepository {
  let resolvedRpc: Rpc | undefined = rpc;
  const callRpc: Rpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function call<T>(
    rpcName: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<VendorCatalogOutcome<T>> {
    try {
      const { data, error } = await callRpc(rpcName, args);
      if (error) return { ok: false, kind: classifyVendorCatalogError(error) };
      const projection = project(data);
      return projection ? { ok: true, data: projection } : { ok: false, kind: "unavailable" };
    } catch {
      unavailable();
    }
  }

  return {
    listVendors(input) {
      return call("direct_entry_list_vendors_admin", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_search: input.search,
        p_include_inactive: input.include_inactive,
        p_page: input.page,
        p_page_size: input.page_size,
      }, vendorCatalogList);
    },
    getVendor(input) {
      return call("direct_entry_get_vendor_admin", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_vendor_id: input.vendor_id,
      }, vendorCatalogItem);
    },
    createVendor(input) {
      return call("direct_entry_create_vendor", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_expected_version: input.expected_version,
        p_vendor_id: input.vendor_id,
        p_display_name: input.display_name,
        p_valid_from: input.valid_from,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, vendorCatalogCreateResult);
    },
    updateVendor(input) {
      return call("direct_entry_update_vendor", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_vendor_id: input.vendor_id,
        p_expected_version: input.expected_version,
        p_display_name: input.display_name,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, vendorCatalogMutation);
    },
    setVendorActive(input) {
      return call("direct_entry_set_vendor_active", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
        p_vendor_id: input.vendor_id,
        p_active: input.active,
        p_expected_version: input.expected_version,
        p_reason: input.reason,
        p_idempotency_key: input.idempotency_key,
      }, vendorCatalogMutation);
    },
  };
}
