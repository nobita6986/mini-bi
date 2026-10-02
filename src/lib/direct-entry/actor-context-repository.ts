import "server-only";

import type { ActorRepository } from "../auth/direct-entry-v2";

const INVALID_REPOSITORY_RECORD = Object.freeze({ repository_error: true });

type ActorContextRpc = (authSubject: string) => Promise<{
  data: unknown;
  error: unknown;
}>;

function createServiceRoleRpc(): ActorContextRpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) =>
    createServiceSupabaseClient()
  );
  return async (authSubject) => {
    const { data, error } = await (await client).rpc(
      "direct_entry_resolve_actor_context",
      { p_auth_subject: authSubject },
    );
    return { data, error };
  };
}

export function createDirectEntryActorRepository(
  rpc?: ActorContextRpc,
): ActorRepository {
  let resolvedRpc = rpc;
  return {
    async loadByAuthSubject(authSubject: string, at: string): Promise<unknown> {
      void at;
      try {
        resolvedRpc ??= createServiceRoleRpc();
        const { data, error } = await resolvedRpc(authSubject);
        if (error) {
          console.error("[direct-entry] actor context RPC failed");
          return INVALID_REPOSITORY_RECORD;
        }
        return data;
      } catch {
        console.error("[direct-entry] actor context RPC unavailable");
        return INVALID_REPOSITORY_RECORD;
      }
    },
  };
}
