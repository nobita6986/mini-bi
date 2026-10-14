"use client";

/**
 * DesktopNav — Client Component.
 * Hiển thị navigation bar ngang (compact) trong header.
 * Ẩn trên mobile (md breakpoint) — mobile dùng Sheet ở MobileNav.
 *
 * P2.5-W06A-R1: active state duoc tinh tu usePathname() (co che pathname nho
 * nhat cua App Router) + findEntryByPath (longest-prefix), thay vi nhan
 * currentPath tu layout (layout khong biet route con).
 *
 * Nhan danh sach da duoc loc tai AppShell; khong tu filter path, khong tu
 * quyet dinh visibility.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, ClipboardList, LayoutDashboard, ShieldCheck, Users } from "lucide-react";

import { findEntryByPath } from "@/lib/navigation/registry";
import { cn } from "@/lib/utils";

type DesktopNavItem = { id: string; label: string; path: string };

const NAV_ICONS: Record<string, typeof LayoutDashboard> = {
  dashboard: LayoutDashboard,
  "direct-entry": ClipboardList,
  "project-operations": Building2,
  "worker-operations": Users,
  admin: ShieldCheck,
} as const;

export function DesktopNav({
  items,
}: {
  items: ReadonlyArray<DesktopNavItem>;
}) {
  const pathname = usePathname();
  const active = findEntryByPath(pathname);
  return (
    <nav aria-label="Điều hướng chính" className="ml-2 hidden items-center gap-1 md:flex">
      {items.map((entry) => {
        const Icon = NAV_ICONS[entry.id];
        if (!Icon) throw new Error(`Missing desktop navigation icon for "${entry.id}"`);
        const isActive = active?.id === entry.id;
        return (
          <Link
            key={entry.id}
            href={entry.path}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              isActive
                ? "bg-primary/10 text-foreground"
                : "text-muted hover:bg-muted/10 hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            <span>{entry.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
