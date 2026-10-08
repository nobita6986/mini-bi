import "server-only";

/**
 * P2.5-HF-R1 - GET /api/direct-entry/workers/episodes
 *
 * Tra cuu episode cua mot nguoi theo ten (trong project dich) hoac theo CCCD chuan hoa,
 * gioi han page_size/offset. Actor chi lay tu server session; quyen (manager co assignment
 * hieu luc o project dich, hoac all-scope admin) do RPC quyet dinh.
 * Gate DIRECT_ENTRY_API_ENABLED chay TRUOC khi parse query, tao session hay repository.
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { lookupWorkerEpisodes } from "@/lib/direct-entry/worker-episode-lookup-api";
import { createWorkerEpisodeLookupRepository } from "@/lib/direct-entry/worker-episode-lookup-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  return lookupWorkerEpisodes(request, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createWorkerEpisodeLookupRepository(),
  });
}
