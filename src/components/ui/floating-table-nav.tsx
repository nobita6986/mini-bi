"use client";

import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

import {
  computeTableScrollAvailability,
  type TableScrollAvailability,
  type TableScrollMetrics,
} from "@/lib/attendance/attendance-monthly-matrix-ui-model";
import { cn } from "@/lib/utils";

export {
  computeTableScrollAvailability,
  type TableScrollAvailability,
  type TableScrollMetrics,
};

export type FloatingTableNavProps = {
  containerRef: RefObject<HTMLElement | null>;
  tableLabel?: string;
  horizontalStepPx?: number;
  verticalStepPx?: number;
  className?: string;
};

const DEFAULT_HORIZONTAL_STEP_PX = 360;
const DEFAULT_VERTICAL_STEP_PX = 280;

export function FloatingTableNav({
  containerRef,
  tableLabel,
  horizontalStepPx = DEFAULT_HORIZONTAL_STEP_PX,
  verticalStepPx = DEFAULT_VERTICAL_STEP_PX,
  className,
}: FloatingTableNavProps) {
  const [availability, setAvailability] = useState<TableScrollAvailability>({
    hasHorizontalOverflow: false,
    hasVerticalOverflow: false,
    hasOverflow: false,
    canScrollLeft: false,
    canScrollRight: false,
    canScrollUp: false,
    canScrollDown: false,
  });

  const syncScrollState = useCallback(() => {
    const el = containerRef.current;
    if (!el) {
      setAvailability({
        hasHorizontalOverflow: false,
        hasVerticalOverflow: false,
        hasOverflow: false,
        canScrollLeft: false,
        canScrollRight: false,
        canScrollUp: false,
        canScrollDown: false,
      });
      return;
    }

    setAvailability(
      computeTableScrollAvailability({
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
      }),
    );
  }, [containerRef]);

  useEffect(() => {
    const el = containerRef.current;
    syncScrollState();
    if (!el) return;

    const handleScroll = () => syncScrollState();
    el.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll, { passive: true });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => syncScrollState());
      resizeObserver.observe(el);
      if (el.firstElementChild) {
        resizeObserver.observe(el.firstElementChild);
      }
    }

    let mutationObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(() => syncScrollState());
      mutationObserver.observe(el, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    }

    return () => {
      el.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [containerRef, syncScrollState]);

  const scrollByDelta = useCallback(
    (dx: number, dy: number) => {
      const el = containerRef.current;
      if (!el) return;
      if (typeof el.scrollBy === "function") {
        el.scrollBy({ left: dx, top: dy, behavior: "smooth" });
      } else {
        el.scrollLeft += dx;
        el.scrollTop += dy;
      }
      window.setTimeout(syncScrollState, 180);
    },
    [containerRef, syncScrollState],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (availability.canScrollLeft) {
          scrollByDelta(-horizontalStepPx, 0);
        }
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (availability.canScrollRight) {
          scrollByDelta(horizontalStepPx, 0);
        }
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (availability.canScrollUp) {
          scrollByDelta(0, -verticalStepPx);
        }
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        if (availability.canScrollDown) {
          scrollByDelta(0, verticalStepPx);
        }
      }
    },
    [
      availability.canScrollDown,
      availability.canScrollLeft,
      availability.canScrollRight,
      availability.canScrollUp,
      horizontalStepPx,
      scrollByDelta,
      verticalStepPx,
    ],
  );

  if (!availability.hasOverflow) {
    return null;
  }

  const regionLabel = tableLabel
    ? `Điều hướng cuộn bảng ${tableLabel}`
    : "Điều hướng cuộn bảng";

  const buttonClass =
    "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface text-xs font-semibold text-foreground shadow-2xs transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div
      role="region"
      aria-label={regionLabel}
      onKeyDown={handleKeyDown}
      className={cn(
        "fixed bottom-4 left-4 z-40 flex items-center gap-1.5 rounded-2xl border border-border/90 bg-surface/95 px-2.5 py-2 shadow-lg backdrop-blur-xs",
        className,
      )}
    >
      <span className="hidden pr-1 text-[11px] font-medium text-muted sm:inline">
        Điều hướng bảng
      </span>

      <button
        type="button"
        aria-label="Cuộn bảng sang trái"
        title="Cuộn bảng sang trái (Phím mũi tên trái)"
        disabled={!availability.canScrollLeft}
        onClick={() => scrollByDelta(-horizontalStepPx, 0)}
        className={buttonClass}
      >
        ←
      </button>

      <div className="flex flex-col gap-1">
        <button
          type="button"
          aria-label="Cuộn bảng lên trên"
          title="Cuộn bảng lên trên (Phím mũi tên lên)"
          disabled={!availability.canScrollUp}
          onClick={() => scrollByDelta(0, -verticalStepPx)}
          className={cn(buttonClass, "h-7 w-8")}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label="Cuộn bảng xuống dưới"
          title="Cuộn bảng xuống dưới (Phím mũi tên xuống)"
          disabled={!availability.canScrollDown}
          onClick={() => scrollByDelta(0, verticalStepPx)}
          className={cn(buttonClass, "h-7 w-8")}
        >
          ↓
        </button>
      </div>

      <button
        type="button"
        aria-label="Cuộn bảng sang phải"
        title="Cuộn bảng sang phải (Phím mũi tên phải)"
        disabled={!availability.canScrollRight}
        onClick={() => scrollByDelta(horizontalStepPx, 0)}
        className={buttonClass}
      >
        →
      </button>
    </div>
  );
}
