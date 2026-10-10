import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { revokeTeamLeader } from "@/lib/direct-entry/team-leader-api";
import { createTeamLeaderRepository } from "@/lib/direct-entry/team-leader-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createTeamLeaderRepository(),
};

export async function POST(
  request: Request, context: { params: Promise<{ teamId: string }> },
): Promise<Response> {
  const { teamId } = await context.params;
  return revokeTeamLeader(request, teamId, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}
