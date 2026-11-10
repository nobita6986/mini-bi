"use client";

import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { Tooltip } from "radix-ui";

import type {
  AttendanceVerificationIndicatorView,
  AttendanceVerificationTone,
} from "@/lib/attendance/attendance-monthly-matrix-ui-model";
import { cn } from "@/lib/utils";

const VERIFICATION_TONE_CLASSES: Readonly<
  Record<AttendanceVerificationTone, string>
> = {
  emerald:
    "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 hover:bg-emerald-500/20 dark:border-emerald-400/35 dark:bg-emerald-500/20 dark:text-emerald-300",
  amber:
    "border-amber-500/40 bg-amber-500/15 text-amber-800 hover:bg-amber-500/25 dark:border-amber-400/40 dark:bg-amber-500/20 dark:text-amber-200",
  red:
    "border-rose-500/40 bg-rose-500/15 text-rose-800 hover:bg-rose-500/25 dark:border-rose-400/40 dark:bg-rose-500/20 dark:text-rose-200",
};

export type AttendanceVerificationBadgeProps = {
  indicator: AttendanceVerificationIndicatorView;
  className?: string;
};

export function AttendanceVerificationBadge({
  indicator,
  className,
}: AttendanceVerificationBadgeProps) {
  const Icon =
    indicator.icon === "check"
      ? CheckCircle2
      : indicator.icon === "clock-warning"
        ? Clock
        : AlertTriangle;

  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={indicator.ariaLabel}
            data-verification-kind={indicator.kind}
            data-verification-icon={indicator.icon}
            data-verification-tone={indicator.tone}
            className={cn(
              "relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              VERIFICATION_TONE_CLASSES[indicator.tone],
              className,
            )}
          >
            <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            className="z-50 max-w-xs rounded-lg border border-border bg-tooltip px-2.5 py-1.5 text-xs font-medium text-foreground shadow-md"
          >
            {indicator.hint}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
