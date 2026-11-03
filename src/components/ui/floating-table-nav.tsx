"use client";

import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import {
  computeClampedTableScrollTarget,
  computeTableScrollAvailability,
  computeTableScrollStepPx,
  resolveFloatingTableNavPositionClass,
  type FloatingTableNavPosition,
  type TableScrollAvailability,
  type TableScrollDirection,
  type TableScrollMetrics,
} from "@/lib/attendance/attendance-monthly-matrix-ui-model";
import { cn } from "@/lib/utils";

export {
  computeClampedTableScrollTarget,
  computeTableScrollAvailability,
  computeTableScrollStepPx,
  resolveFloatingTableNavPositionClass,
  type FloatingTableNavPosition,
  type TableScrollAvailability,
  type TableScrollDirection,
  type TableScrollMetrics,
};

export type FloatingTableNavProps = {
  containerRef: RefObject<HTMLElement | null>;
  tableLabel?: string;
  position?: FloatingTableNavPosition;
  horizontalStepPx?: number;
  verticalStepPx?: number;
  className?: string;
};

export function FloatingTableNav({
  containerRef,
  tableLabel,
  position = "bottom-right",
  horizontalStepPx,
  verticalStepPx,
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

  const scrollInDirection = useCallback(
    (direction: TableScrollDirection) => {
      const el = containerRef.current;
      if (!el) return;
      const customStepPx =
        direction === "left" || direction === "right"
          ? horizontalStepPx
          : verticalStepPx;
      const target = computeClampedTableScrollTarget(
        {
          scrollLeft: el.scrollLeft,
          scrollTop: el.scrollTop,
          scrollWidth: el.scrollWidth,
          scrollHeight: el.scrollHeight,
          clientWidth: el.clientWidth,
          clientHeight: el.clientHeight,
        },
        direction,
        customStepPx,
      );
      if (target.deltaLeft === 0 && target.deltaTop === 0) {
        return;
      }
      if (typeof el.scrollBy === "function") {
        el.scrollBy({
          left: target.deltaLeft,
          top: target.deltaTop,
          behavior: "smooth",
        });
      } else {
        el.scrollLeft = target.left;
        el.scrollTop = target.top;
      }
      window.setTimeout(syncScrollState, 180);
    },
    [containerRef, horizontalStepPx, syncScrollState, verticalStepPx],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (availability.canScrollLeft) {
          scrollInDirection("left");
        }
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (availability.canScrollRight) {
          scrollInDirection("right");
        }
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (availability.canScrollUp) {
          scrollInDirection("up");
        }
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        if (availability.canScrollDown) {
          scrollInDirection("down");
        }
      }
    },
    [
      availability.canScrollDown,
      availability.canScrollLeft,
      availability.canScrollRight,
      availability.canScrollUp,
      scrollInDirection,
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

  const navNode = (
    <div
      role="region"
      aria-label={regionLabel}
      data-testid="floating-table-nav"
      data-position={position}
      onKeyDown={handleKeyDown}
      className={cn(
        resolveFloatingTableNavPositionClass(position),
        "flex max-w-[calc(100vw-2rem)] items-center gap-1.5 rounded-2xl border border-border/90 bg-surface/95 px-2.5 py-2 shadow-lg backdrop-blur-xs",
        className,
      )}
    >
      <button
        type="button"
        aria-label="Cuộn bảng sang trái"
        title="Cuộn bảng sang trái (Phím mũi tên trái)"
        disabled={!availability.canScrollLeft}
        onClick={() => scrollInDirection("left")}
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
          onClick={() => scrollInDirection("up")}
          className={cn(buttonClass, "h-7 w-8")}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label="Cuộn bảng xuống dưới"
          title="Cuộn bảng xuống dưới (Phím mũi tên xuống)"
          disabled={!availability.canScrollDown}
          onClick={() => scrollInDirection("down")}
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
        onClick={() => scrollInDirection("right")}
        className={buttonClass}
      >
        →
      </button>
    </div>
  );

  if (typeof document !== "undefined" && document.body) {
    return createPortal(navNode, document.body);
  }

  return navNode;
}
