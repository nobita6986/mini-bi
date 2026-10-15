import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { revokeProjectTeamScope } from "@/lib/admin/project-team-scope-api";
import { createProjectTeamScopeRepository } from "@/lib/admin/project-team-scope-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createProjectTeamScopeRepository(),
};

export async function POST(request: Request): Promise<Response> {
  return revokeProjectTeamScope(request, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}
