"use client";

import {
  useCallback,
  useEffect,
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
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import {
  getVietnamTodayIsoDate,
  newAttendanceHqIntentKey,
  resolveAttendanceEmployeeDisplayIdentity,
} from "@/lib/attendance/attendance-report-contract";
import {
  projectAttendanceExplanationApprovalInbox,
  projectAttendanceMyExplanationsOverview,
  projectDecideAttendanceExplanationResult,
  projectSubmitAttendanceExplanationResult,
  type AttendanceExplanationApprovalInboxProjection,
  type AttendanceExplanationDaySlotEvaluationProjection,
  type AttendanceExplanationDecision,
  type AttendanceExplanationItemProjection,
  type AttendanceExplanationStatus,
  type AttendanceMyExplanationsOverviewProjection,
} from "@/lib/attendance/attendance-monthly-matrix-contract";
import {
  EXPLANATION_APPROVER_SOURCE_LABELS,
  EXPLANATION_STATUS_LABELS,
  MATRIX_EXPLAINED_APPROVED_LABEL,
  MATRIX_EXPLANATION_PENDING_LABEL,
  MATRIX_EXPLANATION_REJECTED_LABEL,
  MATRIX_MISSING_SLOT_LABEL,
  MATRIX_SLOT_SHORT_LABELS,
  buildDecideAttendanceExplanationPayload,
  buildSubmitAttendanceExplanationPayload,
  formatCheckinDeviationBadgeLabel,
  mapAttendanceExplanationMutationError,
} from "@/lib/attendance/attendance-monthly-matrix-ui-model";
import { cn } from "@/lib/utils";

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

type OverviewLoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: AttendanceMyExplanationsOverviewProjection }
  | { kind: "error"; detail: string };

type InboxLoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: AttendanceExplanationApprovalInboxProjection }
  | { kind: "error"; detail: string };

type SubmitDialogState =
  | { kind: "closed" }
  | {
      kind: "open";
      businessDate: string;
      policyVersionUsed: number;
      slot: AttendanceExplanationDaySlotEvaluationProjection;
    };

type DecisionDialogState =
  | { kind: "closed" }
  | {
      kind: "open";
      item: AttendanceExplanationItemProjection;
      decision: AttendanceExplanationDecision;
    };

function renderExplanationStatusBadge(status: AttendanceExplanationStatus) {
  if (status === "APPROVED") {
    return <StatusBadge tone="success">{MATRIX_EXPLAINED_APPROVED_LABEL}</StatusBadge>;
  }
  if (status === "REJECTED") {
    return <StatusBadge tone="danger">{MATRIX_EXPLANATION_REJECTED_LABEL}</StatusBadge>;
  }
  return <StatusBadge tone="warning">{MATRIX_EXPLANATION_PENDING_LABEL}</StatusBadge>;
}

export type AttendanceExplanationWorkspaceProps = {
  loginRedirectPath?: string;
  onExplanationChanged?: () => void;
};

