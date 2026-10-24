import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { getAttendanceSelfHistory } from "@/lib/attendance/attendance-report-api";
import { createServiceAttendanceSelfHistoryRepository } from "@/lib/attendance/attendance-self-history-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceAttendanceSelfHistoryRepository(),
};

export async function GET(request: Request): Promise<Response> {
  return getAttendanceSelfHistory(request, dependencies);
}
