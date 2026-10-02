import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";

export default function PipelineCheckLayout({ children }: { children: ReactNode }) {
  return <AppShell currentPath="/pipeline-check">{children}</AppShell>;
}
