import "server-only";

import { resolveActor } from "./direct-entry-v2";
import { createDirectEntryActorRepository } from "../direct-entry/actor-context-repository";
import { createSupabaseAuthClient } from "./supabase-auth-client";
import type { PasswordChangeDeps } from "./change-password-core";

export function createChangePasswordDependencies(): PasswordChangeDeps {
  return {
    createClient: createSupabaseAuthClient,
    resolveActor,
    repository: createDirectEntryActorRepository(),
    now: () => new Date().toISOString(),
  };
}