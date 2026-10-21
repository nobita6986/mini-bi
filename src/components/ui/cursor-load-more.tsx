import { cn } from "@/lib/utils";

export function CursorLoadMore({
  hasMore,
  loading = false,
  onLoadMore,
  label = "Tải thêm",
  loadingLabel = "Đang tải…",
  className,
}: {
  hasMore: boolean;
  loading?: boolean;
  onLoadMore: () => void;
  label?: string;
  loadingLabel?: string;
  className?: string;
}) {
  if (!hasMore) return null;
  return (
    <button
      type="button"
      disabled={loading}
      aria-busy={loading}
      onClick={onLoadMore}
      className={cn(
        "inline-flex min-h-11 sm:min-h-10 items-center justify-center rounded-lg border border-border bg-surface px-4 text-sm font-medium text-foreground whitespace-nowrap shrink-0",
        "hover:bg-muted/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {loading ? loadingLabel : label}
    </button>
  );
}
