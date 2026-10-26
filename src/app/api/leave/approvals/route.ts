import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { handleGetApprovalInbox } from "@/lib/leave/leave-api";
import { createLeaveRepository } from "@/lib/leave/leave-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createLeaveRepository(),
};

export async function GET(request: Request): Promise<Response> {
  return handleGetApprovalInbox(
    request,
    process.env.DIRECT_ENTRY_API_ENABLED,
    dependencies,
  );
}
