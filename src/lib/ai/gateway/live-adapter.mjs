/**
 * P1.5-W04B-S02A — Live provider adapter, THUẦN + dependency injection.
 *
 * - Gọi provider QUA outbound boundary được inject (production = safe-outbound; test = mock transport).
 * - KHÔNG dùng raw fetch; KHÔNG import server-only; KHÔNG log API key/prompt đầy đủ/raw response.
 * - CANONICAL PROFILE: path/auth header/scheme lấy từ getProviderProfile() + joinProviderPath() +
 *   buildProviderHeaders() (provider-profiles.ts) — KHÔNG hard-code endpoint/auth ở đây.
 * - USAGE TRUTHFULNESS: successful response BẮT BUỘC có integer prompt_tokens/completion_tokens >= 0;
 *   thiếu/malformed ⇒ AI_PROVIDER_MALFORMED (không revision, không usage giả, không heuristic).
 * - Redirect/DNS/private-IP/rebinding protections do safe-outbound đảm nhiệm (adapter KHÔNG bypass).
 */

import { canonicalJson } from "../engine-shared.mjs";
import { MAX_PAYLOAD_BYTES, MAX_RESPONSE_BYTES } from "./limits.mjs";
import { buildProviderHeaders, getProviderProfile, joinProviderPath } from "../../ai-config/provider-profiles.ts";

export const LIVE_ADAPTER_VERSION = "live-adapter/0.1";
/** Profile live duy nhất được hỗ trợ hiện tại (authority thực sự là provider-profiles.ts). */
export const LIVE_PROVIDER_PROFILE = "openai-compatible";

const PROVIDER_VERSION = "live-openai-compatible/0.1";

/** Strict projection: lấy content của choices[0].message.content (chuỗi), ngược lại null. */
function extractContent(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
  const choices = envelope.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;
  const message = first.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const content = message.content;
  return typeof content === "string" ? content : null;
}

/** Strict usage: BẮT BUỘC integer prompt_tokens/completion_tokens >= 0; thiếu/malformed ⇒ null. */
function extractUsageStrict(envelope) {
  const usage = envelope && typeof envelope === "object" && !Array.isArray(envelope) ? envelope.usage : null;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (!Number.isInteger(promptTokens) || promptTokens < 0) return null;
  if (!Number.isInteger(completionTokens) || completionTokens < 0) return null;
  return { input_tokens: promptTokens, output_tokens: completionTokens };
}

/** Mã hoá lỗi provider (HTTP) thành mã gateway ĐÓNG. */
function mapHttpError(statusCode) {
  if (statusCode === 429) return { code: "AI_PROVIDER_RATE_LIMITED", retryable: true };
  if (statusCode === 408 || (statusCode >= 500 && statusCode <= 599)) return { code: "AI_PROVIDER_TRANSIENT", retryable: true };
  return { code: "AI_PROVIDER_PERMANENT", retryable: false };
}

/** Mã hoá lỗi outbound (SecurityError / AbortError) thành mã gateway ĐÓNG. */
function mapOutboundError(error) {
  const code = error && typeof error.code === "string" ? error.code : null;
  if (code === "TIMEOUT") return { code: "AI_PROVIDER_TIMEOUT", retryable: true };
  if (code === "RESPONSE_TOO_LARGE") return { code: "AI_PROVIDER_OVERSIZED", retryable: false };
  if (code === "DNS_REJECTED" || code === "URL_REJECTED" || code === "REDIRECT_REJECTED" || code === "REQUEST_TOO_LARGE" || code === "INVALID_INPUT") {
    return { code: "AI_PROVIDER_PERMANENT", retryable: false };
  }
  if (error && typeof error.name === "string" && error.name === "AbortError") {
    return { code: "AI_PROVIDER_TIMEOUT", retryable: true };
  }
  return { code: "AI_PROVIDER_TRANSIENT", retryable: true };
}

/**
 * @param {object} options
 * @param {(url:string, opts:object)=>Promise<{statusCode:number,headers:object,body:Buffer}>} options.outbound
 * @param {object} [options.url_policy]  UrlPolicyOptions truyền thẳng cho outbound (allowlist + env).
 * @param {number} [options.max_response_bytes]
 * @param {number} [options.max_request_bytes]
 */
