/**
 * Source-string / structure tests cho App Shell.
 * Đảm bảo App Shell:
 * - Là Server Component an toàn (mobile trigger là client boundary rõ ràng).
 * - Không import module server-only hoặc @/lib/ai-* (server boundary).
 * - Không fetch dữ liệu trong shell (chỉ render children + currentPath).
 * - Có thuộc tính a11y cần thiết cho header / navigation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appShellSource = readFileSync(new URL("./app-shell.tsx", import.meta.url), "utf8");
const mobileNavSource = readFileSync(new URL("./mobile-nav.tsx", import.meta.url), "utf8");
const desktopNavSource = readFileSync(new URL("./desktop-nav.tsx", import.meta.url), "utf8");

test("app-shell.tsx: là Server Component (KHÔNG có 'use client')", () => {
  assert.ok(!appShellSource.includes('"use client"'), "app-shell.tsx phải là Server Component");
  assert.ok(!appShellSource.includes("'use client'"), "app-shell.tsx phải là Server Component");
});

test("app-shell.tsx: không import @/lib/ai-* (server boundary)", () => {
  assert.ok(
    !/from\s+["']@\/lib\/ai\//.test(appShellSource),
    "app-shell.tsx không được import @/lib/ai/*"
  );
  assert.ok(
    !/from\s+["']@\/lib\/ai-config\//.test(appShellSource),
    "app-shell.tsx không được import @/lib/ai-config/*"
  );
  assert.ok(
    !appShellSource.includes("server-only"),
    "app-shell.tsx không được pull server-only"
  );
});

test("app-shell.tsx: có header cấu trúc đúng và re-export ThemeSelector", () => {
  assert.ok(appShellSource.includes("HR Partner"), "phải có logo 'HR Partner'");
  assert.ok(appShellSource.includes("<header"), "phải dùng <header> cho top bar");
  // aria-label 'Điều hướng chính' nằm ở DesktopNav/MobileNav (đã test riêng bên dưới).
});

test("app-shell.tsx: re-export ThemeSelector hiện có (không phá W05 R1)", () => {
  assert.ok(
    appShellSource.includes("ThemeSelector"),
    "phải giữ ThemeSelector từ @/components/dashboard/theme-selector"
  );
});

test("mobile-nav.tsx: là Client Component với 'use client' ở đầu file", () => {
  assert.ok(
    /^\s*"use client"/.test(mobileNavSource),
    "mobile-nav.tsx phải là Client Component (cần state cho Sheet open)"
  );
});

test("mobile-nav.tsx: dùng radix-ui Dialog với Trigger, Content, Overlay", () => {
  assert.ok(mobileNavSource.includes('Dialog.Root'), "phải có Dialog.Root");
  assert.ok(mobileNavSource.includes('Dialog.Trigger'), "phải có Dialog.Trigger");
  assert.ok(mobileNavSource.includes('Dialog.Portal'), "phải có Dialog.Portal");
  assert.ok(mobileNavSource.includes('Dialog.Overlay'), "phải có Dialog.Overlay (backdrop)");
  assert.ok(mobileNavSource.includes('Dialog.Content'), "phải có Dialog.Content (panel)");
  assert.ok(mobileNavSource.includes('Dialog.Close'), "phải có Dialog.Close (nút đóng)");
});

test("mobile-nav.tsx: trigger có aria-label và aria-controls", () => {
  assert.ok(mobileNavSource.includes("aria-label=\"Mở menu điều hướng\""));
  assert.ok(mobileNavSource.includes("aria-controls=\"mobile-nav-sheet\""));
});

test("mobile-nav.tsx: trigger chỉ hiện trên mobile (md:hidden)", () => {
  assert.ok(
    mobileNavSource.includes("md:hidden"),
    "trigger phải ẩn từ md trở lên (mobile-only)"
  );
});

test("mobile-nav.tsx: KHÔNG import @/lib/ai-* (server boundary)", () => {
  assert.ok(
    !/from\s+["']@\/lib\/ai\//.test(mobileNavSource),
    "mobile-nav.tsx không được import @/lib/ai/*"
  );
  assert.ok(
    !/from\s+["']@\/lib\/ai-config\//.test(mobileNavSource),
    "mobile-nav.tsx không được import @/lib/ai-config/*"
  );
});

test("mobile-nav.tsx: không dùng localStorage / console.log / API key", () => {
  for (const forbidden of ["localStorage", "sessionStorage", "document.cookie", "console.log", "api_key", "API key", "Authorization", "Bearer"]) {
    assert.ok(!mobileNavSource.includes(forbidden), `mobile-nav.tsx không được dùng '${forbidden}'`);
  }
});

test("desktop-nav.tsx: là Server Component (KHÔNG có 'use client')", () => {
  assert.ok(!desktopNavSource.includes('"use client"'), "desktop-nav.tsx phải là Server Component");
});

test("desktop-nav.tsx: dùng next/link và có nav landmark", () => {
  assert.ok(desktopNavSource.includes('from "next/link"'), "phải dùng next/link");
  assert.ok(desktopNavSource.includes("<nav"), "phải có <nav>");
  assert.ok(desktopNavSource.includes("aria-label"), "phải có aria-label cho nav");
});

test("desktop-nav.tsx: ẩn trên mobile (md:flex)", () => {
  assert.ok(
    desktopNavSource.includes("md:flex"),
    "desktop-nav phải ẩn dưới md breakpoint"
  );
});

test("desktop-nav.tsx: link active có aria-current='page'", () => {
  assert.ok(desktopNavSource.includes('aria-current'), "phải set aria-current cho active link");
});

test("desktop-nav.tsx: lấy entries từ registry, không hard-code nhãn Dashboard/Direct Entry", () => {
  assert.ok(desktopNavSource.includes("entriesForViewport"));
  assert.ok(desktopNavSource.includes('from "@/lib/navigation/registry"'));
  // Không hard-code label cũ (Pipeline Check) hay mới trong component.
  assert.ok(!desktopNavSource.includes("Pipeline check"));
  assert.ok(!desktopNavSource.includes("Nhập liệu trực tiếp"));
});

test("mobile-nav.tsx: lấy entries từ registry, không hard-code nhãn", () => {
  assert.ok(mobileNavSource.includes("entriesForViewport"));
  assert.ok(mobileNavSource.includes('from "@/lib/navigation/registry"'));
  assert.ok(!mobileNavSource.includes("Pipeline check"));
  assert.ok(!mobileNavSource.includes("Nhập liệu trực tiếp"));
});

test("desktop-nav.tsx & mobile-nav.tsx: KHÔNG có chuỗi 'Google Sheets' hay 'n8n'", () => {
  assert.ok(!/Google Sheets/i.test(desktopNavSource), "desktop-nav không nhắc Google Sheets");
  assert.ok(!/\bn8n\b/i.test(desktopNavSource), "desktop-nav không nhắc n8n");
  assert.ok(!/Google Sheets/i.test(mobileNavSource), "mobile-nav không nhắc Google Sheets");
  assert.ok(!/\bn8n\b/i.test(mobileNavSource), "mobile-nav không nhắc n8n");
});

test("desktop-nav.tsx & mobile-nav.tsx: KHÔNG có client-side role/filter giả (Admin/Kế toán/Leader)", () => {
  // Bảo đảm App Shell không hard-code UI role (đó là việc của P3 RBAC thật).
  for (const src of [desktopNavSource, mobileNavSource]) {
    assert.ok(!/role\s*===?\s*["']admin["']/i.test(src), "không hard-code role admin");
    assert.ok(!/Admin|Kế toáni|Leader/i.test(src), "không hard-code UI role label");
  }
});
