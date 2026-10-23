"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  resolveSafeNotifyAction,
  resolveToastAria,
  TOAST_PHASE_CLASSES,
  TOAST_TONE_STYLES as STORE_TONE_STYLES,
  type NotifyActionProps,
  type NotifyItem,
  type NotifyPhase,
} from "@/components/ui/notify-store";
import { cn } from "@/lib/utils";

export type ToastTone = "success" | "info" | "warning" | "error";

export const TOAST_TONE_STYLES: Readonly<Record<ToastTone, string>> = STORE_TONE_STYLES;

export type ToastActionProps = NotifyActionProps;

/**
 * Thực thi an toàn callback của action trên Toast (one-flight + kiểm tra hiệu lực).
 */
export async function executeToastActionClick(options: {
  action: ToastActionProps | undefined;
  isBusy: () => boolean;
  setBusy: (busy: boolean) => void;
  onDismiss?: () => void;
  preventNavigation?: () => void;
}): Promise<boolean> {
  const { action, isBusy, setBusy, onDismiss, preventNavigation } = options;
  if (!action || isBusy()) {
    preventNavigation?.();
    return false;
  }
  if (action.kind === "retry" && (action.safeToRetry !== true || typeof action.onClick !== "function")) {
    preventNavigation?.();
    return false;
  }
  if (action.isValid) {
    let valid = false;
    try {
      valid = Boolean(action.isValid());
    } catch {
      valid = false;
    }
    if (!valid) {
      preventNavigation?.();
      onDismiss?.();
      return false;
    }
  }
  const hasHref = typeof action.href === "string" && action.href.trim().length > 0;
  if (!action.onClick && !hasHref) {
    preventNavigation?.();
    return false;
  }

  setBusy(true);
  try {
    if (action.onClick) {
      await action.onClick();
    }
    if (action.dismissOnAction) {
      onDismiss?.();
    }
    return true;
  } finally {
    setBusy(false);
  }
}

export function ToastCard({
  tone = "success",
  phase = "open",
  pending = false,
  repeatCount = 1,
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
  pending?: boolean;
  repeatCount?: number;
  title?: string;
  description?: string;
  children?: ReactNode;
  action?: ToastActionProps;
  onDismiss?: () => void;
  dataTestId?: string;
  className?: string;
}) {
  const { role: resolvedRole, ariaLive: resolvedLive } = resolveToastAria(tone);
  const safeAction = resolveSafeNotifyAction(action);
  const [actionBusy, setActionBusy] = useState(false);
  const actionBusyRef = useRef(false);

  const showRepeatBadge = typeof repeatCount === "number" && repeatCount > 1;

  return (
    <div
      role={resolvedRole}
      aria-live={resolvedLive}
      aria-atomic="true"
      data-testid={dataTestId}
      data-toast-tone={tone}
      data-state={phase}
      data-toast-pending={pending ? "true" : undefined}
      data-toast-repeat-count={showRepeatBadge ? String(repeatCount) : undefined}
      aria-busy={pending ? "true" : undefined}
      className={cn(
        "pointer-events-auto w-full rounded-xl border p-3.5 shadow-lg transition-[opacity,transform] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none motion-reduce:transform-none motion-reduce:animate-none",
        TOAST_PHASE_CLASSES[phase],
        TOAST_TONE_STYLES[tone],
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 break-words text-xs sm:text-sm">
          {title ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {pending ? (
                <span
                  aria-hidden="true"
                  data-toast-spinner="true"
                  className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-current border-r-transparent animate-spin motion-reduce:animate-none"
                />
              ) : null}
              <p className="font-semibold text-foreground">{title}</p>
              {showRepeatBadge ? (
                <span
                  data-toast-repeat-badge="true"
                  aria-label={`Lặp lại ${repeatCount} lần`}
                  className="inline-flex shrink-0 items-center rounded-full border border-border bg-surface-muted px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-muted"
                >
                  ×{repeatCount}
                </span>
              ) : null}
            </div>
          ) : null}
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
          {safeAction ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {safeAction.href ? (
                <Link
                  href={safeAction.href}
                  aria-disabled={actionBusy || undefined}
                  tabIndex={actionBusy ? -1 : undefined}
                  data-testid={safeAction.dataTestId}
                  data-toast-action-kind={safeAction.kind ?? "link"}
                  onClick={(event) => {
                    void executeToastActionClick({
                      action: safeAction,
                      isBusy: () => actionBusyRef.current,
                      setBusy: (next) => {
                        actionBusyRef.current = next;
                        setActionBusy(next);
                      },
                      onDismiss,
                      preventNavigation: () => event.preventDefault(),
                    });
                  }}
                  className={cn(
                    "inline-flex min-h-11 sm:min-h-8 items-center rounded-md border border-border bg-surface-muted px-2.5 py-1 text-xs font-medium text-foreground whitespace-nowrap transition-colors duration-[var(--ui-motion-hover,160ms)] motion-reduce:transition-none hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    actionBusy && "pointer-events-none opacity-50",
                  )}
                >
                  {safeAction.label}
                </Link>
              ) : (
                <button
                  type="button"
                  disabled={actionBusy}
                  data-testid={safeAction.dataTestId}
                  data-toast-action-kind={safeAction.kind ?? "action"}
                  onClick={() => {
                    void executeToastActionClick({
                      action: safeAction,
                      isBusy: () => actionBusyRef.current,
                      setBusy: (next) => {
                        actionBusyRef.current = next;
                        setActionBusy(next);
                      },
                      onDismiss,
                    });
                  }}
                  className="inline-flex min-h-11 sm:min-h-8 items-center rounded-md border border-border bg-surface-muted px-2.5 py-1 text-xs font-medium text-foreground whitespace-nowrap transition-colors duration-[var(--ui-motion-hover,160ms)] motion-reduce:transition-none hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {safeAction.label}
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
            className="inline-flex min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 shrink-0 items-center justify-center rounded-md text-xs text-muted whitespace-nowrap transition-colors duration-[var(--ui-motion-hover,160ms)] motion-reduce:transition-none hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            ✕
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ToastViewport({
  items,
  onDismiss,
}: {
  items: readonly NotifyItem[];
  onDismiss: (id: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <section
      aria-label="Thông báo hệ thống"
      data-testid="app-notify-viewport"
      data-ui-toast-viewport="true"
      className="pointer-events-none fixed top-[max(0.75rem,env(safe-area-inset-top))] sm:top-16 right-3 left-3 sm:left-auto sm:right-4 z-[80] flex flex-col gap-2.5 sm:w-full sm:max-w-[420px]"
    >
      {items.map((item) => (
        <ToastCard
          key={item.id}
          tone={item.tone}
          phase={item.phase}
          pending={item.pending}
          repeatCount={item.repeatCount}
          title={item.title}
          description={item.description}
          action={item.action}
          dataTestId={item.dataTestId ?? `toast-item-${item.tone}`}
          onDismiss={() => onDismiss(item.id)}
        />
      ))}
    </section>
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
