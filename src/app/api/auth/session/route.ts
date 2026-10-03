import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createAuthSessionResponse } from "@/lib/auth/auth-session-core";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return createAuthSessionResponse(
    () => getDirectEntryActor(createDirectEntryActorRepository()),
  );
}
