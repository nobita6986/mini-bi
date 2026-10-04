#!/usr/bin/env node
/**
 * P1.6-I04C3-R3A - Browser visual acceptance cho preview ho so day du.
 *
 * PHAM VI THAT SU:
 *  - THAT: component React cua branch nay duoc BIEN DICH bang tsc cua repo va RENDER THAT bang
 *    react-dom/server; CSS module that cua repo duoc nhung nguyen van; Chrome headless that chup
 *    anh o 1920x1080 va 390x844. Du lieu dua vao la GIA (synthetic).
 *  - KHONG: khong mount tuong tac (khong co React runtime trong trang), khong chay Next.js server,
 *    khong DB/R2. Vi vay Escape/focus cua Radix KHONG duoc chung minh o day; phan do chi co
 *    bang chung o muc ma nguon (direct-entry-worker-profile-paste.test.mjs).
 *
 * Vi khong mount tuong tac, trang thai cua task nay la LOCAL_PASS, khong phai BROWSER_PASS.
 *
 * Usage: node scripts/p1.6-i04c3-r3a-preview-acceptance.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync }
  from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHROME = process.env.R3A_CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUTDIR = path.join(ROOT, "docs", "acceptance", "p1.6-i04c3-r3a");
const ENTRY = "src/components/direct-entry/direct-entry-worker-profile-paste-dialog.tsx";

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

function compile(dir, outDir) {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  // tsconfig rieng: giu nguyen alias "@/..." cua repo va emit ESM cho Node.
  const config = {
    compilerOptions: {
      target: "es2022",
      lib: ["dom", "dom.iterable", "esnext"],
      module: "esnext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      isolatedModules: true,
      resolveJsonModule: true,
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: true,
      allowJs: true,
      types: ["node"],
      typeRoots: [path.join(ROOT, "node_modules", "@types")],
      incremental: false,
      noEmit: false,
      outDir,
      rootDir: path.join(ROOT, "src"),
      baseUrl: ROOT,
      paths: { "@/*": ["src/*"] },
    },
    include: [path.join(ROOT, ENTRY), path.join(dir, "css-modules.d.ts")],
  };
  const configPath = path.join(dir, "tsconfig.r3a.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const result = spawnSync(npx, ["tsc", "-p", configPath],
    { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  const emitted = path.join(outDir, "components", "direct-entry",
    "direct-entry-worker-profile-paste-dialog.js");
  if (!existsSync(emitted)) throw new Error("tsc did not emit the component:\n" + output);
  const identityDir = path.join(outDir, "lib", "analytics", "identity");
  mkdirSync(identityDir, { recursive: true });
  writeFileSync(path.join(identityDir, "identity-shared.mjs"),
    readFileSync(path.join(ROOT, "src", "lib", "analytics", "identity", "identity-shared.mjs")));
  const errors = output.split(/\r?\n/).filter((line) => line.includes("error TS"));
  return { typeErrors: errors.length, typeErrorLines: errors.slice(0, 12) };
}

function buildDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "i04c3-r3a-"));
  const outDir = path.join(dir, "build");
  mkdirSync(outDir, { recursive: true });
  // Khai bao ambient cho CSS module: Next cap, nhung tsconfig rut gon thi khong.
  writeFileSync(path.join(dir, "css-modules.d.ts"),
    "declare module '*.module.css' {\n  const styles: Record<string, string>;\n  export default styles;\n}\n");
  // Node/tsc can resolve react/@types/node tu node_modules cua repo qua junction.
  symlinkSync(path.join(ROOT, "node_modules"), path.join(outDir, "node_modules"), "junction");
  writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }, null, 2));
  const { typeErrors, typeErrorLines } = compile(dir, outDir);
  const css = readFileSync(path.join(ROOT,
    "src/components/direct-entry/direct-entry-shell.module.css"), "utf8")
    .replace(/:global\(([^()]*)\)/g, "$1");
  writeFileSync(path.join(outDir, "shell.css"), css);
  writeFileSync(path.join(outDir, "globals.css"), GLOBALS_CSS);
  writeFileSync(path.join(outDir, "render.mjs"),
    readFileSync(path.join(ROOT, "scripts", "p1.6-i04c3-r3a-preview-render.mjs"), "utf8"));
  return { dir, outDir, typeErrors, typeErrorLines };
}

function renderVariants(dir) {
  const result = spawnSync(process.execPath, [
    "--import", pathToFileURL(path.join(ROOT, "scripts", "lib", "r3a-ssr-register.mjs")).href,
    "./render.mjs",
  ], { cwd: dir, encoding: "utf8", env: { ...process.env, R3A_SSR_ROOT: dir } });
  if (result.status !== 0 || !result.stdout) {
    throw new Error("SSR render failed (" + result.status + "):\n" + (result.stderr ?? ""));
  }
  return JSON.parse(result.stdout);
}

function check(scope, name, ok, detail) {
  return { scope, name, ok: ok === true, detail: detail === undefined ? null : detail };
}

/**
 * Bo noi dung textarea (buffer dan cua nguoi dung) truoc khi kiem tra mask.
 * Textarea la INPUT nguoi dung tu dan; masking ap dung cho phan projection ho so.
 */
