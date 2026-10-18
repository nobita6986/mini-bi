import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const form = await readFile(new URL("./direct-entry-multi-entry-form.tsx", import.meta.url), "utf8");
const live = await readFile(new URL("./direct-entry-live.tsx", import.meta.url), "utf8");
const uploads = await readFile(new URL("./direct-entry-initial-worker-uploads.tsx", import.meta.url), "utf8");

test("multi-entry form reuses the staged row model, validation, and server catalog", () => {
  assert.match(live, /inputMode === "form" && editingDraftSubmissionId === null/);
  assert.match(live, /<DirectEntryMultiEntryForm/);
  assert.match(form, /model: SpreadsheetRowModel/);
  assert.match(form, /validation: SpreadsheetValidation/);
  assert.match(form, /catalog: DraftCatalog \| null/);
  assert.match(form, /onChange\(rowId, field, event\.currentTarget\.value\)/);
  assert.match(form, /onProviderTypeChange\(rowId/);
});

test("form exposes the requested worker fields and conditional leave fields", () => {
  for (const label of [
    "Dự án", "HRP/Vendor", "Người tuyển / Vendor", "Loại hình LĐ",
    "Ngày bắt đầu làm việc", "Trạng thái làm việc", "Họ và tên", "Số điện thoại", "Số CCCD",
  ]) assert.ok(form.includes(label), `missing ${label}`);
  assert.match(form, /currentStatus === "Đã nghỉ"/);
  assert.match(form, /Ngày nghỉ thực tế/);
  assert.match(form, /Lý do nghỉ/);
  assert.match(form, /className="sr-only"> \(bắt buộc\)/);
  assert.match(form, /select required value=\{cells\.project_id/);
  assert.match(form, /select required value=\{cells\.recruiter_id/);
  assert.match(form, /DdmmDateInput[\s\S]*?required/);
  assert.doesNotMatch(form, /summary onClick=\{\(event\) => event\.preventDefault\(\)\}/);
});

test("initial documents are selected locally then handed to the existing CCCD and contract uploaders", () => {
  assert.match(form, /WorkerPortraitStageSlot/);
  assert.match(form, /CCCD mặt trước/);
  assert.match(form, /CCCD mặt sau/);
  assert.match(form, /Hợp đồng \(ảnh hoặc PDF\)/);
  assert.doesNotMatch(form, /fetch\s*\(|\.rpc\s*\(/);
  assert.match(uploads, /<DirectEntryCccdManager/);
  assert.match(uploads, /<DirectEntryDocumentEditor/);
  assert.match(uploads, /onInitialFilesAccepted/);
  assert.match(uploads, /onInitialFileAccepted/);
  assert.match(live, /beforeunload/);
});

test("partial batch save filters to valid rows and preserves the remaining staged rows", () => {
  assert.match(live, /preview\.rows\.filter\(\(row\) => row\.canProceed\)/);
  assert.match(live, /stagedValidation\.rows\s*\.filter\(\(row\) => row\.canProceed\)/);
  assert.match(live, /mapSavedWorkerInitialUploads\(/);
  assert.match(live, /deleteSpreadsheetRow\(model, clientRowId\)/);
  assert.match(live, /dòng chưa hợp lệ; hãy sửa các lỗi đang hiển thị rồi lưu tiếp/);
  assert.match(live, /máy chủ đã lưu hồ sơ nhưng phản hồi không khớp số dòng/i);
  assert.match(live, /if \(mappedInitialUploads === null\)[\s\S]*?clearSavedStagedRows\(\)/);
});
