import "server-only";

import { handleN8nBodQueryPost } from "@/lib/integrations/n8n/http-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleN8nBodQueryPost(request);
}
