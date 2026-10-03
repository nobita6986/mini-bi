/**
 * DesktopNav — Server Component.
 * Hiển thị navigation bar ngang (compact) trong header.
 * Ẩn trên mobile (md breakpoint) — mobile dùng Sheet ở MobileNav.
 *
 * Nhận danh sách đã được lọc tại AppShell.
 * Không tự filter path; active state dựa vào `activePath` prop.
 */

import Link from "next/link";

import type { NavEntry } from "@/lib/navigation/registry";
import { cn } from "@/lib/utils";

export function DesktopNav({
  activePath,
  items,
}: {
  activePath: string;
  items: ReadonlyArray<NavEntry>;
}) {
  return (
    <nav aria-label="Điều hướng chính" className="ml-2 hidden items-center gap-1 md:flex">
      {items.map((entry) => {
        const Icon = entry.icon;
        const isActive = activePath === entry.path || activePath.startsWith(entry.path + "/");
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
