/**
 * P1.5-W05-S01 — Test cấu trúc + boundary bảo mật cho panel báo cáo AI.
 * (Test logic thuần nằm ở src/lib/ai-report/report-contract.test.mjs.)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./ai-report-panel.tsx", import.meta.url), "utf8");

test("S01-P1: panel là client component, KHÔNG kéo module server-only/provider vào client", () => {
  assert.ok(source.includes('"use client"'));
  assert.ok(!source.includes("server-only"), "panel không được import server-only");
  assert.ok(!/from\s+["']@\/lib\/ai\//.test(source), "panel không được import @/lib/ai/* (server boundary)");
  assert.ok(!/from\s+["']@\/lib\/ai-config\//.test(source), "panel không được import @/lib/ai-config/*");
  assert.ok(source.includes('from "@/lib/ai-report/report-contract"'), "panel chỉ dùng contract thuần");
});

test("S01-P2: panel không nhận/giữ secret, PII, provider URL đầy đủ hay prompt nội bộ", () => {
  for (const forbidden of ["api_key", "API key", "encrypted_secret", "envelope", "ciphertext", "Authorization", "Bearer", "NEXT_PUBLIC_"]) {
    assert.ok(!source.includes(forbidden), "panel không được chứa " + forbidden);
  }
  for (const forbidden of ["localStorage", "sessionStorage", "document.cookie", "indexedDB", "console.log"]) {
    assert.ok(!source.includes(forbidden), "panel không được dùng " + forbidden);
  }
});

test("S01-P3: chỉ gọi server boundary đã có — không gọi provider/config trực tiếp", () => {
  const controller = readFileSync(new URL("../../lib/ai-report/report-controller.ts", import.meta.url), "utf8");
  assert.ok(controller.includes('"/api/ai/reports/capability"'));
  assert.ok(controller.includes('"/api/ai/reports"'));
  assert.ok(controller.includes('"/analysis"'));
  assert.ok(source.includes('credentials: "same-origin"'));
  assert.ok(source.includes('cache: "no-store"'));
});

test("S01-P4: drawer có semantics a11y (dialog/modal/label/live region)", () => {
  assert.ok(source.includes('role="dialog"'));
  assert.ok(source.includes('aria-modal="true"'));
  assert.ok(source.includes('aria-labelledby="ai-report-title"'));
  assert.ok(source.includes('aria-expanded={open}'));
  assert.ok(source.includes('aria-controls="ai-report-drawer"'));
  assert.ok(source.includes('role="status"') && source.includes('aria-live="polite"'));
  assert.ok(source.includes("Escape"));
});

test("S01-P5: đủ trạng thái empty/loading/error/disabled/config-required/budget/rate-limited", () => {
  assert.ok(source.includes("Báo cáo AI đang tắt."));
  assert.ok(source.includes("AI unavailable"));
  assert.ok(source.includes("Dashboard P1 vẫn hoạt động bình thường."));
  assert.ok(source.includes("codeToMessage("));
  // Mã lỗi được map trong contract thuần (không rải trong component).
  const contract = readFileSync(new URL("../../lib/ai-report/report-contract.ts", import.meta.url), "utf8");
  for (const code of ["AI_RATE_LIMITED", "AI_BUDGET_LIMITED", "AI_CONFIG_REQUIRED", "AI_IDENTITY_CATALOG_REQUIRED", "AI_DISABLED"]) {
    assert.ok(contract.includes(code), "contract phải map mã " + code);
  }
});

test("S01-P6: double-click không tạo hai job (guard busy + disable)", () => {
  assert.ok(source.includes("if (busy) return;"), "submit phải chặn khi busy");
  assert.ok(source.includes("disabled={busy}"), "nút submit phải disable khi busy");
  assert.ok(source.includes("getController().enqueue("), "submit qua controller (projection enqueue)");
});

test("S01-P7: human review — draft phân biệt, regenerate có xác nhận, approve/reject chờ RPC", () => {
  const reportView = readFileSync(new URL("./report-view.ts", import.meta.url), "utf8");
  assert.ok(reportView.includes("Bản nháp do AI tạo, chưa phải dữ liệu đã duyệt."));
  assert.ok(reportView.includes("lifecycleLabel(lifecycle)"));
  assert.ok(source.includes("Tạo lại báo cáo"));
  assert.ok(source.includes("Lý do tạo lại"));
  assert.ok(source.includes("Lý do tạo lại cần ít nhất 3 ký tự"));
  assert.ok(source.includes("Duyệt"));
  assert.ok(source.includes("Từ chối"));
  assert.ok(source.includes("chờ RPC duyệt revision (W05)"), "approve/reject phải nêu rõ chờ RPC");
});

test("S01-P8: report view hiển thị đủ executive/findings/limitations/evidence/comparison", () => {
  const reportView = readFileSync(new URL("./report-view.ts", import.meta.url), "utf8");
  for (const marker of ["Tóm tắt điều hành", "executive_analysis", "period_ref", "Minh chứng", "Cảnh báo dữ liệu", "overall_limitations", "Giới hạn:", "Đề xuất:"]) {
    assert.ok(reportView.includes(marker), "thiếu " + marker);
  }
  assert.ok(reportView.includes("groupFindings("));
  assert.ok(reportView.includes("findingCategoryLabel("));
  assert.ok(reportView.includes("confidenceLabel("));
});

// ---------------------------------------------------------------------------
// R1 — capability/polling/date/focus behavior
// ---------------------------------------------------------------------------

test("S01-R1-P1: capability null ⇒ skeleton loading; không render/submit form trước khi xác nhận capability", () => {
  assert.ok(source.includes("capability === null ? ("), "phải phân nhánh theo capability null");
  assert.ok(source.includes("<Skeleton />"), "capability null phải hiện skeleton");
  const branchIndex = source.indexOf("capability === null ? (");
  const formIndex = source.indexOf("<form");
  assert.ok(formIndex > branchIndex, "form chỉ render trong nhánh capability đã xác nhận");
  // R2: projection capability nằm ở controller thuần (panel gọi loadCapability).
  const controller = readFileSync(new URL("../../lib/ai-report/report-controller.ts", import.meta.url), "utf8");
  assert.ok(controller.includes("projectCapabilityResponse("), "capability phải qua projection thuần");
  assert.ok(!source.includes("as unknown as CapabilityView"), "không dùng type assertion để tin capability");
});

test("S01-R1-P2: focus trap + restore focus + ngăn focus thoát modal", () => {
  assert.ok(source.includes("resolveTabTarget({"), "phải dùng helper Tab thuần");
  assert.ok(source.includes("drawerRef"), "phải có ref drawer");
  assert.ok(source.includes("tabIndex={-1}"), "drawer phải nhận focus");
  assert.ok(source.includes('document.addEventListener("focusin"'), "phải kéo focus về khi thoát modal");
  assert.ok(source.includes("triggerRef.current?.focus()"), "đóng phải trả focus về trigger");
});

test("S01-R1-P3: polling recursive setTimeout — không setInterval, không chồng request, dừng khi đóng", () => {
  const controller = readFileSync(new URL("../../lib/ai-report/report-controller.ts", import.meta.url), "utf8");
  assert.ok(!/setInterval\(/.test(controller), "không dùng setInterval() (dùng recursive setTimeout)");
  assert.ok(controller.includes("schedule.set(() => { void loop(); }, intervalMs)"), "lịch request kế tiếp chỉ sau khi request trước xong");
  assert.ok(controller.includes("if (gen !== generation) return;"), "stale response bị bỏ theo generation");
  assert.ok(controller.includes("controller.signal.aborted"), "request đang bay bị abort");
  assert.ok(controller.includes("activeController.abort()"), "stopPolling abort request đang bay");
  assert.ok(source.includes("if (!open) getController().stopPolling()"), "đóng drawer phải dừng poll");
});

test("S01-R1-P4: history item cập nhật trạng thái theo poll (không mãi 'requested')", () => {
  assert.ok(
    source.includes('(item.job_id === id ? { ...item, status: view.status } : item)'),
    "poll phải cập nhật status của item history khớp job_id"
  );
});

test("S01-R1-P5: as-of mặc định theo Asia/Ho_Chi_Minh, không dùng toISOString().slice(0,10)", () => {
  assert.ok(source.includes("todayDateIso"), "phải dùng helper timezone");
  assert.ok(source.includes("useState(() => todayDateIso())"), "asOf mặc định từ helper GMT+7");
  assert.ok(!source.includes("toISOString().slice(0, 10)"), "không dùng UTC date");
});

test("S01-R1-P6: projection thuần fail-closed AI_INTERNAL, không render một phần", () => {
  const controller = readFileSync(new URL("../../lib/ai-report/report-controller.ts", import.meta.url), "utf8");
  assert.ok(controller.includes("projectUiReportResponse("), "controller phải project response qua validator thuần");
  assert.ok(controller.includes("projectEnqueueResponse("), "controller phải project enqueue response");
  assert.ok(source.includes('setStatusText("Không đọc được trạng thái báo cáo.")'), "malformed phải báo lỗi");
  assert.ok(source.includes('status: "failed_internal"'), "malformed phải fail-closed");
});

// ---------------------------------------------------------------------------
// R2 — capability strict + regenerate gate
// ---------------------------------------------------------------------------

test("S01-R2-P1: fallback capability lỗi đặt regenerate=false; UI chỉ enable Tạo lại khi review.regenerate===true", () => {
  const controller = readFileSync(new URL("../../lib/ai-report/report-controller.ts", import.meta.url), "utf8");
  assert.ok(controller.includes("regenerate: false"), "fallback capability lỗi phải regenerate=false");
  assert.ok(source.includes("capability?.review.regenerate === true"), "nút Tạo lại phải gate theo review.regenerate");
  assert.ok(source.includes("Tạo lại chưa khả dụng"), "phải có title/lời giải thích khi regenerate=false");
});

test("S01-R2-P2: initial focus — mở modal focus drawer ngay (kể cả capability loading)", () => {
  assert.ok(source.includes("drawerRef.current?.focus()"), "mở modal phải focus drawer ngay");
  assert.ok(source.includes("document.activeElement === drawerRef.current"), "chỉ chuyển focus vào control đầu khi focus vẫn ở drawer");
  assert.ok(source.includes("firstFieldRef.current?.focus()"), "sau capability ready focus control đầu tiên");
});
