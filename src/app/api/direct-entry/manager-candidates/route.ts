import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { listManagerCandidatesAdmin } from "@/lib/direct-entry/project-admin-api";
import { createProjectAdminRepository } from "@/lib/direct-entry/project-admin-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/direct-entry/manager-candidates?search=... */
export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  return listManagerCandidatesAdmin(request, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createProjectAdminRepository(),
  });
}
