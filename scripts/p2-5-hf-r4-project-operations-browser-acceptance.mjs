import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const chromePath = process.env.P25R4_CHROME ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const fixtureDir = path.join(root, "src", "app", "p2-5-hf-r4-harness");
const fixtureFile = path.join(fixtureDir, "page.tsx");
const devCache = path.join(root, ".next", "dev");
const checks = [];

function record(name, ok, detail) {
  checks.push({ name, ok: ok === true, ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
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
      const response = await fetch(url);
      if (response.ok) return true;
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
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: "PUT",
  })).json();
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
  const response = await send("Runtime.evaluate", {
    expression, awaitPromise, returnByValue: true,
  });
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description ??
      response.result.exceptionDetails.text);
  }
  return response.result?.result?.value;
}

const api = (send, expression) => evaluate(send, `window.__p25r4.${expression}`);

async function waitFor(send, expression, timeout = 10000) {
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
  await send("Input.dispatchKeyEvent", {
    type: "keyDown", key: name, code, windowsVirtualKeyCode: keyCode,
    ...(text === undefined ? {} : { text }),
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp", key: name, code, windowsVirtualKeyCode: keyCode,
  });
}

async function button(send, expression, name) {
  record(name, await evaluate(send, expression) === true);
}

async function main() {
  if (!existsSync(chromePath)) throw new Error(`Chrome not found at ${chromePath}`);
  if (existsSync(fixtureDir)) throw new Error(`Refusing to replace existing fixture: ${fixtureDir}`);
  if (existsSync(devCache)) throw new Error(`Refusing to modify existing Next dev cache: ${devCache}`);

  const expectedFixtureDir = path.resolve(root, "src", "app", "p2-5-hf-r4-harness");
  const expectedDevCache = path.resolve(root, ".next", "dev");
  if (path.resolve(fixtureDir) !== expectedFixtureDir || path.resolve(devCache) !== expectedDevCache ||
      !expectedFixtureDir.startsWith(root + path.sep) || !expectedDevCache.startsWith(root + path.sep)) {
    throw new Error("Temporary route/cache path validation failed");
  }

  mkdirSync(fixtureDir);
  writeFileSync(fixtureFile, readFileSync(path.join(root,
    "scripts", "p2-5-hf-r4-project-operations-browser-fixture.tsx"), "utf8"));

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
    const baseUrl = `http://localhost:${port}`;
    if (!await waitForServer(`${baseUrl}/p2-5-hf-r4-harness`)) {
      throw new Error(`Next dev server did not start:\n${serverLog.slice(-3000)}`);
    }
    profile = mkdtempSync(path.join(tmpdir(), "p2-5-hf-r4-chrome-"));
    chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0",
      `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--remote-allow-origins=*", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
    const devtoolsPort = await readDevToolsPort(profile);
    const browser = await attach(devtoolsPort);
    socket = browser.socket;
    const { send } = browser;
    await setViewport(send, 390, 844);
    await send("Page.navigate", { url: `${baseUrl}/p2-5-hf-r4-harness` });

    record("browser fixture hydrates", await waitFor(send,
      `typeof window.__p25r4 === "object"`, 45000), serverLog.slice(-2500));
    record("complete list exposes pagination over all 13 returned rows",
      await waitFor(send, `window.__p25r4.listMetrics().text.includes("trong 13 dự án")`));
    const firstPage = await api(send, "listMetrics()");
    record("first list page renders 12 rows", firstPage.rows === 12, firstPage.rows);
    record("mobile page has no horizontal viewport overflow",
      await evaluate(send, "document.documentElement.scrollWidth <= window.innerWidth + 1"));
    record("pagination reaches the final returned project",
      await api(send, "clickNextPage()") && await waitFor(send,
        `window.__p25r4.listMetrics().text.includes("Dự án phụ 11")`));

    await api(send, `fill("select", "inactive")`);
    await waitFor(send, `window.__p25r4.listMetrics().rows === 6`);
    const inactiveProjects = await api(send, "listMetrics()");
    record("status filter is labelled and filters inactive projects",
      inactiveProjects.rows === 6 && inactiveProjects.text.includes("Dự án đã ngừng") &&
      !inactiveProjects.projects.some((row) => row.includes("DEMO-002")), inactiveProjects.projects);
    await api(send, `fill("select", "all")`);
    await api(send, `fill('input[placeholder="Tìm theo mã hoặc tên…"]', "DEMO-001")`);
    record("project search narrows actions to the selected project",
      await waitFor(send, `window.__p25r4.listMetrics().rows === 1`));

    record("Xem quản lý loads current, future, and revoked assignments",
      await api(send, `clickProject("DEMO-001", "Xem quản lý")`) && await waitFor(send,
        `window.__p25r4.bodyText().includes("Đang phụ trách") && window.__p25r4.bodyText().includes("Sắp hiệu lực") && window.__p25r4.bodyText().includes("Lịch sử phân công") && window.__p25r4.bodyText().includes("Đã thu hồi")`));
    const managerCalls = await api(send, "calls()");
    record("manager detail uses the existing candidate API",
      managerCalls.some((call) => call.url.startsWith("/api/direct-entry/manager-candidates")));

    await button(send, `window.__p25r4.clickPageButton("Tạo dự án")`, "open create dialog");
    record("create dialog is mobile-sized, labelled, and focused",
      await waitFor(send, `window.__p25r4.dialogMetrics().exists`) &&
      (await api(send, "dialogMetrics()")).focusId === "project-id" &&
      (await api(send, "formSemantics()")).every((field) => field.labelled));
    const createLayout = await api(send, "dialogMetrics()");
    record("create dialog fits the mobile viewport",
      createLayout.left >= 0 && createLayout.right <= createLayout.innerWidth + 1 &&
      createLayout.bottom <= 844 && createLayout.scrollWidth <= createLayout.innerWidth + 1,
      createLayout);
    await key(send, "Escape", "Escape", 27);
    record("Escape closes the dialog and restores focus",
      await waitFor(send, `!window.__p25r4.dialogMetrics().exists`) &&
      (await api(send, "focusText()")).includes("Tạo dự án"));

    await button(send, `window.__p25r4.clickPageButton("Tạo dự án")`, "reopen create dialog");
    await waitFor(send, `window.__p25r4.dialogMetrics().exists`);
    const mutationsBeforeValidation = (await api(send, "calls()")).filter((call) =>
      call.method === "POST" || call.method === "PATCH").length;
    record("create fields require a name, code, and reason",
      (await api(send, "formSemantics()")).filter((field) => field.required).length === 3);
    await api(send, `fill("#project-id", "bad id")`);
    await api(send, `fill("#project-name", "Tên thử nghiệm")`);
    await api(send, `fillReason("Lý do thử nghiệm")`);
    await button(send, `window.__p25r4.clickDialogButton("Tạo dự án")`, "submit invalid project id");
    record("invalid project id shows a red accessible error without a write",
      await waitFor(send, `window.__p25r4.bodyText().includes("Mã dự án chỉ gồm")`) &&
      (await api(send, "calls()")).filter((call) => call.method === "POST" || call.method === "PATCH").length ===
        mutationsBeforeValidation &&
      await evaluate(send, `Array.from(document.querySelectorAll('[role="alert"]')).some((alert) => alert.className.includes("border-red-300"))`));
    await api(send, `fill("#project-id", "DEMO-NEW")`);
    await api(send, `fill("#project-name", "Dự án mới")`);
    await api(send, `fillReason("Khởi tạo dự án mới")`);
    await button(send, `window.__p25r4.clickDialogButton("Tạo dự án")`, "create project");
    record("create sends the validated project and required reason",
      await waitFor(send, `!window.__p25r4.dialogMetrics().exists`) &&
      (await api(send, "calls()")).some((call) => call.method === "POST" &&
        call.url === "/api/direct-entry/projects" && call.body?.project_id === "DEMO-NEW" &&
        call.body?.display_name === "Dự án mới" && call.body?.reason === "Khởi tạo dự án mới"));

    const renameReadsBefore = await api(send, `calls().filter((call) => call.method === "GET" && call.url === "/api/direct-entry/projects/DEMO-001").length`);
    const listReadsBefore = await api(send, `calls().filter((call) => call.method === "GET" && call.url.startsWith("/api/direct-entry/projects?")).length`);
    await button(send, `window.__p25r4.clickProject("DEMO-001", "Đổi tên")`, "open rename dialog");
    record("Đổi tên opens the labelled, focused dialog with current value",
      await waitFor(send, `window.__p25r4.dialogMetrics().exists && document.querySelector("#rename-name")?.value === "Dự án thử nghiệm"`) &&
      (await api(send, "dialogMetrics()")).focusId === "rename-name" &&
      (await evaluate(send, `document.querySelector("#rename-name")?.labels?.length === 1`)));
    await api(send, `fill("#rename-name", "Dự án đã đổi tên")`);
    await api(send, `fillReason("Đổi tên theo quyết định")`);
    await button(send, `window.__p25r4.clickDialogButton("Lưu")`, "save project rename");
    record("rename sends reason and project OCC, then reloads detail and list",
      await waitFor(send, `!window.__p25r4.dialogMetrics().exists && window.__p25r4.bodyText().includes("Dự án đã đổi tên")`) &&
      (await api(send, "calls()")).some((call) => call.method === "PATCH" &&
        call.url === "/api/direct-entry/projects/DEMO-001" &&
        call.body?.display_name === "Dự án đã đổi tên" && call.body?.reason === "Đổi tên theo quyết định" &&
        call.body?.expected_version === 1) &&
      (await api(send, `calls().filter((call) => call.method === "GET" && call.url === "/api/direct-entry/projects/DEMO-001").length`)) > renameReadsBefore &&
      (await api(send, `calls().filter((call) => call.method === "GET" && call.url.startsWith("/api/direct-entry/projects?")).length`)) > listReadsBefore);

    await button(send, `window.__p25r4.clickProject("DEMO-001", "Đổi tên")`, "reopen rename for conflict");
    await waitFor(send, `window.__p25r4.dialogMetrics().exists`);
    await api(send, `fill("#rename-name", "Không được lưu")`);
    await api(send, `fillReason("Thử xung đột phiên bản")`);
    const mutationCountBeforeConflict = (await api(send, "calls()")).filter((call) =>
      call.method === "POST" || call.method === "PATCH").length;
    await api(send, "conflictNext()");
    await button(send, `window.__p25r4.clickDialogButton("Lưu")`, "trigger version conflict");
    record("409 shows a sanitized conflict and blocks further writes until reload",
      await waitFor(send, `window.__p25r4.bodyText().includes("Dữ liệu đã thay đổi ở nơi khác")`) &&
      await evaluate(send, `document.querySelector('[role="dialog"] button[type="submit"]')?.disabled === true`) &&
      !(await api(send, "bodyText()")).includes("PROJECT_CONFLICT"));
    await api(send, `clickDialogButton("Lưu")`);
    record("conflict lock prevents a second rename request",
      (await api(send, "calls()")).filter((call) => call.method === "POST" || call.method === "PATCH").length ===
        mutationCountBeforeConflict + 1);
    const readsAtConflict = await api(send, `calls().filter((call) => call.method === "GET").length`);
    await button(send, `window.__p25r4.clickGlobalButton("Tải lại dữ liệu")`, "reload after conflict");
    const unlocked = await waitFor(send,
      `!window.__p25r4.bodyText().includes("Dữ liệu đã thay đổi ở nơi khác") && document.querySelector('[role="dialog"] button[type="submit"]')?.disabled === false`);
    const reloadCalls = await api(send, "calls()");
    const reloadBody = await api(send, "bodyText()");
    record("successful authoritative reload unlocks the dialog and refreshes detail/list",
      unlocked && reloadCalls.filter((call) => call.method === "GET").length >= readsAtConflict + 2 &&
      reloadBody.includes("Dự án đã đổi tên"), {
        unlocked,
        readsAtConflict,
        readsAfter: reloadCalls.filter((call) => call.method === "GET").length,
        nameField: await evaluate(send, `document.querySelector("#rename-name")?.value`),
        conflictStillVisible: reloadBody.includes("Dữ liệu đã thay đổi ở nơi khác"),
      });
    await api(send, `fill("#rename-name", "Dự án sau khi tải lại")`);
    await api(send, `fillReason("Lưu sau khi tải phiên bản mới")`);
    await button(send, `window.__p25r4.clickDialogButton("Lưu")`, "save after conflict reload");
    record("next rename uses the freshly loaded project OCC",
      await waitFor(send, `!window.__p25r4.dialogMetrics().exists && window.__p25r4.bodyText().includes("Dự án sau khi tải lại")`) &&
      (await api(send, "calls()")).some((call) => call.method === "PATCH" &&
        call.url === "/api/direct-entry/projects/DEMO-001" &&
        call.body?.display_name === "Dự án sau khi tải lại" && call.body?.expected_version === 2 &&
        call.body?.reason === "Lưu sau khi tải phiên bản mới"));

    await api(send, `fill('input[placeholder="Tìm theo mã hoặc tên…"]', "DEMO-OFF")`);
    await waitFor(send, `window.__p25r4.listMetrics().rows === 1`);
    await button(send, `window.__p25r4.clickProject("DEMO-OFF", "Kích hoạt")`, "open activate dialog");
    await waitFor(send, `window.__p25r4.dialogMetrics().exists`);
    await api(send, `fillReason("Mở lại dự án")`);
    await button(send, `window.__p25r4.clickDialogButton("Kích hoạt")`, "activate project");
    record("activate uses active=true, reason, and project OCC",
      await waitFor(send, `!window.__p25r4.dialogMetrics().exists`) &&
      (await api(send, "calls()")).some((call) => call.method === "POST" &&
        call.url === "/api/direct-entry/projects/DEMO-OFF/active" && call.body?.active === true &&
        call.body?.expected_version === 4 && call.body?.reason === "Mở lại dự án"));
    await button(send, `window.__p25r4.clickProject("DEMO-OFF", "Ngừng")`, "open deactivate dialog");
    await waitFor(send, `window.__p25r4.dialogMetrics().exists`);
    await api(send, `fillReason("Tạm ngừng dự án")`);
    await button(send, `window.__p25r4.clickDialogButton("Ngừng hoạt động")`, "deactivate project");
    record("deactivate uses active=false, reason, and incremented project OCC",
      await waitFor(send, `!window.__p25r4.dialogMetrics().exists`) &&
      (await api(send, "calls()")).some((call) => call.method === "POST" &&
        call.url === "/api/direct-entry/projects/DEMO-OFF/active" && call.body?.active === false &&
        call.body?.expected_version === 5 && call.body?.reason === "Tạm ngừng dự án"));

    await api(send, `fill('input[placeholder="Tìm theo mã hoặc tên…"]', "DEMO-001")`);
    await waitFor(send, `window.__p25r4.listMetrics().rows === 1`);
    await button(send, `window.__p25r4.clickProject("DEMO-001", "Xem quản lý")`, "reload manager detail");
    await waitFor(send, `window.__p25r4.bodyText().includes("Đang phụ trách")`);
    await button(send, `window.__p25r4.clickGlobalButton("Gán quản lý")`, "open manager assignment dialog");
    record("candidate search uses the verified API and exposes keyboard options",
      await waitFor(send, `window.__p25r4.dialogMetrics().exists && document.querySelector("#manager-search") !== null`) &&
      await api(send, `fill("#manager-search", "Nguyễn")`) &&
      await waitFor(send, `window.__p25r4.managerOption()?.includes("Nguyễn An")`));
    await key(send, "ArrowDown", "ArrowDown", 40);
    await key(send, "Enter", "Enter", 13, "\r");
    await api(send, `fill("#manager-from", "2030-02-03")`);
    await button(send, `window.__p25r4.clickDialogButton("Thêm vào danh sách")`, "add selected manager");
    await api(send, `fillReason("Phân công theo kế hoạch")`);
    await button(send, `window.__p25r4.clickDialogButton("Gán quản lý")`, "assign selected manager");
    record("assignment sends selected verified id, reason, and project OCC",
      await waitFor(send, `!window.__p25r4.dialogMetrics().exists`) &&
      (await api(send, "calls()")).some((call) => call.method === "POST" &&
        call.url === "/api/direct-entry/projects/DEMO-001/managers" &&
        call.body?.manager_recruiter_id === "22222222-2222-4222-8222-222222222222" &&
        call.body?.valid_from === "2030-02-03" && call.body?.reason === "Phân công theo kế hoạch" &&
        call.body?.expected_project_version === 3) &&
      (await api(send, "calls()")).some((call) => call.url.startsWith("/api/direct-entry/manager-candidates?search=Nguy%E1%BB%85n")));

    await button(send, `window.__p25r4.clickGroupButton("Đang phụ trách", "Thu hồi phân công")`,
      "open assignment revoke dialog");
    await waitFor(send, `window.__p25r4.dialogMetrics().exists`);
    await api(send, `fillReason("Kết thúc phân công")`);
    await button(send, `window.__p25r4.clickDialogButton("Thu hồi")`, "revoke assignment");
    record("revoke sends assignment OCC, project OCC, reason, and refreshes history",
      await waitFor(send, `!window.__p25r4.dialogMetrics().exists && window.__p25r4.bodyText().includes("Đã thu hồi")`) &&
      (await api(send, "calls()")).some((call) => call.method === "POST" &&
        call.url === "/api/direct-entry/projects/DEMO-001/managers/ASSIGN-CURRENT" &&
        call.body?.expected_version === 4 && call.body?.expected_project_version === 4 &&
        call.body?.reason === "Kết thúc phân công"));

    const errors = await evaluate(send, "document.querySelectorAll('[role=alert]').length");
    record("browser interactions finish without inaccessible residual errors", errors === 0, errors);
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
      if (path.resolve(profile).startsWith(tempRoot + path.sep)) rmSync(profile, { recursive: true, force: true });
    }
    if (existsSync(fixtureDir) && path.resolve(fixtureDir) === expectedFixtureDir) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
    if (!devCacheWasPresent && existsSync(devCache) && path.resolve(devCache) === expectedDevCache &&
        expectedDevCache.startsWith(root + path.sep)) {
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
