import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { endAccountingMemberAdmin } from "@/lib/departments/department-api";
import { createServiceDepartmentRepository } from "@/lib/departments/department-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceDepartmentRepository(),
};

export async function POST(
  request: Request,
  context: { params: Promise<{ membershipId: string }> },
): Promise<Response> {
  const { membershipId } = await context.params;
  return endAccountingMemberAdmin(request, membershipId, dependencies);
}
