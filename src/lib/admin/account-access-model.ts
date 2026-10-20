/**
 * P3.1-W05-A Existing-account access UI projection and request helpers.
 *
 * The server/API (W03A lifecycle + R2 read) remains the sole authority; this
 * module only validates UI payloads and strictly projects responses. It reuses
 * the canonical contract projectors so the browser can never widen the shape.
 * There is no local account vocabulary, label map or raw-key fallback: only the
 * server-projected `display_name`, optional `login_id` and `enabled` flag are
 * the only identity/status fields surfaced. The
 * opaque `account_ref` is an internal route/request identity and `version` is
 * internal OCC state; neither is a display value.
 *
 * A mutation success is exactly `{ ok: true }` with NO projected row, so an
 * applied result never carries optimistic state — the caller must reload the
 * authoritative detail before unlocking.
 */
import {
  projectExistingAccount,
  projectExistingAccountList,
  type ExistingAccount,
  type ExistingAccountList,
} from "../direct-entry/app-user-access-contract.ts";
import {
  newIdempotencyKey,
  normalizeOptionalActionReason,
  validateReason,
  validateUuid,
  validateVersion,
  type RequestResult,
} from "../direct-entry/project-operations-model.ts";

export const ACCOUNT_LIST_PAGE_SIZE = 25;
const SEARCH_MAX = 256;

export type AccountEnabledFilter = "all" | "true" | "false";
export type AccountListQuery = {
  search: string;
  enabled: AccountEnabledFilter;
  page: number;
};

export type AccountMutationOutcome =
  | { kind: "applied" }
  | { kind: "conflict"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "actor-not-available"; message: string }
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

function errorCode(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.code === "string" ? payload.code : null;
}

export function projectAccountListForQuery(
  payload: unknown,
  query: AccountListQuery,
): ExistingAccountList | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "list"]) || payload.ok !== true) {
    return null;
  }
  const list = projectExistingAccountList(payload.list);
  if (!list) return null;
  const expectedSearch = query.search.trim() || null;
  if (list.search !== expectedSearch || list.enabled !== query.enabled ||
      list.page !== query.page || list.page_size !== ACCOUNT_LIST_PAGE_SIZE) {
    return null;
  }
  return list;
}

export function projectAccountItem(payload: unknown): ExistingAccount | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "account"]) || payload.ok !== true) {
    return null;
  }
  return projectExistingAccount(payload.account);
}

export function buildAccountListQuery(input: AccountListQuery): URLSearchParams | null {
  const search = input.search.trim();
  if (search.length > SEARCH_MAX) return null;
  if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > 1000) return null;
  if (input.enabled !== "all" && input.enabled !== "true" && input.enabled !== "false") return null;
  const query = new URLSearchParams({
    enabled: input.enabled,
    page: String(input.page),
    page_size: String(ACCOUNT_LIST_PAGE_SIZE),
  });
  if (search) query.set("search", search);
  return query;
}

export function buildAccountStateRequest(input: {
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure = validateVersion(input.expectedVersion)
    ?? (input.expectedVersion < 1 ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại." : null)
    ?? validateReason(input.reason)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      expected_version: input.expectedVersion,
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function classifyAccountMutation(
  status: number,
  payload: unknown,
): AccountMutationOutcome {
  if (status === 200) {
    // Success is exactly { ok: true } and carries NO projection. Any extra key
    // (an optimistic row) is treated as malformed so the caller never unlocks
    // on a fabricated state.
    return isRecord(payload) && exactKeys(payload, ["ok"]) && payload.ok === true
      ? { kind: "applied" }
      : { kind: "unavailable", message: "Phản hồi không hợp lệ. Có thể thử lại an toàn." };
  }
  if (status === 401) {
    return { kind: "unauthenticated", message: "Phiên đăng nhập không còn hiệu lực." };
  }
  if (status === 403) {
    return errorCode(payload) === "ACTOR_NOT_AVAILABLE"
      ? { kind: "actor-not-available", message: "Không xác định được tài khoản quản trị của bạn. Hãy tải lại trang." }
      : { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  }
  if (status === 404) return { kind: "not-found", message: "Tài khoản không còn khả dụng." };
  if (status === 409) {
    return { kind: "conflict", message: "Tài khoản đã thay đổi ở nơi khác. Tải lại dữ liệu trước khi tiếp tục." };
  }
  if (status === 400 || status === 422) {
    return { kind: "invalid", message: "Thông tin gửi lên không hợp lệ. Kiểm tra lại các trường." };
  }
  return { kind: "unavailable", message: "Dịch vụ hiện không khả dụng. Có thể thử lại cùng thao tác." };
}

export function newAccountIntentKey(): string {
  return newIdempotencyKey();
}
