import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { postDirectEntryCccdReviewResolution } from "@/lib/direct-entry/cccd-review-api";
import { createServiceCccdReviewRepository } from "@/lib/direct-entry/cccd-review-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ entryId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json(
      { ok: false, code: "NOT_FOUND" },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const { entryId } = await context.params;
  return postDirectEntryCccdReviewResolution(
    request,
    entryId,
    process.env.DIRECT_ENTRY_API_ENABLED,
    {
      resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
      reviewRepository: createServiceCccdReviewRepository(),
    },
  );
}
