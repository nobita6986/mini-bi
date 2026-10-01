import { slotToCssVar } from "@/lib/theme/theme-registry";
import type { ChartSegment } from "@/lib/reporting/p1-chart-data";

export function EmploymentComposition({ segments, title }: { segments: ChartSegment[]; title: string }) {
  return (
    <div>
      <div role="img" aria-label={title} className="flex h-7 w-full overflow-hidden rounded-full border border-border">
        {segments.filter((s) => s.value > 0).map((s) => (
          <div key={s.key} style={{ width: s.percent + "%", background: slotToCssVar(s.color) }} className="h-full" title={s.display + ": " + s.value + " người (" + Math.round(s.percent) + "%)"} />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-sm text-foreground">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: slotToCssVar(s.color) }} />
            <span className="truncate">{s.display}</span>
            <span className="ml-auto font-mono">{s.value}</span>
            <span className="w-12 shrink-0 text-right text-xs text-muted">{Math.round(s.percent)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
