/**
 * P1.5-W04A-R2 (D) — Logic THUẦN cho modal/điều hướng (test được bằng Node, không DOM).
 *
 * - decideDismiss: quyết định dismiss theo busy/dirty/confirm (settings panel dùng với Radix Dialog).
 * - resolveTabTarget / confirmInitialFocusIndex: vòng focus thủ công, DÙNG BỞI ai-report-panel
 *   (panel cấu hình AI đã chuyển sang Radix focus trap; không tự viết lại ở panel này).
 * - flowStepOf: luồng 3 bước Lưu -> Kiểm tra -> Kích hoạt cho panel cấu hình AI.
 */

export type DismissDecision = "blocked" | "stay" | "confirm" | "close";

export function decideDismiss(input: { busy: boolean; dirty: boolean; confirmDiscard: boolean }): DismissDecision {
  if (input.busy) return "blocked";
  if (input.confirmDiscard) return "stay";
  if (input.dirty) return "confirm";
  return "close";
}

export type TabTarget = { prevent: boolean; index: number } | { prevent: false; index: -1 };

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

export function confirmInitialFocusIndex(total: number): number {
  return total > 0 ? 0 : -1;
}

export type FlowState = {
  currentStep: number;
  doneStep: number;
};

export function flowStepOf(status: string | null): FlowState {
  if (!status) return { currentStep: 1, doneStep: 0 };
  switch (status) {
    case "active":
      return { currentStep: 3, doneStep: 3 };
    case "verified":
      return { currentStep: 3, doneStep: 2 };
    case "disabled":
      return { currentStep: 0, doneStep: 0 };
    case "draft":
    case "test_failed":
    case "rotation_required":
      return { currentStep: 2, doneStep: 1 };
    default:
      return { currentStep: 1, doneStep: 0 };
  }
}
