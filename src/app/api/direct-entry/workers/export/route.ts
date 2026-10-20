import "server-only";

/**
 * PRE-W2-P1 - POST /api/direct-entry/workers/export
 *
 * Xuat Excel full-PII cho audience recruited ("Người tôi tuyển") va managed ("Dự án tôi quản lý").
 * Gate DIRECT_ENTRY_API_ENABLED chay TRUOC khi doc body, tao session hay repository. Actor,
 * row authority do server session + RPC #86
 * quyet dinh; route khong danh gia quyen va khong forward raw DB message/PII.
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { exportWorkers } from "@/lib/direct-entry/worker-export-api";
import { createWorkerExportRepository } from "@/lib/direct-entry/worker-export-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, {
      status: 404,
      headers: {
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  }
  return exportWorkers(request, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createWorkerExportRepository(),
  });
}
