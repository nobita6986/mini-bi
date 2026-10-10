import "server-only";

/**
 * P3.1-HF-R1 - GET /api/direct-entry/submissions/[submissionId]/duplicate-cccd-preflight
 *
 * Preflight read-only cho DRAFT -> REVIEW: tra ve tap conflict CCCD trung da duoc mask
 * (cccd_last4), bounded va deterministic, kem fingerprint de client xac nhan lai.
 * Gate DIRECT_ENTRY_API_ENABLED chay TRUOC khi doc params, tao session hay repository.
 * Actor/capability/scope/owner do server session + RPC quyet dinh; route khong danh gia quyen.
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { duplicateCccdPreflight } from "@/lib/direct-entry/submission-duplicate-cccd-api";
import { createDuplicateCccdPreflightRepository } from "@/lib/direct-entry/submission-duplicate-cccd-repository";

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
  return duplicateCccdPreflight(request, submissionId, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createDuplicateCccdPreflightRepository(),
  });
}