export function createLiveAdapter(options = {}) {
  const outbound = options.outbound;
  if (typeof outbound !== "function") {
    throw new Error("createLiveAdapter cần outbound function (production = safeOutboundRequest)");
  }
  const urlPolicy = options.url_policy ?? { environment: "production", allowedHosts: [] };
  const maxResponseBytes = Number.isInteger(options.max_response_bytes) && options.max_response_bytes > 0 ? options.max_response_bytes : MAX_RESPONSE_BYTES;
  const maxRequestBytes = Number.isInteger(options.max_request_bytes) && options.max_request_bytes > 0 ? options.max_request_bytes : MAX_PAYLOAD_BYTES;

  return {
    provider_key: "live",
    adapter_version: LIVE_ADAPTER_VERSION,

    async generateStructured(request) {
      const startedAt = Date.now();
      const latencyMs = () => Date.now() - startedAt;
      const fail = (errorCode, retryable, detailRef) => ({
        ok: false,
        error_code: errorCode,
        retryable,
        latency_ms: latencyMs(),
        provider_version: PROVIDER_VERSION,
        detail_ref: detailRef ?? "live:" + errorCode,
      });

      if (request.timeoutSignal && request.timeoutSignal.aborted) {
        return fail("AI_PROVIDER_TIMEOUT", true, "live:timeout");
      }

      const modelConfig = request.modelConfig ?? {};
      const modelKey = typeof modelConfig.model_key === "string" ? modelConfig.model_key : "";
      const providerConfig = modelConfig.provider_config ?? {};
      const apiBaseUrl = providerConfig.api_base_url;
      const secret = modelConfig.credential_secret;
      const profileId = providerConfig.provider_profile;
      if (typeof apiBaseUrl !== "string" || apiBaseUrl === "" || typeof secret !== "string" || secret === "") {
        return fail("AI_CONFIG_REQUIRED", false, "live:config");
      }
      if (modelKey === "") return fail("AI_CONFIG_REQUIRED", false, "live:model");

      // Canonical profile authority: profile không được hỗ trợ ⇒ fail closed TRƯỚC outbound.
      let url;
      let headers;
      try {
        const profile = getProviderProfile(profileId);
        url = joinProviderPath(apiBaseUrl, profile.path);
        headers = buildProviderHeaders(profile, secret);
      } catch {
        return fail("AI_CONFIG_REQUIRED", false, "live:profile");
      }

      const bodyObj = {
        model: modelKey,
        messages: [
          { role: "system", content: request.promptManifest?.system_instruction ?? "" },
          { role: "system", content: request.promptManifest?.developer_instruction ?? "" },
          { role: "user", content: canonicalJson(request.payload) },
        ],
        temperature: 0,
        stream: false,
      };
      const bodyStr = canonicalJson(bodyObj);
      const bodyBytes = Buffer.byteLength(bodyStr, "utf8");
      if (bodyBytes > maxRequestBytes) {
        return fail("AI_PROVIDER_PERMANENT", false, "live:request-too-large");
      }

      let response;
      try {
        response = await outbound(url, {
          url_policy: urlPolicy,
          method: "POST",
          headers,
          body: bodyStr,
          timeoutMs: Number.isInteger(modelConfig.timeout_ms) && modelConfig.timeout_ms > 0 ? modelConfig.timeout_ms : 30_000,
          maxResponseBytes,
          maxRequestBytes,
          maxRedirects: 0,
          signal: request.timeoutSignal,
        });
      } catch (error) {
        const mapped = mapOutboundError(error);
        return fail(mapped.code, mapped.retryable, "live:outbound");
      }

      if (!response || !Number.isInteger(response.statusCode) || !Buffer.isBuffer(response.body)) {
        return fail("AI_PROVIDER_TRANSIENT", true, "live:bad-response");
      }
      const bodyText = response.body.toString("utf8");
      if (Buffer.byteLength(bodyText, "utf8") > maxResponseBytes) {
        return fail("AI_PROVIDER_OVERSIZED", false, "live:oversized");
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        const mapped = mapHttpError(response.statusCode);
        return fail(mapped.code, mapped.retryable, "live:http_" + response.statusCode);
      }

      // Strict projection: envelope/content/usage/content-json malformed ⇒ AI_PROVIDER_MALFORMED (không revision, không usage giả).
      let envelope = null;
      try {
        envelope = JSON.parse(bodyText);
      } catch {
        return fail("AI_PROVIDER_MALFORMED", false, "live:envelope");
      }
      const content = extractContent(envelope);
      if (content === null) return fail("AI_PROVIDER_MALFORMED", false, "live:content");
      const usage = extractUsageStrict(envelope);
      if (usage === null) return fail("AI_PROVIDER_MALFORMED", false, "live:usage");

      let structured = null;
      try {
        structured = JSON.parse(content);
      } catch {
        return fail("AI_PROVIDER_MALFORMED", false, "live:content-json");
      }
      return { ok: true, raw_text: content, structured, usage, latency_ms: latencyMs(), provider_version: PROVIDER_VERSION, model_key: modelKey };
    },
  };
}
