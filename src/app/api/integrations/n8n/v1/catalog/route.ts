import "server-only";

import { handleN8nBodCatalogGet } from "@/lib/integrations/n8n/http-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleN8nBodCatalogGet(request);
}
