"use client";

import { useEffect, useId } from "react";

import type { BarDatum } from "@/lib/reporting/p1-chart-data";
import type { TrendPoint } from "@/lib/reporting/p1-dashboard";

export const CHART_ANIMATION_DURATION_MS = 340;
export const CHART_ANIMATION_EASING = "ease-out" as const;
export const CHART_RAPID_UPDATE_COOLDOWN_MS = 420;
export const CHART_MIN_ANIMATED_ITEMS = 2;
export const CHART_MAX_ANIMATED_TREND_POINTS = 60;
export const CHART_MAX_ANIMATED_BAR_ITEMS = 20;
export const CHART_MAX_ANIMATED_DONUT_SLICES = 12;

export type ChartMotionReason =
  | "initial-mount"
  | "unchanged-dataset"
  | "empty-or-invalid"
  | "reduced-motion"
  | "large-dataset"
  | "rapid-update"
  | "dataset-changed";

export interface ChartDatasetDescriptor {
  signature: string;
  valid: boolean;
  itemCount: number;
}

export interface ChartMotionDecision {
  isAnimationActive: boolean;
  animationDuration: number;
  animationEasing: typeof CHART_ANIMATION_EASING;
  signature: string;
  reason: ChartMotionReason;
}

export interface ChartMotionEvaluationInput {
  chartId?: string;
  mounted?: boolean;
  signature: string;
  valid: boolean;
  itemCount: number;
  maxItems: number;
  minItems?: number;
}

export interface ChartMotionEnvironment {
  now?: () => number;
  isReducedMotion?: () => boolean;
}

interface CommittedChartDatasetState {
  signature: string;
  valid: boolean;
  lastChangeAt: number | null;
}

