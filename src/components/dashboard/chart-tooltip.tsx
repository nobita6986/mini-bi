"use client";

interface TooltipEntry {
  name?: string | number;
  value?: string | number;
  color?: string;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  valueFormatter?: (value: string | number) => string;
}

export function ChartTooltip({ active, payload, label, valueFormatter }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-sm shadow-md dark:border-slate-700 dark:bg-slate-900/95">
      {label !== undefined && label !== "" ? (
        <p className="mb-1 font-medium text-slate-700 dark:text-slate-200">{String(label)}</p>
      ) : null}
      {payload.map((entry, i) => (
        <p key={i} className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
          {entry.color ? <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: entry.color }} /> : null}
          <span className="truncate">{entry.name}</span>
          <span className="ml-auto pl-2 font-mono">{valueFormatter ? valueFormatter(entry.value ?? "") : String(entry.value ?? "")}</span>
        </p>
      ))}
    </div>
  );
}
