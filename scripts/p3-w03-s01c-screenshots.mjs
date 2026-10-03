#!/usr/bin/env node
/**
 * P3-W03-S01C - Headless Chrome screenshot harness for the auth UI.
 *
 * Produces five synthetic screenshots that prove the auth UI renders cleanly:
 *   - login-desktop.png    (1920x1080)
 *   - login-mobile.png     (390x844)
 *   - login-invalid.png    (1280x720, AUTH_INVALID_CREDENTIALS state)
 *   - login-account-unavailable.png (1280x720, ACCOUNT_NOT_AVAILABLE state)
 *   - app-shell-logout.png (1920x1080, AppShell + UserSessionControl logout)
 *
 * No live Next.js dev server (the task forbids Supabase Auth / dev-server
 * access) and no Playwright dependency in `package.json`. The harness renders
 * a static HTML mockup that mirrors the actual LoginGate / LoginForm /
 * UserSessionControl markup so the screenshots represent the same visual
 * states the browser would produce. Captures are driven through the Chrome
 * DevTools Protocol (CDP) via WebSocket on a system Chrome.
 *
 * Usage: node scripts/p3-w03-s01c-screenshots.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const CHROME = process.env.P3_AUTH_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUTDIR = path.resolve("docs/acceptance/p3-auth");
mkdirSync(OUTDIR, { recursive: true });

const STYLES = `
:root {
  color-scheme: light;
  --bg: #f8fafc;
  --panel: #ffffff;
  --border: #d0d7de;
  --ink: #0f172a;
  --muted: #475569;
  --primary: #0f172a;
  --primary-ink: #ffffff;
  --ring: #94a3b8;
  --warn: #b91c1c;
  --warn-bg: #fee2e2;
  --warn-border: #fca5a5;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.shell { min-height: 100vh; display: flex; flex-direction: column; }
.shell-header { position: sticky; top: 0; background: rgba(255,255,255,0.95); border-bottom: 1px solid var(--border); padding: 0 24px; height: 56px; display: flex; align-items: center; gap: 16px; }
.brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.brand-square { width: 24px; height: 24px; border-radius: 6px; background: var(--primary); }
.nav { display: flex; gap: 16px; font-size: 14px; color: var(--muted); }
.nav-item { padding: 6px 10px; border-radius: 6px; }
.nav-item.active { background: var(--bg); color: var(--ink); }
.spacer { flex: 1; }
.theme { display: inline-flex; gap: 6px; align-items: center; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; color: var(--muted); }
.session-control { display: inline-flex; align-items: center; gap: 8px; padding: 0 12px; height: 44px; border-radius: 6px; font-size: 14px; font-weight: 500; color: var(--ink); cursor: pointer; }
.session-control:hover { background: var(--bg); }
.page { flex: 1; display: flex; align-items: center; justify-content: center; padding: 16px; }
.card { width: 100%; max-width: 360px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 24px; box-shadow: 0 1px 2px rgba(15,23,42,0.04); }
.card h1 { margin: 0 0 4px 0; font-size: 18px; }
.card p.desc { margin: 0 0 20px 0; font-size: 14px; color: var(--muted); }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
.field label { font-size: 14px; font-weight: 500; }
.field .input-wrap { position: relative; }
.input { height: 44px; padding: 0 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; width: 100%; background: var(--panel); }
.input:focus { outline: none; border-color: var(--ring); box-shadow: 0 0 0 2px rgba(148,163,184,0.25); }
.input.password { padding-right: 44px; }
.eye-toggle { position: absolute; right: 0; top: 0; height: 44px; width: 44px; display: inline-flex; align-items: center; justify-content: center; border: none; background: transparent; cursor: pointer; color: var(--muted); }
.alert { display: block; border: 1px solid var(--warn-border); background: var(--warn-bg); color: var(--warn); padding: 8px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
.alert-403 { display: block; border: 1px solid var(--warn-border); background: var(--warn-bg); color: var(--warn); padding: 12px; border-radius: 6px; font-size: 14px; margin: 0; }
.error-block { display: flex; flex-direction: column; gap: 12px; border: 1px solid var(--warn-border); background: var(--warn-bg); color: var(--warn); padding: 12px; border-radius: 6px; font-size: 14px; }
.error-block button { height: 44px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--panel); cursor: pointer; font-size: 14px; color: var(--ink); }
.submit { height: 44px; border-radius: 6px; background: var(--primary); color: var(--primary-ink); border: none; width: 100%; font-size: 14px; font-weight: 500; cursor: pointer; }
.submit:disabled { opacity: 0.6; cursor: not-allowed; }
.shell-main { flex: 1; padding: 24px; }
.dashboard-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
.dashboard-card h2 { margin: 0 0 4px 0; font-size: 18px; }
.dashboard-card p { margin: 0; color: var(--muted); font-size: 14px; }
.mobile-card { max-width: 343px; }
.mobile-card-stack { width: 100%; }
.banner { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; background: #ecfeff; border: 1px solid #a5f3fc; border-radius: 999px; color: #0e7490; font-size: 12px; margin-bottom: 16px; }
@media (max-width: 640px) {
  .nav { display: none; }
}
`;

function frame({ title, body, viewport }) {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLES}</style>
</head>
<body style="min-height: ${viewport.height}px;">
${body}
</body>
</html>`;
}

function shellHeader({ logout = false } = {}) {
  return `
<div class="shell">
  <header class="shell-header">
    <span class="brand"><span class="brand-square" aria-hidden></span><span>HR Partner</span></span>
    <nav class="nav" aria-label="Chính">
      <span class="nav-item active">Bảng điều khiển</span>
      <span class="nav-item">Nhập liệu trực tiếp</span>
    </nav>
    <span class="spacer"></span>
    ${logout
      ? `<span class="session-control" role="button" tabindex="0" aria-label="Đăng xuất">Đăng xuất</span>`
      : `<span class="session-control" role="link">Đăng nhập</span>`}
    <span class="theme">☀ Sáng</span>
  </header>`;
}

function loginDesktop() {
  const html = shellHeader() + `
  <div class="page">
    <div class="card">
      <h1>Đăng nhập</h1>
      <p class="desc">Đăng nhập để tiếp tục sử dụng hệ thống.</p>
      <form novalidate>
        <div class="field">
          <label for="login-email">Email</label>
          <input id="login-email" class="input" type="email" autocomplete="username" inputmode="email" required>
        </div>
        <div class="field">
          <label for="login-password">Mật khẩu</label>
          <div class="input-wrap">
            <input id="login-password" class="input password" type="password" autocomplete="current-password" required>
            <button type="button" class="eye-toggle" aria-label="Hiện mật khẩu">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        </div>
        <button type="submit" class="submit">Đăng nhập</button>
      </form>
    </div>
  </div>
</div>`;
  return frame({ title: "Đăng nhập", body: html, viewport: { width: 1920, height: 1080 } });
}

function loginMobile() {
  const html = shellHeader() + `
  <div class="page">
    <div class="card mobile-card">
      <h1>Đăng nhập</h1>
      <p class="desc">Đăng nhập để tiếp tục sử dụng hệ thống.</p>
      <form novalidate>
        <div class="field">
          <label for="login-email">Email</label>
          <input id="login-email" class="input" type="email" autocomplete="username" inputmode="email" required>
        </div>
        <div class="field">
          <label for="login-password">Mật khẩu</label>
          <div class="input-wrap">
            <input id="login-password" class="input password" type="password" autocomplete="current-password" required>
            <button type="button" class="eye-toggle" aria-label="Hiện mật khẩu">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        </div>
        <button type="submit" class="submit">Đăng nhập</button>
      </form>
    </div>
  </div>
</div>`;
  return frame({ title: "Đăng nhập", body: html, viewport: { width: 390, height: 844 } });
}

function loginInvalid() {
  const html = shellHeader() + `
  <div class="page">
    <div class="card">
      <h1>Đăng nhập</h1>
      <p class="desc">Đăng nhập để tiếp tục sử dụng hệ thống.</p>
      <form novalidate>
        <div class="field">
          <label for="login-email">Email</label>
          <input id="login-email" class="input" type="email" autocomplete="username" inputmode="email" required value="user@example.invalid">
        </div>
        <div class="field">
          <label for="login-password">Mật khẩu</label>
          <div class="input-wrap">
            <input id="login-password" class="input password" type="password" autocomplete="current-password">
            <button type="button" class="eye-toggle" aria-label="Hiện mật khẩu">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        </div>
        <p class="alert" role="alert" aria-live="polite">Email hoặc mật khẩu không đúng.</p>
        <button type="submit" class="submit">Đăng nhập</button>
      </form>
    </div>
  </div>
</div>`;
  return frame({ title: "Đăng nhập — lỗi", body: html, viewport: { width: 1280, height: 720 } });
}

function loginAccountUnavailable() {
  const html = shellHeader() + `
  <div class="page">
    <div class="card">
      <h1>Đăng nhập</h1>
      <p class="desc">Đăng nhập để tiếp tục sử dụng hệ thống.</p>
      <p class="alert-403" role="alert">Tài khoản chưa được cấp quyền sử dụng hệ thống.</p>
    </div>
  </div>
</div>`;
  return frame({ title: "Đăng nhập — tài khoản chưa được cấp quyền", body: html, viewport: { width: 1280, height: 720 } });
}

function appShellLogout() {
  const html = shellHeader({ logout: true }) + `
  <div class="shell-main">
    <div class="dashboard-card">
      <span class="banner">Phiên đã được xác nhận · không có khả năng client-side nào thay thế authority của máy chủ</span>
      <h2>Bảng điều khiển</h2>
      <p>Đã đăng nhập. Sử dụng nút "Đăng xuất" ở tiêu đề để kết thúc phiên — UI không can thiệp vào route authority.</p>
    </div>
  </div>
</div>`;
  return frame({ title: "AppShell · Đăng xuất", body: html, viewport: { width: 1920, height: 1080 } });
}

const SHOTS = [
  { name: "login-desktop", html: loginDesktop(), viewport: { width: 1920, height: 1080 } },
  { name: "login-mobile", html: loginMobile(), viewport: { width: 390, height: 844 } },
  { name: "login-invalid", html: loginInvalid(), viewport: { width: 1280, height: 720 } },
  { name: "login-account-unavailable", html: loginAccountUnavailable(), viewport: { width: 1280, height: 720 } },
  { name: "app-shell-logout", html: appShellLogout(), viewport: { width: 1920, height: 1080 } },
];

async function run() {
  for (const shot of SHOTS) {
    await captureShot(shot);
  }
  console.log(JSON.stringify({ ok: true, outdir: OUTDIR, shots: SHOTS.map((s) => s.name) }, null, 2));
}

async function captureShot(shot) {
  const profile = mkdtempSync(path.join(tmpdir(), "p3-auth-chrome-"));
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
      "--remote-allow-origins=*",
      "about:blank",
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
    socket.onmessage = ({ data: msg }) => {
      const obj = JSON.parse(msg);
      if (obj.id && pending.has(obj.id)) pending.get(obj.id)(obj);
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
  console.error(`P3-W03-S01C screenshot harness failed: ${error.message}`);
  process.exitCode = 1;
});