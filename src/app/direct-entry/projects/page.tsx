import { notFound, redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { ProjectOperations } from "@/components/direct-entry/project-operations";
import { decideProjectOperationsPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";

/**
 * P2.5-W06A - Project Operations.
 *
 * Cung boundary voi /direct-entry: cung flag, cung actor resolver (React cache,
 * request-scoped), cung quyet dinh truy cap. UI chi la visibility: quyen that
 * do RPC/admin RPC enforce server-side.
 */
export const dynamic = "force-dynamic";

export const metadata = { title: "Quản lý dự án — mini-bi" };

export default async function ProjectOperationsPage() {
  const uiEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);
  const actor = uiEnabled ? await resolveActorForRequest().catch(() => null) : null;

  switch (decideProjectOperationsPageAccess({ uiEnabled, actor })) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=/direct-entry/projects");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "ALLOW":
      return <ProjectOperations />;
  }
}
