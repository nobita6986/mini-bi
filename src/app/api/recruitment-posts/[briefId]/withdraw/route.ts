import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { failJson } from "@/lib/http/direct-entry-api-guard";
import { handleRecruitmentPostWithdraw } from "@/lib/recruitment-posts/api";
import { createRecruitmentPostRepository } from "@/lib/recruitment-posts/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createRecruitmentPostRepository(),
};

export async function POST(
  request: Request,
  context: { params: Promise<{ briefId: string }> },
): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return failJson("NOT_FOUND", 404);
  }
  const { briefId } = await context.params;
  return handleRecruitmentPostWithdraw(
    request,
    briefId,
    process.env.DIRECT_ENTRY_API_ENABLED,
    dependencies,
  );
}
