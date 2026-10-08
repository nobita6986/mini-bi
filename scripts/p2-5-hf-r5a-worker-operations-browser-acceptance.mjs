import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * P2.5-HF-R5A - Worker Operations interaction acceptance against the PRODUCTION component.
 * Synthetic fetch + real Chrome; no source-string assertions here.
 */

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const chromePath = process.env.P25R5A_CHROME ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const fixtureDir = path.join(root, "src", "app", "p2-5-hf-r5a-harness");
const fixtureFile = path.join(fixtureDir, "page.tsx");
const devCache = path.join(root, ".next", "dev");
const checks = [];

function record(name, ok, detail) {
  checks.push({ name, ok: ok === true, ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(name + (detail === undefined ? "" : ": " + JSON.stringify(detail)));
}

async function pickPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(url, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null) child.kill();
}

async function readDevToolsPort(profile) {
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const port = readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
      if (port) return port;
    } catch { }
  }
  throw new Error("Chrome DevTools port did not become available");
}

async function attach(port) {
  const target = await (await fetch("http://127.0.0.1:" + port + "/json/new?about:blank",
    { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      request.resolve(message);
    }
  });
  await send("Runtime.enable");
  await send("Page.enable");
  return { socket, send };
}

async function evaluate(send, expression, awaitPromise = false) {
  const response = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description ??
      response.result.exceptionDetails.text);
  }
  return response.result?.result?.value;
}

const api = (send, expression) => evaluate(send, "window.__p25r5a." + expression);

async function waitFor(send, expression, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(send, expression)) return true;
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function setViewport(send, width, height) {
  await send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: width < 600,
  });
}

async function key(send, name, code, keyCode, text) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code,
    windowsVirtualKeyCode: keyCode, ...(text === undefined ? {} : { text }) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code,
    windowsVirtualKeyCode: keyCode });
}

async function button(send, expression, name) {
  record(name, await evaluate(send, expression) === true);
}

