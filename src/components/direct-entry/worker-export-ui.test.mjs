/**
 * PRE-W2-P1 (T1A) - Source/structure test cho luong "Xuat Excel" trong Worker Operations.
 *
 * tsx khong import duoc bang node:test => kiem tra o muc source + test logic thuan trong
 * src/lib/direct-entry/worker-export-ui-model.test.mjs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./worker-operations.tsx", import.meta.url), "utf8");
const page = readFileSync(
  new URL("../../app/direct-entry/workers/page.tsx", import.meta.url), "utf8");

test("T1A: tai su dung API xuat server, khong tao XLSX phia client", () => {
  assert.match(source, /"\/workers\/export"/);
  assert.equal(/exceljs|new Workbook|writeBuffer/.test(source), false,
    "khong tao XLSX phia client");
  assert.equal(/server-only/.test(source), false);
  // Body di qua dung builder cua contract, khong tu ghep tay.
  assert.match(source, /buildWorkerExportRequest\(\{ scope, filters, reason \}\)/);
  assert.match(source, /body: JSON.stringify\(request\.body\)/);
});

test("T1A: POST dung method, content-type va same-origin (CSRF)", () => {
  assert.match(source, /method: "POST"/);
  assert.match(source, /"content-type": "application\/json"/);
  assert.match(source, /credentials: "same-origin"/);
});

test("T1A: nut xuat chi o recruited/managed va gate bang capability server", () => {
  assert.match(source, /canExport\?: boolean/);
  assert.match(source, /const exportScope = exportScopeForTab\(tab\)/);
  assert.match(source, /canExport && exportScope !== null \?/);
  assert.match(source, /Xuất Excel/);
  // Khong suy quyen tu role/email/scope kind trong code.
  const code = source.split("\n").filter((line) => !/^\s*(\*|\/\/)/.test(line)).join("\n");
  for (const forbidden of ["role ===", "email", "is_admin"]) {
    assert.equal(code.includes(forbidden), false, "khong duoc suy quyen tu " + forbidden);
  }
});

test("T1A: reason bat buoc trong dialog, chong double-submit", () => {
  assert.match(source, /Lý do xuất/);
  assert.match(source, /required aria-required="true"/);
  assert.match(source, /maxLength=\{WORKER_EXPORT_REASON_MAX\}/);
  assert.match(source, /disabled=\{busy \|\| scope === null\}/);
  assert.match(source, /if \(!open && !busy\) onOpenChange\(false\)/);
  assert.match(source, /if \(scope === null \|\| busy\) return;/);
});

test("T1A: tai file tu response Blob, ten file an toan tu server/fallback", () => {
  assert.match(source, /await response\.blob\(\)/);
  assert.match(source, /URL\.createObjectURL\(blob\)/);
  assert.match(source, /anchor\.download = filename/);
  assert.match(source, /workerExportFilename\(\s*\n?\s*response\.headers\.get\("content-disposition"\), hcmTodayDate\(\)\)/);
});

test("T1A: 422 row-limit va loi khac bao qua copy sanitized, khong tai file thieu dong", () => {
  // Thanh cong (200) moi tai file; cac status khac di qua workerExportErrorMessage.
  assert.match(source, /if \(response\.status === 200\)/);
  assert.match(source, /workerExportErrorMessage\(response\.status, payload\)/);
  assert.match(source, /workerExportErrorMessage\(0, null\)/);
  // 422 khong bao gio roi vao nhanh tai file.
  assert.equal(/status === 422[\s\S]{0,80}blob\(\)/.test(source), false);
});

test("T1A: khong log reason/body/PII ra console", () => {
  assert.equal(/console\.(log|error|warn|debug|info)/.test(source), false,
    "khong log PII/body trong component");
  // Body xuat chi duoc tao boi model tu scope+filter+reason, khong ghep PII tu bang.
  assert.match(source, /buildWorkerExportRequest\(\{ scope, filters, reason \}\)/);
  assert.equal(/JSON\.stringify\([^)]*\)[\s\S]{0,80}(display_name|national_id|account_number)/
    .test(source), false, "body xuat khong lay PII tu bang");
});

test("T1A: page tinh canExport tu capability projection va truyen xuong", () => {
  assert.match(page, /canExportWorkers\(actorProjection\)/);
  assert.match(page, /canExport=\{canExport\}/);
  assert.match(page, /import \{ canExportWorkers \} from "@\/lib\/direct-entry\/worker-export-ui-model"/);
});
