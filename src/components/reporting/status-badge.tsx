import { cn } from "@/lib/utils";

import type { RunStatus } from "@/lib/reporting/pipeline-check";

const VARIANTS: Record<RunStatus, string> = {
  succeeded: "border border-status-success-border bg-status-success-bg text-status-success-text",
  partial: "border border-status-warning-border bg-status-warning-bg text-status-warning-text",
  failed: "border border-status-danger-border bg-status-danger-bg text-status-danger-text",
  running: "border border-status-info-border bg-status-info-bg text-status-info-text",
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
