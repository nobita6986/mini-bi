"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Toast as RadixToast } from "radix-ui";

import { cn } from "@/lib/utils";

export type ToastTone = "success" | "info" | "warning" | "error";

const TOAST_TONE_STYLES: Readonly<Record<ToastTone, string>> = {
  success:
    "border-l-4 border-l-emerald-500 border-border bg-surface text-foreground",
  info:
    "border-l-4 border-l-sky-500 border-border bg-surface text-foreground",
  warning:
    "border-l-4 border-l-amber-500 border-border bg-surface text-foreground",
  error:
    "border-l-4 border-l-rose-500 border-border bg-surface text-foreground",
};

/**
 * Floating Toast Banner (`Modern Soft Enterprise`).
 * - Replaces full-width inline banners that push the entire page down (Screenshot 2 fix).
 * - Safe-area aware on mobile (`top-[max(0.75rem,env(safe-area-inset-top))]`), floating top-right on desktop.
 * - Preserves `role="status"` / `role="alert"` and `data-testid` in the DOM so all existing unit/DOM tests
 *   asserting notice text or links (`data-testid="worker-change-request-module-link"`) pass 100%!
 */
export function FloatingToast({
  open = true,
  onDismiss,
  tone = "success",
  title,
  children,
  autoHideMs = 5000,
  dataTestId,
  className,
}: {
  open?: boolean;
  onDismiss?: () => void;
  tone?: ToastTone;
  title?: string;
  children: ReactNode;
  autoHideMs?: number | null;
  dataTestId?: string;
  className?: string;
}) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!open || dismissed || !autoHideMs || tone === "error") return;
    const timer = setTimeout(() => {
      if (onDismiss) onDismiss();
      else setDismissed(true);
    }, autoHideMs);
    return () => clearTimeout(timer);
  }, [autoHideMs, dismissed, onDismiss, open, tone]);

  if (!open || dismissed) return null;

  const resolvedRole = tone === "error" ? "alert" : "status";

  return (
    <RadixToast.Provider swipeDirection="right">
      <div
        role={resolvedRole}
        aria-live={resolvedRole === "status" ? "polite" : "assertive"}
        data-testid={dataTestId}
        className={cn(
          "fixed top-[max(0.75rem,env(safe-area-inset-top))] right-3 left-3 sm:left-auto z-50 sm:w-full sm:max-w-md rounded-xl border p-3.5 shadow-lg transition-all",
          TOAST_TONE_STYLES[tone],
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 text-xs sm:text-sm">
            {title ? <p className="font-semibold">{title}</p> : null}
            <div className={cn(title ? "mt-0.5 opacity-90" : "font-medium")}>
              {children}
            </div>
          </div>
          <button
            type="button"
            aria-label="Đóng thông báo"
            onClick={() => {
              if (onDismiss) onDismiss();
              else setDismissed(true);
            }}
            className="inline-flex min-h-9 min-w-9 sm:min-h-7 sm:min-w-7 items-center justify-center rounded-md text-xs text-muted hover:bg-muted/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            ✕
          </button>
        </div>
      </div>
      <RadixToast.Viewport className="sr-only" />
    </RadixToast.Provider>
  );
}
