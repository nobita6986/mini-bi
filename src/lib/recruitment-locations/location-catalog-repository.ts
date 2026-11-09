import "server-only";

import {
  projectAdminIndustrialParkCreateResult,
  projectAdminIndustrialParkList,
  projectAdminIndustrialParkMutation,
  projectAdminProvinceCreateResult,
  projectAdminProvinceList,
  projectAdminProvinceMutation,
} from "./location-catalog-contract.ts";
import type {
  AdminIndustrialParkCreateResult,
  AdminIndustrialParkList,
  AdminIndustrialParkMutation,
  AdminProvinceCreateResult,
  AdminProvinceList,
  AdminProvinceMutation,
} from "./location-catalog-contract.ts";

export type LocationCatalogRpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type LocationCatalogActorRef = {
  auth_subject: string;
  app_user_id: string;
};

export type LocationCatalogErrorKind =
  | "conflict"
  | "denied"
  | "invalid"
  | "not-found"
  | "unavailable";

export type LocationCatalogOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; kind: LocationCatalogErrorKind };

export type LocationCatalogRepository = {
  listProvinces(
    input: LocationCatalogActorRef & {
      search: string | null;
      include_inactive: boolean;
      page: number;
      page_size: number;
    },
  ): Promise<LocationCatalogOutcome<AdminProvinceList>>;
  createProvince(
    input: LocationCatalogActorRef & {
      expected_version: number;
      province_code: string;
      display_name: string;
      reason: string | null;
      idempotency_key: string;
    },
  ): Promise<LocationCatalogOutcome<AdminProvinceCreateResult>>;
  updateProvince(
    input: LocationCatalogActorRef & {
      province_id: string;
      expected_version: number;
      display_name: string;
      reason: string | null;
      idempotency_key: string;
    },
  ): Promise<LocationCatalogOutcome<AdminProvinceMutation>>;
  setProvinceActive(
    input: LocationCatalogActorRef & {
      province_id: string;
      active: boolean;
      expected_version: number;
      reason: string | null;
      idempotency_key: string;
    },
  ): Promise<LocationCatalogOutcome<AdminProvinceMutation>>;
  listIndustrialParks(
    input: LocationCatalogActorRef & {
      province_id: string | null;
      search: string | null;
      include_inactive: boolean;
      page: number;
      page_size: number;
    },
  ): Promise<LocationCatalogOutcome<AdminIndustrialParkList>>;
  createIndustrialPark(
    input: LocationCatalogActorRef & {
      expected_version: number;
      province_id: string;
      industrial_park_code: string;
      display_name: string;
      reason: string | null;
      idempotency_key: string;
    },
  ): Promise<LocationCatalogOutcome<AdminIndustrialParkCreateResult>>;
  updateIndustrialPark(
    input: LocationCatalogActorRef & {
      industrial_park_id: string;
      expected_version: number;
      province_id: string | null;
      display_name: string | null;
      reason: string | null;
      idempotency_key: string;
    },
  ): Promise<LocationCatalogOutcome<AdminIndustrialParkMutation>>;
  setIndustrialParkActive(
    input: LocationCatalogActorRef & {
      industrial_park_id: string;
      active: boolean;
      expected_version: number;
      reason: string | null;
      idempotency_key: string;
    },
  ): Promise<LocationCatalogOutcome<AdminIndustrialParkMutation>>;
};

function serviceRoleRpc(): LocationCatalogRpc {
  const client = import("../supabase/server").then(
    ({ createServiceSupabaseClient }) => createServiceSupabaseClient(),
  );
  return async (name, args) => (await client).rpc(name, args);
}

export function classifyLocationCatalogError(error: {
  code?: string;
  message?: string;
}): LocationCatalogErrorKind {
  if (
    error.code === "PT409" ||
    error.code === "40001" ||
    error.code === "23505"
  ) {
    return "conflict";
  }
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "23514") return "invalid";
  if (error.code === "22023") {
    return error.message === "idempotency key reused with different input"
      ? "conflict"
      : "invalid";
  }
  return "unavailable";
}

export function createLocationCatalogRepository(
  rpc?: LocationCatalogRpc,
): LocationCatalogRepository {
  let resolvedRpc: LocationCatalogRpc | undefined = rpc;
  const callRpc: LocationCatalogRpc = async (name, args) => {
    resolvedRpc ??= serviceRoleRpc();
    return resolvedRpc(name, args);
  };

  async function call<T>(
    rpcName: string,
    args: Record<string, unknown>,
    project: (data: unknown) => T | null,
  ): Promise<LocationCatalogOutcome<T>> {
    try {
      const { data, error } = await callRpc(rpcName, args);
      if (error) {
        return { ok: false, kind: classifyLocationCatalogError(error) };
      }
      const projection = project(data);
      return projection
        ? { ok: true, data: projection }
        : { ok: false, kind: "unavailable" };
    } catch {
      console.error("[location-catalog] RPC failed");
      return { ok: false, kind: "unavailable" };
    }
  }

  return {
    listProvinces(input) {
      return call(
        "administrative_province_list_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_search: input.search,
          p_include_inactive: input.include_inactive,
          p_page: input.page,
          p_page_size: input.page_size,
        },
        projectAdminProvinceList,
      );
    },
    createProvince(input) {
      return call(
        "administrative_province_create_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_expected_version: input.expected_version,
          p_province_code: input.province_code,
          p_display_name: input.display_name,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        },
        projectAdminProvinceCreateResult,
      );
    },
    updateProvince(input) {
      return call(
        "administrative_province_update_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_province_id: input.province_id,
          p_expected_version: input.expected_version,
          p_display_name: input.display_name,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        },
        projectAdminProvinceMutation,
      );
    },
    setProvinceActive(input) {
      return call(
        "administrative_province_set_active_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_province_id: input.province_id,
          p_active: input.active,
          p_expected_version: input.expected_version,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        },
        projectAdminProvinceMutation,
      );
    },
    listIndustrialParks(input) {
      return call(
        "industrial_park_list_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_province_id: input.province_id,
          p_search: input.search,
          p_include_inactive: input.include_inactive,
          p_page: input.page,
          p_page_size: input.page_size,
        },
        projectAdminIndustrialParkList,
      );
    },
    createIndustrialPark(input) {
      return call(
        "industrial_park_create_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_expected_version: input.expected_version,
          p_industrial_park_code: input.industrial_park_code,
          p_province_id: input.province_id,
          p_display_name: input.display_name,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        },
        projectAdminIndustrialParkCreateResult,
      );
    },
    updateIndustrialPark(input) {
      return call(
        "industrial_park_update_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_industrial_park_id: input.industrial_park_id,
          p_expected_version: input.expected_version,
          p_province_id: input.province_id,
          p_display_name: input.display_name,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        },
        projectAdminIndustrialParkMutation,
      );
    },
    setIndustrialParkActive(input) {
      return call(
        "industrial_park_set_active_admin",
        {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_industrial_park_id: input.industrial_park_id,
          p_active: input.active,
          p_expected_version: input.expected_version,
          p_reason: input.reason,
          p_idempotency_key: input.idempotency_key,
        },
        projectAdminIndustrialParkMutation,
      );
    },
  };
}
