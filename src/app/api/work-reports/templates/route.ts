import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { createWorkReportTemplateRepository } from "@/lib/work-reports/template-repository";
import { createTemplate, listTemplates } from "@/lib/work-reports/template-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createWorkReportTemplateRepository(),
};

export async function GET(): Promise<Response> {
  return listTemplates(process.env.WORK_REPORTS_API_ENABLED, dependencies);
}

export async function POST(request: Request): Promise<Response> {
  return createTemplate(request, process.env.WORK_REPORTS_API_ENABLED, dependencies);
}
