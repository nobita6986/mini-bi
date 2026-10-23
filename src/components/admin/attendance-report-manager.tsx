"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
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
  ATTENDANCE_REPORT_MAX_RANGE_DAYS,
  firstDayOfIsoMonth,
  formatCoordinatePair,
  formatDistanceMeters,
  getVietnamTodayIsoDate,
  isValidIsoCalendarDate,
  newAttendanceHqIntentKey,
  projectAttendanceAdminReport,
  projectSetHqLocationResult,
  shiftIsoDateDays,
  type AttendanceAdminReportProjection,
  type AttendanceEmployeeOptionProjection,
  type AttendanceHqLocationProjection,
  type AttendanceReportItemProjection,
} from "@/lib/attendance/attendance-report-contract";
import {
  filterCatalogSearchOptions,
  type CatalogSearchOption,
} from "@/lib/direct-entry/catalog-search";
import {
  moveTypeaheadIndex,
  typeaheadKeyAction,
} from "@/lib/direct-entry/typeahead";
import { cn } from "@/lib/utils";

type ReportLoadState =
  | { kind: "loading" }
  | { kind: "ready"; report: AttendanceAdminReportProjection }
  | { kind: "denied"; detail: string }
  | { kind: "error"; detail: string };

type AppliedFilterState = {
  fromDate: string;
  toDate: string;
  employeeId: string;
  page: number;
};

type DetailPhotoState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; objectUrl: string }
  | { kind: "error"; message: string };

type EmployeeComboboxEntry = CatalogSearchOption & {
  employeeId: string;
  displayName: string;
  personnelCode: string | null;
};

const UUID_CLIENT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INPUT_CLASS =
  "min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground " +
  "placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

