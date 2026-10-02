import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("direct-entry route checks the strict server feature gate before rendering the UI", () => {
  const gateIndex = source.indexOf("isDirectEntryUiEnabled(process.env.DIRECT_ENTRY_UI_ENABLED)");
  const notFoundIndex = source.indexOf("notFound()", gateIndex);
  const renderIndex = source.indexOf("<DirectEntryShell");
  assert.ok(gateIndex >= 0);
  assert.ok(notFoundIndex > gateIndex);
  assert.ok(renderIndex > notFoundIndex);
  assert.match(source, /export const dynamic = "force-dynamic"/);
});
