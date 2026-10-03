import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("./entries/[entryId]/documents/route.ts", import.meta.url), "utf8");

test("document upload route gates before actor/session setup and uses configured worker boundary", () => {
  const gate = route.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
  const missing = route.indexOf('code: "NOT_FOUND"');
  const params = route.indexOf("await context.params");
  const session = route.indexOf("getDirectEntryActor(");
  assert.ok(gate >= 0 && missing > gate && params > missing && session > params);
  assert.match(route, /runtime = "nodejs"/);
  assert.match(route, /dynamic = "force-dynamic"/);
  assert.match(route, /createDocumentWorkerAdapter/);
  assert.doesNotMatch(route, /fetch\(|drive\.google|storage\.from\(/i);
});

test("worker callback route is Node-only, server-gated and uses server credentials", () => {
  const callback = readFileSync(new URL("./document-worker/callback/route.ts", import.meta.url), "utf8");
  assert.match(callback, /runtime = "nodejs"/);
  assert.match(callback, /DIRECT_ENTRY_DOCUMENT_CALLBACK_SECRET/);
  assert.match(callback, /receiveDocumentWorkerCallback/);
  assert.doesNotMatch(callback, /\bfetch\s*\(/);
});

test("live and demo boundaries keep upload API calls out of the synthetic demo component", () => {
  const live = readFileSync(new URL("../../../components/direct-entry/direct-entry-live.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../../../components/direct-entry/direct-entry-shell.tsx", import.meta.url), "utf8");
  const demo = shell.slice(shell.indexOf("function DemoDirectEntryShell"), shell.indexOf("export function DirectEntryShell"));
  assert.match(live, /DirectEntryDocumentEditor/);
  assert.doesNotMatch(demo, /\/api\/direct-entry\/entries\/.*\/documents|DirectEntryDocumentEditor/);
  assert.doesNotMatch(live, /INITIAL_DIRECT_ENTRY_ROWS/);
});
