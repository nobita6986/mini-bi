"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { BarDatum } from "@/lib/reporting/p1-chart-data";
import { ChartTooltip } from "./chart-tooltip";

function truncateTick(s: string) {
  return s.length > 18 ? s.slice(0, 17) + "…" : s;
}

export function RecruiterBarChart({ data, title }: { data: BarDatum[]; title: string }) {
  return (
    <div className="h-72 w-full" role="img" aria-label={title}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" accessibilityLayer margin={{ top: 4, right: 36, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#cbd5e1" />
          <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#64748b" }} />
          <YAxis type="category" dataKey="name" width={132} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#475569" }} tickFormatter={truncateTick} />
          <Tooltip content={<ChartTooltip valueFormatter={(v) => v + " người"} />} cursor={{ fill: "#e2e8f0", opacity: 0.4 }} />
          <Bar dataKey="value" name="Số người" radius={[0, 6, 6, 0]} barSize={18} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.key} fill={d.color} />)}
            <LabelList dataKey="value" position="right" formatter={(v) => String(v)} style={{ fontSize: 11, fill: "#64748b" }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
