"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { ReportingBucket } from "@/lib/reporting/p1-reporting";

export function TopBarChart({ data, title }: { data: ReportingBucket[]; title: string }) {
  return (
    <div className="h-72 w-full" role="img" aria-label={title}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" accessibilityLayer margin={{ top: 8, right: 24, left: 16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#d4d4d8" />
          <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
          <YAxis type="category" dataKey="display" width={140} tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
          <Tooltip />
          <Bar dataKey="recruitedCount" name="Số người" fill="#0ea5e9" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
