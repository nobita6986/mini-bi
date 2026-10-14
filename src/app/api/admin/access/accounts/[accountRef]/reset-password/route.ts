import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { resetPassword } from "@/lib/admin/account-operation-api";
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountRef: string }> },
): Promise<Response> {
  const { accountRef } = await params;
  return resetPassword(request, accountRef, process.env.DIRECT_ENTRY_API_ENABLED, dependencies);
}
