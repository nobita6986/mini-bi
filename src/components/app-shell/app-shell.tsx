/**
 * App Shell — Server Component bọc quanh Dashboard / Direct Entry.
 *
 * Cấu trúc:
 * - Header: logo "HR Partner" + ThemeSelector hiện có + trigger Sheet cho mobile.
 * - Desktop: hiển thị header + nội dung (children). Không sidebar cố định ở FT0
 *   (giao diện là "compact navigation" trên header — desktop chỉ có nav bar trên).
 * - Mobile: Sheet (shadcn-style, dựa trên `radix-ui` Dialog) bên trái.
 *
 * Lưu ý:
 * - Chưa có RBAC thật: `capability` chỉ là metadata, filter ở đây chỉ theo
 *   `status: 'current'`.
 * - ThemeSelector giữ nguyên (W05 R1 đã ổn định).
 */

import type { ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { connection } from "next/server";

import { ThemeSelector } from "@/components/dashboard/theme-selector";
import { entriesForViewport, findEntryByPath } from "@/lib/navigation/registry";
import { isDirectEntryUiEnabled } from "@/lib/direct-entry/ui-model";

import { DesktopNav } from "./desktop-nav";
import { MobileNav } from "./mobile-nav";
import { UserSessionControl } from "./user-session-control";

/**
 * Props:
 * - children: nội dung trang.
 * - currentPath: đường dẫn hiện tại (từ page). Dùng để highlight active link.
 *   Tính từ server, không dùng hook client.
 * - headerActions: các action do route hiện tại cung cấp, nếu có.
 */
export async function AppShell({
  children,
  currentPath,
  headerActions,
}: {
  children: ReactNode;
  currentPath: string;
  headerActions?: ReactNode;
}) {
  await connection();
  const directEntryEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);
  const desktopItems = entriesForViewport("desktop", directEntryEnabled);
  const mobileItems = entriesForViewport("mobile", directEntryEnabled);
  const activeEntry = findEntryByPath(currentPath);
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex min-h-14 w-full max-w-6xl flex-wrap items-center gap-3 px-4 py-2 sm:px-6">
          {/* Mobile: hamburger trigger */}
          <MobileNav
            activePath={currentPath}
            items={mobileItems.map(({ id, label, path }) => ({ id, label, path }))}
          />

          {/* Logo HR Partner */}
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 text-sm font-semibold text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
          >
            <Image src="/brand/hrpartner-logo.png" alt="HR Partner" width={2166} height={1706} className="h-9 w-auto" />
            <span>HR Partner</span>
          </Link>

          {/* Desktop nav — ẩn trên mobile */}
          <DesktopNav activePath={currentPath} items={desktopItems} />

          {/* Spacer */}
          <div className="flex-1" />

          {headerActions ? (
            <div className="order-last flex basis-full items-center justify-end gap-2 md:order-none md:basis-auto">
              {headerActions}
            </div>
          ) : null}

          {/* Session control — login/logout UX (route/RPC van la authority) */}
          <UserSessionControl />

          {/* Theme selector — giữ nguyên như W05 R1 */}
          <ThemeSelector />
        </div>

        {/* Active page label — phụ trợ a11y cho screen-reader */}
        {activeEntry ? (
          <p className="sr-only">Đang ở trang: {activeEntry.label}</p>
        ) : null}
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}
