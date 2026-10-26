import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import {
  getRecruiterLinkCandidates,
  linkRecruiterToAccount,
} from "@/lib/admin/account-operation-api";
import { createAccountOperationRepository } from "@/lib/admin/account-operation-repository";
import {
  createAuthAccount,
  resetAuthPassword,
  readAuthUserProvenance,
  findAuthUserByLoginId,
} from "@/lib/admin/account-operation-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createAccountOperationRepository(),
  auth: { createAuthAccount, resetAuthPassword, readAuthUserProvenance, findAuthUserByLoginId },
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ recruiterId: string }> },
): Promise<Response> {
  const { recruiterId } = await params;
  return getRecruiterLinkCandidates(request, recruiterId, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ recruiterId: string }> },
): Promise<Response> {
  const { recruiterId } = await params;
  return linkRecruiterToAccount(request, recruiterId, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}
