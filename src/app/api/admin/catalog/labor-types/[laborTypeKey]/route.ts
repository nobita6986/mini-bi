import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createLaborTypeCatalogRepository } from "@/lib/direct-entry/labor-type-catalog-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATE = () => Response.json({ ok: false, code: "NOT_FOUND" }, {
  status: 404,
  headers: { "Cache-Control": "private, no-store" },
});

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createLaborTypeCatalogRepository(),
};

/**
 * P3.1-W02C - GET/PATCH /api/admin/catalog/labor-types/[laborTypeKey]
 */
import { getLaborTypeCatalog, updateLaborTypeCatalog } from "@/lib/direct-entry/labor-type-catalog-api";

export async function GET(
  request: Request, context: { params: Promise<{ laborTypeKey: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { laborTypeKey } = await context.params;
  return getLaborTypeCatalog(request, laborTypeKey, "true", dependencies);
}

export async function PATCH(
  request: Request, context: { params: Promise<{ laborTypeKey: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { laborTypeKey } = await context.params;
  return updateLaborTypeCatalog(request, laborTypeKey, "true", dependencies);
}
