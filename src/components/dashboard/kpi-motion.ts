import { prefersReducedMotion } from "./chart-motion";

export const KPI_TRANSITION_DURATION_MS = 220;
export const KPI_RAPID_BURST_MS = 120;
export const KPI_DEFAULT_FRAME_STEPS = 8;

const viVnIntegerFormatter = new Intl.NumberFormat("vi-VN", {
  maximumFractionDigits: 0,
});

export type KpiTransitionReason =
  | "initial-mount"
  | "disabled"
  | "non-numeric"
  | "unchanged"
  | "reduced-motion"
  | "rapid-burst"
  | "animate";

export interface KpiTransitionPlan {
  shouldAnimate: boolean;
  fromValue: number | null;
  toValue: number | null;
  finalDisplay: string | null;
  durationMs: number;
  reason: KpiTransitionReason;
}

export interface KpiTransitionInput {
  previousValue: unknown;
  nextValue: unknown;
  hasMounted: boolean;
  animateNumeric?: boolean;
  reducedMotion?: boolean;
  elapsedSinceLastUpdateMs?: number | null;
  durationMs?: number;
}

export function isAnimatableKpiInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

export function formatKpiIntegerValue(value: number): string {
  const safeInteger = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  return viVnIntegerFormatter.format(safeInteger);
}

export function easeOutCubic(progress: number): number {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 1));
  return 1 - Math.pow(1 - clamped, 3);
}

export function interpolateKpiIntegerFrame(
  from: number,
  to: number,
  progress: number,
): number {
  const safeFrom = Math.max(0, Math.round(from));
  const safeTo = Math.max(0, Math.round(to));
  if (!Number.isFinite(progress) || progress >= 1) return safeTo;
  if (progress <= 0) return safeFrom;
  const eased = easeOutCubic(progress);
  const interpolated = Math.round(safeFrom + (safeTo - safeFrom) * eased);
  return Math.max(0, interpolated);
}

export function sampleKpiTransitionFrames(
  from: number,
  to: number,
  steps: number = KPI_DEFAULT_FRAME_STEPS,
): number[] {
  const safeSteps = Math.max(1, Math.floor(steps));
  const frames: number[] = [];
  for (let i = 0; i <= safeSteps; i += 1) {
    const progress = i / safeSteps;
    frames.push(interpolateKpiIntegerFrame(from, to, progress));
  }
  frames[frames.length - 1] = Math.max(0, Math.round(to));
  return frames;
}

export function resolveKpiTransitionPlan(
  input: KpiTransitionInput,
): KpiTransitionPlan {
  const durationMs = input.durationMs ?? KPI_TRANSITION_DURATION_MS;
  const animateNumeric = input.animateNumeric ?? true;
  const reducedMotion = input.reducedMotion ?? prefersReducedMotion();

  if (!isAnimatableKpiInteger(input.nextValue)) {
    return {
      shouldAnimate: false,
      fromValue: null,
      toValue: null,
      finalDisplay: null,
      durationMs,
      reason: "non-numeric",
    };
  }

  const toValue = input.nextValue;
  const finalDisplay = formatKpiIntegerValue(toValue);

  if (!animateNumeric) {
    return {
      shouldAnimate: false,
      fromValue: toValue,
      toValue,
      finalDisplay,
      durationMs,
      reason: "disabled",
    };
  }

  if (!input.hasMounted) {
    return {
      shouldAnimate: false,
      fromValue: toValue,
      toValue,
      finalDisplay,
      durationMs,
      reason: "initial-mount",
    };
  }

  if (!isAnimatableKpiInteger(input.previousValue)) {
    return {
      shouldAnimate: false,
      fromValue: toValue,
      toValue,
      finalDisplay,
      durationMs,
      reason: "non-numeric",
    };
  }

  const fromValue = input.previousValue;
  if (fromValue === toValue) {
    return {
      shouldAnimate: false,
      fromValue,
      toValue,
      finalDisplay,
      durationMs,
      reason: "unchanged",
    };
  }

  if (reducedMotion) {
    return {
      shouldAnimate: false,
      fromValue,
      toValue,
      finalDisplay,
      durationMs,
      reason: "reduced-motion",
    };
  }

  if (
    typeof input.elapsedSinceLastUpdateMs === "number" &&
    Number.isFinite(input.elapsedSinceLastUpdateMs) &&
    input.elapsedSinceLastUpdateMs >= 0 &&
    input.elapsedSinceLastUpdateMs < KPI_RAPID_BURST_MS
  ) {
    return {
      shouldAnimate: false,
      fromValue,
      toValue,
      finalDisplay,
      durationMs,
      reason: "rapid-burst",
    };
  }

  return {
    shouldAnimate: true,
    fromValue,
    toValue,
    finalDisplay,
    durationMs,
    reason: "animate",
  };
}

/**
 * Xác định số nguyên hiển thị ở pha render trước khi `useEffect` chạy:
 * - Giữ nguyên `displayedNumeric` đang trên màn hình khi chuyển giữa hai số nguyên hợp lệ,
 *   tuyệt đối không chớp `toValue` trong 1 frame rồi quay ngược về `fromValue`.
 * - Hiện ngay `value` mới nếu `animateNumeric=false`, `reduced-motion`, hoặc vừa chuyển từ `—`/`N/A`.
 */
export function resolveRenderedKpiNumeric(options: {
  value: unknown;
  displayedNumeric: number | null;
  animateNumeric?: boolean;
  reducedMotion?: boolean;
}): number | null {
  if (!isAnimatableKpiInteger(options.value)) {
    return null;
  }
  const animateNumeric = options.animateNumeric ?? true;
  const reducedMotion = options.reducedMotion ?? prefersReducedMotion();
  if (!animateNumeric || reducedMotion) {
    return options.value;
  }
  if (!isAnimatableKpiInteger(options.displayedNumeric)) {
    return options.value;
  }
  return options.displayedNumeric;
}
