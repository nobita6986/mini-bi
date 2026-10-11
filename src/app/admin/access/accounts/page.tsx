import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { AccountManager } from "@/components/admin/account-manager";
import { decideAccountAccessPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function ExistingAccountAccessPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideAccountAccessPageAccess({ actor })) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/access/accounts");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW":
      return <AccountManager />;
  }
}
