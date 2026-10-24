import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { getAttendanceSelfCheckInPhoto } from "@/lib/attendance/attendance-report-api";
import { createServiceAttendanceSelfHistoryRepository } from "@/lib/attendance/attendance-self-history-repository";
import { createR2AttendanceStorage } from "@/lib/attendance/r2-attendance-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceAttendanceSelfHistoryRepository(),
  storage: createR2AttendanceStorage(),
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ checkinId: string }> },
): Promise<Response> {
  const { checkinId } = await params;
  return getAttendanceSelfCheckInPhoto(request, checkinId, dependencies);
}
