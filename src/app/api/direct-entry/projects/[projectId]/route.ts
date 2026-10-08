import "server-only";

/**
 * P2.5-W06A - GET/PATCH /api/direct-entry/projects/[projectId]
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

import { getProjectAdmin, updateProjectAdmin } from "@/lib/direct-entry/project-admin-api";

export async function GET(
  request: Request, context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { projectId } = await context.params;
  return getProjectAdmin(request, projectId, "true", dependencies);
}

export async function PATCH(
  request: Request, context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { projectId } = await context.params;
  return updateProjectAdmin(request, projectId, "true", dependencies);
}
