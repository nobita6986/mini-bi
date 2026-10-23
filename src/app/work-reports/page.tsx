import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { MyObligations } from "@/components/work-reports/renderer/my-obligations";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import {
  workReportAnalyticsPredicate,
  workReportAssignmentPredicate,
  workReportDelegationPredicate,
  workReportReviewPredicate,
  workReportTemplateManagePredicate,
} from "@/lib/navigation/registry-capability";

export const dynamic = "force-dynamic";

const subnavLinkClass =
  "inline-flex min-h-11 sm:min-h-9 items-center rounded-lg px-2.5 text-primary underline-offset-4 " +
  "transition-[color,background-color,transform] duration-[var(--ui-motion-hover,160ms)] " +
  "ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] hover:bg-primary/10 hover:underline " +
  "active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
  "motion-reduce:transition-none motion-reduce:transform-none";

export default async function WorkReportsPage() {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") notFound();
  const resolution = await resolveActorForRequest().catch(() => null);
  const actor = resolution?.ok ? resolution.actor : null;
  return <PageShell>
    <PageHeader eyebrow="Báo cáo công việc" title="Cần báo cáo" description="Các báo cáo được giao cho bạn; lưu nháp hoặc nộp trước hạn." />
    <nav aria-label="Báo cáo công việc" className="flex flex-wrap gap-1.5 text-sm">
      <Link className={subnavLinkClass} href="/work-reports/my-reports">Lịch sử của tôi</Link>
      {actor && workReportAnalyticsPredicate(actor) ? <Link className={subnavLinkClass} href="/work-reports/analytics">Tổng hợp báo cáo</Link> : null}
      {actor && workReportAssignmentPredicate(actor) ? <Link className={subnavLinkClass} href="/work-reports/assignments">Giao báo cáo</Link> : null}
      {actor && workReportTemplateManagePredicate(actor) ? <Link className={subnavLinkClass} href="/work-reports/templates">Quản lý mẫu</Link> : null}
      {actor && workReportReviewPredicate(actor) ? <Link className={subnavLinkClass} href="/work-reports/reviews">Duyệt báo cáo</Link> : null}
      {actor && workReportDelegationPredicate(actor) ? <Link className={subnavLinkClass} href="/work-reports/delegations">Ủy quyền</Link> : null}
    </nav>
    <MyObligations />
  </PageShell>;
}
