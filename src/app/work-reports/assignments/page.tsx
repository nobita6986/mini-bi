import { notFound, redirect } from "next/navigation";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { AssignmentManager } from "@/components/work-reports/renderer/assignment-manager";
import { WorkReportsShell } from "@/components/work-reports/work-reports-shell";
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
      return (
        <WorkReportsShell
          actor={actor?.ok ? actor.actor : null}
          title="Giao báo cáo"
          description="Tạo giao việc cho nhân viên, nhóm hoặc danh sách nhân viên."
        >
          <AssignmentManager />
        </WorkReportsShell>
      );
  }
}
