import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./ai-settings-panel.tsx", import.meta.url), "utf8");

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

test("S04-P1: panel là client component, không import server-only/@/lib", () => {
  assert.ok(source.includes('"use client"'));
  assert.ok(!/from\s+["']@\/lib\//.test(source), "panel không được import @/lib");
  assert.ok(!source.includes("server-only"), "panel không kéo server-only vào client");
});

test("S04-P2: dùng Radix Dialog/Sheet + AlertDialog + Select (không còn focus trap thủ công)", () => {
  assert.ok(source.includes('from "radix-ui/dialog"'), "phải dùng Radix Dialog");
  assert.ok(source.includes('from "radix-ui/alert-dialog"'), "phải dùng Radix AlertDialog");
  assert.ok(source.includes('from "radix-ui/select"'), "phải dùng Radix Select");
  assert.ok(source.includes("<Dialog.Root"), "phải có Dialog.Root");
  assert.ok(source.includes("<Dialog.Trigger"), "phải có Dialog.Trigger");
  assert.ok(source.includes("<Dialog.Overlay"), "phải có Dialog.Overlay");
  assert.ok(source.includes("<Dialog.Content"), "phải có Dialog.Content");
  assert.ok(source.includes("<Dialog.Title"), "phải có Dialog.Title");
  assert.ok(source.includes("<AlertDialog.Root"), "phải có AlertDialog cho confirm discard/disable");
  // Không còn focus trap thủ công.
  assert.ok(!source.includes("FOCUSABLE_SELECTOR"), "không còn focus trap thủ công");
  assert.ok(!source.includes('addEventListener("keydown"'), "không tự viết Escape handler (Radix quản lý)");
  assert.ok(!source.includes("inert={confirmDiscard}"), "không tự quản lý inert (Radix quản lý)");
});

test("S04-P3: busy chặn dismiss qua decideDismiss; dirty mở AlertDialog confirm", () => {
  assert.ok(source.includes("decideDismiss({ busy, dirty, confirmDiscard })"), "dismiss phải dùng logic thuần decideDismiss");
  assert.ok(source.includes('decision === "blocked"'), "busy phải chặn dismiss");
  assert.ok(source.includes('decision === "confirm"') && source.includes("setConfirmDiscard(true)"), "dirty phải mở confirm");
  assert.ok(source.includes("Bỏ thay đổi chưa lưu?"), "confirm discard phải hỏi rõ");
  assert.ok(source.includes("Ở lại") && source.includes("Bỏ thay đổi"), "confirm có 2 hành động");
});

test("S04-P4: 4 field rõ ràng — profile Select, URL, model, API key password + Eye/EyeOff", () => {
  assert.ok(source.includes("Provider profile"), "có field Provider profile");
  assert.ok(source.includes("OpenAI-compatible"), "profile có mô tả OpenAI-compatible");
  assert.ok(source.includes("API URL"), "có field API URL");
  assert.ok(source.includes("https://api.provider.example/v1"), "URL có placeholder ví dụ");
  assert.ok(source.includes("Bắt buộc HTTPS"), "URL hiển thị yêu cầu HTTPS");
  assert.ok(source.includes("Model"), "có field Model");
  assert.ok(source.includes("API key"), "có field API key");
  assert.ok(source.includes('type={showKey ? "text" : "password"}'), "API key type=password mặc định + toggle");
  assert.ok(source.includes("Eye") && source.includes("EyeOff"), "có nút Eye/EyeOff từ lucide");
  assert.ok(source.includes('autoComplete="new-password"'), "API key autoComplete=new-password");
  assert.ok(source.includes("spellCheck={false}"), "API key tắt spellCheck");
  assert.ok(source.includes("data-1p-ignore"), "API key có data-1p-ignore");
  assert.ok(source.includes("aria-label={showKey ? "), "icon-only eye button có aria-label");
});

test("S04-P5: API key không lộ/persist client; hint giải thích mã hoá server", () => {
  for (const token of ["localStorage", "sessionStorage", "document.cookie", "indexedDB", "console.log", "NEXT_PUBLIC_"]) {
    assert.ok(!source.includes(token), "không được dùng " + token);
  }
  assert.ok(source.includes("API key được mã hóa phía máy chủ và không hiển thị lại sau khi lưu."), "có hint mã hoá server");
  assert.ok(!source.includes("encrypted_secret"), "không render envelope");
  assert.ok(!source.includes("api_base_url"), "không render full URL (chỉ sanitized_host)");
  assert.equal(countOccurrences(source, "value={apiKey}"), 2, "API key chỉ render trong 2 input (form + rotate)");
});

test("S04-P6: luồng 3 bước Save→Test→Activate với điều kiện enable đúng", () => {
  assert.ok(source.includes("flowStepOf"), "dùng flowStepOf");
  assert.ok(source.includes("StepIndicator"), "có chỉ báo bước");
  for (const label of ["Lưu cấu hình", "Kiểm tra kết nối", "Kích hoạt"]) {
    assert.ok(source.includes(label), "có bước " + label);
  }
  assert.ok(source.includes("canSave") && source.includes("canTest") && source.includes("canActivate"), "có điều kiện enable từng bước");
  assert.ok(source.includes('config.status === "verified"'), "Activate chỉ enable khi verified");
  assert.ok(source.includes("canRotate") && source.includes("canDisable"), "có điều kiện rotate/disable");
});

test("S04-P7: config summary sanitized + Badge semantic + advanced actions", () => {
  assert.ok(source.includes("Cấu hình hiện tại"), "có card Cấu hình hiện tại");
  for (const field of ["provider_profile", "sanitized_host", "model", "key_fingerprint", "version", "status", "verified_at", "updated_at"]) {
    assert.ok(source.includes(field), "summary hiển thị " + field);
  }
  assert.ok(source.includes("shortFingerprint") && source.includes(".slice(0, 8)"), "vân tay khoá rút gọn");
  assert.ok(source.includes("Badge"), "có Badge semantic");
  assert.ok(source.includes("Xoay API key"), "có disclosure Xoay API key");
  assert.ok(source.includes("Phiên bản mới sẽ cần kiểm tra kết nối lại"), "rotate yêu cầu verify lại");
  assert.ok(source.includes("Tắt cấu hình AI?"), "disable dùng AlertDialog");
  assert.ok(source.includes("Báo cáo AI sẽ fail-closed"), "disable nêu fail-closed");
  assert.ok(!source.includes("window.confirm"), "không dùng window.confirm");
});

test("S04-P8: gọi đủ 5 endpoint + OCC xử lý version conflict + reload projection", () => {
  for (const endpoint of ["/api/ai/settings", "/api/ai/settings/test", "/api/ai/settings/rotate", "/api/ai/settings/activate", "/api/ai/settings/disable"]) {
    assert.ok(source.includes(endpoint), "gọi " + endpoint);
  }
  assert.ok(source.includes("expected_version"), "gửi expected_version");
  assert.ok(source.includes("AI_VERSION_CONFLICT"), "xử lý version conflict");
  assert.ok(source.includes("409"), "xử lý HTTP 409");
  assert.ok(source.includes("await loadSettings()"), "reload projection sau conflict");
  assert.ok(source.includes("Không kết nối được tới server."), "lỗi mạng fail-closed");
});

test("S04-P9: loading Skeleton + error role=alert + aria-live status", () => {
  assert.ok(source.includes("animate-pulse"), "initial loading dùng skeleton");
  assert.ok(source.includes('role="alert"'), "lỗi nghiêm trọng dùng role=alert");
  assert.ok(source.includes('role="status"') && source.includes('aria-live="polite"'), "status dùng aria-live polite");
  assert.ok(source.includes("aria-invalid="), "field error dùng aria-invalid");
  assert.ok(source.includes("aria-describedby="), "field dùng aria-describedby");
});

test("S04-P10: desktop side panel + mobile full-height + không overflow trang", () => {
  assert.ok(source.includes("sm:w-[30rem]"), "desktop side panel 30rem");
  assert.ok(source.includes("sm:right-0"), "desktop bên phải");
  assert.ok(source.includes("fixed inset-0"), "mobile full-height");
  assert.ok(source.includes("overflow-y-auto"), "nội dung scroll độc lập");
});