export function AttendanceExplanationWorkspace({
  loginRedirectPath = "/leave",
  onExplanationChanged,
}: AttendanceExplanationWorkspaceProps) {
  const router = useRouter();
  const notify = useNotify();

  const [selectedDate, setSelectedDate] = useState<string>(() =>
    getVietnamTodayIsoDate(),
  );
  const [reloadToken, setReloadToken] = useState(0);
  const [overviewState, setOverviewState] = useState<OverviewLoadState>({
    kind: "loading",
  });
  const [lastOverview, setLastOverview] =
    useState<AttendanceMyExplanationsOverviewProjection | null>(null);

  const [inboxFilter, setInboxFilter] = useState<
    AttendanceExplanationStatus | "ALL"
  >("PENDING");
  const [inboxState, setInboxState] = useState<InboxLoadState>({
    kind: "idle",
  });
  const [lastInbox, setLastInbox] =
    useState<AttendanceExplanationApprovalInboxProjection | null>(null);

  const [submitDialog, setSubmitDialog] = useState<SubmitDialogState>({
    kind: "closed",
  });
  const [reasonInput, setReasonInput] = useState("");
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [decisionDialog, setDecisionDialog] = useState<DecisionDialogState>({
    kind: "closed",
  });
  const [decisionNoteInput, setDecisionNoteInput] = useState("");
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const requestReload = useCallback(() => {
    setOverviewState({ kind: "loading" });
    setReloadToken((v) => v + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      const params = new URLSearchParams();
      if (selectedDate.trim() !== "") {
        params.set("business_date", selectedDate.trim());
      }
      const query = params.toString();
      const url = query
        ? `/api/attendance/explanations?${query}`
        : "/api/attendance/explanations";

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
        });
      } catch (err) {
        if (
          controller.signal.aborted ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return;
        }
        setOverviewState({
          kind: "error",
          detail: "Không thể kết nối máy chủ để tải dữ liệu giải trình chấm công.",
        });
        return;
      }

      if (controller.signal.aborted) return;

      if (response.status === 401) {
        router.replace(`/login?next=${encodeURIComponent(loginRedirectPath)}`);
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (controller.signal.aborted) return;

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        setOverviewState({
          kind: "error",
          detail:
            "Không tải được thông tin giải trình chấm công. Vui lòng thử lại.",
        });
        return;
      }

      const projected = projectAttendanceMyExplanationsOverview({
        viewer: payload.viewer,
        routing: payload.routing,
        today_local: payload.today_local,
        selected_date: payload.selected_date,
        day_evaluation: payload.day_evaluation,
        pagination: payload.pagination,
        items: payload.items,
      });

      if (!projected) {
        setOverviewState({
          kind: "error",
          detail: "Phản hồi giải trình chấm công không đúng định dạng chuẩn.",
        });
        return;
      }

      setLastOverview(projected);
      setOverviewState({ kind: "ready", data: projected });
    })();

    return () => {
      controller.abort();
    };
  }, [loginRedirectPath, reloadToken, router, selectedDate]);

  const activeOverview =
    overviewState.kind === "ready" ? overviewState.data : lastOverview;
  const canApprove = activeOverview?.viewer.can_approve_explanations === true;

  useEffect(() => {
    if (!canApprove) {
      return;
    }

    const controller = new AbortController();

    void (async () => {
      const params = new URLSearchParams({ status: inboxFilter });
      let response: Response;
      try {
        response = await fetch(
          `/api/attendance/explanations/approvals?${params.toString()}`,
          {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
          },
        );
      } catch (err) {
        if (
          controller.signal.aborted ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return;
        }
        setInboxState({
          kind: "error",
          detail: "Không thể kết nối máy chủ để tải danh sách duyệt giải trình.",
        });
        return;
      }

      if (controller.signal.aborted) return;

      if (response.status === 401) {
        router.replace(`/login?next=${encodeURIComponent(loginRedirectPath)}`);
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (controller.signal.aborted) return;

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        setInboxState({
          kind: "error",
          detail: "Không tải được hộp thư phê duyệt giải trình chấm công.",
        });
        return;
      }

      const projected = projectAttendanceExplanationApprovalInbox({
        viewer: payload.viewer,
        pagination: payload.pagination,
        items: payload.items,
      });

      if (!projected) {
        setInboxState({
          kind: "error",
          detail: "Phản hồi hộp thư duyệt giải trình không đúng định dạng chuẩn.",
        });
        return;
      }

      setLastInbox(projected);
      setInboxState({ kind: "ready", data: projected });
    })();

    return () => {
      controller.abort();
    };
  }, [canApprove, inboxFilter, loginRedirectPath, reloadToken, router]);

  const activeInbox = inboxState.kind === "ready" ? inboxState.data : lastInbox;

  function openSubmitDialog(slot: AttendanceExplanationDaySlotEvaluationProjection) {
    if (!activeOverview) return;
    setSubmitError(null);
    setReasonInput("");
    setSubmitDialog({
      kind: "open",
      businessDate: activeOverview.day_evaluation.business_date,
      policyVersionUsed: activeOverview.day_evaluation.policy_version_used,
      slot,
    });
  }

  function closeSubmitDialog() {
    if (submitBusy) return;
    setSubmitDialog({ kind: "closed" });
    setSubmitError(null);
  }

  async function handleSubmitExplanation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitBusy || submitDialog.kind !== "open") return;

    const idempotencyKey = newAttendanceHqIntentKey();
    const built = buildSubmitAttendanceExplanationPayload({
      businessDate: submitDialog.businessDate,
      slotCode: submitDialog.slot.slot_code,
      reason: reasonInput,
      idempotencyKey,
      todayVn: getVietnamTodayIsoDate(),
    });

    if (!built.ok) {
      setSubmitError(built.message);
      return;
    }

    setSubmitBusy(true);
    setSubmitError(null);

    try {
      const response = await fetch("/api/attendance/explanations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(built.body),
      });

      if (response.status === 401) {
        setSubmitBusy(false);
        router.replace(`/login?next=${encodeURIComponent(loginRedirectPath)}`);
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const mapped = mapAttendanceExplanationMutationError(
          response.status,
          extractErrorCode(payload),
        );
        setSubmitError(mapped.message);
        if (mapped.isConflict) {
          requestReload();
        }
        setSubmitBusy(false);
        return;
      }

      const projected = projectSubmitAttendanceExplanationResult({
        replayed: payload.replayed,
        explanation: payload.explanation,
      });

      if (!projected) {
        setSubmitError("Phản hồi gửi giải trình không đúng định dạng chuẩn.");
        setSubmitBusy(false);
        return;
      }

      setSubmitBusy(false);
      setSubmitDialog({ kind: "closed" });
      notify.success({
        title: "Đã gửi giải trình chấm công",
        description: `Ngày ${projected.explanation.business_date} · ${projected.explanation.slot_label} (${projected.explanation.target_time})`,
      });
      requestReload();
      onExplanationChanged?.();
    } catch {
      setSubmitBusy(false);
      setSubmitError("Không thể kết nối máy chủ khi gửi giải trình chấm công.");
    }
  }

  function openDecisionDialog(
    item: AttendanceExplanationItemProjection,
    decision: AttendanceExplanationDecision,
  ) {
    setDecisionError(null);
    setDecisionNoteInput("");
    setDecisionDialog({ kind: "open", item, decision });
  }

  function closeDecisionDialog() {
    if (decisionBusy) return;
    setDecisionDialog({ kind: "closed" });
    setDecisionError(null);
  }

  async function handleDecideExplanation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (decisionBusy || decisionDialog.kind !== "open") return;

    const { item, decision } = decisionDialog;
    const idempotencyKey = newAttendanceHqIntentKey();
    const built = buildDecideAttendanceExplanationPayload({
      decision,
      expectedRowVersion: item.row_version,
      decisionNote: decisionNoteInput,
      idempotencyKey,
    });

    if (!built.ok) {
      setDecisionError(built.message);
      return;
    }

    setDecisionBusy(true);
    setDecisionError(null);

    try {
      const response = await fetch(
        `/api/attendance/explanations/approvals/${encodeURIComponent(item.explanation_id)}/decision`,
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
        setDecisionBusy(false);
        router.replace(`/login?next=${encodeURIComponent(loginRedirectPath)}`);
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        const mapped = mapAttendanceExplanationMutationError(
          response.status,
          extractErrorCode(payload),
        );
        setDecisionError(mapped.message);
        if (mapped.isConflict) {
          requestReload();
        }
        setDecisionBusy(false);
        return;
      }

      const projected = projectDecideAttendanceExplanationResult({
        replayed: payload.replayed,
        explanation: payload.explanation,
      });

      if (!projected) {
        setDecisionError(
          "Phản hồi phê duyệt giải trình không đúng định dạng chuẩn.",
        );
        setDecisionBusy(false);
        return;
      }

      setDecisionBusy(false);
      setDecisionDialog({ kind: "closed" });
      notify.success({
        title:
          decision === "APPROVE"
            ? "Đã duyệt giải trình chấm công"
            : "Đã từ chối giải trình chấm công",
        description: `${projected.explanation.requester.display_name ?? projected.explanation.requester.login_id ?? "Nhân sự"} · Ngày ${projected.explanation.business_date} (${projected.explanation.slot_label})`,
      });
      requestReload();
      onExplanationChanged?.();
    } catch {
      setDecisionBusy(false);
      setDecisionError(
        "Không thể kết nối máy chủ khi xử lý phê duyệt giải trình.",
      );
    }
  }

  if (overviewState.kind === "error" && !activeOverview) {
    return (
      <div className="space-y-4">
        <ErrorState
          title="Không tải được phân hệ Giải trình chấm công"
          detail={overviewState.detail}
        />
        <Button type="button" variant="secondary" onClick={requestReload}>
          Thử tải lại
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 1. Khu vực tạo giải trình theo mốc trong ngày của nhân sự */}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <CardHeader
            title="Giải trình chấm công theo mốc giờ chuẩn"
            description="Khi thiếu lượt chấm hoặc chấm công lệch ngoài khoảng dung sai của một mốc cụ thể trong ngày, nhân viên có thể chủ động gửi giải trình tới đúng người duyệt phép của mình. Việc duyệt giải trình chỉ ghi nhận trạng thái Giải trình được duyệt trên mốc đó, tuyệt đối không tạo lượt check-in giả hay sửa dữ liệu gốc."
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs font-medium text-foreground">
              <span>Ngày chấm công:</span>
              <input
                type="date"
                aria-label="Chọn ngày chấm công cần xem hoặc giải trình"
                value={selectedDate}
                max={getVietnamTodayIsoDate()}
                onChange={(event) => {
                  if (event.target.value) {
                    setSelectedDate(event.target.value);
                  }
                }}
                className="rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-xs text-foreground"
              />
            </label>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={requestReload}
              disabled={overviewState.kind === "loading"}
            >
              Làm mới
            </Button>
          </div>
        </div>

        {activeOverview ? (
          <div className="space-y-4">
            {/* Tuyến người duyệt giải trình */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-muted/45 px-3.5 py-2.5 text-xs">
              <div>
                <span className="text-muted">Người duyệt giải trình của bạn: </span>
                {activeOverview.routing.primary_approver ? (
                  <strong className="text-foreground">
                    {activeOverview.routing.primary_approver.display_name ??
                      activeOverview.routing.primary_approver.login_id ??
                      "Người duyệt"}
                  </strong>
                ) : activeOverview.routing.route_kind === "ADMIN_BOD_DIRECT" ||
                  activeOverview.routing.route_kind === "ADMIN_BOD_FALLBACK" ? (
                  <strong className="text-foreground">
                    Ban Giám đốc / Admin
                  </strong>
                ) : (
                  <strong className="text-red-700 dark:text-red-300">
                    Chưa cấu hình người duyệt
                  </strong>
                )}
                {activeOverview.routing.route_kind ? (
                  <span className="ml-1.5 text-muted">
                    (
                    {EXPLANATION_APPROVER_SOURCE_LABELS[
                      activeOverview.routing.route_kind
                    ] ?? activeOverview.routing.route_kind}
                    )
                  </span>
                ) : null}
              </div>
              <div className="font-mono text-muted">
                Ngày đang xem:{" "}
                <strong className="text-foreground">
                  {activeOverview.day_evaluation.business_date}
                </strong>{" "}
                · Khung giờ{" "}
                <strong className="text-foreground">
                  v{activeOverview.day_evaluation.policy_version_used}
                </strong>{" "}
                ({activeOverview.day_evaluation.slots.length} mốc)
              </div>
            </div>

            {/* Danh sách các mốc chấm công trong ngày đã chọn */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {activeOverview.day_evaluation.slots.map((slot) => {
                const slotLabel =
                  slot.slot_label ||
                  MATRIX_SLOT_SHORT_LABELS[slot.slot_code] ||
                  `Time ${slot.slot_index}`;
                const existingExplanation = slot.explanation;
                const isEligibleToSubmit =
                  slot.eligible_for_explanation &&
                  !existingExplanation &&
                  (slot.slot_status === "MISSING" ||
                    slot.slot_status === "OUT_OF_GRACE") &&
                  activeOverview.day_evaluation.business_date <=
                    getVietnamTodayIsoDate();

                const cardBorderClass =
                  slot.slot_status === "EXPLAINED_APPROVED" ||
                  slot.slot_status === "ON_TIME"
                    ? "border-emerald-300/80 bg-emerald-50/50 dark:border-emerald-800/60 dark:bg-emerald-950/25"
                    : slot.slot_status === "LEAVE_COVERED"
                      ? "border-sky-300/80 bg-sky-50/50 dark:border-sky-800/60 dark:bg-sky-950/25"
                      : slot.slot_status === "OUT_OF_GRACE"
                        ? "border-amber-300/80 bg-amber-50/50 dark:border-amber-800/60 dark:bg-amber-950/25"
                        : slot.slot_status === "UPCOMING"
                          ? "border-sky-300/80 bg-sky-50/50 dark:border-sky-800/60 dark:bg-sky-950/25"
                        : "border-red-300/80 bg-red-50/50 dark:border-red-800/60 dark:bg-red-950/25";

                return (
                  <div
                    key={slot.slot_code}
                    className={cn(
                      "flex flex-col justify-between gap-2.5 rounded-xl border p-3 text-xs",
                      cardBorderClass,
                    )}
                  >
                    <div className="space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold text-foreground">
                            {slotLabel}{" "}
                            <span className="font-mono font-bold">
                              ({slot.target_time})
                            </span>
                          </p>
                          <p className="text-[11px] text-muted">
                            Dung sai: -{slot.grace_before_minutes}p / +
                            {slot.grace_after_minutes}p
                          </p>
                        </div>
                        {slot.slot_status === "EXPLAINED_APPROVED" ? (
                          <StatusBadge tone="success">
                            {MATRIX_EXPLAINED_APPROVED_LABEL}
                          </StatusBadge>
                        ) : slot.slot_status === "ON_TIME" ? (
                          <StatusBadge tone="success">Đúng khung giờ</StatusBadge>
                        ) : slot.slot_status === "LEAVE_COVERED" ? (
                          <StatusBadge tone="info">Nghỉ phép đã duyệt</StatusBadge>
                        ) : slot.slot_status === "OUT_OF_GRACE" ? (
                          <StatusBadge tone="warning">Lệch khung giờ</StatusBadge>
                        ) : slot.slot_status === "UPCOMING" ? (
                          <StatusBadge tone="info">Chưa đến giờ chấm</StatusBadge>
                        ) : (
                          <StatusBadge tone="danger">
                            {MATRIX_MISSING_SLOT_LABEL}
                          </StatusBadge>
                        )}
                      </div>

                      {slot.checkins.length > 0 ? (
                        <div className="space-y-1">
                          <p className="text-[11px] font-medium text-muted">
                            Lượt chấm thực tế thuộc mốc này:
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {slot.checkins.map((c) => {
                              const badge = formatCheckinDeviationBadgeLabel(
                                c.deviation_status,
                                c.delta_minutes,
                              );
                              return (
                                <span
                                  key={c.checkin_id}
                                  className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px] font-semibold"
                                >
                                  <span>{c.time_local}</span>
                                  {badge ? (
                                    <span className="rounded bg-amber-200 px-1 text-[10px] font-sans font-bold text-amber-950 dark:bg-amber-900 dark:text-amber-100">
                                      {badge}
                                    </span>
                                  ) : null}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      ) : (
                        <p className="text-[11px] text-muted">
                          Không có lượt chấm công nào gắn với mốc này.
                        </p>
                      )}

                      {existingExplanation ? (
                        <div className="mt-1.5 space-y-1 rounded-lg border border-border/80 bg-surface/90 p-2">
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-semibold text-foreground">
                              Trạng thái giải trình:
                            </span>
                            {renderExplanationStatusBadge(
                              existingExplanation.status,
                            )}
                          </div>
                          <p className="text-[11px] text-foreground">
                            <span className="text-muted">Lý do: </span>
                            {existingExplanation.reason}
                          </p>
                          {existingExplanation.decision_note ? (
                            <p className="text-[11px] text-foreground">
                              <span className="text-muted">Phản hồi người duyệt: </span>
                              {existingExplanation.decision_note}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    {isEligibleToSubmit ? (
                      <div className="pt-1">
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          className="w-full"
                          disabled={!activeOverview.viewer.can_submit_explanation}
                          onClick={() => openSubmitDialog(slot)}
                        >
                          Gửi giải trình cho {slotLabel}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted">
            Đang tải dữ liệu các mốc chấm công trong ngày...
          </p>
        )}
      </Card>

      {/* 2. Danh sách giải trình đã gửi của bản thân */}
      <Card>
        <CardHeader
          title="Lịch sử giải trình chấm công của tôi"
          description="Theo dõi các giải trình chấm công đã gửi, người duyệt và kết quả phê duyệt."
        />

        {!activeOverview ? (
          <p className="py-6 text-center text-sm text-muted">
            Đang tải danh sách giải trình...
          </p>
        ) : activeOverview.items.length === 0 ? (
          <EmptyState
            title="Chưa có giải trình chấm công nào"
            description="Chọn ngày chấm công ở trên và bấm Gửi giải trình tại mốc bị thiếu hoặc lệch khung giờ nếu cần giải trình."
          />
        ) : (
          <DataTableContainer>
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Ngày &amp; Mốc giờ chuẩn
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Trạng thái gốc &amp; Lượt chấm thực tế
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Lý do giải trình
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Người duyệt &amp; Kết quả
                  </th>
                </tr>
              </thead>
              <tbody>
                {activeOverview.items.map((item) => (
                  <tr key={item.explanation_id} className={DATA_TABLE_ROW_CLASS}>
                    <td
                      data-label="Ngày & Mốc giờ chuẩn"
                      className={DATA_TABLE_TD_CLASS}
                    >
                      <div className="space-y-0.5 text-xs">
                        <p className="font-mono font-semibold text-foreground">
                          {item.business_date}
                        </p>
                        <p className="text-foreground">
                          {item.slot_label} ({item.target_time}) ·{" "}
                          <span className="font-mono text-muted">
                            KG v{item.policy_version_used}
                          </span>
                        </p>
                      </div>
                    </td>
                    <td
                      data-label="Trạng thái gốc & Lượt chấm thực tế"
                      className={DATA_TABLE_TD_CLASS}
                    >
                      <div className="space-y-1 text-xs">
                        <p className="font-medium text-foreground">
                          {item.original_slot_status === "MISSING"
                            ? MATRIX_MISSING_SLOT_LABEL
                            : "Lệch khung giờ"}
                        </p>
                        {item.related_checkins.length > 0 ? (
                          <p className="font-mono text-[11px] text-muted">
                            Giờ chấm:{" "}
                            {item.related_checkins
                              .map((c) => c.time_local)
                              .join(", ")}
                          </p>
                        ) : (
                          <p className="text-[11px] text-muted">
                            Không có lượt chấm
                          </p>
                        )}
                      </div>
                    </td>
                    <td
                      data-label="Lý do giải trình"
                      className={DATA_TABLE_TD_CLASS}
                    >
                      <div className="max-w-md space-y-1 text-xs">
                        <p className="text-foreground">{item.reason}</p>
                        <p className="font-mono text-[11px] text-muted">
                          Gửi lúc: {item.submitted_at}
                        </p>
                      </div>
                    </td>
                    <td
                      data-label="Người duyệt & Kết quả"
                      className={DATA_TABLE_TD_CLASS}
                    >
                      <div className="space-y-1 text-xs">
                        <div>{renderExplanationStatusBadge(item.status)}</div>
                        <p className="text-muted">
                          Người duyệt:{" "}
                          <strong className="text-foreground">
                            {item.decided_by?.display_name ??
                              item.primary_approver?.display_name ??
                              "Ban Giám đốc / Admin"}
                          </strong>
                        </p>
                        {item.decision_note ? (
                          <p className="text-foreground">
                            <span className="text-muted">Ghi chú duyệt: </span>
                            {item.decision_note}
                          </p>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTableContainer>
        )}
      </Card>

      {/* 3. Hộp thư phê duyệt giải trình chấm công (chỉ hiển thị cho cấp có thẩm quyền duyệt) */}
      {canApprove ? (
        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <CardHeader
              title="Hộp thư phê duyệt Giải trình chấm công"
              description="Áp dụng cùng luồng phân quyền người duyệt với Quản lý nghỉ phép. Khi duyệt, mốc chấm công được ghi nhận là Giải trình được duyệt; khi từ chối, mốc giữ nguyên trạng thái thiếu/lệch và hiển thị Giải trình bị từ chối."
            />
            <div
              role="tablist"
              aria-label="Bộ lọc trạng thái duyệt giải trình"
              className="flex flex-wrap gap-1.5"
            >
              {(
                [
                  { id: "PENDING", label: "Chờ duyệt" },
                  { id: "APPROVED", label: "Đã duyệt" },
                  { id: "REJECTED", label: "Đã từ chối" },
                  { id: "ALL", label: "Tất cả" },
                ] as const
              ).map((tab) => {
                const selected = inboxFilter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setInboxFilter(tab.id)}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors",
                      selected
                        ? "border-accent bg-accent text-accent-foreground"
                        : "border-border bg-surface text-foreground hover:bg-surface-muted",
                    )}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          {inboxState.kind === "error" && !activeInbox ? (
            <Alert tone="error" role="alert" title="Lỗi tải hộp thư phê duyệt">
              <p>{inboxState.detail}</p>
            </Alert>
          ) : !activeInbox ? (
            <p className="py-6 text-center text-sm text-muted">
              Đang tải danh sách giải trình cần phê duyệt...
            </p>
          ) : activeInbox.items.length === 0 ? (
            <EmptyState
              title="Không có giải trình chấm công nào trong bộ lọc này"
              description="Các giải trình chấm công thuộc phạm vi phê duyệt của bạn sẽ hiển thị tại đây."
            />
          ) : (
            <DataTableContainer>
              <table className={DATA_TABLE_CLASS}>
                <thead className={DATA_TABLE_HEAD_CLASS}>
                  <tr>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Nhân sự
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Ngày &amp; Mốc giải trình
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Lượt chấm thực tế &amp; Lý do
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Trạng thái
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Thao tác phê duyệt
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {activeInbox.items.map((item) => {
                    const requesterIdentity = resolveAttendanceEmployeeDisplayIdentity({
                      displayName: item.requester.display_name,
                      personnelCode: item.requester.personnel_code,
                      loginId: item.requester.login_id,
                    });
                    return (
                      <tr
                        key={item.explanation_id}
                        className={DATA_TABLE_ROW_CLASS}
                      >
                        <td data-label="Nhân sự" className={DATA_TABLE_TD_CLASS}>
                          <div className="space-y-0.5 text-xs">
                            <p className="font-semibold text-foreground">
                              {requesterIdentity.displayName}
                            </p>
                            {requesterIdentity.personnelCode ? (
                              <p className="font-mono text-muted">
                                Mã NS: {requesterIdentity.personnelCode}
                              </p>
                            ) : null}
                            {item.routed_team?.team_name ? (
                              <p className="text-muted">
                                Nhóm: {item.routed_team.team_name}
                              </p>
                            ) : null}
                          </div>
                        </td>
                      <td
                        data-label="Ngày & Mốc giải trình"
                        className={DATA_TABLE_TD_CLASS}
                      >
                        <div className="space-y-0.5 text-xs">
                          <p className="font-mono font-semibold text-foreground">
                            {item.business_date}
                          </p>
                          <p className="text-foreground">
                            {item.slot_label} ({item.target_time}) ·{" "}
                            <span className="font-mono text-muted">
                              KG v{item.policy_version_used}
                            </span>
                          </p>
                          <p className="text-[11px] text-muted">
                            Trạng thái gốc:{" "}
                            <strong>
                              {item.original_slot_status === "MISSING"
                                ? MATRIX_MISSING_SLOT_LABEL
                                : "Lệch khung giờ"}
                            </strong>
                          </p>
                        </div>
                      </td>
                      <td
                        data-label="Lượt chấm thực tế & Lý do"
                        className={DATA_TABLE_TD_CLASS}
                      >
                        <div className="max-w-md space-y-1 text-xs">
                          {item.related_checkins.length > 0 ? (
                            <p className="font-mono text-[11px] text-muted">
                              Giờ chấm thực tế:{" "}
                              <strong className="text-foreground">
                                {item.related_checkins
                                  .map((c) => c.time_local)
                                  .join(", ")}
                              </strong>
                            </p>
                          ) : (
                            <p className="text-[11px] text-muted">
                              Không có lượt chấm trong mốc này
                            </p>
                          )}
                          <p className="text-foreground">
                            <span className="text-muted">Lý do: </span>
                            {item.reason}
                          </p>
                          {item.decision_note ? (
                            <p className="text-foreground">
                              <span className="text-muted">Ghi chú duyệt: </span>
                              {item.decision_note}
                            </p>
                          ) : null}
                        </div>
                      </td>
                      <td
                        data-label="Trạng thái"
                        className={DATA_TABLE_TD_CLASS}
                      >
                        <div className="space-y-1 text-xs">
                          {renderExplanationStatusBadge(item.status)}
                          <p className="text-[11px] text-muted">
                            {EXPLANATION_STATUS_LABELS[item.status]}
                          </p>
                        </div>
                      </td>
                      <td
                        data-label="Thao tác phê duyệt"
                        className={DATA_TABLE_TD_CLASS}
                      >
                        {item.can_decide && item.status === "PENDING" ? (
                          <div className="flex flex-wrap gap-1.5">
                            <Button
                              type="button"
                              variant="primary"
                              size="sm"
                              onClick={() => openDecisionDialog(item, "APPROVE")}
                            >
                              Duyệt
                            </Button>
                            <Button
                              type="button"
                              variant="danger"
                              size="sm"
                              onClick={() => openDecisionDialog(item, "REJECT")}
                            >
                              Từ chối
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted">
                            {item.status === "PENDING"
                              ? "Chỉ xem"
                              : `Đã xử lý${item.decided_by ? ` (${item.decided_by.display_name})` : ""}`}
                          </span>
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
      ) : null}

      {/* Dialog: Gửi giải trình cho 1 mốc cụ thể */}
      <FormDialog
        open={submitDialog.kind === "open"}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeSubmitDialog();
        }}
        title={
          submitDialog.kind === "open"
            ? `Gửi giải trình · ${submitDialog.slot.slot_label} (${submitDialog.slot.target_time})`
            : "Gửi giải trình chấm công"
        }
        description={
          submitDialog.kind === "open"
            ? `Ngày chấm công ${submitDialog.businessDate} · Khung giờ v${submitDialog.policyVersionUsed}`
            : undefined
        }
        closeAriaLabel="Đóng hộp thoại gửi giải trình chấm công"
      >
        {submitDialog.kind === "open" ? (
          <form onSubmit={handleSubmitExplanation} className="space-y-4">
            {submitError ? (
              <Alert tone="error" role="alert" title="Không thể gửi giải trình">
                <p>{submitError}</p>
              </Alert>
            ) : null}

            <div className="rounded-xl border border-border bg-surface-muted/45 p-3 text-xs space-y-1">
              <p>
                <span className="text-muted">Mốc giải trình: </span>
                <strong className="text-foreground">
                  {submitDialog.slot.slot_label} ({submitDialog.slot.target_time})
                </strong>{" "}
                · Dung sai -{submitDialog.slot.grace_before_minutes}p / +
                {submitDialog.slot.grace_after_minutes}p
              </p>
              <p>
                <span className="text-muted">Trạng thái hiện tại: </span>
                <strong className="text-foreground">
                  {submitDialog.slot.slot_status === "MISSING"
                    ? MATRIX_MISSING_SLOT_LABEL
                    : "Lệch khung giờ"}
                </strong>
              </p>
              {submitDialog.slot.checkins.length > 0 ? (
                <p>
                  <span className="text-muted">Lượt chấm thực tế trong mốc: </span>
                  <strong className="font-mono text-foreground">
                    {submitDialog.slot.checkins
                      .map((c) => c.time_local)
                      .join(", ")}
                  </strong>
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="attendance-explanation-reason"
                className="block text-xs font-semibold text-foreground"
              >
                Lý do giải trình (bắt buộc, 3–1000 ký tự)
              </label>
              <textarea
                id="attendance-explanation-reason"
                rows={4}
                required
                minLength={3}
                maxLength={1000}
                value={reasonInput}
                onChange={(e) => setReasonInput(e.target.value)}
                placeholder="Nhập rõ lý do thiếu chấm công hoặc chấm công lệch khung giờ tại mốc này..."
                className={INPUT_CLASS}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={closeSubmitDialog}
                disabled={submitBusy}
              >
                Hủy
              </Button>
              <Button type="submit" variant="primary" disabled={submitBusy}>
                {submitBusy ? "Đang gửi..." : "Gửi giải trình"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>

      {/* Dialog: Duyệt / Từ chối giải trình */}
      <FormDialog
        open={decisionDialog.kind === "open"}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) closeDecisionDialog();
        }}
        title={
          decisionDialog.kind === "open"
            ? decisionDialog.decision === "APPROVE"
              ? "Xác nhận Duyệt giải trình chấm công"
              : "Xác nhận Từ chối giải trình chấm công"
            : "Phê duyệt giải trình"
        }
        description={
          decisionDialog.kind === "open"
            ? `${
                resolveAttendanceEmployeeDisplayIdentity({
                  displayName: decisionDialog.item.requester.display_name,
                  personnelCode: decisionDialog.item.requester.personnel_code,
                  loginId: decisionDialog.item.requester.login_id,
                }).displayName
              } · Ngày ${decisionDialog.item.business_date} · ${decisionDialog.item.slot_label} (${decisionDialog.item.target_time})`
            : undefined
        }
        closeAriaLabel="Đóng hộp thoại phê duyệt giải trình"
      >
        {decisionDialog.kind === "open" ? (
          <form onSubmit={handleDecideExplanation} className="space-y-4">
            {decisionError ? (
              <Alert
                tone="error"
                role="alert"
                title="Không thể xử lý phê duyệt"
              >
                <p>{decisionError}</p>
              </Alert>
            ) : null}

            <div className="rounded-xl border border-border bg-surface-muted/45 p-3 text-xs space-y-1">
              <p>
                <span className="text-muted">Nhân sự: </span>
                <strong className="text-foreground">
                  {
                    resolveAttendanceEmployeeDisplayIdentity({
                      displayName: decisionDialog.item.requester.display_name,
                      personnelCode: decisionDialog.item.requester.personnel_code,
                      loginId: decisionDialog.item.requester.login_id,
                    }).displayName
                  }
                </strong>
              </p>
              <p>
                <span className="text-muted">Mốc giải trình: </span>
                <strong className="text-foreground">
                  {decisionDialog.item.slot_label} (
                  {decisionDialog.item.target_time})
                </strong>{" "}
                ngày{" "}
                <strong className="font-mono text-foreground">
                  {decisionDialog.item.business_date}
                </strong>
              </p>
              <p>
                <span className="text-muted">Lý do của nhân viên: </span>
                <strong className="text-foreground">
                  {decisionDialog.item.reason}
                </strong>
              </p>
              <p className="text-[11px] text-muted pt-1">
                {decisionDialog.decision === "APPROVE"
                  ? "Khi duyệt, mốc chấm công này sẽ hiển thị trạng thái “Giải trình được duyệt” trên Báo cáo tháng (không tạo lượt check-in giả)."
                  : "Khi từ chối, mốc chấm công giữ nguyên trạng thái thiếu/lệch ban đầu và hiển thị “Giải trình bị từ chối”."}
              </p>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="attendance-explanation-decision-note"
                className="block text-xs font-semibold text-foreground"
              >
                Ghi chú phê duyệt (tùy chọn, tối đa 1000 ký tự)
              </label>
              <textarea
                id="attendance-explanation-decision-note"
                rows={3}
                maxLength={1000}
                value={decisionNoteInput}
                onChange={(e) => setDecisionNoteInput(e.target.value)}
                placeholder="Nhập phản hồi hoặc ghi chú quyết định (nếu có)..."
                className={INPUT_CLASS}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={closeDecisionDialog}
                disabled={decisionBusy}
              >
                Hủy
              </Button>
              <Button
                type="submit"
                variant={
                  decisionDialog.decision === "APPROVE" ? "primary" : "danger"
                }
                disabled={decisionBusy}
              >
                {decisionBusy
                  ? "Đang xử lý..."
                  : decisionDialog.decision === "APPROVE"
                    ? "Xác nhận Duyệt"
                    : "Xác nhận Từ chối"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>
    </div>
  );
}
