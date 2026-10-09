import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createTeamMembershipRepository } from "@/lib/direct-entry/team-membership-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATE = () => Response.json({ ok: false, code: "NOT_FOUND" }, {
  status: 404,
  headers: { "Cache-Control": "private, no-store" },
});

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createTeamMembershipRepository(),
};

/**
 * P3.1-W01C-B - POST .../team-memberships/[teamId]/move
 * Dong interval dang mo va mo interval moi cung ngay, trong mot transaction.
 */
import { moveTeamMembership } from "@/lib/direct-entry/team-membership-api";

export async function POST(
  request: Request,
  context: { params: Promise<{ recruiterId: string; teamId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { recruiterId, teamId } = await context.params;
  return moveTeamMembership(request, recruiterId, teamId, "true", dependencies);
}