const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function main() {
  if (!existsSync(chromePath)) throw new Error("Chrome not found at " + chromePath);
  if (existsSync(fixtureDir)) throw new Error("Refusing to replace existing fixture: " + fixtureDir);
  if (existsSync(devCache)) throw new Error("Refusing to modify existing Next dev cache: " + devCache);
  const expectedFixtureDir = path.resolve(root, "src", "app", "p2-5-hf-r5a-harness");
  const expectedDevCache = path.resolve(root, ".next", "dev");
  if (path.resolve(fixtureDir) !== expectedFixtureDir || path.resolve(devCache) !== expectedDevCache ||
      !expectedFixtureDir.startsWith(root + path.sep) ||
      !expectedDevCache.startsWith(root + path.sep)) {
    throw new Error("Temporary route/cache path validation failed");
  }

  mkdirSync(fixtureDir);
  writeFileSync(fixtureFile, readFileSync(path.join(root,
    "scripts", "p2-5-hf-r5a-worker-operations-browser-fixture.tsx"), "utf8"));

  let server;
  let chrome;
  let profile;
  let socket;
  const devCacheWasPresent = existsSync(devCache);
  let serverLog = "";
  let failure;
  try {
    const port = await pickPort();
    const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
    server = spawn(process.execPath, [nextBin, "dev", "-p", String(port)], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk) => { serverLog += String(chunk); });
    server.stderr?.on("data", (chunk) => { serverLog += String(chunk); });
    const baseUrl = "http://localhost:" + port;
    if (!await waitForServer(baseUrl + "/p2-5-hf-r5a-harness")) {
      throw new Error("Next dev server did not start:\n" + serverLog.slice(-3000));
    }
    profile = mkdtempSync(path.join(tmpdir(), "p2-5-hf-r5a-chrome-"));
    chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0",
      "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
      "--remote-allow-origins=*", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
    const devtoolsPort = await readDevToolsPort(profile);
    const browser = await attach(devtoolsPort);
    socket = browser.socket;
    const { send } = browser;
    await setViewport(send, 390, 844);
    await send("Page.navigate", { url: baseUrl + "/p2-5-hf-r5a-harness" });

    record("browser fixture hydrates", await waitFor(send,
      "typeof window.__p25r5a === 'object'", 60000), serverLog.slice(-2500));
    record("initial tab follows the server actor projection (all)",
      await waitFor(send, "window.__p25r5a.listRowTexts().length === 25") &&
      (await api(send, "tabLabels()")).length === 4 &&
      (await evaluate(send,
        "document.querySelector('[role=\"tab\"][aria-selected=\"true\"]')?.innerText.trim()")) ===
        "Toàn bộ NLĐ",
      await api(send, "tabLabels()"));

    const order = await api(send, "queueBeforeList()");
    record("change-request queue renders exactly once and BEFORE the worker list",
      order.present === true && order.queueCount === 1 &&
      order.queueIndex > -1 && order.queueIndex < order.panelIndex, order);

    await api(send, "clearCalls()");
    await button(send, 'window.__p25r5a.clickButton("Tải thêm")', "load more page two");
    record("second page appends 5 unique rows with the server cursor",
      await waitFor(send, "window.__p25r5a.listRowTexts().length === 30") &&
      new Set(await api(send, "listRowTexts()")).size === 30 &&
      (await api(send, "calls()")).some((call) =>
        call.url.includes("cursor=20261008%3Ac1000000-0000-4000-8000-000000000025")),
      (await api(send, "calls()")).map((call) => call.url));

    record("tab switch renders the managed relation",
      await api(send, 'clickTab("Dự án tôi quản lý")') &&
      await waitFor(send, "window.__p25r5a.listRowTexts().length === 1"));
    await api(send, "failNextLoadMore()");
    const rowsBeforeFailure = await api(send, "listRowTexts()");
    await button(send, 'window.__p25r5a.clickButton("Tải thêm")',
      "load more fails on the second page");
    const failureState = await waitFor(send,
      "window.__p25r5a.errorText().some((text) => text.includes('Không tải được danh sách'))");
    record("failed load-more keeps the loaded rows and reports a red error",
      failureState &&
      JSON.stringify(await api(send, "listRowTexts()")) === JSON.stringify(rowsBeforeFailure) &&
      (await api(send, "alertClassNames()")).some((name) => name.includes("border-red-500")),
      { rows: (await api(send, "listRowTexts()")).length });

    await api(send, 'denyScope("all")');
    await button(send, 'window.__p25r5a.clickTab("Toàn bộ NLĐ")', "switch to denied tab");
    const deniedShown = await waitFor(send,
      "window.__p25r5a.errorText().some((text) => text.includes('không có quyền xem danh sách này'))");
    const deniedText = await api(send, "errorText()");
    const deniedQueue = await api(send, "queueBeforeList()");
    record("403 stays inside its own tab while the queue and other tabs keep working",
      deniedShown &&
      deniedQueue.present === true && deniedQueue.queueCount === 1 &&
      await api(send, 'clickTab("Dự án tôi quản lý")') &&
      await waitFor(send, "window.__p25r5a.listRowTexts().length === 1"),
      deniedText);
    await api(send, "denyScope(null)");

    record("no technical UUID is rendered to the user",
      !UUID_TEXT.test(await api(send, "bodyText()")));

    await button(send, 'window.__p25r5a.clickRowButton("Người lao động quản lý 01", "Đề xuất thay đổi")',
      "open proposal drawer");
    const expectedFields = ["worker-display-name", "worker-employee-code", "worker-project",
      "worker-first-work-date", "worker-recruiter", "worker-labor-type", "worker-gender-state",
      "worker-date_of_birth-state", "worker-national_id-state",
      "worker-national_id_issued_at-state", "worker-national_id_issued_place-state",
      "worker-address-state", "worker-phone-state", "propose-target"];
    await waitFor(send, "window.__p25r5a.dialogOpen()");
    const preloaded = await waitFor(send, "document.querySelector('#worker-display-name') !== null");
    const openedFields = await api(send, "dialogFieldIds()");
    record("proposal drawer preloads the authorized baseline and every contract field",
      preloaded && (await api(send, "dialogTitle()")) === "Đề xuất thay đổi" &&
      expectedFields.every((id) => openedFields.includes(id)) &&
      (await evaluate(send, "document.querySelector('#worker-display-name')?.value")) === "Nguyễn Văn A",
      openedFields);

    await api(send, "clearCalls()");
    await api(send, 'fill("#worker-address-state", "provided")');
    await api(send, 'fill("#worker-address", "Số 1 đường Lê Lợi")');
    await api(send, 'fillReason("Bổ sung địa chỉ theo hồ sơ giấy")');
    await button(send, 'window.__p25r5a.clickDialogButton("Gửi đề xuất")', "submit proposal");
    const proposalCall = (await api(send, "calls()")).find((call) => call.method === "POST" &&
      call.url === "/api/direct-entry/change-requests");
    const proposalBody = proposalCall?.body?.items?.[0]?.proposal;
    record("proposal sends only the changed entry fields with reason, OCC and idempotency",
      await waitFor(send, "!window.__p25r5a.dialogOpen()") &&
      JSON.stringify(Object.keys(proposalBody ?? {})) === JSON.stringify(["worker_details"]) &&
      proposalBody?.worker_details?.address?.state === "provided" &&
      proposalBody?.worker_details?.address?.value === "Số 1 đường Lê Lợi" &&
      proposalBody?.worker_details?.phone?.state === "omitted" &&
      proposalBody?.worker_details?.display_name === "Nguyễn Văn A" &&
      proposalCall?.body?.items?.[0]?.expected_version === 3 &&
      proposalCall?.body?.items?.[0]?.target_kind === "ENTRY_FIELD" &&
      proposalCall?.body?.reason === "Bổ sung địa chỉ theo hồ sơ giấy" &&
      typeof proposalCall?.body?.idempotency_key === "string",
      proposalBody);

    await button(send, 'window.__p25r5a.clickRowButton("Người lao động quản lý 01", "Đề xuất thay đổi")',
      "reopen drawer for work status");
    await waitFor(send, "window.__p25r5a.dialogOpen()");
    await api(send, 'fill("#propose-target", "WORK_STATUS")');
    await waitFor(send, "document.querySelector('#worker-target-status')?.options.length === 2");
    const statusOptions = await evaluate(send,
      "Array.from(document.querySelectorAll('#worker-target-status option'), (o) => o.value)");
    record("work status offers only the transitions the database allows",
      JSON.stringify(statusOptions) === JSON.stringify(["", "OFF"]), statusOptions);
    await api(send, 'fill("#worker-target-status", "OFF")');
    const leaveField = await evaluate(send,
      "(() => { const f = document.querySelector('#worker-leave-reason');" +
      " return { exists: !!f, required: f?.required === true, valid: f?.checkValidity() ?? true }; })()");
    await api(send, "clearCalls()");
    await api(send, 'fillReason("Nghỉ việc theo đề nghị")');
    await button(send, 'window.__p25r5a.clickDialogButton("Gửi đề xuất")', "submit leave without reason");
    record("leaving work requires a leave reason and sends nothing without it",
      leaveField.exists && leaveField.required && leaveField.valid === false &&
      !(await api(send, "calls()")).some((call) => call.method === "POST"), leaveField);
    await api(send, 'fill("#worker-leave-reason", "Nghỉ theo nguyện vọng")');
    const dialogOpenMetrics = await api(send, "dialogMetrics()");
    record("mobile drawer stays inside the viewport with focus inside the dialog",
      dialogOpenMetrics.exists === true && dialogOpenMetrics.left >= 0 &&
      dialogOpenMetrics.right <= dialogOpenMetrics.innerWidth + 1 &&
      dialogOpenMetrics.top >= 0 && dialogOpenMetrics.bottom <= 844 &&
      dialogOpenMetrics.scrollWidth <= dialogOpenMetrics.innerWidth + 1 &&
      dialogOpenMetrics.focusInside === true, dialogOpenMetrics);
    await button(send, 'window.__p25r5a.clickDialogButton("Gửi đề xuất")', "submit leave with reason");
    const leaveCall = (await api(send, "calls()")).find((call) => call.method === "POST" &&
      call.url === "/api/direct-entry/change-requests");
    record("WORK_STATUS OFF sends status, effective date and leave reason only",
      await waitFor(send, "!window.__p25r5a.dialogOpen()") &&
      leaveCall?.body?.items?.[0]?.target_kind === "WORK_STATUS" &&
      JSON.stringify(Object.keys(leaveCall?.body?.items?.[0]?.proposal ?? {}).sort()) ===
        JSON.stringify(["effective_date", "leave_reason", "status"]) &&
      leaveCall?.body?.items?.[0]?.proposal?.leave_reason === "Nghỉ theo nguyện vọng",
      leaveCall);

    await button(send, 'window.__p25r5a.clickRowButton("Người lao động quản lý 01", "Đề xuất thay đổi")',
      "reopen drawer for the bank flow");
    await waitFor(send, "window.__p25r5a.dialogOpen()");
    await waitFor(send, "document.querySelector('#worker-display-name') !== null");
    await api(send, 'fill("#propose-target", "PAYMENT")');
    const bankFields = await api(send, "dialogFieldIds()");
    record("bank account information keeps its own target flow",
      ["bank-state", "bank-account", "bank-id", "bank-holder"].every((id) => bankFields.includes(id)) &&
      !bankFields.includes("worker-display-name") && !bankFields.includes("worker-target-status"),
      bankFields);
    await key(send, "Escape", "Escape", 27);
    record("Escape closes the drawer and returns focus to the trigger",
      await waitFor(send, "!window.__p25r5a.dialogOpen()") &&
      (await api(send, "focusText()")) === "Đề xuất thay đổi", await api(send, "focusText()"));

    await button(send, 'window.__p25r5a.clickRowButton("Người lao động quản lý 01", "Sửa trực tiếp")',
      "open privileged correction drawer");
    await waitFor(send, "window.__p25r5a.dialogOpen()");
    await waitFor(send, "document.querySelector('#worker-phone-state') !== null");
    record("privileged correction is offered in its own mode",
      (await api(send, "dialogTitle()")) === "Sửa trực tiếp hồ sơ" &&
      !(await api(send, "dialogFieldIds()")).includes("propose-target"));
    await api(send, "clearCalls()");
    await api(send, 'fill("#worker-phone-state", "provided")');
    await api(send, 'fill("#worker-phone", "0901234567")');
    await api(send, 'fillReason("Sửa số điện thoại theo CCCD")');
    await button(send, 'window.__p25r5a.clickDialogButton("Lưu chỉnh sửa trực tiếp")',
      "submit privileged correction");
    const correctionCall = (await api(send, "calls()")).find((call) =>
      call.method === "POST" && call.url.endsWith("/privileged-edit"));
    const patched = correctionCall?.body?.patch;
    record("privileged correction sends the changed patch, reason, OCC and idempotency header",
      await waitFor(send, "!window.__p25r5a.dialogOpen()") &&
      correctionCall?.body?.expected_entry_version === 3 &&
      correctionCall?.body?.reason === "Sửa số điện thoại theo CCCD" &&
      JSON.stringify(Object.keys(patched ?? {})) === JSON.stringify(["worker_details"]) &&
      patched?.worker_details?.phone?.state === "provided" &&
      patched?.worker_details?.phone?.value === "0901234567" &&
      patched?.worker_details?.address?.state === "omitted" &&
      typeof correctionCall?.headers?.["idempotency-key"] === "string",
      patched);

    await api(send, "setCatalogDenied(true)");
    await api(send, "remount()");
    record("a denied catalog is reported as an authority limit, not as a system error",
      await waitFor(send, "window.__p25r5a.listRowTexts().length === 25") &&
      (await api(send, "statusClassNames()")).some((name) => name.includes("text-sky-800")) &&
      (await api(send, "bodyText()")).includes("không có quyền đọc danh mục") &&
      !(await api(send, "errorText()")).some((text) => text.includes("danh mục")) &&
      (await api(send, "tabpanelSelectCount()")) === 1,
      await api(send, "statusClassNames()"));
    await api(send, "clearCalls()");
    await api(send, 'fillStatusFilter("OFF")');
    record("status filtering still works while the catalog is denied",
      await waitFor(send, "window.__p25r5a.calls().some((call) => call.url.includes('employment_status=OFF'))"),
      (await api(send, "calls()")).map((call) => call.url));

    await button(send, 'window.__p25r5a.clickRowButton("Người lao động 01", "Sửa trực tiếp")',
      "open drawer with denied catalog");
    record("denied catalog keeps the drawer fail-closed on the current project and recruiter",
      await waitFor(send, "window.__p25r5a.dialogOpen()") &&
      await waitFor(send, "document.querySelector('#worker-project') !== null") &&
      (await api(send, "dialogDisabledFieldIds()")).includes("worker-project") &&
      (await api(send, "dialogDisabledFieldIds()")).includes("worker-recruiter") &&
      (await api(send, "bodyText()")).includes("chỉ giữ được dự án và người tuyển hiện tại"),
      await api(send, "dialogDisabledFieldIds()"));
    await key(send, "Escape", "Escape", 27);
    await waitFor(send, "!window.__p25r5a.dialogOpen()");

    await api(send, "setCatalogDenied(false)");
    await api(send, "setCatalogError(true)");
    await api(send, "remount()");
    record("a failing catalog is still a red error",
      await waitFor(send, "window.__p25r5a.listRowTexts().length === 25") &&
      await waitFor(send, "window.__p25r5a.errorText().some((text) => text.includes('Không tải được danh mục dự án và người tuyển'))") &&
      (await api(send, "alertClassNames()")).some((name) => name.includes("border-red-500")),
      await api(send, "errorText()"));

    await api(send, "setCatalogError(false)");
    await api(send, "remount()");
    await waitFor(send, "window.__p25r5a.listRowTexts().length === 25");
    await api(send, "setPrivileged(false)");
    await api(send, "remount()");
    record("privileged correction disappears without the session capability",
      await waitFor(send, "window.__p25r5a.listRowTexts().length === 25") &&
      (await api(send, "bodyText()")).includes("Đề xuất thay đổi") &&
      !(await api(send, "bodyText()")).includes("Sửa trực tiếp"));

    // P2.5-HF-R5A-R1: khong con duong network rejection nao im lang.
    await api(send, 'clickTab("Tôi đã nhập")');
    record("uploader relation keeps its rows when the next page request fails",
      await waitFor(send, "window.__p25r5a.listRowTexts().length === 1") &&
      await api(send, "failSubmissions()") === undefined &&
      await api(send, 'clickButton("Tải thêm")') &&
      await waitFor(send, "window.__p25r5a.alertTexts().some((t) => t.includes('Không tải được danh sách. Vui lòng thử lại.'))") &&
      (await api(send, "listRowTexts()")).length === 1 &&
      await api(send, 'alertHasButton("Thử lại")'),
      await api(send, "alertTexts()"));
    await api(send, "clearCalls()");
    await api(send, "allowSubmissions()");
    await api(send, 'clickAlertButton("Thử lại")');
    record("retry from the retained-rows failure reloads the relation",
      await waitFor(send, "window.__p25r5a.alertTexts().length === 0") &&
      (await api(send, "listRowTexts()")).length === 1 &&
      (await api(send, "calls()")).some((call) => call.method === "GET" &&
        call.url.startsWith("/api/direct-entry/submissions")),
      (await api(send, "calls()")).map((call) => call.url));
    await api(send, 'clickTab("Toàn bộ NLĐ")');
    await waitFor(send, "window.__p25r5a.listRowTexts().length > 0");
    await api(send, "failSubmissions()");
    await api(send, 'clickTab("Tôi đã nhập")');
    await api(send, "allowSubmissions()");
    record("initial rejection without rows shows the sanitized message, not a blank page",
      await waitFor(send, "window.__p25r5a.alertTexts().some((t) => t.startsWith('Không tải được danh sách. Vui lòng thử lại.'))") &&
      (await api(send, "tabLabels()")).length === 4 &&
      (await api(send, "queueText()")).length > 0 &&
      await api(send, 'alertHasButton("Thử lại")'),
      await api(send, "alertTexts()"));
    await api(send, "clearCalls()");
    await api(send, "failRequests()");
    const queueBeforeFailure = await api(send, "queueCards()");
    record("review queue keeps its rows when the older-requests refresh fails",
      await api(send, 'clickButton("Tải thêm yêu cầu cũ hơn")') &&
      await waitFor(send, "window.__p25r5a.alertTexts().some((t) => t.includes('Không tải được danh sách. Vui lòng thử lại.'))") &&
      (await api(send, "queueCards()")) === queueBeforeFailure &&
      (await api(send, "queueText()")).includes("Yêu cầu thay đổi") &&
      !(await api(send, "queueText()")).includes("()"),
      { before: queueBeforeFailure, after: await api(send, "queueCards()"),
        alerts: await api(send, "alertTexts()") });
    await api(send, "remount()");
    record("initial queue rejection reports the sanitized message instead of empty parentheses",
      await waitFor(send, "window.__p25r5a.queueText().includes('Không tải được danh sách yêu cầu thay đổi')") &&
      (await api(send, "queueText()")).includes("Không tải được danh sách. Vui lòng thử lại.") &&
      !(await api(send, "queueText()")).includes("()") &&
      (await api(send, "queueCards()")) === 0,
      await api(send, "queueText()"));
    await setViewport(send, 1280, 900);
    record("desktop layout has no horizontal overflow",
      await waitFor(send, "document.documentElement.scrollWidth <= window.innerWidth + 1"));
  } catch (error) {
    failure = error;
  } finally {
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    for (const child of [chrome, server]) {
      if (child) {
        try { child.kill(); } catch { }
        await waitForExit(child);
      }
    }
    if (profile) {
      const tempRoot = path.resolve(tmpdir());
      if (path.resolve(profile).startsWith(tempRoot + path.sep)) {
        rmSync(profile, { recursive: true, force: true });
      }
    }
    if (existsSync(fixtureDir) && path.resolve(fixtureDir) === expectedFixtureDir) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
    if (!devCacheWasPresent && existsSync(devCache) &&
        path.resolve(devCache) === expectedDevCache && expectedDevCache.startsWith(root + path.sep)) {
      rmSync(devCache, { recursive: true, force: true });
    }
  }

  const result = { ok: !failure && checks.every((check) => check.ok), total: checks.length,
    passed: checks.filter((check) => check.ok).length, checks,
    ...(failure ? { error: String(failure?.message ?? failure) } : {}) };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
