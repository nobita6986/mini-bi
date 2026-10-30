import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { failJson } from "@/lib/http/direct-entry-api-guard";
import { handleGetSalaryAdvanceProjectWorkerHistory } from "@/lib/salary-advance/salary-advance-api";
import { createSalaryAdvanceRepository } from "@/lib/salary-advance/salary-advance-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createSalaryAdvanceRepository(),
};

export async function GET(
  request: Request,
  context: {
    params: Promise<{ projectId: string; workerEntryId: string }>;
  },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  const { projectId, workerEntryId } = await context.params;
  return handleGetSalaryAdvanceProjectWorkerHistory(
    request,
    projectId,
    workerEntryId,
    process.env.DIRECT_ENTRY_API_ENABLED,
    dependencies,
  );
}
