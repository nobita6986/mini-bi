/**
 * Phase 4 — Full Admin / BOD Recruitment Location Catalog UI model
 * (Provinces & Industrial Parks).
 *
 * Uses the canonical Phase 1 contract (`location-catalog-contract.ts`) and never
 * sends client-computed `normalized_key` or authority fields.
 */
import {
  newIdempotencyKey,
  normalizeOptionalActionReason,
  validateReason,
  validateUuid,
  validateVersion,
  type RequestResult,
} from "../direct-entry/project-operations-model.ts";
import {
  normalizeIndustrialParkKey,
  normalizeProvinceKey,
  projectAdminIndustrialParkCreateResult,
  projectAdminIndustrialParkList,
  projectAdminIndustrialParkMutation,
  projectAdminProvinceCreateResult,
  projectAdminProvinceList,
  projectAdminProvinceMutation,
  type AdminIndustrialParkCreateResult,
  type AdminIndustrialParkList,
  type AdminIndustrialParkMutation,
  type AdminProvinceCreateResult,
  type AdminProvinceList,
  type AdminProvinceMutation,
} from "../recruitment-locations/location-catalog-contract.ts";

export const LOCATION_CATALOG_PAGE_SIZE = 50;
const SEARCH_MAX = 256;
const NAME_MAX = 256;
const CATALOG_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

export type ProvinceListQuery = {
  search: string;
  includeInactive: boolean;
  page: number;
};

export type IndustrialParkListQuery = {
  provinceId: string;
  search: string;
  includeInactive: boolean;
  page: number;
};

