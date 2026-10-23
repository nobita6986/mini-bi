import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { listOffboardingReport } from "@/lib/workforce/offboarding-report-api";
import { createOffboardingReportRepository } from "@/lib/workforce/offboarding-report-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createOffboardingReportRepository(),
};

export async function GET(request: Request): Promise<Response> {
  return listOffboardingReport(request, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}
