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
 * P3.1-W01C-A - GET/POST /api/admin/catalog/teams
 * Gate chay TRUOC khi tao session hay repository. Khong co UI trong task nay.
 */
import { createTeamCatalog, listTeamsCatalog } from "@/lib/direct-entry/team-catalog-api";

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return listTeamsCatalog(request, "true", dependencies);
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return createTeamCatalog(request, "true", dependencies);
}
