"use client";

import type { ReportingBucket } from "@/lib/reporting/p1-reporting";
import { stableColorForKey } from "@/lib/reporting/p1-chart-data";
import { slotToCssVar } from "@/lib/theme/theme-registry";

export function TeamBucketChart({
  buckets,
  highlightedKey = null,
  onHoverKey,
}: {
  buckets: ReportingBucket[];
  highlightedKey?: string | null;
  onHoverKey?: (key: string | null) => void;
}) {
  const max = Math.max(...buckets.map((bucket) => bucket.recruitedCount), 0);
  return (
    <div role="img" aria-label="Biểu đồ số tuyển theo nhóm" className="space-y-3">
      {buckets.map((bucket) => {
        const isHighlighted = highlightedKey === bucket.key;
        const isDimmed = highlightedKey !== null && !isHighlighted;
        return (
          <div
            key={bucket.key}
            data-bi-highlighted={isHighlighted ? "true" : undefined}
            onMouseEnter={onHoverKey ? () => onHoverKey(bucket.key) : undefined}
            onMouseLeave={onHoverKey ? () => onHoverKey(null) : undefined}
            className={`grid grid-cols-1 gap-1 rounded-lg px-2 py-1 transition-colors duration-[var(--ui-motion-hover,160ms)] sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto] sm:items-center sm:gap-3 ${
              isHighlighted ? "bg-primary/10 ring-1 ring-primary/30" : ""
            }`}
          >
            <span className="min-w-0 break-words text-sm text-foreground" title={bucket.display}>
              {bucket.display}
            </span>
            <div className="h-4 overflow-hidden rounded border border-border bg-muted/15">
              <div
                className="h-full min-w-0 rounded transition-opacity duration-[var(--ui-motion-hover,160ms)]"
                style={{
                  width: max > 0 ? `${Math.round((bucket.recruitedCount / max) * 100)}%` : "0%",
                  background: slotToCssVar(stableColorForKey(bucket.key)),
                  opacity: isDimmed ? 0.35 : 1,
                }}
              />
            </div>
            <span className="text-right text-sm font-mono tabular-nums text-foreground">
              {bucket.recruitedCount}
            </span>
          </div>
        );
      })}
    </div>
  );
}
