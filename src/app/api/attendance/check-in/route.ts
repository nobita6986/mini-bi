import "server-only";

import { postAttendanceCheckIn } from "@/lib/attendance/attendance-api";
import { createServiceAttendanceRepository } from "@/lib/attendance/attendance-repository";
import { createR2AttendanceStorage } from "@/lib/attendance/r2-attendance-storage";
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return postAttendanceCheckIn(request, process.env, {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createServiceAttendanceRepository(),
    storage: createR2AttendanceStorage(),
  });
}
