import "server-only";

/**
 * P1.6-W04-S04C-S02A - POST /api/direct-entry/change-requests
 * P1.6-W04-S04C-S02B - GET  /api/direct-entry/change-requests
 *
 * POST: tao change request cho entry thuoc submission da SUBMITTED.
 * GET:  liet ke change request ma actor duoc phep xem (keyset pagination).
 * Gate DIRECT_ENTRY_API_ENABLED chay TRUOC khi tao session hay repository.
 * POST semantics khong doi.
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createChangeRequest } from "@/lib/direct-entry/change-request-api";
import { listChangeRequests } from "@/lib/direct-entry/change-request-read-api";
import { createChangeRequestReadRepository } from "@/lib/direct-entry/change-request-read-repository";
import { createChangeRequestRepository } from "@/lib/direct-entry/change-request-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  return createChangeRequest(request, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createChangeRequestRepository(),
  });
}

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  return listChangeRequests(request, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createChangeRequestReadRepository(),
  });
}
