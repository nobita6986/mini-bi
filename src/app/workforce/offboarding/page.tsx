import { notFound, redirect } from "next/navigation";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
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
    case "ALLOW": redirect("/dashboard?tab=offboarding");
  }
}
