import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";
import { resolveNavActorForAppShell } from "@/lib/navigation/resolve-nav-actor";

export default async function WorkReportsLayout({ children }: { children: ReactNode }) {
  const actor = await resolveNavActorForAppShell({
    directEntryEnabled: isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED),
    adminNavigationEnabled: true,
  });
  return <AppShell actor={actor}>{children}</AppShell>;
}
