"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  PAYMENT_STATES,
  projectPaymentInput,
  projectPaymentProjection,
  projectPaymentUpdateResult,
  type PaymentProjection,
  type PaymentState,
} from "@/lib/direct-entry/payment-contract";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";
import styles from "./direct-entry-shell.module.css";

type PaymentForm = {
  state: PaymentState;
  account_number: string;
  bank_id: string;
  account_holder_name: string;
};

type PaymentSnapshot = {
  entryVersion: number;
  payment: PaymentProjection | null;
};

type Props = {
  entryId: string | null;
  entryVersion: number | null;
  rowId: string;
  banks: DraftCatalog["banks"];
  canEdit: boolean;
  canView: boolean;
  onEntryVersionChange(rowId: string, entryVersion: number): void;
};

const EMPTY_FORM: PaymentForm = {
  state: "omitted",
  account_number: "",
  bank_id: "",
  account_holder_name: "",
};

const PAYMENT_STATE_LABELS: Record<PaymentState, string> = {
  omitted: "Chưa bổ sung",
  unknown: "Chưa xác định",
  intentionally_blank: "Chủ động để trống",
  provided: "Đã cung cấp",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function formFromSnapshot(snapshot: PaymentSnapshot, canView: boolean): PaymentForm {
  const payment = snapshot.payment;
  if (!payment) return { ...EMPTY_FORM };
  if (canView && !payment.masked) {
    return {
      state: payment.state,
      account_number: payment.account_number ?? "",
      bank_id: payment.bank_id ?? "",
      account_holder_name: payment.account_holder_name ?? "",
    };
  }
  return {
    state: payment.state,
    account_number: "",
    bank_id: "",
    account_holder_name: "",
  };
}

function snapshotProjection(value: unknown, entryId: string): PaymentSnapshot | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.entry) ||
      value.entry.entry_id !== entryId ||
      typeof value.entry.version !== "number" || !Number.isSafeInteger(value.entry.version) ||
      value.entry.version < 1 ||
      (value.entry.payment !== null && !projectPaymentProjection(value.entry.payment))) return null;
  return {
    entryVersion: value.entry.version,
    payment: value.entry.payment === null ? null : projectPaymentProjection(value.entry.payment),
  };
}

function errorCode(value: unknown): string {
  return isRecord(value) && typeof value.code === "string"
    ? value.code
    : "PAYMENT_UNAVAILABLE";
}

function maskAccountNumber(accountNumber: string): string {
  return `${"•".repeat(Math.max(accountNumber.length - 4, 0))}${accountNumber.slice(-4)}`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "loading": return "Đang tải thông tin thanh toán…";
    case "dirty": return "Có thay đổi thanh toán chưa lưu";
    case "saving": return "Đang lưu thông tin thanh toán…";
    case "saved": return "Đã lưu thông tin thanh toán";
    case "error": return "Lỗi lưu thông tin thanh toán";
    case "conflict": return "Xung đột phiên bản thanh toán";
    default: return "Thông tin thanh toán đã lưu";
  }
}

