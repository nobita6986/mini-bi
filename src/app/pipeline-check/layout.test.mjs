/**
 * Source-string test cho pipeline-check sau App-NAV-02A.
 *
 * Pipeline Check (Google Sheets → n8n → Supabase) đã được dự án loại bỏ;
 * navbar đã bỏ entry này và route cũ redirect server-side về /dashboard
 * (xem docs/handoffs/app-nav-02a.md).
 *
 * Test xác nhận:
 * - page.tsx KHÔNG render pipeline data cũ (không còn fetchPipelineCheck,
 *   SourceStatusTable, SummaryCard, EmptyState nội bộ pipeline).
 * - page.tsx redirect('/dashboard') từ next/navigation.
 * - KHÔNG có layout AppShell còn wrap trang pipeline (layout.tsx đã bỏ).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";

const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("pipeline-check/page.tsx: redirect server-side về /dashboard", () => {
  assert.ok(
    /from\s+["']next\/navigation["']/.test(pageSource),
    "page phải import từ next/navigation"
  );
  assert.ok(/redirect\(["']\/dashboard["']\)/.test(pageSource), "page phải gọi redirect('/dashboard')");
});

test("pipeline-check/page.tsx: KHÔNG còn gọi fetchPipelineCheck hoặc isPipelineCheckEnabled", () => {
  assert.ok(!pageSource.includes("fetchPipelineCheck"), "page cũ đã redirect; không fetch pipeline data");
  assert.ok(
    !pageSource.includes("isPipelineCheckEnabled"),
    "page cũ đã redirect; không check pipeline enabled flag"
  );
});

test("pipeline-check/page.tsx: KHÔNG import SourceStatusTable/SummaryCard/StatusBadge (UI pipeline cũ)", () => {
  for (const ui of ["SourceStatusTable", "SummaryCard", "StatusBadge", "EmptyState", "ErrorState"]) {
    assert.ok(!pageSource.includes(ui), `page cũ đã redirect; không import ${ui}`);
  }
});

test("pipeline-check/page.tsx: KHÔNG còn nhắc 'Google Sheets' hay 'n8n' ngoài comment giải thích (kiến trúc cũ đã retired)", () => {
  // Bỏ qua phần comment JSDoc ở đầu file (giải thích lịch sử).
  // Phần code phía dưới không được nhắc tới kiến trúc cũ.
  const commentEnd = pageSource.indexOf("*/");
  const codeAfterComment = commentEnd >= 0 ? pageSource.slice(commentEnd + 2) : pageSource;
  assert.ok(!/Google Sheets/i.test(codeAfterComment), "code không nhắc Google Sheets");
  assert.ok(!/\bn8n\b/i.test(codeAfterComment), "code không nhắc n8n");
});

test("pipeline-check: layout.tsx đã được bỏ (route chỉ redirect, không render)", () => {
  assert.equal(
    existsSync(new URL("./layout.tsx", import.meta.url)),
    false,
    "layout.tsx không còn — redirect ngăn render, không cần AppShell"
  );
});

test("pipeline-check/page.tsx: có dynamic = 'force-dynamic' để chắc chắn không bị cache tĩnh", () => {
  assert.match(pageSource, /export const dynamic = "force-dynamic"/);
});