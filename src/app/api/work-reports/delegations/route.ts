import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import {
  createWorkReportDelegation,
  listWorkReportDelegations,
} from "@/lib/work-reports/delegation-api";
import { createDelegationRepository } from "@/lib/work-reports/delegation-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return listWorkReportDelegations(request, process.env.WORK_REPORTS_API_ENABLED, {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createDelegationRepository(),
  });
}

export async function POST(request: Request): Promise<Response> {
  return createWorkReportDelegation(request, process.env.WORK_REPORTS_API_ENABLED, {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createDelegationRepository(),
  });
}
