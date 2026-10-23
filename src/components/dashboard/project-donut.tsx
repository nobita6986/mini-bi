"use client";

import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { useTheme } from "@/lib/theme/theme-provider";
import { useMounted } from "@/lib/theme/use-mounted";
import type { ProjectDonutSlice } from "@/lib/reporting/p1-chart-data";
import {
  BiClearHighlightButton,
  resolveDonutSliceHighlightKey,
  useBiHighlight,
} from "./bi-cross-highlight";
import {
  buildDonutDatasetSignature,
  CHART_MAX_ANIMATED_DONUT_SLICES,
  useChartDataAnimation,
} from "./chart-motion";

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
    <div className="rounded-xl border border-border bg-tooltip px-3 py-2 text-sm shadow-md transition-opacity duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none">
      <p className="text-sm font-semibold text-foreground">{d.display}</p>
      <p className="mt-0.5 text-muted">
        <span className="font-mono tabular-nums">{d.value}</span> người · <span className="font-mono tabular-nums">{Math.round(d.percent)}%</span>
      </p>
    </div>
  );
}

export function ProjectDonut({ slices, title }: { slices: ProjectDonutSlice[]; title: string }) {
  const { resolveColor } = useTheme();
  const mounted = useMounted();
  const total = slices.reduce((a, s) => a + s.value, 0);
  const sliceKeys = useMemo(() => slices.map((s) => s.key), [slices]);
  const highlight = useBiHighlight(sliceKeys);
  const activeSliceKey = resolveDonutSliceHighlightKey(
    highlight.activeKey,
    slices,
    highlight.validKeys,
  );
  const activeSlice = activeSliceKey
    ? slices.find((s) => s.key === activeSliceKey) ?? null
    : null;

  const dataset = useMemo(() => buildDonutDatasetSignature(slices), [slices]);
  const chartMotion = useChartDataAnimation({
    chartId: `project-donut:${title}`,
    mounted,
    signature: dataset.signature,
    valid: dataset.valid,
    itemCount: dataset.itemCount,
    maxItems: CHART_MAX_ANIMATED_DONUT_SLICES,
  });

  if (!mounted) {
    return (
      <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-2">
        <div className="h-56 w-full" role="img" aria-label={title} />
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-2">
        <div className="relative h-56 w-full" role="img" aria-label={title}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart accessibilityLayer>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="display"
                innerRadius="60%"
                outerRadius="88%"
                paddingAngle={1.5}
                strokeWidth={1}
                onMouseEnter={(_, index) => {
                  const key = slices[index]?.key ?? null;
                  highlight.onHover(key);
                }}
                onMouseLeave={() => highlight.onHover(null)}
                isAnimationActive={chartMotion.isAnimationActive}
                animationDuration={chartMotion.animationDuration}
                animationEasing={chartMotion.animationEasing}
              >
                {slices.map((s) => {
                  const isHighlighted = activeSliceKey === s.key;
                  const isDimmed = activeSliceKey !== null && !isHighlighted;
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
              <Tooltip key={chartMotion.signature} content={<DonutTooltip />} />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
            <span className="text-2xl font-semibold tabular-nums text-foreground">
              {activeSlice ? activeSlice.value : total}
            </span>
            <span className="max-w-full truncate text-xs text-muted">
              {activeSlice ? `${Math.round(activeSlice.percent)}% · ${activeSlice.display}` : "người"}
            </span>
          </div>
        </div>
        <ul className="max-h-56 space-y-1 overflow-y-auto text-sm text-foreground">
          {slices.map((s) => {
            const isHighlighted = activeSliceKey === s.key;
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
                  className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                    isHighlighted
                      ? "bg-primary/10 font-medium text-foreground ring-1 ring-primary/30"
                      : "text-foreground hover:bg-surface-hover"
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: resolveColor(s.color) }}
                  />
                  <span className="min-w-0 flex-1 truncate" title={s.display}>
                    {s.display}
                  </span>
                  <span className="ml-auto shrink-0 font-mono tabular-nums">{s.value}</span>
                  <span className="w-11 shrink-0 text-right font-mono tabular-nums text-xs text-muted">
                    {Math.round(s.percent)}%
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <BiClearHighlightButton
        visible={highlight.pinnedKey !== null}
        onClear={highlight.onClear}
      />
    </div>
  );
}
