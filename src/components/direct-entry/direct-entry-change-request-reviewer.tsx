"use client";

/**
 * P1.6-W04-S04C-S03B2 - Reviewer xem xet va quyet dinh change request ENTRY_FIELD.
 *
 * - Chi goi change-request detail endpoint khi nguoi dung mo "Xem xet" (khong tai truoc).
 * - Detail duoc strict-project bang projectChangeRequestDetail roi map ngay sang view model an toan;
 *   khong luu/khong render raw JSON, khong hien thi UUID lam noi dung chinh.
 * - Before/after chi gom 5 field khong PII; entry projection lay qua projectProposerEntry (S03B1)
 *   nen khong doc thong tin ca nhan, thanh toan hay tai lieu.
 * - can_decide chi la display hint; quyet dinh that do server/RPC quyet dinh.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog, Dialog } from "radix-ui";

import { hcmTodayDate } from "@/lib/direct-entry/change-request-proposal-builders";

import {
  CHANGE_REQUEST_STATE_LABELS,
  normalizeReason,
  projectionSlice,
  projectProposerEntry,
  type ProposerEntryProjection,
} from "@/lib/direct-entry/change-request-proposer";
import { projectChangeRequestStateResult } from "@/lib/direct-entry/change-request-contract";
import type { ChangeRequestDecision } from "@/lib/direct-entry/change-request-contract";
import {
  buildDecisionRequest,
  buildReviewerViewModel,
  catalogProjectLabel,
  catalogRecruiterLabel,
  decisionIntentSignature,
  LABOR_TYPE_LABELS,
  REVIEW_DECISION_LABELS,
  REVIEW_TARGET_KIND_LABELS,
  reviewerErrorMessage,
  reviewDecisionMessage,
  reviewDecisionState,
  STALE_REVIEW_MESSAGE,
  UNSUPPORTED_REVIEW_MESSAGE,
  reviewerUnsupportedMessage,
  unsupportedReviewerViewModel,
  type ReviewerUnsupportedReason,
  type ReviewerViewModel,
} from "@/lib/direct-entry/change-request-reviewer";
import {
  projectChangeRequestDetail,
  type ChangeRequestListItem,
} from "@/lib/direct-entry/change-request-read-contract";
import {
  projectEntrySensitiveContext,
  type EntrySensitiveContext,
} from "@/lib/direct-entry/change-request-read-projection";
import {
  clearIntentKey,
  EMPTY_INTENT_KEY,
  resolveIntentKey,
  shortRef,
  type TransitionIntentKeyState,
} from "@/lib/direct-entry/submission-lifecycle";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";

import styles from "./direct-entry-shell.module.css";

const DETAIL_KEYS = [
  "request_id", "state", "version", "created_at", "items", "can_withdraw", "can_decide",
] as const;
const DECISION_RESULT_KEYS = ["request_id", "state", "version"] as const;
const ENTRY_KEYS = ["entry"] as const;

export type ChangeRequestReviewerProps = {
  request: ChangeRequestListItem | null;
  onOpenChange: (open: boolean) => void;
  catalogFor: (date: string) => DraftCatalog | undefined;
  ensureCatalog: (date: string) => Promise<DraftCatalog>;
  onDecided: (message: string) => void;
  onConflict: (message: string) => void;
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function DirectEntryChangeRequestReviewer({
  request,
  onOpenChange,
  catalogFor,
  ensureCatalog,
  onDecided,
  onConflict,
}: ChangeRequestReviewerProps) {
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [loadMessage, setLoadMessage] = useState("");
  const [model, setModel] = useState<ReviewerViewModel | null>(null);
  const [reason, setReason] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [busy, setBusy] = useState<ChangeRequestDecision | null>(null);
  const [confirmDecision, setConfirmDecision] = useState<ChangeRequestDecision | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const intentKey = useRef<TransitionIntentKeyState>(EMPTY_INTENT_KEY);
  const lastRequestId = useRef<string | null>(null);
  // Radix Dialog khong tu tra focus khi khong dung Dialog.Trigger; ghi lai nut da mo dialog.
  const openerRef = useRef<HTMLElement | null>(null);

  const formatField = useCallback(
    (entry: ProposerEntryProjection, field: string, value: string): string | null => {
      // P3-W07C-R6-R1: nhan Du an / Nguoi tuyen lay tu catalog HIEN TAI (actor-scoped),
      // khong theo first_work_date cua ban ghi.
      const catalog = catalogFor(hcmTodayDate());
      if (field === "project_id") return catalogProjectLabel(catalog, value);
      if (field === "recruiter_id") return catalogRecruiterLabel(catalog, value);
      if (field === "labor_type") return LABOR_TYPE_LABELS[value] ?? null;
      return value;
    },
    [catalogFor],
  );

  // Bank id -> nhan catalog tu catalog hien tai; khong giai duoc thi fail-closed.
  const bankLabelFromCatalog = useCallback((bankId: string): string | null => {
    const catalog = catalogFor(hcmTodayDate());
    return catalog?.banks.find((bank) => bank.bank_id === bankId)?.display_name ?? null;
  }, [catalogFor]);

  useEffect(() => {
    if (!request) return undefined;
    const requestId = request.request_id;
    // Mo mot yeu cau khac thi moi reset trang thai; tai lai sau 409/loi thi giu nguyen
    // ly do da nhap va thong bao vua hien de nguoi dung con thay.
    const isNewRequest = lastRequestId.current !== requestId;
    lastRequestId.current = requestId;
    let cancelled = false;
    async function load() {
      if (isNewRequest) {
        setLoadState("loading");
        setModel(null);
      }
      setLoadMessage("");
      if (isNewRequest) {
        setStatusMessage("");
        setReason("");
        setConfirmDecision(null);
        openerRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      }
      try {
        const detailResponse = await fetch(
          "/api/direct-entry/change-requests/" + encodeURIComponent(requestId),
          { cache: "no-store", credentials: "same-origin" },
        );
        const detailBody = await readJson(detailResponse);
        if (!detailResponse.ok) throw new Error("CHANGE_REQUEST_UNAVAILABLE");
        const detail = projectChangeRequestDetail(
          projectionSlice(detailBody, DETAIL_KEYS),
          { request_id: requestId },
        );
        if (!detail) {
          // Payload khong qua duoc projection strict: fail-closed, khong render gi.
          if (cancelled) return;
          setModel(unsupportedReviewerViewModel(requestId, "PROPOSAL"));
          setLoadState("ready");
          return;
        }
        const entries = new Map<string, ProposerEntryProjection>();
        const contexts = new Map<string, EntrySensitiveContext>();
        // Phan loai dung nguyen nhan khi khong doc duoc entry, de dialog bao dung taxonomy
        // thay vi nhan chung "can phien ban giao dien hoac quyen xem khac".
        let entryFailure: ReviewerUnsupportedReason | null = null;
        for (const item of detail.items) {
          const response = await fetch(
            "/api/direct-entry/entries/" + encodeURIComponent(item.entry_id),
            { cache: "no-store", credentials: "same-origin" },
          );
          const body = await readJson(response);
          const slice = projectionSlice(body, ENTRY_KEYS);
          const entry = slice ? projectProposerEntry(slice.entry) : null;
          if (!response.ok) {
            entryFailure ??= (response.status === 403 || response.status === 404)
              ? "ENTRY_DENIED"
              : "ENTRY_UNAVAILABLE";
            continue;
          }
          if (!entry || entry.entry_id !== item.entry_id) {
            entryFailure ??= "ENTRY";
            continue;
          }
          entries.set(entry.entry_id, entry);
          // Ngu canh nhay cam (worker_details/payment/employment_status) strict-project rieng;
          // server da redact theo capability nen field khong duoc phep coi nhu KHONG CO.
          const context = slice ? projectEntrySensitiveContext(slice.entry) : null;
          if (context) contexts.set(entry.entry_id, context);
        }
        if (entryFailure !== null && entries.size < detail.items.length) {
          if (cancelled) return;
          setModel(unsupportedReviewerViewModel(requestId, entryFailure));
          setLoadState("ready");
          return;
        }
        // P3-W07C-R6-R1: khong tai catalog theo first_work_date cua tung ban ghi.
        await ensureCatalog(hcmTodayDate()).catch(() => null);
        if (cancelled) return;
        setModel(buildReviewerViewModel({
          detail, entries, format: formatField, contexts, bankLabel: bankLabelFromCatalog,
        }));
        setLoadState("ready");
      } catch (cause) {
        if (cancelled) return;
        setModel(null);
        setLoadState("error");
        setLoadMessage(cause instanceof Error ? cause.message : "CHANGE_REQUEST_UNAVAILABLE");
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [bankLabelFromCatalog, ensureCatalog, formatField, reloadToken, request]);

  // Nut quyet dinh van duoc render khi dang gui (disabled + "Dang gui…"), chi an khi request
  // khong con o trang thai cho quyet dinh.
  const canDecide = loadState === "ready" && model?.kind === "reviewable";

  const decide = useCallback(async (decision: ChangeRequestDecision) => {
    if (!request || !model || model.kind !== "reviewable") return;
    const requestId = request.request_id;
    const expectedVersion = model.version;
    const trimmed = normalizeReason(reason);
    if (trimmed === null) {
      setStatusMessage("Lý do quyết định là bắt buộc và tối đa 4000 ký tự.");
      return;
    }
    const intent = decisionIntentSignature(requestId, decision, trimmed);
    const resolved = resolveIntentKey(intentKey.current, intent, () => crypto.randomUUID());
    intentKey.current = resolved.state;
    const payload = buildDecisionRequest({
      decision,
      expectedVersion,
      reason: trimmed,
      idempotencyKey: resolved.key,
    });
    if (!payload) {
      setStatusMessage(reviewerErrorMessage(400));
      return;
    }
    setBusy(decision);
    setStatusMessage("");
    try {
      const response = await fetch(
        "/api/direct-entry/change-requests/" + encodeURIComponent(requestId) + "/decision",
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": resolved.key,
          },
          body: JSON.stringify(payload),
        },
      );
      const body = await readJson(response);
      if (response.ok) {
        const updated = projectChangeRequestStateResult(
          projectionSlice(body, DECISION_RESULT_KEYS),
          {
            request_id: requestId,
            expected_version: expectedVersion,
            state: reviewDecisionState(decision),
          },
        );
        if (!updated) {
          // 2xx nhung ket qua khong doc duoc: giu nguyen key de lan thu lai van idempotent.
          setStatusMessage(reviewerErrorMessage(500));
          return;
        }
        intentKey.current = clearIntentKey(resolved.state, intent);
        setModel({ kind: "terminal", request_id: updated.request_id, state: updated.state });
        const message = reviewDecisionMessage(decision, shortRef(updated.request_id));
        setStatusMessage(message);
        onDecided(message);
        return;
      }
      const status = response.status;
      if (status >= 500) {
        setStatusMessage(reviewerErrorMessage(status));
        return;
      }
      intentKey.current = clearIntentKey(resolved.state, intent);
      setStatusMessage(reviewerErrorMessage(status));
      if (status === 409) {
        onConflict(reviewerErrorMessage(status));
        setReloadToken((current) => current + 1);
      } else if (status === 401 || status === 403) {
        onConflict(reviewerErrorMessage(status));
      }
    } catch {
      setStatusMessage(reviewerErrorMessage(0));
    } finally {
      setBusy(null);
    }
  }, [model, onConflict, onDecided, reason, request]);

  const entryCount = useMemo(
    () => (model && "items" in model ? model.items.length : 0),
    [model],
  );

  return (
    <Dialog.Root open={request !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.drawerOverlay} />
        {request && (
          <Dialog.Content
            className={styles.drawer}
            data-testid="reviewer-dialog"
            onCloseAutoFocus={(event) => {
              const opener = openerRef.current;
              if (opener && opener.isConnected) {
                event.preventDefault();
                opener.focus();
              }
            }}
          >
            <Dialog.Title className={styles.drawerTitle}>Xem xét yêu cầu thay đổi</Dialog.Title>
            <Dialog.Description className={styles.drawerDescription}>
              Yêu cầu {shortRef(request.request_id)} · {CHANGE_REQUEST_STATE_LABELS[request.state]}
              {entryCount > 0 ? " · " + entryCount + " dòng" : ""}
            </Dialog.Description>

            <div className={styles.drawerFields}>
              <div className={styles.notice} aria-live="polite">
                {loadState === "loading" && "Đang tải chi tiết yêu cầu thay đổi…"}
                {loadState === "error" &&
                  "Không tải được chi tiết yêu cầu thay đổi (" + loadMessage + ")."}
              </div>

              {model?.kind === "unsupported" && (
                <p className={styles.notice} data-testid="reviewer-unsupported"
                  data-reason={model.reason}>
                  {reviewerUnsupportedMessage(model.reason)}
                </p>
              )}

              {model?.kind === "terminal" && (
                <p className={styles.submissionTerminalNote} data-testid="reviewer-terminal">
                  Yêu cầu đã ở trạng thái {CHANGE_REQUEST_STATE_LABELS[model.state]} và không còn chờ
                  quyết định.
                </p>
              )}

              {model?.kind === "stale" && (
                <p role="status" className={styles.submissionBlocked} data-testid="reviewer-stale">
                  {STALE_REVIEW_MESSAGE}
                </p>
              )}

              {model?.kind === "readonly" && (
                <p role="status" className={styles.submissionBlocked} data-testid="reviewer-readonly">
                  {model.message}
                </p>
              )}

              {(model?.kind === "reviewable" || model?.kind === "stale" ||
                model?.kind === "readonly") && (
                <>
                  {model.items.map((entry) => (
                    <div key={entry.entry_id} className={styles.proposerEntry}>
                      <strong>{entry.entry_code}</strong>
                      <p className={styles.submissionHint} data-testid="reviewer-item-kind">
                        {REVIEW_TARGET_KIND_LABELS[entry.targetKind] ?? entry.targetKind}
                      </p>
                      {entry.message !== null && (
                        <p className={styles.submissionHint} data-testid="reviewer-item-message">
                          {entry.message}
                        </p>
                      )}
                      {entry.rows.length === 0 ? (
                        <p className={styles.submissionHint}>
                          Không còn thay đổi so với dữ liệu hiện tại.
                        </p>
                      ) : (
                        <table className={styles.reviewerTable}>
                          <caption className={styles.submissionHint}>
                            So sánh giá trị hiện tại và giá trị đề xuất của dòng {entry.entry_code}
                          </caption>
                          <thead>
                            <tr><th scope="col">Trường</th><th scope="col">Hiện tại</th><th scope="col">Đề xuất</th></tr>
                          </thead>
                          <tbody>
                            {entry.rows.map((row) => (
                              <tr key={row.field}>
                                <th scope="row">{row.label}</th>
                                <td>{row.before}</td>
                                <td>{row.after}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  ))}

                  {model.kind === "reviewable" && (
                    <div className={styles.field}>
                      <label htmlFor="change-request-decision-reason">Lý do quyết định</label>
                      <textarea
                        id="change-request-decision-reason"
                        aria-label="Lý do quyết định"
                        rows={3}
                        maxLength={4000}
                        value={reason}
                        onChange={(event) => {
                          setReason(event.target.value);
                          setStatusMessage("");
                        }}
                      />
                    </div>
                  )}

                  <p className={styles.submissionHint}>
                    Quyết định áp dụng atomic cho toàn bộ {entryCount} dòng của yêu cầu: nếu một dòng
                    không áp dụng được, toàn bộ yêu cầu không thay đổi.
                  </p>
                </>
              )}

              {statusMessage && (
                <p role="alert" data-testid="reviewer-status">{statusMessage}</p>
              )}
            </div>

            <div className={styles.drawerActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={loadState === "loading" || busy !== null}
                onClick={() => setReloadToken((current) => current + 1)}
              >
                Tải lại
              </button>
              <Dialog.Close asChild>
                <button type="button" className={styles.secondaryButton} disabled={busy !== null}>
                  Đóng
                </button>
              </Dialog.Close>
              {canDecide && (
                <>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    aria-busy={busy === "reject"}
                    disabled={busy !== null}
                    onClick={() => {
                      if (normalizeReason(reason) === null) {
                        setStatusMessage("Lý do quyết định là bắt buộc và tối đa 4000 ký tự.");
                        return;
                      }
                      setConfirmDecision("reject");
                    }}
                  >
                    {busy === "reject" ? "Đang gửi…" : REVIEW_DECISION_LABELS.reject}
                  </button>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    aria-busy={busy === "approve"}
                    disabled={busy !== null}
                    onClick={() => {
                      if (normalizeReason(reason) === null) {
                        setStatusMessage("Lý do quyết định là bắt buộc và tối đa 4000 ký tự.");
                        return;
                      }
                      setConfirmDecision("approve");
                    }}
                  >
                    {busy === "approve" ? "Đang gửi…" : REVIEW_DECISION_LABELS.approve}
                  </button>
                </>
              )}
            </div>

            <AlertDialog.Root open={confirmDecision !== null} onOpenChange={(open) => {
              if (!open) setConfirmDecision(null);
            }}>
              <AlertDialog.Portal>
                <AlertDialog.Overlay className={styles.drawerOverlay} />
                {confirmDecision && (
                  <AlertDialog.Content className={styles.confirmDialog}>
                    <AlertDialog.Title className={styles.drawerTitle}>
                      {confirmDecision === "approve" ? "Duyệt yêu cầu thay đổi?" : "Từ chối yêu cầu thay đổi?"}
                    </AlertDialog.Title>
                    <AlertDialog.Description className={styles.drawerDescription}>
                      Quyết định áp dụng atomic cho toàn bộ {entryCount} dòng của yêu cầu này. Nếu một
                      dòng không áp dụng được, toàn bộ yêu cầu không thay đổi.
                    </AlertDialog.Description>
                    <div className={styles.drawerActions}>
                      <AlertDialog.Cancel asChild>
                        <button type="button" className={styles.secondaryButton}>Hủy</button>
                      </AlertDialog.Cancel>
                      <AlertDialog.Action asChild>
                        <button
                          type="button"
                          className={styles.primaryButton}
                          onClick={() => {
                            const decision = confirmDecision;
                            setConfirmDecision(null);
                            void decide(decision);
                          }}
                        >
                          {confirmDecision === "approve" ? "Duyệt yêu cầu" : "Từ chối yêu cầu"}
                        </button>
                      </AlertDialog.Action>
                    </div>
                  </AlertDialog.Content>
                )}
              </AlertDialog.Portal>
            </AlertDialog.Root>
          </Dialog.Content>
        )}
      </Dialog.Portal>
    </Dialog.Root>
  );
}
