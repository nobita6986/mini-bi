/**
 * P1.5-W04A-R1 (C) — Chuẩn hoá kết quả đọc RPC: PHÂN BIỆT ba trạng thái.
 *
 *   1. `{ ok:true, ... }`  — đọc thành công (giá trị có thể null = KHÔNG có cấu hình);
 *   2. `{ ok:false, code:<code DB> }` — RPC từ chối hợp lệ (đã sanitize);
 *   3. `{ ok:false, code:"AI_INTERNAL" }` — lỗi DB/transport/malformed response.
 *
 * Không bao giờ biến (2)/(3) thành null ("not configured" giả) và không trả raw Supabase error.
 */

export type RpcFail = { ok: false; code: string; message: string };

/** Thông điệp an toàn: một dòng, không ký tự điều khiển, tối đa 200 ký tự. */
export function sanitizeMessage(message: unknown, fallback: string): string {
  const text = typeof message === "string" ? message.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  return text === "" ? fallback : text.slice(0, 200);
}

export function internalFail(name: string, reason: string): RpcFail {
  return { ok: false, code: "AI_INTERNAL", message: "rpc " + name + " " + reason };
}

/** `client.rpc()` trả { data, error } (hoặc ném) ⇒ chuẩn hoá. */
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
    const code = typeof payload.code === "string" && payload.code !== "" ? payload.code : "AI_INTERNAL";
    return { ok: false, code, message: sanitizeMessage(payload.message, "rpc " + name + " từ chối") };
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

/** Projection active: shape sai ⇒ AI_INTERNAL (không được coi là "không có cấu hình"). */
export function projectActiveConfig(value: Record<string, unknown>): { ok: true; config: ActiveConfigProjection | null } | RpcFail {
  if (value.ok !== true) return internalFail("active", "trả shape không hợp lệ");
  const projection: ActiveConfigProjection = {
    config_id: typeof value.config_id === "string" ? value.config_id : "",
    provider_profile: typeof value.provider_profile === "string" ? value.provider_profile : "",
    model: typeof value.model === "string" ? value.model : "",
    version: typeof value.version === "number" ? value.version : Number.NaN,
    status: "active",
    verified_at: typeof value.verified_at === "string" ? value.verified_at : null,
    sanitized_host: typeof value.sanitized_host === "string" ? value.sanitized_host : "",
  };
  if (
    projection.config_id === "" ||
    projection.provider_profile === "" ||
    projection.model === "" ||
    !Number.isSafeInteger(projection.version) ||
    projection.version < 1
  ) {
    return internalFail("active", "trả trường thiếu/sai kiểu");
  }
  return { ok: true, config: projection };
}