function withoutInputBuffer(html) {
  return html.replace(/<textarea[\s\S]*?<\/textarea>/g, "<textarea></textarea>");
}

function htmlChecks(variants) {
  const checks = [];
  const valid = withoutInputBuffer(variants.valid);
  const mixed = withoutInputBuffer(variants.mixed);
  const add = (scope, name, ok, detail) => checks.push(check(scope, name, ok, detail));

  add("real-component", "tieu de dialog la output cua component",
    valid.includes("Dán hồ sơ từ Excel"));
  add("real-component", "CTA dung trang thai cho server",
    valid.includes("Chờ máy chủ hỗ trợ hồ sơ đầy đủ"));
  add("real-component", "CTA luon disabled",
    /data-testid="profile-submit"[^>]*disabled/.test(valid));
  add("real-component", "khong co nut nao mang nhan Luu",
    !/>\s*Lưu\s*</.test(valid));
  add("real-component", "summary co du bon chi so",
    valid.includes("3 dòng") && valid.includes("hợp lệ") && valid.includes("lỗi") &&
    valid.includes("cảnh báo"));
  add("real-component", "summary loi dung role=alert",
    /data-testid="profile-summary"[^>]*role="alert"/.test(mixed));
  add("real-component", "summary hop le dung role=status",
    /data-testid="profile-summary"[^>]*role="status"/.test(valid));
  for (const section of ["Công việc", "Hồ sơ cá nhân", "Tình trạng làm việc", "Thanh toán",
    "Validation-only"]) {
    add("real-component", "co section " + section, valid.includes(">" + section + "</h4>"));
  }
  add("real-component", "co dong chi tiet da mo rong",
    valid.includes('data-testid="profile-detail-2"'));
  add("real-component", "dong chua mo khong render chi tiet",
    !valid.includes('data-testid="profile-detail-3"'));
  add("real-component", "co nut xem chi tiet cho tung dong",
    valid.includes('data-testid="profile-detail-toggle-3"'));

  // Che PII: CCCD va STK chi hien 4 ky tu cuoi.
  add("real-component", "CCCD duoc mask", valid.includes("••••••••8901"));
  add("real-component", "khong lo raw CCCD 12 so", !valid.includes("012345678901"));
  add("real-component", "khong lo raw CCCD 9 so", !valid.includes("012345678<"));
  add("real-component", "STK duoc mask", valid.includes("••••••••6789"));
  add("real-component", "khong lo raw STK", !valid.includes("000123456789"));
  add("real-component", "khong co raw JSON",
    !valid.includes("<pre") && !valid.includes('{"') && !valid.includes("&quot;state&quot;"));
  for (const forbidden of ["storage_key", "checksum", "bucket", "signed", "actor_id",
    "auth_subject", "capability", "scope_kind", "submission_id", "entry_ids"]) {
    add("real-component", "khong lo " + forbidden, !valid.includes(forbidden));
  }

  // Trang thai hon hop theo yeu cau: 1 dong hop le, 1 dong thieu catalog, 1 dong loi CCCD/ngay.
  add("real-component", "co dong hop le", /profile-status-2"[^>]*>Hợp lệ</.test(mixed));
  add("real-component", "co dong thieu catalog",
    mixed.includes("Không có trong danh mục của ngày hiệu lực"));
  add("real-component", "co dong loi CCCD", mixed.includes("CMT/CCCD phải gồm đúng 9 hoặc 12 chữ số"));
  add("real-component", "co dong loi ngay", mixed.includes("Ngày không hợp lệ"));
  add("real-component", "dong loi hien badge loi", />Có lỗi</.test(mixed));
  add("real-component", "khong POST/fetch trong markup",
    !/<form|method="post"/i.test(valid));
  // Gia tri nhay cam chi duoc phep xuat hien trong buffer dan (textarea), khong o projection.
  const rawOccurrences = (variants.valid.match(/012345678901/g) ?? []).length;
  add("real-component", "raw CCCD chi nam trong buffer dan", rawOccurrences === 1,
    { rawOccurrences });
  add("real-component", "chi co mot textarea (buffer dan)",
    (variants.valid.match(/<textarea/g) ?? []).length === 1);
  // Trong trang thai hon hop, CCCD dung van bi mask.
  add("real-component", "trang thai hon hop van mask CCCD",
    !mixed.includes("012345678901") && !mixed.includes("000123456789"));
  return checks;
}

function serveHtml(pages) {
  return import("node:http").then(({ createServer }) => new Promise((resolve) => {
    const server = createServer((request, response) => {
      const key = request.url.replace(/^\//, "").replace(/\.html$/, "") || "valid";
      const html = pages[key];
      if (!html) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  }));
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
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  return { socket, send };
}

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true });
  return result.result?.result?.value;
}

const SHOTS = [
  { name: "fullprofile-valid-desktop-1920x1080", variant: "valid",
    viewport: { width: 1920, height: 1080 } },
  { name: "fullprofile-valid-mobile-390x844", variant: "valid",
    viewport: { width: 390, height: 844 } },
  { name: "fullprofile-mixed-desktop-1920x1080", variant: "mixed",
    viewport: { width: 1920, height: 1080 } },
  { name: "fullprofile-mixed-mobile-390x844", variant: "mixed",
    viewport: { width: 390, height: 844 } },
];

async function main() {
  if (!existsSync(CHROME)) throw new Error("Chrome not found at " + CHROME);
  mkdirSync(OUTDIR, { recursive: true });
  const { dir, outDir, typeErrors, typeErrorLines } = buildDir();
  const report = { harness: "p1.6-i04c3-r3a-preview-acceptance", typeErrors, typeErrorLines,
    checks: [], shots: [] };
  try {
    const variants = renderVariants(outDir);
    report.checks = htmlChecks(variants);
    for (const [key, html] of Object.entries(variants)) {
      writeFileSync(path.join(OUTDIR, "preview-" + key + ".html"), html);
    }
    const { server, port } = await serveHtml(variants);
    const profile = mkdtempSync(path.join(tmpdir(), "i04c3-r3a-chrome-"));
    const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0",
      "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
      "--remote-allow-origins=*", "--hide-scrollbars", "about:blank"],
    { stdio: "ignore", detached: false });
    let socket = null;
    try {
      const devtoolsPort = await readDevToolsPort(profile);
      const attached = await attach(devtoolsPort);
      socket = attached.socket;
      const { send } = attached;
      for (const shot of SHOTS) {
        await send("Page.navigate", { url: "http://127.0.0.1:" + port + "/" + shot.variant + ".html" });
        await new Promise((resolve) => setTimeout(resolve, 500));
        await send("Emulation.setDeviceMetricsOverride", { width: shot.viewport.width,
          height: shot.viewport.height, deviceScaleFactor: 1, mobile: shot.viewport.width < 500 });
        await new Promise((resolve) => setTimeout(resolve, 250));
        const metrics = await evaluate(send,
          "JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, dialogWidth: (document.querySelector('.profilePasteDialog')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width })");
        const parsed = JSON.parse(metrics);
        report.checks.push(check("real-css", shot.name + ".khong-tran-ngang",
          parsed.scrollWidth <= parsed.innerWidth + 1, parsed));
        report.checks.push(check("real-css", shot.name + ".dialog-nam-trong-viewport",
          parsed.dialogWidth <= parsed.innerWidth + 1, parsed));
        const captured = await send("Page.captureScreenshot", { format: "png",
          captureBeyondViewport: true });
        const file = path.join(OUTDIR, shot.name + ".png");
        writeFileSync(file, Buffer.from(captured.result.data, "base64"));
        report.shots.push({ name: shot.name, viewport: shot.viewport,
          bytes: readFileSync(file).length });
      }
    } finally {
      if (socket && socket.readyState === WebSocket.OPEN) socket.close();
      try { chrome.kill(); } catch { /* ignore */ }
      await waitForExit(chrome);
      server.close();
      await new Promise((resolve) => setTimeout(resolve, 150));
      rmSync(profile, { recursive: true, force: true });
    }
    report.limitations = [
      "Render tinh (react-dom/server): KHONG mount tuong tac, khong co React runtime trong trang.",
      "Vi vay Escape/focus cua Radix chi co bang chung o muc ma nguon, khong phai runtime.",
      "Khung dialog (.drawerOverlay/.profilePasteDialog) va 2 dong title/description do harness cung cap; toan bo phan con lai la output that cua component.",
      "Khong chay Next.js server, khong DB, khong R2; du lieu la GIA (synthetic).",
    ];
  } catch (error) {
    report.checks.push(check("harness", "chay duoc harness", false,
      String(error && error.message ? error.message : error)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  report.total = report.checks.length;
  report.passed = report.checks.filter((item) => item.ok).length;
  report.failed = report.total - report.passed;
  report.ok = report.failed === 0 && report.typeErrors === 0;
  writeFileSync(path.join(OUTDIR, "preview-acceptance.json"),
    JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({
    ok: report.ok,
    typeErrors: report.typeErrors,
    total: report.total,
    passed: report.passed,
    failed: report.failed,
    failedChecks: report.checks.filter((item) => !item.ok).map((item) =>
      item.scope + " :: " + item.name + " :: " + JSON.stringify(item.detail)),
    shots: report.shots.map((shot) => shot.name),
  }, null, 2));
  if (report.ok !== true) process.exitCode = 1;
}

main().catch((error) => {
  console.error("R3A preview acceptance failed: " + error.message);
  process.exitCode = 1;
});