export function prefersReducedMotion(
  win: { matchMedia?: (query: string) => { matches: boolean } } | null | undefined =
    typeof window !== "undefined" ? window : undefined,
): boolean {
  if (!win || typeof win.matchMedia !== "function") return false;
  try {
    return Boolean(win.matchMedia("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
}

export function buildTrendDatasetSignature(
  data: readonly TrendPoint[],
  bounds?: { from?: string; to?: string },
  renderedItemCount?: number,
): ChartDatasetDescriptor {
  const effectiveCount = renderedItemCount ?? data.length;
  if (!Array.isArray(data) || data.length < CHART_MIN_ANIMATED_ITEMS || effectiveCount < CHART_MIN_ANIMATED_ITEMS) {
    return {
      signature: `${bounds?.from ?? ""}..${bounds?.to ?? ""}|empty:${data?.length ?? 0}`,
      valid: false,
      itemCount: effectiveCount,
    };
  }

  let totalCount = 0;
  const parts: string[] = [];
  for (const point of data) {
    if (!point || typeof point.date !== "string" || !Number.isFinite(point.count) || point.count < 0) {
      return {
        signature: `${bounds?.from ?? ""}..${bounds?.to ?? ""}|invalid`,
        valid: false,
        itemCount: effectiveCount,
      };
    }
    totalCount += point.count;
    parts.push(`${point.date}:${point.count}`);
  }

  return {
    signature: `${bounds?.from ?? ""}..${bounds?.to ?? ""}|${parts.join("|")}`,
    valid: totalCount > 0,
    itemCount: effectiveCount,
  };
}

export function buildBarDatasetSignature(data: readonly BarDatum[]): ChartDatasetDescriptor {
  if (!Array.isArray(data) || data.length < CHART_MIN_ANIMATED_ITEMS) {
    return {
      signature: `empty:${data?.length ?? 0}`,
      valid: false,
      itemCount: data?.length ?? 0,
    };
  }

  let totalValue = 0;
  const parts: string[] = [];
  for (const item of data) {
    if (!item || typeof item.key !== "string" || !Number.isFinite(item.value) || item.value < 0) {
      return {
        signature: "invalid",
        valid: false,
        itemCount: data.length,
      };
    }
    totalValue += item.value;
    parts.push(`${item.key}:${item.value}`);
  }

  return {
    signature: parts.join("|"),
    valid: totalValue > 0,
    itemCount: data.length,
  };
}

export function buildDonutDatasetSignature(
  slices: ReadonlyArray<{ key: string; value: number; percent: number }>,
): ChartDatasetDescriptor {
  if (!Array.isArray(slices) || slices.length < CHART_MIN_ANIMATED_ITEMS) {
    return {
      signature: `empty:${slices?.length ?? 0}`,
      valid: false,
      itemCount: slices?.length ?? 0,
    };
  }

  let totalValue = 0;
  const parts: string[] = [];
  for (const slice of slices) {
    if (
      !slice ||
      typeof slice.key !== "string" ||
      !Number.isFinite(slice.value) ||
      slice.value < 0 ||
      !Number.isFinite(slice.percent) ||
      slice.percent < 0
    ) {
      return {
        signature: "invalid",
        valid: false,
        itemCount: slices.length,
      };
    }
    totalValue += slice.value;
    parts.push(`${slice.key}:${slice.value}:${Math.round(slice.percent * 100)}`);
  }

  return {
    signature: parts.join("|"),
    valid: totalValue > 0,
    itemCount: slices.length,
  };
}

function inactiveDecision(signature: string, reason: ChartMotionReason): ChartMotionDecision {
  return {
    isAnimationActive: false,
    animationDuration: CHART_ANIMATION_DURATION_MS,
    animationEasing: CHART_ANIMATION_EASING,
    signature,
    reason,
  };
}

export function createChartMotionTracker(env: ChartMotionEnvironment = {}) {
  const now = env.now ?? (() => Date.now());
  const isReducedMotion = env.isReducedMotion ?? (() => prefersReducedMotion());
  const stateByChartId = new Map<string, CommittedChartDatasetState>();

  function getDecision(input: ChartMotionEvaluationInput): ChartMotionDecision {
    const chartId = input.chartId ?? "default";
    const mounted = input.mounted ?? true;
    const minItems = input.minItems ?? CHART_MIN_ANIMATED_ITEMS;

    if (!mounted) {
      return inactiveDecision(input.signature, "initial-mount");
    }

    if (!input.valid || input.itemCount < minItems) {
      return inactiveDecision(input.signature, "empty-or-invalid");
    }

    const prev = stateByChartId.get(chartId);
    if (!prev || !prev.valid) {
      return inactiveDecision(input.signature, "initial-mount");
    }

    if (prev.signature === input.signature) {
      return inactiveDecision(input.signature, "unchanged-dataset");
    }

    if (isReducedMotion()) {
      return inactiveDecision(input.signature, "reduced-motion");
    }

    if (input.itemCount > input.maxItems) {
      return inactiveDecision(input.signature, "large-dataset");
    }

    const currentTimestamp = now();
    if (
      prev.lastChangeAt !== null &&
      currentTimestamp - prev.lastChangeAt < CHART_RAPID_UPDATE_COOLDOWN_MS
    ) {
      return inactiveDecision(input.signature, "rapid-update");
    }

    return {
      isAnimationActive: true,
      animationDuration: CHART_ANIMATION_DURATION_MS,
      animationEasing: CHART_ANIMATION_EASING,
      signature: input.signature,
      reason: "dataset-changed",
    };
  }

  function commit(input: ChartMotionEvaluationInput): void {
    const chartId = input.chartId ?? "default";
    const mounted = input.mounted ?? true;
    const minItems = input.minItems ?? CHART_MIN_ANIMATED_ITEMS;
    if (!mounted) return;

    const valid = Boolean(input.valid && input.itemCount >= minItems);
    const prev = stateByChartId.get(chartId);
    if (!prev || !prev.valid) {
      stateByChartId.set(chartId, {
        signature: input.signature,
        valid,
        lastChangeAt: null,
      });
      return;
    }

    if (prev.signature !== input.signature) {
      stateByChartId.set(chartId, {
        signature: input.signature,
        valid,
        lastChangeAt: valid ? now() : null,
      });
      return;
    }

    if (prev.valid !== valid) {
      stateByChartId.set(chartId, {
        signature: input.signature,
        valid,
        lastChangeAt: prev.lastChangeAt,
      });
    }
  }

  function evaluate(input: ChartMotionEvaluationInput): ChartMotionDecision {
    const decision = getDecision(input);
    commit(input);
    return decision;
  }

  function reset(chartId?: string): void {
    if (chartId !== undefined) {
      stateByChartId.delete(chartId);
      return;
    }
    stateByChartId.clear();
  }

  return {
    getDecision,
    commit,
    evaluate,
    reset,
  };
}

const defaultChartMotionTracker = createChartMotionTracker();

export function useChartDataAnimation(input: ChartMotionEvaluationInput): ChartMotionDecision {
  const instanceId = useId();
  const scopedChartId = `${input.chartId ?? "chart"}:${instanceId}`;
  const scopedInput: ChartMotionEvaluationInput = {
    ...input,
    chartId: scopedChartId,
  };

  const decision = defaultChartMotionTracker.getDecision(scopedInput);

  useEffect(() => {
    defaultChartMotionTracker.commit({
      chartId: scopedChartId,
      mounted: input.mounted,
      signature: input.signature,
      valid: input.valid,
      itemCount: input.itemCount,
      maxItems: input.maxItems,
      minItems: input.minItems,
    });
  }, [
    scopedChartId,
    input.mounted,
    input.signature,
    input.valid,
    input.itemCount,
    input.maxItems,
    input.minItems,
  ]);

  useEffect(() => {
    return () => {
      defaultChartMotionTracker.reset(scopedChartId);
    };
  }, [scopedChartId]);

  return decision;
}
