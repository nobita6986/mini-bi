import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { LaborTypeCatalogManager } from "@/components/admin/labor-type-catalog-manager";
import { decideLaborTypeCatalogPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function LaborTypeCatalogPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideLaborTypeCatalogPageAccess({ actor })) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/catalog/labor-types");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW":
      return <LaborTypeCatalogManager />;
  }
}
