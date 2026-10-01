"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { useTheme } from "@/lib/theme/theme-provider";
import { useMounted } from "@/lib/theme/use-mounted";
import type { BarDatum } from "@/lib/reporting/p1-chart-data";
import { ChartTooltip } from "./chart-tooltip";

function truncateTick(s: string) {
  return s.length > 18 ? s.slice(0, 17) + "…" : s;
}

export function RecruiterBarChart({ data, title }: { data: BarDatum[]; title: string }) {
  const { resolveColor, tokens } = useTheme();
  const mounted = useMounted();
  if (!mounted) return <div className="h-72 w-full" role="img" aria-label={title} />;
  return (
    <div className="h-72 w-full" role="img" aria-label={title}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" accessibilityLayer margin={{ top: 4, right: 36, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={tokens.border} />
          <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: tokens.muted }} />
          <YAxis type="category" dataKey="name" width={132} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: tokens.fg }} tickFormatter={truncateTick} />
          <Tooltip content={<ChartTooltip valueFormatter={(v) => v + " người"} />} cursor={{ fill: tokens.border, opacity: 0.4 }} />
          <Bar dataKey="value" name="Số người" radius={[0, 6, 6, 0]} barSize={18} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.key} fill={resolveColor(d.color)} />)}
            <LabelList dataKey="value" position="right" formatter={(v) => String(v)} style={{ fontSize: 11, fill: tokens.muted }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
