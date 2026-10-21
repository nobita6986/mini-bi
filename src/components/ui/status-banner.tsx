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
}: {
  tone?: StatusBannerTone;
  title?: string;
  children: ReactNode;
  role?: "status" | "alert";
  className?: string;
  dataTestId?: string;
}) {
  const resolvedRole = role ?? (tone === "error" ? "alert" : "status");
  return (
    <div
      role={resolvedRole}
      aria-live={resolvedRole === "status" ? "polite" : undefined}
      data-testid={dataTestId}
      className={cn("rounded-md border px-4 py-3 text-sm", TONE_CLASSES[tone], className)}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={title ? "mt-1" : undefined}>{children}</div>
    </div>
  );
}
