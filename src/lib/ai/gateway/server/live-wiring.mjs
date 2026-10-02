import "server-only";

/**
 * P1.5-W04B-S02A — Server-only composition cho live adapter.
 *
 * - Nối safeOutboundRequest (secure outbound) + URL policy (đã validate) vào createLiveAdapter.
 * - Production fail-closed: thiếu outbound/url_policy ⇒ resolveProviderAdapter trả AI_PROVIDER_DISABLED
 *   (hoặc adapter fail-closed với allowlist rỗng) TRƯỚC network.
 * - KHÔNG raw fetch; mọi outbound đi qua safeOutboundRequest.
 */

import { safeOutboundRequest } from "../../../ai-config/safe-outbound.ts";
import { resolveProviderAdapter } from "../provider.mjs";

/**
 * @param {object} options
 * @param {Function} [options.outbound]  default = safeOutboundRequest (test inject mock secure outbound).
 * @param {object} [options.url_policy]  UrlPolicyOptions đã validate (allowlist từ AI_PROVIDER_ALLOWED_HOSTS).
 * @param {number} [options.max_response_bytes]
 * @param {number} [options.max_request_bytes]
 */
export function createLiveAdapterFactory(options = {}) {
  const outbound = options.outbound ?? safeOutboundRequest;
  const urlPolicy = options.url_policy ?? null;
  const maxResponseBytes = options.max_response_bytes;
  const maxRequestBytes = options.max_request_bytes;

  return function resolveAdapter({ provider_key, config }) {
    if (provider_key !== "live") {
      return resolveProviderAdapter({ provider_key, config });
    }
    return resolveProviderAdapter({
      provider_key,
      config: {
        ...(config ?? {}),
        outbound,
        url_policy: urlPolicy,
        max_response_bytes: maxResponseBytes,
        max_request_bytes: maxRequestBytes,
      },
    });
  };
}
