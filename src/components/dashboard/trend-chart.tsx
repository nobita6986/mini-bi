"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { useTheme } from "@/lib/theme/theme-provider";
import { useMounted } from "@/lib/theme/use-mounted";
import type { TrendPoint } from "@/lib/reporting/p1-dashboard";
import {
  aggregateDailyTrendPoints,
  TREND_RESOLUTION_OPTIONS,
  type TrendResolution,
} from "@/lib/reporting/p1-dashboard-period";
import {
  buildTrendDatasetSignature,
  CHART_MAX_ANIMATED_TREND_POINTS,
  useChartDataAnimation,
} from "./chart-motion";
import { ChartTooltip } from "./chart-tooltip";

function renderDot(props: { cx?: number; cy?: number; payload?: { date?: string; count?: number } }, color: string) {
  const { cx, cy, payload } = props;
  if (!payload || payload.count === 0) return <g key={payload?.date ?? "dot"} />;
  return <circle key={payload.date} cx={cx} cy={cy} r={3.5} fill={color} stroke="var(--surface)" strokeWidth={1.5} />;
}

export function TrendChart({
  data,
  from,
  to,
}: {
  data: TrendPoint[];
  from?: string;
  to?: string;
}) {
  const { tokens } = useTheme();
  const mounted = useMounted();
  const primary = tokens.primary;
  const [resolution, setResolution] = useState<TrendResolution>("day");
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const activeOption =
    TREND_RESOLUTION_OPTIONS.find((opt) => opt.key === resolution) ??
    TREND_RESOLUTION_OPTIONS[0];

  const bucketedData = useMemo(
    () => aggregateDailyTrendPoints(data, resolution, { from, to }),
    [data, resolution, from, to],
  );
  const dataset = useMemo(
    () => buildTrendDatasetSignature(data, { from, to }, bucketedData.length),
    [data, from, to, bucketedData.length],
  );
  const chartMotion = useChartDataAnimation({
    chartId: "trend-chart",
    mounted,
    signature: dataset.signature,
    valid: dataset.valid,
    itemCount: dataset.itemCount,
    maxItems: CHART_MAX_ANIMATED_TREND_POINTS,
  });

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex = -1;
    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % TREND_RESOLUTION_OPTIONS.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index + TREND_RESOLUTION_OPTIONS.length - 1) % TREND_RESOLUTION_OPTIONS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = TREND_RESOLUTION_OPTIONS.length - 1;
    }
    if (nextIndex < 0) return;
    event.preventDefault();
    setResolution(TREND_RESOLUTION_OPTIONS[nextIndex].key);
    requestAnimationFrame(() => buttonRefs.current[nextIndex]?.focus());
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted" aria-live="polite">
          Đang hiển thị theo: <span className="font-medium text-foreground">{activeOption.label}</span>
          {" · "}
          <span className="font-mono tabular-nums">{bucketedData.length}</span> mốc
        </p>
        <div
          role="group"
          aria-label="Độ phân giải xu hướng"
          className="inline-flex flex-wrap items-center rounded-lg border border-border bg-surface-muted p-0.5"
        >
          {TREND_RESOLUTION_OPTIONS.map((opt, idx) => {
            const active = resolution === opt.key;
            return (
              <button
                key={opt.key}
                ref={(el) => {
                  buttonRefs.current[idx] = el;
                }}
                type="button"
                aria-pressed={active}
                onClick={() => setResolution(opt.key)}
                onKeyDown={(event) => handleKeyDown(event, idx)}
                className={`min-h-9 rounded-md px-3 text-xs font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                  active
                    ? "bg-primary text-on-primary shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {!mounted ? (
        <div className="h-64 w-full" role="img" aria-label={activeOption.ariaLabel} />
      ) : (
        <div className="h-64 w-full" role="img" aria-label={activeOption.ariaLabel}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={bucketedData} accessibilityLayer margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={primary} stopOpacity={0.32} />
                  <stop offset="95%" stopColor={primary} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={tokens.border} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: tokens.muted }} minTickGap={24} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: tokens.muted }} width={40} />
              <Tooltip
                key={chartMotion.signature}
                content={<ChartTooltip valueFormatter={(v) => v + " lượt"} />}
                cursor={{ stroke: tokens.border, strokeDasharray: "3 3" }}
              />
              <Area
                type="monotone"
                dataKey="count"
                name="Lượt tuyển"
                stroke={primary}
                fill="url(#trendFill)"
                strokeWidth={2.5}
                dot={(p) => renderDot(p as { cx?: number; cy?: number; payload?: { date?: string; count?: number } }, primary)}
                activeDot={{ r: 5, fill: primary }}
                isAnimationActive={chartMotion.isAnimationActive}
                animationDuration={chartMotion.animationDuration}
                animationEasing={chartMotion.animationEasing}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
