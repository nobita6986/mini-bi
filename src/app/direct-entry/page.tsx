import { notFound, redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { DirectEntryShell } from "@/components/direct-entry/direct-entry-shell";
import { decideDirectEntryPageAccess } from "@/lib/auth/direct-entry-page-access";
import { resolveActorForRequest } from "@/lib/navigation/resolve-nav-actor";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";

export const dynamic = "force-dynamic";

export const metadata = { title: "Nhập liệu trực tiếp — mini-bi" };

export default async function DirectEntryPage() {
  const uiEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);

  // P3-W06A R1: dung `resolveActorForRequest` (React cache, request-scoped)
  // thay vi goi truc tiep `getDirectEntryActor`/`resolveSessionWithBoundedRetry`
  // o day. Layout (AppShell) da goi `resolveNavActorForAppShell` → cung cache
  // key → chi 1 lan Supabase getUser + 1 lan actor repository resolution.
  //
  // Khi Direct Entry UI flag off, layout khong can actor va khong query;
  // page cung khong query (chi can NOT_FOUND → trang 404). Tranh hoan toan
  // actor query thua.
  const actor = uiEnabled
    ? await resolveActorForRequest().catch(() => null)
    : null;

  switch (decideDirectEntryPageAccess({ uiEnabled, actor })) {
    case "NOT_FOUND":
      notFound();
      // notFound() tra ve never; cac nhanh sau khong the chay.
    case "REDIRECT_LOGIN":
      redirect("/login?next=/direct-entry");
    case "ACCOUNT_UNAVAILABLE":
      return <AccountUnavailable />;
    case "TEMPORARY_UNAVAILABLE":
      return <TemporaryUnavailable />;
    case "ACCESS_DENIED":
      return <AccessDenied />;
    case "ALLOW":
      return (
        <DirectEntryShell
          mode={process.env.DIRECT_ENTRY_API_ENABLED === "true" ? "live" : "demo"}
        />
      );
  }
}