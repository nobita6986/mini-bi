/**
 * P1.5-W04A-R2 (D) — Logic THUẦN cho modal/điều hướng của panel cấu hình AI.
 *
 * Tách khỏi component để test được bằng Node (không cần DOM, không thêm dependency):
 * - quyết định dismiss theo busy/dirty/confirm;
 * - tính đích Tab/Shift+Tab trong vòng focus.
 */

export type DismissDecision = "blocked" | "stay" | "confirm" | "close";

/**
 * Quyết định khi có một đường dismiss (Escape, overlay, nút Đóng, toggle trigger):
 * - `busy` ⇒ KHÔNG đóng (blocked);
 * - đang mở alertdialog xác nhận ⇒ Escape = "Ở lại" (stay), không đóng drawer;
 * - có thay đổi chưa lưu ⇒ hỏi xác nhận (confirm);
 * - còn lại ⇒ đóng (close).
 */
export function decideDismiss(input: { busy: boolean; dirty: boolean; confirmDiscard: boolean }): DismissDecision {
  if (input.busy) return "blocked";
  if (input.confirmDiscard) return "stay";
  if (input.dirty) return "confirm";
  return "close";
}

export type TabTarget = { prevent: boolean; index: number } | { prevent: false; index: -1 };

/**
 * Đích focus khi nhấn Tab/Shift+Tab trong vòng focus:
 * - không có phần tử nào focus được (`total === 0`) ⇒ không prevent (caller tự focus container);
 * - focus đang ở NGOÀI vòng (`inside === false`) ⇒ kéo về đầu/cuối;
 * - ở phần tử cuối + Tab, hoặc phần tử đầu + Shift+Tab ⇒ quay vòng.
 */
export function resolveTabTarget(input: {
  total: number;
  activeIndex: number;
  shiftKey: boolean;
  inside: boolean;
}): TabTarget {
  const { total, activeIndex, shiftKey, inside } = input;
  if (total <= 0) return { prevent: false, index: -1 };
  const first = 0;
  const last = total - 1;
  if (shiftKey) {
    if (!inside || activeIndex === first || activeIndex === -1) return { prevent: true, index: last };
    return { prevent: false, index: -1 };
  }
  if (!inside || activeIndex === last || activeIndex === -1) return { prevent: true, index: first };
  return { prevent: false, index: -1 };
}

/** Đích focus khi mở alertdialog xác nhận: nút hành động chính ("Bỏ thay đổi"). */
export function confirmInitialFocusIndex(total: number): number {
  return total > 0 ? 0 : -1;
}
