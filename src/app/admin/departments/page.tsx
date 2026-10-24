import { notFound, redirect } from "next/navigation";

import { DepartmentListManager } from "@/components/admin/department-list-manager";
import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { decideAccountAccessPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = { title: "Phòng ban — Hệ thống báo cáo HRP" };

export default async function AdminDepartmentsPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideAccountAccessPageAccess({ actor })) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin/departments");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "ALLOW":
      return <DepartmentListManager />;
  }
}