const VI_INTEGER = new Intl.NumberFormat("vi-VN");
const VI_DECIMAL = new Intl.NumberFormat("vi-VN", {
  maximumFractionDigits: 1,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractErrorCode(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.code === "string" ? payload.code : null;
}

function formatEmployeeOptionLabel(option: AttendanceEmployeeOptionProjection): string {
  return option.personnel_code
    ? `${option.display_name} (${option.personnel_code})`
    : option.display_name;
}

function optionDomId(listId: string, employeeId: string): string {
  return `${listId}-${employeeId === "" ? "all" : encodeURIComponent(employeeId)}`;
}

function formatSyncDelayNote(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 300) {
    return null;
  }
  if (seconds < 3600) {
    return `Đồng bộ sau ${Math.round(seconds / 60)} phút`;
  }
  const hours = (seconds / 3600).toFixed(1).replace(".", ",");
  return `Đồng bộ sau ${hours} giờ`;
}

function formatTimeSourceLabel(source: AttendanceReportItemProjection["time_source"]): string {
  return source === "SERVER_ANCHORED"
    ? "Mốc thời gian máy chủ (SERVER_ANCHORED)"
    : "Đồng hồ thiết bị chưa xác minh (DEVICE_CLOCK_UNVERIFIED)";
}

function formatDistanceStatusLabel(
  status: AttendanceReportItemProjection["distance_status"],
): string {
  switch (status) {
    case "COMPUTED":
      return "Đã tính khoảng cách (COMPUTED)";
    case "INVALID_GPS":
      return "Tọa độ GPS thiếu hoặc không hợp lệ (INVALID_GPS)";
    case "HQ_NOT_CONFIGURED":
      return "Chưa cấu hình trụ sở tại thời điểm chấm công (HQ_NOT_CONFIGURED)";
  }
}

function parseCoordinateField(
  rawValue: string,
  min: number,
  max: number,
  label: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const normalized = rawValue.trim().replace(",", ".");
  if (normalized === "") {
    return { ok: false, message: `Vui lòng nhập ${label}.` };
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return {
      ok: false,
      message: `${label} phải là số hợp lệ trong khoảng từ ${min} đến ${max}.`,
    };
  }
  return { ok: true, value: Object.is(parsed, -0) ? 0 : parsed };
}

function validateClientDateRange(fromDate: string, toDate: string): string | null {
  if (!isValidIsoCalendarDate(fromDate) || !isValidIsoCalendarDate(toDate)) {
    return "Ngày lọc không hợp lệ (định dạng YYYY-MM-DD).";
  }
  if (fromDate > toDate) {
    return "Ngày bắt đầu không được lớn hơn ngày kết thúc.";
  }
  const startMs = Date.parse(`${fromDate}T00:00:00Z`);
  const endMs = Date.parse(`${toDate}T00:00:00Z`);
  const diffDays = Math.round((endMs - startMs) / 86_400_000);
  if (diffDays > ATTENDANCE_REPORT_MAX_RANGE_DAYS) {
    return `Khoảng ngày tra cứu tối đa là ${ATTENDANCE_REPORT_MAX_RANGE_DAYS} ngày.`;
  }
  return null;
}

/**
 * Combobox tìm kiếm một lựa chọn cho bộ lọc nhân viên chấm công.
 * Tái sử dụng `filterCatalogSearchOptions`, `moveTypeaheadIndex`, `typeaheadKeyAction`
 * theo pattern `CatalogFilterCombobox` trong `worker-operations.tsx`.
 * Giá trị commit ra ngoài luôn là UUID `app_user_id` hoặc `""` ("Tất cả nhân viên");
 * không bao giờ dùng `display_name` làm khóa lọc gửi lên server.
 */
function AttendanceEmployeeCombobox({
  id,
  label,
  allLabel,
  placeholder,
  options,
  value,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  allLabel: string;
  placeholder: string;
  options: readonly AttendanceEmployeeOptionProjection[];
  value: string;
  disabled?: boolean;
  onChange: (nextEmployeeId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const listboxRef = useRef<HTMLUListElement | null>(null);
  const listId = `${id}-listbox`;

  const entries = useMemo<EmployeeComboboxEntry[]>(
    () => [
      {
        id: "",
        employeeId: "",
        label: allLabel,
        keywords: "",
        displayName: allLabel,
        personnelCode: null,
      },
      ...options.map((option) => ({
        id: option.personnel_code ?? "",
        employeeId: option.app_user_id,
        label: formatEmployeeOptionLabel(option),
        keywords: option.display_name,
        displayName: option.display_name,
        personnelCode: option.personnel_code,
      })),
    ],
    [allLabel, options],
  );

  const visible = useMemo(
    () => filterCatalogSearchOptions(entries, query),
    [entries, query],
  );

  const resolvedActiveIndex =
    activeIndex >= 0 && activeIndex < visible.length ? activeIndex : -1;
  const activeOption =
    resolvedActiveIndex >= 0 ? visible[resolvedActiveIndex] : undefined;

  const selectedOption = useMemo(
    () =>
      value === ""
        ? undefined
        : options.find((option) => option.app_user_id === value),
    [options, value],
  );
  const selectedLabel = selectedOption ? formatEmployeeOptionLabel(selectedOption) : "";

  useEffect(() => {
    if (!open || !activeOption || !listboxRef.current) return;
    const activeEl = document.getElementById(
      optionDomId(listId, activeOption.employeeId),
    );
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [open, activeOption, listId]);

  const choose = (nextEmployeeId: string) => {
    setQuery("");
    setOpen(false);
    setActiveIndex(-1);
    onChange(nextEmployeeId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = typeaheadKeyAction(event.key, event.nativeEvent.isComposing);
    if (action === null || action === "ignore") return;

    if (action === "up" || action === "down") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
      }
      setActiveIndex((index) => moveTypeaheadIndex(index, visible.length, action));
      return;
    }

    if (action === "commit") {
      if (open) {
        event.preventDefault();
        if (activeOption !== undefined) {
          choose(activeOption.employeeId);
        } else if (visible.length === 1) {
          choose(visible[0].employeeId);
        }
      }
      return;
    }

    if (action === "close") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setQuery("");
        setActiveIndex(-1);
      }
      return;
    }

    if (action === "tab") {
      setOpen(false);
      setQuery("");
      setActiveIndex(-1);
    }
  };

  return (
    <div className="relative flex flex-col">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={open}
          aria-activedescendant={
            open && activeOption !== undefined
              ? optionDomId(listId, activeOption.employeeId)
              : undefined
          }
          className={cn(INPUT_CLASS, value !== "" ? "pr-10" : "")}
          placeholder={open && selectedLabel ? selectedLabel : placeholder}
          disabled={disabled}
          value={open ? query : selectedLabel}
          onChange={(event) => {
            const nextQuery = event.target.value;
            const nextVisible = filterCatalogSearchOptions(entries, nextQuery);
            setQuery(nextQuery);
            setOpen(true);
            setActiveIndex(
              nextQuery.trim() !== "" && nextVisible.length > 0 ? 0 : -1,
            );
          }}
          onFocus={() => {
            setQuery("");
            setOpen(true);
            setActiveIndex(-1);
          }}
          onClick={() => {
            if (!open && !disabled) {
              setOpen(true);
            }
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            setOpen(false);
            setQuery("");
            setActiveIndex(-1);
          }}
        />
        {value !== "" && !disabled ? (
          <button
            type="button"
            aria-label="Xóa lọc nhân viên, quay lại Tất cả nhân viên"
            title="Quay lại Tất cả nhân viên"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose("")}
            className="absolute right-1.5 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-sm font-medium text-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            ×
          </button>
        ) : null}
      </div>

      {open ? (
        <ul
          ref={listboxRef}
          id={listId}
          role="listbox"
          aria-label={`${label} — gợi ý`}
          className="absolute top-full z-30 mt-1 max-h-60 w-full overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface py-1 shadow-lg"
        >
          {visible.length === 0 ? (
            <li role="presentation" className="px-3 py-2.5 text-sm text-muted">
              Không tìm thấy nhân viên phù hợp với từ khóa &ldquo;{query.trim()}&rdquo;.
            </li>
          ) : (
            visible.map((option, index) => {
              const isSelected = value === option.employeeId;
              const isHighlighted = resolvedActiveIndex === index;
              return (
                <li
                  key={option.employeeId === "" ? "__all__" : option.employeeId}
                  id={optionDomId(listId, option.employeeId)}
                  role="option"
                  aria-selected={isSelected}
                  className={cn(
                    "flex min-h-11 sm:min-h-9 cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm transition-colors",
                    isHighlighted
                      ? "bg-accent/15 text-foreground"
                      : isSelected
                        ? "bg-surface-muted/80 font-medium text-foreground"
                        : "text-foreground hover:bg-surface-muted/60",
                  )}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option.employeeId)}
                >
                  <div className="min-w-0 flex-1 break-words">
                    <span className={cn(isSelected ? "font-semibold" : "font-normal")}>
                      {option.displayName}
                    </span>
                    {option.personnelCode ? (
                      <span className="ml-1.5 font-mono text-xs text-muted">
                        ({option.personnelCode})
                      </span>
                    ) : option.employeeId !== "" ? (
                      <span className="ml-1.5 text-xs text-muted">
                        (Chưa có mã NS)
                      </span>
                    ) : null}
                  </div>
                  {isSelected ? (
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-xs font-semibold text-accent"
                    >
                      Đang chọn
                    </span>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}

function DistanceCell({ item }: { item: AttendanceReportItemProjection }) {
  if (item.distance_status === "COMPUTED" && item.distance_meters !== null) {
    return (
      <div className="space-y-0.5">
        <p className="font-mono text-sm font-semibold tabular-nums text-foreground">
          {formatDistanceMeters(item.distance_meters)}
        </p>
        <p className="text-xs text-muted">
          Theo trụ sở v{item.hq_version_used}
        </p>
      </div>
    );
  }

  if (item.distance_status === "INVALID_GPS") {
    return (
      <div className="space-y-1">
        <StatusBadge tone="danger">Không tính được</StatusBadge>
        <p className="text-xs text-muted">Tọa độ GPS thiếu hoặc không hợp lệ</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <StatusBadge tone="neutral">Không tính được</StatusBadge>
      <p className="text-xs text-muted">
        Chưa cấu hình trụ sở tại thời điểm chấm công
      </p>
    </div>
  );
}

function TimeVerificationCell({ item }: { item: AttendanceReportItemProjection }) {
  const syncNote = formatSyncDelayNote(item.sync_delay_seconds);
  return (
    <div className="space-y-1">
      {item.time_verified ? (
        <StatusBadge tone="success" dot>
          Đã xác minh (Mốc máy chủ)
        </StatusBadge>
      ) : (
        <StatusBadge tone="warning" dot>
          Chưa xác minh (Đồng hồ thiết bị)
        </StatusBadge>
      )}
      {syncNote ? <p className="text-xs text-muted">{syncNote}</p> : null}
    </div>
  );
}

function GpsDetailCell({ item }: { item: AttendanceReportItemProjection }) {
  const hasValidCoordinates =
    item.latitude !== null &&
    item.longitude !== null &&
    Number.isFinite(item.latitude) &&
    Number.isFinite(item.longitude);

  if (!hasValidCoordinates) {
    return (
      <div className="space-y-1">
        <StatusBadge tone="danger">GPS thiếu / không hợp lệ</StatusBadge>
        {item.note ? (
          <p className="max-w-xs break-words text-xs text-muted">
            Ghi chú: {item.note}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-0.5 text-xs">
      <p className="font-mono tabular-nums text-foreground">
        {formatCoordinatePair(item.latitude, item.longitude)}
        {item.accuracy_meters !== null
          ? ` (±${Math.round(item.accuracy_meters)} m)`
          : ""}
      </p>
      {item.address_hint ? (
        <p className="max-w-xs break-words text-muted">{item.address_hint}</p>
      ) : null}
      {item.note ? (
        <p className="max-w-xs break-words text-foreground/85">
          Ghi chú: {item.note}
        </p>
      ) : null}
    </div>
  );
}

function AttendanceCheckinDetailBody({
  item,
  currentHq,
  photoState,
  onRetryPhoto,
  onPhotoDecodeError,
  onClose,
}: {
  item: AttendanceReportItemProjection;
  currentHq: AttendanceHqLocationProjection | null;
  photoState: DetailPhotoState;
  onRetryPhoto: () => void;
  onPhotoDecodeError: () => void;
  onClose: () => void;
}) {
  const hasValidCoordinates =
    item.latitude !== null &&
    item.longitude !== null &&
    Number.isFinite(item.latitude) &&
    Number.isFinite(item.longitude);
  const syncDelayNote = formatSyncDelayNote(item.sync_delay_seconds);
  const matchesCurrentHq =
    item.hq_version_used !== null &&
    currentHq !== null &&
    currentHq.version === item.hq_version_used;

  return (
    <div className="space-y-4">
      {/* 1. Khung ảnh chấm công private */}
      <section aria-label="Ảnh chấm công" className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Ảnh chấm công
        </h3>
        <div className="flex min-h-44 flex-col items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-muted/40 p-3">
          {photoState.kind === "loading" || photoState.kind === "idle" ? (
            <p
              role="status"
              aria-live="polite"
              className="py-8 text-center text-sm text-muted"
            >
              Đang tải ảnh chấm công…
            </p>
          ) : null}

          {photoState.kind === "ready" ? (
            /* eslint-disable-next-line @next/next/no-img-element -- blob URL tạo từ endpoint ảnh chấm công riêng tư có AbortController và thu hồi qua URL.revokeObjectURL */
            <img
              src={photoState.objectUrl}
              alt={`Ảnh chấm công của ${item.employee_display_name} lúc ${item.captured_at_local}`}
              className="mx-auto max-h-[42dvh] w-auto max-w-full rounded-lg object-contain sm:max-h-[48dvh]"
              onError={onPhotoDecodeError}
            />
          ) : null}

          {photoState.kind === "error" ? (
            <div className="w-full space-y-2">
              <Alert tone="warning" role="alert" title="Không hiển thị được ảnh chấm công">
                <p>{photoState.message}</p>
              </Alert>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={onRetryPhoto}
                >
                  Thử tải lại ảnh
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {/* 2. Nhân sự & Thời điểm chấm công */}
      <section
        aria-label="Thông tin nhân sự và thời gian"
        className="rounded-xl border border-border bg-surface p-3.5 sm:p-4"
      >
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
          Nhân sự &amp; thời gian ghi nhận
        </h3>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">Tên nhân viên</dt>
            <dd className="mt-0.5 break-words font-medium text-foreground">
              {item.employee_display_name}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Mã nhân sự</dt>
            <dd className="mt-0.5 font-mono text-foreground">
              {item.personnel_code ?? "Chưa liên kết mã nhân sự"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">
              Ngày &amp; giờ chấm công ({ATTENDANCE_BUSINESS_TIMEZONE})
            </dt>
            <dd className="mt-0.5 font-mono font-medium tabular-nums text-foreground">
              {item.captured_at_local}
            </dd>
            <dd className="mt-0.5 text-xs text-muted">
              Ngày nghiệp vụ:{" "}
              <span className="font-mono text-foreground">{item.business_date}</span> · Lần #
              {item.sequence_in_day} trong ngày
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Thời điểm UTC</dt>
            <dd className="mt-0.5 break-all font-mono text-xs tabular-nums text-foreground">
              Chụp: {item.captured_at || "Không có"}
            </dd>
            <dd className="mt-0.5 break-all font-mono text-xs tabular-nums text-muted">
              Máy chủ nhận: {item.received_at || "Không có"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Trạng thái xác minh thời gian</dt>
            <dd className="mt-1">
              {item.time_verified ? (
                <StatusBadge tone="success" dot>
                  Đã xác minh
                </StatusBadge>
              ) : (
                <StatusBadge tone="warning" dot>
                  Chưa xác minh
                </StatusBadge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Nguồn thời gian</dt>
            <dd className="mt-0.5 break-words text-foreground">
              {formatTimeSourceLabel(item.time_source)}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted">Độ trễ đồng bộ</dt>
            <dd className="mt-0.5 font-mono tabular-nums text-foreground">
              {VI_INTEGER.format(item.sync_delay_seconds)} giây
              {syncDelayNote ? (
                <span className="ml-2 font-sans text-xs text-muted">
                  ({syncDelayNote})
                </span>
              ) : (
                <span className="ml-2 font-sans text-xs text-muted">
                  (Đồng bộ gần thời gian thực)
                </span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      {/* 3. Vị trí GPS, Khoảng cách trụ sở & Ghi chú */}
      <section
        aria-label="Thông tin GPS và khoảng cách trụ sở"
        className="rounded-xl border border-border bg-surface p-3.5 sm:p-4"
      >
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
          Tọa độ GPS, khoảng cách trụ sở &amp; ghi chú
        </h3>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">Tọa độ GPS (Vĩ độ, Kinh độ)</dt>
            <dd className="mt-0.5 font-mono tabular-nums text-foreground">
              {hasValidCoordinates
                ? formatCoordinatePair(item.latitude, item.longitude)
                : "Thiếu hoặc không hợp lệ"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Độ chính xác GPS</dt>
            <dd className="mt-0.5 font-mono tabular-nums text-foreground">
              {item.accuracy_meters !== null
                ? `±${VI_DECIMAL.format(item.accuracy_meters)} m`
                : "Không có dữ liệu độ chính xác"}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted">Địa chỉ gợi ý</dt>
            <dd className="mt-0.5 break-words text-foreground">
              {item.address_hint.trim() !== ""
                ? item.address_hint
                : "Không có địa chỉ gợi ý"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Khoảng cách tới trụ sở</dt>
            <dd className="mt-0.5 font-mono font-semibold tabular-nums text-foreground">
              {item.distance_status === "COMPUTED" && item.distance_meters !== null
                ? formatDistanceMeters(item.distance_meters)
                : "Không tính được"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Trạng thái tính khoảng cách</dt>
            <dd className="mt-0.5 break-words text-foreground">
              {formatDistanceStatusLabel(item.distance_status)}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted">Phiên bản / cấu hình trụ sở</dt>
            <dd className="mt-0.5 break-words text-foreground">
              {item.hq_version_used !== null ? (
                <span>
                  Áp dụng phiên bản trụ sở{" "}
                  <strong className="font-mono">v{item.hq_version_used}</strong>
                  {matchesCurrentHq && currentHq ? (
                    <span className="text-muted">
                      {" "}
                      — Tọa độ hiện hành:{" "}
                      <span className="font-mono text-foreground">
                        {formatCoordinatePair(currentHq.latitude, currentHq.longitude)}
                      </span>{" "}
                      (hiệu lực từ {currentHq.effective_from_local} GMT+7)
                    </span>
                  ) : currentHq ? (
                    <span className="text-muted">
                      {" "}
                      (Trụ sở hiện hành đang ở phiên bản{" "}
                      <span className="font-mono text-foreground">
                        v{currentHq.version}
                      </span>
                      :{" "}
                      <span className="font-mono text-foreground">
                        {formatCoordinatePair(currentHq.latitude, currentHq.longitude)}
                      </span>
                      )
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="text-muted">
                  Chưa có phiên bản trụ sở áp dụng tại thời điểm chấm công
                  {currentHq
                    ? ` (Trụ sở hiện hành: v${currentHq.version} — ${formatCoordinatePair(currentHq.latitude, currentHq.longitude)})`
                    : ""}
                </span>
              )}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted">Ghi chú</dt>
            <dd className="mt-0.5 whitespace-pre-wrap break-words text-foreground">
              {item.note.trim() !== "" ? item.note : "Không có ghi chú"}
            </dd>
          </div>
        </dl>
      </section>

      <div className="flex justify-end pt-1">
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          Đóng
        </Button>
      </div>
    </div>
  );
}

export function AttendanceReportManager() {
  const router = useRouter();
  const notify = useNotify();
  const initialToday = getVietnamTodayIsoDate();
  const initialFrom = shiftIsoDateDays(initialToday, -6);

  const [fromInput, setFromInput] = useState(initialFrom);
  const [toInput, setToInput] = useState(initialToday);
  const [employeeIdInput, setEmployeeIdInput] = useState("");
  const [filterError, setFilterError] = useState<string | null>(null);

  const [appliedFilters, setAppliedFilters] = useState<AppliedFilterState>({
    fromDate: initialFrom,
    toDate: initialToday,
    employeeId: "",
    page: 1,
  });
  const [reloadToken, setReloadToken] = useState(0);
  const [loadState, setLoadState] = useState<ReportLoadState>({ kind: "loading" });
  const [lastReport, setLastReport] = useState<AttendanceAdminReportProjection | null>(
    null,
  );
  const [knownEmployeesById, setKnownEmployeesById] = useState<
    Record<string, AttendanceEmployeeOptionProjection>
  >({});

  // Detail dialog & private photo lifecycle state
  const [detailItem, setDetailItem] = useState<AttendanceReportItemProjection | null>(
    null,
  );
  const [detailPhotoState, setDetailPhotoState] = useState<DetailPhotoState>({
    kind: "idle",
  });
  const photoAbortRef = useRef<AbortController | null>(null);
  const photoObjectUrlRef = useRef<string | null>(null);
  const photoRequestSeqRef = useRef(0);

  const releaseActivePhotoResources = useCallback(() => {
    photoRequestSeqRef.current += 1;
    if (photoAbortRef.current !== null) {
      photoAbortRef.current.abort();
      photoAbortRef.current = null;
    }
    if (photoObjectUrlRef.current !== null) {
      URL.revokeObjectURL(photoObjectUrlRef.current);
      photoObjectUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      releaseActivePhotoResources();
    };
  }, [releaseActivePhotoResources]);

  // Headquarters configuration form state (only interactive when viewer.can_configure_hq === true)
  const [hqFormOpen, setHqFormOpen] = useState(false);
  const [hqLatInput, setHqLatInput] = useState("");
  const [hqLonInput, setHqLonInput] = useState("");
  const [hqFormError, setHqFormError] = useState<string | null>(null);
  const [hqConflictMessage, setHqConflictMessage] = useState<string | null>(null);
  const [hqSaving, setHqSaving] = useState(false);
  const [hqPendingAttempt, setHqPendingAttempt] = useState<{
    key: string;
    latitude: number;
    longitude: number;
    expectedVersion: number;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      const params = new URLSearchParams({
        from_date: appliedFilters.fromDate,
        to_date: appliedFilters.toDate,
        page: String(appliedFilters.page),
        page_size: String(ATTENDANCE_REPORT_DEFAULT_PAGE_SIZE),
      });
      if (appliedFilters.employeeId !== "") {
        params.set("employee_id", appliedFilters.employeeId);
      }

      let response: Response;
      try {
        response = await fetch(`/api/admin/attendance/report?${params.toString()}`, {
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
          detail: "Không thể kết nối máy chủ để tải báo cáo chấm công. Vui lòng thử lại.",
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
          detail: "Tài khoản hiện tại không có quyền xem báo cáo chấm công.",
        });
        return;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const code = extractErrorCode(payload);
        const detail =
          code === "ATTENDANCE_REPORT_RANGE_INVALID"
            ? "Khoảng ngày lọc không hợp lệ hoặc vượt quá 366 ngày."
            : code === "ATTENDANCE_REPORT_EMPLOYEE_INVALID"
              ? "Nhân viên được chọn không hợp lệ."
              : code === "ATTENDANCE_REPORT_FILTER_CONFLICT"
                ? "Tham số bộ lọc nhân viên bị xung đột."
                : code === "ATTENDANCE_REPORT_SEARCH_INVALID"
                  ? "Từ khóa tìm kiếm nhân viên không hợp lệ."
                  : "Không tải được dữ liệu báo cáo chấm công. Vui lòng thử lại.";
        setLoadState({ kind: "error", detail });
        return;
      }

      const projected = projectAttendanceAdminReport(payload.report);
      if (!projected) {
        setLoadState({
          kind: "error",
          detail: "Dữ liệu phản hồi báo cáo không đúng định dạng chuẩn.",
        });
        return;
      }

      if (projected.employee_options.length > 0) {
        setKnownEmployeesById((prev) => {
          const next = { ...prev };
          for (const option of projected.employee_options) {
            next[option.app_user_id] = option;
          }
          return next;
        });
      }

      setLastReport(projected);
      setLoadState({ kind: "ready", report: projected });
    })();

    return () => {
      controller.abort();
    };
  }, [appliedFilters, reloadToken, router]);

  const activeReport =
    loadState.kind === "ready" ? loadState.report : lastReport;
  const isFetching = loadState.kind === "loading";

  const comboboxEmployeeOptions = useMemo<AttendanceEmployeeOptionProjection[]>(() => {
    const base = activeReport?.employee_options ?? [];
    if (
      employeeIdInput !== "" &&
      !base.some((option) => option.app_user_id === employeeIdInput) &&
      knownEmployeesById[employeeIdInput]
    ) {
      return [knownEmployeesById[employeeIdInput], ...base];
    }
    return base;
  }, [activeReport, employeeIdInput, knownEmployeesById]);

  const appliedEmployeeLabel = useMemo(() => {
    const activeEmployeeId =
      activeReport?.filters.employee_id ??
      (appliedFilters.employeeId !== "" ? appliedFilters.employeeId : null);
    if (!activeEmployeeId) return null;
    const matched =
      activeReport?.employee_options.find(
        (option) => option.app_user_id === activeEmployeeId,
      ) ?? knownEmployeesById[activeEmployeeId];
    return matched ? formatEmployeeOptionLabel(matched) : "Nhân viên đã chọn";
  }, [activeReport, appliedFilters.employeeId, knownEmployeesById]);

  function fetchDetailPhoto(checkinId: string) {
    releaseActivePhotoResources();

    const requestSeq = photoRequestSeqRef.current;
    const controller = new AbortController();
    photoAbortRef.current = controller;
    setDetailPhotoState({ kind: "loading" });

    void (async () => {
      let response: Response;
      try {
        response = await fetch(
          `/api/admin/attendance/checkins/${encodeURIComponent(checkinId)}/photo`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
          },
        );
      } catch (err) {
        if (
          controller.signal.aborted ||
          requestSeq !== photoRequestSeqRef.current ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return;
        }
        setDetailPhotoState({
          kind: "error",
          message:
            "Không thể kết nối máy chủ để tải ảnh chấm công. Thông tin chi tiết bên dưới vẫn đầy đủ.",
        });
        return;
      }

      if (controller.signal.aborted || requestSeq !== photoRequestSeqRef.current) {
        return;
      }

      if (response.status === 401) {
        releaseActivePhotoResources();
        setDetailItem(null);
        setDetailPhotoState({ kind: "idle" });
        router.replace("/login?next=/admin/attendance");
        return;
      }

      if (response.status === 404) {
        setDetailPhotoState({
          kind: "error",
          message: "Không tìm thấy ảnh chấm công cho lượt ghi nhận này.",
        });
        return;
      }

      if (response.status === 403) {
        setDetailPhotoState({
          kind: "error",
          message: "Tài khoản hiện tại không có quyền xem ảnh chấm công này.",
        });
        return;
      }

      if (!response.ok) {
        setDetailPhotoState({
          kind: "error",
          message:
            "Không tải được ảnh chấm công lúc này. Toàn bộ thông tin chi tiết của lượt chấm công vẫn hiển thị bên dưới.",
        });
        return;
      }

      let blob: Blob;
      try {
        blob = await response.blob();
      } catch (err) {
        if (
          controller.signal.aborted ||
          requestSeq !== photoRequestSeqRef.current ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return;
        }
        setDetailPhotoState({
          kind: "error",
          message: "Dữ liệu ảnh chấm công bị gián đoạn khi tải về.",
        });
        return;
      }

      if (controller.signal.aborted || requestSeq !== photoRequestSeqRef.current) {
        return;
      }

      const contentType = (
        response.headers.get("content-type") ??
        blob.type ??
        ""
      ).toLowerCase();
      if (blob.size === 0 || (contentType !== "" && !contentType.startsWith("image/"))) {
        setDetailPhotoState({
          kind: "error",
          message: "Dữ liệu ảnh chấm công không hợp lệ hoặc bị trống.",
        });
        return;
      }

      const nextObjectUrl = URL.createObjectURL(blob);
      if (controller.signal.aborted || requestSeq !== photoRequestSeqRef.current) {
        URL.revokeObjectURL(nextObjectUrl);
        return;
      }

      photoObjectUrlRef.current = nextObjectUrl;
      setDetailPhotoState({ kind: "ready", objectUrl: nextObjectUrl });
    })();
  }

  function openDetailDialog(item: AttendanceReportItemProjection) {
    setDetailItem(item);
    fetchDetailPhoto(item.checkin_id);
  }

  function closeDetailDialog() {
    releaseActivePhotoResources();
    setDetailItem(null);
    setDetailPhotoState({ kind: "idle" });
  }

  function handlePhotoDecodeError() {
    if (photoObjectUrlRef.current !== null) {
      URL.revokeObjectURL(photoObjectUrlRef.current);
      photoObjectUrlRef.current = null;
    }
    setDetailPhotoState({
      kind: "error",
      message:
        "Không thể hiển thị tệp ảnh chấm công. Thông tin chi tiết bên dưới vẫn đầy đủ.",
    });
  }

  function requestReload() {
    setLoadState({ kind: "loading" });
    setReloadToken((token) => token + 1);
  }

  function applyFilterRange(
    nextFrom: string,
    nextTo: string,
    nextEmployeeId: string,
  ) {
    const normalizedEmployeeId = nextEmployeeId.trim().toLowerCase();
    if (
      normalizedEmployeeId !== "" &&
      !UUID_CLIENT_PATTERN.test(normalizedEmployeeId)
    ) {
      setFilterError("Lựa chọn nhân viên không hợp lệ.");
      return;
    }
    const rangeValidationError = validateClientDateRange(nextFrom, nextTo);
    if (rangeValidationError) {
      setFilterError(rangeValidationError);
      return;
    }
    setFilterError(null);
    setFromInput(nextFrom);
    setToInput(nextTo);
    setEmployeeIdInput(normalizedEmployeeId);
    setLoadState({ kind: "loading" });
    setAppliedFilters({
      fromDate: nextFrom,
      toDate: nextTo,
      employeeId: normalizedEmployeeId,
      page: 1,
    });
  }

  function handleFilterSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    applyFilterRange(fromInput, toInput, employeeIdInput);
  }

  function handlePreset(kind: "today" | "7d" | "30d" | "month") {
    const today = getVietnamTodayIsoDate();
    const nextFrom =
      kind === "today"
        ? today
        : kind === "7d"
          ? shiftIsoDateDays(today, -6)
          : kind === "30d"
            ? shiftIsoDateDays(today, -29)
            : firstDayOfIsoMonth(today);
    applyFilterRange(nextFrom, today, employeeIdInput);
  }

  function openHqEditor() {
    if (!activeReport?.viewer.can_configure_hq) return;
    setHqFormError(null);
    setHqConflictMessage(null);
    setHqPendingAttempt(null);
    setHqLatInput(
      activeReport.current_hq ? String(activeReport.current_hq.latitude) : "",
    );
    setHqLonInput(
      activeReport.current_hq ? String(activeReport.current_hq.longitude) : "",
    );
    setHqFormOpen(true);
  }

  async function handleSaveHqLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeReport?.viewer.can_configure_hq || hqSaving) return;

    const parsedLat = parseCoordinateField(
      hqLatInput,
      -90,
      90,
      "Vĩ độ (Latitude)",
    );
    if (!parsedLat.ok) {
      setHqFormError(parsedLat.message);
      return;
    }
    const parsedLon = parseCoordinateField(
      hqLonInput,
      -180,
      180,
      "Kinh độ (Longitude)",
    );
    if (!parsedLon.ok) {
      setHqFormError(parsedLon.message);
      return;
    }

    const expectedVersion = activeReport.current_hq?.version ?? 0;
    const reuseAttempt =
      hqPendingAttempt &&
      hqPendingAttempt.latitude === parsedLat.value &&
      hqPendingAttempt.longitude === parsedLon.value &&
      hqPendingAttempt.expectedVersion === expectedVersion
        ? hqPendingAttempt
        : {
            key: newAttendanceHqIntentKey(),
            latitude: parsedLat.value,
            longitude: parsedLon.value,
            expectedVersion,
          };

    setHqPendingAttempt(reuseAttempt);
    setHqFormError(null);
    setHqConflictMessage(null);
    setHqSaving(true);

    let response: Response;
    try {
      response = await fetch("/api/admin/attendance/hq-location", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": reuseAttempt.key,
        },
        body: JSON.stringify({
          latitude: reuseAttempt.latitude,
          longitude: reuseAttempt.longitude,
          expected_version: reuseAttempt.expectedVersion,
          idempotency_key: reuseAttempt.key,
        }),
      });
    } catch {
      setHqSaving(false);
      setHqFormError(
        "Mất kết nối khi lưu tọa độ trụ sở. Bạn có thể bấm Lưu lại an toàn với cùng dữ liệu.",
      );
      return;
    }

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

    setHqSaving(false);

    if (response.status === 409) {
      const code = extractErrorCode(payload);
      setHqPendingAttempt(null);
      setHqConflictMessage(
        code === "ATTENDANCE_HQ_VERSION_CONFLICT"
          ? "Tọa độ trụ sở vừa được quản trị viên khác cập nhật. Vui lòng tải lại dữ liệu mới nhất trước khi lưu."
          : "Yêu cầu bị xung đột khóa chống trùng lặp. Vui lòng tải lại dữ liệu và thực hiện lại.",
      );
      return;
    }

    if (response.status === 403) {
      setHqPendingAttempt(null);
      setHqFormError("Chỉ tài khoản Full Admin mới được phép cập nhật tọa độ trụ sở.");
      return;
    }

    if (!response.ok || !isRecord(payload) || payload.ok !== true) {
      setHqPendingAttempt(null);
      setHqFormError("Tọa độ gửi lên không hợp lệ hoặc dịch vụ tạm thời gián đoạn.");
      return;
    }

    const projected = projectSetHqLocationResult({
      replayed: payload.replayed,
      hq: payload.hq,
    });
    if (!projected) {
      setHqPendingAttempt(null);
      setHqFormError("Phản hồi cập nhật trụ sở không hợp lệ. Vui lòng tải lại báo cáo.");
      return;
    }

    setHqPendingAttempt(null);
    setHqFormOpen(false);
    notify.success({
      title: `Đã lưu vị trí trụ sở (v${projected.hq.version})`,
      description: "Các lượt chấm công mới từ thời điểm này sẽ tính khoảng cách theo tọa độ mới.",
    });
    requestReload();
  }

  if (loadState.kind === "denied") {
    return <ErrorState title="Không có quyền truy cập" detail={loadState.detail} />;
  }

  if (loadState.kind === "error" && !activeReport) {
    return (
      <div className="space-y-4">
        <ErrorState title="Không tải được báo cáo chấm công" detail={loadState.detail} />
        <div>
          <Button
            variant="secondary"
            onClick={requestReload}
          >
            Thử tải lại
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            Báo cáo chấm công
          </h1>
          <p className="mt-1 text-sm text-muted">
            Tổng quan và chi tiết lượt chấm công theo ngày nghiệp vụ hệ thống (
            <span className="font-mono">{ATTENDANCE_BUSINESS_TIMEZONE}</span>).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={isFetching}
            onClick={requestReload}
          >
            {isFetching ? "Đang tải..." : "Làm mới"}
          </Button>
        </div>
      </header>

      {loadState.kind === "error" ? (
        <Alert tone="error" role="alert" title="Không thể làm mới báo cáo">
          <p>{loadState.detail}</p>
        </Alert>
      ) : null}

      {/* 1. Headquarters Location Card */}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <CardHeader
            title="Vị trí trụ sở tính khoảng cách"
            description="Mỗi lần cập nhật tạo một phiên bản tọa độ mới có hiệu lực từ thời điểm lưu. Các lượt chấm công lịch sử giữ nguyên khoảng cách theo phiên bản trụ sở hiệu lực lúc chấm công."
          />
          {activeReport?.viewer.can_configure_hq ? (
            <div className="shrink-0">
              {!hqFormOpen ? (
                <Button variant="soft" size="sm" onClick={openHqEditor}>
                  {activeReport.current_hq
                    ? "Cập nhật tọa độ trụ sở"
                    : "Cấu hình tọa độ trụ sở"}
                </Button>
              ) : null}
            </div>
          ) : activeReport ? (
            <StatusBadge tone="neutral">Chỉ xem (BoD/Accounting)</StatusBadge>
          ) : null}
        </div>

        {activeReport ? (
          activeReport.current_hq ? (
            <div className="grid gap-3 rounded-xl border border-border bg-surface-muted/50 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted">
                  Phiên bản hiện hành
                </p>
                <p className="mt-1 font-mono font-semibold text-foreground">
                  v{activeReport.current_hq.version}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted">
                  Tọa độ (Vĩ độ, Kinh độ)
                </p>
                <p className="mt-1 font-mono tabular-nums text-foreground">
                  {activeReport.current_hq.latitude.toFixed(6)},{" "}
                  {activeReport.current_hq.longitude.toFixed(6)}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted">
                  Hiệu lực từ (GMT+7)
                </p>
                <p className="mt-1 font-mono tabular-nums text-foreground">
                  {activeReport.current_hq.effective_from_local}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted">
                  Người cấu hình
                </p>
                <p className="mt-1 font-medium text-foreground">
                  {activeReport.current_hq.configured_by_display_name}
                </p>
              </div>
            </div>
          ) : (
            <Alert tone="warning" title="Chưa cấu hình vị trí trụ sở">
              <p>
                Hệ thống chưa có tọa độ trụ sở. Các lượt chấm công phát sinh trước khi cấu hình sẽ hiển thị rõ là{" "}
                <strong>Không tính được khoảng cách</strong>.
              </p>
            </Alert>
          )
        ) : (
          <p className="text-sm text-muted">Đang tải thông tin vị trí trụ sở...</p>
        )}

        {hqFormOpen && activeReport?.viewer.can_configure_hq ? (
          <form
            onSubmit={handleSaveHqLocation}
            className="mt-4 space-y-4 rounded-xl border border-border bg-surface p-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="hq-latitude-input"
                  className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted"
                >
                  Vĩ độ trụ sở (Latitude: -90 đến 90)
                </label>
                <input
                  id="hq-latitude-input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="Ví dụ: 21.028511"
                  value={hqLatInput}
                  disabled={hqSaving}
                  onChange={(event) => {
                    setHqLatInput(event.target.value);
                    setHqPendingAttempt(null);
                  }}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label
                  htmlFor="hq-longitude-input"
                  className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted"
                >
                  Kinh độ trụ sở (Longitude: -180 đến 180)
                </label>
                <input
                  id="hq-longitude-input"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="Ví dụ: 105.804817"
                  value={hqLonInput}
                  disabled={hqSaving}
                  onChange={(event) => {
                    setHqLonInput(event.target.value);
                    setHqPendingAttempt(null);
                  }}
                  className={INPUT_CLASS}
                />
              </div>
            </div>

            {hqFormError ? (
              <Alert tone="error" role="alert" title="Không thể lưu tọa độ trụ sở">
                <p>{hqFormError}</p>
              </Alert>
            ) : null}

            {hqConflictMessage ? (
              <Alert tone="warning" role="alert" title="Dữ liệu trụ sở đã thay đổi">
                <p>{hqConflictMessage}</p>
                <div className="mt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setHqConflictMessage(null);
                      setHqFormOpen(false);
                      requestReload();
                    }}
                  >
                    Tải lại phiên bản mới nhất
                  </Button>
                </div>
              </Alert>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={hqSaving}
                onClick={() => {
                  setHqFormOpen(false);
                  setHqFormError(null);
                  setHqConflictMessage(null);
                  setHqPendingAttempt(null);
                }}
              >
                Hủy
              </Button>
              <Button variant="primary" size="sm" type="submit" loading={hqSaving}>
                {hqSaving ? "Đang lưu..." : "Lưu phiên bản tọa độ mới"}
              </Button>
            </div>
          </form>
        ) : null}
      </Card>

      {/* 2. Date-range & Searchable Employee Combobox Filter Toolbar */}
      <form onSubmit={handleFilterSubmit}>
        <FilterToolbar
          actions={
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={isFetching}
                onClick={() => handlePreset("today")}
              >
                Hôm nay
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={isFetching}
                onClick={() => handlePreset("7d")}
              >
                7 ngày qua
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={isFetching}
                onClick={() => handlePreset("30d")}
              >
                30 ngày qua
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={isFetching}
                onClick={() => handlePreset("month")}
              >
                Tháng này
              </Button>
              <Button
                variant="primary"
                size="sm"
                type="submit"
                loading={isFetching}
              >
                Áp dụng bộ lọc
              </Button>
            </>
          }
          summary={
            <>
              <span>
                Khoảng ngày nghiệp vụ đang xem:{" "}
                <strong className="font-mono text-foreground">
                  {activeReport?.filters.from_date ?? appliedFilters.fromDate}
                </strong>{" "}
                đến{" "}
                <strong className="font-mono text-foreground">
                  {activeReport?.filters.to_date ?? appliedFilters.toDate}
                </strong>
                {" · Nhân viên: "}
                <strong className="text-foreground">
                  {appliedEmployeeLabel ?? "Tất cả nhân viên"}
                </strong>
              </span>
              <span>Múi giờ nghiệp vụ: {ATTENDANCE_BUSINESS_TIMEZONE}</span>
            </>
          }
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label
                htmlFor="attendance-from-date"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Từ ngày (giờ nghiệp vụ)
              </label>
              <input
                id="attendance-from-date"
                type="date"
                value={fromInput}
                onChange={(event) => setFromInput(event.target.value)}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label
                htmlFor="attendance-to-date"
                className="mb-1 block text-xs font-medium text-muted"
              >
                Đến ngày (giờ nghiệp vụ)
              </label>
              <input
                id="attendance-to-date"
                type="date"
                value={toInput}
                onChange={(event) => setToInput(event.target.value)}
                className={INPUT_CLASS}
              />
            </div>
            <AttendanceEmployeeCombobox
              id="attendance-employee-filter"
              label="Nhân viên"
              allLabel="Tất cả nhân viên"
              placeholder="Tất cả nhân viên — tìm tên hoặc mã NS..."
              options={comboboxEmployeeOptions}
              value={employeeIdInput}
              disabled={isFetching && !activeReport}
              onChange={setEmployeeIdInput}
            />
          </div>
        </FilterToolbar>
      </form>

      {filterError ? (
        <Alert tone="error" role="alert" title="Bộ lọc chưa hợp lệ">
          <p>{filterError}</p>
        </Alert>
      ) : null}

      {/* 3. Overview KPI Summary */}
      <section aria-label="Tổng quan chấm công" className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">Tổng quan trong kỳ lọc</h2>
        {activeReport ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Tổng lượt chấm công
              </p>
              <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-foreground">
                {VI_INTEGER.format(activeReport.overview.total_checkins)}
              </p>
              <p className="mt-1 text-xs text-muted">
                Trên {VI_INTEGER.format(activeReport.overview.unique_employees)} nhân viên có lượt chấm công
              </p>
            </Card>

            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Xác minh thời gian
              </p>
              <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-foreground">
                {VI_INTEGER.format(activeReport.overview.verified_time_count)}
                <span className="ml-1.5 text-sm font-normal text-muted">
                  / {VI_INTEGER.format(activeReport.overview.total_checkins)} đã xác minh
                </span>
              </p>
              <p className="mt-1 text-xs text-muted">
                Chưa xác minh (đồng hồ thiết bị):{" "}
                <strong className="font-mono text-foreground">
                  {VI_INTEGER.format(activeReport.overview.unverified_time_count)}
                </strong>
              </p>
            </Card>

            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Độ phủ tính khoảng cách
              </p>
              <p className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-foreground">
                {VI_INTEGER.format(activeReport.overview.distance_computed_count)}
                <span className="ml-1.5 text-sm font-normal text-muted">
                  tính được
                </span>
              </p>
              <p className="mt-1 text-xs text-muted">
                Không tính được:{" "}
                <strong className="font-mono text-foreground">
                  {VI_INTEGER.format(activeReport.overview.distance_unavailable_count)}
                </strong>
              </p>
            </Card>

            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Khoảng cách trung bình tới trụ sở
              </p>
              <p className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground">
                {formatDistanceMeters(activeReport.overview.avg_distance_meters)}
              </p>
              <p className="mt-1 text-xs text-muted">
                Chỉ tính trên các lượt có tọa độ hợp lệ và đã có trụ sở hiệu lực
              </p>
            </Card>

            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Khoảng cách xa nhất tới trụ sở
              </p>
              <p className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground">
                {formatDistanceMeters(activeReport.overview.max_distance_meters)}
              </p>
              <p className="mt-1 text-xs text-muted">
                Giá trị lớn nhất trong các lượt tính được khoảng cách
              </p>
            </Card>

            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                Phân trang máy chủ
              </p>
              <p className="mt-1.5 font-mono text-xl font-semibold tabular-nums text-foreground">
                Trang {activeReport.pagination.page} / {activeReport.pagination.total_pages}
              </p>
              <p className="mt-1 text-xs text-muted">
                Tối đa {activeReport.pagination.page_size} dòng mỗi trang từ máy chủ
              </p>
            </Card>
          </div>
        ) : (
          <Card>
            <p className="text-sm text-muted">Đang tải số liệu tổng quan...</p>
          </Card>
        )}
      </section>

      {/* 4. Server-Paginated Detailed Check-in Table */}
      <Card>
        <CardHeader
          title="Danh sách chi tiết lượt chấm công"
          description="Sắp xếp từ mới nhất đến cũ nhất theo thời điểm chấm công; chỉ tải trang hiện tại từ máy chủ."
        />

        {!activeReport ? (
          <p className="py-8 text-center text-sm text-muted">
            Đang tải danh sách lượt chấm công...
          </p>
        ) : activeReport.items.length === 0 ? (
          <EmptyState
            title="Không có lượt chấm công trong khoảng lọc"
            description="Thử mở rộng khoảng ngày nghiệp vụ hoặc chọn lại Tất cả nhân viên."
          />
        ) : (
          <>
            <DataTableContainer>
              <table className={DATA_TABLE_CLASS}>
                <thead className={DATA_TABLE_HEAD_CLASS}>
                  <tr>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Nhân viên
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Ngày &amp; giờ chấm công
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Xác minh thời gian
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Tọa độ GPS &amp; ghi chú
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Khoảng cách tới trụ sở
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Thao tác
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {activeReport.items.map((item) => (
                    <tr key={item.checkin_id} className={DATA_TABLE_ROW_CLASS}>
                      <td data-label="Nhân viên" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5">
                          <p className="font-medium text-foreground">
                            {item.employee_display_name}
                          </p>
                          {item.personnel_code ? (
                            <p className="font-mono text-xs text-muted">
                              Mã NS: {item.personnel_code}
                            </p>
                          ) : null}
                        </div>
                      </td>
                      <td
                        data-label="Ngày & giờ chấm công"
                        className={DATA_TABLE_TD_CLASS}
                      >
                        <div className="space-y-0.5">
                          <p className="font-mono text-sm font-medium tabular-nums text-foreground">
                            {item.captured_at_local}
                          </p>
                          <p className="text-xs text-muted">
                            Ngày NV:{" "}
                            <span className="font-mono">{item.business_date}</span> · Lần #
                            {item.sequence_in_day}
                          </p>
                        </div>
                      </td>
                      <td
                        data-label="Xác minh thời gian"
                        className={DATA_TABLE_TD_CLASS}
                      >
                        <TimeVerificationCell item={item} />
                      </td>
                      <td
                        data-label="Tọa độ GPS & ghi chú"
                        className={DATA_TABLE_TD_CLASS}
                      >
                        <GpsDetailCell item={item} />
                      </td>
                      <td
                        data-label="Khoảng cách tới trụ sở"
                        className={DATA_TABLE_TD_CLASS}
                      >
                        <DistanceCell item={item} />
                      </td>
                      <td data-label="Thao tác" className={DATA_TABLE_TD_CLASS}>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          aria-label={`Xem chi tiết lượt chấm công của ${item.employee_display_name} lúc ${item.captured_at_local}`}
                          onClick={() => openDetailDialog(item)}
                        >
                          Chi tiết
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTableContainer>

            <OffsetPager
              page={activeReport.pagination.page}
              pageCount={activeReport.pagination.total_pages}
              total={activeReport.pagination.total_rows}
              disabled={isFetching}
              ariaLabel="Phân trang danh sách lượt chấm công"
              onPageChange={(nextPage) => {
                setLoadState({ kind: "loading" });
                setAppliedFilters((current) => ({ ...current, page: nextPage }));
              }}
            />
          </>
        )}
      </Card>

      {/* 5. Check-in Detail Dialog (loads private photo lazily on open) */}
      <FormDialog
        open={detailItem !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closeDetailDialog();
          }
        }}
        title={
          detailItem
            ? `Chi tiết lượt chấm công — ${detailItem.employee_display_name}`
            : "Chi tiết lượt chấm công"
        }
        description={
          detailItem
            ? `Ghi nhận lúc ${detailItem.captured_at_local} (${ATTENDANCE_BUSINESS_TIMEZONE})`
            : undefined
        }
        closeAriaLabel="Đóng chi tiết lượt chấm công"
        contentClassName="sm:w-[min(44rem,calc(100vw-2rem))]"
        dataTestId="attendance-checkin-detail-dialog"
      >
        {detailItem ? (
          <AttendanceCheckinDetailBody
            item={detailItem}
            currentHq={activeReport?.current_hq ?? null}
            photoState={detailPhotoState}
            onRetryPhoto={() => fetchDetailPhoto(detailItem.checkin_id)}
            onPhotoDecodeError={handlePhotoDecodeError}
            onClose={closeDetailDialog}
          />
        ) : null}
      </FormDialog>
    </div>
  );
}
