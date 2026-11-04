import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { postAttendanceSlotPolicyUnassignAdmin } from "@/lib/attendance/attendance-monthly-matrix-api";
import { createServiceAttendanceMonthlyMatrixRepository } from "@/lib/attendance/attendance-monthly-matrix-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceAttendanceMonthlyMatrixRepository(),
};

type RouteContext = {
  params: Promise<{ assignmentId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { assignmentId } = await context.params;
  return postAttendanceSlotPolicyUnassignAdmin(request, assignmentId, dependencies);
}
