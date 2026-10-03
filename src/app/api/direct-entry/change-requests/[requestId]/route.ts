import "server-only";

/**
 * P1.6-W04-S04C-S02B - GET /api/direct-entry/change-requests/[requestId]
 *
 * Chi tiet mot change request ma actor duoc phep xem. Khong tim thay va khong co quyen
 * tra cung mot ma 404 de tranh enumeration. Gate chay TRUOC params/session/repository.
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { readChangeRequest } from "@/lib/direct-entry/change-request-read-api";
import { createChangeRequestReadRepository } from "@/lib/direct-entry/change-request-read-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
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
  return readChangeRequest(request, requestId, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createChangeRequestReadRepository(),
  });
}
