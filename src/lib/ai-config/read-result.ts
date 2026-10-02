/**
 * P1.5-W04A-R1/R2 (C) — Chuẩn hoá kết quả đọc RPC + validate row: PHÂN BIỆT ba trạng thái.
 *
 *   1. `{ ok:true, ... }`  — đọc thành công (giá trị có thể null = KHÔNG có cấu hình, phải TƯỜNG MINH);
 *   2. `{ ok:false, code:<code DB non-empty> }` — RPC từ chối hợp lệ (đã sanitize);
 *   3. `{ ok:false, code:"AI_INTERNAL" }` — lỗi DB/transport/malformed (kể cả envelope RPC sai kiểu).
 *
 * R2 (A): success CHỈ hợp lệ khi `payload.ok === true` — payload THIẾU `ok`, `ok` sai kiểu
 * (`null`/`"true"`/`1`), array hoặc malformed ⇒ AI_INTERNAL. Không fallback ngầm cho consumer nào.
 * R2 (B): `config` phải TƯỜNG MINH `null` mới là "chưa cấu hình"; thiếu property/undefined/array/
 * primitive/object thiếu field ⇒ AI_INTERNAL. Row non-null được validate đầy đủ theo ProviderConfig.
 */

import { assertValidConfig, isSanitizedHost, type ProviderConfig } from "./config-contract.ts";

export type RpcFail = { ok: false; code: string; message: string };

/** Thông điệp an toàn: một dòng, không ký tự điều khiển, tối đa 200 ký tự. */
export function sanitizeMessage(message: unknown, fallback: string): string {
  const text = typeof message === "string" ? message.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  return text === "" ? fallback : text.slice(0, 200);
}

export function internalFail(name: string, reason: string): RpcFail {
  return { ok: false, code: "AI_INTERNAL", message: "rpc " + name + " " + reason };
}

/**
 * `client.rpc()` trả { data, error } (hoặc ném) ⇒ chuẩn hoá.
 * R2 (A): envelope phải có `ok` boolean TƯỜNG MINH.
 */
export function classifyRpcResponse(name: string, response: unknown): { ok: true; value: Record<string, unknown> } | RpcFail {
  if (response === null || response === undefined || typeof response !== "object") {
    return internalFail(name, "trả về không hợp lệ");
  }
  const record = response as { data?: unknown; error?: unknown };
  if (record.error) return internalFail(name, "thất bại");
  const data = record.data;
  if (data === null || data === undefined || typeof data !== "object" || Array.isArray(data)) {
    return internalFail(name, "trả dữ liệu rỗng hoặc sai kiểu");
  }
  const payload = data as Record<string, unknown>;
  if (payload.ok === false) {
    // Từ chối hợp lệ PHẢI có code non-empty; thiếu/sai kiểu ⇒ KHÔNG phải refusal hợp lệ.
    if (typeof payload.code !== "string" || payload.code.trim() === "") {
      return internalFail(name, "từ chối nhưng thiếu code");
    }
    return { ok: false, code: payload.code, message: sanitizeMessage(payload.message, "rpc " + name + " từ chối") };
  }
  if (payload.ok !== true) {
    // R2 (A): thiếu ok / ok = null | "true" | 1 | … ⇒ malformed envelope, KHÔNG được coi là success.
    return internalFail(name, "envelope thiếu ok=true tường minh");
  }
  return { ok: true, value: payload };
}

/** Mã mà `ai_provider_config_active` dùng để báo "chưa có cấu hình active" (trạng thái HỢP LỆ). */
export const NO_ACTIVE_CONFIG_CODE = "AI_CONFIG_REQUIRED";

export type ActiveConfigProjection = {
  config_id: string;
  provider_profile: string;
  model: string;
  version: number;
  status: string;
  verified_at: string | null;
  sanitized_host: string;
};

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * R3 (A) — Projection active FAIL-CLOSED: payload phải có ĐỦ và ĐÚNG ĐỊNH DẠNG mọi field.
 *
 * Config active bắt buộc ĐÃ verified ⇒ `verified_at` phải là timestamp hợp lệ và KHÁC null.
 * Thiếu/sai kiểu/sai định dạng bất kỳ field nào ⇒ AI_INTERNAL (KHÔNG phải AI_CONFIG_REQUIRED,
 * KHÔNG được coi là "chưa có cấu hình", KHÔNG enqueue job).
 */
