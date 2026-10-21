import { cn } from "@/lib/utils";

const PAGER_BUTTON_CLASS =
  "inline-flex min-h-10 items-center justify-center rounded-md border border-border bg-surface px-3 text-sm font-medium text-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";

export function OffsetPager({
  page,
  pageCount,
  total,
  ariaLabel = "Phân trang danh sách",
  previousLabel = "Trang trước",
  nextLabel = "Trang sau",
  previousDisabled,
  nextDisabled,
  disabled = false,
  onPageChange,
  className,
}: {
  page: number;
  pageCount: number;
  total?: number;
  ariaLabel?: string;
  previousLabel?: string;
  nextLabel?: string;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  disabled?: boolean;
  onPageChange: (nextPage: number) => void;
  className?: string;
}) {
  const safePageCount = Math.max(1, pageCount);
  return (
    <div
      className={cn(
        "mt-4 flex flex-col gap-3 border-t border-border pt-3 text-sm sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <p aria-live="polite" className="text-muted">
        Trang {page} / {safePageCount}
        {typeof total === "number" ? ` · ${total} kết quả` : ""}
      </p>
      <nav aria-label={ariaLabel} className="flex items-center gap-2">
        <button
          type="button"
          className={PAGER_BUTTON_CLASS}
          disabled={previousDisabled ?? (disabled || page <= 1)}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          {previousLabel}
        </button>
        <button
          type="button"
          className={PAGER_BUTTON_CLASS}
          disabled={nextDisabled ?? (disabled || page >= safePageCount)}
          onClick={() => onPageChange(Math.min(safePageCount, page + 1))}
        >
          {nextLabel}
        </button>
      </nav>
    </div>
  );
}
