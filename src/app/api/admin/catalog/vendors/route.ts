import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createVendorCatalogRepository } from "@/lib/direct-entry/vendor-catalog-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATE = () => Response.json({ ok: false, code: "NOT_FOUND" }, {
  status: 404,
  headers: { "Cache-Control": "private, no-store" },
});

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createVendorCatalogRepository(),
};

/**
 * P3.1-W02-B - GET/POST /api/admin/catalog/vendors
 * Gate chay TRUOC khi tao session hay repository. Khong co UI trong task nay.
 */
import { createVendorCatalog, listVendorsCatalog } from "@/lib/direct-entry/vendor-catalog-api";

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return listVendorsCatalog(request, "true", dependencies);
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return createVendorCatalog(request, "true", dependencies);
}
