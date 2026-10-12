import type { ReactNode } from "react";
import { connection } from "next/server";

import { AppShell } from "@/components/app-shell/app-shell";
import { resolveNavActorForAppShell } from "@/lib/navigation/resolve-nav-actor";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";

/**
 * P3.1-HF-R3 - layout khu vuc /reports.
 *
 * Bao cao CCCD trung la mot surface doc-only tap trung, tach khoi Direct Entry UI va Admin
 * area. Layout chi wrap AppShell va resolve actor projection (React cache, request-scoped)
 * de nav loc dung `NAV_ENTRIES`; quyen that do page gate + RPC quyet dinh.
 * `adminNavigationEnabled: true` dam bao actor luon duoc resolve cho nav ke ca khi Direct
 * Entry UI flag off (bao cao khong phu thuoc flag do o tang page).
 */
export default async function ReportsLayout({ children }: { children: ReactNode }) {
  await connection();
  const directEntryEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);
  const actor = await resolveNavActorForAppShell({
    directEntryEnabled,
    adminNavigationEnabled: true,
  });
  return <AppShell actor={actor}>{children}</AppShell>;
}
