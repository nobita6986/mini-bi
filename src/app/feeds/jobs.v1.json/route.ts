import { handleRecruitmentPostPublicFeedV1 } from "../../../lib/recruitment-posts/api";
import { createRecruitmentPostRepository } from "../../../lib/recruitment-posts/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const repository = createRecruitmentPostRepository();

export async function GET(request: Request): Promise<Response> {
  return handleRecruitmentPostPublicFeedV1(request, { repository });
}
