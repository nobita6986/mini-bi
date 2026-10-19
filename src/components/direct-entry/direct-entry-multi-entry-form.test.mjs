import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const form = await readFile(new URL("./direct-entry-multi-entry-form.tsx", import.meta.url), "utf8");
const live = await readFile(new URL("./direct-entry-live.tsx", import.meta.url), "utf8");
const uploads = await readFile(new URL("./direct-entry-initial-worker-uploads.tsx", import.meta.url), "utf8");
const documentEditor = await readFile(new URL("./direct-entry-document-editor.tsx", import.meta.url), "utf8");
const stageSlots = await readFile(new URL("./worker-portrait-stage-slot.tsx", import.meta.url), "utf8");

test("multi-entry form reuses the staged row model, validation, and server catalog", () => {
  assert.match(live, /inputMode === "form" && editingDraftSubmissionId === null/);
  assert.match(live, /<DirectEntryMultiEntryForm/);
  assert.match(form, /model: SpreadsheetRowModel/);
  assert.match(form, /validation: SpreadsheetValidation/);
  assert.match(form, /catalog: DraftCatalog \| null/);
  assert.match(form, /onChange\(rowId, field, event\.currentTarget\.value\)/);
  assert.match(form, /onProviderTypeChange\(rowId/);
});

test("form exposes the requested worker fields and restricts new employment statuses", () => {
  for (const label of [
    "Dự án", "HRP/Vendor", "Người tuyển / Vendor", "Loại hình LĐ",
    "Ngày bắt đầu làm việc", "Trạng thái làm việc", "Họ và tên", "Số điện thoại", "Số CCCD",
  ]) assert.ok(form.includes(label), `missing ${label}`);
  assert.match(form, /const currentStatus = unsupportedStatus \? "" : rawStatus \|\| "Đang làm"/);
  assert.match(form, /<option value="Đang làm">Đang làm<\/option>/);
  assert.match(form, /<option value="Đang chờ việc">Đang chờ việc<\/option>/);
  assert.doesNotMatch(form, /<option value="Đã nghỉ">/);
  assert.match(form, /disabled=\{busy \|\| !canSave \|\| hasUnsupportedEmploymentStatus\}/);
  assert.match(form, /className="sr-only"> \(bắt buộc\)/);
  assert.match(form, /select required value=\{cells\.project_id/);
  assert.match(form, /select required value=\{cells\.recruiter_id/);
  assert.match(form, /DdmmDateInput[\s\S]*?required/);
  assert.doesNotMatch(form, /summary onClick=\{\(event\) => event\.preventDefault\(\)\}/);
});

test("selecting each file immediately stages it privately for the matching worker row", () => {
  assert.match(form, /WorkerPortraitStageSlot/);
  for (const documentType of ["CCCD_FRONT", "CCCD_BACK", "EMPLOYMENT_CONTRACT"]) {
    assert.ok(form.includes(`documentType="${documentType}"`), `missing slot for ${documentType}`);
  }
  for (const label of ["CCCD mặt trước (ảnh hoặc PDF", "CCCD mặt sau (ảnh hoặc PDF", "Hợp đồng (ảnh hoặc PDF"]) {
    assert.ok(stageSlots.includes(label), `missing upload label ${label}`);
  }
  assert.match(stageSlots, /if \(file !== null\) onStage\(rowKey, file\)/,
    "file selection starts the stage upload immediately");
  assert.match(stageSlots, /Tệp đang ở bản nháp; máy chủ sẽ gắn vào hồ sơ khi lưu thành công/);
  assert.doesNotMatch(form, /fetch\s*\(|\.rpc\s*\(/);
  assert.doesNotMatch(form, /DirectEntryInitialWorkerUploads/,
    "the form does not defer its selected files to a post-save uploader");
  assert.match(live, /const portraitStages = useWorkerPortraitStages\(/);
  for (const documentType of ["CCCD_FRONT", "CCCD_BACK", "EMPLOYMENT_CONTRACT"]) {
    assert.match(live, new RegExp(`documentType: "${documentType}"`));
  }
  assert.match(live, /documentStageIdsBySourceRow/);
  assert.match(live, /documentStageIdsBySourceRow,\s*\)/);
  assert.match(live, /beforeunload/);
  // Saved-row document management for the spreadsheet remains on its existing transport.
  assert.match(uploads, /<DirectEntryCccdManager/);
  assert.match(uploads, /<DirectEntryDocumentEditor/);
  assert.match(uploads, /onInitialFilesAccepted/);
  assert.match(uploads, /onInitialFileAccepted/);
  assert.match(live, /<DirectEntryDocumentEditor[\s\S]*?showPortrait/);
  assert.match(documentEditor, /fetchEntryDetail\(entryId, fetch\)/);
  assert.match(documentEditor, /setWorkerPortrait\(parsed\.workerPortrait\)/);
  assert.match(documentEditor, /<WorkerPortraitPanel/);
});

test("partial batch save filters to valid rows and preserves the remaining staged rows", () => {
  assert.match(live, /preview\.rows\.filter\(\(row\) => row\.canProceed\)/);
  assert.match(live, /stagedValidation\.rows\s*\.filter\(\(row\) => row\.canProceed\)/);
  assert.match(live, /const savedRowSet = new Set\(savedClientRowIds\)/);
  assert.match(live, /if \(savedRowSet\.has\(rowKey\)\) controller\.settle\(rowKey, stageId\)/);
  assert.match(live, /savedClientRowIds\.reduce\([\s\S]{0,120}?deleteSpreadsheetRow\(model, clientRowId\)/);
  assert.match(live, /documentStageIdsBySourceRow/);
  assert.match(live, /dòng chưa hợp lệ; hãy sửa các lỗi đang hiển thị rồi lưu tiếp/);
  assert.match(live, /documentPending \?\? fullProfileErrorMessage\(result\.code\)/,
    "an unreadable or uncertain response stays on the retry path, never a success message");
  assert.match(live, /const clearSavedStagedRows = \(\) => \{[\s\S]{0,400}?savedClientRowIds\.reduce\(/);
});
