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
  // R1 (A): mọi đường dismiss đi qua requestClose (busy ⇒ không đóng, dirty ⇒ hỏi xác nhận).
  assert.ok(
    source.includes("onClick={requestClose}"),
    "overlay và nút Đóng phải gọi requestClose",
  );
  assert.ok(
    source.includes("apiUrlRef.current ?? drawerRef.current"),
    "khi mở phải focus vào input API URL (fallback: drawer)",
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

// ---------------------------------------------------------------------------
// W04A-R1 (A) — Modal accessibility + secret lifecycle
// ---------------------------------------------------------------------------

test("R1-A1: focus trap thật — Tab/Shift+Tab quay vòng trong drawer, không thoát ra nền", () => {
  assert.ok(source.includes('const FOCUSABLE_SELECTOR'), "phải có selector phần tử focus được");
  assert.ok(source.includes('event.key !== "Tab"'), "phải xử lý phím Tab");
  assert.ok(source.includes("event.shiftKey"), "phải xử lý Shift+Tab");
  assert.ok(countOccurrences(source, "event.preventDefault()") >= 3, "Tab/Escape phải preventDefault để không thoát nền");
  // R2: đích Tab tính bằng logic thuần đã test riêng (ai-settings-panel-logic.test.mjs).
  assert.ok(source.includes("resolveTabTarget({"), "phải tính đích Tab bằng logic thuần");
  assert.ok(source.includes("items[target.index].focus()"), "phải focus theo đích quay vòng");
  assert.ok(source.includes('document.addEventListener("focusin"'), "phải kéo focus về panel nếu nó thoát ra nền");
  assert.ok(source.includes("tabIndex={-1}"), "drawer phải nhận được focus khi không còn phần tử nào focus được");
});

test("R1-A2: busy chặn MỌI đường dismiss (Escape, overlay, nút Đóng, toggle trigger)", () => {
  // R2: busy được kiểm trong decideDismiss (nhánh "blocked") — logic thuần đã test riêng.
  assert.ok(source.includes('decision === "blocked"'), "requestClose phải chặn khi busy");
  assert.ok(!source.includes("onClick={closeDrawer}"), "không còn đường đóng trực tiếp bỏ qua guard");
  assert.ok(source.includes("onClick={requestClose}"), "overlay/nút Đóng phải đi qua requestClose");
  const escapeBlock = source.slice(source.indexOf('event.key === "Escape"'), source.indexOf('event.key === "Escape"') + 400);
  assert.ok(escapeBlock.includes("requestClose()"), "Escape phải đi qua requestClose (busy ⇒ không đóng)");
  assert.ok(source.includes("if (open) {") && source.includes("requestClose();"), "toggle trigger cũng phải đi qua requestClose");
});

test("R1-A3: dirty state theo dõi URL/model/profile/API key và hỏi xác nhận khi đóng", () => {
  assert.ok(source.includes("const dirty ="), "phải có dirty state");
  for (const part of ["apiKey.length > 0", "apiUrl.trim().length > 0", "model.trim() !== (config?.model", "providerProfile.trim()"]) {
    assert.ok(source.includes(part), "dirty phải theo dõi: " + part);
  }
  assert.ok(source.includes('role="alertdialog"'), "phải có hộp xác nhận bỏ thay đổi");
  assert.ok(source.includes("Bỏ thay đổi chưa lưu?"), "phải hỏi rõ trước khi bỏ thay đổi");
  assert.ok(source.includes("Bỏ thay đổi") && source.includes("Ở lại"), "phải có hai lựa chọn Bỏ thay đổi / Ở lại");
  // R2: quyết định dismiss nằm ở logic thuần; dirty ⇒ nhánh "confirm" mở hộp xác nhận.
  assert.ok(source.includes("decideDismiss({ busy, dirty, confirmDiscard })"), "phải dùng decideDismiss cho mọi đường dismiss");
  assert.ok(source.includes('decision === "confirm"') && source.includes("setConfirmDiscard(true)"), "đóng khi dirty phải mở xác nhận");
});

test("R1-A4: xác nhận bỏ ⇒ clear API key NGAY và reset form về server state", () => {
  const discardBlock = source.slice(source.indexOf("const discardChanges"), source.indexOf("const discardChanges") + 420);
  assert.ok(discardBlock.includes('setApiKey("")'), "discardChanges phải clear API key ngay");
  assert.ok(discardBlock.includes("resetFormToServerState(config)"), "discardChanges phải reset form về server state");
  assert.ok(discardBlock.indexOf('setApiKey("")') < discardBlock.indexOf("performClose()"), "clear key phải xảy ra TRƯỚC khi đóng");
  const resetBlock = source.slice(source.indexOf("const resetFormToServerState"), source.indexOf("const resetFormToServerState") + 320);
  assert.ok(resetBlock.includes('setApiUrl("")'), "reset phải xoá API URL đang nhập");
  assert.ok(resetBlock.includes('setApiKey("")'), "reset phải xoá API key");
  assert.ok(resetBlock.includes("next?.model ?? \"\""), "reset phải đưa model về giá trị server");
});

test("R1-A5: không lưu secret vào bất kỳ persistence nào của browser", () => {
  for (const forbidden of ["localStorage", "sessionStorage", "document.cookie", "indexedDB"]) {
    assert.ok(!source.includes(forbidden), "panel không được dùng " + forbidden);
  }
  assert.equal(countOccurrences(source, "value={apiKey}"), 1, "API key chỉ được render trong input password");
});

// ---------------------------------------------------------------------------
// W04A-R2 (D) — alertdialog thực sự modal
// ---------------------------------------------------------------------------

test("R2-D5: alertdialog xác nhận có semantics modal và khoá nội dung phía sau", () => {
  assert.ok(source.includes('role="alertdialog"'), "phải dùng role=alertdialog");
  assert.ok(source.includes('aria-modal="true"'), "alertdialog phải khai báo aria-modal");
  assert.ok(source.includes("inert={confirmDiscard}"), "nội dung phía sau phải bị inert khi confirm mở");
  assert.ok(source.includes("aria-hidden={confirmDiscard}"), "nội dung phía sau phải aria-hidden khi confirm mở");
  assert.ok(
    source.includes('(node) => node.getAttribute("aria-hidden") !== "true" && !node.closest("[inert]")'),
    "vòng focus phải loại các phần tử nằm trong vùng inert",
  );
  assert.ok(source.includes("confirmDiscardRef.current?.focus()"), "phải chuyển focus vào nút trong alertdialog");
  assert.ok(source.includes("resolveTabTarget(") && source.includes("decideDismiss("), "phải dùng logic thuần đã test");
});

test("R2-D6: Escape trong confirm = Ở lại; Ở lại phục hồi focus; Bỏ thay đổi clear key trước khi đóng", () => {
  const requestCloseBlock = source.slice(source.indexOf("const requestClose = useCallback"), source.indexOf("const discardChanges"));
  assert.ok(requestCloseBlock.includes('decision === "stay"'), "Escape/overlay khi confirm mở phải đi nhánh stay");
  assert.ok(requestCloseBlock.indexOf('decision === "blocked"') < requestCloseBlock.indexOf("stayInDrawer()"), "busy phải được kiểm TRƯỚC mọi nhánh đóng");
  assert.ok(requestCloseBlock.indexOf("stayInDrawer()") < requestCloseBlock.indexOf("performClose()"), "confirm phải chặn trước khi đóng drawer");

  const stayBlock = source.slice(source.indexOf("const stayInDrawer"), source.indexOf("const stayInDrawer") + 260);
  assert.ok(stayBlock.includes("setConfirmDiscard(false)"), "Ở lại phải đóng confirm");
  assert.ok(!stayBlock.includes("setOpen(false)"), "Ở lại KHÔNG được đóng drawer");
  assert.ok(stayBlock.includes("closeButtonRef.current"), "Ở lại phải phục hồi focus hợp lý");

  const discardBlock = source.slice(source.indexOf("const discardChanges"), source.indexOf("const discardChanges") + 420);
  assert.ok(discardBlock.indexOf('setApiKey("")') < discardBlock.indexOf("performClose()"), "clear API key phải trước khi đóng");
});

// ---------------------------------------------------------------------------
// W04A-R3 (C) — alertdialog modal thật: toàn bộ nền drawer nằm trong vùng inert
// ---------------------------------------------------------------------------

test("R3-C1: nút Đóng + header + status + section + form đều nằm TRONG vùng inert của nền drawer", () => {
  const start = source.indexOf("{/* background-inert-start */}");
  const end = source.indexOf("{/* background-inert-end */}");
  assert.ok(start > 0, "phải có marker bắt đầu vùng nền");
  assert.ok(end > start, "phải có marker kết thúc vùng nền");

  const background = source.slice(start, end);
  for (const marker of [
    "<header",
    "Đóng",
    'role="status"',
    "Cấu hình hiện tại",
    "<form",
    "Lưu cấu hình",
    "Kiểm tra kết nối",
    "Xoay API key",
    "Kích hoạt",
    "Tắt cấu hình",
  ]) {
    assert.ok(background.includes(marker), "vùng nền phải chứa: " + marker);
  }
  assert.ok(background.includes("inert={confirmDiscard}"), "vùng nền phải inert theo confirmDiscard");
  assert.ok(background.includes("aria-hidden={confirmDiscard}"), "vùng nền phải aria-hidden theo confirmDiscard");
  assert.ok(background.indexOf("closeButtonRef") > 0, "nút Đóng phải nằm TRONG vùng nền inert");

  // alertdialog là thành phần DUY NHẤT ngoài vùng nền.
  const alertIndex = source.indexOf('role="alertdialog"');
  assert.ok(alertIndex > 0 && alertIndex < start, "alertdialog phải nằm ngoài (trước) vùng nền");
  assert.equal(background.includes('role="alertdialog"'), false, "alertdialog KHÔNG được nằm trong vùng inert");
  assert.ok(source.includes("Bỏ thay đổi") && source.includes("Ở lại"), "alertdialog có hai nút hành động");
});

test("R3-C2: focus programmatic ngoài alertdialog bị kéo về nút mặc định; vòng focus lọc vùng inert", () => {
  assert.ok(source.includes('!node.closest("[inert]")'), "vòng focus phải loại phần tử trong vùng inert");
  assert.ok(source.includes("ref={alertDialogRef}"), "alertdialog phải có ref để kiểm containment");

  const focusInBlock = source.slice(source.indexOf("const onFocusIn"), source.indexOf("const onFocusIn") + 800);
  assert.ok(focusInBlock.includes("if (confirmDiscard)"), "focusin phải xử lý riêng khi alertdialog mở");
  assert.ok(focusInBlock.includes("alertDialogRef.current.contains(node)"), "phải kiểm node có nằm trong alertdialog");
  assert.ok(focusInBlock.includes("confirmDiscardRef.current?.focus()"), "focus ngoài alertdialog phải kéo về nút mặc định");
});

test("R3-C3: Escape = Ở lại và busy chặn dismiss (nhánh quyết định trong handler)", () => {
  assert.ok(source.includes('decision === "stay"') && source.includes("stayInDrawer()"), "Escape trong confirm phải là Ở lại");
  assert.ok(source.includes('decision === "blocked"'), "busy phải chặn dismiss");
  assert.ok(source.includes("if (open && !confirmDiscard)") === false, "không cần nhánh phụ");
});
