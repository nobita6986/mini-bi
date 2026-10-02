/**
 * P1.5-W04 — HTTP security guards thuần (testable, KHÔNG server-only):
 * CSRF/origin cho mutation từ browser + token worker constant-time + sanitize thông điệp.
 */

/** So sánh chuỗi constant-time (độ dài khác nhau ⇒ false, không lộ độ dài khớp prefix). */
export function timingSafeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const length = Math.max(a.length, b.length, 1);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * CSRF/origin guard: mutation từ browser phải có Origin khớp Host và không cross-site.
 */
export function checkSameOriginRequest({ origin, host, secFetchSite }) {
  if (typeof secFetchSite === "string" && secFetchSite.toLowerCase() === "cross-site") {
    return { ok: false, code: "AI_CSRF_REJECTED", message: "cross-site request bị chặn" };
  }
  if (typeof origin !== "string" || origin.trim() === "") {
    return { ok: false, code: "AI_CSRF_REJECTED", message: "thiếu Origin" };
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, code: "AI_CSRF_REJECTED", message: "Origin không hợp lệ" };
  }
  if (typeof host !== "string" || host.trim() === "") {
    return { ok: false, code: "AI_CSRF_REJECTED", message: "thiếu Host" };
  }
  if (parsed.host !== host) {
    return { ok: false, code: "AI_CSRF_REJECTED", message: "Origin không khớp host" };
  }
  return { ok: true };
}

/** Kiểm tra token worker: thiếu cấu hình ⇒ AI_CONFIG_REQUIRED; sai ⇒ AI_WORKER_UNAUTHORIZED. */
export function checkWorkerToken(provided, expected) {
  if (typeof expected !== "string" || expected.trim() === "") {
    return { ok: false, code: "AI_CONFIG_REQUIRED", message: "thiếu token worker phía server" };
  }
  if (typeof provided !== "string" || provided.length === 0) {
    return { ok: false, code: "AI_WORKER_UNAUTHORIZED", message: "thiếu token worker" };
  }
  return timingSafeEqualString(provided, expected)
    ? { ok: true }
    : { ok: false, code: "AI_WORKER_UNAUTHORIZED", message: "token worker không hợp lệ" };
}

/** Chỉ giữ thông điệp ngắn, một dòng, không ký tự điều khiển (dùng cho log/response). */
export function sanitizeMessage(message) {
  if (typeof message !== "string") return null;
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
}
