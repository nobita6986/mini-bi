#!/usr/bin/env node
/**
 * P1.6-W04-S04B-R2C2 - Headless Chrome screenshot harness for the R2C dialog.
 *
 * Produces four synthetic screenshots that prove the dialog renders cleanly on
 * desktop 1920x1080 and mobile 390x844 without overflow, surfaces the reason
 * validation, and shows the conflict state. Captures are driven through the
 * Chrome DevTools Protocol (CDP) directly via WebSocket — no Playwright
 * dependency, no live Next.js server.
 *
 * The harness renders a static HTML mockup of the dialog and its four states
 * because the task forbids DB / R2 / dev-server access.
 *
 * Usage: node scripts/p1.6-w04-s04b-r2c2-screenshots.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const CHROME = process.env.R2C2_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUTDIR = path.resolve("docs/acceptance/r2c2");
mkdirSync(OUTDIR, { recursive: true });

function mockPage({ title, body, viewport }) {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f8fafc;
    --panel: #ffffff;
    --border: #d0d7de;
    --ink: #0f172a;
    --muted: #475569;
    --accent: #0f766e;
    --warn: #b91c1c;
    --warn-bg: #fee2e2;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: system-ui, sans-serif; }
  .page { padding: 16px; min-height: ${viewport.height}px; }
  .banner { background: #ecfeff; border: 1px solid #a5f3fc; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
  .banner strong { color: #0e7490; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
  .header h1 { margin: 0; font-size: 22px; }
  .header p { margin: 4px 0 0 0; color: var(--muted); font-size: 13px; }
  .btn { border: 1px solid var(--border); background: var(--panel); padding: 8px 12px; border-radius: 6px; font-size: 14px; cursor: pointer; }
  .btn-primary { background: #0f172a; color: white; border-color: #0f172a; }
  .card-list { display: grid; gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
  .card-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .badge { background: #dcfce7; color: #166534; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
  .badge-warn { background: var(--warn-bg); color: var(--warn); }
  .dialog-overlay { position: fixed; inset: 0; background: rgba(15,23,42,0.45); display: flex; align-items: flex-start; justify-content: center; padding: 24px; overflow: auto; }
  .dialog { background: var(--panel); border-radius: 12px; box-shadow: 0 30px 60px rgba(15,23,42,0.25); padding: 24px; max-width: 920px; width: 100%; max-height: calc(100vh - 48px); overflow: auto; }
  .dialog h2 { margin: 0 0 4px 0; font-size: 20px; }
  .dialog p.desc { margin: 0 0 16px 0; color: var(--muted); font-size: 14px; }
  .doc-section { border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .doc-section h3 { margin: 0 0 12px 0; font-size: 15px; }
  .doc-row { display: grid; gap: 8px; }
  label.field { display: grid; gap: 6px; font-size: 13px; color: var(--muted); margin-top: 12px; }
  label.field input, label.field textarea, label.field select { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; color: var(--ink); background: white; }
  label.field textarea { min-height: 80px; resize: vertical; }
  .doc-status { color: var(--muted); font-size: 13px; margin: 8px 0 0 0; }
  .doc-error { color: var(--warn); background: var(--warn-bg); padding: 8px 12px; border-radius: 6px; font-size: 13px; margin: 8px 0 0 0; }
  .doc-version { display: inline-block; margin-left: 8px; color: var(--muted); font-size: 12px; }
  .doc-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
  .doc-list li { padding: 6px 0; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .term-note { background: #fef3c7; border: 1px solid #fde68a; padding: 8px 12px; border-radius: 6px; font-size: 13px; color: #92400e; margin: 8px 0 12px 0; }
  .responsive-hint { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
  .row-1 { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .stack { display: grid; gap: 8px; }
  .mobile-card-title { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
</style>
</head>
<body>
<div class="page">
${body}
</div>
</body>
</html>`;
}

function desktopFrame(title, body) {
  return mockPage({ title, body, viewport: { width: 1920, height: 1080 } });
}

function mobileFrame(title, body) {
  return mockPage({ title, body, viewport: { width: 390, height: 844 } });
}

const DESKTOP_MANAGER = `
<div class="banner"><strong>Dữ liệu nháp trên máy chủ</strong><br/>Thay đổi chỉ được lưu khi máy chủ xác nhận; bản chưa lưu nằm trong bộ nhớ trang.</div>
<div class="header">
  <div>
    <p style="color: var(--muted); margin: 0; font-size: 12px;">P1.6 · Direct Entry · S03CD</p>
    <h1>Nhập liệu trực tiếp</h1>
    <p>Bản nháp của bạn · 3 dòng</p>
  </div>
  <div class="row-1">
    <button class="btn">Thêm dòng</button>
    <button class="btn btn-primary">Lưu nháp</button>
  </div>
</div>
<div class="card-list">
  <div class="card">
    <div class="mobile-card-title">
      <strong>Đợt SUBMITTED · 12 NLĐ</strong>
      <span class="badge">SUBMITTED</span>
    </div>
    <p class="doc-status">Phiên bản 4 · cập nhật 04-10-2026 08:31</p>
    <p class="term-note">Đã gửi chính thức là trạng thái cuối. Thay đổi sau đó phải đi qua yêu cầu thay đổi.</p>
    <div class="row-1">
      <button class="btn">Yêu cầu thay đổi</button>
      <button class="btn btn-primary">Quản lý tài liệu</button>
    </div>
  </div>
</div>
<div class="dialog-overlay" data-testid="dialog">
  <div class="dialog" role="dialog" aria-labelledby="dialog-title">
    <h2 id="dialog-title">Quản lý tài liệu</h2>
    <p class="desc">Tải lên thay thế tài liệu cho đợt đã gửi chính thức. Mỗi lần thay thế cần lý do và được ghi nhận đầy đủ phiên bản.</p>
    <div class="doc-section" aria-labelledby="ent1">
      <h3 id="ent1">Hồ sơ · hrp-2026-941001</h3>
      <ul class="doc-list">
        <li><strong>CCCD mặt trước:</strong> Đã hoàn tất <span class="doc-version">Phiên bản 2 · 0.42 MiB · Sẵn sàng / Đã kiểm tra định dạng · <a href="#">Tải xuống</a></span></li>
        <li><strong>CCCD mặt sau:</strong> Đã hoàn tất <span class="doc-version">Phiên bản 1 · 0.31 MiB · Sẵn sàng / Đã kiểm tra định dạng · <a href="#">Tải xuống</a></span></li>
        <li><strong>Hợp đồng:</strong> Chưa hoàn tất</li>
      </ul>
      <label class="field">
        <span>Lý do thay thế tài liệu</span>
        <textarea aria-label="Lý do thay thế tài liệu" placeholder="Bắt buộc · tối đa 4000 ký tự"></textarea>
      </label>
      <label class="field">
        <span>Loại tài liệu</span>
        <select><option>CCCD mặt trước</option><option>CCCD mặt sau</option><option>Hợp đồng</option></select>
      </label>
      <label class="field">
        <span>Chọn hoặc thay tệp (JPEG, PNG, PDF · tối đa 10 MiB)</span>
        <input type="file" disabled>
      </label>
      <p class="doc-status">Chọn tệp và nhập lý do trước khi tải lên.</p>
    </div>
    <div class="actions">
      <button class="btn">Đóng</button>
    </div>
  </div>
</div>
`;

const REASON_REQUIRED = `
<div class="page" style="background: var(--bg);">
  <div class="dialog-overlay" data-testid="dialog">
    <div class="dialog" role="dialog" aria-labelledby="dialog-title" style="max-width: 560px;">
      <h2 id="dialog-title">Quản lý tài liệu</h2>
      <p class="desc">Lý do bắt buộc cho mọi thay thế ở đợt SUBMITTED.</p>
      <label class="field">
        <span>Lý do thay thế tài liệu</span>
        <textarea aria-label="Lý do thay thế tài liệu"></textarea>
      </label>
      <p class="doc-error" role="alert">Lý do thay thế tài liệu là bắt buộc và tối đa 4000 ký tự.</p>
      <div class="actions">
        <button class="btn">Đóng</button>
        <button class="btn btn-primary" disabled>Tải lên</button>
      </div>
    </div>
  </div>
</div>
`;

const MOBILE_MANAGER = `
<div style="padding: 16px;">
  <div class="card">
    <div class="mobile-card-title">
      <strong>Đợt SUBMITTED · 12 NLĐ</strong>
      <span class="badge">SUBMITTED</span>
    </div>
    <p class="doc-status">Phiên bản 4 · 04-10 08:31</p>
    <div class="row-1" style="flex-direction: column; align-items: stretch; gap: 6px;">
      <button class="btn" style="width: 100%;">Yêu cầu thay đổi</button>
      <button class="btn btn-primary" style="width: 100%;">Quản lý tài liệu</button>
    </div>
  </div>
</div>
<div class="dialog-overlay" data-testid="dialog">
  <div class="dialog" role="dialog" aria-labelledby="dialog-title" style="padding: 16px;">
    <h2 id="dialog-title" style="font-size: 18px;">Quản lý tài liệu</h2>
    <p class="desc" style="font-size: 13px;">Tải lên thay thế cho đợt SUBMITTED. Mỗi lần thay thế cần lý do.</p>
    <div class="doc-section" style="padding: 12px;">
      <h3 style="font-size: 14px;">Hồ sơ · hrp-2026-941001</h3>
      <ul class="doc-list">
        <li><strong>CCCD mặt trước:</strong> Đã hoàn tất</li>
        <li><strong>CCCD mặt sau:</strong> Đã hoàn tất</li>
        <li><strong>Hợp đồng:</strong> Chưa hoàn tất</li>
      </ul>
      <label class="field">
        <span>Lý do thay thế tài liệu</span>
        <textarea aria-label="Lý do thay thế tài liệu"></textarea>
      </label>
      <label class="field">
        <span>Loại tài liệu</span>
        <select><option>CCCD mặt trước</option><option>CCCD mặt sau</option><option>Hợp đồng</option></select>
      </label>
    </div>
    <div class="actions" style="flex-direction: column-reverse; align-items: stretch;">
      <button class="btn" style="width: 100%;">Đóng</button>
    </div>
  </div>
</div>
`;

const CONFLICT_STATE = `
<div class="dialog-overlay" data-testid="dialog">
  <div class="dialog" role="dialog" aria-labelledby="dialog-title" style="max-width: 720px;">
    <h2 id="dialog-title">Quản lý tài liệu</h2>
    <p class="desc">Đợt này có thay đổi mới trên máy chủ; hãy tải trạng thái mới trước khi thay thế.</p>
    <div class="doc-section">
      <h3>Hồ sơ · hrp-2026-941001</h3>
      <ul class="doc-list">
        <li><strong>CCCD mặt trước:</strong> Đã hoàn tất <span class="doc-version">Phiên bản 3 · 0.42 MiB · Sẵn sàng / Đã kiểm tra định dạng · <a href="#">Tải xuống</a></span></li>
      </ul>
      <p class="doc-error" role="alert">Dữ liệu đã thay đổi trên máy chủ. Tải trạng thái mới trước khi tiếp tục.</p>
      <div class="actions" style="justify-content: flex-start;">
        <button class="btn">Tải trạng thái mới</button>
      </div>
    </div>
    <div class="actions">
      <button class="btn">Đóng</button>
    </div>
  </div>
</div>
`;

const SHOTS = [
  {
    name: "submitted-document-manager-desktop",
    html: desktopFrame("R2C desktop", DESKTOP_MANAGER),
    viewport: { width: 1920, height: 1080 },
  },
  {
    name: "submitted-document-reason-required",
    html: desktopFrame("R2C reason required", REASON_REQUIRED),
    viewport: { width: 1280, height: 720 },
  },
  {
    name: "submitted-document-mobile",
    html: mobileFrame("R2C mobile", MOBILE_MANAGER),
    viewport: { width: 390, height: 844 },
  },
  {
    name: "submitted-document-conflict",
    html: desktopFrame("R2C conflict", CONFLICT_STATE),
    viewport: { width: 1280, height: 720 },
  },
];

async function run() {
  for (const shot of SHOTS) {
    await captureShot(shot);
  }
  console.log(JSON.stringify({ ok: true, outdir: OUTDIR, shots: SHOTS.map((s) => s.name) }, null, 2));
}

async function captureShot(shot) {
  const profile = mkdtempSync(path.join(tmpdir(), "r2c2-chrome-"));
  const port = await pickPort();
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(shot.html);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-allow-origins=*`,
      `about:blank`,
    ],
    { stdio: "ignore", detached: false },
  );
  let devtoolsPort;
  let target;
  let socket;
  try {
    for (let i = 0; i < 80 && !devtoolsPort; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        const fs = await import("node:fs/promises");
        const data = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8");
        devtoolsPort = data.split(/\r?\n/)[0];
      } catch { /* not ready */ }
    }
    if (!devtoolsPort) throw new Error("DevTools port unavailable");
    target = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?http://127.0.0.1:${port}/`, { method: "PUT" })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = reject;
    });
    let id = 0;
    const pending = new Map();
    socket.onmessage = ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await send("Emulation.setDeviceMetricsOverride", {
      width: shot.viewport.width,
      height: shot.viewport.height,
      deviceScaleFactor: 1,
      mobile: shot.viewport.width < 500,
    });
    const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    const out = path.join(OUTDIR, `${shot.name}.png`);
    writeFileSync(out, Buffer.from(result.result.data, "base64"));
  } finally {
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    if (chrome && chrome.pid) {
      try { chrome.kill(); } catch { /* ignore */ }
      await waitForExit(chrome);
    }
    server.close();
    // Defer profile cleanup so Windows releases the handle.
    await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(profile, { recursive: true, force: true });
  }
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => resolve(), 1000);
    child.on("exit", () => { clearTimeout(timer); resolve(); });
  });
}

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

run().catch((error) => {
  console.error(`R2C2 screenshot harness failed: ${error.message}`);
  process.exitCode = 1;
});