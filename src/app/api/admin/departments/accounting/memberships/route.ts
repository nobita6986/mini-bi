import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import {
  assignAccountingMemberAdmin,
  listAccountingMembershipsAdmin,
} from "@/lib/departments/department-api";
import { createServiceDepartmentRepository } from "@/lib/departments/department-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createServiceDepartmentRepository(),
};

export async function GET(request: Request): Promise<Response> {
  return listAccountingMembershipsAdmin(request, dependencies);
}

export async function POST(request: Request): Promise<Response> {
  return assignAccountingMemberAdmin(request, dependencies);
}
