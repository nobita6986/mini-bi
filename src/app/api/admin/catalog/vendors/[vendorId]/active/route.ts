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
 * P3.1-W02-B - POST /api/admin/catalog/vendors/[vendorId]/active
 * Fail closed: deactivation chi doi co active cua Vendor; representation
 * recruiter theo Vendor trong cung transaction (DB), khong xoa du lieu.
 */
import { setVendorCatalogActive } from "@/lib/direct-entry/vendor-catalog-api";

export async function POST(
  request: Request, context: { params: Promise<{ vendorId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { vendorId } = await context.params;
  return setVendorCatalogActive(request, vendorId, "true", dependencies);
}