export function DirectEntryPaymentEditor({
  entryId,
  entryVersion,
  rowId,
  banks,
  canEdit,
  canView,
  onEntryVersionChange,
}: Props) {
  const [form, setForm] = useState<PaymentForm>(EMPTY_FORM);
  const [paymentVersion, setPaymentVersion] = useState(0);
  const [currentEntryVersion, setCurrentEntryVersion] = useState(entryVersion);
  const [maskedAccount, setMaskedAccount] = useState<string | null>(null);
  const [status, setStatus] = useState(entryId ? "loading" : "clean");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [conflictCopy, setConflictCopy] = useState<PaymentSnapshot | null>(null);
  const pendingWrite = useRef<{ fingerprint: string; key: string } | null>(null);
  const canReveal = canView;

  const loadSnapshot = useCallback(async (): Promise<PaymentSnapshot> => {
    if (!entryId) throw new Error("ENTRY_NOT_SAVED");
    const response = await fetch(
      `/api/direct-entry/entries/${encodeURIComponent(entryId)}`,
      { cache: "no-store", credentials: "same-origin" },
    );
    const snapshot = snapshotProjection(await readJson(response), entryId);
    if (!response.ok || !snapshot) throw new Error("PAYMENT_PROJECTION_UNAVAILABLE");
    return snapshot;
  }, [entryId]);

  const applySnapshot = useCallback((snapshot: PaymentSnapshot, nextStatus: string) => {
    setForm(formFromSnapshot(snapshot, canReveal));
    setCurrentEntryVersion(snapshot.entryVersion);
    setPaymentVersion(snapshot.payment?.version ?? 0);
    setMaskedAccount(snapshot.payment?.masked ? snapshot.payment.account_number : null);
    setConflictCopy(null);
    setMessage("");
    setStatus(nextStatus);
    if (entryId) onEntryVersionChange(rowId, snapshot.entryVersion);
  }, [canReveal, entryId, onEntryVersionChange, rowId]);

  useEffect(() => {
    let cancelled = false;
    pendingWrite.current = null;
    if (!entryId) {
      return () => { cancelled = true; };
    }
    void loadSnapshot().then((snapshot) => {
      if (!cancelled) applySnapshot(snapshot, "clean");
    }).catch(() => {
      if (!cancelled) {
        setStatus("error");
        setMessage("Không tải được projection thanh toán an toàn.");
      }
    });
    return () => { cancelled = true; };
  }, [applySnapshot, entryId, loadSnapshot]);

  const onFormChange = useCallback((patch: Partial<PaymentForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setStatus("dirty");
    setMessage("");
    setConflictCopy(null);
  }, []);

  const save = useCallback(async () => {
    const expectedEntryVersion = Math.max(
      currentEntryVersion ?? 0,
      entryVersion ?? 0,
    );
    if (!entryId || !canEdit || status === "saving" || status === "loading" ||
        status === "conflict" || expectedEntryVersion < 1) return;
    if (reason.trim().length === 0 || reason.length > 4000) {
      setStatus("error");
      setMessage("Nhập lý do cập nhật (tối đa 4000 ký tự).");
      return;
    }
    const activeBankIds = new Set(banks.map(({ bank_id }) => bank_id));
    const payment = projectPaymentInput({
      state: form.state,
      account_number: form.state === "provided" ? form.account_number : null,
      bank_id: form.state === "provided" ? form.bank_id : null,
      account_holder_name: form.state === "provided" ? form.account_holder_name : null,
    }, activeBankIds);
    if (!payment) {
      setStatus("error");
      setMessage(form.state === "provided"
        ? "Nhập STK dạng số, chọn ngân hàng đang hoạt động và nhập tên chủ tài khoản."
        : "Thông tin thanh toán không hợp lệ.");
      return;
    }
    const body = {
      expected_entry_version: expectedEntryVersion,
      expected_payment_version: paymentVersion,
      payment,
      reason,
    };
    const fingerprint = JSON.stringify(body);
    const pending = pendingWrite.current;
    const key = pending?.fingerprint === fingerprint ? pending.key : crypto.randomUUID();
    pendingWrite.current = { fingerprint, key };
    setStatus("saving");
    setMessage("");
    try {
      const response = await fetch(
        `/api/direct-entry/entries/${encodeURIComponent(entryId)}/payment`,
        {
          method: "PATCH",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify(body),
        },
      );
      const result = await readJson(response);
      if (response.status === 409) {
        pendingWrite.current = null;
        setStatus("conflict");
        try {
          setConflictCopy(await loadSnapshot());
          setMessage("Máy chủ đã đổi phiên bản. Chọn bản server hoặc giữ local trước khi lưu lại.");
        } catch {
          setMessage("Xung đột phiên bản; không tải được bản server để đối chiếu.");
        }
        return;
      }
      const projected = projectPaymentUpdateResult(result, entryId);
      if (!response.ok || !projected) {
        setStatus("error");
        setMessage(`Không lưu được thông tin thanh toán (${errorCode(result)}).`);
        return;
      }
      pendingWrite.current = null;
      setCurrentEntryVersion(projected.entry_version);
      setPaymentVersion(projected.payment_version);
      onEntryVersionChange(rowId, projected.entry_version);
      setStatus("saved");
      setMessage("Đã lưu qua máy chủ.");
      if (!canReveal) {
        const safeForm: PaymentForm = {
          state: payment.state,
          account_number: "",
          bank_id: "",
          account_holder_name: "",
        };
        setForm(safeForm);
        setMaskedAccount(payment.state === "provided"
          ? maskAccountNumber(payment.account_number ?? "")
          : null);
        try {
          applySnapshot(await loadSnapshot(), "saved");
        } catch {
          setMessage("Đã lưu. Projection che STK hiện chưa tải lại được.");
        }
      }
    } catch {
      setStatus("error");
      setMessage("Không lưu được thông tin thanh toán. Có thể thử lại; request giữ nguyên khóa idempotency.");
    }
  }, [
    applySnapshot, banks, canEdit, canReveal, currentEntryVersion, entryId, entryVersion, form,
    loadSnapshot, onEntryVersionChange, paymentVersion, reason, rowId, status,
  ]);

  const applyServer = useCallback(() => {
    if (!conflictCopy) return;
    pendingWrite.current = null;
    setReason("");
    applySnapshot(conflictCopy, "clean");
  }, [applySnapshot, conflictCopy]);

  const keepLocal = useCallback(() => {
    if (!conflictCopy) return;
    pendingWrite.current = null;
    setCurrentEntryVersion(conflictCopy.entryVersion);
    setPaymentVersion(conflictCopy.payment?.version ?? 0);
    setMaskedAccount(conflictCopy.payment?.masked
      ? conflictCopy.payment.account_number
      : null);
    onEntryVersionChange(rowId, conflictCopy.entryVersion);
    setConflictCopy(null);
    setStatus("dirty");
    setMessage("Bản local được giữ; phiên bản mới đã nạp. Chỉ cập nhật khi bấm lưu lại.");
  }, [conflictCopy, onEntryVersionChange, rowId]);

  const retryConflictLoad = useCallback(async () => {
    try {
      setConflictCopy(await loadSnapshot());
      setMessage("Đã tải projection hiện tại. Chọn bản server hoặc giữ local.");
    } catch {
      setMessage("Không tải được projection hiện tại.");
    }
  }, [loadSnapshot]);

  const readOnlyPayment = status !== "loading" && status !== "error" &&
    (!canEdit || !entryId);
  const isMasked = !canReveal || maskedAccount !== null;

  return (
    <section className={styles.paymentSection} aria-labelledby={`payment-title-${rowId}`}>
      <h3 id={`payment-title-${rowId}`} className={styles.paymentTitle}>Thông tin thanh toán</h3>
      <p className={styles.paymentStatus} role="status">{statusLabel(status)}</p>
      {!entryId && (
        <p className={styles.paymentNotice}>
          Có thể lưu thanh toán sau khi lưu dòng bản nháp trên máy chủ.
        </p>
      )}
      {entryId && status === "loading" && <p>Đang tải projection có kiểm soát quyền…</p>}
      {entryId && status === "error" && (
        <p className={styles.paymentError} role="alert">{message}</p>
      )}
      {entryId && status !== "loading" && status !== "error" && (
        <>
          <label className={styles.field}>
            <span>Trạng thái thông tin thanh toán</span>
            {readOnlyPayment
              ? <output>{PAYMENT_STATE_LABELS[form.state]}</output>
              : (
                <select
                  aria-label="Trạng thái thông tin thanh toán"
                  value={form.state}
                  disabled={status === "saving" || status === "conflict"}
                  onChange={(event) => {
                    const state = event.currentTarget.value;
                    if (PAYMENT_STATES.includes(state as PaymentState)) {
                      onFormChange({ state: state as PaymentState });
                    }
                  }}
                >
                  {PAYMENT_STATES.map((state) => (
                    <option key={state} value={state}>{PAYMENT_STATE_LABELS[state]}</option>
                  ))}
                </select>
              )}
          </label>
          {form.state === "provided" && (
            isMasked && maskedAccount && !canEdit
              ? <p className={styles.paymentNotice}>Số tài khoản: <strong>{maskedAccount}</strong></p>
              : (
                <>
                  {maskedAccount && isMasked && (
                    <p className={styles.paymentNotice}>
                      STK đã lưu: <strong>{maskedAccount}</strong>. Không hiển thị plaintext.
                    </p>
                  )}
                  <label className={styles.field}>
                    <span>Số tài khoản</span>
                    <input
                      aria-label="Số tài khoản"
                      type={canReveal ? "text" : "password"}
                      inputMode="numeric"
                      autoComplete="off"
                      value={form.account_number}
                      disabled={!canEdit || status === "saving" || status === "conflict"}
                      onCopy={canReveal ? undefined : (event) => event.preventDefault()}
                      onCut={canReveal ? undefined : (event) => event.preventDefault()}
                      onContextMenu={canReveal ? undefined : (event) => event.preventDefault()}
                      onChange={(event) => onFormChange({ account_number: event.currentTarget.value })}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>Ngân hàng</span>
                    {readOnlyPayment
                      ? <output>{form.bank_id
                        ? banks.find(({ bank_id }) => bank_id === form.bank_id)?.display_name ?? "—"
                        : "Không có dữ liệu ngân hàng trong projection"}</output>
                      : (
                        <select
                          aria-label="Ngân hàng"
                          value={form.bank_id}
                          disabled={status === "saving" || status === "conflict"}
                          onChange={(event) => onFormChange({ bank_id: event.currentTarget.value })}
                        >
                          <option value="">Chọn ngân hàng đang hoạt động</option>
                          {banks.map((bank) => (
                            <option key={bank.bank_id} value={bank.bank_id}>{bank.display_name}</option>
                          ))}
                        </select>
                      )}
                  </label>
                  <label className={styles.field}>
                    <span>Tên chủ tài khoản</span>
                    {readOnlyPayment
                      ? <output>{form.account_holder_name || "Không có dữ liệu trong projection"}</output>
                      : (
                        <input
                          aria-label="Tên chủ tài khoản"
                          type={canReveal ? "text" : "password"}
                          autoComplete="off"
                          maxLength={256}
                          value={form.account_holder_name}
                          disabled={status === "saving" || status === "conflict"}
                          onCopy={canReveal ? undefined : (event) => event.preventDefault()}
                          onCut={canReveal ? undefined : (event) => event.preventDefault()}
                          onContextMenu={canReveal ? undefined : (event) => event.preventDefault()}
                          onChange={(event) => onFormChange({
                            account_holder_name: event.currentTarget.value,
                          })}
                        />
                      )}
                  </label>
                </>
              )
          )}
          {!canView && (
            <p className={styles.paymentNotice}>
              Quyền xem đầy đủ chưa được cấp. Giá trị đã lưu chỉ hiển thị dạng che; khi sửa thông tin
              “Đã cung cấp”, cần nhập lại đủ các trường.
            </p>
          )}
          {canEdit && (
            <>
              <label className={styles.field}>
                <span>Lý do cập nhật</span>
                <textarea
                  aria-label="Lý do cập nhật thanh toán"
                  maxLength={4000}
                  value={reason}
                  disabled={status === "saving" || status === "conflict"}
                  onChange={(event) => setReason(event.currentTarget.value)}
                />
              </label>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={status === "saving" || status === "loading" || status === "conflict" ||
                  status === "clean" || status === "saved" || !entryId}
                onClick={() => void save()}
              >
                {status === "saving" ? "Đang lưu…" : "Lưu thông tin thanh toán"}
              </button>
            </>
          )}
        </>
      )}
      {status === "conflict" && (
        <div className={styles.paymentConflict} role="alert">
          <strong>Xung đột phiên bản; dữ liệu local chưa được ghi đè.</strong>
          {message && <span>{message}</span>}
          {conflictCopy
            ? <>
              <span>Phiên bản dòng: {Math.max(currentEntryVersion ?? 0, entryVersion ?? 0)}; bản server: {conflictCopy.entryVersion}.</span>
              <button type="button" className={styles.secondaryButton} onClick={applyServer}>
                Tải bản server
              </button>
              <button type="button" className={styles.secondaryButton} onClick={keepLocal}>
                Giữ bản local để xem lại
              </button>
            </>
            : <button type="button" className={styles.secondaryButton} onClick={() => void retryConflictLoad()}>
              Tải lại bản server
            </button>}
        </div>
      )}
      {status === "error" && message && <p className={styles.paymentError} role="alert">{message}</p>}
      {status === "saved" && message && <p className={styles.paymentNotice}>{message}</p>}
    </section>
  );
}
