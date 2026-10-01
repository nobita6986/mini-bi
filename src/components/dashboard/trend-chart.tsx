"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { TrendPoint } from "@/lib/reporting/p1-dashboard";
import { ChartTooltip } from "./chart-tooltip";

function renderDot(props: { cx?: number; cy?: number; payload?: { date?: string; count?: number } }) {
  const { cx, cy, payload } = props;
  if (!payload || payload.count === 0) return <g key={payload?.date ?? "dot"} />;
  return <circle key={payload.date} cx={cx} cy={cy} r={3.5} fill="#4f46e5" stroke="#fff" strokeWidth={1.5} />;
}

export function TrendChart({ data }: { data: TrendPoint[] }) {
  return (
    <div className="h-64 w-full" role="img" aria-label="Biểu đồ xu hướng tuyển dụng theo ngày">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} accessibilityLayer margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#6366f1" stopOpacity={0.32} />
              <stop offset="95%" stopColor="#6366f1" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#cbd5e1" />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#64748b" }} minTickGap={24} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#64748b" }} width={40} />
          <Tooltip content={<ChartTooltip valueFormatter={(v) => v + " người"} />} cursor={{ stroke: "#cbd5e1", strokeDasharray: "3 3" }} />
          <Area type="monotone" dataKey="count" name="Số người" stroke="#4f46e5" fill="url(#trendFill)" strokeWidth={2.5} dot={renderDot} activeDot={{ r: 5, fill: "#4f46e5" }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
