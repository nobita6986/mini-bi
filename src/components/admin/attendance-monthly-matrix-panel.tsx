"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";

import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import {
  DATA_TABLE_CLASS,
  DATA_TABLE_HEAD_CLASS,
  DATA_TABLE_ROW_CLASS,
  DATA_TABLE_TD_CLASS,
  DATA_TABLE_TH_CLASS,
  DataTableContainer,
} from "@/components/ui/data-table";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { OffsetPager } from "@/components/ui/offset-pager";
import {
  ATTENDANCE_BUSINESS_TIMEZONE,
  ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE,
  formatCoordinatePair,
  formatDistanceMeters,
  newAttendanceHqIntentKey,
} from "@/lib/attendance/attendance-report-contract";
import {
  projectAssignBranchResult,
  projectAttendanceBranchesAdminList,
  projectAttendanceMonthlyMatrixReport,
  projectUnassignBranchResult,
  projectUpsertBranchResult,
  type AttendanceBranchAdminItemProjection,
  type AttendanceBranchAssignmentAdminItemProjection,
  type AttendanceBranchesAdminListProjection,
  type AttendanceMonthlyMatrixDayCellProjection,
  type AttendanceMonthlyMatrixEmployeeRowProjection,
  type AttendanceMonthlyMatrixReportProjection,
} from "@/lib/attendance/attendance-monthly-matrix-contract";
import {
  buildAssignEmployeeToBranchPayload,
  buildGoogleMapsCoordinatesUrl,
  buildMonthlyMatrixExportUrl,
  buildMonthlyMatrixReportQuery,
  buildUnassignEmployeeFromBranchPayload,
  buildUpsertBranchPayload,
  describeBranchAssignmentStatus,
  describeMatrixDayCell,
  formatMatrixWeekdayLabel,
  getVietnamCurrentYearMonth,
  mapBranchAdminMutationError,
  mapMonthlyMatrixExportError,
  mapMonthlyMatrixReportError,
  validateMonthlyMatrixFilters,
  type MatrixEmployeeFilterMode,
} from "@/lib/attendance/attendance-monthly-matrix-ui-model";
import { attendanceMonthlyMatrixExportFilename } from "@/lib/attendance/attendance-monthly-matrix-xlsx";
import { cn } from "@/lib/utils";

const VI_INTEGER = new Intl.NumberFormat("vi-VN");
const VI_DECIMAL = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const INPUT_CLASS =
  "w-full min-h-11 sm:min-h-10 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-ring/30";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractErrorCode(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.code === "string" && payload.code.trim() !== "") {
    return payload.code.trim();
  }
  if (isRecord(payload.error) && typeof payload.error.code === "string") {
    return payload.error.code.trim();
  }
  return null;
}

type MatrixLoadState =
  | { kind: "loading" }
  | { kind: "ready"; report: AttendanceMonthlyMatrixReportProjection }
  | { kind: "denied"; detail: string }
  | { kind: "error"; detail: string };

type MatrixAppliedFilters = {
  yearMonth: string;
  branchId: string;
  filterMode: MatrixEmployeeFilterMode;
  employeeId: string;
  search: string;
  page: number;
};

