import "server-only";

import { handleHrpSyncCatalogGet } from "@/lib/integrations/hrp/catalog-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleHrpSyncCatalogGet(request);
}
