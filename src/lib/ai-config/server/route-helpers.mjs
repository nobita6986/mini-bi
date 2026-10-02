import "server-only";

/**
 * P1.5-W04A — Guard + response cho route settings.
 *
 * Thứ tự fail-closed: feature flag (404 TRƯỚC DB) → CSRF/origin → rate limit → body bounded.
 * Module này KHÔNG import store/Supabase (test được bằng Node, không cần DB).
 */

import { checkSameOriginRequest, sanitizeMessage } from "../../ai/gateway/http-guards.mjs";
import { httpStatusFor, toApiCode } from "../settings-codes.ts";
import { isAiSettingsEnabled, PILOT_ACTOR_REF } from "../settings-flag.ts";
import { createRateLimiter } from "../rate-limit.ts";

export const MAX_SETTINGS_BODY_BYTES = 20 * 1024;
export const SETTINGS_MUTATION_LIMIT = 20;
export const SETTINGS_MUTATION_WINDOW_MS = 60_000;

const mutationLimiter = createRateLimiter({
  limit: SETTINGS_MUTATION_LIMIT,
  window_ms: SETTINGS_MUTATION_WINDOW_MS,
});

/** Trần rate limit theo actor pilot (bộ nhớ tiến trình — ghi rõ hạn chế, P3 sẽ thay bằng phân tán). */
export function checkSettingsRateLimit(actorRef = PILOT_ACTOR_REF) {
  return mutationLimiter.check(actorRef);
}

export function settingsJson(body, status = 200) {
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

export function settingsError(code, message) {
  const apiCode = toApiCode(code);
  return settingsJson({ ok: false, code: apiCode, message: sanitizeMessage(message) }, httpStatusFor(apiCode));
}

/**
 * Guard chung cho mọi route settings (KHÔNG chạm DB).
 * @returns {{ok:true} | {ok:false, response:Response}}
 */
export function guardSettingsRequest(request, options = {}) {
  const actorRef = options.actor_ref ?? PILOT_ACTOR_REF;
  if (!isAiSettingsEnabled()) {
    return { ok: false, response: settingsError("SETTINGS_DISABLED", "Bảng cấu hình AI đang tắt") };
  }
  if (options.mutation === true) {
    const originCheck = checkSameOriginRequest({
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
      secFetchSite: request.headers.get("sec-fetch-site"),
    });
    if (!originCheck.ok) {
      return { ok: false, response: settingsError("CSRF_REJECTED", originCheck.message) };
    }
    const limit = checkSettingsRateLimit(actorRef);
    if (!limit.ok) {
      return { ok: false, response: settingsError("RATE_LIMITED", "quá nhiều yêu cầu cấu hình") };
    }
  }
  return { ok: true };
}

export async function readSettingsBody(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number.parseInt(contentLength, 10) > MAX_SETTINGS_BODY_BYTES) {
    return { ok: false, code: "INVALID_INPUT", message: "body quá lớn" };
  }
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, code: "INVALID_INPUT", message: "không đọc được body" };
  }
  if (text.length > MAX_SETTINGS_BODY_BYTES) return { ok: false, code: "INVALID_INPUT", message: "body quá lớn" };
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, code: "INVALID_INPUT", message: "body phải là JSON object" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, code: "INVALID_INPUT", message: "body không phải JSON hợp lệ" };
  }
}
