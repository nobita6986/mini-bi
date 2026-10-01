import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type AlertTone = "info" | "warning" | "error";

const TONE_CLASSES: Record<AlertTone, string> = {
  info: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100",
  warning: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100",
  error: "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100",
};

export function Alert({ tone = "info", title, children }: { tone?: AlertTone; title: string; children?: ReactNode }) {
  return (
    <div role="status" className={cn("rounded-md border px-4 py-3 text-sm", TONE_CLASSES[tone])}>
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 [&>p]:mt-1">{children}</div> : null}
    </div>
  );
}
