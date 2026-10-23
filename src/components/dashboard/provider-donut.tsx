"use client";

import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { useTheme } from "@/lib/theme/theme-provider";
import { useMounted } from "@/lib/theme/use-mounted";
import type { ChartSegment } from "@/lib/reporting/p1-chart-data";
import {
  buildDonutDatasetSignature,
  CHART_MAX_ANIMATED_DONUT_SLICES,
  useChartDataAnimation,
} from "./chart-motion";
import { ChartTooltip } from "./chart-tooltip";

export function ProviderDonut({ segments, title }: { segments: ChartSegment[]; title: string }) {
  const { resolveColor } = useTheme();
  const mounted = useMounted();
  const total = segments.reduce((a, s) => a + s.value, 0);
  const dataset = useMemo(() => buildDonutDatasetSignature(segments), [segments]);
  const chartMotion = useChartDataAnimation({
    chartId: `provider-donut:${title}`,
    mounted,
    signature: dataset.signature,
    valid: dataset.valid,
    itemCount: dataset.itemCount,
    maxItems: CHART_MAX_ANIMATED_DONUT_SLICES,
  });
  if (!mounted) return <div className="h-56 w-full" role="img" aria-label={title} />;
  return (
    <div>
      <div className="relative h-56 w-full" role="img" aria-label={title}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart accessibilityLayer>
            <Pie
              data={segments}
              dataKey="value"
              nameKey="display"
              innerRadius="62%"
              outerRadius="88%"
              paddingAngle={2}
              strokeWidth={1}
              isAnimationActive={chartMotion.isAnimationActive}
              animationDuration={chartMotion.animationDuration}
              animationEasing={chartMotion.animationEasing}
            >
              {segments.map((s) => <Cell key={s.key} fill={resolveColor(s.color)} />)}
            </Pie>
            <Tooltip key={chartMotion.signature} content={<ChartTooltip valueFormatter={(v) => v + " người"} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold text-foreground">{total}</span>
          <span className="text-xs text-muted">người</span>
        </div>
      </div>
      <ul className="mt-3 space-y-1.5">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-sm text-foreground">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: resolveColor(s.color) }} />
            <span className="truncate">{s.display}</span>
            <span className="ml-auto font-mono">{s.value}</span>
            <span className="w-12 shrink-0 text-right text-xs text-muted">{Math.round(s.percent)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
