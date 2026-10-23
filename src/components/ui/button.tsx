import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "soft"
  | "danger"
  | "danger-outline"
  | "ghost";

export type ButtonSize = "md" | "sm" | "icon-sm";

const VARIANT_CLASSES: Readonly<Record<ButtonVariant, string>> = {
  primary:
    "border border-transparent bg-primary text-on-primary shadow-2xs hover:opacity-95",
  secondary:
    "border border-border bg-surface text-foreground hover:bg-muted/10",
  outline:
    "border border-border bg-surface text-foreground hover:bg-muted/10",
  soft:
    "border border-primary/25 bg-primary/10 text-primary hover:bg-primary/15",
  danger:
    "border border-transparent bg-rose-600 text-white hover:bg-rose-700",
  "danger-outline":
    "border border-rose-500/35 bg-rose-500/10 text-rose-700 hover:bg-rose-500/15 dark:text-rose-200",
  ghost:
    "border border-transparent bg-transparent text-muted hover:bg-muted/10 hover:text-foreground",
};

const SIZE_CLASSES: Readonly<Record<ButtonSize, string>> = {
  // Mobile touch target >= 44px (min-h-11), Desktop standard >= 40px (sm:min-h-10)
  md: "min-h-11 sm:min-h-10 px-3.5 py-2 text-sm rounded-lg gap-2",
  // Table row action button: 44px on mobile (<768px), compact 32px (md:h-8) on desktop table
  sm: "min-h-11 md:min-h-8 md:h-8 px-2.5 py-1.5 md:py-1 text-xs rounded-md gap-1.5",
  "icon-sm":
    "min-h-11 min-w-11 md:min-h-8 md:min-w-8 md:h-8 md:w-8 p-0 rounded-md",
};

export function buttonClasses({
  variant = "secondary",
  size = "md",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return cn(
    "inline-flex items-center justify-center font-medium whitespace-nowrap shrink-0 transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-[var(--ui-motion-hover,160ms)] active:duration-[var(--ui-motion-fast,120ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] active:scale-[0.99] disabled:active:scale-100 aria-busy:active:scale-100 motion-reduce:transition-none motion-reduce:transform-none",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    className,
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  type = "button",
  loading,
  disabled,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      disabled={disabled ?? loading}
      aria-busy={loading || props["aria-busy"] || undefined}
      className={buttonClasses({ variant, size, className })}
      {...props}
    >
      {children}
    </button>
  );
}
