import "server-only";

/**
 * P1.6-W04-S04C-S02C - GET /api/direct-entry/submissions
 *
 * Liet ke submission cua chinh actor (DRAFT/REVIEW/SUBMITTED) voi keyset pagination.
 * Gate DIRECT_ENTRY_API_ENABLED chay TRUOC khi parse query, tao session hay repository.
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { listOwnSubmissions } from "@/lib/direct-entry/submission-read-api";
import { createSubmissionReadRepository } from "@/lib/direct-entry/submission-read-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  return listOwnSubmissions(request, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createSubmissionReadRepository(),
  });
}
