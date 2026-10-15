import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import {
  listProjectTeamScopes,
  grantProjectTeamScope,
} from "@/lib/admin/project-team-scope-api";
import { createProjectTeamScopeRepository } from "@/lib/admin/project-team-scope-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createProjectTeamScopeRepository(),
};

export async function GET(request: Request): Promise<Response> {
  return listProjectTeamScopes(request, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}

export async function POST(request: Request): Promise<Response> {
  return grantProjectTeamScope(request, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}
