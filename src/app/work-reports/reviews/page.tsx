import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { ReviewInbox } from "@/components/work-reports/renderer/review-inbox";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { workReportReviewPredicate } from "@/lib/navigation/registry-capability";

export const dynamic = "force-dynamic";
export const metadata = { title: "Duyệt báo cáo — Mini BI" };

export default async function WorkReportReviewsPage() {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") notFound();
  const resolution = await resolveActorForRequest().catch(() => null);
  if (!resolution) return <TemporaryUnavailable />;
  if (!resolution.ok) {
    if (resolution.reason === "UNAUTHENTICATED") redirect("/login?next=/work-reports/reviews");
    if (resolution.reason === "ACTOR_MAPPING_MISSING" || resolution.reason === "ACTOR_DISABLED") return <AccountUnavailable />;
    return <TemporaryUnavailable />;
  }

  return workReportReviewPredicate(resolution.actor) ? <PageShell>
    <PageHeader eyebrow="Báo cáo công việc" title="Duyệt báo cáo" description="Hàng đợi và nội dung do máy chủ giới hạn theo phạm vi duyệt hiện hành." />
    <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/work-reports">Quay lại báo cáo công việc</Link>
    <ReviewInbox />
  </PageShell> : <AccessDenied />;
}
