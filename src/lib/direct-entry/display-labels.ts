/**
 * PRE-W2-HF-UI-LABELS - Nhan hien thi tieng Viet dung chung cho trang thai lam viec va gioi tinh.
 *
 * Lop presentation thuan: khong I/O, khong doi enum/API payload/DB. Moi be mat UI doc nhan qua
 * day de (a) khong bao gio render ma enum (ON/OFF/UNCONFIRMED/MALE/FEMALE/OTHER) nhu chu hien thi
 * va (b) khong lap lai bang nhan o nhieu noi.
 */

export type WorkStatusUiCode = "ON" | "OFF" | "UNCONFIRMED" | "PENDING";
export type GenderUiCode = "MALE" | "FEMALE" | "OTHER";

export const WORK_STATUS_UI_LABELS: Readonly<Record<WorkStatusUiCode, string>> = Object.freeze({
  ON: "Đang làm",
  OFF: "Đã nghỉ",
  UNCONFIRMED: "Đang chờ việc",
  PENDING: "Đang chờ việc",
});

/** Fallback tieng Viet cho trang thai thieu/khong hop le (khong bao gio tra ma enum). */
export const WORK_STATUS_UI_FALLBACK = "Chưa có trạng thái";

/** Nhan trang thai lam viec; null/rỗng/khong nhan dien -> fallback tieng Viet. */
export function workStatusUiLabel(status: string | null | undefined): string {
  if (status === null || status === undefined) return WORK_STATUS_UI_FALLBACK;
  const key = status.trim().toUpperCase();
  return WORK_STATUS_UI_LABELS[key as WorkStatusUiCode] ?? WORK_STATUS_UI_FALLBACK;
}

export const GENDER_UI_LABELS: Readonly<Record<GenderUiCode, string>> = Object.freeze({
  MALE: "Nam",
  FEMALE: "Nữ",
  OTHER: "Khác",
});

/** Fallback khi o gioi tinh co gia tri nhung khong nhan dien duoc (khong bao gio tra ma enum). */
export const GENDER_UI_FALLBACK = "—";

/**
 * Nhan gioi tinh. O trong (chua chon) giu nguyen chuoi rong de khong hien placeholder "—";
 * gia tri khong nhan dien duoc -> "—" (khong bao gio tra ma enum tieng Anh).
 */
export function genderUiLabel(gender: string | null | undefined): string {
  if (gender === null || gender === undefined) return "";
  const key = gender.trim().toUpperCase();
  if (key === "") return "";
  return GENDER_UI_LABELS[key as GenderUiCode] ?? GENDER_UI_FALLBACK;
}
