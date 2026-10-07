import "server-only";

/**
 * P2.5-W06A - GET/POST /api/direct-entry/projects
 * Gate chay TRUOC khi tao session hay repository.
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createProjectAdminRepository } from "@/lib/direct-entry/project-admin-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATE = () => Response.json({ ok: false, code: "NOT_FOUND" }, {
  status: 404,
  headers: { "Cache-Control": "private, no-store" },
});

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createProjectAdminRepository(),
};

import { createProjectAdmin, listProjectsAdmin } from "@/lib/direct-entry/project-admin-api";

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return listProjectsAdmin(request, "true", dependencies);
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return createProjectAdmin(request, "true", dependencies);
}
