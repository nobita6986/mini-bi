import { notFound, redirect } from "next/navigation";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { DirectEntryShell } from "@/components/direct-entry/direct-entry-shell";
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";

export const dynamic = "force-dynamic";

export const metadata = { title: "Nhập liệu trực tiếp — mini-bi" };

const ENTRY_CAPABILITIES = ["entry_own", "entry_team", "entry_admin"] as const;

export default async function DirectEntryPage() {
  // Feature chưa bật: giữ hành vi fail-closed cũ (khong dung "khong co quyen" cho feature off).
  if (!isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED)) {
    notFound();
  }

  // Route guard defense-in-depth/UX; authority that van nam o API/DB.
  const session = await getDirectEntryActor(createDirectEntryActorRepository());
  const actor = session.actor;
  if (!actor.ok) {
    if (actor.reason === "UNAUTHENTICATED") {
      redirect("/login?next=/direct-entry");
    }
    return <AccountUnavailable />;
  }
  const hasEntryCapability = actor.actor.capabilities.some((capability) =>
    (ENTRY_CAPABILITIES as readonly string[]).includes(capability));
  if (!hasEntryCapability) {
    return <AccessDenied />;
  }

  return (
    <DirectEntryShell
      mode={process.env.DIRECT_ENTRY_API_ENABLED === "true" ? "live" : "demo"}
    />
  );
}
