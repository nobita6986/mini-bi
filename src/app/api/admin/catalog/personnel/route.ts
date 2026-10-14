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
 * P3.1-W01B - GET/POST /api/admin/catalog/personnel
 * Gate chay TRUOC khi tao session hay repository. Khong co UI trong task nay.
 */
import { listPersonnelCatalog } from "@/lib/direct-entry/personnel-catalog-api";

/**
 * PRE-W2-HF-D3-C: free-create personnel is closed. POST is intentionally not
 * exported here — Next returns 405 for POST. Create now goes through
 * POST /api/admin/catalog/personnel/from-account (account-driven).
 */
export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return listPersonnelCatalog(request, "true", dependencies);
}
