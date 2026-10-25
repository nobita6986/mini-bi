import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { triggerBackgroundCccdQrExtraction } from "@/lib/direct-entry/cccd-qr-api";
import { createServiceCccdQrRepository } from "@/lib/direct-entry/cccd-qr-repository";
import { postFullProfileBatch } from "@/lib/direct-entry/full-profile-api";
import { createFullProfileRepository } from "@/lib/direct-entry/full-profile-repository";
import { createDirectEntryWriteRepository } from "@/lib/direct-entry/write-repository";
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
  return postFullProfileBatch(request, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createFullProfileRepository(),
    portraitStages: createWorkerPortraitStageRepository(),
    documentRepository: createDirectEntryWriteRepository(),
    documentStorage: createR2DocumentStorage(),
    onCccdImageFinalized: (input) =>
      triggerBackgroundCccdQrExtraction({
        ...input,
        qrRepository: createServiceCccdQrRepository(),
      }),
  });
}
