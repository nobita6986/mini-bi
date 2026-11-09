"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { CursorLoadMore } from "@/components/ui/cursor-load-more";
import {
  DATA_TABLE_CLASS,
  DATA_TABLE_HEAD_CLASS,
  DATA_TABLE_ROW_CLASS,
  DATA_TABLE_TD_CLASS,
  DATA_TABLE_TH_CLASS,
  DataTableContainer,
} from "@/components/ui/data-table";
import { FormDialog } from "@/components/ui/form-dialog";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  OFFBOARDING_HIDE_REASON_MAX_LENGTH,
  newOffboardingHideIntentKey,
  parseOffboardingHideResult,
  parseOffboardingReportList,
  type OffboardingReportItem,
  type OffboardingReportList,
} from "@/lib/workforce/offboarding-report-contract";

type View = "loading" | "ready" | "denied" | "error";

type HideDialogState = {
  item: OffboardingReportItem;
  snapshot_entry_id: string;
  snapshot_status_event_id: string;
};

const PAGE_SIZE = 25;
const REASON_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function extractErrorCode(body: unknown): string | null {
  return isRecord(body) && typeof body.code === "string" ? body.code : null;
}

export function OffboardingReportPanel() {
  const [view, setView] = useState<View>("loading");
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<OffboardingReportList | null>(null);
  const [items, setItems] = useState<OffboardingReportItem[]>([]);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);

  const [hideDialog, setHideDialog] = useState<HideDialogState | null>(null);
  const [hideReason, setHideReason] = useState("");
  const [hideError, setHideError] = useState<string | null>(null);
  const [hideSubmitting, setHideSubmitting] = useState(false);
  const [hideIntentKey, setHideIntentKey] = useState<string>("");

  const generation = useRef(0);

  async function fetchPage(nextPage: number, append: boolean) {
    const gen = ++generation.current;
    try {
      const response = await fetch(
        `/api/workforce/offboarding?page=${nextPage}&page_size=${PAGE_SIZE}`,
        {
          cache: "no-store",
          headers: { accept: "application/json" },
        },
      );
      if (response.status === 403) {
        if (gen === generation.current) {
          setView("denied");
          setError(null);
        }
        return;
      }
      const body = await response.json().catch(() => null);
      const parsed =
        response.ok && isRecord(body) && body.ok === true
          ? parseOffboardingReportList(body.data)
          : null;
      if (gen !== generation.current) return;
      if (!parsed) {
        setView("error");
        setError("Không tải được báo cáo người lao động nghỉ việc.");
        return;
      }
      setList(parsed);
      setItems((current) => (append ? [...current, ...parsed.items] : parsed.items));
      setPage(nextPage);
      setView("ready");
      setError(null);
    } catch {
      if (gen !== generation.current) return;
      setView("error");
      setError("Không tải được báo cáo người lao động nghỉ việc.");
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchPage(1, false);
    }, 0);
    return () => {
      clearTimeout(timer);
      generation.current += 1;
    };
  }, []);

  async function loadMore() {
    const next = page + 1;
    setLoadingMore(true);
    await fetchPage(next, true);
    setLoadingMore(false);
  }

  function openHideDialog(item: OffboardingReportItem) {
    if (!item.snapshot_entry_id || !item.snapshot_status_event_id) {
      return;
    }
    setHideDialog({
      item,
      snapshot_entry_id: item.snapshot_entry_id,
      snapshot_status_event_id: item.snapshot_status_event_id,
    });
    setHideReason("");
    setHideError(null);
    setHideIntentKey(newOffboardingHideIntentKey());
  }

  function closeHideDialog() {
    if (hideSubmitting) return;
    setHideDialog(null);
    setHideReason("");
    setHideError(null);
    setHideIntentKey("");
  }

  function handleReasonChange(nextValue: string) {
    setHideReason(nextValue);
    setHideError(null);
    setHideIntentKey(newOffboardingHideIntentKey());
  }

  async function submitHide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hideDialog || hideSubmitting) return;

    const trimmedReason = hideReason.trim();
    if (trimmedReason.length === 0) {
      setHideError("Vui lòng nhập lý do ẩn người lao động khỏi báo cáo.");
      return;
    }
    if (trimmedReason.length > OFFBOARDING_HIDE_REASON_MAX_LENGTH) {
      setHideError(
        `Lý do ẩn tối đa ${OFFBOARDING_HIDE_REASON_MAX_LENGTH} ký tự sau khi cắt khoảng trắng.`,
      );
      return;
    }
    if (REASON_CONTROL_CHARS.test(trimmedReason)) {
      setHideError("Lý do ẩn chứa ký tự điều khiển không hợp lệ.");
      return;
    }

    const intentKey = hideIntentKey || newOffboardingHideIntentKey();
    if (!hideIntentKey) {
      setHideIntentKey(intentKey);
    }

    setHideSubmitting(true);
    setHideError(null);

    try {
      const response = await fetch("/api/workforce/offboarding/hide", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": intentKey,
          Accept: "application/json",
        },
        body: JSON.stringify({
          snapshot_entry_id: hideDialog.snapshot_entry_id,
          snapshot_status_event_id: hideDialog.snapshot_status_event_id,
          reason: trimmedReason,
          idempotency_key: intentKey,
        }),
      });

      const body = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && body.ok === true && parseOffboardingHideResult(body.data)) {
        setHideSubmitting(false);
        setHideDialog(null);
        setHideReason("");
        setHideError(null);
        setHideIntentKey("");
        await fetchPage(1, false);
        return;
      }

      setHideSubmitting(false);
      const code = extractErrorCode(body);
      if (response.status === 409) {
        if (code === "WORKFORCE_OFFBOARDING_SNAPSHOT_STALE") {
          setHideError(
            "Trạng thái của người lao động vừa thay đổi hoặc đã được ẩn trước đó. Đang tải lại danh sách mới nhất…",
          );
          await fetchPage(1, false);
          return;
        }
        setHideIntentKey(newOffboardingHideIntentKey());
        setHideError("Khóa chống trùng lặp bị xung đột. Vui lòng xác nhận lại.");
        return;
      }
      if (response.status === 403) {
        setHideError("Bạn không có quyền ẩn người lao động khỏi báo cáo này.");
        return;
      }
      if (response.status === 401) {
        setHideError("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
        return;
      }
      if (response.status === 400) {
        setHideError("Thông tin gửi lên không hợp lệ. Vui lòng kiểm tra lại lý do ẩn.");
        return;
      }
      setHideError(
        "Dịch vụ tạm thời gián đoạn. Bạn có thể bấm Xác nhận ẩn để thử lại an toàn.",
      );
    } catch {
      setHideSubmitting(false);
      setHideError(
        "Mất kết nối tới máy chủ. Bạn có thể bấm Xác nhận ẩn để thử lại an toàn với cùng dữ liệu.",
      );
    }
  }

  const canPhone = list?.scope === "all";
  const canHide = list?.can_hide === true;
  const trimmedReasonLength = hideReason.trim().length;

  return (
    <div className="space-y-4">
      {view === "loading" ? (
        <p role="status" className="py-8 text-center text-sm text-muted">
          Đang tải báo cáo…
        </p>
      ) : null}
      {view === "denied" ? (
        <StatusBanner tone="warning">
          Bạn không có quyền xem báo cáo người lao động nghỉ việc.
        </StatusBanner>
      ) : null}
      {view === "error" ? (
        <StatusBanner tone="error">{error ?? "Không tải được báo cáo."}</StatusBanner>
      ) : null}
      {view === "ready" && items.length === 0 ? (
        <StatusBanner>
          Chưa có người lao động nghỉ việc đủ 3 ngày trong phạm vi hiện tại.
        </StatusBanner>
      ) : null}

      {view === "ready" && items.length > 0 ? (
        <DataTableContainer
          scrollClassName="overflow-x-auto"
          footer={
            list?.can_export ? (
              <div className="flex justify-end">
                <a href="/api/workforce/offboarding/export">
                  <Button variant="secondary">Xuất Excel</Button>
                </a>
              </div>
            ) : null
          }
        >
          <table className={DATA_TABLE_CLASS + " min-w-[820px]"}>
            <thead className={DATA_TABLE_HEAD_CLASS}>
              <tr>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Họ tên
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Mã NLĐ
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Dự án / công việc cuối
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Người tuyển cuối
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Ngày nghỉ việc
                </th>
                <th scope="col" className={DATA_TABLE_TH_CLASS}>
                  Số ngày đã nghỉ
                </th>
                {canPhone ? (
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Số điện thoại
                  </th>
                ) : null}
                {canHide ? (
                  <th scope="col" className={DATA_TABLE_TH_CLASS + " text-right"}>
                    Thao tác
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.employee_code} className={DATA_TABLE_ROW_CLASS}>
                  <td className={DATA_TABLE_TD_CLASS} data-card-header="true">
                    {item.display_name}
                  </td>
                  <td
                    className={DATA_TABLE_TD_CLASS + " font-mono tabular-nums"}
                    data-label="Mã NLĐ"
                  >
                    {item.employee_code}
                  </td>
                  <td className={DATA_TABLE_TD_CLASS} data-label="Dự án cuối">
                    {item.project_display}
                  </td>
                  <td className={DATA_TABLE_TD_CLASS} data-label="Người tuyển cuối">
                    {item.recruiter_display}
                  </td>
                  <td
                    className={DATA_TABLE_TD_CLASS + " whitespace-nowrap"}
                    data-label="Ngày nghỉ"
                  >
                    {item.off_effective_date}
                  </td>
                  <td
                    className={DATA_TABLE_TD_CLASS + " font-mono tabular-nums"}
                    data-label="Số ngày đã nghỉ"
                  >
                    {item.days_since_off}
                  </td>
                  {canPhone ? (
                    <td className={DATA_TABLE_TD_CLASS} data-label="Số điện thoại">
                      {item.phone && item.phone.trim().length > 0 ? item.phone : "—"}
                    </td>
                  ) : null}
                  {canHide ? (
                    <td
                      className={DATA_TABLE_TD_CLASS + " text-right"}
                      data-label="Thao tác"
                      data-card-actions="true"
                    >
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={!item.snapshot_entry_id || !item.snapshot_status_event_id}
                        onClick={() => openHideDialog(item)}
                      >
                        Ẩn NLĐ
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </DataTableContainer>
      ) : null}

      {view === "ready" && list?.has_more ? (
        <div className="flex justify-center">
          <CursorLoadMore hasMore loading={loadingMore} onLoadMore={() => void loadMore()} />
        </div>
      ) : null}

      <FormDialog
        open={hideDialog !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeHideDialog();
        }}
        title="Ẩn người lao động khỏi báo cáo nghỉ việc"
        description="Thao tác chỉ ẩn trạng thái nghỉ việc hiện tại của người lao động (ví dụ đã về quê, quá tuổi hoặc chưa có kế hoạch bố trí việc). Nếu sau này phát sinh đợt tuyển dụng hoặc biến động trạng thái mới đủ điều kiện, người lao động sẽ tự động xuất hiện lại."
        descriptionId="offboarding-hide-dialog-desc"
        closeDisabled={hideSubmitting}
        dataTestId="offboarding-hide-dialog"
      >
        {hideDialog ? (
          <form onSubmit={(event) => void submitHide(event)} className="space-y-4">
            <div className="rounded-xl border border-border bg-muted/10 p-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-foreground">
                  {hideDialog.item.display_name}
                </span>
                <span className="font-mono text-xs text-muted">
                  Mã NLĐ: {hideDialog.item.employee_code}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted">
                Dự án cuối: {hideDialog.item.project_display} · Nghỉ từ{" "}
                {hideDialog.item.off_effective_date} ({hideDialog.item.days_since_off} ngày)
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="offboarding-hide-reason"
                  className="text-sm font-medium text-foreground"
                >
                  Lý do ẩn <span className="text-rose-600 dark:text-rose-400">*</span>
                </label>
                <span className="font-mono text-xs text-muted tabular-nums">
                  {trimmedReasonLength}/{OFFBOARDING_HIDE_REASON_MAX_LENGTH}
                </span>
              </div>
              <textarea
                id="offboarding-hide-reason"
                name="reason"
                rows={3}
                maxLength={OFFBOARDING_HIDE_REASON_MAX_LENGTH}
                required
                disabled={hideSubmitting}
                value={hideReason}
                onChange={(event) => handleReasonChange(event.target.value)}
                placeholder="Ví dụ: Đã về quê, quá tuổi bố trí dự án hiện tại…"
                className="min-h-24 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>

            {hideError ? <StatusBanner tone="error">{hideError}</StatusBanner> : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="secondary"
                disabled={hideSubmitting}
                onClick={closeHideDialog}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={hideSubmitting}
                disabled={hideSubmitting || trimmedReasonLength === 0}
              >
                {hideSubmitting ? "Đang lưu…" : "Xác nhận ẩn"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </div>
  );
}
