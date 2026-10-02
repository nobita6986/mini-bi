/**
 * P1.5-W04A-R2 (D) — Test THẬT cho logic modal của panel (gọi hàm, không chỉ so chuỗi source).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { confirmInitialFocusIndex, decideDismiss, resolveTabTarget } from "./ai-settings-panel-logic.ts";

test("R2-D1: busy chặn MỌI đường dismiss (kể cả khi dirty hoặc alertdialog đang mở)", () => {
  assert.equal(decideDismiss({ busy: true, dirty: false, confirmDiscard: false }), "blocked");
  assert.equal(decideDismiss({ busy: true, dirty: true, confirmDiscard: false }), "blocked");
  assert.equal(decideDismiss({ busy: true, dirty: true, confirmDiscard: true }), "blocked");
  assert.equal(decideDismiss({ busy: true, dirty: false, confirmDiscard: true }), "blocked");
});

test("R2-D2: quyết định dismiss theo dirty/confirm", () => {
  assert.equal(decideDismiss({ busy: false, dirty: false, confirmDiscard: false }), "close");
  assert.equal(decideDismiss({ busy: false, dirty: true, confirmDiscard: false }), "confirm");
  // Escape/overlay khi alertdialog đang mở = "Ở lại" (KHÔNG đóng drawer).
  assert.equal(decideDismiss({ busy: false, dirty: true, confirmDiscard: true }), "stay");
  assert.equal(decideDismiss({ busy: false, dirty: false, confirmDiscard: true }), "stay");
});

test("R2-D3: Tab/Shift+Tab quay vòng trong vòng focus, không thoát ra nền", () => {
  // 3 phần tử: 0,1,2
  assert.deepEqual(resolveTabTarget({ total: 3, activeIndex: 2, shiftKey: false, inside: true }), { prevent: true, index: 0 });
  assert.deepEqual(resolveTabTarget({ total: 3, activeIndex: 0, shiftKey: true, inside: true }), { prevent: true, index: 2 });
  // Ở giữa ⇒ để trình duyệt tự đi tiếp trong vòng.
  assert.deepEqual(resolveTabTarget({ total: 3, activeIndex: 1, shiftKey: false, inside: true }), { prevent: false, index: -1 });
  assert.deepEqual(resolveTabTarget({ total: 3, activeIndex: 1, shiftKey: true, inside: true }), { prevent: false, index: -1 });
  // Focus đang ở NGOÀI vòng ⇒ kéo về đầu/cuối.
  assert.deepEqual(resolveTabTarget({ total: 3, activeIndex: -1, shiftKey: false, inside: false }), { prevent: true, index: 0 });
  assert.deepEqual(resolveTabTarget({ total: 3, activeIndex: -1, shiftKey: true, inside: false }), { prevent: true, index: 2 });
  // Không còn phần tử nào focus được ⇒ caller tự focus container.
  assert.deepEqual(resolveTabTarget({ total: 0, activeIndex: -1, shiftKey: false, inside: true }), { prevent: false, index: -1 });
  // Vòng focus CHỈ còn 2 nút của alertdialog (nội dung sau bị inert).
  assert.deepEqual(resolveTabTarget({ total: 2, activeIndex: 1, shiftKey: false, inside: true }), { prevent: true, index: 0 });
  assert.deepEqual(resolveTabTarget({ total: 2, activeIndex: 0, shiftKey: true, inside: true }), { prevent: true, index: 1 });
});

test("R2-D4: alertdialog nhận focus vào hành động chính khi mở", () => {
  assert.equal(confirmInitialFocusIndex(2), 0);
  assert.equal(confirmInitialFocusIndex(0), -1);
});
