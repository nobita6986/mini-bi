#!/usr/bin/env node
/**
 * P1.6-I04C3-R2 - Browser acceptance driver (headless Chrome qua CDP, khong dung Playwright).
 *
 * PHAM VI THAT SU - doc ky truoc khi trich dan ket qua:
 *  - THAT: Chrome headless that (layout engine that, DOM that, Web Crypto that). Trang nap
 *    CHINH cac module domain cua branch nay, bien dich bang tsc cua repo:
 *      excel-paste, excel-paste-import, paste-batch-save, cccd-document-pair, cccd-status,
 *      cccd-upload-runner, cccd-transport, document-detail-projection.
 *    Trang cung nap CHINH file direct-entry-shell.module.css (chi doi :global(X) -> X).
 *    Moi request duoc stub TRONG TRANG => khong cham server/DB/R2/env.
 *  - KHONG: khong mount cay React component, khong chay Next.js server. Dialog la mot DOM shell
 *    mo phong markup. Vi vay hanh vi Escape/focus cua Radix KHONG duoc chung minh o day:
 *    cac check do mang scope "shell-mirror" va duoc bao cao rieng. Bang chung cho component
 *    nam o source-contract test (direct-entry-excel-paste.test.mjs, direct-entry-cccd-manager.test.mjs).
 *
 * Scope cua tung check: real-module | real-css | dom-stub | shell-mirror.
 *
 * Usage: node scripts/p1.6-i04c3-r2-browser-acceptance.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHROME = process.env.I04C3_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUTDIR = path.join(ROOT, "docs", "acceptance", "p1.6-i04c3-r2");
const ENTRIES = [
  "src/lib/direct-entry/excel-paste-import.ts",
  "src/lib/direct-entry/paste-batch-save.ts",
  "src/lib/direct-entry/cccd-status.ts",
  "src/lib/direct-entry/cccd-upload-runner.ts",
  "src/lib/direct-entry/cccd-transport.ts",
  "src/lib/direct-entry/document-detail-projection.ts",
];

const SHOTS = [
  { name: "excel-paste-desktop-1920x1080", view: "paste", pasteState: "valid",
    viewport: { width: 1920, height: 1080 } },
  { name: "excel-paste-mobile-390x844", view: "paste", pasteState: "valid",
    viewport: { width: 390, height: 844 } },
  { name: "excel-paste-errors-desktop", view: "paste", pasteState: "error",
    viewport: { width: 1920, height: 1080 } },
  { name: "cccd-dialog-desktop-1920x1080", view: "cccd",
    viewport: { width: 1920, height: 1080 } },
  { name: "cccd-dialog-mobile-390x844", view: "cccd",
    viewport: { width: 390, height: 844 } },
];

// Bien CSS cua app (src/app/globals.css) duoc dinh nghia lai nguyen gia tri de CSS module
// cua Direct Entry render dung nhu trong ung dung.
const GLOBALS_CSS = `:root {
  --background: #f7f9ff;
  --foreground: #0f172a;
  --surface: #ffffff;
  --muted: #64748b;
  --border: #e2e8f0;
  color-scheme: light;
}
body { margin: 0; background: var(--background); color: var(--foreground);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
`;

const INDEX_HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>P1.6-I04C3-R2 browser acceptance</title>
<link rel="stylesheet" href="./globals.css">
<link rel="stylesheet" href="./shell.css">
</head>
<body>
<div id="page" class="page">
  <div class="banner" role="status">
    <strong>Dữ liệu nháp trên máy chủ</strong>
    <span>Thay đổi chỉ được lưu khi máy chủ xác nhận; bản chưa lưu nằm trong bộ nhớ trang.</span>
  </div>
  <header class="header">
    <div>
      <p class="eyebrow">P1.6 · Direct Entry · I04C3-R2</p>
      <h1>Nhập liệu trực tiếp</h1>
      <p>Bản nháp của bạn · 3 dòng</p>
    </div>
    <div class="liveHeaderActions">
      <button type="button" class="secondaryButton" id="paste-excel-open">Dán từ Excel</button>
      <button type="button" class="secondaryButton">Thêm dòng</button>
      <button type="button" class="primaryButton">Lưu nháp</button>
    </div>
  </header>
  <div id="view-paste"></div>
  <div id="view-cccd"></div>
</div>
<script type="module" src="./harness.mjs"></script>
</body>
</html>
`;

function compileLib(outDir) {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(npx, [
    "tsc", ...ENTRIES,
    "--outDir", path.join(outDir, "lib"),
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
    "--rewriteRelativeImportExtensions",
    "--strict",
  ], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  const entry = path.join(outDir, "lib", "direct-entry", "excel-paste-import.js");
  if (!existsSync(entry)) throw new Error("tsc did not emit harness modules:\n" + output);
  // tsc khong copy .mjs (chi copy khi --allowJs): chep tay dung file runtime can thiet.
  const identityDir = path.join(outDir, "lib", "analytics", "identity");
  mkdirSync(identityDir, { recursive: true });
  writeFileSync(path.join(identityDir, "identity-shared.mjs"),
    readFileSync(path.join(ROOT, "src", "lib", "analytics", "identity", "identity-shared.mjs")));
  return output.split(/\r?\n/).filter((line) => line.includes("error TS")).length;
}

function buildDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "i04c3-browser-"));
  const typeErrors = compileLib(dir);
  const css = readFileSync(path.join(ROOT,
    "src/components/direct-entry/direct-entry-shell.module.css"), "utf8")
    .replace(/:global\(([^()]*)\)/g, "$1");
  writeFileSync(path.join(dir, "globals.css"), GLOBALS_CSS);
  writeFileSync(path.join(dir, "shell.css"), css);
  writeFileSync(path.join(dir, "index.html"), INDEX_HTML);
  writeFileSync(path.join(dir, "harness.mjs"),
    readFileSync(path.join(ROOT, "scripts", "p1.6-i04c3-r2-browser-page.mjs"), "utf8"));
  return { dir, typeErrors };
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

function serve(dir) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const relative = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.join(dir, decodeURIComponent(relative));
    if (!file.startsWith(dir) || !existsSync(file)) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => resolve(), 1500);
    child.on("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function readDevToolsPort(profile) {
  const fs = await import("node:fs/promises");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const data = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8");
      const port = data.split(/\r?\n/)[0].trim();
      if (port) return port;
    } catch { /* not ready yet */ }
  }
  throw new Error("DevToolsActivePort unavailable");
}

