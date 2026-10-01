import type { ChartSegment } from "@/lib/reporting/p1-chart-data";

export function EmploymentComposition({ segments, title }: { segments: ChartSegment[]; title: string }) {
  return (
    <div>
      <div role="img" aria-label={title} className="flex h-7 w-full overflow-hidden rounded-full border border-slate-200 dark:border-slate-800">
        {segments.filter((s) => s.value > 0).map((s) => (
          <div key={s.key} style={{ width: s.percent + "%", background: s.color }} className="h-full" title={s.display + ": " + s.value + " người (" + Math.round(s.percent) + "%)"} />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
            <span className="truncate">{s.display}</span>
            <span className="ml-auto font-mono">{s.value}</span>
            <span className="w-12 shrink-0 text-right text-xs text-slate-500 dark:text-slate-400">{Math.round(s.percent)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
