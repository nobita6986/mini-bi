/**
 * App Shell — Server Component bọc quanh Dashboard / Direct Entry.
 *
 * Cấu trúc:
 * - Header: logo "HR Partner" + ThemeSelector hiện có + trigger Sheet cho mobile.
 * - Desktop: hiển thị header + nội dung (children). Không sidebar cố định ở FT0
 *   (giao diện là "compact navigation" trên header — desktop chỉ có nav bar trên).
 * - Mobile: Sheet (shadcn-style, dựa trên `radix-ui` Dialog) bên trái.
 *
 * P3-W06A — Capability-aware navigation:
 * - Nhận `actor` projection tối thiểu từ page boundary (đã resolve ở layout).
 *   KHÔNG tự resolve session/cookie ở AppShell; tránh duplicate query + lộ PII.
 * - `actor` chỉ chứa `capabilities` + `scopes` (đã sanitize từ
 *   `actorProjection` của `auth-session-core.ts`). Không có `auth_subject`,
 *   không có email, không có PII khác.
 * - Filter cùng `NAV_ENTRIES` qua `filterEntriesForActor` cho desktop và
 *   mobile — không tạo registry thứ hai.
 * - `actor === null` (page chưa resolve được) → chỉ `any` còn hiện (Dashboard).
 *
 * P3-W06A R1:
 * - Tầng chịu trách nhiệm viewport: `filterEntriesForActor` (dùng
 *   `entry.visibility[viewport]` để quyết định). AppShell chỉ truyền
 *   viewport đúng cho từng tầng; KHÔNG tự xây predicate để tránh mobile
 *   dùng nhầm desktop visibility.
 * - Capability predicate (`decideNavEntryVisibility`) chỉ xét capability
 *   + actor, không trộn viewport vào.
 *
 * Lưu ý:
 * - Route/API/DB vẫn là authority; visibility chỉ là UI hint.
 * - ThemeSelector giữ nguyên (W05 R1 đã ổn định).
 */

import type { ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { connection } from "next/server";

import { ThemeSelector } from "@/components/dashboard/theme-selector";
import {
  filterEntriesForActor,
  findEntryByPath,
} from "@/lib/navigation/registry";
import {
  decideNavEntryVisibility,
  type NavActorProjection,
} from "@/lib/navigation/registry-capability";
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
 *   P3-W06A Scope B: AI deferred → header actions chỉ render khi page truyền vào.
 * - actor: projection tối thiểu từ page boundary (đã resolve ở layout). Có thể
 *   null khi page không resolve được session — AppShell vẫn render Dashboard.
 */
export async function AppShell({
  children,
  currentPath,
  headerActions,
  actor,
}: {
  children: ReactNode;
  currentPath: string;
  headerActions?: ReactNode;
  actor: NavActorProjection | null;
}) {
  await connection();
  const directEntryEnabled = isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED);

  // P3-W06A R1: phan tach ro rang tang viewport va tang capability.
  // - `filterEntriesForActor` chiu trach nhiem viewport/visibility: loc
  //   `entry.visibility[viewport]` va flag `directEntryEnabled`.
  // - `decideNavEntryVisibility` chi xet capability + actor, khong quan
  //   tam viewport. Truyen dung viewport va `entryVisibleInViewport` cho
  //   tung nhanh desktop/mobile de tranh mobile dung nham desktop visibility
  //   (bug P3-W06A R1 gap 2).
  const desktopItems = filterEntriesForActor({
    viewport: "desktop",
    directEntryEnabled,
    actor,
    decide: (entry) =>
      decideNavEntryVisibility({
        capabilityKey: entry.capability,
        actor,
        viewport: "desktop",
        entryVisibleInViewport: entry.visibility.desktop,
      }),
  });
  const mobileItems = filterEntriesForActor({
    viewport: "mobile",
    directEntryEnabled,
    actor,
    decide: (entry) =>
      decideNavEntryVisibility({
        capabilityKey: entry.capability,
        actor,
        viewport: "mobile",
        entryVisibleInViewport: entry.visibility.mobile,
      }),
  });
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