"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import type { ChartSegment } from "@/lib/reporting/p1-chart-data";
import { ChartTooltip } from "./chart-tooltip";

export function ProviderDonut({ segments, title }: { segments: ChartSegment[]; title: string }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  return (
    <div>
      <div className="relative h-56 w-full" role="img" aria-label={title}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart accessibilityLayer>
            <Pie data={segments} dataKey="value" nameKey="display" innerRadius="62%" outerRadius="88%" paddingAngle={2} strokeWidth={1} isAnimationActive={false}>
              {segments.map((s) => <Cell key={s.key} fill={s.color} />)}
            </Pie>
            <Tooltip content={<ChartTooltip valueFormatter={(v) => v + " người"} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold text-slate-900 dark:text-slate-50">{total}</span>
          <span className="text-xs text-slate-500 dark:text-slate-400">người</span>
        </div>
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
