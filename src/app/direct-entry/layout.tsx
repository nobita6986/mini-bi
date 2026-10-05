import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";
import { resolveNavActorForAppShell } from "@/lib/navigation/resolve-nav-actor";

/**
 * P3-W06A: page boundary resolve actor một lần và truyền vào AppShell.
 * `AppShell` sẽ filter cùng `NAV_ENTRIES` cho desktop + mobile dựa trên
 * capability set. Trang này vẫn giữ route guard hiện có ở server level
 * (decideDirectEntryPageAccess), UI chỉ là visibility hint.
 */
export default async function DirectEntryLayout({ children }: { children: ReactNode }) {
  const actor = await resolveNavActorForAppShell();
  return <AppShell currentPath="/direct-entry" actor={actor}>{children}</AppShell>;
}