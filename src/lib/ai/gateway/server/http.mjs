import "server-only";

/**
 * P1.5-W04 — HTTP helpers cho route AI: response sanitize, no-store, giới hạn body.
 * Không bao giờ trả packet/payload/analysis thô của provider hay chi tiết lỗi nội bộ.
 */

const STATUS_BY_CODE = {
  AI_DISABLED: 503,
  AI_CONFIG_REQUIRED: 503,
  AI_POLICY_REQUIRED: 503,
  AI_PROVIDER_DISABLED: 503,
  AI_WORKER_UNAUTHORIZED: 401,
  AI_CSRF_REJECTED: 403,
  AI_RATE_LIMITED: 429,
  AI_CONCURRENCY_LIMITED: 429,
  AI_BUDGET_LIMITED: 429,
  AI_INPUT_INVALID: 422,
  AI_JOB_NOT_FOUND: 404,
  AI_VALIDATION_FAILED: 422,
  AI_INTERNAL: 500,
};

export const MAX_BODY_BYTES = 16 * 1024;

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export function errorResponse(code, message) {
  return jsonResponse({ ok: false, code, message: sanitizeMessage(message) }, STATUS_BY_CODE[code] ?? 500);
}

/** Chỉ giữ thông điệp ngắn, một dòng, không chứa ký tự điều khiển. */
export function sanitizeMessage(message) {
  if (typeof message !== "string") return null;
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
}

/** Đọc JSON body có trần kích thước; không log nội dung. */
export async function readJsonBody(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return { ok: false, code: "AI_INPUT_INVALID", message: "body quá lớn" };
  }
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, code: "AI_INPUT_INVALID", message: "không đọc được body" };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false, code: "AI_INPUT_INVALID", message: "body quá lớn" };
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, code: "AI_INPUT_INVALID", message: "body phải là JSON object" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, code: "AI_INPUT_INVALID", message: "body không phải JSON hợp lệ" };
  }
}
