import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { failJson } from "@/lib/http/direct-entry-api-guard";
import { handlePostEndGlobalRoleAdmin } from "@/lib/vendor-finance/vendor-finance-api";
import { createVendorFinanceRepository } from "@/lib/vendor-finance/vendor-finance-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createVendorFinanceRepository(),
};

export async function POST(
  request: Request,
  context: { params: Promise<{ roleGrantId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  const { roleGrantId } = await context.params;
  return handlePostEndGlobalRoleAdmin(
    request,
    roleGrantId,
    process.env.DIRECT_ENTRY_API_ENABLED,
    dependencies,
  );
}
