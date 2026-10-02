import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getServerEnv } from "@/lib/env";
import {
  resolveActor,
  type ActorRepository,
  type ActorResolution,
} from "./direct-entry-v2";

export type DirectEntrySessionResult = {
  actor: ActorResolution;
  response_headers: Readonly<Record<string, string>>;
};

const AUTH_REFRESH_HEADERS = new Set(["cache-control", "expires", "pragma"]);

export async function getDirectEntryActor(
  repository: ActorRepository | null | undefined,
): Promise<DirectEntrySessionResult> {
  const at = new Date().toISOString();
  const env = getServerEnv();
  const cookieStore = await cookies();
  const responseHeaders: Record<string, string> = {};
  const supabase = createServerClient(
    env.supabaseUrl,
    env.supabasePublishableKey,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet, headers) => {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
          for (const [name, value] of Object.entries(headers)) {
            const normalizedName = name.toLowerCase();
            if (AUTH_REFRESH_HEADERS.has(normalizedName)) {
              responseHeaders[normalizedName] = value;
            }
          }
        },
      },
    },
  );

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.id) {
    return {
      actor: { ok: false, reason: "UNAUTHENTICATED" },
      response_headers: responseHeaders,
    };
  }

  return {
    actor: await resolveActor({
      session: {
        auth_subject: data.user.id,
        provider: "supabase",
        authenticated_at: null,
      },
      repository,
      at,
    }),
    response_headers: responseHeaders,
  };
}
