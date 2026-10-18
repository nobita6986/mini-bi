import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import {
  deleteWorkerPortraitStage,
  postWorkerPortraitStage,
} from "@/lib/direct-entry/worker-portrait-stage-api";
import { createWorkerPortraitStageRepository } from "@/lib/direct-entry/worker-portrait-stage-repository";
import { createR2DocumentStorage } from "@/lib/direct-entry/r2-document-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dependencies() {
  return {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createWorkerPortraitStageRepository(),
    storage: createR2DocumentStorage(),
  };
}

export async function POST(request: Request): Promise<Response> {
  return postWorkerPortraitStage(request,
    process.env.DIRECT_ENTRY_API_ENABLED === "true" ? "true" : undefined, dependencies());
}

export async function DELETE(request: Request): Promise<Response> {
  return deleteWorkerPortraitStage(request,
    process.env.DIRECT_ENTRY_API_ENABLED === "true" ? "true" : undefined, dependencies());
}
