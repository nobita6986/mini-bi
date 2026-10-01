/**
 * Pagination an toàn cho fact loader reporting (R3).
 *
 * Đảm bảo read-model KHÔNG bao giờ công bố dữ liệu bị truncate như dữ liệu đầy đủ.
 * Module thuần (không import "@/", không server-only) để Node test chạy được.
 */

export const REPORTING_PAGE_SIZE = 1000;
export const REPORTING_DEFAULT_MAX_ROWS = 100_000;

export const REPORTING_PAGINATION_FAILED_CODE = "REPORTING_QUERY_FAILED";
export const REPORTING_COUNT_MISMATCH_CODE = "REPORTING_COUNT_MISMATCH";
export const REPORTING_RESULT_TOO_LARGE_CODE = "REPORTING_RESULT_TOO_LARGE";

/** Thứ tự ổn định đúng khóa chính của daily_recruitment_breakdown (để range phân trang không nhảy/trùng). */
export const REPORTING_FACT_ORDER = [
  "source_id",
  "business_date",
  "project_key",
  "recruiter_key",
  "provider_type_key",
  "employment_type_key",
] as const;

export interface PaginatedPage<T> {
  rows: T[];
  /** Exact count từ DB (tổng số dòng khớp filter, bỏ qua range). null = bất thường. */
  count: number | null;
  error?: { code?: string; message?: string } | null;
}

export type PageLoader<T> = (range: readonly [number, number]) => Promise<PaginatedPage<T>>;

export interface PaginationOptions {
  pageSize?: number;
  maxRows?: number;
}

export type PaginateAllResult<T> =
  | { ok: true; rows: T[]; count: number }
  | { ok: false; code: string; message: string };

/**
 * Đọc toàn bộ các dòng khớp filter qua các page (page size <= 1000), rồi xác nhận
 * số dòng thu được bằng exact count. Mọi lỗi (page lỗi, count thiếu/không khớp,
 * vượt ceiling) đều trả { ok:false } — không bao giờ trả dữ liệu một phần.
 *
 * Filter + order do server áp dụng MỘT lần trên query builder (closure `load`),
 * helper chỉ thay đổi `range` giữa các page.
 */
export async function paginateAll<T>(
  load: PageLoader<T>,
  options?: PaginationOptions
): Promise<PaginateAllResult<T>> {
  const pageSize = Math.min(options?.pageSize ?? REPORTING_PAGE_SIZE, REPORTING_PAGE_SIZE);
  const maxRows = options?.maxRows ?? REPORTING_DEFAULT_MAX_ROWS;
  const rows: T[] = [];
  let totalCount: number | null = null;
  let offset = 0;

  for (;;) {
    const page = await load([offset, offset + pageSize - 1]);
    if (page.error) {
      return {
        ok: false,
        code: REPORTING_PAGINATION_FAILED_CODE,
        message: "Không tải được dữ liệu báo cáo. Đây không phải trạng thái không có dữ liệu.",
      };
    }
    if (typeof page.count !== "number" || page.count < 0) {
      return { ok: false, code: REPORTING_COUNT_MISMATCH_CODE, message: "Thiếu exact count từ database." };
    }
    if (totalCount === null) totalCount = page.count;
    else if (totalCount !== page.count) {
      return { ok: false, code: REPORTING_COUNT_MISMATCH_CODE, message: "Exact count không nhất quán giữa các page." };
    }
    const pageRows = page.rows ?? [];
    rows.push(...pageRows);
    if (rows.length > maxRows) {
      return { ok: false, code: REPORTING_RESULT_TOO_LARGE_CODE, message: "Kết quả báo cáo vượt giới hạn xử lý." };
    }
    if (pageRows.length === 0) break;
    if (pageRows.length < pageSize) break;
    offset += pageSize;
    if (rows.length >= totalCount) break;
  }

  if (rows.length !== totalCount) {
    return { ok: false, code: REPORTING_COUNT_MISMATCH_CODE, message: "Số dòng nhận được không khớp exact count." };
  }
  return { ok: true, rows, count: totalCount };
}
