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
    <div className="rounded-xl border border-border bg-tooltip px-3 py-2 text-sm shadow-md transition-opacity duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none">
      {label !== undefined && label !== "" ? (
        <p className="mb-1 text-sm font-semibold text-foreground">{String(label)}</p>
      ) : null}
      {payload.map((entry, i) => (
        <p key={i} className="flex items-center gap-1.5 text-muted">
          {entry.color ? <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: entry.color }} /> : null}
          <span className="truncate">{entry.name}</span>
          <span className="ml-auto pl-2 text-right font-mono tabular-nums">{valueFormatter ? valueFormatter(entry.value ?? "") : String(entry.value ?? "")}</span>
        </p>
      ))}
    </div>
  );
}
