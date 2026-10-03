import type { CookieMethodsServer, CookieOptions } from "@supabase/ssr";

export type AuthCookieStore = {
  getAll(): { name: string; value: string }[];
  set(name: string, value: string, options: CookieOptions): void;
};

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
