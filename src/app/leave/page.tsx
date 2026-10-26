import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";

import { AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { LeaveManagementWorkspace } from "@/components/leave/leave-management-workspace";
import { decideLeavePageAccess } from "@/lib/leave/leave-ui-model";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Quản lý nghỉ phép — Hệ thống báo cáo HRP",
};

export default async function LeaveManagementPage() {
  await connection();
  const actor = await resolveActorForRequest().catch(() => null);
  const decision = decideLeavePageAccess({
    enabledFlag: process.env.DIRECT_ENTRY_API_ENABLED,
    actor,
  });

  switch (decision) {
    case "NOT_FOUND":
      notFound();
    case "REDIRECT_LOGIN":
      redirect("/login?next=%2Fleave");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ALLOW":
      return <LeaveManagementWorkspace />;
  }
}
