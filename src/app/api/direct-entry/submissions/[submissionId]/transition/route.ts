import "server-only";

/**
 * P1.6-W04-S04C-S01A - POST /api/direct-entry/submissions/[submissionId]/transition
 *
 * Chuyen trang thai submission: DRAFT -> REVIEW, REVIEW -> DRAFT, REVIEW -> SUBMITTED.
 * Gate DIRECT_ENTRY_API_ENABLED chay TRUOC khi doc params, tao session hay repository.
 * Actor/capability/scope/OCC/idempotency do server session + RPC quyet dinh.
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { transitionSubmission } from "@/lib/direct-entry/submission-transition-api";
import { createSubmissionTransitionRepository } from "@/lib/direct-entry/submission-transition-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
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
  return transitionSubmission(request, submissionId, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createSubmissionTransitionRepository(),
  });
}
