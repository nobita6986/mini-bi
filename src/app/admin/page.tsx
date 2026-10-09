import Link from "next/link";
import { redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { Card, CardHeader } from "@/components/ui/card";
import { decideAdminAreaAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const actor = await resolveActorForRequest().catch(() => null);
  switch (decideAdminAreaAccess({ actor })) {
    case "REDIRECT_LOGIN":
      redirect("/login?next=/admin");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "NOT_FOUND":
      return <AccessDenied />;
    case "ALLOW":
      return (
        <div className="space-y-6">
          <header>
            <h1 className="text-2xl font-semibold text-foreground">Quản trị</h1>
            <p className="mt-1 text-sm text-muted">Quản lý các danh mục được cấp quyền.</p>
          </header>
          <Card>
            <CardHeader
              title="Nhân sự"
              description="Quản lý mã, vị trí và trạng thái hồ sơ nhân sự."
            />
            <Link
              href="/admin/catalog/personnel"
              className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              Mở danh mục nhân sự
            </Link>
          </Card>
        </div>
      );
  }
}
