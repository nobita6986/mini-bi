import type { CookieOptions } from "@supabase/ssr";

import type {
  ActorRepository,
  ActorResolution,
  SessionIdentity,
} from "./direct-entry-v2";

type SessionCookie = { name: string; value: string };
type RefreshedCookie = SessionCookie & { options: CookieOptions };

export type SessionCookieStore = {
  getAll(): SessionCookie[];
  set(name: string, value: string, options: CookieOptions): void;
};

export type SupabaseSessionClient = {
  auth: {
    getUser(): Promise<{
      data: { user: { id: string } | null };
      error: unknown;
    }>;
  };
};

export type SupabaseSessionClientFactory = (
  url: string,
  publishableKey: string,
  options: {
    cookies: {
      getAll(): SessionCookie[];
      setAll(
        cookies: RefreshedCookie[],
        headers: Record<string, string>,
      ): void;
    };
  },
) => SupabaseSessionClient;

export type DirectEntryActorResolver = (input: {
  session: SessionIdentity | null;
  repository: ActorRepository | null | undefined;
  at: string;
}) => Promise<ActorResolution>;

export type DirectEntrySessionResult = {
  actor: ActorResolution;
  response_headers: Readonly<Record<string, string>>;
};

const AUTH_REFRESH_HEADERS = new Set(["cache-control", "expires", "pragma"]);

export async function resolveDirectEntrySession(input: {
  createClient: SupabaseSessionClientFactory;
  resolveActor: DirectEntryActorResolver;
  supabaseUrl: string;
  publishableKey: string;
  cookieStore: SessionCookieStore;
  repository: ActorRepository | null | undefined;
  at: string;
}): Promise<DirectEntrySessionResult> {
  const responseHeaders: Record<string, string> = {};
  const client = input.createClient(input.supabaseUrl, input.publishableKey, {
    cookies: {
      getAll: () => input.cookieStore.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value, options } of cookiesToSet) {
          input.cookieStore.set(name, value, options);
        }
        for (const [name, value] of Object.entries(headers)) {
          const normalizedName = name.toLowerCase();
          if (AUTH_REFRESH_HEADERS.has(normalizedName)) {
            responseHeaders[normalizedName] = value;
          }
        }
      },
    },
  });

  const { data, error } = await client.auth.getUser();
  if (error || !data.user?.id) {
    return {
      actor: { ok: false, reason: "UNAUTHENTICATED" },
      response_headers: responseHeaders,
    };
  }

  return {
    actor: await input.resolveActor({
      session: {
        auth_subject: data.user.id,
        provider: "supabase",
        authenticated_at: null,
      },
      repository: input.repository,
      at: input.at,
    }),
    response_headers: responseHeaders,
  };
}
