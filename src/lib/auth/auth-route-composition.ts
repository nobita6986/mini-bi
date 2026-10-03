import "server-only";

import { resolveActor } from "./direct-entry-v2";
import { createDirectEntryActorRepository } from "../direct-entry/actor-context-repository";
import { createSupabaseAuthClient } from "./supabase-auth-client";
import type { AuthDependencies } from "./auth-session-core";

export function createAuthDependencies(): AuthDependencies {
  return {
    createClient: createSupabaseAuthClient,
    repository: createDirectEntryActorRepository(),
    resolveActor,
    now: () => new Date().toISOString(),
  };
}
