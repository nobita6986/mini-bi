import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { listAccountingCandidatesAdmin } from "@/lib/departments/department-api";
import { createServiceDepartmentRepository } from "@/lib/departments/department-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceDepartmentRepository(),
};

export async function GET(request: Request): Promise<Response> {
  return listAccountingCandidatesAdmin(request, dependencies);
}
