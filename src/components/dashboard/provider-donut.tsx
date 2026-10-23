"use client";

import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { useTheme } from "@/lib/theme/theme-provider";
import { useMounted } from "@/lib/theme/use-mounted";
import type { ChartSegment } from "@/lib/reporting/p1-chart-data";
import { BiClearHighlightButton, useBiHighlight } from "./bi-cross-highlight";
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
  const segmentKeys = useMemo(() => segments.map((s) => s.key), [segments]);
  const highlight = useBiHighlight(segmentKeys);
  const activeSegment = highlight.activeKey
    ? segments.find((s) => s.key === highlight.activeKey) ?? null
    : null;

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
              onMouseEnter={(_, index) => {
                const key = segments[index]?.key ?? null;
                highlight.onHover(key);
              }}
              onMouseLeave={() => highlight.onHover(null)}
              isAnimationActive={chartMotion.isAnimationActive}
              animationDuration={chartMotion.animationDuration}
              animationEasing={chartMotion.animationEasing}
            >
              {segments.map((s) => {
                const isHighlighted = highlight.activeKey === s.key;
                const isDimmed = highlight.activeKey !== null && !isHighlighted;
                return (
                  <Cell
                    key={s.key}
                    fill={resolveColor(s.color)}
                    fillOpacity={isDimmed ? 0.35 : 1}
                    stroke={isHighlighted ? "var(--foreground)" : "var(--surface)"}
                    strokeWidth={isHighlighted ? 2 : 1}
                  />
                );
              })}
            </Pie>
            <Tooltip key={chartMotion.signature} content={<ChartTooltip valueFormatter={(v) => v + " người"} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
          <span className="text-2xl font-semibold tabular-nums text-foreground">
            {activeSegment ? activeSegment.value : total}
          </span>
          <span className="max-w-full truncate text-xs text-muted">
            {activeSegment ? `${Math.round(activeSegment.percent)}% · ${activeSegment.display}` : "người"}
          </span>
        </div>
      </div>
      <ul className="mt-3 space-y-1">
        {segments.map((s) => {
          const isHighlighted = highlight.activeKey === s.key;
          const isPinned = highlight.pinnedKey === s.key;
          return (
            <li key={s.key} data-bi-highlighted={isHighlighted ? "true" : undefined}>
              <button
                type="button"
                aria-pressed={isPinned}
                onMouseEnter={() => highlight.onHover(s.key)}
                onMouseLeave={() => highlight.onHover(null)}
                onFocus={() => highlight.onFocus(s.key)}
                onBlur={() => highlight.onFocus(null)}
                onClick={() => highlight.onTogglePin(s.key)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") highlight.onClear();
                }}
                className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                  isHighlighted
                    ? "bg-primary/10 font-medium text-foreground ring-1 ring-primary/30"
                    : "text-foreground hover:bg-surface-hover"
                }`}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: resolveColor(s.color) }} />
                <span className="truncate">{s.display}</span>
                <span className="ml-auto font-mono tabular-nums">{s.value}</span>
                <span className="w-12 shrink-0 text-right font-mono tabular-nums text-xs text-muted">
                  {Math.round(s.percent)}%
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <BiClearHighlightButton
        visible={highlight.pinnedKey !== null}
        onClear={highlight.onClear}
      />
    </div>
  );
}
