import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { postDecideAttendanceExplanation } from "@/lib/attendance/attendance-monthly-matrix-api";
import { createServiceAttendanceMonthlyMatrixRepository } from "@/lib/attendance/attendance-monthly-matrix-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceAttendanceMonthlyMatrixRepository(),
};

type RouteContext = {
  params: Promise<{ explanationId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const { explanationId } = await context.params;
  return postDecideAttendanceExplanation(request, explanationId, dependencies);
}
