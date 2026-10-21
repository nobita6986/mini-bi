import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Analytical ReportTable (`TBL-RPT-01..06`).
 * Uses Sticky-First-Column Horizontal Scroll on Mobile (`< 768px`) with scroll hint.
 */
export function ReportTableContainer({
  children,
  showMobileScrollHint = true,
  className,
}: {
  children: ReactNode;
  showMobileScrollHint?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-surface shadow-2xs",
        className,
      )}
    >
      {showMobileScrollHint ? (
        <div className="flex items-center justify-between border-b border-border bg-surface-muted px-3 py-1.5 text-[11px] text-muted md:hidden">
          <span>Cột đầu tiên được cố định</span>
          <span>Vuốt ngang để xem thêm số liệu ↔</span>
        </div>
      ) : null}
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

export const REPORT_TABLE_CLASS =
  "r22-report-table w-full border-collapse text-left text-xs sm:text-sm";

export const REPORT_TABLE_HEAD_CLASS =
  "border-b border-border bg-surface-muted text-xs font-semibold uppercase tracking-wider text-muted";

export const REPORT_TABLE_TH_CLASS =
  "px-3 py-2.5 font-semibold whitespace-nowrap";

export const REPORT_TABLE_ROW_CLASS =
  "border-b border-border/70 last:border-b-0 transition-colors hover:bg-surface-hover";

export const REPORT_TABLE_TD_CLASS = "px-3 py-2 align-middle";