function MatrixDayCell({ cell }: { cell: AttendanceMonthlyMatrixDayCellProjection }) {
  const presentation = describeMatrixDayCell(cell);

  const cellToneClass =
    presentation.tone === "red"
      ? "border-red-300/80 bg-red-50/90 text-red-950 dark:border-red-900/60 dark:bg-red-950/35 dark:text-red-100"
      : presentation.tone === "amber"
        ? "border-amber-300/80 bg-amber-50/85 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/35 dark:text-amber-100"
        : "border-emerald-300/80 bg-emerald-50/80 text-emerald-950 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-100";

  return (
    <div
      className={cn(
        "flex min-h-[5.5rem] w-40 flex-col justify-between gap-1 rounded-lg border p-2 text-xs",
        cellToneClass,
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <span
          className={cn(
            "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold",
            presentation.tone === "red"
              ? "bg-red-200/80 text-red-950 dark:bg-red-900/70 dark:text-red-100"
              : presentation.tone === "amber"
                ? "bg-amber-200/80 text-amber-950 dark:bg-amber-900/70 dark:text-amber-100"
                : "bg-emerald-200/80 text-emerald-950 dark:bg-emerald-900/70 dark:text-emerald-100",
          )}
        >
          {presentation.statusLabel}
        </span>
        {presentation.targetBadgeLabel ? (
          <span className="rounded border border-current/25 px-1 py-0.5 font-mono text-[10px] font-medium">
            {presentation.targetBadgeLabel}
          </span>
        ) : null}
      </div>

      {presentation.hasCheckin ? (
        <div className="space-y-0.5">
          <p className="font-mono font-semibold tabular-nums">
            {presentation.timeRangeLabel}
          </p>
          {presentation.verificationLabel ? (
            <p className="text-[11px] opacity-85">{presentation.verificationLabel}</p>
          ) : null}
          {presentation.distanceLabel ? (
            <p className="font-mono text-[11px] font-medium opacity-90">
              {presentation.distanceLabel}
            </p>
          ) : null}
        </div>
      ) : null}

      {presentation.hasApprovedLeave ? (
        <div className="space-y-1 border-t border-current/15 pt-1">
          {presentation.leaveBadges.length > 0 ? (
            presentation.leaveBadges.map((leave) => (
              <div
                key={leave.requestId}
                className="rounded bg-white/75 px-1.5 py-0.5 text-[11px] font-semibold text-red-900 shadow-2xs dark:bg-black/30 dark:text-red-100"
              >
                Nghỉ phép: {leave.leaveTypeLabel} · Buổi: {leave.sessionLabel}
              </div>
            ))
          ) : (
            <div className="rounded bg-white/75 px-1.5 py-0.5 text-[11px] font-semibold text-red-900 dark:bg-black/30 dark:text-red-100">
              Nghỉ phép ({VI_DECIMAL.format(presentation.approvedLeaveUnits)} công)
            </div>
          )}
        </div>
      ) : null}

      {presentation.dayStatus === "NO_CHECKIN" ? (
        <p className="text-[11px] opacity-80">
          Không ghi nhận lượt chấm công
        </p>
      ) : null}
    </div>
  );
}

function MatrixEmployeeStickySummary({
  row,
}: {
  row: AttendanceMonthlyMatrixEmployeeRowProjection;
}) {
  return (
    <div className="w-64 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-foreground">
          {row.employee_display_name}
        </span>
        {!row.enabled ? (
          <StatusBadge tone="neutral">Ngừng kích hoạt</StatusBadge>
        ) : null}
      </div>
      <p className="font-mono text-xs text-muted">
        {row.personnel_code ? `Mã NS: ${row.personnel_code}` : "Chưa liên kết mã NS"}
      </p>
      <div className="text-xs text-muted">
        {row.branch ? (
          <span>
            Chi nhánh:{" "}
            <strong className="font-medium text-foreground">
              {row.branch.branch_code} — {row.branch.display_name}
            </strong>
          </span>
        ) : (
          <span>Đích tính khoảng cách: Trụ sở (HQ)</span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1 text-[11px]">
        <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200">
          Check-in: {VI_INTEGER.format(row.summary.checkin_day_count)} ngày (
          {VI_INTEGER.format(row.summary.total_checkins)} lượt)
        </span>
        <span className="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-900 dark:bg-red-950/60 dark:text-red-200">
          Nghỉ phép: {VI_INTEGER.format(row.summary.approved_leave_day_count)} ngày (
          {VI_DECIMAL.format(row.summary.approved_leave_units)} công)
        </span>
        <span className="rounded bg-red-50 px-1.5 py-0.5 font-medium text-red-800 dark:bg-red-950/40 dark:text-red-200">
          Chưa check-in: {VI_INTEGER.format(row.summary.no_checkin_day_count)} ngày
        </span>
      </div>
      <p className="text-[11px] text-muted">
        Khoảng cách tính được: {VI_INTEGER.format(row.summary.distance_computed_count)} lượt
        {row.summary.min_distance_meters !== null &&
        row.summary.max_distance_meters !== null
          ? ` (${formatDistanceMeters(row.summary.min_distance_meters)} – ${formatDistanceMeters(row.summary.max_distance_meters)})`
          : ""}
      </p>
    </div>
  );
}

export function AttendanceMonthlyMatrixSection() {
  const router = useRouter();
  const notify = useNotify();
  const initialMonth = useMemo(() => getVietnamCurrentYearMonth(), []);

  const [yearMonthInput, setYearMonthInput] = useState(initialMonth);
  const [branchIdInput, setBranchIdInput] = useState("");
  const [filterModeInput, setFilterModeInput] =
    useState<MatrixEmployeeFilterMode>("search");
  const [employeeIdInput, setEmployeeIdInput] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [filterError, setFilterError] = useState<string | null>(null);

  const [appliedFilters, setAppliedFilters] = useState<MatrixAppliedFilters>({
    yearMonth: initialMonth,
    branchId: "",
    filterMode: "search",
    employeeId: "",
    search: "",
    page: 1,
  });
  const [reloadToken, setReloadToken] = useState(0);
  const [loadState, setLoadState] = useState<MatrixLoadState>({ kind: "loading" });
  const [lastReport, setLastReport] =
    useState<AttendanceMonthlyMatrixReportProjection | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<{
    message: string;
    canRetry: boolean;
  } | null>(null);

  const requestReload = useCallback(() => {
    setLoadState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      const query = buildMonthlyMatrixReportQuery({
        yearMonth: appliedFilters.yearMonth,
        branchId: appliedFilters.branchId,
        filterMode: appliedFilters.filterMode,
        employeeId: appliedFilters.employeeId,
        search: appliedFilters.search,
        page: appliedFilters.page,
        pageSize: ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE,
      });

      let response: Response;
      try {
        response = await fetch(`/api/admin/attendance/monthly-matrix?${query}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        setLoadState({
          kind: "error",
          detail: "Không thể kết nối máy chủ để tải ma trận chấm công tháng. Vui lòng thử lại.",
        });
        return;
      }

      if (controller.signal.aborted) return;

      if (response.status === 401) {
        router.replace("/login?next=/admin/attendance");
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (controller.signal.aborted) return;

      if (response.status === 403) {
        setLastReport(null);
        setLoadState({
          kind: "denied",
          detail: mapMonthlyMatrixReportError(403, extractErrorCode(payload)),
        });
        return;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const code = extractErrorCode(payload);
        setLoadState({
          kind: "error",
          detail: mapMonthlyMatrixReportError(response.status, code),
        });
        return;
      }

      const projected = projectAttendanceMonthlyMatrixReport(payload.report);
      if (!projected) {
        setLoadState({
          kind: "error",
          detail: "Dữ liệu phản hồi ma trận chấm công tháng không đúng định dạng chuẩn.",
        });
        return;
      }

      setLastReport(projected);
      setLoadState({ kind: "ready", report: projected });
    })();

    return () => {
      controller.abort();
    };
  }, [appliedFilters, reloadToken, router]);

  const activeReport = loadState.kind === "ready" ? loadState.report : lastReport;
  const isFetching = loadState.kind === "loading";

  function handleFilterModeChange(nextMode: MatrixEmployeeFilterMode) {
    setFilterModeInput(nextMode);
    if (nextMode === "employee") {
      setSearchInput("");
    } else {
      setEmployeeIdInput("");
    }
  }

  function handleFilterSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = validateMonthlyMatrixFilters({
      yearMonth: yearMonthInput,
      filterMode: filterModeInput,
      employeeId: employeeIdInput,
      search: searchInput,
    });
    if (validationError) {
      setFilterError(validationError);
      return;
    }
    setFilterError(null);
    setExportError(null);
    setLoadState({ kind: "loading" });
    setAppliedFilters({
      yearMonth: yearMonthInput.trim(),
      branchId: branchIdInput.trim(),
      filterMode: filterModeInput,
      employeeId: filterModeInput === "employee" ? employeeIdInput.trim() : "",
      search: filterModeInput === "search" ? searchInput.trim() : "",
      page: 1,
    });
  }

  function handleResetCurrentMonth() {
    const currentMonth = getVietnamCurrentYearMonth();
    setYearMonthInput(currentMonth);
    setBranchIdInput("");
    setFilterModeInput("search");
    setEmployeeIdInput("");
    setSearchInput("");
    setFilterError(null);
    setExportError(null);
    setLoadState({ kind: "loading" });
    setAppliedFilters({
      yearMonth: currentMonth,
      branchId: "",
      filterMode: "search",
      employeeId: "",
      search: "",
      page: 1,
    });
  }

  async function handleExportExcel() {
    if (exporting) return;
    setExporting(true);
    setExportError(null);

    const exportUrl = buildMonthlyMatrixExportUrl({
      yearMonth: appliedFilters.yearMonth,
      branchId: appliedFilters.branchId,
      filterMode: appliedFilters.filterMode,
      employeeId: appliedFilters.employeeId,
      search: appliedFilters.search,
    });

    try {
      const response = await fetch(exportUrl, {
        method: "GET",
        cache: "no-store",
      });

      if (response.status === 401) {
        setExporting(false);
        router.replace("/login?next=/admin/attendance");
        return;
      }

      if (!response.ok) {
        let payload: unknown = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        const code = extractErrorCode(payload);
        const message = mapMonthlyMatrixExportError(response.status, code);
        const canRetry =
          response.status === 409 ||
          code === "ATTENDANCE_MATRIX_EXPORT_PAGINATION_INCOMPLETE" ||
          response.status >= 500;
        setExportError({ message, canRetry });
        notify.error({ title: "Không thể xuất Excel ma trận tháng", description: message });
        setExporting(false);
        return;
      }

      const blob = await response.blob();
      const filename = attendanceMonthlyMatrixExportFilename(appliedFilters.yearMonth);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);

      notify.success({
        title: "Đã xuất Excel ma trận chấm công tháng",
        description: `Tệp ${filename} đã được tải xuống.`,
      });
    } catch {
      const message =
        "Không thể kết nối máy chủ khi xuất tệp Excel ma trận chấm công. Vui lòng thử lại.";
      setExportError({ message, canRetry: true });
      notify.error({ title: "Lỗi xuất Excel", description: message });
    } finally {
      setExporting(false);
    }
  }

  if (loadState.kind === "denied") {
    return <ErrorState title="Không có quyền truy cập" detail={loadState.detail} />;
  }

  if (loadState.kind === "error" && !activeReport) {
    return (
      <div className="space-y-4">
        <ErrorState
          title="Không tải được ma trận chấm công tháng"
          detail={loadState.detail}
        />
        <div>
          <Button variant="secondary" onClick={requestReload}>
            Thử tải lại
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {loadState.kind === "error" ? (
        <Alert tone="error" role="alert" title="Không thể làm mới ma trận tháng">
          <p>{loadState.detail}</p>
        </Alert>
      ) : null}

      <form onSubmit={handleFilterSubmit}>
        <FilterToolbar
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isFetching}
                onClick={handleResetCurrentMonth}
              >
                Tháng hiện tại
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={isFetching}
              >
                Áp dụng bộ lọc
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={exporting}
                disabled={exporting || isFetching}
                onClick={() => void handleExportExcel()}
              >
                {exporting ? "Đang xuất Excel..." : "Xuất Excel ma trận tháng"}
              </Button>
            </>
          }
          summary={
            <>
              <span>
                Tháng đang xem:{" "}
                <strong className="font-mono text-foreground">
                  {activeReport?.filters.year_month ?? appliedFilters.yearMonth}
                </strong>
                {activeReport
                  ? ` (${activeReport.filters.from_date} → ${activeReport.filters.to_date})`
                  : ""}
              </span>
              <span>Múi giờ nghiệp vụ: {ATTENDANCE_BUSINESS_TIMEZONE}</span>
            </>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label
                htmlFor="matrix-year-month"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Tháng báo cáo (YYYY-MM)
              </label>
              <input
                id="matrix-year-month"
                type="month"
                value={yearMonthInput}
                onChange={(event) => setYearMonthInput(event.target.value)}
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label
                htmlFor="matrix-branch-filter"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Chi nhánh HRP
              </label>
              <select
                id="matrix-branch-filter"
                value={branchIdInput}
                onChange={(event) => setBranchIdInput(event.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Tất cả chi nhánh &amp; trụ sở</option>
                {(activeReport?.branch_options ?? []).map((branch) => (
                  <option key={branch.branch_id} value={branch.branch_id}>
                    {branch.branch_code} — {branch.display_name}
                    {branch.active ? "" : " (Ngừng hoạt động)"}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="matrix-employee-mode"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Cách lọc nhân sự
              </label>
              <select
                id="matrix-employee-mode"
                value={filterModeInput}
                onChange={(event) =>
                  handleFilterModeChange(event.target.value as MatrixEmployeeFilterMode)
                }
                className={INPUT_CLASS}
              >
                <option value="search">Tìm theo tên hoặc mã NS</option>
                <option value="employee">Chọn nhân sự cụ thể</option>
              </select>
            </div>

            {filterModeInput === "employee" ? (
              <div>
                <label
                  htmlFor="matrix-employee-select"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Nhân sự cụ thể
                </label>
                <select
                  id="matrix-employee-select"
                  value={employeeIdInput}
                  onChange={(event) => setEmployeeIdInput(event.target.value)}
                  className={INPUT_CLASS}
                >
                  <option value="">Tất cả nhân sự</option>
                  {(activeReport?.employee_options ?? []).map((emp) => (
                    <option key={emp.app_user_id} value={emp.app_user_id}>
                      {emp.display_name}
                      {emp.personnel_code ? ` (${emp.personnel_code})` : ""}
                      {emp.branch_code ? ` · CN ${emp.branch_code}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <label
                  htmlFor="matrix-search-input"
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Từ khóa tên / mã nhân sự
                </label>
                <input
                  id="matrix-search-input"
                  type="search"
                  maxLength={100}
                  placeholder="Nhập tên hoặc mã nhân sự..."
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  className={INPUT_CLASS}
                />
              </div>
            )}
          </div>
        </FilterToolbar>
      </form>

      {filterError ? (
        <Alert tone="error" role="alert" title="Bộ lọc ma trận chưa hợp lệ">
          <p>{filterError}</p>
        </Alert>
      ) : null}

      {exportError ? (
        <Alert tone="error" role="alert" title="Không thể xuất Excel ma trận tháng">
          <p>{exportError.message}</p>
          {exportError.canRetry ? (
            <div className="mt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={exporting}
                onClick={() => void handleExportExcel()}
              >
                Thử xuất lại
              </Button>
            </div>
          ) : null}
        </Alert>
      ) : null}

      {/* Monthly Overview KPI Cards */}
      <section aria-label="Tổng quan chấm công tháng" className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">
          Tổng quan ma trận tháng
        </h2>
        {activeReport ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Tổng nhân sự trong kỳ
              </p>
              <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-foreground">
                {VI_INTEGER.format(activeReport.overview.total_employees)}
              </p>
              <p className="mt-1 text-xs text-muted">
                Có check-in:{" "}
                <strong className="font-mono text-foreground">
                  {VI_INTEGER.format(activeReport.overview.employees_with_checkins)}
                </strong>{" "}
                nhân sự
              </p>
            </Card>

            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Số ngày &amp; lượt check-in
              </p>
              <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
                {VI_INTEGER.format(activeReport.overview.total_checkin_days)}{" "}
                <span className="text-sm font-normal text-muted">ngày</span>
              </p>
              <p className="mt-1 text-xs text-muted">
                Tổng lượt check-in:{" "}
                <strong className="font-mono text-foreground">
                  {VI_INTEGER.format(activeReport.overview.total_checkins)}
                </strong>{" "}
                lượt
              </p>
            </Card>

            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Nghỉ phép đã duyệt
              </p>
              <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-red-700 dark:text-red-300">
                {VI_INTEGER.format(activeReport.overview.total_approved_leave_days)}{" "}
                <span className="text-sm font-normal text-muted">ngày</span>
              </p>
              <p className="mt-1 text-xs text-muted">
                {VI_DECIMAL.format(activeReport.overview.total_approved_leave_units)} công phép trên{" "}
                <strong className="font-mono text-foreground">
                  {VI_INTEGER.format(activeReport.overview.employees_with_approved_leave)}
                </strong>{" "}
                nhân sự
              </p>
            </Card>

            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Ngày chưa có check-in
              </p>
              <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-red-700 dark:text-red-300">
                {VI_INTEGER.format(activeReport.overview.total_no_checkin_days)}
              </p>
              <p className="mt-1 text-xs text-muted">
                Chưa check-in &amp; không có phép:{" "}
                <strong className="font-mono text-foreground">
                  {VI_INTEGER.format(
                    activeReport.overview.total_no_checkin_without_leave_days,
                  )}
                </strong>{" "}
                ngày
              </p>
            </Card>
          </div>
        ) : (
          <Card>
            <p className="text-sm text-muted">Đang tải tổng quan ma trận tháng...</p>
          </Card>
        )}
      </section>

      {/* Matrix Table */}
      <Card>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <CardHeader
            title={`Bảng ma trận chấm công tháng ${activeReport?.filters.year_month ?? appliedFilters.yearMonth}`}
            description="Mỗi dòng là một nhân viên, mỗi cột là một ngày trong tháng. Ô màu đỏ thể hiện ngày chưa có check-in hoặc ngày nghỉ phép đã duyệt (kèm rõ loại phép và buổi nghỉ)."
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 font-medium text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
              Có check-in
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 font-medium text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              Có check-in &amp; Nghỉ phép
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-red-50 px-2 py-1 font-medium text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              Nghỉ phép đã duyệt (ghi rõ loại phép/buổi)
            </span>
            <span className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50/75 px-2 py-1 font-medium text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
              Chưa có check-in
            </span>
          </div>
        </div>

        {!activeReport ? (
          <p className="py-8 text-center text-sm text-muted">
            Đang tải dữ liệu ma trận chấm công tháng...
          </p>
        ) : activeReport.items.length === 0 ? (
          <EmptyState
            title="Không có nhân sự phù hợp trong tháng đã chọn"
            description="Thử chọn lại chi nhánh HRP hoặc xóa bộ lọc nhân sự/từ khóa."
          />
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="min-w-max border-collapse text-left text-sm">
                <thead className={DATA_TABLE_HEAD_CLASS}>
                  <tr>
                    <th
                      scope="col"
                      className="sticky left-0 z-20 min-w-[17rem] border-b border-r border-border bg-surface px-3 py-3 text-xs font-semibold uppercase tracking-wide text-muted shadow-[1px_0_0_var(--border)]"
                    >
                      Nhân sự &amp; Tổng hợp tháng
                    </th>
                    {activeReport.calendar_days.map((calDay) => (
                      <th
                        key={calDay.business_date}
                        scope="col"
                        title={calDay.business_date}
                        className="min-w-[10.5rem] border-b border-r border-border px-2 py-2 text-center text-xs font-semibold text-foreground last:border-r-0"
                      >
                        <div className="font-mono text-sm">
                          Ngày {String(calDay.day_of_month).padStart(2, "0")}
                        </div>
                        <div className="text-[11px] font-normal text-muted">
                          {formatMatrixWeekdayLabel(calDay.day_of_week)} · {calDay.business_date.slice(5)}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeReport.items.map((row) => (
                    <tr
                      key={row.app_user_id}
                      className="border-b border-border/80 align-top last:border-b-0"
                    >
                      <td className="sticky left-0 z-10 border-r border-border bg-surface px-3 py-3 shadow-[1px_0_0_var(--border)]">
                        <MatrixEmployeeStickySummary row={row} />
                      </td>
                      {row.days.map((cell) => (
                        <td
                          key={cell.business_date}
                          className="border-r border-border/60 p-1.5 align-top last:border-r-0"
                        >
                          <MatrixDayCell cell={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <OffsetPager
              page={activeReport.pagination.page}
              pageCount={activeReport.pagination.total_pages}
              total={activeReport.pagination.total_rows}
              disabled={isFetching}
              ariaLabel="Phân trang ma trận chấm công tháng"
              onPageChange={(nextPage) => {
                setLoadState({ kind: "loading" });
                setAppliedFilters((current) => ({ ...current, page: nextPage }));
              }}
            />
          </>
        )}
      </Card>
    </div>
  );
}

type BranchesLoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: AttendanceBranchesAdminListProjection }
  | { kind: "denied"; detail: string }
  | { kind: "error"; detail: string };

type BranchDialogMode =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; branch: AttendanceBranchAdminItemProjection }
  | { kind: "assign"; preselectedBranchId?: string }
  | {
      kind: "unassign";
      assignment: AttendanceBranchAssignmentAdminItemProjection;
    };

export function AttendanceBranchesAdminSection() {
  const router = useRouter();
  const notify = useNotify();

  const [includeInactive, setIncludeInactive] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [loadState, setLoadState] = useState<BranchesLoadState>({ kind: "loading" });
  const [lastData, setLastData] =
    useState<AttendanceBranchesAdminListProjection | null>(null);

  const [assignmentBranchFilter, setAssignmentBranchFilter] = useState("");
  const [assignmentStatusFilter, setAssignmentStatusFilter] = useState<
    "all" | "effective" | "upcoming" | "closed"
  >("all");

  const [dialogMode, setDialogMode] = useState<BranchDialogMode>({ kind: "closed" });
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [conflictBanner, setConflictBanner] = useState<string | null>(null);

  // Branch upsert form state
  const [branchCodeInput, setBranchCodeInput] = useState("");
  const [branchNameInput, setBranchNameInput] = useState("");
  const [branchAddressInput, setBranchAddressInput] = useState("");
  const [branchLatInput, setBranchLatInput] = useState("");
  const [branchLonInput, setBranchLonInput] = useState("");
  const [branchActiveInput, setBranchActiveInput] = useState(true);

  // Assignment form state
  const [assignUserIdInput, setAssignUserIdInput] = useState("");
  const [assignBranchIdInput, setAssignBranchIdInput] = useState("");
  const [assignValidFromInput, setAssignValidFromInput] = useState("");

  // Unassign form state
  const [unassignValidToInput, setUnassignValidToInput] = useState("");

  const requestReload = useCallback(() => {
    setLoadState({ kind: "loading" });
    setConflictBanner(null);
    setReloadToken((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      const params = new URLSearchParams({
        include_inactive: includeInactive ? "true" : "false",
      });

      let response: Response;
      try {
        response = await fetch(`/api/admin/attendance/branches?${params.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        setLoadState({
          kind: "error",
          detail: "Không thể kết nối máy chủ để tải danh sách chi nhánh HRP.",
        });
        return;
      }

      if (controller.signal.aborted) return;

      if (response.status === 401) {
        router.replace("/login?next=/admin/attendance");
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (controller.signal.aborted) return;

      if (response.status === 403) {
        setLastData(null);
        setLoadState({
          kind: "denied",
          detail: "Tài khoản hiện tại không có quyền xem danh sách chi nhánh HRP.",
        });
        return;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        setLoadState({
          kind: "error",
          detail: "Không tải được dữ liệu quản trị chi nhánh HRP. Vui lòng thử lại.",
        });
        return;
      }

      const projected = projectAttendanceBranchesAdminList({
        viewer: payload.viewer,
        business_date: payload.business_date,
        include_inactive: payload.include_inactive,
        branches: payload.branches,
        assignments: payload.assignments,
        employee_options: payload.employee_options,
      });

      if (!projected) {
        setLoadState({
          kind: "error",
          detail: "Dữ liệu danh sách chi nhánh HRP không đúng định dạng chuẩn.",
        });
        return;
      }

      setLastData(projected);
      setLoadState({ kind: "ready", data: projected });
    })();

    return () => {
      controller.abort();
    };
  }, [includeInactive, reloadToken, router]);

  const activeData = loadState.kind === "ready" ? loadState.data : lastData;
  const isFetching = loadState.kind === "loading";
  const canManageBranches = activeData?.viewer.can_manage_branches === true;

  const activeBranches = useMemo(
    () => (activeData?.branches ?? []).filter((branch) => branch.active),
    [activeData],
  );

  const filteredAssignments = useMemo(() => {
    const rows = activeData?.assignments ?? [];
    return rows.filter((item) => {
      if (assignmentBranchFilter !== "" && item.branch_id !== assignmentBranchFilter) {
        return false;
      }
      if (assignmentStatusFilter === "effective") {
        return item.valid_to === null && item.effective;
      }
      if (assignmentStatusFilter === "upcoming") {
        return item.valid_to === null && !item.effective;
      }
      if (assignmentStatusFilter === "closed") {
        return item.valid_to !== null;
      }
      return true;
    });
  }, [activeData, assignmentBranchFilter, assignmentStatusFilter]);

  function closeDialog() {
    if (mutationBusy) return;
    setDialogMode({ kind: "closed" });
    setMutationError(null);
  }

  function openCreateBranchDialog() {
    setMutationError(null);
    setBranchCodeInput("");
    setBranchNameInput("");
    setBranchAddressInput("");
    setBranchLatInput("");
    setBranchLonInput("");
    setBranchActiveInput(true);
    setDialogMode({ kind: "create" });
  }

  function openEditBranchDialog(branch: AttendanceBranchAdminItemProjection) {
    setMutationError(null);
    setBranchCodeInput(branch.branch_code);
    setBranchNameInput(branch.display_name);
    setBranchAddressInput(branch.address);
    setBranchLatInput(branch.latitude === null ? "" : String(branch.latitude));
    setBranchLonInput(branch.longitude === null ? "" : String(branch.longitude));
    setBranchActiveInput(branch.active);
    setDialogMode({ kind: "edit", branch });
  }

  function openAssignDialog(preselectedBranchId?: string) {
    setMutationError(null);
    setAssignUserIdInput("");
    const defaultBranchId =
      preselectedBranchId ?? activeBranches[0]?.branch_id ?? "";
    setAssignBranchIdInput(defaultBranchId);
    setAssignValidFromInput(activeData?.business_date ?? "");
    setDialogMode({ kind: "assign", preselectedBranchId });
  }

  function openUnassignDialog(assignment: AttendanceBranchAssignmentAdminItemProjection) {
    setMutationError(null);
    setUnassignValidToInput(activeData?.business_date ?? assignment.valid_from);
    setDialogMode({ kind: "unassign", assignment });
  }

  async function handleSaveBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationBusy || !canManageBranches) return;

    const isEdit = dialogMode.kind === "edit";
    const expectedVersion = isEdit ? dialogMode.branch.version : 0;
    const idempotencyKey = newAttendanceHqIntentKey();

    const built = buildUpsertBranchPayload({
      branchCode: branchCodeInput,
      displayName: branchNameInput,
      address: branchAddressInput,
      latitudeInput: branchLatInput,
      longitudeInput: branchLonInput,
      active: branchActiveInput,
      expectedVersion,
      idempotencyKey,
    });

    if (!built.ok) {
      setMutationError(built.message);
      return;
    }

    setMutationBusy(true);
    setMutationError(null);

    const url = isEdit
      ? `/api/admin/attendance/branches/${encodeURIComponent(dialogMode.branch.branch_id)}`
      : "/api/admin/attendance/branches";
    const method = isEdit ? "PUT" : "POST";

    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(built.body),
      });

      if (response.status === 401) {
        setMutationBusy(false);
        router.replace("/login?next=/admin/attendance");
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const mapped = mapBranchAdminMutationError(
          response.status,
          extractErrorCode(payload),
        );
        setMutationError(mapped.message);
        if (mapped.isConflict) {
          setConflictBanner(mapped.message);
        }
        setMutationBusy(false);
        return;
      }

      const projected = projectUpsertBranchResult({
        replayed: payload.replayed,
        branch: payload.branch,
      });
      if (!projected) {
        setMutationError("Phản hồi lưu chi nhánh không đúng định dạng chuẩn.");
        setMutationBusy(false);
        return;
      }

      setMutationBusy(false);
      setDialogMode({ kind: "closed" });
      notify.success({
        title: isEdit ? "Đã cập nhật chi nhánh HRP" : "Đã tạo chi nhánh HRP mới",
        description: `${projected.branch.branch_code} — ${projected.branch.display_name} (v${projected.branch.version})`,
      });
      requestReload();
    } catch {
      setMutationBusy(false);
      setMutationError("Không thể kết nối máy chủ khi lưu chi nhánh HRP.");
    }
  }

  async function handleQuickToggleBranchActive(
    branch: AttendanceBranchAdminItemProjection,
  ) {
    if (mutationBusy || !canManageBranches) return;
    const idempotencyKey = newAttendanceHqIntentKey();
    const built = buildUpsertBranchPayload({
      branchCode: branch.branch_code,
      displayName: branch.display_name,
      address: branch.address,
      latitudeInput: branch.latitude === null ? "" : String(branch.latitude),
      longitudeInput: branch.longitude === null ? "" : String(branch.longitude),
      active: !branch.active,
      expectedVersion: branch.version,
      idempotencyKey,
    });
    if (!built.ok) {
      notify.error({ title: "Không thể đổi trạng thái", description: built.message });
      return;
    }

    setMutationBusy(true);
    try {
      const response = await fetch(
        `/api/admin/attendance/branches/${encodeURIComponent(branch.branch_id)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(built.body),
        },
      );

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const mapped = mapBranchAdminMutationError(
          response.status,
          extractErrorCode(payload),
        );
        if (mapped.isConflict) setConflictBanner(mapped.message);
        notify.error({ title: "Không thể đổi trạng thái chi nhánh", description: mapped.message });
        setMutationBusy(false);
        return;
      }

      setMutationBusy(false);
      notify.success({
        title: !branch.active ? "Đã kích hoạt chi nhánh" : "Đã ngừng hoạt động chi nhánh",
        description: `${branch.branch_code} — ${branch.display_name}`,
      });
      requestReload();
    } catch {
      setMutationBusy(false);
      notify.error({
        title: "Lỗi kết nối",
        description: "Không thể kết nối máy chủ khi đổi trạng thái chi nhánh.",
      });
    }
  }

  async function handleAssignEmployee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationBusy || !canManageBranches) return;

    const selectedBranch =
      (activeData?.branches ?? []).find((b) => b.branch_id === assignBranchIdInput) ??
      null;
    const idempotencyKey = newAttendanceHqIntentKey();

    const built = buildAssignEmployeeToBranchPayload({
      appUserId: assignUserIdInput,
      branch: selectedBranch,
      validFrom: assignValidFromInput,
      idempotencyKey,
    });

    if (!built.ok) {
      setMutationError(built.message);
      return;
    }

    setMutationBusy(true);
    setMutationError(null);

    try {
      const response = await fetch("/api/admin/attendance/branches/assignments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(built.body),
      });

      if (response.status === 401) {
        setMutationBusy(false);
        router.replace("/login?next=/admin/attendance");
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const mapped = mapBranchAdminMutationError(
          response.status,
          extractErrorCode(payload),
        );
        setMutationError(mapped.message);
        if (mapped.isConflict) setConflictBanner(mapped.message);
        setMutationBusy(false);
        return;
      }

      const projected = projectAssignBranchResult({
        replayed: payload.replayed,
        assignment: payload.assignment,
      });
      if (!projected) {
        setMutationError("Phản hồi phân công chi nhánh không đúng định dạng chuẩn.");
        setMutationBusy(false);
        return;
      }

      setMutationBusy(false);
      setDialogMode({ kind: "closed" });
      notify.success({
        title: "Đã gán nhân viên vào chi nhánh HRP",
        description: `Chi nhánh ${projected.assignment.branch_code} · hiệu lực từ ${projected.assignment.valid_from}`,
      });
      requestReload();
    } catch {
      setMutationBusy(false);
      setMutationError("Không thể kết nối máy chủ khi phân công chi nhánh.");
    }
  }

  async function handleUnassignEmployee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationBusy || !canManageBranches || dialogMode.kind !== "unassign") return;

    const targetAssignment = dialogMode.assignment;
    const idempotencyKey = newAttendanceHqIntentKey();

    const built = buildUnassignEmployeeFromBranchPayload({
      validTo: unassignValidToInput,
      expectedVersion: targetAssignment.version,
      idempotencyKey,
    });

    if (!built.ok) {
      setMutationError(built.message);
      return;
    }

    setMutationBusy(true);
    setMutationError(null);

    try {
      const response = await fetch(
        `/api/admin/attendance/branches/assignments/${encodeURIComponent(targetAssignment.assignment_id)}/unassign`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(built.body),
        },
      );

      if (response.status === 401) {
        setMutationBusy(false);
        router.replace("/login?next=/admin/attendance");
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const mapped = mapBranchAdminMutationError(
          response.status,
          extractErrorCode(payload),
        );
        setMutationError(mapped.message);
        if (mapped.isConflict) setConflictBanner(mapped.message);
        setMutationBusy(false);
        return;
      }

      const projected = projectUnassignBranchResult({
        replayed: payload.replayed,
        assignment: payload.assignment,
      });
      if (!projected) {
        setMutationError("Phản hồi kết thúc phân công không đúng định dạng chuẩn.");
        setMutationBusy(false);
        return;
      }

      setMutationBusy(false);
      setDialogMode({ kind: "closed" });
      notify.success({
        title: "Đã kết thúc phân công chi nhánh",
        description: `Hiệu lực đến ngày ${projected.assignment.valid_to ?? ""}`,
      });
      requestReload();
    } catch {
      setMutationBusy(false);
      setMutationError("Không thể kết nối máy chủ khi kết thúc phân công chi nhánh.");
    }
  }

  if (loadState.kind === "denied") {
    return <ErrorState title="Không có quyền truy cập" detail={loadState.detail} />;
  }

  if (loadState.kind === "error" && !activeData) {
    return (
      <div className="space-y-4">
        <ErrorState
          title="Không tải được danh sách chi nhánh HRP"
          detail={loadState.detail}
        />
        <div>
          <Button variant="secondary" onClick={requestReload}>
            Thử tải lại
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {conflictBanner ? (
        <Alert tone="warning" role="alert" title="Xung đột phiên bản dữ liệu">
          <p>{conflictBanner}</p>
          <div className="mt-2">
            <Button variant="secondary" size="sm" onClick={requestReload}>
              Tải lại danh sách chi nhánh
            </Button>
          </div>
        </Alert>
      ) : null}

      {/* 1. Danh mục Chi nhánh HRP */}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <CardHeader
            title="Quản trị Chi nhánh HRP"
            description="Danh mục chi nhánh văn phòng/tuyển dụng dùng để đối chiếu khoảng cách chấm công cho nhân sự được phân công."
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(event) => setIncludeInactive(event.target.checked)}
                className="h-4 w-4 rounded border-border text-accent focus:ring-ring/40"
              />
              Hiển thị cả chi nhánh ngừng hoạt động
            </label>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={isFetching}
              onClick={requestReload}
            >
              Làm mới
            </Button>
            {canManageBranches ? (
              <>
                <Button
                  type="button"
                  variant="soft"
                  size="sm"
                  disabled={mutationBusy}
                  onClick={() => openAssignDialog()}
                >
                  Phân công nhân viên
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={mutationBusy}
                  onClick={openCreateBranchDialog}
                >
                  Thêm chi nhánh HRP
                </Button>
              </>
            ) : activeData ? (
              <StatusBadge tone="neutral">Chỉ xem (BoD)</StatusBadge>
            ) : null}
          </div>
        </div>

        {!activeData ? (
          <p className="py-8 text-center text-sm text-muted">
            Đang tải danh sách chi nhánh HRP...
          </p>
        ) : activeData.branches.length === 0 ? (
          <EmptyState
            title="Chưa có chi nhánh HRP nào"
            description={
              canManageBranches
                ? "Bấm Thêm chi nhánh HRP để khởi tạo chi nhánh đầu tiên."
                : "Hiện chưa có chi nhánh nào được cấu hình trong hệ thống."
            }
          />
        ) : (
          <DataTableContainer>
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Mã &amp; Tên chi nhánh
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Địa chỉ &amp; Tọa độ GPS
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Trạng thái
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Nhân sự hiệu lực
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Cập nhật gần nhất
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody>
                {activeData.branches.map((branch) => {
                  const mapsUrl = buildGoogleMapsCoordinatesUrl(
                    branch.latitude,
                    branch.longitude,
                  );
                  return (
                    <tr key={branch.branch_id} className={DATA_TABLE_ROW_CLASS}>
                      <td data-label="Mã & Tên chi nhánh" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5">
                          <p className="font-semibold text-foreground">
                            {branch.display_name}
                          </p>
                          <p className="font-mono text-xs text-muted">
                            Mã CN: {branch.branch_code} · v{branch.version}
                          </p>
                        </div>
                      </td>
                      <td data-label="Địa chỉ & Tọa độ GPS" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5 text-xs">
                          <p className="max-w-xs break-words text-foreground">
                            {branch.address || "Chưa nhập địa chỉ"}
                          </p>
                          {mapsUrl &&
                          branch.latitude !== null &&
                          branch.longitude !== null ? (
                            <p className="font-mono tabular-nums">
                              <a
                                href={mapsUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary underline decoration-primary/50 underline-offset-2 hover:text-primary/80"
                              >
                                {formatCoordinatePair(branch.latitude, branch.longitude)}
                              </a>
                            </p>
                          ) : (
                            <p className="text-amber-700 dark:text-amber-300">
                              Chưa cấu hình tọa độ
                            </p>
                          )}
                        </div>
                      </td>
                      <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                        {branch.active ? (
                          <StatusBadge tone="success" dot>
                            Đang hoạt động
                          </StatusBadge>
                        ) : (
                          <StatusBadge tone="neutral" dot>
                            Ngừng hoạt động
                          </StatusBadge>
                        )}
                      </td>
                      <td data-label="Nhân sự hiệu lực" className={DATA_TABLE_TD_CLASS}>
                        <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
                          {VI_INTEGER.format(branch.active_assignment_count)}
                        </span>
                      </td>
                      <td data-label="Cập nhật gần nhất" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5 text-xs">
                          <p className="font-medium text-foreground">
                            {branch.updated_by_display_name}
                          </p>
                          <p className="font-mono text-muted">{branch.updated_at.slice(0, 10)}</p>
                        </div>
                      </td>
                      <td data-label="Thao tác" className={DATA_TABLE_TD_CLASS}>
                        {canManageBranches ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={mutationBusy}
                              onClick={() => openEditBranchDialog(branch)}
                            >
                              Sửa
                            </Button>
                            {branch.active ? (
                              <Button
                                type="button"
                                variant="soft"
                                size="sm"
                                disabled={mutationBusy}
                                onClick={() => openAssignDialog(branch.branch_id)}
                              >
                                Gán NV
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={mutationBusy}
                              onClick={() => void handleQuickToggleBranchActive(branch)}
                            >
                              {branch.active ? "Ngừng" : "Kích hoạt"}
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted">Chỉ xem</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTableContainer>
        )}
      </Card>

      {/* 2. Danh sách & Lịch sử phân công nhân viên vào Chi nhánh HRP */}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <CardHeader
            title="Phân công nhân viên theo Chi nhánh HRP"
            description="Theo dõi phân công đang hiệu lực, sắp hiệu lực và lịch sử phân công chi nhánh của nhân viên."
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <select
              aria-label="Lọc phân công theo chi nhánh"
              value={assignmentBranchFilter}
              onChange={(event) => setAssignmentBranchFilter(event.target.value)}
              className={INPUT_CLASS}
            >
              <option value="">Tất cả chi nhánh</option>
              {(activeData?.branches ?? []).map((branch) => (
                <option key={branch.branch_id} value={branch.branch_id}>
                  {branch.branch_code} — {branch.display_name}
                </option>
              ))}
            </select>
            <select
              aria-label="Lọc trạng thái hiệu lực phân công"
              value={assignmentStatusFilter}
              onChange={(event) =>
                setAssignmentStatusFilter(
                  event.target.value as "all" | "effective" | "upcoming" | "closed",
                )
              }
              className={INPUT_CLASS}
            >
              <option value="all">Tất cả trạng thái</option>
              <option value="effective">Đang hiệu lực</option>
              <option value="upcoming">Sắp hiệu lực</option>
              <option value="closed">Đã kết thúc (Lịch sử)</option>
            </select>
          </div>
        </div>

        {!activeData ? (
          <p className="py-8 text-center text-sm text-muted">
            Đang tải lịch sử phân công chi nhánh...
          </p>
        ) : filteredAssignments.length === 0 ? (
          <EmptyState
            title="Chưa có bản ghi phân công chi nhánh phù hợp"
            description="Nhân sự chưa được phân công chi nhánh sẽ mặc định tính khoảng cách chấm công theo Trụ sở (HQ)."
          />
        ) : (
          <DataTableContainer>
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Nhân viên
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Chi nhánh HRP
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Khoảng thời gian hiệu lực
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Trạng thái
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredAssignments.map((assignment) => {
                  const statusInfo = describeBranchAssignmentStatus(assignment);
                  return (
                    <tr key={assignment.assignment_id} className={DATA_TABLE_ROW_CLASS}>
                      <td data-label="Nhân viên" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5">
                          <p className="font-medium text-foreground">
                            {assignment.employee_display_name}
                          </p>
                          <p className="font-mono text-xs text-muted">
                            {assignment.personnel_code
                              ? `Mã NS: ${assignment.personnel_code}`
                              : "Chưa có mã NS"}
                          </p>
                        </div>
                      </td>
                      <td data-label="Chi nhánh HRP" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5">
                          <p className="font-medium text-foreground">
                            {assignment.branch_name}
                          </p>
                          <p className="font-mono text-xs text-muted">
                            {assignment.branch_code}
                          </p>
                        </div>
                      </td>
                      <td data-label="Khoảng thời gian hiệu lực" className={DATA_TABLE_TD_CLASS}>
                        <p className="font-mono text-xs text-foreground">
                          {statusInfo.rangeLabel}
                        </p>
                        <p className="text-[11px] text-muted">
                          Phiên bản phân công: v{assignment.version}
                        </p>
                      </td>
                      <td data-label="Trạng thái" className={DATA_TABLE_TD_CLASS}>
                        <StatusBadge
                          tone={
                            statusInfo.tone === "emerald"
                              ? "success"
                              : statusInfo.tone === "amber"
                                ? "warning"
                                : "neutral"
                          }
                          dot
                        >
                          {statusInfo.statusLabel}
                        </StatusBadge>
                      </td>
                      <td data-label="Thao tác" className={DATA_TABLE_TD_CLASS}>
                        {canManageBranches && statusInfo.canUnassign ? (
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={mutationBusy}
                            onClick={() => openUnassignDialog(assignment)}
                          >
                            Kết thúc phân công
                          </Button>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTableContainer>
        )}
      </Card>

      {/* Dialog: Create / Edit Branch */}
      <FormDialog
        open={dialogMode.kind === "create" || dialogMode.kind === "edit"}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDialog();
        }}
        title={
          dialogMode.kind === "edit"
            ? `Cập nhật chi nhánh ${dialogMode.branch.branch_code}`
            : "Thêm chi nhánh HRP mới"
        }
        description="Vĩ độ và kinh độ phải cùng nhập hoặc cùng để trống. Khi để trống, khoảng cách chấm công của chi nhánh sẽ báo chưa cấu hình tọa độ."
        closeAriaLabel="Đóng hộp thoại chi nhánh"
      >
        <form onSubmit={handleSaveBranch} className="space-y-4">
          {mutationError ? (
            <Alert tone="error" role="alert" title="Không thể lưu chi nhánh">
              <p>{mutationError}</p>
            </Alert>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="branch-code-input"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Mã chi nhánh (A-Z, 0-9, ., _, :, -)
              </label>
              <input
                id="branch-code-input"
                type="text"
                required
                maxLength={64}
                placeholder="VD: HN-CAU-GIAY"
                value={branchCodeInput}
                disabled={mutationBusy}
                onChange={(event) => setBranchCodeInput(event.target.value.toUpperCase())}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label
                htmlFor="branch-name-input"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Tên hiển thị chi nhánh
              </label>
              <input
                id="branch-name-input"
                type="text"
                required
                maxLength={256}
                placeholder="VD: Chi nhánh Cầu Giấy"
                value={branchNameInput}
                disabled={mutationBusy}
                onChange={(event) => setBranchNameInput(event.target.value)}
                className={INPUT_CLASS}
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="branch-address-input"
              className="mb-1 block text-xs font-medium text-muted"
            >
              Địa chỉ chi nhánh (tối đa 500 ký tự)
            </label>
            <input
              id="branch-address-input"
              type="text"
              maxLength={500}
              placeholder="Số nhà, đường, quận/huyện, tỉnh/thành..."
              value={branchAddressInput}
              disabled={mutationBusy}
              onChange={(event) => setBranchAddressInput(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="branch-lat-input"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Vĩ độ (Latitude: -90 đến 90)
              </label>
              <input
                id="branch-lat-input"
                type="text"
                inputMode="decimal"
                placeholder="VD: 21.028511"
                value={branchLatInput}
                disabled={mutationBusy}
                onChange={(event) => setBranchLatInput(event.target.value)}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label
                htmlFor="branch-lon-input"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Kinh độ (Longitude: -180 đến 180)
              </label>
              <input
                id="branch-lon-input"
                type="text"
                inputMode="decimal"
                placeholder="VD: 105.804817"
                value={branchLonInput}
                disabled={mutationBusy}
                onChange={(event) => setBranchLonInput(event.target.value)}
                className={INPUT_CLASS}
              />
            </div>
          </div>

          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={branchActiveInput}
              disabled={mutationBusy}
              onChange={(event) => setBranchActiveInput(event.target.checked)}
              className="h-4 w-4 rounded border-border text-accent focus:ring-ring/40"
            />
            Chi nhánh đang hoạt động
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={mutationBusy}
              onClick={closeDialog}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={mutationBusy}
            >
              {mutationBusy ? "Đang lưu..." : "Lưu chi nhánh"}
            </Button>
          </div>
        </form>
      </FormDialog>

      {/* Dialog: Assign Employee to Branch */}
      <FormDialog
        open={dialogMode.kind === "assign"}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDialog();
        }}
        title="Phân công nhân viên vào Chi nhánh HRP"
        description="Chỉ cho phép gán nhân viên mới vào chi nhánh đang hoạt động. Khoảng hiệu lực không được chồng lấn với phân công khác của cùng nhân viên."
        closeAriaLabel="Đóng hộp thoại phân công chi nhánh"
      >
        <form onSubmit={handleAssignEmployee} className="space-y-4">
          {mutationError ? (
            <Alert tone="error" role="alert" title="Không thể phân công chi nhánh">
              <p>{mutationError}</p>
            </Alert>
          ) : null}

          <div>
            <label
              htmlFor="assign-employee-select"
              className="mb-1 block text-xs font-medium text-muted"
            >
              Nhân viên ({"`app_user_id`"})
            </label>
            <select
              id="assign-employee-select"
              required
              value={assignUserIdInput}
              disabled={mutationBusy}
              onChange={(event) => setAssignUserIdInput(event.target.value)}
              className={INPUT_CLASS}
            >
              <option value="">-- Chọn nhân viên --</option>
              {(activeData?.employee_options ?? []).map((emp) => (
                <option key={emp.app_user_id} value={emp.app_user_id}>
                  {emp.display_name}
                  {emp.personnel_code ? ` (${emp.personnel_code})` : ""}
                  {emp.enabled ? "" : " [Đã khóa]"}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="assign-branch-select"
              className="mb-1 block text-xs font-medium text-muted"
            >
              Chi nhánh HRP (đang hoạt động)
            </label>
            <select
              id="assign-branch-select"
              required
              value={assignBranchIdInput}
              disabled={mutationBusy}
              onChange={(event) => setAssignBranchIdInput(event.target.value)}
              className={INPUT_CLASS}
            >
              <option value="">-- Chọn chi nhánh đang hoạt động --</option>
              {activeBranches.map((branch) => (
                <option key={branch.branch_id} value={branch.branch_id}>
                  {branch.branch_code} — {branch.display_name} (v{branch.version})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="assign-valid-from-input"
              className="mb-1 block text-xs font-medium text-muted"
            >
              Hiệu lực từ ngày (YYYY-MM-DD)
            </label>
            <input
              id="assign-valid-from-input"
              type="date"
              required
              value={assignValidFromInput}
              disabled={mutationBusy}
              onChange={(event) => setAssignValidFromInput(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={mutationBusy}
              onClick={closeDialog}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={mutationBusy}
              disabled={mutationBusy || activeBranches.length === 0}
            >
              {mutationBusy ? "Đang phân công..." : "Xác nhận phân công"}
            </Button>
          </div>
        </form>
      </FormDialog>

      {/* Dialog: Unassign / Close Branch Assignment */}
      <FormDialog
        open={dialogMode.kind === "unassign"}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDialog();
        }}
        title="Kết thúc phân công Chi nhánh HRP"
        description={
          dialogMode.kind === "unassign"
            ? `Nhân viên: ${dialogMode.assignment.employee_display_name} · Chi nhánh: ${dialogMode.assignment.branch_code} (hiệu lực từ ${dialogMode.assignment.valid_from})`
            : undefined
        }
        closeAriaLabel="Đóng hộp thoại kết thúc phân công"
      >
        <form onSubmit={handleUnassignEmployee} className="space-y-4">
          {mutationError ? (
            <Alert tone="error" role="alert" title="Không thể kết thúc phân công">
              <p>{mutationError}</p>
            </Alert>
          ) : null}

          <div>
            <label
              htmlFor="unassign-valid-to-input"
              className="mb-1 block text-xs font-medium text-muted"
            >
              Hiệu lực đến hết ngày (YYYY-MM-DD)
            </label>
            <input
              id="unassign-valid-to-input"
              type="date"
              required
              value={unassignValidToInput}
              disabled={mutationBusy}
              onChange={(event) => setUnassignValidToInput(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={mutationBusy}
              onClick={closeDialog}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={mutationBusy}
            >
              {mutationBusy ? "Đang xử lý..." : "Kết thúc phân công"}
            </Button>
          </div>
        </form>
      </FormDialog>
    </div>
  );
}
