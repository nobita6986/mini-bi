import "server-only";

/**
 * P1.5-W04A-R2 — Wiring Supabase cho provider-config store.
 *
 * Toàn bộ logic đọc/ghi + validate nằm ở `../store-core.ts` (test được với RPC giả); module này chỉ:
 * - dựng hàm `rpc` từ service-role client;
 * - bơm keyring từ ENV (thiếu/sai ⇒ AI_CONFIG_REQUIRED);
 * ⇒ Supabase thật và test double dùng CHUNG một projection rule.
 */

import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { tryKeyringFromEnvironment } from "../crypto-envelope.ts";
import { createProviderConfigStoreCore } from "../store-core.ts";

export function createSupabaseProviderConfigStore(options = {}) {
  const clientFactory = options.client_factory ?? createServiceSupabaseClient;
  const env = options.env ?? process.env;
  const previousKeys = options.previous_keys ?? new Map();

  return createProviderConfigStoreCore({
    config_id: options.config_id ?? "pilot-provider",
    rpc: async (name, params) => {
      const client = clientFactory();
      return client.rpc(name, params);
    },
    keyring: () => tryKeyringFromEnvironment(env, previousKeys),
  });
}
