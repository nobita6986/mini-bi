import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { MyObligations } from "@/components/work-reports/renderer/my-obligations";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import {
  workReportAnalyticsPredicate,
  workReportAssignmentPredicate,
  workReportTemplateManagePredicate,
} from "@/lib/navigation/registry-capability";

export const dynamic = "force-dynamic";

export default async function WorkReportsPage() {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") notFound();
  const resolution = await resolveActorForRequest().catch(() => null);
  const actor = resolution?.ok ? resolution.actor : null;
  return <PageShell>
    <PageHeader eyebrow="Báo cáo công việc" title="Cần báo cáo" description="Các báo cáo được giao cho bạn; lưu nháp hoặc nộp trước hạn." />
    <nav aria-label="Báo cáo công việc" className="flex flex-wrap gap-3 text-sm">
      <Link className="text-primary underline-offset-4 hover:underline" href="/work-reports/my-reports">Lịch sử của tôi</Link>
      {actor && workReportAnalyticsPredicate(actor) ? <Link className="text-primary underline-offset-4 hover:underline" href="/work-reports/analytics">Tổng hợp báo cáo</Link> : null}
      {actor && workReportAssignmentPredicate(actor) ? <Link className="text-primary underline-offset-4 hover:underline" href="/work-reports/assignments">Giao báo cáo</Link> : null}
      {actor && workReportTemplateManagePredicate(actor) ? <Link className="text-primary underline-offset-4 hover:underline" href="/work-reports/templates">Quản lý mẫu</Link> : null}
    </nav>
    <MyObligations />
  </PageShell>;
}
