import "server-only";

/**
 * PUT/PATCH /api/direct-entry/projects/[projectId]/location
 * Updates or clears project coordinates within existing project_admin (can_manage_project_master) authority.
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { updateProjectLocationAdmin } from "@/lib/direct-entry/project-admin-api";
import { createProjectAdminRepository } from "@/lib/direct-entry/project-admin-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATE = () =>
  Response.json(
    { ok: false, code: "NOT_FOUND" },
    {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    },
  );

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createProjectAdminRepository(),
};

export async function PUT(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { projectId } = await context.params;
  return updateProjectLocationAdmin(request, projectId, "true", dependencies);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  const { projectId } = await context.params;
  return updateProjectLocationAdmin(request, projectId, "true", dependencies);
}
