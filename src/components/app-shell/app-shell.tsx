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
 * - AI panels KHÔNG bị động vào.
 */

import type { ReactNode } from "react";
import Link from "next/link";

import { ThemeSelector } from "@/components/dashboard/theme-selector";
import { findEntryByPath } from "@/lib/navigation/registry";

import { DesktopNav } from "./desktop-nav";
import { MobileNav } from "./mobile-nav";

/**
 * Props:
 * - children: nội dung trang.
 * - currentPath: đường dẫn hiện tại (từ page). Dùng để highlight active link.
 *   Tính từ server, không dùng hook client.
 */
export function AppShell({ children, currentPath }: { children: ReactNode; currentPath: string }) {
  const activeEntry = findEntryByPath(currentPath);
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4 sm:px-6">
          {/* Mobile: hamburger trigger */}
          <MobileNav activePath={currentPath} />

          {/* Logo HR Partner */}
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 text-sm font-semibold text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
          >
            <span
              aria-hidden
              className="inline-block h-6 w-6 rounded-md bg-primary"
            />
            <span>HR Partner</span>
          </Link>

          {/* Desktop nav — ẩn trên mobile */}
          <DesktopNav activePath={currentPath} />

          {/* Spacer */}
          <div className="flex-1" />

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
