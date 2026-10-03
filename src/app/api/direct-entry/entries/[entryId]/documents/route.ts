import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { uploadDirectEntryDocument } from "@/lib/direct-entry/document-api";
import { unavailableDocumentStorageAdapter } from "@/lib/direct-entry/document-storage-adapter";
import { createDirectEntryWriteRepository } from "@/lib/direct-entry/write-repository";

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
  return uploadDirectEntryDocument(request, entryId, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createDirectEntryWriteRepository(),
    storage: unavailableDocumentStorageAdapter,
  });
}
