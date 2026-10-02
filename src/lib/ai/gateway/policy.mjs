/**
 * P1.5-W04 — Policy layer fail-closed: rate limit, concurrency, attempts, timeout, trần response/payload,
 * ngân sách token theo ngày.
 *
 * Thuần + deterministic: mọi số đo (thời điểm, usage, số job đang chạy) do caller truyền vào.
 * KHÔNG gọi provider khi policy không đạt.
 */

import { REQUIRED_POLICY_KEYS } from "./limits.mjs";

function isPositiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Đọc policy từ nguồn cấu hình (env đã parse). Thiếu/sai ⇒ AI_POLICY_REQUIRED (fail closed).
 * KHÔNG tự đặt ngân sách tiền thật; đây chỉ là trần kỹ thuật + token ceiling do ops khai báo.
 */
export function readPolicyConfig(source) {
  const raw = source ?? {};
  const missing = REQUIRED_POLICY_KEYS.filter((key) => !isPositiveInt(raw[key]));
  if (missing.length > 0) {
    return { ok: false, code: "AI_POLICY_REQUIRED", message: "thiếu policy: " + missing.join(", ") };
  }
  const windowMs = isPositiveInt(raw.window_ms) ? raw.window_ms : 60000;
  const maxPayloadBytes = isPositiveInt(raw.max_payload_bytes) ? raw.max_payload_bytes : 256 * 1024;
  if (raw.provider_timeout_ms < 1000 || raw.provider_timeout_ms > 120000) {
    return { ok: false, code: "AI_POLICY_REQUIRED", message: "provider_timeout_ms ngoài khoảng cho phép" };
  }
  if (raw.max_attempts > 5) {
    return { ok: false, code: "AI_POLICY_REQUIRED", message: "max_attempts vượt trần an toàn" };
  }
  return {
    ok: true,
    config: {
      window_ms: windowMs,
      max_requests_per_window: raw.max_requests_per_window,
      max_concurrent_jobs: raw.max_concurrent_jobs,
      max_attempts: raw.max_attempts,
      provider_timeout_ms: raw.provider_timeout_ms,
      max_response_bytes: raw.max_response_bytes,
      max_payload_bytes: maxPayloadBytes,
      daily_token_ceiling: raw.daily_token_ceiling,
    },
  };
}

/**
 * Đánh giá policy. Trả { ok:true } hoặc { ok:false, code, message }.
 * Thứ tự kiểm tra deterministic: config → rate → concurrency → attempts → budget → payload size.
 */
export function evaluatePolicy({ config, context, payload_bytes = 0 }) {
  if (!config || typeof config !== "object") {
    return { ok: false, code: "AI_POLICY_REQUIRED", message: "thiếu policy config" };
  }
  const missing = REQUIRED_POLICY_KEYS.filter((key) => !isPositiveInt(config[key]));
  if (missing.length > 0) {
    return { ok: false, code: "AI_POLICY_REQUIRED", message: "thiếu policy: " + missing.join(", ") };
  }
  if (!context || typeof context !== "object") {
    return { ok: false, code: "AI_POLICY_REQUIRED", message: "thiếu policy context" };
  }

  const windowMs = isPositiveInt(config.window_ms) ? config.window_ms : 60000;
  const recent = Array.isArray(context.recent_requests) ? context.recent_requests : [];
  const inWindow = recent.filter((timestamp) => Number.isFinite(timestamp) && context.now_ms - timestamp < windowMs);
  if (inWindow.length >= config.max_requests_per_window) {
    return { ok: false, code: "AI_RATE_LIMITED", message: "vượt giới hạn request trong cửa sổ" };
  }

  if (!Number.isInteger(context.active_jobs) || context.active_jobs < 0) {
    return { ok: false, code: "AI_POLICY_REQUIRED", message: "thiếu số job đang chạy" };
  }
  if (context.active_jobs >= config.max_concurrent_jobs) {
    return { ok: false, code: "AI_CONCURRENCY_LIMITED", message: "vượt giới hạn job đồng thời" };
  }

  // `attempts` là số lần ĐÃ claim (bao gồm lần hiện tại) ⇒ chỉ chặn khi VƯỢT trần.
  if (Number.isInteger(context.attempts) && context.attempts > config.max_attempts) {
    return { ok: false, code: "AI_BUDGET_LIMITED", message: "vượt số lần thử tối đa" };
  }

  if (Number.isFinite(context.tokens_used_today) && context.tokens_used_today >= config.daily_token_ceiling) {
    return { ok: false, code: "AI_BUDGET_LIMITED", message: "vượt trần token trong ngày" };
  }

  if (payload_bytes > config.max_payload_bytes) {
    return { ok: false, code: "AI_BUDGET_LIMITED", message: "payload vượt trần cho phép" };
  }

  return { ok: true };
}

/** Trần response-size của provider (dùng cho adapter). */
export function responseCeilingOf(config) {
  return isPositiveInt(config?.max_response_bytes) ? config.max_response_bytes : null;
}
