import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { previewTemplate } from "@/lib/work-reports/template-api";
import { createWorkReportTemplateRepository } from "@/lib/work-reports/template-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createWorkReportTemplateRepository(),
};

export async function GET(request: Request, context: { params: Promise<{ templateId: string }> }): Promise<Response> {
  const { templateId } = await context.params;
  const versionId = new URL(request.url).searchParams.get("version_id") ?? "";
  return previewTemplate(templateId, versionId, process.env.WORK_REPORTS_API_ENABLED, dependencies);
}
