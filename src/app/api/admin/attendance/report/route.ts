import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { getAttendanceAdminReport } from "@/lib/attendance/attendance-report-api";
import { createServiceAttendanceAdminReportRepository } from "@/lib/attendance/attendance-report-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceAttendanceAdminReportRepository(),
};

export async function GET(request: Request): Promise<Response> {
  return getAttendanceAdminReport(request, dependencies);
}
