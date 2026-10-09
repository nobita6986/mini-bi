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
 * P3.1-W01C-B - GET /api/admin/catalog/team-memberships?state=current|scheduled|history
 * Ba nhom doc la ba read contract rieng biet, chon bang query bat buoc.
 */
import { listTeamMembership } from "@/lib/direct-entry/team-membership-api";

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return listTeamMembership(request, "true", dependencies);
}
