"use client";

import type { ReportingBucket } from "@/lib/reporting/p1-reporting";
import { stableColorForKey } from "@/lib/reporting/p1-chart-data";
import { slotToCssVar } from "@/lib/theme/theme-registry";

export function TeamBucketChart({ buckets }: { buckets: ReportingBucket[] }) {
  const max = Math.max(...buckets.map((bucket) => bucket.recruitedCount), 0);
  return (
    <div role="img" aria-label="Biểu đồ số tuyển theo nhóm" className="space-y-3">
      {buckets.map((bucket) => (
        <div key={bucket.key} className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
          <span className="min-w-0 break-words text-sm text-foreground" title={bucket.display}>{bucket.display}</span>
          <div className="h-4 overflow-hidden rounded border border-border bg-muted/15">
            <div
              className="h-full min-w-0 rounded"
              style={{
                width: max > 0 ? `${Math.round((bucket.recruitedCount / max) * 100)}%` : "0%",
                background: slotToCssVar(stableColorForKey(bucket.key)),
              }}
            />
          </div>
          <span className="text-right text-sm font-mono text-foreground">{bucket.recruitedCount}</span>
        </div>
      ))}
    </div>
  );
}
