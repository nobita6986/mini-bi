import { slotToCssVar } from "@/lib/theme/theme-registry";
import type { StatusSegment } from "@/lib/reporting/p1-chart-data";

export function SourceStatusBar({ segments, total }: { segments: StatusSegment[]; total: number }) {
  return (
    <div>
      <div role="img" aria-label="Phân bố trạng thái nguồn" className="flex h-3 w-full overflow-hidden rounded-full bg-muted/20">
        {segments.filter((s) => s.count > 0).map((s) => (
          <div key={s.label} style={{ width: (total > 0 ? (s.count / total) * 100 : 0) + "%", background: slotToCssVar(s.color) }} className="h-full" title={s.label + ": " + s.count} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: slotToCssVar(s.color) }} />
            {s.label}: <span className="font-mono">{s.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
