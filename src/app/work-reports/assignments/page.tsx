import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { AssignmentManager } from "@/components/work-reports/renderer/assignment-manager";
import { decideWorkReportAssignmentsPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function WorkReportAssignmentsPage() {
  const enabled = process.env.WORK_REPORTS_API_ENABLED === "true";
  if (!enabled) notFound();
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideWorkReportAssignmentsPageAccess({ actor })) {
    case "NOT_FOUND": notFound();
    case "REDIRECT_LOGIN": redirect("/login?next=/work-reports/assignments");
    case "ACCOUNT_UNAVAILABLE": return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE": return <TemporaryUnavailable />;
    case "ACCESS_DENIED": return <AccessDenied />;
    case "ALLOW":
      return <PageShell>
        <PageHeader eyebrow="Báo cáo công việc" title="Giao báo cáo" description="Tạo giao việc cho nhân viên, nhóm hoặc danh sách nhân viên." />
        <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/work-reports">Quay lại báo cáo của tôi</Link>
        <AssignmentManager />
      </PageShell>;
  }
}
