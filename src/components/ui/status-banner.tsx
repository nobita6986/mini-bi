import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type StatusBannerTone = "info" | "success" | "warning" | "error";

const TONE_CLASSES: Readonly<Record<StatusBannerTone, string>> = {
  info: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100",
  success: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  warning: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100",
  error: "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100",
};

export function StatusBanner({
  tone = "info",
  title,
  children,
  role,
  className,
  dataTestId,
  onDismiss,
  dismissLabel = "Đóng thông báo",
  dismissTestId,
}: {
  tone?: StatusBannerTone;
  title?: string;
  children: ReactNode;
  role?: "status" | "alert";
  className?: string;
  dataTestId?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
  dismissTestId?: string;
}) {
  const resolvedRole = role ?? (tone === "error" ? "alert" : "status");
  return (
    <div
      role={resolvedRole}
      aria-live={resolvedRole === "status" ? "polite" : undefined}
      data-testid={dataTestId}
      data-ui-panel-motion="true"
      className={cn(
        "rounded-md border px-4 py-3 text-sm transition-colors duration-[var(--ui-motion-hover,160ms)] motion-reduce:transition-none",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {title ? <p className="font-medium">{title}</p> : null}
          <div className={title ? "mt-1" : undefined}>{children}</div>
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={dismissLabel}
            data-testid={dismissTestId}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-transparent text-current/80 hover:bg-black/5 hover:text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 dark:hover:bg-white/10"
          >
            <span aria-hidden="true" className="text-base leading-none">
              ×
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
