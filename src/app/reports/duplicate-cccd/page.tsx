import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { DuplicateCccdReportPanel } from "@/components/reporting/duplicate-cccd-report-panel";
import { decideDuplicateCccdReportPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";
export const metadata = { title: "Báo cáo CCCD trùng — mini-bi" };

/**
 * P3.1-HF-R3 - /reports/duplicate-cccd.
 *
 * Server gate dung CHUNG predicate voi nav (decideDuplicateCccdReportPageAccess); quyen that
 * do RPC #74 quyet dinh lai. Khong suy quyen client-side.
 */
export default async function DuplicateCccdReportPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideDuplicateCccdReportPageAccess({ actor })) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/reports/duplicate-cccd");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW":
      return <DuplicateCccdReportPanel />;
  }
}
