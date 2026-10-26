import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getServerEnv } from "../env.ts";

const supabaseAbortSignalStorage = new AsyncLocalStorage<AbortSignal>();

/**
 * Runs an async/sync operation with an active `AbortSignal` that will be
 * automatically attached to every outbound PostgREST `fetch` request issued
 * by `createServiceSupabaseClient()` within that async execution context.
 */
export function runWithSupabaseAbortSignal<T>(
  signal: AbortSignal,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return supabaseAbortSignalStorage.run(signal, fn);
}

export function getActiveSupabaseAbortSignal(): AbortSignal | undefined {
  return supabaseAbortSignalStorage.getStore();
}

export function createAbortAwareFetch(
  explicitSignal?: AbortSignal,
  baseFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const contextSignal =
      explicitSignal ?? supabaseAbortSignalStorage.getStore();
    if (!contextSignal) {
      return baseFetch(input, init);
    }
    const existingSignal = init?.signal ?? undefined;
    const mergedSignal = existingSignal
      ? AbortSignal.any([existingSignal, contextSignal])
      : contextSignal;
    return baseFetch(input, {
      ...init,
      signal: mergedSignal,
    });
  };
}

/**
 * Supabase server client.
 *
 * CẢNH BÁO: `createServiceSupabaseClient` dùng SUPABASE_SECRET_KEY — key này
 * BYPASS RLS. Chỉ được gọi trong server runtime. Không truyền client này,
 * không truyền key này, và không trả dữ liệu thô từ nó về trình duyệt.
 *
 * P0 chưa có Auth người dùng nên web cần quyền đọc phía server. Khi P1-W03
 * (access gate pilot trước dữ liệu thật) và P3 (role đầy đủ) làm access layer,
 * cần tách role reader hạn chế quyền thay vì dùng key đặc quyền.
 */
export function createServiceSupabaseClient(options?: {
  signal?: AbortSignal;
  fetch?: typeof fetch;
}): SupabaseClient {
  const env = getServerEnv();
  if (!env.supabaseSecretKey) {
    throw new Error(
      "Thiếu SUPABASE_SECRET_KEY: server read/ingestion cần key này. " +
        "Xem .env.example và docs/handoffs/p0-t1-g1.md."
    );
  }
  return createClient(env.supabaseUrl, env.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: createAbortAwareFetch(options?.signal, options?.fetch),
    },
  });
}

/** Client chỉ có quyền công khai (publishable key). Bị RLS/RPC grants từ chối mọi truy cập dữ liệu. */
export function createPublicSupabaseClient(): SupabaseClient {
  const env = getServerEnv();
  return createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
