import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { failJson } from "@/lib/http/direct-entry-api-guard";
import { createR2SalaryAdvanceEvidenceStorage } from "@/lib/salary-advance/r2-salary-advance-evidence-storage";
import { handlePostReserveSalaryAdvanceEvidence } from "@/lib/salary-advance/salary-advance-api";
import { createSalaryAdvanceRepository } from "@/lib/salary-advance/salary-advance-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const repository = createSalaryAdvanceRepository();
const resolveSession = () =>
  getDirectEntryActor(createDirectEntryActorRepository());

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  const { requestId } = await context.params;
  return handlePostReserveSalaryAdvanceEvidence(
    request,
    requestId,
    process.env.DIRECT_ENTRY_API_ENABLED,
    {
      resolveSession,
      repository,
      storage: createR2SalaryAdvanceEvidenceStorage(),
    },
  );
}
