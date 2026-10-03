import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";

export default function DirectEntryLayout({ children }: { children: ReactNode }) {
  return <AppShell currentPath="/direct-entry">{children}</AppShell>;
}