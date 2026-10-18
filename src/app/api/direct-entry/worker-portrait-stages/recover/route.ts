import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { recoverWorkerPortraitStage } from "@/lib/direct-entry/worker-portrait-stage-api";
import { createWorkerPortraitStageRepository } from "@/lib/direct-entry/worker-portrait-stage-repository";
import { createR2DocumentStorage } from "@/lib/direct-entry/r2-document-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  return recoverWorkerPortraitStage(request, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createWorkerPortraitStageRepository(),
    storage: createR2DocumentStorage(),
  });
}
