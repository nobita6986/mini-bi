"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type WorkReportsNavLink = { href: string; label: string; activeKey: string };

const linkClass =
  "inline-flex min-h-11 sm:min-h-9 items-center rounded-lg border border-transparent px-3 text-sm font-medium whitespace-nowrap " +
  "transition-[color,background-color,border-color,transform] duration-[var(--ui-motion-hover,160ms)] " +
  "ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring/40 active:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none";

export function WorkReportsModuleNav({ links }: { links: readonly WorkReportsNavLink[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Báo cáo công việc" className="flex flex-wrap gap-1.5">
      {links.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={linkClass + (active
              ? " border-border bg-primary/10 text-primary"
              : " text-muted hover:bg-primary/10 hover:text-primary")}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
