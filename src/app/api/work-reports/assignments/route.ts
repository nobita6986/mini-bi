import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createWorkReportAssignment, listWorkReportAssignmentOptions } from "@/lib/work-reports/assignment-api";
import { createAssignmentRepository } from "@/lib/work-reports/assignment-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
  return createWorkReportAssignment(request, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createAssignmentRepository(),
  });
}

export async function GET(request: Request): Promise<Response> {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
  return listWorkReportAssignmentOptions(request, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createAssignmentRepository(),
  });
}
