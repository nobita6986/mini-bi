/**
 * P1.5-W04B-S01 — Live provider adapter (OpenAI-compatible), THUẦN + dependency injection.
 *
 * - Gọi provider QUA outbound boundary được inject (production = safe-outbound; test = mock transport).
 * - KHÔNG dùng raw fetch ở đây; KHÔNG import server-only; KHÔNG log API key/prompt đầy đủ/raw response.
 * - Strict projection envelope OpenAI; lỗi provider được sanitize thành mã gateway ĐÓNG.
 * - Redirect/DNS/private-IP/rebinding protections do safe-outbound đảm nhiệm (adapter KHÔNG bypass).
 */

import { canonicalJson } from "../engine-shared.mjs";
import { MAX_PAYLOAD_BYTES, MAX_RESPONSE_BYTES } from "./limits.mjs";

export const LIVE_ADAPTER_VERSION = "live-adapter/0.1";
export const LIVE_PROVIDER_PROFILE = "openai-compatible";

const OPENAI_PATH = "chat/completions";
const PROVIDER_VERSION = "live-openai-compatible/0.1";

function estimateTokens(text) {
  return Math.max(1, Math.ceil((typeof text === "string" ? text.length : 0) / 4));
}

/** Nối path vào base URL đã chuẩn hoá mà KHÔNG nuốt path sẵn có (vd: /v1). Trả null nếu sai origin. */
function joinChatCompletionsPath(apiBaseUrl) {
  try {
    const base = new URL(apiBaseUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
    if (base.search !== "" || base.hash !== "") return null;
    if (!base.pathname.endsWith("/")) base.pathname = base.pathname + "/";
    const joined = new URL(OPENAI_PATH, base);
    if (joined.origin !== base.origin) return null;
    return joined.href;
  } catch {
    return null;
  }
}

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

/** Strict projection usage; thiếu/sai kiểu ⇒ ước lượng (không bao giờ âm/null giả). */
function extractUsage(envelope, bodyText, payloadText) {
  const usage = envelope && typeof envelope === "object" && !Array.isArray(envelope) ? envelope.usage : null;
  const promptTokens = usage && Number.isInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : null;
  const completionTokens = usage && Number.isInteger(usage.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : null;
  return {
    input_tokens: promptTokens ?? estimateTokens(payloadText),
    output_tokens: completionTokens ?? estimateTokens(bodyText),
  };
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
      const profile = providerConfig.provider_profile;
      if (typeof apiBaseUrl !== "string" || apiBaseUrl === "" || typeof secret !== "string" || secret === "") {
        return fail("AI_CONFIG_REQUIRED", false, "live:config");
      }
      if (profile !== LIVE_PROVIDER_PROFILE) return fail("AI_CONFIG_REQUIRED", false, "live:profile");
      if (modelKey === "") return fail("AI_CONFIG_REQUIRED", false, "live:model");

      const url = joinChatCompletionsPath(apiBaseUrl);
      if (url === null) return fail("AI_PROVIDER_PERMANENT", false, "live:url");

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

      const headers = {
        "content-type": "application/json",
        accept: "application/json",
        authorization: "Bearer " + secret,
      };

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

      // Strict projection envelope OpenAI (malformed ⇒ structured:null ⇒ downstream AI_PROVIDER_MALFORMED).
      let envelope = null;
      try {
        envelope = JSON.parse(bodyText);
      } catch {
        envelope = null;
      }
      const content = extractContent(envelope);
      const usage = extractUsage(envelope, content === null ? bodyText : content, bodyStr);
      if (content === null) {
        return { ok: true, raw_text: bodyText, structured: null, usage, latency_ms: latencyMs(), provider_version: PROVIDER_VERSION, model_key: modelKey };
      }
      let structured = null;
      try {
        structured = JSON.parse(content);
      } catch {
        structured = null;
      }
      return { ok: true, raw_text: content, structured, usage, latency_ms: latencyMs(), provider_version: PROVIDER_VERSION, model_key: modelKey };
    },
  };
}
