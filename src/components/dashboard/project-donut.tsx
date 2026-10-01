"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import type { ProjectDonutSlice } from "@/lib/reporting/p1-chart-data";

interface TooltipEntry {
  name?: string;
  value?: number;
  color?: string;
  payload?: ProjectDonutSlice;
}

function DonutTooltip({ active, payload }: { active?: boolean; payload?: TooltipEntry[] }) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  if (!d) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-sm shadow-md dark:border-slate-700 dark:bg-slate-900/95">
      <p className="font-medium text-slate-700 dark:text-slate-200">{d.display}</p>
      <p className="mt-0.5 text-slate-600 dark:text-slate-300">
        <span className="font-mono">{d.value}</span> người · <span className="font-mono">{Math.round(d.percent)}%</span>
      </p>
    </div>
  );
}

export function ProjectDonut({ slices, title }: { slices: ProjectDonutSlice[]; title: string }) {
  const total = slices.reduce((a, s) => a + s.value, 0);
  return (
    <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-2">
      <div className="relative h-56 w-full" role="img" aria-label={title}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart accessibilityLayer>
            <Pie data={slices} dataKey="value" nameKey="display" innerRadius="60%" outerRadius="88%" paddingAngle={1.5} strokeWidth={1} isAnimationActive={false}>
              {slices.map((s) => <Cell key={s.key} fill={s.color} />)}
            </Pie>
            <Tooltip content={<DonutTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold text-slate-900 dark:text-slate-50">{total}</span>
          <span className="text-xs text-slate-500 dark:text-slate-400">người</span>
        </div>
      </div>
      <ul className="space-y-1.5 text-sm text-slate-700 dark:text-slate-200">
        {slices.map((s) => (
          <li key={s.key} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
            <span className="min-w-0 flex-1 truncate" title={s.display}>{s.display}</span>
            <span className="ml-auto shrink-0 font-mono">{s.value}</span>
            <span className="w-11 shrink-0 text-right text-xs text-slate-500 dark:text-slate-400">{Math.round(s.percent)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
