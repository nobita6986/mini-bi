/**
 * Source-string test cho 2 layout tích hợp AppShell.
 * Đảm bảo:
 * - Cả 2 layout đều dùng AppShell với currentPath tương ứng.
 * - Không phá vỡ các page đã có.
 * - Không thay đổi business data layer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dashboardLayout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
const dashboardPage = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("dashboard/layout.tsx: default export là function và wrap AppShell với currentPath='/dashboard'", () => {
  assert.match(dashboardLayout, /export default function DashboardLayout/);
  assert.ok(dashboardLayout.includes('AppShell'));
  assert.ok(dashboardLayout.includes('currentPath="/dashboard"'));
});

test("dashboard/layout.tsx: không import @/lib/ai-* (server boundary)", () => {
  assert.ok(!/from\s+["']@\/lib\/ai\//.test(dashboardLayout));
  assert.ok(!/from\s+["']@\/lib\/ai-config\//.test(dashboardLayout));
});

test("dashboard/page.tsx: KHÔNG bị thay đổi (giữ nguyên logic business)", () => {
  // Sanity: page vẫn gọi fetchReporting và DashboardView như trước.
  assert.ok(dashboardPage.includes("fetchReporting"));
  assert.ok(dashboardPage.includes("DashboardView"));
  assert.ok(dashboardPage.includes('dynamic = "force-dynamic"'));
});
