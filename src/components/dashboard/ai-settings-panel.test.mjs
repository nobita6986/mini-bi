import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./ai-settings-panel.tsx", import.meta.url), "utf8");

/** Đếm số lần xuất hiện của một chuỗi con trong source. */
function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

test("panel là client component và không import module server-only", () => {
  assert.ok(source.includes('"use client"'), 'panel phải có directive "use client" ở đầu file');
  assert.ok(
    !/from\s+["']@\/lib\//.test(source),
    "panel không được import bất kỳ module nào từ @/lib (đặc biệt @/lib/ai hoặc @/lib/ai-config)",
  );
  assert.ok(
    !source.includes("server-only"),
    "panel không được kéo theo module server-only vào client bundle",
  );
});

test("nút mở có aria-expanded/aria-controls và drawer có đủ ARIA dialog", () => {
  assert.ok(source.includes("Cấu hình AI"), 'nút mở phải có nhãn "Cấu hình AI"');
  assert.ok(source.includes("aria-expanded={open}"), "nút mở phải phản ánh trạng thái qua aria-expanded");
  assert.ok(
    source.includes('aria-controls="ai-settings-drawer"'),
    "nút mở phải trỏ tới drawer bằng aria-controls=\"ai-settings-drawer\"",
  );
  assert.ok(source.includes('role="dialog"'), 'drawer phải có role="dialog"');
  assert.ok(source.includes('aria-modal="true"'), 'drawer phải có aria-modal="true"');
  assert.ok(
    source.includes('aria-labelledby="ai-settings-title"'),
    'drawer phải có aria-labelledby="ai-settings-title"',
  );
  assert.ok(source.includes('id="ai-settings-drawer"'), "drawer phải có id khớp với aria-controls");
  assert.ok(source.includes('id="ai-settings-title"'), "tiêu đề drawer phải có id khớp với aria-labelledby");
  assert.ok(
    source.includes("{open ? ("),
    "drawer chỉ được render khi open (không render thường trú)",
  );
});

test("drawer đóng được bằng Escape, bằng nút Đóng và bằng click overlay", () => {
  assert.ok(
    source.includes("Escape") || source.includes("keydown"),
    "phải có xử lý phím Escape (keydown) để đóng drawer",
  );
  assert.ok(
    source.includes('addEventListener("keydown"'),
    "phải đăng ký listener keydown để bắt Escape",
  );
  assert.ok(source.includes("Đóng"), 'phải có nút "Đóng"');
  assert.ok(
    source.includes("onClick={closeDrawer}"),
    "overlay và nút Đóng phải gọi closeDrawer",
  );
  assert.ok(
    source.includes("apiUrlRef.current?.focus()"),
    "khi mở phải focus vào input API URL",
  );
  assert.ok(
    source.includes("triggerRef.current?.focus()"),
    "khi đóng phải trả focus về nút mở",
  );
  assert.ok(
    source.includes("sm:inset-y-0 sm:right-0") && source.includes("sm:w-[26rem]"),
    "desktop phải là drawer bên phải rộng 26rem, mobile full-screen",
  );
  assert.ok(source.includes("fixed inset-0"), "mobile phải full-screen bằng fixed inset-0");
});

test("khi mở panel gọi GET /api/ai/settings với credentials/cache/headers an toàn", () => {
  assert.ok(source.includes('"/api/ai/settings"'), "phải gọi endpoint /api/ai/settings");
  assert.ok(
    source.includes('credentials: "same-origin"'),
    'fetch phải dùng credentials: "same-origin"',
  );
  assert.ok(source.includes('cache: "no-store"'), 'fetch phải dùng cache: "no-store"');
  assert.ok(source.includes('accept: "application/json"'), 'fetch phải gửi header accept: application/json');
  assert.ok(source.includes('role="status"') && source.includes('aria-live="polite"'), 'phải có vùng trạng thái aria-live="polite"');
});

test("input API key là password, không autofill, có hint aria-describedby", () => {
  assert.ok(source.includes('type="password"'), 'input API key phải có type="password"');
  assert.ok(source.includes('autoComplete="off"'), 'input API key phải có autoComplete="off"');
  assert.ok(source.includes("spellCheck={false}"), "input API key phải tắt spellCheck");
  assert.ok(source.includes("data-1p-ignore"), "input API key phải có data-1p-ignore");
  assert.ok(
    source.includes('aria-describedby="ai-api-key-hint"'),
    "input API key phải trỏ tới hint bằng aria-describedby",
  );
  assert.ok(
    source.includes('id="ai-api-key-hint"') &&
      source.includes("Khoá chỉ được mã hoá ở server, không hiển thị lại"),
    "hint của API key phải tồn tại với nội dung tiếng Việt đã yêu cầu",
  );
  assert.ok(source.includes('type="url"'), "input API URL phải có type=\"url\"");
});

test("mọi input đều có label htmlFor tương ứng", () => {
  const labels = [
    ["ai-provider-profile", "provider profile"],
    ["ai-api-url", "API URL"],
    ["ai-model", "model"],
    ["ai-api-key", "API key"],
  ];
  for (const [id, name] of labels) {
    assert.ok(
      source.includes('htmlFor="' + id + '"'),
      "input " + name + " phải có <label htmlFor=\"" + id + "\">",
    );
    assert.ok(source.includes('id="' + id + '"'), "input " + name + " phải có id=\"" + id + "\" khớp label");
  }
});

test("xoá API key khỏi state ngay sau khi Lưu hoặc Xoay thành công", () => {
  assert.ok(
    source.includes('setApiKey("")'),
    'phải gọi setApiKey("") để xoá API key khỏi state sau khi lưu/xoay thành công',
  );
});

test("không lưu trữ bền, không log, không lộ secret qua biến môi trường public", () => {
  const forbidden = ["localStorage", "sessionStorage", "document.cookie", "console.log", "NEXT_PUBLIC_"];
  for (const token of forbidden) {
    assert.ok(!source.includes(token), "source không được chứa " + token);
  }
  assert.ok(!/console\.(error|warn|info|debug)/.test(source), "source không được log ra console");
  assert.ok(!source.includes("?api_key"), "api_key không được đưa vào query string");
  assert.ok(!source.includes("&api_key"), "api_key không được đưa vào query string");
  assert.equal(
    countOccurrences(source, "api_key"),
    3,
    "api_key chỉ được xuất hiện 3 lần: 2 JSON body (Lưu/Xoay) và 1 tên field input",
  );
  assert.equal(
    countOccurrences(source, "api_key:"),
    2,
    "api_key chỉ được đưa vào JSON body của Lưu cấu hình và Xoay API key",
  );
  assert.equal(
    countOccurrences(source, 'name="api_key"'),
    1,
    "api_key chỉ được khai báo một lần với vai trò tên field của input",
  );
});

test("không hiển thị API key: chỉ đúng một value={apiKey} cho input password", () => {
  const uses = countOccurrences(source, "value={apiKey}");
  assert.equal(uses, 1, "chỉ được có đúng 1 lần value={apiKey} (input password), hiện có " + uses);
  assert.ok(!source.includes("encrypted_secret"), "không được render trường secret đã mã hoá");
  assert.ok(!source.includes("api_base_url"), "không được render api_base_url thô; chỉ dùng sanitized_host");
});

test("chỉ hiển thị các trường đã sanitize của config", () => {
  for (const field of [
    "provider_profile",
    "sanitized_host",
    "model",
    "key_fingerprint",
    "version",
    "status",
    "verified_at",
    "last_tested_at",
    "updated_at",
  ]) {
    assert.ok(source.includes(field), "panel phải hiển thị trường " + field);
  }
  assert.ok(source.includes(".slice(0, 8)") && source.includes("…"), "vân tay khoá phải rút gọn 8 ký tự đầu + dấu ba chấm");
});

test("gọi đủ 5 endpoint của API cấu hình AI", () => {
  const endpoints = [
    "/api/ai/settings",
    "/api/ai/settings/test",
    "/api/ai/settings/rotate",
    "/api/ai/settings/activate",
    "/api/ai/settings/disable",
  ];
  for (const endpoint of endpoints) {
    assert.ok(source.includes(endpoint), "panel phải gọi endpoint " + endpoint);
  }
});

test("optimistic concurrency: gửi expected_version và xử lý AI_VERSION_CONFLICT", () => {
  assert.ok(source.includes("expected_version"), "body Lưu/Xoay phải gửi expected_version");
  assert.ok(
    source.includes("config?.version ?? null"),
    "expected_version phải là config?.version ?? null",
  );
  assert.ok(source.includes("AI_VERSION_CONFLICT"), "phải xử lý mã lỗi AI_VERSION_CONFLICT");
  assert.ok(source.includes("409"), "phải xử lý HTTP 409 như xung đột phiên bản");
  assert.ok(
    source.includes("Cấu hình đã thay đổi ở phiên khác, đang tải lại…"),
    "phải hiển thị cảnh báo xung đột phiên bản bằng tiếng Việt",
  );
  assert.ok(
    source.includes("await loadSettings()"),
    "sau xung đột phiên bản phải gọi lại GET /api/ai/settings",
  );
});

test("mọi nút đều disable khi đang bận", () => {
  const disabled = countOccurrences(source, "disabled={busy");
  assert.ok(disabled >= 6, "các nút Lưu/Kiểm tra/Xoay/Kích hoạt/Tắt/Đóng phải disable khi busy, hiện có " + disabled);
});

test("dùng token Tailwind sẵn có của repo", () => {
  for (const token of ["bg-surface", "text-foreground", "text-muted", "border-border", "rounded-2xl", "bg-primary", "text-on-primary"]) {
    assert.ok(source.includes(token), "phải dùng token Tailwind " + token);
  }
});

test("toàn bộ nhãn nút chính là tiếng Việt theo yêu cầu", () => {
  for (const label of ["Lưu cấu hình", "Kiểm tra kết nối", "Xoay API key", "Kích hoạt", "Tắt cấu hình"]) {
    assert.ok(source.includes(label), 'phải có nút "' + label + '"');
  }
});
