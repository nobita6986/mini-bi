"use client";

/**
 * ActivePageLabel — Client Component.
 * Dung usePathname() (co che pathname nho nhat cua App Router) + findEntryByPath
 * de in nhan sr-only "Đang ở trang: X" cho screen-reader.
 */

import { usePathname } from "next/navigation";

import { findEntryByPath } from "@/lib/navigation/registry";

export function ActivePageLabel() {
  const pathname = usePathname();
  const active = findEntryByPath(pathname);
  return active ? <p className="sr-only">Đang ở trang: {active.label}</p> : null;
}
