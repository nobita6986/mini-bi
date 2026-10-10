"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isAdminSectionActive, type AdminSection } from "@/lib/admin/admin-navigation";

export function AdminSubnav({
  sections,
}: {
  sections: readonly AdminSection[];
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Điều hướng Quản trị" className="mb-6 border-b border-border">
      <ul className="flex flex-wrap gap-2">
        {sections.map((section) => {
          const current = isAdminSectionActive(pathname, section.href);
          return (
            <li key={section.id}>
              <Link
                href={section.href}
                aria-current={current ? "page" : undefined}
                className="inline-flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 aria-[current=page]:border-primary aria-[current=page]:bg-primary/10 aria-[current=page]:font-semibold aria-[current=page]:text-foreground"
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
