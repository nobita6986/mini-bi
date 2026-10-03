import "server-only";

/**
 * P1.6-W04-S04C-S02C - GET /api/direct-entry/submissions/[submissionId]
 *
 * Chi tiet mot submission cua chinh actor. Submission khong ton tai VA submission cua actor khac
 * tra cung mot ma 404 (chong enumeration). Gate chay TRUOC params/session/repository.
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { readOwnSubmission } from "@/lib/direct-entry/submission-read-api";
import { createSubmissionReadRepository } from "@/lib/direct-entry/submission-read-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ submissionId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  const { submissionId } = await context.params;
  return readOwnSubmission(request, submissionId, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createSubmissionReadRepository(),
  });
}
