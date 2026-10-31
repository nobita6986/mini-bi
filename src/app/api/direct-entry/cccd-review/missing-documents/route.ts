import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { getDirectEntryMissingDocumentWorkers } from "@/lib/direct-entry/cccd-review-api";
import { createServiceCccdReviewRepository } from "@/lib/direct-entry/cccd-review-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json(
      { ok: false, code: "NOT_FOUND" },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  return getDirectEntryMissingDocumentWorkers(request, process.env.DIRECT_ENTRY_API_ENABLED, {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    reviewRepository: createServiceCccdReviewRepository(),
  });
}
