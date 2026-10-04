import type { ReactNode } from "react";
import { connection } from "next/server";

import { AppShell } from "@/components/app-shell/app-shell";
import { AiReportPanel } from "@/components/ai-report/ai-report-panel";
import { AiSettingsPanel } from "@/components/dashboard/ai-settings-panel";
import { isAiSettingsEnabled } from "@/lib/ai-config/settings-flag";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  await connection();
  const headerActions = (
    <>
      <AiReportPanel />
      {isAiSettingsEnabled() ? <AiSettingsPanel /> : null}
    </>
  );
  return <AppShell currentPath="/dashboard" headerActions={headerActions}>{children}</AppShell>;
}
