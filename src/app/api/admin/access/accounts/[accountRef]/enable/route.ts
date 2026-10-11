import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createAccountAccessRepository } from "@/lib/direct-entry/app-user-access-repository";
import { mutateAccount } from "@/lib/direct-entry/app-user-access-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createAccountAccessRepository(),
};

export async function POST(
  request: Request, context: { params: Promise<{ accountRef: string }> },
): Promise<Response> {
  const { accountRef } = await context.params;
  return mutateAccount(request, accountRef, "enable", process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}
