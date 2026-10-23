import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { hideOffboardingWorker } from "@/lib/workforce/offboarding-report-api";
import { createOffboardingReportRepository } from "@/lib/workforce/offboarding-report-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createOffboardingReportRepository(),
};

export async function POST(request: Request): Promise<Response> {
  return hideOffboardingWorker(request, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}
