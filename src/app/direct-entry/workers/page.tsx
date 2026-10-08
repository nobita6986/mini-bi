import { notFound, redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { WorkerOperations } from "@/components/direct-entry/worker-operations";
import { decideDirectEntryPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";

/**
 * P2.5-W06 - Worker Operations. Cung boundary voi /direct-entry: cung flag, cung actor
 * resolver (request-scoped cache) va cung quyet dinh truy cap. UI chi la visibility:
 * ba audience (uploader / recruiter / project manager) do RPC worker directory quyet dinh,
 * va quyen de xuat do allowed_actions server tra.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Người lao động — mini-bi" };

export default async function WorkerOperationsPage() {
  const uiEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);
  const actor = uiEnabled ? await resolveActorForRequest().catch(() => null) : null;

  switch (decideDirectEntryPageAccess({ uiEnabled, actor })) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=/direct-entry/workers");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "ALLOW":
      return <WorkerOperations />;
  }
}
