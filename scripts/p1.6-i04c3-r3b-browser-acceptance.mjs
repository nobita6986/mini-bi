#!/usr/bin/env node
/**
 * P1.6-I04C3-R3B - Interactive browser component acceptance.
 *
 * THAT:
 *  - next dev THAT cua app nay compile CHINH component production
 *    (DirectEntryLive + dialog "Dan ho so tu Excel" + cot/CCCD manager).
 *  - Chrome headless THAT, dieu khien qua CDP (chuot/ban phim that).
 *  - HTTP duoc chan trong trang bang router trong bo nho voi du lieu GIA (synthetic).
 *
 * KHONG:
 *  - khong phai Production route UAT, khong authenticated Production acceptance,
 *    khong R2 acceptance, khong DB. Khong backdoor/env seam nao trong production code.
 *
 * Fixture duoc copy vao src/app/r3b-harness/page.tsx va bi XOA trong finally.
 *
 * Usage: node scripts/p1.6-i04c3-r3b-browser-acceptance.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHROME = process.env.R3B_CHROME ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUTDIR = path.join(ROOT, "docs", "acceptance", "p1.6-i04c3-r3b");
const HARNESS_DIR = path.join(ROOT, "src", "app", "r3b-harness");
const HARNESS_FILE = path.join(HARNESS_DIR, "page.tsx");
const ROUTE = "/r3b-harness";

const checks = [];
function check(scope, name, ok, detail) {
  checks.push({ scope, name, ok: ok === true, detail: detail === undefined ? null : detail });
}

/* --------------------------------------------------------------- fixtures */

const HEADER = ["Mã NLĐ", "Dự án", "Ngày bắt đầu làm việc", "Họ và tên", "Tên NV Tuyển dụng",
  "Loại hình LĐ", "Giới tính", "DOB", "CMT/CCCD", "Ngày cấp", "Nơi cấp", "Địa chỉ hiện tại",
  "Số điện thoại", "Ghi chú", "Tình trạng làm việc hiện tại", "STK", "Tên ngân hàng",
  "Tên chủ tài khoản"];

function tsv(rows) {
  const header = [];
  for (const pairs of rows) {
    for (const [name] of pairs) if (!header.includes(name)) header.push(name);
  }
  const lines = rows.map((pairs) => {
    const map = new Map(pairs);
    return header.map((name) => (map.has(name) ? map.get(name) : "")).join("\t");
  });
  return [header.join("\t"), ...lines].join("\n");
}

function profileRow(code, overrides = {}) {
  const base = [["Mã NLĐ", code], ["Dự án", "Dự án Giả Bắc"],
    ["Ngày bắt đầu làm việc", "2026-10-15"], ["Họ và tên", "Nguyễn Văn Giả A"],
    ["Tên NV Tuyển dụng", "Tuyển Dụng Giả 1"], ["Loại hình LĐ", "Thời vụ"]];
  const pairs = base.map(([header, value]) => [header, overrides[header] ?? value]);
  for (const [header, value] of Object.entries(overrides)) {
    if (!base.some(([existing]) => existing === header)) pairs.push([header, value]);
  }
  return pairs;
}

const MINIMAL = tsv([profileRow("hrp-2026-000101")]);
const THREE_ROWS = tsv([profileRow("hrp-2026-000101"), profileRow("hrp-2026-000102"),
  profileRow("hrp-2026-000103")]);
