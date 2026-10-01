"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { useTheme } from "@/lib/theme/theme-provider";
import { useMounted } from "@/lib/theme/use-mounted";
import type { TrendPoint } from "@/lib/reporting/p1-dashboard";
import { ChartTooltip } from "./chart-tooltip";

function renderDot(props: { cx?: number; cy?: number; payload?: { date?: string; count?: number } }, color: string) {
  const { cx, cy, payload } = props;
  if (!payload || payload.count === 0) return <g key={payload?.date ?? "dot"} />;
  return <circle key={payload.date} cx={cx} cy={cy} r={3.5} fill={color} stroke="var(--surface)" strokeWidth={1.5} />;
}

export function TrendChart({ data }: { data: TrendPoint[] }) {
  const { tokens } = useTheme();
  const mounted = useMounted();
  const primary = tokens.primary;
  if (!mounted) return <div className="h-64 w-full" role="img" aria-label="Biểu đồ xu hướng tuyển dụng theo ngày" />;
  return (
    <div className="h-64 w-full" role="img" aria-label="Biểu đồ xu hướng tuyển dụng theo ngày">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} accessibilityLayer margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={primary} stopOpacity={0.32} />
              <stop offset="95%" stopColor={primary} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={tokens.border} />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: tokens.muted }} minTickGap={24} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: tokens.muted }} width={40} />
          <Tooltip content={<ChartTooltip valueFormatter={(v) => v + " người"} />} cursor={{ stroke: tokens.border, strokeDasharray: "3 3" }} />
          <Area type="monotone" dataKey="count" name="Số người" stroke={primary} fill="url(#trendFill)" strokeWidth={2.5} dot={(p) => renderDot(p as { cx?: number; cy?: number; payload?: { date?: string; count?: number } }, primary)} activeDot={{ r: 5, fill: primary }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
