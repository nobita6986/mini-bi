import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("./entries/[entryId]/documents/route.ts", import.meta.url), "utf8");

test("document upload route gates before actor/session setup and uses only the unavailable adapter", () => {
  const gate = route.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
  const missing = route.indexOf('code: "NOT_FOUND"');
  const params = route.indexOf("await context.params");
  const session = route.indexOf("getDirectEntryActor(");
  assert.ok(gate >= 0 && missing > gate && params > missing && session > params);
  assert.match(route, /runtime = "nodejs"/);
  assert.match(route, /dynamic = "force-dynamic"/);
  assert.match(route, /unavailableDocumentStorageAdapter/);
  assert.doesNotMatch(route, /fetch\(|drive\.google|storage\.from\(/i);
});

test("live and demo boundaries keep upload API calls out of the synthetic demo component", () => {
  const live = readFileSync(new URL("../../../components/direct-entry/direct-entry-live.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../../../components/direct-entry/direct-entry-shell.tsx", import.meta.url), "utf8");
  const demo = shell.slice(shell.indexOf("function DemoDirectEntryShell"), shell.indexOf("export function DirectEntryShell"));
  assert.match(live, /DirectEntryDocumentEditor/);
  assert.doesNotMatch(demo, /\/api\/direct-entry\/entries\/.*\/documents|DirectEntryDocumentEditor/);
  assert.doesNotMatch(live, /INITIAL_DIRECT_ENTRY_ROWS/);
});