const FULL = tsv([profileRow("hrp-2026-000201", {
  "Giới tính": "Nữ", DOB: "20/05/1990", "CMT/CCCD": "012345678901", "Ngày cấp": "2020-06-01",
  "Nơi cấp": "Cục Cảnh sát Giả", "Địa chỉ hiện tại": "Số 1 Đường Giả",
  "Số điện thoại": "0900000001", "Ghi chú": "Ghi chú giả",
  "Tình trạng làm việc hiện tại": "Đang làm", STK: "000123456789",
  "Tên ngân hàng": "Ngân hàng Giả", "Tên chủ tài khoản": "NGUYEN VAN GIA A",
})]);
const SHUFFLED = tsv([[
  ["Tên NV Tuyển dụng", "Tuyển Dụng Giả 1"], ["Họ và tên", "Nguyễn Văn Giả A"],
  ["Loại hình LĐ", "Thời vụ"], ["Mã NLĐ", "hrp-2026-000301"], ["Dự án", "Dự án Giả Bắc"],
  ["Ngày bắt đầu làm việc", "15/10/2026"],
]]);
const ALIAS = tsv([[
  ["Mã số ứng viên", "hrp-2026-000401"], ["Dự án", "Dự án Giả Bắc"],
  ["Ngày bắt đầu làm việc", "2026-10-15"], ["Họ và tên", "Nguyễn Văn Giả A"],
  ["Tên NV Tuyển dụng", "Tuyển Dụng Giả 1"], ["Loại hình LĐ", "Thời vụ"],
]]);
const BAD_CELL = [HEADER.join("\t"), [
  "hrp-2026-000501", "Dự án Giả Bắc", "2026-10-15", "Nguyễn Văn Giả A", "Tuyển Dụng Giả 1",
  "Thời vụ", "Nam", "1990-05-20", "12345", "", "", "", "", "", "", "", "", ""].join("\t"),
].join("\n");
const UNKNOWN_HEADER = [["Mã NLĐ", "Dự án", "Ngày bắt đầu làm việc", "Họ và tên",
  "Tên NV Tuyển dụng", "Loại hình LĐ", "Cột lạ"].join("\t"),
["hrp-2026-000601", "Dự án Giả Bắc", "2026-10-15", "Nguyễn Văn Giả A", "Tuyển Dụng Giả 1",
  "Thời vụ", "x"].join("\t")].join("\n");
const DUPLICATE_HEADER = [["Mã NLĐ", "Mã số ứng viên", "Dự án", "Ngày bắt đầu làm việc",
  "Họ và tên", "Tên NV Tuyển dụng", "Loại hình LĐ"].join("\t"),
["hrp-2026-000701", "hrp-2026-000701", "Dự án Giả Bắc", "2026-10-15", "Nguyễn Văn Giả A",
  "Tuyển Dụng Giả 1", "Thời vụ"].join("\t")].join("\n");
const UNRESOLVED = tsv([profileRow("hrp-2026-000801", { "Dự án": "Dự án Không Có Trong Danh Mục" })]);
const PAYMENT_ROW = tsv([profileRow("hrp-2026-000901", { STK: "000123456789",
  "Tên ngân hàng": "Ngân hàng Giả", "Tên chủ tài khoản": "NGUYEN VAN GIA A" })]);
const MIXED_PAYMENT = tsv([profileRow("hrp-2026-001001"), profileRow("hrp-2026-001002", {
  STK: "000123456789", "Tên ngân hàng": "Ngân hàng Giả",
  "Tên chủ tài khoản": "NGUYEN VAN GIA A" })]);

/* ------------------------------------------------------------------ chrome */

async function pickPort() {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => resolve(), 2000);
    child.on("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return true;
    } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function readDevToolsPort(profile) {
  const fs = await import("node:fs/promises");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const data = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8");
      const port = data.split(/\r?\n/)[0].trim();
      if (port) return port;
    } catch { /* not ready */ }
  }
  throw new Error("DevToolsActivePort unavailable");
}

async function attach(devtoolsPort) {
  const target = await (await fetch("http://127.0.0.1:" + devtoolsPort + "/json/new?about:blank",
    { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const consoleMessages = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
      consoleMessages.push((message.params.args ?? []).map((arg) => String(arg.value)).join(" "));
    }
    if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
      consoleMessages.push("log: " + String(message.params.entry.text));
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");
  return { socket, send, consoleMessages };
}

async function evaluate(send, expression, awaitPromise) {
  const result = await send("Runtime.evaluate", {
    expression, awaitPromise: awaitPromise === true, returnByValue: true,
  });
  if (result.result?.exceptionDetails) {
    throw new Error("evaluate failed: " + JSON.stringify(
      result.result.exceptionDetails.exception?.description ??
      result.result.exceptionDetails.text));
  }
  return result.result?.result?.value;
}

const api = (send, expression) => evaluate(send, "window.__r3b." + expression);
const apiAsync = (send, expression) => evaluate(send, "window.__r3b." + expression, true);

async function waitFor(send, expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(send, expression);
    if (value === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

async function pressEscape(send) {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape",
    windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape",
    windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
}

async function setViewport(send, width, height) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1,
    mobile: width < 500 });
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function screenshot(send, name) {
  const captured = await send("Page.captureScreenshot", { format: "png",
    captureBeyondViewport: true });
  const file = path.join(OUTDIR, name + ".png");
  writeFileSync(file, Buffer.from(captured.result.data, "base64"));
  return { name, bytes: readFileSync(file).length };
}

/* --------------------------------------------------------------- scenarios */

/** Mo dialog va cho portal mount. Lan mo dau tien co the phai cho Turbopack bien dich chunk. */
async function openDialog(send) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await api(send, "openDialog()");
    const opened = await waitFor(send, "window.__r3b.dialogOpen() === true", 30000);
    if (opened) return true;
  }
  return false;
}

