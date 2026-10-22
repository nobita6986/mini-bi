"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import {
  resolveToastAria,
  TOAST_PHASE_CLASSES,
  TOAST_TONE_STYLES as STORE_TONE_STYLES,
  type NotifyPhase,
} from "@/components/ui/notify-store";
import { cn } from "@/lib/utils";

export type ToastTone = "success" | "info" | "warning" | "error";

export const TOAST_TONE_STYLES: Readonly<Record<ToastTone, string>> = STORE_TONE_STYLES;

export type ToastActionProps = {
  label: string;
  onClick?: () => void;
  href?: string;
  dataTestId?: string;
};

export function ToastCard({
  tone = "success",
  phase = "open",
  title,
  description,
  children,
  action,
  onDismiss,
  dataTestId,
  className,
}: {
  tone?: ToastTone;
  phase?: NotifyPhase;
  title?: string;
  description?: string;
  children?: ReactNode;
  action?: ToastActionProps;
  onDismiss?: () => void;
  dataTestId?: string;
  className?: string;
}) {
  const { role: resolvedRole, ariaLive: resolvedLive } = resolveToastAria(tone);

  return (
    <div
      role={resolvedRole}
      aria-live={resolvedLive}
      aria-atomic="true"
      data-testid={dataTestId}
      data-toast-tone={tone}
      data-state={phase}
      className={cn(
        "pointer-events-auto w-full rounded-xl border p-3.5 shadow-lg transition-[opacity,transform] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none motion-reduce:transform-none motion-reduce:animate-none",
        TOAST_PHASE_CLASSES[phase],
        TOAST_TONE_STYLES[tone],
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 break-words text-xs sm:text-sm">
          {title ? <p className="font-semibold text-foreground">{title}</p> : null}
          {description ? (
            <p className={cn("text-foreground/90", title ? "mt-0.5" : "font-medium")}>
              {description}
            </p>
          ) : null}
          {children ? (
            <div className={cn((title || description) ? "mt-1 opacity-90" : "font-medium")}>
              {children}
            </div>
          ) : null}
          {action ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {action.href ? (
                <Link
                  href={action.href}
                  data-testid={action.dataTestId}
                  onClick={() => {
                    action.onClick?.();
                  }}
                  className="inline-flex min-h-11 sm:min-h-8 items-center rounded-md border border-border bg-surface-muted px-2.5 py-1 text-xs font-medium text-foreground whitespace-nowrap hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {action.label}
                </Link>
              ) : (
                <button
                  type="button"
                  data-testid={action.dataTestId}
                  onClick={() => {
                    action.onClick?.();
                  }}
                  className="inline-flex min-h-11 sm:min-h-8 items-center rounded-md border border-border bg-surface-muted px-2.5 py-1 text-xs font-medium text-foreground whitespace-nowrap hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  {action.label}
                </button>
              )}
            </div>
          ) : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            aria-label="Đóng thông báo"
            onClick={onDismiss}
            className="inline-flex min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 shrink-0 items-center justify-center rounded-md text-xs text-muted whitespace-nowrap hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            ✕
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Adapter tương thích tạm cho các call-site đang chờ migrate sang `useNotify()`.
 * Không tạo provider hay viewport lồng nhau ở từng instance.
 */
export function FloatingToast({
  open = true,
  onDismiss,
  tone = "success",
  title,
  children,
  autoHideMs = 4000,
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

  return (
    <div className="pointer-events-none fixed top-[max(0.75rem,env(safe-area-inset-top))] right-3 left-3 sm:left-auto sm:right-4 z-[80] sm:w-full sm:max-w-[420px]">
      <ToastCard
        tone={tone}
        title={title}
        dataTestId={dataTestId}
        className={className}
        onDismiss={() => {
          if (onDismiss) onDismiss();
          else setDismissed(true);
        }}
      >
        {children}
      </ToastCard>
    </div>
  );
}
