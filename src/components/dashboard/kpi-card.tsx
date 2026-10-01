import type { ReactNode } from "react";

export function KpiCard({ label, value, hint, accent }: { label: string; value: ReactNode; hint?: string; accent: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="absolute inset-x-0 top-0 h-1" style={{ background: accent }} aria-hidden />
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: accent }} aria-hidden />
        {label}
      </p>
      <div className="mt-2 text-3xl font-semibold tracking-tight text-foreground">{value}</div>
      {hint ? <p className="mt-1.5 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