async function paste(send, text) {
  await api(send, "setText(" + JSON.stringify(text) + ")");
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function submit(send) {
  await api(send, 'click("profile-submit")');
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function runScenarios(send, shots, consoleMessages) {
  // --- S1: mo/dong dialog, Escape, focus return ---
  // Turbopack dev bien dich chunk client theo yeu cau, nen phai cho hydrate xong.
  const hydrated = await waitFor(send, 'typeof window.__r3b === "object"', 90000);
  check("interactive", "harness hydrate component that (client bundle da chay)", hydrated);
  const ready = await waitFor(send,
    'document.querySelector(\'[data-testid="profile-paste-open"]\') !== null', 15000);
  check("interactive", "nut mo dialog duoc render", ready);
  check("interactive", "mo dialog bang nut 'Dan ho so tu Excel'", await openDialog(send));
  await paste(send, MINIMAL);
  await pressEscape(send);
  check("interactive", "Escape dong dialog",
    await waitFor(send, "window.__r3b.dialogOpen() === false", 5000));
  const focusBack = await waitFor(send,
    'window.__r3b.activeTestId() === "profile-paste-open"', 10000);
  check("interactive", "focus tra ve nut mo sau Escape", focusBack,
    { activeTestId: await api(send, "activeTestId()"),
      tag: await evaluate(send, "document.activeElement?.tagName ?? null"),
      text: String(await evaluate(send, "document.activeElement?.textContent ?? null")).slice(0, 60) });

  // --- S2: minimal profile ---
  await openDialog(send);
  await paste(send, MINIMAL);
  await waitFor(send, "window.__r3b.submitDisabled() === false");
  check("interactive", "minimal profile: CTA bat", (await api(send, "submitDisabled()")) === false);
  check("interactive", "minimal profile: summary co 1 dong",
    String(await api(send, "summary()")).includes("1 dòng"), await api(send, "summary()"));
  check("interactive", "minimal profile: preview co 1 card",
    (await api(send, "rowCount()")) === 1);
  shots.desktop = await screenshot(send, "full-profile-paste-preview-desktop");

  // --- S3: full profile + masked PII ---
  await paste(send, FULL);
  await api(send, 'click("profile-detail-toggle-2")');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const detailText = String(await api(send, "bodyText()"));
  check("interactive", "full profile: hien du 5 section",
    ["Công việc", "Hồ sơ cá nhân", "Tình trạng làm việc", "Thanh toán", "Validation-only"]
      .every((section) => detailText.includes(section)));
  check("interactive", "full profile: CCCD duoc mask", detailText.includes("••••••••8901"));
  check("interactive", "full profile: khong lo raw CCCD", !detailText.includes("012345678901"));
  check("interactive", "full profile: STK duoc mask", detailText.includes("••••••••6789"));
  check("interactive", "full profile: khong lo raw STK", !detailText.includes("000123456789"));

  // --- S4: thu tu cot tuy y ---
  await paste(send, SHUFFLED);
  await waitFor(send, "window.__r3b.submitDisabled() === false");
  check("interactive", "thu tu cot tuy y: CTA bat", (await api(send, "submitDisabled()")) === false);

  // --- S5: alias Ma so ung vien ---
  await paste(send, ALIAS);
  await waitFor(send, "window.__r3b.submitDisabled() === false");
  check("interactive", "alias 'Ma so ung vien' duoc chap nhan",
    (await api(send, "submitDisabled()")) === false);
  check("interactive", "UI khong hien 'Ma so ung vien'",
    !String(await api(send, "bodyText()")).includes("Mã số ứng viên"));

  // --- S6: loi theo cell ---
  await paste(send, BAD_CELL);
  await new Promise((resolve) => setTimeout(resolve, 300));
  check("interactive", "loi CMT/CCCD chan submit", (await api(send, "submitDisabled()")) === true);
  check("interactive", "loi hien theo dong/cot",
    String(await api(send, "bodyText()")).includes("CMT/CCCD phải gồm đúng 9 hoặc 12 chữ số"),
    await api(send, "bodyText()"));
  check("interactive", "summary loi dung role=alert",
    (await evaluate(send, 'document.querySelector(\'[data-testid="profile-summary"]\')?.getAttribute("role")')) === "alert");
  shots.error = await screenshot(send, "full-profile-validation-error");

  // --- S7: unknown/duplicate header ---
  await paste(send, UNKNOWN_HEADER);
  await new Promise((resolve) => setTimeout(resolve, 300));
  check("interactive", "unknown header fail closed",
    (await api(send, "submitDisabled()")) === true &&
    String(await api(send, "bodyText()")).includes("không thuộc danh sách hỗ trợ"));
  await paste(send, DUPLICATE_HEADER);
  await new Promise((resolve) => setTimeout(resolve, 300));
  check("interactive", "duplicate header fail closed",
    (await api(send, "submitDisabled()")) === true &&
    String(await api(send, "bodyText()")).includes("cùng trỏ về một trường dữ liệu"));

  // --- S8: catalog resolve / unresolved ---
  await paste(send, MINIMAL);
  await waitFor(send, "window.__r3b.submitDisabled() === false");
  check("interactive", "catalog resolve thanh cong: CTA bat",
    (await api(send, "submitDisabled()")) === false);
  await paste(send, UNRESOLVED);
  await new Promise((resolve) => setTimeout(resolve, 400));
  check("interactive", "catalog unresolved: CTA tat",
    (await api(send, "submitDisabled()")) === true);
  check("interactive", "catalog unresolved: co blocker ro",
    JSON.stringify(await api(send, "blockers()")).includes("chưa đối chiếu được dự án"),
    await api(send, "blockers()"));

  // --- S9/S10: banks=0 ---
  await api(send, "setBanks([])");
  await apiAsync(send, "remount()");
  await waitFor(send, 'document.querySelector(\'[data-testid="profile-paste-open"]\') !== null', 15000);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await openDialog(send);
  await paste(send, MINIMAL);
  await waitFor(send, "window.__r3b.submitDisabled() === false");
  check("interactive", "banks=0 + non-payment: CTA van bat",
    (await api(send, "submitDisabled()")) === false);

  await paste(send, PAYMENT_ROW);
  await new Promise((resolve) => setTimeout(resolve, 400));
  check("interactive", "banks=0 + payment-bearing: CTA tat",
    (await api(send, "submitDisabled()")) === true);
  check("interactive", "banks=0 + payment-bearing: blocker ro",
    JSON.stringify(await api(send, "blockers()")).includes("ngân hàng đang hoạt động"),
    await api(send, "blockers()"));
  shots.paymentBlocked = await screenshot(send, "full-profile-payment-blocked-banks-empty");

  await paste(send, MIXED_PAYMENT);
  await new Promise((resolve) => setTimeout(resolve, 400));
  check("interactive", "mixed batch co 1 dong payment-bearing: chan ca nhom",
    (await api(send, "submitDisabled()")) === true);

  // --- S11..S14: batch that ---
  await api(send, "setBanks([{ bank_id: '33333333-3333-4333-8333-333333333333', display_name: 'Ngân hàng Giả' }])");
  await apiAsync(send, "remount()");
  await waitFor(send, 'document.querySelector(\'[data-testid="profile-paste-open"]\') !== null', 15000);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await api(send, "setBatch({ mode: 'success' })");
  await openDialog(send);
  await paste(send, THREE_ROWS);
  await waitFor(send, "window.__r3b.submitDisabled() === false");
  await api(send, 'click("profile-submit")');
  await waitFor(send, 'window.__r3b.saved() !== null', 8000);
  const batchCalls = (await api(send, "calls()")).filter((call) =>
    call.url.includes("/batches/full-profile"));
  check("interactive", "valid batch: DUNG MOT POST", batchCalls.length === 1,
    { batchCalls: batchCalls.length, all: (await api(send, "calls()")).length });
  const sentBody = JSON.parse(batchCalls[0].body);
  check("interactive", "request body dung contract",
    sentBody.contract_version === "worker-profile/1.0" && sentBody.rows.length === 3 &&
    JSON.stringify(Object.keys(sentBody).sort()) === JSON.stringify(["contract_version", "rows"]),
    Object.keys(sentBody));
  check("interactive", "request header co Idempotency-Key dang UUID",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(batchCalls[0].idempotencyKey ?? ""), batchCalls[0].idempotencyKey);
  const sentKeys = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) { sentKeys.add(key); walk(child); }
    }
  };
  walk(sentBody);
  check("interactive", "request khong co truong authority",
    !["actor", "actor_id", "app_user_id", "auth_subject", "capability", "scope", "scope_kind",
      "entry_id", "submission_id", "provider_type", "team", "team_id", "payment_state",
      "bank_label"].some((key) => sentKeys.has(key)), [...sentKeys]);
  check("interactive", "header request dung",
    Object.keys(batchCalls[0].idempotencyKey ? { k: 1 } : {}).length === 1 &&
    batchCalls[0].method === "POST");
  check("interactive", "chi endpoint full-profile duoc goi",
    (await api(send, "calls()")).every((call) =>
      !call.url.startsWith("/api/direct-entry/batches?") &&
      !(call.url === "/api/direct-entry/batches")),
    (await api(send, "calls()")).map((call) => call.url));
  check("interactive", "thanh cong chi sau projection hop le",
    String(await api(send, "saved()")).includes("Đã lưu 3 dòng"), await api(send, "saved()"));
  check("interactive", "parent reload tu server va bao trang thai",
    String(await api(send, "notice()")).includes("Đã lưu 3 dòng"),
    await api(send, "notice()"));
  shots.success = await screenshot(send, "full-profile-batch-success");

  // --- S21: CCCD boundary ---
  const cccd = await api(send, "cccdButtons()");
  check("interactive", "sau khi luu: cot CCCD co nut quan ly va bat dung entry_id",
    Array.isArray(cccd) && cccd.length === 3 && cccd.every((item) => item.disabled === false),
    cccd);
  check("interactive", "CCCD hien 'Chua tai trang thai' (khong gia 0/2)",
    JSON.stringify(await api(send, "cccdLabels()")).includes("Chưa tải trạng thái"),
    await api(send, "cccdLabels()"));

  // --- S15: busy chan double submit + 5xx retry dung lai key ---
  await api(send, "setBatch({ mode: 'status', status: 500, code: 'BATCH_UNAVAILABLE' })");
  await paste(send, MINIMAL);
  await waitFor(send, "window.__r3b.submitDisabled() === false");
  await api(send, "calls().length = 0");
  await evaluate(send, "window.__r3b.calls().length = 0");
  await api(send, 'click("profile-submit")');
  await waitFor(send, 'window.__r3b.message() !== null && window.__r3b.message() !== ""', 8000);
  const firstRetryCall = (await api(send, "calls()")).filter((call) =>
    call.url.includes("/batches/full-profile"));
  check("interactive", "5xx: giu key va cho bam Thu lai (khong auto-loop)",
    firstRetryCall.length === 1, firstRetryCall.length);
  check("interactive", "5xx: thong bao da lam sach, khong lo ma tho",
    String(await api(send, "message()")).includes("Máy chủ chưa xử lý được") &&
    !String(await api(send, "message()")).includes("BATCH_UNAVAILABLE"),
    await api(send, "message()"));
  check("interactive", "5xx: nut doi thanh 'Thu lai'",
    String(await api(send, "submitLabel()")).trim() === "Thử lại",
    await api(send, "submitLabel()"));
  await api(send, 'click("profile-submit")');
  await new Promise((resolve) => setTimeout(resolve, 600));
  const retryCalls = (await api(send, "calls()")).filter((call) =>
    call.url.includes("/batches/full-profile"));
  check("interactive", "retry cung intent dung lai CUNG idempotency key",
    retryCalls.length === 2 &&
    retryCalls[0].idempotencyKey === retryCalls[1].idempotencyKey,
    retryCalls.map((call) => call.idempotencyKey));

  // --- S22: sua du lieu sau loi => key moi ---
  await paste(send, tsv([profileRow("hrp-2026-001101")]));
  await waitFor(send, "window.__r3b.submitDisabled() === false");
  await api(send, 'click("profile-submit")');
  await new Promise((resolve) => setTimeout(resolve, 600));
  const afterEdit = (await api(send, "calls()")).filter((call) =>
    call.url.includes("/batches/full-profile"));
  check("interactive", "sua du lieu tao intent/key moi",
    afterEdit.length === 3 &&
    afterEdit[2].idempotencyKey !== afterEdit[1].idempotencyKey,
    afterEdit.map((call) => call.idempotencyKey));

  // --- S23: 2xx malformed khong tu retry, khong hien thanh cong ---
  await api(send, "setBatch({ mode: 'malformed' })");
  await paste(send, tsv([profileRow("hrp-2026-001201")]));
  await waitFor(send, "window.__r3b.submitDisabled() === false");
  const beforeMalformed = (await api(send, "calls()")).length;
  await submit(send);
  const malformedCalls = (await api(send, "calls()")).length - beforeMalformed;
  check("interactive", "2xx malformed: chi mot request, khong tu retry",
    malformedCalls === 1, malformedCalls);
  check("interactive", "2xx malformed: khong hien thanh cong",
    (await api(send, "saved()")) === null);
  check("interactive", "2xx malformed: thong bao da lam sach",
    String(await api(send, "message()")).includes("không đọc được"), await api(send, "message()"));

  // --- S24: 400 sanitized ---
  await api(send, "setBatch({ mode: 'status', status: 400, code: 'NATIONAL_ID_INVALID' })");
  await paste(send, tsv([profileRow("hrp-2026-001301")]));
  await waitFor(send, "window.__r3b.submitDisabled() === false");
  await submit(send);
  check("interactive", "400: thong bao tieng Viet da lam sach",
    String(await api(send, "message()")).includes("CMT/CCCD phải gồm đúng 9 hoặc 12 chữ số") &&
    !String(await api(send, "message()")).includes("NATIONAL_ID_INVALID"),
    await api(send, "message()"));

  // --- S25: 401/403 sanitized ---
  for (const [status, code, expected] of [[401, "UNAUTHENTICATED", "Phiên làm việc đã hết hiệu lực"],
    [403, "ACTOR_DENIED", "không có quyền"]]) {
    await api(send, "setBatch({ mode: 'status', status: " + status + ", code: '" + code + "' })");
    await paste(send, tsv([profileRow("hrp-2026-0014" + String(status).slice(-2))]));
    await waitFor(send, "window.__r3b.submitDisabled() === false");
    await submit(send);
    check("interactive", status + ": thong bao da lam sach",
      String(await api(send, "message()")).includes(expected), await api(send, "message()"));
  }

  // --- S26: 409 khong auto-retry + reconcile ---
  await api(send, "setBatch({ mode: 'status', status: 409, code: 'IDEMPOTENCY_CONFLICT' })");
  await paste(send, tsv([profileRow("hrp-2026-001501")]));
  await waitFor(send, "window.__r3b.submitDisabled() === false");
  await evaluate(send, "window.__r3b.calls().length = 0");
  const beforeConflict = (await api(send, "calls()")).length;
  await submit(send);
  const conflictCalls = (await api(send, "calls()")).filter((call) =>
    call.url.includes("/batches/full-profile"));
  check("interactive", "409: khong auto-retry",
    conflictCalls.length === 1, conflictCalls.length);
  check("interactive", "409: thong bao reconcile da lam sach",
    String(await api(send, "message()")).includes("Dữ liệu đã thay đổi ở nơi khác") &&
    !String(await api(send, "message()")).includes("IDEMPOTENCY_CONFLICT"),
    await api(send, "message()"));
  check("interactive", "409: parent reload/reconcile du lieu server",
    String(await api(send, "notice()")).includes("Danh sách vừa được tải lại"),
    await api(send, "notice()"));
  void beforeConflict;

  // --- S27: khong PII trong URL/storage ---
  const allCalls = await api(send, "calls()");
  const urls = allCalls.map((call) => call.url).join("|");
  check("interactive", "khong PII trong URL/query string",
    !urls.includes("Nguy%E1%BB%85n") && !urls.includes("Nguyễn") &&
    !urls.includes("012345678901") && !urls.includes("000123456789"), urls.slice(0, 400));
  check("interactive", "khong dung localStorage/sessionStorage",
    (await api(send, "storageKeys()")) === 0);
  check("interactive", "khong co console error",
    consoleMessages.length === 0, consoleMessages.slice(0, 5));

  // --- S28: mobile ---
  await setViewport(send, 390, 844);
  await paste(send, THREE_ROWS);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const viewport = await api(send, "viewport()");
  check("interactive", "mobile 390x844 khong tran ngang",
    viewport.scrollWidth <= viewport.innerWidth + 1, viewport);
  const dialogRect = await api(send, 'rect(\'[data-testid="profile-paste-dialog"]\')');
  check("interactive", "mobile: dialog nam trong viewport",
    dialogRect !== null && dialogRect.width <= viewport.innerWidth + 1, dialogRect);
  shots.mobile = await screenshot(send, "full-profile-paste-mobile");

  // --- desktop overflow ---
  await setViewport(send, 1920, 1080);
  const desktopViewport = await api(send, "viewport()");
  check("interactive", "desktop 1920x1080 khong tran ngang",
    desktopViewport.scrollWidth <= desktopViewport.innerWidth + 1, desktopViewport);
}

