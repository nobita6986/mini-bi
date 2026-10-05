import { redirect } from "next/navigation";
import { connection } from "next/server";

import { AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { resolveSessionWithBoundedRetry } from "@/lib/auth/direct-entry-session-retry";
import { decideSessionPageAccess } from "@/lib/auth/session-page-access";
import type { ActorResolution } from "@/lib/auth/direct-entry-v2";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { fetchCutoverReporting } from "@/lib/reporting/p2-w04a-reporting-server";
import { fetchCutoverReportingOptions } from "@/lib/reporting/p2-w04a-options-server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tổng quan tuyển dụng — mini-bi" };

type SearchParams = Record<string, string | string[] | undefined>;

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await connection();

  // P1.7-H04: /dashboard khong con duoc bao ve boi Basic Auth, nen phai xac thuc
  // session/actor TRUOC khi doc bat ky du lieu reporting nao.
  let actor: ActorResolution | null = null;
  try {
    const session = await resolveSessionWithBoundedRetry(() =>
      getDirectEntryActor(createDirectEntryActorRepository()));
    actor = session.actor;
  } catch {
    actor = null;
  }

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

  const params = await searchParams;
  const [report, options] = await Promise.all([
    fetchCutoverReporting(params),
    fetchCutoverReportingOptions(),
  ]);
  return <DashboardView report={report} optionsResult={options} />;
}
