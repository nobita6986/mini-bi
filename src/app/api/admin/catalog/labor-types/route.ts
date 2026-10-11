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
 * P3.1-W02C - GET/POST /api/admin/catalog/labor-types
 * Gate chay TRUOC khi tao session hay repository. Khong co UI trong task nay.
 */
import { createLaborTypeCatalog, listLaborTypeCatalog } from "@/lib/direct-entry/labor-type-catalog-api";

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return listLaborTypeCatalog(request, "true", dependencies);
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return createLaborTypeCatalog(request, "true", dependencies);
}
