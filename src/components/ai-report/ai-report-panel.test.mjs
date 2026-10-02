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
  assert.ok(source.includes('"/api/ai/reports/capability"'));
  assert.ok(source.includes('"/api/ai/reports"'));
  assert.ok(source.includes('"/analysis"'));
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
  assert.ok(source.includes("request_id ?? result.record.job_id"), "dùng id idempotent trả về");
});

test("S01-P7: human review — draft phân biệt, regenerate có xác nhận, approve/reject chờ RPC", () => {
  assert.ok(source.includes("Bản nháp do AI tạo, chưa phải dữ liệu đã duyệt."));
  assert.ok(source.includes("lifecycleLabel(lifecycle)"));
  assert.ok(source.includes("Tạo lại báo cáo"));
  assert.ok(source.includes("Lý do tạo lại"));
  assert.ok(source.includes("Lý do tạo lại cần ít nhất 3 ký tự"));
  assert.ok(source.includes("Duyệt"));
  assert.ok(source.includes("Từ chối"));
  assert.ok(source.includes("chờ RPC duyệt revision (W05)"), "approve/reject phải nêu rõ chờ RPC");
});

test("S01-P8: report view hiển thị đủ executive/findings/limitations/evidence/comparison", () => {
  for (const marker of ["Tóm tắt điều hành", "executive_analysis", "period_ref", "Minh chứng", "Cảnh báo dữ liệu", "overall_limitations", "Giới hạn:", "Đề xuất:"]) {
    assert.ok(source.includes(marker), "thiếu " + marker);
  }
  assert.ok(source.includes("groupFindings("));
  assert.ok(source.includes("findingCategoryLabel("));
  assert.ok(source.includes("confidenceLabel("));
});
