import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { postAttendanceBranchAssignmentAdmin } from "@/lib/attendance/attendance-monthly-matrix-api";
import { createServiceAttendanceMonthlyMatrixRepository } from "@/lib/attendance/attendance-monthly-matrix-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceAttendanceMonthlyMatrixRepository(),
};

export async function POST(request: Request): Promise<Response> {
  return postAttendanceBranchAssignmentAdmin(request, dependencies);
}
