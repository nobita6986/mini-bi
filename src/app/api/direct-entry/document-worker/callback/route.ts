import "server-only";

import { receiveDocumentWorkerCallback } from "@/lib/direct-entry/document-worker-callback-api";
import { createDirectEntryWriteRepository } from "@/lib/direct-entry/write-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return receiveDocumentWorkerCallback(request, process.env.DIRECT_ENTRY_API_ENABLED, {
    repository: createDirectEntryWriteRepository(),
    secret: process.env.DIRECT_ENTRY_DOCUMENT_CALLBACK_SECRET,
  });
}
