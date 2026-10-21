import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { WorkReportAnalytics } from "@/components/work-reports/analytics/work-report-analytics";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { decideWorkReportAnalyticsPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tổng hợp báo cáo — Mini BI" };

export default async function WorkReportAnalyticsPage() {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") notFound();
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideWorkReportAnalyticsPageAccess({ actor })) {
    case "NOT_FOUND": notFound();
    case "REDIRECT_LOGIN": redirect("/login?next=/work-reports/analytics");
    case "ACCOUNT_UNAVAILABLE": return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE": return <TemporaryUnavailable />;
    case "ACCESS_DENIED": return <AccessDenied />;
    case "ALLOW":
      return <PageShell>
        <PageHeader eyebrow="Báo cáo công việc" title="Tổng hợp báo cáo" description="KPI, chỉ tiêu và bài nộp nguồn trong phạm vi quyền hiện hành." />
        <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/work-reports">Quay lại báo cáo của tôi</Link>
        <WorkReportAnalytics />
      </PageShell>;
  }
}
