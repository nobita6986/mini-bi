import { notFound, redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { DirectEntryShell } from "@/components/direct-entry/direct-entry-shell";
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { resolveSessionWithBoundedRetry } from "@/lib/auth/direct-entry-session-retry";
import { decideDirectEntryPageAccess } from "@/lib/auth/direct-entry-page-access";
import type { ActorResolution } from "@/lib/auth/direct-entry-v2";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";

export const dynamic = "force-dynamic";

export const metadata = { title: "Nhập liệu trực tiếp — mini-bi" };

export default async function DirectEntryPage() {
  const uiEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);
  let actor: ActorResolution | null = null;
  if (uiEnabled) {
    // P1.7-H07: bounded retry (toi da 1 lan) cho transient SSR errors; chi
    // fallback ve `null` (=> TEMPORARY_UNAVAILABLE) neu retry cung throw.
    try {
      const session = await resolveSessionWithBoundedRetry(() =>
        getDirectEntryActor(createDirectEntryActorRepository()));
      actor = session.actor;
    } catch {
      actor = null;
    }
  }

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
