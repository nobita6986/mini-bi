import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getServerEnv } from "@/lib/env";

/**
 * Supabase server client.
 *
 * CẢNH BÁO: `createServiceSupabaseClient` dùng SUPABASE_SECRET_KEY — key này
 * BYPASS RLS. Chỉ được gọi trong server runtime. Không truyền client này,
 * không truyền key này, và không trả dữ liệu thô từ nó về trình duyệt.
 *
 * P0 chưa có Auth người dùng nên web cần quyền đọc phía server. Khi P1-W03/P3
 * làm access layer, cần tách role reader hạn chế quyền thay vì dùng key đặc quyền.
 */
export function createServiceSupabaseClient(): SupabaseClient {
  const env = getServerEnv();
  if (!env.supabaseSecretKey) {
    throw new Error(
      "Thiếu SUPABASE_SECRET_KEY: server read/ingestion cần key này. " +
        "Xem .env.example và docs/handoffs/p0-t1-g1.md."
    );
  }
  return createClient(env.supabaseUrl, env.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Client chỉ có quyền công khai (publishable key). Bị RLS/RPC grants từ chối mọi truy cập dữ liệu. */
export function createPublicSupabaseClient(): SupabaseClient {
  const env = getServerEnv();
  return createClient(env.supabaseUrl, env.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
