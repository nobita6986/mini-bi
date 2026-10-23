import { redirect } from "next/navigation";

import { AttendanceReportManager } from "@/components/admin/attendance-report-manager";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { decideAttendanceReportPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function AdminAttendanceReportPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideAttendanceReportPageAccess({ actor })) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/attendance");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW":
      return <AttendanceReportManager />;
  }
}
