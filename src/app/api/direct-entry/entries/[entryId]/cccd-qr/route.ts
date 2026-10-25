import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import {
  getDirectEntryCccdQr,
  processDirectEntryCccdQr,
} from "@/lib/direct-entry/cccd-qr-api";
import { createServiceCccdQrRepository } from "@/lib/direct-entry/cccd-qr-repository";
import { createR2DocumentStorage } from "@/lib/direct-entry/r2-document-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ entryId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json(
      { ok: false, code: "NOT_FOUND" },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const { entryId } = await context.params;
  return getDirectEntryCccdQr(request, entryId, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    qrRepository: createServiceCccdQrRepository(),
    storage: createR2DocumentStorage(),
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ entryId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json(
      { ok: false, code: "NOT_FOUND" },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  const { entryId } = await context.params;
  return processDirectEntryCccdQr(request, entryId, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    qrRepository: createServiceCccdQrRepository(),
    storage: createR2DocumentStorage(),
  });
}
