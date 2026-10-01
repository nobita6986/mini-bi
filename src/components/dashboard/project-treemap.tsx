"use client";

import { ResponsiveContainer, Tooltip, Treemap } from "recharts";

import type { TreemapDatum } from "@/lib/reporting/p1-chart-data";
import { ChartTooltip } from "./chart-tooltip";

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function ProjectTreemap({ data, title }: { data: TreemapDatum[]; title: string }) {
  const renderCell = (props: { x: number; y: number; width: number; height: number; index: number }) => {
    const { x, y, width, height, index } = props;
    const d = data[index];
    if (!d || width <= 0 || height <= 0) return <g />;
    return (
      <g>
        <rect x={x} y={y} width={width} height={height} rx={4} fill={d.color} stroke="#fff" strokeWidth={1.5} />
        {width > 46 && height > 26 ? (
          <text x={x + 7} y={y + 16} fontSize={11} fontWeight={600} fill="#fff">{truncate(d.name, Math.max(4, Math.floor(width / 8)))}</text>
        ) : null}
        {width > 46 && height > 44 ? (
          <text x={x + 7} y={y + 32} fontSize={10} fill="#fff" opacity={0.9}>{d.size} người</text>
        ) : null}
      </g>
    );
  };

  return (
    <div className="h-72 w-full" role="img" aria-label={title}>
      <ResponsiveContainer width="100%" height="100%">
        <Treemap data={data} dataKey="size" nameKey="name" content={renderCell} isAnimationActive={false} nodeGap={3} stroke="#fff">
          <Tooltip content={<ChartTooltip valueFormatter={(v) => v + " người"} />} />
        </Treemap>
      </ResponsiveContainer>
    </div>
  );
}
