"use client";

import type { ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { MoreHorizontal } from "lucide-react";

import { cn } from "@/lib/utils";

export interface RowOverflowAction {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/**
 * Accessible overflow menu (`⋯`) for secondary table/card row actions.
 * - Zero hover dependency.
 * - Touch target >= 44x44px on mobile (`min-h-11 min-w-11`), compact `32x32px` (`md:h-8 md:w-8`) on desktop.
 * - Menu items are `min-h-11` on mobile for safe thumb tapping.
 */
export function RowOverflowMenu({
  actions,
  ariaLabel = "Thao tác khác",
  className,
}: {
  actions: ReadonlyArray<RowOverflowAction>;
  ariaLabel?: string;
  className?: string;
}) {
  if (actions.length === 0) return null;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            "inline-flex min-h-11 min-w-11 md:min-h-8 md:min-w-8 md:h-8 md:w-8 items-center justify-center rounded-md border border-border bg-surface text-foreground transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none hover:bg-muted/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            className,
          )}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          data-ui-popover-motion="true"
          className="z-50 min-w-[12rem] overflow-hidden rounded-xl border border-border bg-surface p-1.5 text-foreground shadow-lg"
        >
          {actions.map((action) => (
            <DropdownMenu.Item
              key={action.id}
              disabled={action.disabled}
              onSelect={() => {
                if (!action.disabled) action.onSelect();
              }}
              className={cn(
                "flex min-h-11 md:min-h-9 w-full cursor-pointer select-none items-center rounded-lg px-3 py-2 text-xs sm:text-sm font-medium outline-none transition-colors",
                "focus:bg-muted/15 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                action.danger
                  ? "text-rose-600 focus:bg-rose-500/10 dark:text-rose-300"
                  : "text-foreground",
              )}
            >
              {action.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
