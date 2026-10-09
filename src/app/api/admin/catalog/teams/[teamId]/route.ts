import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createTeamCatalogRepository } from "@/lib/direct-entry/team-catalog-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATE = () => Response.json({ ok: false, code: "NOT_FOUND" }, {
  status: 404,
  headers: { "Cache-Control": "private, no-store" },
});

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createTeamCatalogRepository(),
};

/**
 * P3.1-W01C-A - GET/PATCH /api/admin/catalog/teams/[teamId]
 * PATCH chi nhan display_name: code va active khong nam trong contract nay.
 */
import { getTeamCatalog, updateTeamCatalog } from "@/lib/direct-entry/team-catalog-api";

export async function GET(
  request: Request, context: { params: Promise<{ teamId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { teamId } = await context.params;
  return getTeamCatalog(request, teamId, "true", dependencies);
}

export async function PATCH(
  request: Request, context: { params: Promise<{ teamId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { teamId } = await context.params;
  return updateTeamCatalog(request, teamId, "true", dependencies);
}
