import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { ProvinceCatalogManager } from "@/components/admin/province-catalog-manager";
import { decideRecruitmentLocationCatalogPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Danh mục Tỉnh/Thành tuyển dụng — Hệ thống báo cáo HRP",
};

export default async function ProvinceCatalogPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideRecruitmentLocationCatalogPageAccess({ actor })) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/catalog/provinces");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW":
      return <ProvinceCatalogManager />;
  }
}
