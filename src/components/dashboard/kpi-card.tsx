"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  formatKpiIntegerValue,
  interpolateKpiIntegerFrame,
  isAnimatableKpiInteger,
  KPI_TRANSITION_DURATION_MS,
  resolveKpiTransitionPlan,
} from "./kpi-motion";

export function KpiCard({
  label,
  value,
  hint,
  accent,
  variant = "default",
  animateNumeric = true,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent: string;
  variant?: "default" | "compact";
  animateNumeric?: boolean;
}) {
  const compact = variant === "compact";
  const hasMountedRef = useRef(false);
  const previousValueRef = useRef<unknown>(value);
  const [activeFrame, setActiveFrame] = useState<{
    target: number;
    current: number;
  } | null>(null);

  useEffect(() => {
    const plan = resolveKpiTransitionPlan({
      previousValue: previousValueRef.current,
      nextValue: value,
      hasMounted: hasMountedRef.current,
      animateNumeric,
      durationMs: KPI_TRANSITION_DURATION_MS,
    });
    hasMountedRef.current = true;
    previousValueRef.current = value;

    if (!plan.shouldAnimate || plan.fromValue === null || plan.toValue === null) {
      return;
    }

    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      return;
    }

    const fromValue = plan.fromValue;
    const toValue = plan.toValue;
    const durationMs = plan.durationMs;
    let startTime: number | null = null;
    let rafId = 0;

    const tick = (now: number) => {
      if (startTime === null) {
        startTime = now;
      }
      const elapsed = now - startTime;
      const progress = durationMs <= 0 ? 1 : Math.min(1, elapsed / durationMs);
      if (progress >= 1) {
        setActiveFrame(null);
        return;
      }
      const current = interpolateKpiIntegerFrame(fromValue, toValue, progress);
      setActiveFrame({ target: toValue, current });
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);

    return () => {
      if (rafId && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [value, animateNumeric]);

  const numericValue = isAnimatableKpiInteger(value) ? value : null;
  const displayedNumeric =
    numericValue !== null &&
    activeFrame !== null &&
    activeFrame.target === numericValue
      ? activeFrame.current
      : numericValue;
  const renderedValue: ReactNode =
    displayedNumeric !== null ? formatKpiIntegerValue(displayedNumeric) : value;
  const authoritativeNumericText =
    numericValue !== null ? formatKpiIntegerValue(numericValue) : undefined;

  return (
    <div
      className={
        compact
          ? "relative flex h-full min-h-28 flex-col overflow-hidden rounded-xl border border-border bg-surface p-3 shadow-sm"
          : "relative overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-sm"
      }
    >
      <div className="absolute inset-x-0 top-0 h-1" style={{ background: accent }} aria-hidden />
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: accent }} aria-hidden />
        {label}
      </p>
      <div
        className={
          "mt-2 font-semibold tracking-tight tabular-nums text-foreground transition-opacity duration-[var(--ui-motion-kpi,220ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none " +
          (compact ? "text-2xl" : "text-3xl")
        }
        data-kpi-final-value={authoritativeNumericText}
      >
        {renderedValue}
      </div>
      {hint ? <p className={"text-xs text-muted " + (compact ? "mt-auto pt-1" : "mt-1.5")}>{hint}</p> : null}
    </div>
  );
}