async function attach(devtoolsPort) {
  const target = await (await fetch(
    "http://127.0.0.1:" + devtoolsPort + "/json/new?about:blank",
    { method: "PUT" })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      consoleErrors.push(String(message.params?.exceptionDetails?.text ?? "exception"));
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
      consoleErrors.push((message.params.args ?? []).map((arg) => String(arg.value)).join(" "));
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
      consoleErrors.push("log: " + String(message.params.entry.text));
    }
  });
  return { socket, send, consoleErrors };
}

async function evaluate(send, expression, awaitPromise) {
  const result = await send("Runtime.evaluate", {
    expression, awaitPromise: awaitPromise === true, returnByValue: true,
  });
  if (result.result?.exceptionDetails) {
    throw new Error("page evaluate failed: " +
      JSON.stringify(result.result.exceptionDetails.exception?.description ??
        result.result.exceptionDetails.text));
  }
  return result.result?.result?.value;
}

async function main() {
  if (!existsSync(CHROME)) throw new Error("Chrome not found at " + CHROME);
  mkdirSync(OUTDIR, { recursive: true });
  const { dir, typeErrors } = buildDir();
  const { server, port } = await serve(dir);
  const profile = mkdtempSync(path.join(tmpdir(), "i04c3-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profile,
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-allow-origins=*",
    "--hide-scrollbars",
    "about:blank",
  ], { stdio: "ignore", detached: false });

  let socket = null;
  let collected = [];
  const report = { harness: "p1.6-i04c3-r2-browser-acceptance", typeErrors, shots: [], checks: [] };
  try {
    const devtoolsPort = await readDevToolsPort(profile);
    const pageUrl = "http://127.0.0.1:" + port + "/index.html";
    const attached = await attach(devtoolsPort);
    socket = attached.socket;
    const { send, consoleErrors } = attached;
    collected = consoleErrors;

    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900,
      deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: pageUrl });
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      ready = await evaluate(send,
        "typeof window.__run === 'function' && typeof window.__show === 'function'");
      if (ready === true) break;
    }
    if (ready !== true) {
      const diagnostic = await evaluate(send,
        "(async () => { const out = {}; for (const url of ['./harness.mjs','./lib/direct-entry/excel-paste-import.js','./lib/direct-entry/cccd-upload-runner.js','./lib/analytics/identity/identity-shared.mjs','./shell.css']) { try { const r = await fetch(url); out[url] = r.status + ' ' + r.headers.get('content-type'); } catch (e) { out[url] = 'ERR ' + e.message; } } try { await import('./harness.mjs'); out.import = 'ok'; } catch (e) { out.import = String(e && e.message ? e.message : e); } return JSON.stringify(out); })()",
        true);
      throw new Error("harness module did not load: " + diagnostic);
    }
    await evaluate(send, "window.__run()", true);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (await evaluate(send, "window.__DONE__ === true")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    for (const shot of SHOTS) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: shot.viewport.width,
        height: shot.viewport.height,
        deviceScaleFactor: 1,
        mobile: shot.viewport.width < 500,
      });
      const args = shot.pasteState
        ? JSON.stringify(shot.view) + "," + JSON.stringify(shot.pasteState)
        : JSON.stringify(shot.view);
      await evaluate(send, "window.__show(" + args + ")", true);
      const captured = await send("Page.captureScreenshot", { format: "png",
        captureBeyondViewport: true });
      const file = path.join(OUTDIR, shot.name + ".png");
      writeFileSync(file, Buffer.from(captured.result.data, "base64"));
      report.shots.push({ name: shot.name, viewport: shot.viewport, bytes: readFileSync(file).length });
    }

    const results = await evaluate(send, "window.__collect()");
    report.ok = results.ok === true && consoleErrors.length === 0;
    report.total = results.total;
    report.passed = results.passed;
    report.failed = results.failed;
    report.error = results.error ?? null;
    report.consoleErrors = consoleErrors;
    report.checks = results.checks;
    report.scopeCounts = results.checks.reduce((accumulator, item) => {
      accumulator[item.scope] = (accumulator[item.scope] ?? 0) + 1;
      return accumulator;
    }, {});
    report.limitations = [
      "Khong mount cay React component: hanh vi Escape/focus cua Radix chi duoc ghi nhan voi scope shell-mirror.",
      "Khong chay Next.js server, khong DB, khong R2: moi request duoc stub trong trang.",
      "Bang chung component-level nam o source-contract test, khong phai o harness nay.",
    ];
  } catch (error) {
    report.ok = false;
    report.error = String(error && error.message ? error.message : error);
    report.consoleErrors = collected;
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    try { chrome.kill(); } catch { /* ignore */ }
    await waitForExit(chrome);
    server.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    rmSync(profile, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }

  writeFileSync(path.join(OUTDIR, "browser-acceptance.json"),
    JSON.stringify(report, null, 2) + "\n");
  const failed = report.checks.filter((item) => !item.ok);
  console.log(JSON.stringify({
    ok: report.ok,
    total: report.total,
    passed: report.passed,
    failed: report.failed,
    scopeCounts: report.scopeCounts,
    error: report.error,
    failedChecks: failed.map((item) => item.scope + " :: " + item.name),
    shots: report.shots.map((shot) => shot.name),
  }, null, 2));
  if (report.ok !== true) process.exitCode = 1;
}

main().catch((error) => {
  console.error("I04C3-R2 browser acceptance failed: " + error.message);
  process.exitCode = 1;
});
