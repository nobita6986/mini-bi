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
    <div className="rounded-lg border border-border bg-tooltip px-3 py-2 text-sm shadow-md">
      {label !== undefined && label !== "" ? (
        <p className="mb-1 font-medium text-foreground">{String(label)}</p>
      ) : null}
      {payload.map((entry, i) => (
        <p key={i} className="flex items-center gap-1.5 text-muted">
          {entry.color ? <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: entry.color }} /> : null}
          <span className="truncate">{entry.name}</span>
          <span className="ml-auto pl-2 font-mono">{valueFormatter ? valueFormatter(entry.value ?? "") : String(entry.value ?? "")}</span>
        </p>
      ))}
    </div>
  );
}
