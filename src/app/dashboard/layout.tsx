import type { ReactNode } from "react";
import { connection } from "next/server";

import { AppShell } from "@/components/app-shell/app-shell";
import { resolveNavActorForAppShell } from "@/lib/navigation/resolve-nav-actor";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";

/**
 * P3-W06A Scope B: AI deferred to P3.1.
 *
 * Hai action `Tạo báo cáo AI` (AiReportPanel) và `Cấu hình AI` (AiSettingsPanel)
 * KHÔNG render trong P3 release hiện tại — kể cả khi `AI_REPORTS_ENABLED` /
 * `AI_SETTINGS_ENABLED` được bật nhầm trên Production. Implementation vẫn
 * giữ nguyên trong source (không xoá), AI API internals không bị động vào,
 * PILOT_ACTOR_REF và rate limiter vẫn thuộc P3.1.
 *
 * `headerActions` rỗng nghĩa là AppShell không render bất kỳ action header nào.
 * Khi P3.1 re-enable, layout này sẽ đọc lại cờ + capability và truyền header
 * actions phù hợp — không phải đụng vào AppShell.
 *
 * P3-W06A R1: `resolveNavActorForAppShell` duoc wrap boi React `cache()`
 * (request-scoped) → cung `ActorResolution` voi `DashboardPage` o duoi
 * (page goi cung function `resolveActorForRequest`, cache hit, khong co
 * 2 getUser + 2 RPC). Khi Direct Entry UI flag off, layout tra ve
 * `actor = null` luon (tranh query thua).
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  await connection();
  const directEntryEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);
  const actor = await resolveNavActorForAppShell({ directEntryEnabled });
  return <AppShell actor={actor}>{children}</AppShell>;
}