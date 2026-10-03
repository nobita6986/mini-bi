import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { finalizeDirectEntryDocument } from "@/lib/direct-entry/document-finalize-api";
import { createR2DocumentStorage } from "@/lib/direct-entry/r2-document-storage";
import { createDirectEntryWriteRepository } from "@/lib/direct-entry/write-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ entryId: string; documentId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  const { entryId, documentId } = await context.params;
  return finalizeDirectEntryDocument(request, entryId, documentId, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createDirectEntryWriteRepository(),
    storage: createR2DocumentStorage(),
  });
}