/* -------------------------------------------------------------------- main */

function installFixture() {
  mkdirSync(HARNESS_DIR, { recursive: true });
  writeFileSync(HARNESS_FILE,
    readFileSync(path.join(ROOT, "scripts", "p1.6-i04c3-r3b-browser-fixture.tsx"), "utf8"));
}

function removeFixture() {
  rmSync(HARNESS_DIR, { recursive: true, force: true });
  // next dev sinh .next/dev/types/validator.ts tro toi route harness; xoa cache dev de
  // `next typegen` + typecheck sau do khong con tham chieu route da bi go.
  rmSync(path.join(ROOT, ".next", "dev"), { recursive: true, force: true });
}

async function main() {
  if (!existsSync(CHROME)) throw new Error("Chrome not found at " + CHROME);
  mkdirSync(OUTDIR, { recursive: true });
  installFixture();
  const report = { harness: "p1.6-i04c3-r3b-browser-acceptance", shots: [] };
  const shots = {};
  let collectedConsole = [];
  let devServer = null;
  let chrome = null;
  let socket = null;
  let serverLog = "";
  try {
    const port = await pickPort();
    // Chay truc tiep binary cua next (khong qua shell) de kill() dung process that.
    const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
    devServer = spawn(process.execPath, [nextBin, "dev", "-p", String(port)], {
      cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    });
    devServer.stdout?.on("data", (chunk) => { serverLog += String(chunk); });
    devServer.stderr?.on("data", (chunk) => { serverLog += String(chunk); });
    // Phai dung "localhost": next dev chan cross-origin dev resource (/_next/*) tu 127.0.0.1,
    // khien client bundle khong nap duoc va component khong hydrate.
    const base = "http://localhost:" + port;
    const up = await waitForServer(base + ROUTE, 180000);
    if (!up) throw new Error("next dev did not become ready:\n" + serverLog.slice(-2000));

    const profile = mkdtempSync(path.join(tmpdir(), "i04c3-r3b-chrome-"));
    chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0",
      "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
      "--remote-allow-origins=*", "--hide-scrollbars", "about:blank"],
    { stdio: "ignore", detached: false });
    const devtoolsPort = await readDevToolsPort(profile);
    const attached = await attach(devtoolsPort);
    socket = attached.socket;
    const { send, consoleMessages } = attached;
    collectedConsole = consoleMessages;
    await setViewport(send, 1920, 1080);
    await send("Page.navigate", { url: base + ROUTE });
    await runScenarios(send, shots, consoleMessages);
    report.consoleErrors = consoleMessages;
    report.serverError = serverLog.includes("Error:") ? serverLog.slice(-1500) : null;
  } catch (error) {
    check("harness", "chay duoc interactive acceptance", false,
      String(error && error.message ? error.message : error));
    report.consoleErrors = collectedConsole;
    report.serverLogTail = serverLog.slice(-4000);
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    if (chrome) { try { chrome.kill(); } catch { /* ignore */ } await waitForExit(chrome); }
    if (devServer) { try { devServer.kill(); } catch { /* ignore */ } await waitForExit(devServer); }
    removeFixture();
  }

  report.shots = Object.entries(shots).map(([key, value]) => ({ key, ...value }));
  report.checks = checks;
  report.total = checks.length;
  report.passed = checks.filter((item) => item.ok).length;
  report.failed = report.total - report.passed;
  report.ok = report.failed === 0;
  writeFileSync(path.join(OUTDIR, "browser-acceptance.json"),
    JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({
    ok: report.ok,
    total: report.total,
    passed: report.passed,
    failed: report.failed,
    failedChecks: checks.filter((item) => !item.ok).map((item) =>
      item.name + " :: " + JSON.stringify(item.detail)),
    shots: report.shots.map((shot) => shot.name),
  }, null, 2));
  // Thoat tuong minh: child process cua dev server co the giu event loop.
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error("R3B browser acceptance failed: " + error.message);
  process.exit(1);
});
