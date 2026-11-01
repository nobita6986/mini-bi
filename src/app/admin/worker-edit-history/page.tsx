import { redirect } from "next/navigation";

import { WorkerEditHistoryManager } from "@/components/admin/worker-edit-history-manager";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { decideWorkerEditHistoryPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function AdminWorkerEditHistoryPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideWorkerEditHistoryPageAccess({ actor })) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/worker-edit-history");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW":
      return <WorkerEditHistoryManager />;
  }
}
