import "server-only";
import { z } from "zod";

/**
 * Validation biến môi trường phía server.
 *
 * Nguyên tắc:
 * - Chỉ NEXT_PUBLIC_* mới được nhúng vào bundle trình duyệt.
 * - SUPABASE_SECRET_KEY là key đặc quyền (bypass RLS): chỉ tồn tại ở server runtime,
 *   không được import vào Client Component, không được log, không được trả về client.
 * - Validation chạy lazy (khi gọi lần đầu) để `next build` không cần secret.
 */

const urlLike = z
  .string()
  .refine((value) => /^https?:\/\/[^\s]+$/.test(value), { message: "phải là URL http(s) hợp lệ" });

const serverEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: urlLike,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
});

export type ServerEnv = {
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseSecretKey: string | null;
};

let cached: ServerEnv | null = null;

/** Trả biến môi trường server đã validate; ném lỗi cấu hình rõ ràng nếu thiếu/sai. */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  });

  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(
      `Cấu hình môi trường không hợp lệ. Thiếu hoặc sai: ${missing}. ` +
        "Sao chép .env.example thành .env.local và điền giá trị (xem README)."
    );
  }

  cached = {
    supabaseUrl: parsed.data.NEXT_PUBLIC_SUPABASE_URL,
    supabasePublishableKey: parsed.data.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    supabaseSecretKey: parsed.data.SUPABASE_SECRET_KEY ?? null,
  };
  return cached;
}

export type EnvVarStatus = { name: string; scope: "public" | "server"; present: boolean };

/** Trạng thái hiện diện của biến môi trường — KHÔNG bao giờ trả về giá trị. */
export function getEnvVarStatus(): EnvVarStatus[] {
  const read = (name: string, scope: "public" | "server"): EnvVarStatus => ({
    name,
    scope,
    present: Boolean(process.env[name] && String(process.env[name]).trim() !== ""),
  });

  return [
    read("NEXT_PUBLIC_SUPABASE_URL", "public"),
    read("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "public"),
    read("SUPABASE_SECRET_KEY", "server"),
    read("PILOT_ACCESS_USERNAME", "server"),
    read("PILOT_ACCESS_PASSWORD", "server"),
  ];
}
