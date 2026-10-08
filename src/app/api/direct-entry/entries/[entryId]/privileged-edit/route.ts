import "server-only";

/**
 * P2.5-HF-R3 - POST /api/direct-entry/entries/[entryId]/privileged-edit
 *
 * Sua truc tiep ho so da gui (DRAFT hoac SUBMITTED) cho Admin (entry_admin + all scope) va
 * bundle BoD/Ke toan (entry_privileged_edit + all scope): reason, OCC, idempotency, revision
 * va audit bat bien. Submission dang REVIEW van bi khoa.
 * Gate DIRECT_ENTRY_API_ENABLED chay TRUOC khi parse body, tao session hay repository.
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { privilegedEditEntry } from "@/lib/direct-entry/privileged-edit-api";
import { createPrivilegedEditRepository } from "@/lib/direct-entry/privileged-edit-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ entryId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  const { entryId } = await context.params;
  return privilegedEditEntry(request, entryId, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createPrivilegedEditRepository(),
  });
}
