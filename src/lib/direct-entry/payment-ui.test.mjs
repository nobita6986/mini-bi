import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const shell = readFileSync(new URL(
  "../../components/direct-entry/direct-entry-shell.tsx",
  import.meta.url,
), "utf8");
const demoShell = shell.slice(0, shell.indexOf("export function DirectEntryShell"));
const editor = readFileSync(new URL(
  "../../components/direct-entry/direct-entry-payment-editor.tsx",
  import.meta.url,
), "utf8");
const live = readFileSync(new URL(
  "../../components/direct-entry/direct-entry-live.tsx",
  import.meta.url,
), "utf8");

test("synthetic demo shell never invokes the Direct Entry API", () => {
  assert.doesNotMatch(demoShell, /fetch\s*\(|\/api\/direct-entry/);
});

test("payment editor keeps secrets out of browser storage and masks reveal controls", () => {
  assert.doesNotMatch(editor, /localStorage|sessionStorage/);
  assert.match(editor, /type=\{canReveal \? "text" : "password"\}/);
  assert.match(editor, /onCopy=\{canReveal \? undefined : \(event\) => event\.preventDefault\(\)\}/);
  assert.match(editor, /onCut=\{canReveal \? undefined : \(event\) => event\.preventDefault\(\)\}/);
  assert.match(editor, /onContextMenu=\{canReveal \? undefined : \(event\) => event\.preventDefault\(\)\}/);
  assert.match(editor, /status === "conflict"/);
  assert.match(editor, /Tải bản server/);
  assert.match(editor, /Giữ bản local/);
  assert.match(live, /selectedRow\.state !== "saving" && selectedRow\.state !== "conflict"/);
  assert.match(live, /key=\{`\$\{selectedRow\.rowId\}:\$\{selectedRow\.entryId \?\? "new"\}`\}/);
  assert.match(live, /canEdit=\{capabilities\.includes\("entry_own"\)/);
  assert.match(live, /canView=\{capabilities\.includes\("payment_view"\)\}/);
});
