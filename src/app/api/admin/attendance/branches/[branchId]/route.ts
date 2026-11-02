import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { postOrPutAttendanceBranchAdmin } from "@/lib/attendance/attendance-monthly-matrix-api";
import { createServiceAttendanceMonthlyMatrixRepository } from "@/lib/attendance/attendance-monthly-matrix-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceAttendanceMonthlyMatrixRepository(),
};

type RouteContext = {
  params: Promise<{ branchId: string }>;
};

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { branchId } = await context.params;
  return postOrPutAttendanceBranchAdmin(request, branchId, dependencies);
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { branchId } = await context.params;
  return postOrPutAttendanceBranchAdmin(request, branchId, dependencies);
}
