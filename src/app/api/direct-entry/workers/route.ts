import "server-only";

/**
 * P2.5-W03 - GET /api/direct-entry/workers
 *
 * Worker directory theo audience DB-authoritative (recruiter / project manager /
 * entry_admin@all) voi keyset pagination va allowed_actions do server sinh.
 * Gate DIRECT_ENTRY_API_ENABLED chay TRUOC khi parse query, tao session hay repository.
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { listWorkers } from "@/lib/direct-entry/worker-directory-api";
import { createWorkerDirectoryRepository } from "@/lib/direct-entry/worker-directory-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  return listWorkers(request, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createWorkerDirectoryRepository(),
  });
}
