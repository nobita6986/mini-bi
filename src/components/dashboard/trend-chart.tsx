"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { TrendPoint } from "@/lib/reporting/p1-dashboard";

export function TrendChart({ data }: { data: TrendPoint[] }) {
  return (
    <div className="h-64 w-full" role="img" aria-label="Biểu đồ xu hướng tuyển dụng theo ngày">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} accessibilityLayer margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#d4d4d8" />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
          <Tooltip />
          <Area type="monotone" dataKey="count" name="Số người" stroke="#0ea5e9" fill="url(#trendFill)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
