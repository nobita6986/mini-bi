import type { ReactNode } from "react";

export function KpiCard({
  label,
  value,
  hint,
  accent,
  variant = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent: string;
  variant?: "default" | "compact";
}) {
  const compact = variant === "compact";
  return (
    <div className={compact
      ? "relative flex h-full min-h-28 flex-col overflow-hidden rounded-xl border border-border bg-surface p-3 shadow-sm"
      : "relative overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-sm"}>
      <div className="absolute inset-x-0 top-0 h-1" style={{ background: accent }} aria-hidden />
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: accent }} aria-hidden />
        {label}
      </p>
      <div className={"mt-2 font-semibold tracking-tight text-foreground " + (compact ? "text-2xl" : "text-3xl")}>{value}</div>
      {hint ? <p className={"text-xs text-muted " + (compact ? "mt-auto pt-1" : "mt-1.5")}>{hint}</p> : null}
    </div>
  );
}
