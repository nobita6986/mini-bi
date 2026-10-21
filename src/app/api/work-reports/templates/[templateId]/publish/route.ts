import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { templateAction } from "@/lib/work-reports/template-api";
import { createWorkReportTemplateRepository } from "@/lib/work-reports/template-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createWorkReportTemplateRepository(),
};
export async function POST(request: Request, context: { params: Promise<{ templateId: string }> }): Promise<Response> {
  return templateAction(request, (await context.params).templateId, "publish", process.env.WORK_REPORTS_API_ENABLED, dependencies);
}
