/**
 * Source-string test cho layout direct-entry.
 *
 * App-NAV-02A: /direct-entry được bọc bởi AppShell hiện có với
 * currentPath='/direct-entry'. Không sửa page business logic, không tạo
 * AppShell thứ hai.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const layoutSource = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("direct-entry/layout.tsx: default export là function và wrap AppShell với currentPath='/direct-entry'", () => {
  assert.match(layoutSource, /export default async function DirectEntryLayout/);
  assert.ok(layoutSource.includes("AppShell"));
  assert.ok(layoutSource.includes('currentPath="/direct-entry"'));
});

test("direct-entry/layout.tsx: truyền actor projection cho AppShell (P3-W06A capability-aware)", () => {
  // P3-W06A: page boundary resolve actor một lần và truyền vào AppShell.
  // P3-W06A R1: resolver wrap boi React `cache()` (request-scoped) va nhan
  // flag `directEntryEnabled` de tranh query thua khi UI off.
  assert.match(layoutSource, /import\s*\{[^}]*resolveNavActorForAppShell[^}]*\}\s*from\s*["']@\/lib\/navigation\/resolve-nav-actor/);
  assert.match(layoutSource, /await resolveNavActorForAppShell\(\s*\{\s*directEntryEnabled\s*\}\s*\)/);
  assert.match(layoutSource, /actor=\{actor\}/);
});

test("direct-entry/layout.tsx: KHÔNG tạo App Shell thứ hai (chỉ một AppShell từ @/components/app-shell)", () => {
  // Đếm số lần AppShell được import để chắc chắn layout này không tự định nghĩa shell.
  const importMatches = layoutSource.match(/from\s+["']@\/components\/app-shell\//g) ?? [];
  assert.equal(importMatches.length, 1, "chỉ một import từ @/components/app-shell");
  // Không định nghĩa local 'AppShell' hoặc 'Sheet' hoặc 'Dialog' tại đây.
  assert.ok(!/function\s+AppShell/.test(layoutSource), "không định nghĩa AppShell local");
  assert.ok(!/Dialog\.Root/.test(layoutSource), "không tự build Dialog trong layout");
});

test("direct-entry/layout.tsx: không import @/lib/ai-* (server boundary)", () => {
  assert.ok(!/from\s+["']@\/lib\/ai\//.test(layoutSource));
  assert.ok(!/from\s+["']@\/lib\/ai-config\//.test(layoutSource));
  assert.ok(!layoutSource.includes("headerActions"));
});

test("direct-entry/layout.tsx: layout file là Server Component (không 'use client')", () => {
  assert.ok(!layoutSource.includes('"use client"'), "layout phải là Server Component");
  assert.ok(!layoutSource.includes("'use client'"), "layout phải là Server Component");
});

test("direct-entry/page.tsx: KHÔNG bị App-NAV-02A thay đổi (giữ nguyên business logic + gate)", () => {
  // Đảm bảo task này không sửa page business logic của Direct Entry.
  assert.match(pageSource, /export const dynamic = "force-dynamic"/);
  assert.ok(pageSource.includes("isDirectEntryUiEnabled"));
  assert.ok(pageSource.includes("<DirectEntryShell"));
  assert.ok(pageSource.includes('title: "Nhập liệu trực tiếp'));
});