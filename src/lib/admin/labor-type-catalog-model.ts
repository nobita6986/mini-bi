/**
 * P3.1-W04-D Labor Type Catalog UI projection and request helpers.
 * The server/API (W02C, RPC #79) remains the sole authority; this module only
 * validates UI payloads and strictly projects responses. There is no local
 * labor-type vocabulary, label map or raw-key fallback: every key and label
 * shown comes from the server projection.
 */
import {
  isCanonicalLaborTypeKey,
  laborTypeCatalogCreateResult,
  laborTypeCatalogItem,
  laborTypeCatalogList,
  laborTypeCatalogMutation,
  type AdminLaborType,
  type AdminLaborTypeCreateResult,
  type AdminLaborTypeList,
  type AdminLaborTypeMutation,
} from "../direct-entry/labor-type-catalog-contract.ts";
import {
  newIdempotencyKey,
  validateReason,
  validateUuid,
  validateVersion,
  type RequestResult,
} from "../direct-entry/project-operations-model.ts";

export const LABOR_TYPE_LIST_PAGE_SIZE = 25;
const SEARCH_MAX = 256;
const NAME_MAX = 256;
const SORT_MAX = 100000;

export type LaborTypeListQuery = { search: string; includeInactive: boolean; page: number };
export type LaborTypeMutationOutcome =
  | { kind: "applied"; laborType: AdminLaborTypeCreateResult | AdminLaborTypeMutation }
  | { kind: "conflict"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function projectLaborTypeListForQuery(
  payload: unknown,
  query: LaborTypeListQuery,
): AdminLaborTypeList | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "list"]) || payload.ok !== true) {
    return null;
  }
  const list = laborTypeCatalogList(payload.list);
  if (!list) return null;
  const expectedSearch = query.search.trim() || null;
  if (list.page !== query.page || list.page_size !== LABOR_TYPE_LIST_PAGE_SIZE ||
      list.include_inactive !== query.includeInactive || list.search !== expectedSearch) {
    return null;
  }
  return list;
}

export function projectLaborTypeItem(payload: unknown): AdminLaborType | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "labor_type"]) || payload.ok !== true) {
    return null;
  }
  return laborTypeCatalogItem(payload.labor_type);
}

export function projectLaborTypeCreate(payload: unknown): AdminLaborTypeCreateResult | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "labor_type"]) || payload.ok !== true) {
    return null;
  }
  return laborTypeCatalogCreateResult(payload.labor_type);
}

export function projectLaborTypeMutation(payload: unknown): AdminLaborTypeMutation | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "labor_type"]) || payload.ok !== true) {
    return null;
  }
  return laborTypeCatalogMutation(payload.labor_type);
}

export function buildLaborTypeListQuery(input: LaborTypeListQuery): URLSearchParams | null {
  const search = input.search.trim();
  if (search.length > SEARCH_MAX || !Number.isSafeInteger(input.page) ||
      input.page < 1 || input.page > 1000) {
    return null;
  }
  const query = new URLSearchParams({
    include_inactive: String(input.includeInactive),
    page: String(input.page),
    page_size: String(LABOR_TYPE_LIST_PAGE_SIZE),
  });
  if (search) query.set("search", search);
  return query;
}

function validateLaborTypeKey(value: string): string | null {
  const key = value.trim();
  if (!key) return "Mã loại hình lao động là bắt buộc.";
  if (!isCanonicalLaborTypeKey(key)) return "Mã loại hình lao động không hợp lệ.";
  return null;
}

function validateDisplayName(value: string): string | null {
  const name = value.trim();
  if (!name) return "Tên hiển thị là bắt buộc.";
  if (name.length > NAME_MAX) return "Tên hiển thị tối đa 256 ký tự.";
  return null;
}

function validateSortOrder(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d{1,6}$/.test(trimmed) || Number(trimmed) > SORT_MAX) {
    return "Thứ tự sắp xếp phải là số nguyên từ 0 đến 100000.";
  }
  return null;
}

export function buildLaborTypeCreateRequest(input: {
  laborTypeKey: string;
  displayName: string;
  sortOrder: string;
  reason: string;
  idempotencyKey: string;
}): RequestResult {
  const failure = validateLaborTypeKey(input.laborTypeKey)
    ?? validateDisplayName(input.displayName)
    ?? validateSortOrder(input.sortOrder)
    ?? validateReason(input.reason)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      expected_version: 0,
      labor_type_key: input.laborTypeKey.trim(),
      display_name: input.displayName.trim(),
      sort_order: Number(input.sortOrder.trim()),
      reason: input.reason,
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildLaborTypeUpdateRequest(input: {
  displayName: string;
  sortOrder: string;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}): RequestResult {
  const failure = validateDisplayName(input.displayName)
    ?? validateSortOrder(input.sortOrder)
    ?? validateVersion(input.expectedVersion)
    ?? (input.expectedVersion < 1 ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại." : null)
    ?? validateReason(input.reason)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      expected_version: input.expectedVersion,
      display_name: input.displayName.trim(),
      sort_order: Number(input.sortOrder.trim()),
      reason: input.reason,
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildLaborTypeSetActiveRequest(input: {
  active: boolean;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
}): RequestResult {
  const failure = typeof input.active !== "boolean"
    ? "Trạng thái không hợp lệ."
    : validateVersion(input.expectedVersion)
      ?? (input.expectedVersion < 1 ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại." : null)
      ?? validateReason(input.reason)
      ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      active: input.active,
      expected_version: input.expectedVersion,
      reason: input.reason,
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function classifyLaborTypeMutation(
  status: number,
  payload: unknown,
  operation: "create" | "update" | "set-active",
): LaborTypeMutationOutcome {
  if (status === 200) {
    const laborType = operation === "create"
      ? projectLaborTypeCreate(payload)
      : projectLaborTypeMutation(payload);
    return laborType
      ? { kind: "applied", laborType }
      : { kind: "unavailable", message: "Phản hồi không hợp lệ. Có thể thử lại an toàn." };
  }
  if (status === 401) return { kind: "unauthenticated", message: "Phiên đăng nhập không còn hiệu lực." };
  if (status === 403) return { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  if (status === 404) return { kind: "not-found", message: "Loại hình lao động không còn khả dụng." };
  if (status === 409) return { kind: "conflict", message: "Loại hình lao động đã thay đổi ở nơi khác. Tải lại dữ liệu trước khi tiếp tục." };
  if (status === 400 || status === 422) return { kind: "invalid", message: "Thông tin gửi lên không hợp lệ. Kiểm tra lại các trường." };
  return { kind: "unavailable", message: "Dịch vụ hiện không khả dụng. Có thể thử lại cùng thao tác." };
}

export function newLaborTypeIntentKey(): string {
  return newIdempotencyKey();
}

export function laborTypeListConfirmsKey(list: AdminLaborTypeList, laborTypeKey: string): boolean {
  return list.labor_types.some((laborType) => laborType.labor_type_key === laborTypeKey);
}
