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

test("payment editor keeps secrets out of browser storage and follows enclosing edit action", () => {
  assert.doesNotMatch(editor, /localStorage|sessionStorage/);
  assert.doesNotMatch(editor, /canReveal|payment_view|payment_edit|masked/);
  assert.match(editor, /type="text"/);
  assert.match(editor, /account_number: payment\.account_number \?\? ""/);
  assert.match(editor, /bank_name: payment\.bank_name \?\? ""/);
  assert.match(editor, /account_holder_name: payment\.account_holder_name \?\? ""/);
  assert.match(editor, /if \(!entryId \|\| !canEdit/);
  assert.match(editor, /status === "conflict"/);
  assert.match(editor, /Tải bản server/);
  assert.match(editor, /Giữ bản local/);
  assert.match(live, /selectedRow\.state !== "saving" && selectedRow\.state !== "conflict"/);
  assert.match(live, /key=\{`\$\{selectedRow\.rowId\}:\$\{selectedRow\.entryId \?\? "new"\}`\}/);
  assert.match(live, /canEdit=\{capabilities\.includes\("entry_own"\)/);
  assert.doesNotMatch(live, /payment_view|payment_edit/);
  assert.match(editor, /form\.bank_name \|\| "Không có dữ liệu ngân hàng trong projection"/);
  assert.match(editor, /Ngân hàng đang lưu: \{form\.bank_name\}/);
});
