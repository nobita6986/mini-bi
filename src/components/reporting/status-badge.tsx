import { cn } from "@/lib/utils";

import type { RunStatus } from "@/lib/reporting/pipeline-check";

const VARIANTS: Record<RunStatus, string> = {
  succeeded: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  partial: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  running: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
};

const LABELS: Record<RunStatus, string> = {
  succeeded: "Succeeded",
  partial: "Partial",
  failed: "Failed",
  running: "Running",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", VARIANTS[status])}>
      {LABELS[status]}
    </span>
  );
}