export type ProvinceMutationOutcome =
  | {
      kind: "applied";
      province: AdminProvinceCreateResult | AdminProvinceMutation;
    }
  | { kind: "conflict"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

export type IndustrialParkMutationOutcome =
  | {
      kind: "applied";
      industrialPark:
        | AdminIndustrialParkCreateResult
        | AdminIndustrialParkMutation;
    }
  | { kind: "conflict"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function projectProvinceListForQuery(
  payload: unknown,
  query: ProvinceListQuery,
): AdminProvinceList | null {
  if (
    !isRecord(payload) ||
    !exactKeys(payload, ["ok", "list"]) ||
    payload.ok !== true
  ) {
    return null;
  }
  const list = projectAdminProvinceList(payload.list);
  if (!list) return null;
  const expectedSearch = query.search.trim() || null;
  if (
    list.page !== query.page ||
    list.page_size !== LOCATION_CATALOG_PAGE_SIZE ||
    list.include_inactive !== query.includeInactive ||
    list.search !== expectedSearch
  ) {
    return null;
  }
  return list;
}

export function projectProvinceCreate(
  payload: unknown,
): AdminProvinceCreateResult | null {
  if (
    !isRecord(payload) ||
    !exactKeys(payload, ["ok", "province"]) ||
    payload.ok !== true
  ) {
    return null;
  }
  return projectAdminProvinceCreateResult(payload.province);
}

export function projectProvinceMutation(
  payload: unknown,
): AdminProvinceMutation | null {
  if (
    !isRecord(payload) ||
    !exactKeys(payload, ["ok", "province"]) ||
    payload.ok !== true
  ) {
    return null;
  }
  return projectAdminProvinceMutation(payload.province);
}

export function projectIndustrialParkListForQuery(
  payload: unknown,
  query: IndustrialParkListQuery,
): AdminIndustrialParkList | null {
  if (
    !isRecord(payload) ||
    !exactKeys(payload, ["ok", "list"]) ||
    payload.ok !== true
  ) {
    return null;
  }
  const list = projectAdminIndustrialParkList(payload.list);
  if (!list) return null;
  const expectedSearch = query.search.trim() || null;
  const expectedProvinceId = query.provinceId.trim().toLowerCase() || null;
  if (
    list.page !== query.page ||
    list.page_size !== LOCATION_CATALOG_PAGE_SIZE ||
    list.include_inactive !== query.includeInactive ||
    list.search !== expectedSearch ||
    list.province_id !== expectedProvinceId
  ) {
    return null;
  }
  return list;
}

export function projectIndustrialParkCreate(
  payload: unknown,
): AdminIndustrialParkCreateResult | null {
  if (
    !isRecord(payload) ||
    !exactKeys(payload, ["ok", "industrial_park"]) ||
    payload.ok !== true
  ) {
    return null;
  }
  return projectAdminIndustrialParkCreateResult(payload.industrial_park);
}

export function projectIndustrialParkMutation(
  payload: unknown,
): AdminIndustrialParkMutation | null {
  if (
    !isRecord(payload) ||
    !exactKeys(payload, ["ok", "industrial_park"]) ||
    payload.ok !== true
  ) {
    return null;
  }
  return projectAdminIndustrialParkMutation(payload.industrial_park);
}

export function buildProvinceListQuery(
  input: ProvinceListQuery,
): URLSearchParams | null {
  const search = input.search.trim();
  if (
    search.length > SEARCH_MAX ||
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    input.page > 1000
  ) {
    return null;
  }
  const query = new URLSearchParams({
    include_inactive: String(input.includeInactive),
    page: String(input.page),
    page_size: String(LOCATION_CATALOG_PAGE_SIZE),
  });
  if (search) query.set("search", search);
  return query;
}

export function buildIndustrialParkListQuery(
  input: IndustrialParkListQuery,
): URLSearchParams | null {
  const search = input.search.trim();
  const provinceId = input.provinceId.trim().toLowerCase();
  if (
    search.length > SEARCH_MAX ||
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    input.page > 1000
  ) {
    return null;
  }
  if (provinceId && validateUuid(provinceId)) {
    return null;
  }
  const query = new URLSearchParams({
    include_inactive: String(input.includeInactive),
    page: String(input.page),
    page_size: String(LOCATION_CATALOG_PAGE_SIZE),
  });
  if (provinceId) query.set("province_id", provinceId);
  if (search) query.set("search", search);
  return query;
}

function validateCatalogCode(value: string, label: string): string | null {
  const code = value.trim().toUpperCase();
  if (!code) return `${label} là bắt buộc.`;
  if (!CATALOG_CODE_PATTERN.test(code)) {
    return `${label} không hợp lệ (2–64 ký tự A-Z, 0-9, dấu gạch dưới _, bắt đầu bằng chữ cái).`;
  }
  return null;
}

function validateProvinceDisplayName(value: string): string | null {
  const name = value.trim();
  if (!name) return "Tên hiển thị Tỉnh/Thành là bắt buộc.";
  if (name.length > NAME_MAX) return "Tên hiển thị Tỉnh/Thành tối đa 256 ký tự.";
  if (!normalizeProvinceKey(name)) {
    return "Tên hiển thị Tỉnh/Thành phải chứa ký tự chữ hoặc số hợp lệ sau khi chuẩn hóa.";
  }
  return null;
}

function validateIndustrialParkDisplayName(value: string): string | null {
  const name = value.trim();
  if (!name) return "Tên hiển thị Khu công nghiệp là bắt buộc.";
  if (name.length > NAME_MAX) {
    return "Tên hiển thị Khu công nghiệp tối đa 256 ký tự.";
  }
  if (!normalizeIndustrialParkKey(name)) {
    return "Tên hiển thị Khu công nghiệp phải chứa ký tự chữ hoặc số hợp lệ sau khi chuẩn hóa.";
  }
  return null;
}

export function buildProvinceCreateRequest(input: {
  provinceCode: string;
  displayName: string;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure =
    validateCatalogCode(input.provinceCode, "Mã Tỉnh/Thành") ??
    validateProvinceDisplayName(input.displayName) ??
    validateReason(input.reason) ??
    validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      expected_version: 0,
      province_code: input.provinceCode.trim().toUpperCase(),
      display_name: input.displayName.trim(),
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildProvinceUpdateRequest(input: {
  displayName: string;
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure =
    validateProvinceDisplayName(input.displayName) ??
    validateVersion(input.expectedVersion) ??
    (input.expectedVersion < 1
      ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại."
      : null) ??
    validateReason(input.reason) ??
    validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      expected_version: input.expectedVersion,
      display_name: input.displayName.trim(),
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildLocationSetActiveRequest(input: {
  active: boolean;
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure =
    typeof input.active !== "boolean"
      ? "Trạng thái không hợp lệ."
      : (validateVersion(input.expectedVersion) ??
        (input.expectedVersion < 1
          ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại."
          : null) ??
        validateReason(input.reason) ??
        validateUuid(input.idempotencyKey));
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      active: input.active,
      expected_version: input.expectedVersion,
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildIndustrialParkCreateRequest(input: {
  provinceId: string;
  industrialParkCode: string;
  displayName: string;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const normalizedProvinceId = input.provinceId.trim().toLowerCase();
  const provinceFailure = !normalizedProvinceId
    ? "Vui lòng chọn Tỉnh/Thành trực thuộc."
    : validateUuid(normalizedProvinceId)
      ? "Tỉnh/Thành đã chọn không hợp lệ."
      : null;
  const failure =
    provinceFailure ??
    validateCatalogCode(input.industrialParkCode, "Mã Khu công nghiệp") ??
    validateIndustrialParkDisplayName(input.displayName) ??
    validateReason(input.reason) ??
    validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      expected_version: 0,
      province_id: normalizedProvinceId,
      industrial_park_code: input.industrialParkCode.trim().toUpperCase(),
      display_name: input.displayName.trim(),
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildIndustrialParkUpdateRequest(input: {
  provinceId: string;
  displayName: string;
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const normalizedProvinceId = input.provinceId.trim().toLowerCase();
  const provinceFailure = !normalizedProvinceId
    ? "Vui lòng chọn Tỉnh/Thành trực thuộc."
    : validateUuid(normalizedProvinceId)
      ? "Tỉnh/Thành đã chọn không hợp lệ."
      : null;
  const failure =
    provinceFailure ??
    validateIndustrialParkDisplayName(input.displayName) ??
    validateVersion(input.expectedVersion) ??
    (input.expectedVersion < 1
      ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại."
      : null) ??
    validateReason(input.reason) ??
    validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      expected_version: input.expectedVersion,
      province_id: normalizedProvinceId,
      display_name: input.displayName.trim(),
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function classifyProvinceMutation(
  status: number,
  payload: unknown,
  operation: "create" | "update" | "set-active",
): ProvinceMutationOutcome {
  if (status === 200) {
    const province =
      operation === "create"
        ? projectProvinceCreate(payload)
        : projectProvinceMutation(payload);
    return province
      ? { kind: "applied", province }
      : {
          kind: "unavailable",
          message: "Phản hồi không hợp lệ. Có thể thử lại an toàn.",
        };
  }
  if (status === 401) {
    return {
      kind: "unauthenticated",
      message: "Phiên đăng nhập không còn hiệu lực.",
    };
  }
  if (status === 403) {
    return {
      kind: "denied",
      message: "Bạn không có quyền quản trị danh mục Tỉnh/Thành.",
    };
  }
  if (status === 404) {
    return {
      kind: "not-found",
      message: "Tỉnh/Thành không còn khả dụng.",
    };
  }
  if (status === 409) {
    return {
      kind: "conflict",
      message:
        operation === "create" || operation === "update"
          ? "Mã Tỉnh/Thành, tên chuẩn hóa bị trùng hoặc dữ liệu đã thay đổi ở nơi khác. Vui lòng tải lại dữ liệu trước khi tiếp tục."
          : "Tỉnh/Thành đang còn Khu công nghiệp đang hoạt động hoặc dữ liệu đã thay đổi ở nơi khác. Vui lòng tải lại dữ liệu.",
    };
  }
  if (status === 400 || status === 422) {
    return {
      kind: "invalid",
      message: "Thông tin Tỉnh/Thành gửi lên không hợp lệ. Kiểm tra lại các trường.",
    };
  }
  return {
    kind: "unavailable",
    message: "Dịch vụ hiện không khả dụng. Có thể thử lại cùng thao tác.",
  };
}

export function classifyIndustrialParkMutation(
  status: number,
  payload: unknown,
  operation: "create" | "update" | "set-active",
): IndustrialParkMutationOutcome {
  if (status === 200) {
    const industrialPark =
      operation === "create"
        ? projectIndustrialParkCreate(payload)
        : projectIndustrialParkMutation(payload);
    return industrialPark
      ? { kind: "applied", industrialPark }
      : {
          kind: "unavailable",
          message: "Phản hồi không hợp lệ. Có thể thử lại an toàn.",
        };
  }
  if (status === 401) {
    return {
      kind: "unauthenticated",
      message: "Phiên đăng nhập không còn hiệu lực.",
    };
  }
  if (status === 403) {
    return {
      kind: "denied",
      message: "Bạn không có quyền quản trị danh mục Khu công nghiệp.",
    };
  }
  if (status === 404) {
    return {
      kind: "not-found",
      message: "Khu công nghiệp hoặc Tỉnh/Thành không còn khả dụng.",
    };
  }
  if (status === 409) {
    return {
      kind: "conflict",
      message:
        operation === "set-active"
          ? "Không thể ngừng hoạt động / đổi trạng thái KCN: KCN đang được dùng bởi tin tuyển dụng đang hiệu lực (PUBLISHED), Tỉnh/Thành đang ngừng hoạt động, hoặc dữ liệu đã thay đổi. Vui lòng rút/cập nhật tin liên quan hoặc tải lại dữ liệu."
          : "Mã KCN, tên chuẩn hóa trong cùng Tỉnh/Thành bị trùng hoặc dữ liệu đã thay đổi ở nơi khác. Vui lòng tải lại dữ liệu trước khi tiếp tục.",
    };
  }
  if (status === 400 || status === 422) {
    return {
      kind: "invalid",
      message:
        "Thông tin Khu công nghiệp gửi lên không hợp lệ. Kiểm tra lại các trường.",
    };
  }
  return {
    kind: "unavailable",
    message: "Dịch vụ hiện không khả dụng. Có thể thử lại cùng thao tác.",
  };
}

export function newLocationCatalogIntentKey(): string {
  return newIdempotencyKey();
}

export function provinceListConfirmsCode(
  list: AdminProvinceList,
  provinceCode: string,
): boolean {
  const normalized = provinceCode.trim().toUpperCase();
  return list.provinces.some((item) => item.province_code === normalized);
}

export function industrialParkListConfirmsCode(
  list: AdminIndustrialParkList,
  industrialParkCode: string,
): boolean {
  const normalized = industrialParkCode.trim().toUpperCase();
  return list.industrial_parks.some(
    (item) => item.industrial_park_code === normalized,
  );
}
