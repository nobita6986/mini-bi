"use client";

/**
 * P1.6-W04-S04C-S03B1 - Proposer tao change request ENTRY_FIELD cho mot dot da SUBMITTED.
 *
 * - Chi ho tro target_kind ENTRY_FIELD voi 5 field khong PII. Cac loai khac (thong tin ca nhan,
 *   thanh toan, trang thai lam viec, tai lieu) khong duoc gui va khong gia vo la da ho tro.
 * - Mot POST duy nhat cho 1..N entry (atomic). Khong optimistic update.
 * - Khong goi change-request detail endpoint; khong render raw proposal/JSON.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog, Dialog } from "radix-ui";

import { RecruiterTypeahead, type PickerOption } from "@/components/direct-entry/typeahead-picker-smoke";
import {
  buildProposerItems,
  changeRequestErrorMessage,
  changedProposerFields,
  normalizeReason,
  projectProposerEntry,
  projectionSlice,
  proposalFromDraft,
  proposerErrorMessage,
  PROPOSER_FIELD_LABELS,
  summarizeProposal,
  type ProposerEntryDraft,
  type ProposerEntryProjection,
  type ProposerFields,
} from "@/lib/direct-entry/change-request-proposer";
import {
  projectChangeRequestCreate,
  projectChangeRequestCreated,
} from "@/lib/direct-entry/change-request-contract";
import {
  DETAIL_KEYS,
  projectSubmissionDetail,
} from "@/lib/direct-entry/submission-read-contract";
import type { SubmissionReadItem } from "@/lib/direct-entry/submission-read-contract";
import {
  clearIntentKey,
  EMPTY_INTENT_KEY,
  resolveIntentKey,
  type TransitionIntentKeyState,
} from "@/lib/direct-entry/submission-lifecycle";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";

import styles from "./direct-entry-shell.module.css";

export type ChangeRequestProposerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  submission: SubmissionReadItem | null;
  catalogFor: (date: string) => DraftCatalog | undefined;
  ensureCatalog: (date: string) => Promise<DraftCatalog>;
  onCreated: (input: { request_id: string; items: number }) => void;
  onConflict: () => void;
  onUnauthorized: () => void;
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function baselineOf(entry: ProposerEntryProjection): ProposerFields {
  return {
    employee_code: entry.employee_code,
    first_work_date: entry.first_work_date,
    project_id: entry.project_id,
    recruiter_id: entry.recruiter_id,
    labor_type: entry.labor_type,
  };
}

function optionsFor(catalog: DraftCatalog | undefined): PickerOption[] {
  return catalog?.recruiters.map((recruiter) => ({
    id: recruiter.recruiter_id,
    label: recruiter.display_name,
    groupLabel: recruiter.provider_type.toUpperCase() + " · " + recruiter.team_display_name,
    provider: recruiter.provider_type.toUpperCase(),
    team: recruiter.team_display_name,
  })) ?? [];
}

export function DirectEntryChangeRequestProposer({
  open,
  onOpenChange,
  submission,
  catalogFor,
  ensureCatalog,
  onCreated,
  onConflict,
  onUnauthorized,
}: ChangeRequestProposerProps) {
  const [entryState, setEntryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [entryMessage, setEntryMessage] = useState("");
  const [entries, setEntries] = useState<ProposerEntryProjection[]>([]);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ProposerFields>>({});
  const [reason, setReason] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const intentKey = useRef<TransitionIntentKeyState>(EMPTY_INTENT_KEY);

  useEffect(() => {
    if (!open || !submission) return undefined;
    let cancelled = false;
    async function load() {
      setEntryState("loading");
      try {
        const detailResponse = await fetch(
          "/api/direct-entry/submissions/" + encodeURIComponent(submission!.submission_id),
          { cache: "no-store", credentials: "same-origin" },
        );
        const detailBody = await readJson(detailResponse);
        const detail = projectSubmissionDetail(
          projectionSlice(detailBody, DETAIL_KEYS),
          { submission_id: submission!.submission_id },
        );
        if (!detailResponse.ok || !detail) throw new Error("SUBMISSION_UNAVAILABLE");
        const loaded: ProposerEntryProjection[] = [];
        for (const entryId of detail.entry_ids) {
          const response = await fetch(
            "/api/direct-entry/entries/" + encodeURIComponent(entryId),
            { cache: "no-store", credentials: "same-origin" },
          );
          const body = await readJson(response);
          const slice = projectionSlice(body, ["entry"]);
          const entry = slice ? projectProposerEntry(slice.entry) : null;
          if (!response.ok || !entry || entry.entry_id !== entryId) {
            throw new Error("ENTRY_UNAVAILABLE");
          }
          loaded.push(entry);
        }
        await Promise.all([...new Set(loaded.map((item) => item.first_work_date))]
          .map((date) => ensureCatalog(date).catch(() => null)));
        if (cancelled) return;
        setEntries(loaded);
        setDrafts({});
        setSelected([]);
        setReason("");
        setStatusMessage("");
        setEntryState("ready");
        setEntryMessage("");
      } catch (cause) {
        if (cancelled) return;
        setEntryState("error");
        setEntryMessage(cause instanceof Error ? cause.message : "CHANGE_REQUEST_UNAVAILABLE");
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [ensureCatalog, open, submission]);

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selected.includes(entry.entry_id)),
    [entries, selected],
  );

  const proposerDrafts: ProposerEntryDraft[] = useMemo(
    () => selectedEntries.map((entry) => {
      const baseline = baselineOf(entry);
      return {
        entry_id: entry.entry_id,
        expected_version: entry.expected_version,
        baseline,
        draft: drafts[entry.entry_id] ?? baseline,
      };
    }),
    [drafts, selectedEntries],
  );

  const buildResult = useMemo(() => buildProposerItems(proposerDrafts), [proposerDrafts]);
  const normalizedReason = normalizeReason(reason);
  const canSubmit = buildResult.ok && normalizedReason !== null && !busy && entryState === "ready";

  function toggleEntry(entryId: string) {
    setSelected((current) => current.includes(entryId)
      ? current.filter((id) => id !== entryId)
      : [...current, entryId]);
    setStatusMessage("");
  }

  function editEntry(entryId: string, patch: Partial<ProposerFields>) {
    setDrafts((current) => {
      const entry = entries.find((item) => item.entry_id === entryId);
      const base = current[entryId] ?? (entry ? baselineOf(entry) : null);
      if (!base) return current;
      return { ...current, [entryId]: { ...base, ...patch } };
    });
    setStatusMessage("");
  }

  const submit = useCallback(async () => {
    if (!buildResult.ok) {
      setStatusMessage(proposerErrorMessage(buildResult.code));
      return;
    }
    const normalized = normalizeReason(reason);
    if (normalized === null) {
      setStatusMessage("Lý do thay đổi là bắt buộc và tối đa 4000 ký tự.");
      return;
    }
    const signature = JSON.stringify({ items: buildResult.items, reason: normalized });
    const intent = "change_request_create:" + signature;
    const resolved = resolveIntentKey(intentKey.current, intent, () => crypto.randomUUID());
    intentKey.current = resolved.state;
    const body = {
      items: buildResult.items,
      reason: normalized,
      idempotency_key: resolved.key,
    };
    const validated = projectChangeRequestCreate(body);
    if (!validated.ok) {
      setStatusMessage("Yêu cầu thay đổi không hợp lệ.");
      return;
    }
    setBusy(true);
    setStatusMessage("Đang gửi yêu cầu thay đổi…");
    try {
      const response = await fetch("/api/direct-entry/change-requests", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": resolved.key,
        },
        body: JSON.stringify(validated.value),
      });
      const payload = await readJson(response);
      if (response.ok) {
        const created = projectChangeRequestCreated(
          projectionSlice(payload, ["request_id", "state", "items"]),
          buildResult.items.length,
        );
        if (!created) {
          setStatusMessage(changeRequestErrorMessage(500));
          return;
        }
        intentKey.current = clearIntentKey(resolved.state, intent);
        onCreated({ request_id: created.request_id, items: created.items });
        onOpenChange(false);
        return;
      }
      const status = response.status;
      if (status === 409) {
        intentKey.current = clearIntentKey(resolved.state, intent);
        setStatusMessage(changeRequestErrorMessage(409));
        onConflict();
        return;
      }
      if (status >= 500) {
        setStatusMessage(changeRequestErrorMessage(status));
        return;
      }
      intentKey.current = clearIntentKey(resolved.state, intent);
      setStatusMessage(changeRequestErrorMessage(status));
      if (status === 401 || status === 403) onUnauthorized();
    } catch {
      setStatusMessage(changeRequestErrorMessage(0));
    } finally {
      setBusy(false);
    }
  }, [buildResult, onConflict, onCreated, onOpenChange, onUnauthorized, reason]);

  const summaryLines = proposerDrafts.map((draft) => {
    const entry = entries.find((item) => item.entry_id === draft.entry_id);
    const changed = changedProposerFields(draft.baseline, draft.draft)
      .map((field) => PROPOSER_FIELD_LABELS[field]).join(", ");
    return (entry ? entry.employee_code : draft.entry_id) + ": " + (changed || "chưa có thay đổi");
  });

  return (
    <Dialog.Root open={open} onOpenChange={(next) => {
      if (!busy) onOpenChange(next);
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.drawerOverlay} />
        <Dialog.Content className={styles.drawer} aria-describedby="change-request-proposer-description">
          <Dialog.Title className={styles.drawerTitle}>Yêu cầu thay đổi</Dialog.Title>
          <Dialog.Description id="change-request-proposer-description" className={styles.drawerDescription}>
            Đề xuất thay đổi cho đợt đã gửi chính thức. Hiện hỗ trợ thay đổi thông tin dòng:
            mã người lao động, ngày đầu tiên đi làm, dự án, người tuyển và loại hình lao động.
            Thông tin cá nhân, thanh toán, trạng thái làm việc và tài liệu chưa hỗ trợ.
          </Dialog.Description>

          <div className={styles.notice} aria-live="polite">
            {entryState === "loading" && "Đang tải các dòng của đợt…"}
            {entryState === "error" &&
              `Không tải được dòng của đợt (${entryMessage}).`}
            {entryState === "ready" && entries.length === 0 &&
              "Đợt này không có dòng nào để đề xuất thay đổi."}
          </div>

          <div className={styles.drawerFields}>
            {entryState === "ready" && entries.map((entry) => {
              const isSelected = selected.includes(entry.entry_id);
              const catalog = catalogFor(entry.first_work_date);
              const baseline = baselineOf(entry);
              const draft = drafts[entry.entry_id] ?? baseline;
              return (
                <div key={entry.entry_id} className={styles.proposerEntry}>
                  <label className={styles.proposerChoice}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      aria-label={"Chọn dòng " + entry.employee_code}
                      onChange={() => toggleEntry(entry.entry_id)}
                    />
                    <span>
                      <strong>{entry.employee_code}</strong>
                      {" · "}{entry.first_work_date}{" · phiên bản "}{entry.expected_version}
                    </span>
                  </label>
                  {isSelected && (
                    <div className={styles.proposerFields}>
                      <div className={styles.field}>
                        <label htmlFor={"cr-code-" + entry.entry_id}>Mã người lao động</label>
                        <input
                          id={"cr-code-" + entry.entry_id}
                          aria-label={"Mã người lao động của " + entry.employee_code}
                          value={draft.employee_code}
                          onChange={(event) => editEntry(entry.entry_id, {
                            employee_code: event.target.value,
                          })}
                        />
                      </div>
                      <div className={styles.field}>
                        <label htmlFor={"cr-date-" + entry.entry_id}>Ngày đầu tiên đi làm</label>
                        <input
                          id={"cr-date-" + entry.entry_id}
                          type="date"
                          aria-label={"Ngày đầu tiên đi làm của " + entry.employee_code}
                          value={draft.first_work_date}
                          onChange={(event) => editEntry(entry.entry_id, {
                            first_work_date: event.target.value,
                          })}
                        />
                      </div>
                      <div className={styles.field}>
                        <label htmlFor={"cr-project-" + entry.entry_id}>Dự án</label>
                        <select
                          id={"cr-project-" + entry.entry_id}
                          aria-label={"Dự án của " + entry.employee_code}
                          value={draft.project_id}
                          onChange={(event) => editEntry(entry.entry_id, {
                            project_id: event.target.value,
                          })}
                        >
                          <option value="">Chọn dự án</option>
                          {catalog?.projects.map((project) => (
                            <option key={project.project_id} value={project.project_id}>
                              {project.display_name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className={styles.field}>
                        <RecruiterTypeahead
                          id={"cr-recruiter-" + entry.entry_id}
                          options={optionsFor(catalog)}
                          value={draft.recruiter_id}
                          label={"Người tuyển của " + entry.employee_code}
                          onChange={(recruiterId) => editEntry(entry.entry_id, {
                            recruiter_id: recruiterId,
                          })}
                        />
                      </div>
                      <div className={styles.field}>
                        <label htmlFor={"cr-labor-" + entry.entry_id}>Loại hình lao động</label>
                        <select
                          id={"cr-labor-" + entry.entry_id}
                          aria-label={"Loại hình lao động của " + entry.employee_code}
                          value={draft.labor_type}
                          onChange={(event) => {
                            const value = event.target.value;
                            if (value === "TEMPORARY" || value === "PERMANENT") {
                              editEntry(entry.entry_id, { labor_type: value });
                            }
                          }}
                        >
                          <option value="TEMPORARY">Thời vụ</option>
                          <option value="PERMANENT">Toàn thời gian</option>
                        </select>
                      </div>
                      <p className={styles.submissionHint}>
                        Thay đổi: {changedProposerFields(baseline, draft)
                          .map((field) => PROPOSER_FIELD_LABELS[field]).join(", ") || "chưa có"}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}

            {entryState === "ready" && entries.length > 0 && (
              <div className={styles.field}>
                <label htmlFor="change-request-reason">Lý do thay đổi</label>
                <textarea
                  id="change-request-reason"
                  aria-label="Lý do thay đổi"
                  rows={3}
                  value={reason}
                  maxLength={4000}
                  onChange={(event) => { setReason(event.target.value); setStatusMessage(""); }}
                />
              </div>
            )}

            {entryState === "ready" && proposerDrafts.length > 0 && (
              <div className={styles.proposerSummary} aria-live="polite">
                <strong>Tóm tắt {proposerDrafts.length} dòng sẽ gửi</strong>
                <ul>
                  {summaryLines.map((line, index) => <li key={index}>{line}</li>)}
                </ul>
                {buildResult.ok && (
                  <p className={styles.submissionHint}>
                    Trường thay đổi: {summarizeProposal(
                      proposalFromDraft(proposerDrafts[0].baseline, proposerDrafts[0].draft),
                    ) || "—"}
                  </p>
                )}
              </div>
            )}

            {statusMessage && <p role="alert">{statusMessage}</p>}
          </div>

          <div className={styles.drawerActions}>
            <Dialog.Close asChild>
              <button type="button" className={styles.secondaryButton} disabled={busy}>
                Hủy
              </button>
            </Dialog.Close>
            <button
              type="button"
              className={styles.primaryButton}
              aria-busy={busy}
              disabled={!canSubmit}
              onClick={() => {
                if (!buildResult.ok) {
                  setStatusMessage(proposerErrorMessage(buildResult.code));
                  return;
                }
                if (normalizeReason(reason) === null) {
                  setStatusMessage("Lý do thay đổi là bắt buộc và tối đa 4000 ký tự.");
                  return;
                }
                setConfirmOpen(true);
              }}
            >
              {busy ? "Đang gửi…" : "Xem lại và gửi"}
            </button>
          </div>

          <AlertDialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialog.Portal>
              <AlertDialog.Overlay className={styles.drawerOverlay} />
              <AlertDialog.Content className={styles.confirmDialog}>
                <AlertDialog.Title className={styles.drawerTitle}>
                  Gửi yêu cầu thay đổi?
                </AlertDialog.Title>
                <AlertDialog.Description className={styles.drawerDescription}>
                  Yêu cầu được gửi trong một lần cho tất cả {proposerDrafts.length} dòng đã chọn
                  {" "}(atomic). Nếu một dòng không hợp lệ, toàn bộ yêu cầu không được tạo.
                </AlertDialog.Description>
                <ul className={styles.proposerConfirmList}>
                  {summaryLines.map((line, index) => <li key={index}>{line}</li>)}
                </ul>
                <div className={styles.drawerActions}>
                  <AlertDialog.Cancel asChild>
                    <button type="button" className={styles.secondaryButton}>Hủy</button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action asChild>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={() => { setConfirmOpen(false); void submit(); }}
                    >
                      Gửi yêu cầu
                    </button>
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
