import { redirect } from "next/navigation";
import { connection } from "next/server";

import { AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { decideSessionPageAccess } from "@/lib/auth/session-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { fetchCutoverReporting } from "@/lib/reporting/p2-w04a-reporting-server";
import { fetchCutoverReportingOptions } from "@/lib/reporting/p2-w04a-options-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tổng quan tuyển dụng — mini-bi" };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await connection();

  // P1.7-H04: /dashboard khong con duoc bao ve boi Basic Auth, nen phai xac thuc
  // session/actor TRUOC khi doc bat ky du lieu reporting nao.
  //
  // P3-W06A R1: dung `resolveActorForRequest` (React cache, request-scoped)
  // thay vi goi truc tiep `getDirectEntryActor`/`resolveSessionWithBoundedRetry`
  // o day. Layout (AppShell) da goi cung function o cung render pass → cache
  // hit → chi 1 lan Supabase getUser + 1 lan actor repository resolution cho
  // ca layout va page.
  const actor = await resolveActorForRequest().catch(() => null);

  switch (decideSessionPageAccess(actor)) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/dashboard");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ALLOW":
      break;
  }

  // ALLOW is returned only when actor.ok is true; narrow before the scoped fetch.
  if (!actor?.ok) {
    return <TemporaryUnavailable />;
  }

  const params = await searchParams;
  const [report, options] = await Promise.all([
    fetchCutoverReporting(params, actor.actor),
    fetchCutoverReportingOptions(actor.actor),
  ]);
  // P3-W06C: the dashboard audience comes from the DB-authoritative W05A scoped
  // payload, never from a UI role. A failed read passes null so the view fails
  // closed to the narrowest scope instead of claiming the company-wide one.
  return (
    <DashboardView
      report={report}
      optionsResult={options}
      audience={report.ok ? report.audience : null}
    />
  );
}
