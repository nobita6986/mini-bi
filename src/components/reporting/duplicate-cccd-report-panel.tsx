"use client";

import { useEffect, useRef, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import {
  buildDuplicateCccdReportQuery,
  clampDuplicateCccdReportPage,
  duplicateCccdSelfWithdrawErrorMessage,
  employmentStatusLabel,
  maskedCccd,
  nextDuplicateCccdReportPage,
  projectDuplicateCccdReportResponse,
  DUPLICATE_CCCD_REPORT_DEFAULT_PAGE_SIZE,
  DUPLICATE_CCCD_REPORT_MAX_PAGE,
  DUPLICATE_CCCD_REPORT_PAGE_SIZE_OPTIONS as PAGE_SIZE_OPTIONS,
} from "@/lib/direct-entry/duplicate-cccd-report-contract";
import type {
  DuplicateCccdReportEpisode,
  DuplicateCccdReportGroup,
  DuplicateCccdReportPage,
} from "@/lib/direct-entry/duplicate-cccd-report-contract";
import { privilegedEditErrorMessage } from "@/lib/direct-entry/worker-operations-model";
import { todayDateIso } from "@/lib/format";

type ReportState =
  | { kind: "loading" }
  | { kind: "loaded"; page: DuplicateCccdReportPage }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "error" };

const button = "inline-flex min-h-10 items-center justify-center rounded-md border border-border " +
  "bg-surface px-3 text-sm font-medium text-foreground transition-[background-color,border-color,color,transform] " +
  "duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] " +
  "hover:enabled:bg-surface-hover active:enabled:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";

const primaryButton = "inline-flex min-h-10 items-center justify-center rounded-md border border-transparent " +
  "bg-primary px-4 text-sm font-medium text-primary-foreground transition-[background-color,opacity,transform] " +
  "duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] " +
  "hover:enabled:opacity-90 active:enabled:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";

const warningActionButton = "inline-flex min-h-9 items-center justify-center rounded-md border border-status-warning-border " +
  "bg-status-warning-bg px-2.5 py-1 text-xs font-medium text-status-warning-text transition-[background-color,border-color,transform] " +
  "duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] " +
  "hover:enabled:opacity-90 active:enabled:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";

function makeIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `dup-cccd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body?.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

function StatusBadge({ status }: { status: DuplicateCccdReportEpisode["latest_status"] }) {
  const active = status !== "OFF";
  return (
    <span className={active
      ? "inline-flex whitespace-nowrap rounded-full border border-status-success-border bg-status-success-bg px-2.5 py-1 text-xs font-medium text-status-success-text"
      : "inline-flex whitespace-nowrap rounded-full border border-border bg-surface-muted px-2.5 py-1 text-xs font-medium text-muted"}>
      {employmentStatusLabel(status)}
    </span>
  );
}

function StatusCell({
  episode,
  onMarkOff,
}: {
  episode: DuplicateCccdReportEpisode;
  onMarkOff: (target: DuplicateCccdReportEpisode) => void;
}) {
  if (!episode.can_mark_off) {
    return <StatusBadge status={episode.latest_status} />;
  }
  const workerLabel = episode.display_name ?? episode.employee_code ?? "hồ sơ";
  return (
    <button
      type="button"
      onClick={() => onMarkOff(episode)}
      title="Đổi trạng thái sang Đã nghỉ"
      aria-label={`Đổi trạng thái sang Đã nghỉ cho ${workerLabel}`}
      className="inline-flex min-h-8 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-status-success-border bg-status-success-bg px-2.5 py-1 text-xs font-medium text-status-success-text underline decoration-dotted underline-offset-2 transition-[opacity,transform] duration-[var(--ui-motion-hover,160ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] hover:opacity-85 active:scale-[0.99] motion-reduce:transition-none motion-reduce:transform-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <span>{employmentStatusLabel(episode.latest_status)}</span>
    </button>
  );
}

function GroupCard({
  group,
  onMarkOff,
  onSelfWithdraw,
}: {
  group: DuplicateCccdReportGroup;
  onMarkOff: (target: DuplicateCccdReportEpisode) => void;
  onSelfWithdraw: (target: DuplicateCccdReportEpisode) => void;
}) {
  const masked = maskedCccd(group.cccd_last4, group.cccd_length);
  return (
    <Card>
      <CardHeader
        title={"CCCD " + masked}
        description={
          group.cccd_length + " chữ số · " + group.profile_count + " hồ sơ · " +
          group.project_count + " dự án · " + group.active_profile_count + " đang hoạt động"
        }
      />
      <p className="mb-3 text-sm text-muted">
        Vào làm sớm nhất: <span className="font-mono tabular-nums whitespace-nowrap">{group.first_work_date ?? "—"}</span> · gần nhất: <span className="font-mono tabular-nums whitespace-nowrap">{group.latest_first_work_date ?? "—"}</span>
      </p>
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="r22-report-table w-full min-w-[640px] text-left text-sm">
          <caption className="sr-only">
            Các hồ sơ dùng chung số CCCD {masked}
          </caption>
          <thead className="bg-surface-muted text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-3 py-3">Họ tên</th>
              <th scope="col" className="px-3 py-3">Mã nhân viên</th>
              <th scope="col" className="px-3 py-3">Dự án</th>
              <th scope="col" className="px-3 py-3">Ngày vào làm</th>
              <th scope="col" className="px-3 py-3">Trạng thái</th>
              <th scope="col" className="px-3 py-3">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {group.episodes.map((episode) => (
              <tr key={episode.entry_id} className="transition-colors duration-[var(--ui-motion-hover,160ms)] motion-reduce:transition-none hover:bg-surface-hover">
                <td className="px-3 py-3 font-medium">{episode.display_name ?? "—"}</td>
                <td className="px-3 py-3 font-mono tabular-nums whitespace-nowrap text-xs">{episode.employee_code ?? "—"}</td>
                <td className="px-3 py-3">{episode.project_display ?? "—"}</td>
                <td className="px-3 py-3 font-mono tabular-nums whitespace-nowrap text-xs">{episode.first_work_date ?? "—"}</td>
                <td className="px-3 py-3">
                  <StatusCell episode={episode} onMarkOff={onMarkOff} />
                </td>
                <td className="px-3 py-3">
                  {episode.can_self_withdraw ? (
                    <button
                      type="button"
                      onClick={() => onSelfWithdraw(episode)}
                      className={warningActionButton}
                    >
                      Rút trùng
                    </button>
                  ) : (
                    <span className="text-xs text-muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * Panel bao cao CCCD trung trong Dashboard shell (tab "Bao cao CCCD trung").
 * Ke thua Card, spacing, typography va responsive tu Dashboard; doc lap voi URL filter cua
 * Dashboard. Cac co hanh dong tren tung dong ho so do server RPC quyet dinh.
 */
export function DuplicateCccdReportPanel() {
  const [state, setState] = useState<ReportState>({ kind: "loading" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DUPLICATE_CCCD_REPORT_DEFAULT_PAGE_SIZE);
  const [managedOnly, setManagedOnly] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const userActionRef = useRef(false);
  const notify = useNotify();

  const [markOffTarget, setMarkOffTarget] = useState<DuplicateCccdReportEpisode | null>(null);
  const [effectiveDate, setEffectiveDate] = useState(() => todayDateIso());
  const [leaveReason, setLeaveReason] = useState("");
  const [markOffActionReason, setMarkOffActionReason] = useState("");
  const [markOffError, setMarkOffError] = useState<string | null>(null);
  const [markOffSubmitting, setMarkOffSubmitting] = useState(false);
  const markOffIdempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const [withdrawTarget, setWithdrawTarget] = useState<DuplicateCccdReportEpisode | null>(null);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const [withdrawSubmitting, setWithdrawSubmitting] = useState(false);
  const withdrawIdempotencyRef = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const isUserInitiated = userActionRef.current;
    void (async () => {
      const failWith = (nextState: Exclude<ReportState, { kind: "loading" | "loaded" }>) => {
        setState(nextState);
        if (isUserInitiated) {
          userActionRef.current = false;
          const title = nextState.kind === "denied"
            ? "Bạn không có quyền xem báo cáo CCCD trùng."
            : nextState.kind === "unavailable"
              ? "Báo cáo CCCD trùng hiện không khả dụng. Hãy thử tải lại."
              : "Không tải được báo cáo CCCD trùng. Hãy thử tải lại.";
          notify.error({ title });
        }
      };

      const query = buildDuplicateCccdReportQuery({ page, page_size: pageSize, managed_only: managedOnly });
      if (!query) {
        failWith({ kind: "error" });
        return;
      }
      let response: Response;
      try {
        response = await fetch(`/api/direct-entry/duplicate-cccd-report?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        failWith({ kind: "unavailable" });
        return;
      }
      if (response.status === 401 || response.status === 403) {
        failWith({ kind: "denied" });
        return;
      }
      if (response.status !== 200) {
        failWith(response.status === 404 || response.status >= 500
          ? { kind: "unavailable" }
          : { kind: "error" });
        return;
      }
      try {
        const loaded = projectDuplicateCccdReportResponse(await response.json(), {
          page,
          page_size: pageSize,
          managed_only: managedOnly,
        });
        if (!loaded) {
          failWith({ kind: "error" });
          return;
        }
        const clampedPage = clampDuplicateCccdReportPage(page, loaded.total_groups, loaded.page_size);
        if (clampedPage !== page) {
          setPage(clampedPage);
          return;
        }
        userActionRef.current = false;
        setState({ kind: "loaded", page: loaded });
      } catch {
        failWith({ kind: "error" });
      }
    })();
    return () => controller.abort();
  }, [managedOnly, notify, page, pageSize, reloadToken]);

  const reload = () => {
    userActionRef.current = true;
    setState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  const reloadAfterMutation = () => {
    userActionRef.current = false;
    setState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  const openMarkOffDialog = (episode: DuplicateCccdReportEpisode) => {
    const today = todayDateIso();
    const initialDate = episode.first_work_date && episode.first_work_date > today
      ? episode.first_work_date
      : today;
    setMarkOffTarget(episode);
    setEffectiveDate(initialDate);
    setLeaveReason("");
    setMarkOffActionReason("");
    setMarkOffError(null);
    markOffIdempotencyRef.current = null;
  };

  const openSelfWithdrawDialog = (episode: DuplicateCccdReportEpisode) => {
    setWithdrawTarget(episode);
    setWithdrawReason("");
    setWithdrawError(null);
    withdrawIdempotencyRef.current = null;
  };

  const submitMarkOff = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!markOffTarget || markOffSubmitting) return;

    const trimmedLeaveReason = leaveReason.trim();
    if (trimmedLeaveReason.length === 0 || leaveReason.length > 4000) {
      setMarkOffError("Vui lòng nhập lý do nghỉ việc (tối đa 4.000 ký tự).");
      return;
    }
    const today = todayDateIso();
    if (!effectiveDate || effectiveDate > today) {
      setMarkOffError("Ngày nghỉ việc không hợp lệ hoặc vượt quá ngày hiện tại.");
      return;
    }
    if (markOffTarget.first_work_date && effectiveDate < markOffTarget.first_work_date) {
      setMarkOffError(`Ngày nghỉ việc không được trước ngày vào làm (${markOffTarget.first_work_date}).`);
      return;
    }
    if (markOffActionReason.length > 1000) {
      setMarkOffError("Ghi chú kiểm toán không được vượt quá 1.000 ký tự.");
      return;
    }

    const normalizedReason = markOffActionReason.trim() || null;
    const fingerprint = JSON.stringify([
      markOffTarget.entry_id,
      markOffTarget.entry_version,
      effectiveDate,
      trimmedLeaveReason,
      normalizedReason,
    ]);
    if (markOffIdempotencyRef.current?.fingerprint !== fingerprint) {
      markOffIdempotencyRef.current = { fingerprint, key: makeIdempotencyKey() };
    }
    const idempotencyKey = markOffIdempotencyRef.current.key;

    setMarkOffSubmitting(true);
    setMarkOffError(null);
    try {
      const response = await fetch(
        `/api/direct-entry/entries/${encodeURIComponent(markOffTarget.entry_id)}/privileged-edit`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            expected_entry_version: markOffTarget.entry_version,
            patch: {
              employment_status: {
                status: "OFF",
                effective_date: effectiveDate,
                leave_reason: trimmedLeaveReason,
              },
            },
            reason: normalizedReason,
          }),
        },
      );
      if (response.status === 200) {
        setMarkOffTarget(null);
        markOffIdempotencyRef.current = null;
        notify.success({ title: "Đã chuyển trạng thái hồ sơ sang Đã nghỉ." });
        reloadAfterMutation();
        return;
      }
      const code = await readErrorCode(response);
      const message = privilegedEditErrorMessage(response.status, code);
      setMarkOffError(message);
      notify.error({ title: message });
    } catch {
      const message = privilegedEditErrorMessage(500, null);
      setMarkOffError(message);
      notify.error({ title: message });
    } finally {
      setMarkOffSubmitting(false);
    }
  };

  const submitSelfWithdraw = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!withdrawTarget || withdrawSubmitting) return;

    if (withdrawReason.length > 1000) {
      setWithdrawError("Ghi chú rút trùng không được vượt quá 1.000 ký tự.");
      return;
    }
    const normalizedReason = withdrawReason.trim() || null;
    const fingerprint = JSON.stringify([
      withdrawTarget.entry_id,
      withdrawTarget.entry_version,
      normalizedReason,
    ]);
    if (withdrawIdempotencyRef.current?.fingerprint !== fingerprint) {
      withdrawIdempotencyRef.current = { fingerprint, key: makeIdempotencyKey() };
    }
    const idempotencyKey = withdrawIdempotencyRef.current.key;

    setWithdrawSubmitting(true);
    setWithdrawError(null);
    try {
      const response = await fetch("/api/direct-entry/duplicate-cccd-report/self-withdraw", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          entry_id: withdrawTarget.entry_id,
          expected_entry_version: withdrawTarget.entry_version,
          idempotency_key: idempotencyKey,
          reason: normalizedReason,
        }),
      });
      if (response.status === 200) {
        setWithdrawTarget(null);
        withdrawIdempotencyRef.current = null;
        notify.success({ title: "Đã rút trùng hồ sơ và cập nhật lại báo cáo." });
        reloadAfterMutation();
        return;
      }
      const code = await readErrorCode(response);
      const message = duplicateCccdSelfWithdrawErrorMessage(response.status, code);
      setWithdrawError(message);
      notify.error({ title: message });
    } catch {
      const message = duplicateCccdSelfWithdrawErrorMessage(500, null);
      setWithdrawError(message);
      notify.error({ title: message });
    } finally {
      setWithdrawSubmitting(false);
    }
  };

  const loaded = state.kind === "loaded" ? state.page : null;
  const pageCount = loaded
    ? Math.min(DUPLICATE_CCCD_REPORT_MAX_PAGE, Math.max(1,
        Math.ceil(loaded.total_groups / Math.max(1, loaded.page_size))))
    : 1;
  const nextPage = loaded ? nextDuplicateCccdReportPage(loaded.page, loaded.has_more) : null;
  const previousPage = loaded && loaded.page > 1 ? loaded.page - 1 : null;
  const today = todayDateIso();

  return (
    <div className="space-y-4">
      <Alert tone="info" title="Thao tác có kiểm soát">
        <p>
          Số CCCD được che, chỉ hiển thị 4 chữ số cuối. Chỉ những dòng bạn được cấp quyền mới hiện
          thao tác: người đã nhập hồ sơ có thể Rút trùng (giữ nguyên lịch sử kiểm toán và điều chỉnh
          số tuyển mới), người phụ trách phạm vi có thể đổi Đang làm sang Đã nghỉ kèm lý do nghỉ việc
          bắt buộc.
        </p>
      </Alert>

      <Card className="p-4">
        <CardHeader
          title="Hồ sơ có CCCD trùng"
          description="Danh sách các hồ sơ đang làm việc dùng chung một số CCCD. Không gộp và không xóa hồ sơ gốc — mọi thao tác đều lưu lịch sử kiểm toán."
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Số dòng mỗi trang
              <select
                value={pageSize}
                onChange={(event) => {
                  userActionRef.current = true;
                  setPageSize(Number(event.target.value));
                  setPage(1);
                  setState({ kind: "loading" });
                }}
                className="min-h-10 rounded-md border border-border bg-surface px-3 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
            </label>
            <label className="inline-flex min-h-10 cursor-pointer items-center gap-2.5 rounded-md border border-border bg-surface px-3 text-sm font-medium text-foreground transition-colors duration-[var(--ui-motion-hover,160ms)] motion-reduce:transition-none hover:bg-surface-hover">
              <input
                type="checkbox"
                checked={managedOnly}
                onChange={(event) => {
                  userActionRef.current = true;
                  setManagedOnly(event.target.checked);
                  setPage(1);
                  setState({ kind: "loading" });
                }}
                className="h-4 w-4 rounded border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
              <span>Chỉ dự án tôi quản lý</span>
            </label>
          </div>
          <button type="button" className={button} onClick={reload}>Tải lại</button>
        </div>
      </Card>

      {state.kind === "loading" ? (
        <p role="status" className="py-8 text-center text-sm text-muted">Đang tải báo cáo CCCD trùng…</p>
      ) : null}

      {state.kind === "denied" ? (
        <ErrorState
          title="Bạn không có quyền xem báo cáo CCCD trùng"
          detail="Tài khoản hiện tại không đủ điều kiện truy cập báo cáo này."
        />
      ) : null}

      {state.kind === "unavailable" ? (
        <div className="space-y-3">
          <ErrorState title="Báo cáo CCCD trùng hiện không khả dụng" />
          <button type="button" className={button} onClick={reload}>Thử tải lại</button>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="space-y-3">
          <ErrorState
            title="Không tải được báo cáo CCCD trùng"
            detail="Phản hồi không hợp lệ. Hãy thử tải lại."
          />
          <button type="button" className={button} onClick={reload}>Thử tải lại</button>
        </div>
      ) : null}

      {loaded ? (
        loaded.groups.length === 0 ? (
          <EmptyState
            title="Không có hồ sơ trùng CCCD"
            description={managedOnly
              ? "Hiện không có nhóm CCCD trùng nào thuộc các dự án bạn đang quản lý."
              : "Hiện chưa có hồ sơ nào dùng chung số CCCD trong phạm vi báo cáo."}
          />
        ) : (
          <>
            <p role="status" className="text-sm text-muted">
              {loaded.total_groups} nhóm CCCD trùng · {loaded.total_entries} hồ sơ
            </p>
            <div className="space-y-4">
              {loaded.groups.map((group) => (
                <GroupCard
                  key={`${group.cccd_last4}-${group.cccd_length}-${group.episodes[0]?.entry_id ?? "group"}`}
                  group={group}
                  onMarkOff={openMarkOffDialog}
                  onSelfWithdraw={openSelfWithdrawDialog}
                />
              ))}
            </div>
            <nav aria-label="Phân trang báo cáo CCCD trùng"
              className="flex flex-col gap-3 border-t border-border pt-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <p aria-live="polite">Trang {loaded.page} / {pageCount}</p>
              <div className="flex items-center gap-2">
                <button type="button" className={button} disabled={previousPage === null}
                  onClick={() => { if (previousPage !== null) { userActionRef.current = true; setPage(previousPage); setState({ kind: "loading" }); } }}>
                  Trang trước
                </button>
                <button type="button" className={button} disabled={nextPage === null}
                  onClick={() => { if (nextPage !== null) { userActionRef.current = true; setPage(nextPage); setState({ kind: "loading" }); } }}>
                  Trang sau
                </button>
              </div>
            </nav>
          </>
        )
      ) : null}

      <FormDialog
        open={markOffTarget !== null}
        onOpenChange={(open) => {
          if (!open && !markOffSubmitting) {
            setMarkOffTarget(null);
            setMarkOffError(null);
          }
        }}
        closeDisabled={markOffSubmitting}
        title="Chuyển trạng thái sang Đã nghỉ"
        description="Cập nhật trực tiếp trạng thái làm việc của hồ sơ sang Đã nghỉ và ghi nhận lý do nghỉ việc."
      >
        {markOffTarget ? (
          <form onSubmit={submitMarkOff} className="space-y-4">
            <div className="rounded-xl border border-border bg-surface-muted p-3 text-sm space-y-1">
              <p><span className="text-muted">Người lao động:</span> <span className="font-medium text-foreground">{markOffTarget.display_name ?? "—"}</span></p>
              <p><span className="text-muted">Mã nhân viên:</span> <span className="font-mono tabular-nums text-xs text-foreground">{markOffTarget.employee_code ?? "—"}</span></p>
              <p><span className="text-muted">Dự án:</span> <span className="text-foreground">{markOffTarget.project_display ?? "—"}</span></p>
            </div>

            {markOffError ? (
              <Alert tone="error" role="alert" title="Không cập nhật được trạng thái">
                <p>{markOffError}</p>
              </Alert>
            ) : null}

            <label className="flex flex-col gap-1.5 text-sm font-medium">
              <span>Ngày nghỉ việc <span className="text-status-danger-text">*</span></span>
              <input
                type="date"
                value={effectiveDate}
                min={markOffTarget.first_work_date ?? undefined}
                max={today}
                required
                disabled={markOffSubmitting}
                onChange={(event) => setEffectiveDate(event.target.value)}
                className="min-h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium">
              <span>Lý do nghỉ việc <span className="text-status-danger-text">*</span></span>
              <textarea
                rows={3}
                value={leaveReason}
                maxLength={4000}
                required
                disabled={markOffSubmitting}
                placeholder="Nhập lý do người lao động nghỉ việc…"
                onChange={(event) => setLeaveReason(event.target.value)}
                className="rounded-md border border-border bg-surface p-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm font-medium">
              <span>Ghi chú kiểm toán (tùy chọn)</span>
              <input
                type="text"
                value={markOffActionReason}
                maxLength={1000}
                disabled={markOffSubmitting}
                placeholder="Ghi chú thêm cho nhật ký thay đổi (không bắt buộc)…"
                onChange={(event) => setMarkOffActionReason(event.target.value)}
                className="min-h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
              />
            </label>

            <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={markOffSubmitting}
                onClick={() => {
                  setMarkOffTarget(null);
                  setMarkOffError(null);
                }}
                className={button}
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={markOffSubmitting || leaveReason.trim().length === 0}
                className={primaryButton}
              >
                {markOffSubmitting ? "Đang cập nhật…" : "Xác nhận chuyển Đã nghỉ"}
              </button>
            </div>
          </form>
        ) : null}
      </FormDialog>

      <FormDialog
        open={withdrawTarget !== null}
        onOpenChange={(open) => {
          if (!open && !withdrawSubmitting) {
            setWithdrawTarget(null);
            setWithdrawError(null);
          }
        }}
        closeDisabled={withdrawSubmitting}
        title="Xác nhận rút trùng hồ sơ"
        description="Thao tác dành riêng cho đúng người đã nhập hồ sơ này trên hệ thống."
      >
        {withdrawTarget ? (
          <form onSubmit={submitSelfWithdraw} className="space-y-4">
            <div className="rounded-xl border border-border bg-surface-muted p-3 text-sm space-y-1">
              <p><span className="text-muted">Người lao động:</span> <span className="font-medium text-foreground">{withdrawTarget.display_name ?? "—"}</span></p>
              <p><span className="text-muted">Mã nhân viên:</span> <span className="font-mono tabular-nums text-xs text-foreground">{withdrawTarget.employee_code ?? "—"}</span></p>
              <p><span className="text-muted">Dự án:</span> <span className="text-foreground">{withdrawTarget.project_display ?? "—"}</span></p>
            </div>

            <Alert tone="warning" title="Lưu ý trước khi rút trùng">
              <p>
                Hồ sơ này sẽ được rút khỏi số liệu tuyển mới và nhóm CCCD trùng đang làm việc. Hệ
                thống không xóa hồ sơ gốc và vẫn giữ nguyên toàn bộ lịch sử kiểm toán.
              </p>
            </Alert>

            {withdrawError ? (
              <Alert tone="error" role="alert" title="Không thực hiện được rút trùng">
                <p>{withdrawError}</p>
              </Alert>
            ) : null}

            <label className="flex flex-col gap-1.5 text-sm font-medium">
              <span>Ghi chú rút trùng (tùy chọn)</span>
              <input
                type="text"
                value={withdrawReason}
                maxLength={1000}
                disabled={withdrawSubmitting}
                placeholder="Ví dụ: Nhập trùng với hồ sơ dự án đối ứng…"
                onChange={(event) => setWithdrawReason(event.target.value)}
                className="min-h-10 rounded-md border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
              />
            </label>

            <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={withdrawSubmitting}
                onClick={() => {
                  setWithdrawTarget(null);
                  setWithdrawError(null);
                }}
                className={button}
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={withdrawSubmitting}
                className={primaryButton}
              >
                {withdrawSubmitting ? "Đang rút trùng…" : "Xác nhận rút trùng"}
              </button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </div>
  );
}
