import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { listPendingWorkReportReviews } from "@/lib/work-reports/review-api";
import { createReviewRepository } from "@/lib/work-reports/review-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return listPendingWorkReportReviews(request, process.env.WORK_REPORTS_API_ENABLED, {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createReviewRepository(),
  });
}
