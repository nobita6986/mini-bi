import "server-only";

import { getAttendanceTime } from "@/lib/attendance/attendance-api";
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return getAttendanceTime(request, process.env, {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  });
}
