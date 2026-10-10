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
 * P3.1-W02-B - GET/PATCH /api/admin/catalog/vendors/[vendorId]
 * vendorId la business key (khong phai UUID). PATCH chi nhan display_name:
 * vendor_id bat bien va active co route rieng.
 */
import { getVendorCatalog, updateVendorCatalog } from "@/lib/direct-entry/vendor-catalog-api";

export async function GET(
  request: Request, context: { params: Promise<{ vendorId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { vendorId } = await context.params;
  return getVendorCatalog(request, vendorId, "true", dependencies);
}

export async function PATCH(
  request: Request, context: { params: Promise<{ vendorId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { vendorId } = await context.params;
  return updateVendorCatalog(request, vendorId, "true", dependencies);
}
