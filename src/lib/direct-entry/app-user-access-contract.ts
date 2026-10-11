const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASON_MAX = 4000;

export type ExistingAccount = {
  account_ref: string;
  display_name: string;
  enabled: boolean;
  version: number;
};
export type ExistingAccountList = {
  search: string | null;
  enabled: "all" | "true" | "false";
  page: number;
  page_size: number;
  total: number;
  accounts: ExistingAccount[];
};

export type AccountListQuery = {
  search: string | null;
  enabled: "all" | "true" | "false";
  page: number;
  page_size: number;
};

export type AccountAccessParsed<T> =
  | { ok: true; value: T }
  | { ok: false; code: "ACCOUNT_INVALID" };

export function projectExistingAccount(value: unknown): ExistingAccount | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "account_ref,display_name,enabled,version") return null;
  if (typeof row.account_ref !== "string" || !UUID.test(row.account_ref)) return null;
  if (typeof row.display_name !== "string" || row.display_name !== row.display_name.trim() ||
      row.display_name === "" || row.display_name.length > 256) return null;
  if (typeof row.enabled !== "boolean" || typeof row.version !== "number" ||
      !Number.isSafeInteger(row.version) || row.version < 1) return null;
  return {
    account_ref: row.account_ref,
    display_name: row.display_name,
    enabled: row.enabled,
    version: row.version,
  };
}

export function projectExistingAccountList(value: unknown): ExistingAccountList | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).sort().join(",") !== "accounts,enabled,page,page_size,search,total") return null;
  if (envelope.search !== null && (typeof envelope.search !== "string" ||
      envelope.search !== envelope.search.trim() || envelope.search === "" || envelope.search.length > 256)) return null;
  if (envelope.enabled !== "all" && envelope.enabled !== "true" && envelope.enabled !== "false") return null;
  if (typeof envelope.page !== "number" || !Number.isSafeInteger(envelope.page) || envelope.page < 1) return null;
  if (typeof envelope.page_size !== "number" || !Number.isSafeInteger(envelope.page_size) || envelope.page_size < 1 || envelope.page_size > 100) return null;
  if (typeof envelope.total !== "number" || !Number.isSafeInteger(envelope.total) || envelope.total < 0 || !Array.isArray(envelope.accounts)) return null;
  const accounts = envelope.accounts.map(projectExistingAccount);
  if (accounts.some((account) => account === null)) return null;
  return {
    search: envelope.search,
    enabled: envelope.enabled,
    page: envelope.page,
    page_size: envelope.page_size,
    total: envelope.total,
    accounts: accounts as ExistingAccount[],
  };
}

function exact(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).sort().join(",") === [...keys].sort().join(",");
}
function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= max ? value : null;
}
function integer(value: unknown, min: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : null;
}

export function parseAccountListQuery(url: URL): AccountAccessParsed<AccountListQuery> {
  const allowed = new Set(["search", "enabled", "page", "page_size"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) return { ok: false, code: "ACCOUNT_INVALID" };
  for (const key of allowed) if (url.searchParams.getAll(key).length > 1) return { ok: false, code: "ACCOUNT_INVALID" };
  const rawSearch = url.searchParams.get("search");
  if (rawSearch !== null && (rawSearch.trim() === "" || rawSearch.length > 256)) return { ok: false, code: "ACCOUNT_INVALID" };
  const search = rawSearch === null ? null : rawSearch.trim();
  const enabled = url.searchParams.get("enabled") ?? "all";
  if (enabled !== "all" && enabled !== "true" && enabled !== "false") return { ok: false, code: "ACCOUNT_INVALID" };
  const rawPage = url.searchParams.get("page") ?? "1";
  const rawPageSize = url.searchParams.get("page_size") ?? "25";
  if (!/^\d{1,6}$/.test(rawPage) || !/^\d{1,6}$/.test(rawPageSize)) return { ok: false, code: "ACCOUNT_INVALID" };
  const page = Number(rawPage);
  const page_size = Number(rawPageSize);
  if (page < 1 || page > 1000 || page_size < 1 || page_size > 100) return { ok: false, code: "ACCOUNT_INVALID" };
  return { ok: true, value: { search, enabled, page, page_size } };
}

export type AccountMutationRequest = {
  expected_version: number;
  reason: string;
  idempotency_key: string;
};

export function parseAccountMutation(body: unknown): AccountAccessParsed<AccountMutationRequest> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, code: "ACCOUNT_INVALID" };
  const record = body as Record<string, unknown>;
  if (!exact(record, ["expected_version", "reason", "idempotency_key"])) return { ok: false, code: "ACCOUNT_INVALID" };
  const expected_version = integer(record.expected_version, 1);
  const reason = text(record.reason, REASON_MAX);
  const idempotency_key = typeof record.idempotency_key === "string" && UUID.test(record.idempotency_key)
    ? record.idempotency_key : null;
  if (expected_version === null || reason === null || idempotency_key === null) return { ok: false, code: "ACCOUNT_INVALID" };
  return { ok: true, value: { expected_version, reason, idempotency_key } };
}

export function parseAccountRef(value: string): string | null {
  return UUID.test(value) ? value : null;
}
