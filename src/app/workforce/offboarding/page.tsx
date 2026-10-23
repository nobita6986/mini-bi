import { notFound, redirect } from "next/navigation";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { OffboardingReportPanel } from "@/components/workforce/offboarding-report-panel";
import { decideWorkforceOffboardingPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";
export const metadata = { title: "NLĐ nghỉ việc — Mini BI" };

export default async function WorkforceOffboardingPage() {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") notFound();
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideWorkforceOffboardingPageAccess({ actor })) {
    case "NOT_FOUND": notFound();
    case "REDIRECT_LOGIN": redirect("/login?next=/workforce/offboarding");
    case "ACCOUNT_UNAVAILABLE": return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE": return <TemporaryUnavailable />;
    case "ACCESS_DENIED": return <AccessDenied />;
    case "ALLOW":
      return (
        <PageShell>
          <PageHeader
            eyebrow="Báo cáo nhân sự"
            title="NLĐ nghỉ việc"
            description="Người lao động đã nghỉ ở đợt làm việc cuối và chưa có việc mới từ 3 ngày trở lên. Số điện thoại và Excel chỉ dành cho Admin / BoD."
          />
          <OffboardingReportPanel />
        </PageShell>
      );
  }
}
