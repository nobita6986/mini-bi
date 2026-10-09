import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createPersonnelCatalogRepository } from "@/lib/direct-entry/personnel-catalog-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATE = () => Response.json({ ok: false, code: "NOT_FOUND" }, {
  status: 404,
  headers: { "Cache-Control": "private, no-store" },
});

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createPersonnelCatalogRepository(),
};

/**
 * P3.1-W01B - POST /api/admin/catalog/personnel/[recruiterId]/active
 */
import { setPersonnelCatalogActive } from "@/lib/direct-entry/personnel-catalog-api";

export async function POST(
  request: Request, context: { params: Promise<{ recruiterId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { recruiterId } = await context.params;
  return setPersonnelCatalogActive(request, recruiterId, "true", dependencies);
}
