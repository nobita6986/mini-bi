import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { getTemplate, updateTemplate } from "@/lib/work-reports/template-api";
import { createWorkReportTemplateRepository } from "@/lib/work-reports/template-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createWorkReportTemplateRepository(),
};

export async function GET(_request: Request, context: { params: Promise<{ templateId: string }> }): Promise<Response> {
  const { templateId } = await context.params;
  return getTemplate(templateId, process.env.WORK_REPORTS_API_ENABLED, dependencies);
}

export async function PATCH(request: Request, context: { params: Promise<{ templateId: string }> }): Promise<Response> {
  const { templateId } = await context.params;
  return updateTemplate(request, templateId, process.env.WORK_REPORTS_API_ENABLED, dependencies);
}
