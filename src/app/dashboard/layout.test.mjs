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
  assert.match(dashboardLayout, /export default async function DashboardLayout/);
  assert.ok(dashboardLayout.includes('AppShell'));
  assert.ok(dashboardLayout.includes('currentPath="/dashboard"'));
});

test("dashboard/layout.tsx: chỉ import server-side AI feature flag, không import AI internals", () => {
  assert.ok(!/from\s+["']@\/lib\/ai\//.test(dashboardLayout));
  assert.ok(dashboardLayout.includes('from "@/lib/ai-config/settings-flag"'));
});

test("dashboard/layout.tsx: truyền AI actions, settings vẫn fail-closed theo server flag", () => {
  assert.ok(dashboardLayout.includes('import { AiReportPanel } from "@/components/ai-report/ai-report-panel"'));
  assert.ok(dashboardLayout.includes('import { AiSettingsPanel } from "@/components/dashboard/ai-settings-panel"'));
  assert.ok(dashboardLayout.includes('import { isAiSettingsEnabled } from "@/lib/ai-config/settings-flag"'));
  assert.ok(dashboardLayout.includes("await connection()"));
  assert.equal(dashboardLayout.split("<AiReportPanel />").length - 1, 1);
  assert.equal(dashboardLayout.split("<AiSettingsPanel />").length - 1, 1);
  assert.ok(dashboardLayout.includes("{isAiSettingsEnabled() ? <AiSettingsPanel /> : null}"));
  assert.ok(dashboardLayout.includes('headerActions={headerActions}'));
});

test("dashboard/page.tsx keeps report retrieval but no longer owns AI actions", () => {
  assert.ok(dashboardPage.includes("fetchReporting"));
  assert.ok(dashboardPage.includes("DashboardView"));
  assert.ok(dashboardPage.includes('dynamic = "force-dynamic"'));
  assert.ok(!dashboardPage.includes("isAiSettingsEnabled"));
  assert.ok(!dashboardPage.includes("aiSettingsEnabled"));
});
