"use client";

/**
 * MobileNav — Client Component.
 *
 * Hiển thị trigger button (hamburger) trên mobile, mở Sheet drawer bên trái.
 * Sheet được build trực tiếp trên `radix-ui` Dialog (shadcn-style pattern).
 * Sau APP-NAV-01A, có thể refactor thành shadcn `Sheet` snippet — không
 * phải thay đổi hành vi.
 *
 * - Trigger: button với `aria-controls`, `aria-expanded`.
 * - Overlay: Dialog Overlay (backdrop) mờ.
 * - Content: navigation list (radix-ui không cần, chỉ render `<Link>` từ
 *   `next/link`).
 * - ESC đóng: Dialog Root xử lý (đã kiểm thử bằng cách đặt `onOpenChange`).
 * - Focus trap + focus return: Dialog.Root lo.
 *
 * Server-render: bị khoá bởi `'use client'`, nhưng `entriesForViewport` được
 * import thuần từ registry, có thể prerender HTML ban đầu (rỗng portal).
 */

import { useState } from "react";
import Link from "next/link";
import { Dialog } from "radix-ui";
import { Menu, X } from "lucide-react";

import { entriesForViewport } from "@/lib/navigation/registry";
import { cn } from "@/lib/utils";

export function MobileNav({ activePath }: { activePath: string }) {
  const [open, setOpen] = useState(false);
  const items = entriesForViewport("mobile");

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {/* Trigger chỉ hiện trên mobile (md:hidden) */}
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Mở menu điều hướng"
          aria-controls="mobile-nav-sheet"
          className={cn(
            "inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground",
            "hover:bg-muted/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            "md:hidden"
          )}
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-30 bg-black/40 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0"
          )}
        />
        <Dialog.Content
          id="mobile-nav-sheet"
          aria-describedby={undefined}
          className={cn(
            "fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col gap-2 border-r border-border bg-surface p-4 shadow-xl",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left",
            "duration-200"
          )}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-foreground">Điều hướng</span>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Đóng menu"
                className={cn(
                  "inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground",
                  "hover:bg-muted/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                )}
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </Dialog.Close>
          </div>

          <nav aria-label="Điều hướng chính (di động)" className="flex flex-col gap-1">
            {items.map((entry) => {
              const Icon = entry.icon;
              const isActive = activePath === entry.path || activePath.startsWith(entry.path + "/");
              return (
                <Link
                  key={entry.id}
                  href={entry.path}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "inline-flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium",
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

          <Dialog.Title className="sr-only">Menu điều hướng chính</Dialog.Title>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
