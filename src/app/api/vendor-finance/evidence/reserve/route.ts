import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { failJson } from "@/lib/http/direct-entry-api-guard";
import { createR2VendorFinanceEvidenceStorage } from "@/lib/vendor-finance/r2-evidence-storage";
import { handlePostReserveVendorFinanceEvidence } from "@/lib/vendor-finance/vendor-finance-api";
import { createVendorFinanceRepository } from "@/lib/vendor-finance/vendor-finance-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const repository = createVendorFinanceRepository();
const resolveSession = () => getDirectEntryActor(createDirectEntryActorRepository());

export async function POST(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  return handlePostReserveVendorFinanceEvidence(
    request,
    process.env.DIRECT_ENTRY_API_ENABLED,
    {
      resolveSession,
      repository,
      storage: createR2VendorFinanceEvidenceStorage(),
    },
  );
}