export function projectActiveConfig(value: Record<string, unknown>): { ok: true; config: ActiveConfigProjection | null } | RpcFail {
  if (value.ok !== true) return internalFail("active", "envelope thiếu ok=true tường minh");

  const configId = value.config_id;
  if (typeof configId !== "string" || !SAFE_ID.test(configId)) {
    return internalFail("active", "thiếu/sai config_id");
  }
  const providerProfile = value.provider_profile;
  if (typeof providerProfile !== "string" || !SAFE_ID.test(providerProfile)) {
    return internalFail("active", "thiếu/sai provider_profile");
  }
  const model = value.model;
  if (typeof model !== "string" || model.trim() === "" || model.trim() !== model || model.length > 256 || /[\u0000-\u001f\u007f]/.test(model)) {
    return internalFail("active", "thiếu/sai model");
  }
  const version = value.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    return internalFail("active", "thiếu/sai version");
  }
  const sanitizedHost = value.sanitized_host;
  if (typeof sanitizedHost !== "string" || sanitizedHost === "" || !isSanitizedHost(sanitizedHost)) {
    return internalFail("active", "thiếu/sai sanitized_host");
  }
  const verifiedAt = value.verified_at;
  if (typeof verifiedAt !== "string" || verifiedAt === "" || Number.isNaN(Date.parse(verifiedAt))) {
    return internalFail("active", "thiếu/sai verified_at của config active");
  }

  return {
    ok: true,
    config: {
      config_id: configId,
      provider_profile: providerProfile,
      model,
      version,
      status: "active",
      verified_at: verifiedAt,
      sanitized_host: sanitizedHost,
    },
  };
}

/**
 * R2 (B) — Row config đọc từ DB:
 * - property `config` PHẢI tồn tại: `null` tường minh = chưa cấu hình (trạng thái hợp lệ);
 *   thiếu property / `undefined` / array / primitive / object thiếu field ⇒ AI_INTERNAL.
 * - Row non-null phải validate đầy đủ theo ProviderConfig (field + envelope/AAD bindings).
 */
export function validateConfigRow(name: string, value: Record<string, unknown>): { ok: true; config: ProviderConfig | null } | RpcFail {
  if (!Object.prototype.hasOwnProperty.call(value, "config")) {
    return internalFail(name, "thiếu property config (không được coi là chưa cấu hình)");
  }
  const row = value.config;
  if (row === null) return { ok: true, config: null };
  if (row === undefined) return internalFail(name, "config = undefined");
  if (typeof row !== "object" || Array.isArray(row)) return internalFail(name, "config sai kiểu");

  const config = rowToConfig(row as Record<string, unknown>);
  if (!config) return internalFail(name, "config sai kiểu");
  try {
    assertValidConfig(config);
  } catch {
    // Validator throw (SecurityError) ⇒ sanitized AI_INTERNAL, KHÔNG để throw thoát ra route.
    return internalFail(name, "config không hợp lệ theo ProviderConfig");
  }
  return { ok: true, config };
}

/** Row (jsonb từ Postgres) → domain ProviderConfig (envelope giữ nguyên dạng object). */
export function rowToConfig(row: unknown): ProviderConfig | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  if (typeof record.config_id !== "string" || record.config_id === "") return null;
  return {
    config_id: record.config_id,
    provider_profile: record.provider_profile as string,
    api_base_url: record.api_base_url as string,
    model: record.model as string,
    encrypted_secret: record.envelope as ProviderConfig["encrypted_secret"],
    version: record.version as number,
    status: record.status as ProviderConfig["status"],
    verified_at: (record.verified_at ?? null) as string | null,
    updated_at: record.updated_at as string,
    sanitized_host: record.sanitized_host as string,
    key_fingerprint: record.key_fingerprint as string,
    optimistic_version: record.optimistic_version as number,
  };
}
