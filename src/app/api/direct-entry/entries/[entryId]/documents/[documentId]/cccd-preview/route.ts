import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { previewCccdDocument } from "@/lib/direct-entry/document-finalize-api";
import { createR2DocumentStorage } from "@/lib/direct-entry/r2-document-storage";
import { createDirectEntryWriteRepository } from "@/lib/direct-entry/write-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ entryId: string; documentId: string }> },
): Promise<Response> {
  const { entryId, documentId } = await context.params;
  return previewCccdDocument(request, entryId, documentId,
    process.env.DIRECT_ENTRY_API_ENABLED === "true" ? "true" : undefined, {
      resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
      repository: createDirectEntryWriteRepository(),
      storage: createR2DocumentStorage(),
    });
}
