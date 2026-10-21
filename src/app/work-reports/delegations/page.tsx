import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { DelegationManager } from "@/components/work-reports/renderer/delegation-manager";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { workReportDelegationPredicate } from "@/lib/navigation/registry-capability";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ủy quyền báo cáo — Mini BI" };

export default async function WorkReportDelegationsPage() {
  if (process.env.WORK_REPORTS_API_ENABLED !== "true") notFound();
  const resolution = await resolveActorForRequest().catch(() => null);
  if (!resolution) return <TemporaryUnavailable />;
  if (!resolution.ok) {
    if (resolution.reason === "UNAUTHENTICATED") redirect("/login?next=/work-reports/delegations");
    if (resolution.reason === "ACTOR_MAPPING_MISSING" || resolution.reason === "ACTOR_DISABLED") return <AccountUnavailable />;
    return <TemporaryUnavailable />;
  }
  return workReportDelegationPredicate(resolution.actor) ? <PageShell>
    <PageHeader eyebrow="Báo cáo công việc" title="Ủy quyền" description="Giao quyền báo cáo trong phạm vi và thời hạn được máy chủ cấp phép." />
    <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/work-reports">Quay lại báo cáo công việc</Link>
    <DelegationManager />
  </PageShell> : <AccessDenied />;
}
