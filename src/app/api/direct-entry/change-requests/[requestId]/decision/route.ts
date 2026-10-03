import "server-only";

/**
 * P1.6-W04-S04C-S02A - POST /api/direct-entry/change-requests/[requestId]/decision
 *
 * Reviewer approve hoac reject. Gate chay TRUOC params/session/repository; dispatch chi sau
 * khi request da duoc project strict (khong co generic action dispatch tu client).
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { decideChangeRequest } from "@/lib/direct-entry/change-request-api";
import { createChangeRequestRepository } from "@/lib/direct-entry/change-request-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  const { requestId } = await context.params;
  return decideChangeRequest(request, requestId, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createChangeRequestRepository(),
  });
}
