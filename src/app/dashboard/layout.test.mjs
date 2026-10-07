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

test("dashboard/layout.tsx: default export là function và wrap AppShell", () => {
  assert.match(dashboardLayout, /export default async function DashboardLayout/);
  assert.ok(dashboardLayout.includes('AppShell'));
  // F6: active path giờ do usePathname tinh client-side, layout khong truyen currentPath.
  assert.ok(!dashboardLayout.includes('currentPath'));
});

test("dashboard/layout.tsx: chỉ import server-side nav actor, không import AI internals", () => {
  // P3-W06A: thay import AI feature flag bằng resolveNavActorForAppShell.
  assert.ok(!/from\s+["']@\/lib\/ai\//.test(dashboardLayout));
  assert.ok(!/from\s+["']@\/lib\/ai-config\//.test(dashboardLayout));
  assert.match(dashboardLayout, /from\s+["']@\/lib\/navigation\/resolve-nav-actor["']/);
});

test("dashboard/layout.tsx: truyền actor projection tối thiểu cho AppShell (P3-W06A capability-aware)", () => {
  // P3-W06A Scope B: AI deferred to P3.1 → KHÔNG import AI panels nữa.
  // Implementation vẫn giữ nguyên trong source nhưng layout không render headerActions AI.
  assert.equal(
    /import\s*\{[^}]*AiReportPanel[^}]*\}\s*from\s*["']@\/components\/ai-report\//.test(dashboardLayout),
    false,
    "P3-W06A: dashboard layout KHÔNG import AiReportPanel (AI deferred to P3.1)",
  );
  assert.equal(
    /import\s*\{[^}]*AiSettingsPanel[^}]*\}\s*from\s*["']@\/components\/dashboard\/ai-settings-panel/.test(dashboardLayout),
    false,
    "P3-W06A: dashboard layout KHÔNG import AiSettingsPanel (AI deferred to P3.1)",
  );
  assert.equal(
    /isAiSettingsEnabled/.test(dashboardLayout),
    false,
    "P3-W06A: dashboard layout KHÔNG gọi isAiSettingsEnabled",
  );
  // headerActions rỗng → AppShell sẽ không render button AI.
  // Loc bo comment truoc khi check, vi file co the ghi chu "headerActions rỗng".
  const codeLines = dashboardLayout.split("\n").filter((line) => !/^\s*(\*|\/\/)/.test(line));
  const codeOnly = codeLines.join("\n");
  assert.equal(/headerActions/.test(codeOnly), false,
    "P3-W06A: dashboard layout KHÔNG truyền headerActions (đã ẩn AI)");
  // P3-W06A Scope A: truyền actor projection tối thiểu vào AppShell.
  // P3-W06A R1: resolver wrap boi React `cache()` (request-scoped) va nhan
  // flag `directEntryEnabled` de tranh query thua khi UI off.
  assert.match(dashboardLayout, /import\s*\{[^}]*resolveNavActorForAppShell[^}]*\}\s*from\s*["']@\/lib\/navigation\/resolve-nav-actor/);
  assert.match(dashboardLayout, /await resolveNavActorForAppShell\(\s*\{\s*directEntryEnabled\s*\}\s*\)/);
  assert.match(dashboardLayout, /actor=\{actor\}/);
});

test("dashboard/page.tsx keeps report retrieval but no longer owns AI actions", () => {
  // P2-W04A cutover: dashboard must use the cutover reporting fetcher, not
  // the legacy `fetchReporting` / `fetchReportingOptions` (T1B replaced
  // them with `fetchCutoverReporting` + `fetchCutoverReportingOptions`).
  assert.ok(dashboardPage.includes("fetchCutoverReporting"));
  assert.ok(dashboardPage.includes("fetchCutoverReportingOptions"));
  assert.ok(!dashboardPage.includes("fetchReportingOptions"));
  // The legacy `fetchReporting` only survives as a substring in a
  // comment; require the imported-symbol call to be the cutover one.
  assert.ok(
    /await\s+Promise\.all\(\s*\[\s*fetchCutoverReporting\(/.test(dashboardPage),
    "P2-W04A: dashboard/page must call fetchCutoverReporting in Promise.all",
  );
  assert.ok(dashboardPage.includes("DashboardView"));
  assert.ok(dashboardPage.includes('dynamic = "force-dynamic"'));
  assert.ok(!dashboardPage.includes("isAiSettingsEnabled"));
  assert.ok(!dashboardPage.includes("aiSettingsEnabled"));
});
