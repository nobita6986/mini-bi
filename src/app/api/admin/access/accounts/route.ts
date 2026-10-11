import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createAccountAccessRepository } from "@/lib/direct-entry/app-user-access-repository";
import { listAccounts } from "@/lib/direct-entry/app-user-access-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createAccountAccessRepository(),
};

export async function GET(request: Request): Promise<Response> {
  return listAccounts(request, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}
