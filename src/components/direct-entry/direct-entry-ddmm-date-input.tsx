"use client";

/**
 * P3-W07C-R6 - Editor ngay dung CHUNG cho moi be mat nhap first_work_date.
 *
 * Ly do: input type="date" cua trinh duyet hien thi theo locale may (MM/DD/YYYY),
 * khong theo hop dong DD/MM/YYYY cua san pham. Component nay dung text input voi
 * placeholder DD/MM/YYYY, giu mot draft cuc bo de nguoi dung go tung ky tu, va chi
 * commit ISO khi ngay hop le.
 *
 * Khong dung new Date("YYYY-MM-DD"). Chuyen doi qua formatDateToDDMM / parseDDMMToIso.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import {
  decideDdmmCommit,
  formatDateToDDMM,
} from "@/lib/direct-entry/direct-entry-date-format";

export const DDMM_DATE_PLACEHOLDER = "DD/MM/YYYY";

export type DdmmDateInputProps = {
  /** Gia tri ISO "YYYY-MM-DD" dang luu. */
  value: string;
  /** Goi khi nguoi dung commit mot ngay hop le. */
  onCommit(iso: string): void;
  ariaLabel: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Goi khi editor dong (Enter/blur/Escape) de react-data-grid dong cell editor. */
  onClose?: (commitChanges: boolean) => void;
  className?: string;
};

export function DdmmDateInput(props: DdmmDateInputProps) {
  const { value, onCommit, ariaLabel, disabled = false, autoFocus = false, onClose, className } = props;
  const [draft, setDraft] = useState(() => formatDateToDDMM(value));
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Dong bo khi gia tri ISO ben ngoai doi (reload/undo/commit o noi khac). Dung mau
  // "adjust state when a prop changes" cua React thay vi setState trong effect.
  const [syncedValue, setSyncedValue] = useState(value);
  if (syncedValue !== value) {
    setSyncedValue(value);
    setDraft(formatDateToDDMM(value));
  }
  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  // Enter co the commit roi editor unmount => blur chay lai. Chan commit lan hai.
  const settled = useRef(false);

  const commit = (): void => {
    if (settled.current) return;
    settled.current = true;
    const decision = decideDdmmCommit(draft, value);
    if (!decision.ok) {
      // Ngay sai/rong: KHONG ghi de gia tri cu; tra hien thi ve gia tri dang luu.
      setDraft(formatDateToDDMM(value));
      onClose?.(false);
      return;
    }
    if (decision.iso === value) {
      // Khong doi gi: chi dong editor, khong ban commit thua.
      setDraft(formatDateToDDMM(value));
      onClose?.(false);
      return;
    }
    // Co thay doi that: bao len tren. Voi react-data-grid, onCommit se dong editor
    // qua onRowChange(row, true) nen khong goi onClose them lan nua.
    onCommit(decision.iso);
    setDraft(formatDateToDDMM(decision.iso));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDraft(formatDateToDDMM(value));
      onClose?.(false);
    }
  };

  return (
    <input
      ref={inputRef}
      className={className}
      type="text"
      inputMode="numeric"
      placeholder={DDMM_DATE_PLACEHOLDER}
      aria-label={ariaLabel}
      disabled={disabled}
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
    />
  );
}
