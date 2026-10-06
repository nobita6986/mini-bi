import type { CookieMethodsServer, CookieOptions } from "@supabase/ssr";

export type AuthCookieStore = {
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options: CookieOptions): void;
};

export type AuthCookieWriteMode = "read-write" | "read-only";

export function scopeAuthCookieStore(
  cookieStore: AuthCookieStore,
  writeMode: AuthCookieWriteMode = "read-write",
): AuthCookieStore {
  return {
    getAll: () => cookieStore.getAll(),
    set: (name, value, options) => {
      if (writeMode === "read-only") return;
      cookieStore.set(name, value, options);
    },
  };
}

export function createSupabaseCookieAdapter(
  cookieStore: AuthCookieStore,
): CookieMethodsServer {
  return {
    getAll: () => cookieStore.getAll(),
    setAll: (cookies) => {
      for (const { name, value, options } of cookies) {
        cookieStore.set(name, value, options);
      }
    },
  };
}
