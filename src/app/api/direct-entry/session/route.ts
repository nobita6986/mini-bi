import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createDirectEntrySessionResponse } from "@/lib/direct-entry/session-bootstrap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return createDirectEntrySessionResponse(
    process.env.DIRECT_ENTRY_API_ENABLED,
    () => getDirectEntryActor(createDirectEntryActorRepository()),
  );
}
