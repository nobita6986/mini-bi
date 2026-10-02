/**
 * Source-string test cho layout pipeline-check.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const layoutSource = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("pipeline-check/layout.tsx: default export là function và wrap AppShell với currentPath='/pipeline-check'", () => {
  assert.match(layoutSource, /export default function PipelineCheckLayout/);
  assert.ok(layoutSource.includes("AppShell"));
  assert.ok(layoutSource.includes('currentPath="/pipeline-check"'));
});

test("pipeline-check/layout.tsx: không import @/lib/ai-* (server boundary)", () => {
  assert.ok(!/from\s+["']@\/lib\/ai\//.test(layoutSource));
  assert.ok(!/from\s+["']@\/lib\/ai-config\//.test(layoutSource));
});

test("pipeline-check/page.tsx: KHÔNG bị thay đổi (giữ nguyên logic business)", () => {
  assert.ok(pageSource.includes("fetchPipelineCheck"));
  assert.ok(pageSource.includes("isPipelineCheckEnabled"));
  assert.ok(pageSource.includes('dynamic = "force-dynamic"'));
});
