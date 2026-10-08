import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";
import { resolveNavActorForAppShell } from "@/lib/navigation/resolve-nav-actor";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";

/**
 * P3-W06A: page boundary resolve actor một lần và truyền vào AppShell.
 * `AppShell` sẽ filter cùng `NAV_ENTRIES` cho desktop + mobile dựa trên
 * capability set. Trang này vẫn giữ route guard hiện có ở server level
 * (decideDirectEntryPageAccess), UI chỉ là visibility hint.
 *
 * P3-W06A R1: cung resolver (request-scoped React cache) voi page o duoi.
 * Khi Direct Entry UI flag off, layout khong can actor (Direct Entry nav
 * entry da bi filter boi flag; Dashboard luon hien voi capability "any").
 */
export default async function DirectEntryLayout({ children }: { children: ReactNode }) {
  const directEntryEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);
  const actor = await resolveNavActorForAppShell({ directEntryEnabled });
  return <AppShell actor={actor}>{children}</AppShell>;
}