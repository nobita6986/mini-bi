import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { postOrPutAttendanceSlotPolicyProfileAdmin } from "@/lib/attendance/attendance-monthly-matrix-api";
import { createServiceAttendanceMonthlyMatrixRepository } from "@/lib/attendance/attendance-monthly-matrix-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceAttendanceMonthlyMatrixRepository(),
};

type RouteContext = {
  params: Promise<{ profileId: string }>;
};

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { profileId } = await context.params;
  return postOrPutAttendanceSlotPolicyProfileAdmin(request, profileId, dependencies);
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { profileId } = await context.params;
  return postOrPutAttendanceSlotPolicyProfileAdmin(request, profileId, dependencies);
}
