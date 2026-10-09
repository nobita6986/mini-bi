import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const manager = source("./direct-entry-cccd-manager.tsx");
const workerDocuments = source("./direct-entry-worker-documents.tsx");
const documentEditor = source("./direct-entry-document-editor.tsx");
const live = source("./direct-entry-live.tsx");
const grid = source("./direct-entry-spreadsheet-grid.tsx");
const columns = source("../../lib/direct-entry/direct-entry-grid-columns.ts");
const runner = source("../../lib/direct-entry/cccd-upload-runner.ts");
const projection = source("../../lib/direct-entry/document-detail-projection.ts");
const transport = source("../../lib/direct-entry/cccd-transport.ts");
const status = source("../../lib/direct-entry/cccd-status.ts");

const RAW_LOGGING = /console\.(?:log|error|warn|info)\(/;

test("cot 'Ho so CCCD' hien dung ba trang thai va nut quan ly bi khoa khi chua luu", () => {
  // P1.7-H06: action rail da duoc loai boi hoan toan; contextual action bar
  // chi hien thi khi chon mot dong cu the. CCCD mo qua documents dialog.
  assert.match(columns, /key: "cccd_documents", label: "Hồ sơ CCCD"/);
  assert.deepEqual(
    JSON.parse(JSON.stringify(["save_status", "row_actions"])),
    ["save_status", "row_actions"],
  );
  // Dam bao cccd_documents khong con trong action rail - no da chuyen ra ngoai grid.
  const railMatch = columns.match(/DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS[^=]*=\s*Object\.freeze\(\[([^\]]+)\]\)/);
  assert.ok(railMatch, "DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS phai duoc dinh nghia");
  const railKeys = railMatch[1].split(",").map((k) => k.trim()).filter(Boolean)
    .map((k) => k.replace(/^["']|["']$/g, ""));
  assert.deepEqual(railKeys, ["save_status", "row_actions"]);
  assert.match(live, /readCccdStatus\(cccdCache, row\.entryId, row\.entryVersion\)/);
  assert.match(live, /cccdStatus: cccdStatus\.label/);
  // P1.7-H06: CCCD status chi hien thi tren mobile card; khong con action rail
  // ngoai grid va khong con nut "Tải hoc khong co ban" trong rail cu.
  assert.equal(grid.includes("{row.cccdStatus}"), false,
    "cccdStatus khong con la data cell cua grid");
  // H06: callback documents duoc goi qua setDocumentsRowId thay vi setCccdRowId.
  assert.match(live, /setDocumentsRowId\(persisted\.rowId\)/);
  assert.match(live, /data-testid="contextual-documents"/);
  assert.match(live, /data-testid="contextual-action-bar"/);
  // H06: contextual action bar co nut Hồ sơ NLĐ (khi co capability), nguoc lai disabled.
  assert.match(live, /Hồ sơ NLĐ/);
  assert.match(live, /Xóa dòng/);
  // H06: khong con placeholder "Lưu dòng trước" hay "Tải hồ sơ" trong rail.
  assert.doesNotMatch(live, /Lưu dòng trước/);
  assert.doesNotMatch(live, /Tải hồ sơ/);
  assert.equal(grid.includes("fetch("), false, "o luoi chi doc cache, khong goi API");
  assert.match(status, /entryId === null \|\| entryId === ""/);
  assert.match(status, /CCCD_UNSAVED_LABEL = "Chưa lưu"/);
  assert.match(status, /CCCD_STATUS_UNKNOWN_LABEL/);
  // Mobile cung hien trang thai.
  assert.match(live, /Hồ sơ CCCD: \{readCccdStatus\(cccdCache, row\.entryId, row\.entryVersion\)\.label\}/);
});

test("khong co N+1: tai trang khong goi entry detail cho tung dong", () => {
  assert.equal(live.includes("fetchEntryDetail"), false,
    "luoi khong duoc import chi tiet entry");
  const loadEffect = live.slice(live.indexOf("async function load() {"), live.indexOf("void load();"));
  assert.equal(loadEffect.includes("/api/direct-entry/entries/"), false,
    "buoc tai trang khong goi detail tung dong");
  // Chi co dung hai cho goi entries detail trong live: PATCH luu mot dong va conflict copy khi nguoi dung mo.
  const entriesCalls = [...live.matchAll(/\/api\/direct-entry\/entries\/\$\{encodeURIComponent\(/g)];
  assert.equal(entriesCalls.length, 2);
  assert.equal((live.match(/fetchConflictCopy/g) ?? []).length > 0, true);
  assert.equal((manager.match(/fetchEntryDetail\(/g) ?? []).length, 3,
    "1 lan mo ho so + 1 lan nguoi dung bam Tai lai + 1 lan reload sau upload");
  assert.equal(manager.includes("/api/direct-entry"), false, "route nam trong transport, khong o component");
});

test("mo ho so cua dung mot dong: dung MOT GET, phu thuoc chi entryId/canView", () => {
  const start = manager.indexOf("useEffect(() => {\n    if (entryId === null || !canView) return;");
  const end = manager.indexOf("}, [canView, entryId]);");
  assert.equal(start > 0 && end > start, true);
  const openEffect = manager.slice(start, end);
  assert.equal((openEffect.match(/fetchEntryDetail\(/g) ?? []).length, 1);
  // Trang thai ban dau duoc suy ra tu props, khong setState dong bo trong effect.
  assert.match(manager, /useState<"idle" \| "loading" \| "ready" \| "error">\(entryId === null \? "idle" : "loading"\)/);
  assert.doesNotMatch(openEffect, /setLoadState\("loading"\)/);
  // P1.7-H06: documents dialog mount lai theo entry_id; khong dung effect de reset trang thai.
  assert.match(live, /key=\{documentsRow\?\.entryId \?\? "no-documents-row"\}/);
  assert.doesNotMatch(manager, /setSlots\(\{ CCCD_FRONT: EMPTY_SLOT/);
  assert.match(openEffect, /latest\.current\.onStatus\(entryId, projection\.entryVersion, projection\.documents\)/);
  // Callback/rowId di qua ref => doi trang thai bang khong lam phat sinh GET thu hai.
  assert.match(manager, /const latest = useRef\(\{ onStatus, onEntryVersionChange, rowId \}\)/);
  // Trong effect chi goi qua ref: doi callback khong lam chay lai effect.
  assert.equal(/\bonStatus\b/.test(openEffect.replace(/latest\.current\.onStatus/g, "")), false);
  assert.equal(/\bonEntryVersionChange\b/.test(
    openEffect.replace(/latest\.current\.onEntryVersionChange/g, "")), false);
  assert.match(manager, /latest\.current = \{ onStatus, onEntryVersionChange, rowId \};/);
});

test("cache trong memory theo entry version, cap nhat sau upload/finalize; khong storage", () => {
  assert.match(live, /const \[cccdCache, setCccdCache\] = useState<CccdStatusCache>\(EMPTY_CCCD_STATUS_CACHE\)/);
  assert.match(live, /writeCccdStatus\(current, entryId, entryVersion, documents\)/);
  assert.match(manager, /latest\.current\.onEntryVersionChange\(latest\.current\.rowId, projection\.entryVersion\)/);
  for (const file of [manager, live, status, runner, transport, projection]) {
    for (const api of ["localStorage.", "sessionStorage.", "indexedDB.", "document.cookie"]) {
      assert.equal(file.includes(api), false, api);
    }
  }
});

test("hai slot CCCD: chon mot hoac hai mat, JPEG/PNG/PDF toi da 10 MiB, SHA-256 tu bytes", () => {
  assert.match(manager, /CCCD_DOCUMENT_TYPES\.map/);
  assert.match(manager, /accept="image\/jpeg,image\/png,application\/pdf"/);
  assert.match(manager, /className=\{styles\.filePickerButton\} aria-hidden="true">[\s\S]*?Chọn tệp/);
  assert.match(manager, /disabled=\{!canEdit \|\| busy\}/,
    "file chooser stays available while the detail projection is loading");
  assert.match(manager, /Bạn vẫn có thể chọn tệp trong lúc chờ/);
  assert.match(manager, /CCCD_MAX_BYTES/);
  assert.match(manager, /CCCD_MIME_TYPES/);
  assert.match(manager, /sha256HexFromBytes\(await slot\.blob\.arrayBuffer\(\)\)/);
  assert.match(manager, /files\.push\(\{/);
  assert.match(manager, /onClick=\{\(\) => void upload\(selectedTypes\)\}/);
  assert.match(manager, /selectedTypes\.length === 0/);
  assert.match(runner, /buildCccdUploadPlan\(\{/);
  assert.match(runner, /const fileByType = new Map\(input\.files\.map/);
});

test("retry rieng mat loi, khong optimistic READY, ghi ro khi chua reload duoc", () => {
  assert.match(manager, /result\?\.status === "failed" && result\.retryable && slot\.blob/);
  assert.match(manager, /data-testid={"cccd-retry-" \+ documentType}/);
  assert.match(manager, /onClick=\{\(\) => void upload\(\[documentType\]\)\}/);
  assert.match(manager, /if \(slot\.status === "failed"\) continue;/);
  assert.match(runner, /status: complete \? "complete" : "pending"/);
  assert.match(runner, /const complete = cccdSlotComplete\(\[outcome\.document\]\)\[item\.documentType\]/);
  assert.match(manager, /Đã ghi nhận tài liệu nhưng chưa tải lại được trạng thái/);
  assert.match(manager, /DOCUMENT_VERSION_CONFLICT/);
  assert.match(manager, /Hãy bấm Tải lại trạng thái rồi thử lại/);
});

test("read-only khi dong khong o ban nhap; khong noi vao change-request API", () => {
  // P1.7-H06 + H08: read-only check chuyen sang documents dialog; canEditDocuments
  // chap nhan capability uploader cu hoac PM assigned tren dong DRAFT; server
  // van giu submission lock va kiem tra assignment/owner doc lap.
  assert.match(live, /canEditDocuments=\{documentsRow !== null/);
  assert.match(live, /entry_own[\s\S]{0,200}\|\|[\s\S]{0,200}entry_admin/);
  assert.match(live, /isRowEditable\(documentsRow, submissions\)[\s\S]{0,250}capabilities\.includes\("change_request_create"\)/);
  assert.match(live, /canViewDocuments=\{capabilities\.includes\("document_view"\) \|\|/);
  assert.match(manager, /disabled=\{!canEdit \|\| busy \|\| detail === null \|\| selectedTypes\.length === 0\}/,
    "upload remains locked until detail is loaded and a file is selected");
  const fileInputStart = manager.indexOf('id={"cccd-file-');
  const fileInputEnd = manager.indexOf("onChange=", fileInputStart);
  const fileInput = manager.slice(fileInputStart, fileInputEnd);
  assert.match(fileInput, /disabled=\{!canEdit \|\| busy\}/);
  assert.doesNotMatch(fileInput, /detail === null/,
    "file selection itself does not wait on detail loading");
  assert.match(manager, /Dòng này không ở bản nháp nên hồ sơ chỉ xem được/);
  assert.equal(manager.includes("change-request"), false);
  assert.equal(manager.includes("changeRequest"), false);
  assert.equal(runner.includes("change-request"), false);
  // reason boundary hien huu duoc tai su dung, khong tu them truong moi.
  assert.match(transport, /body\.reason = input\.reason/);
  assert.doesNotMatch(transport, /change_request|changeRequest/);
});

test("worker document flow uses one dialog and keeps CCCD and contract uploads separate", () => {
  assert.equal((workerDocuments.match(/<Dialog\.Root\b/g) ?? []).length, 1,
    "one modal owns the entire worker document flow");
  assert.doesNotMatch(manager, /<Dialog\.(?:Root|Portal|Overlay|Content)/,
    "CCCD manager renders content only, with no nested modal");
  assert.match(workerDocuments, /<DirectEntryCccdManager[\s\S]*?row=\{row\}/);
  assert.match(documentEditor, /const documentType: DocumentType = "EMPLOYMENT_CONTRACT"/);
  assert.doesNotMatch(documentEditor, /Loại tài liệu/,
    "the contract widget cannot upload duplicate CCCD types");
  assert.match(documentEditor, /className=\{styles\.filePickerButton\} aria-hidden="true">[\s\S]*?Chọn tệp/);
});

test("khong ro ri filename/PII/checksum/storage key/bucket/signed URL ra UI hay log", () => {
  // Phan CCCD cua luoi (cot trang thai + props dialog) khong duoc cham toi du lieu nhay cam.
  // P1.7-H06: documents dialog thay the CCCD rieng; van giu nguyen contract cu.
  const docsIndex = live.indexOf("<DirectEntryWorkerDocuments");
  const cccdSlice = live.slice(live.indexOf('key: "cccdStatus"'), live.indexOf('key: "paymentEditor"'))
    + (docsIndex > 0
      ? live.slice(docsIndex, live.indexOf("onEntryVersionChange={onPaymentEntryVersionChange}", docsIndex))
      : "");
  for (const file of [manager, cccdSlice]) {
    assert.doesNotMatch(file, RAW_LOGGING);
    assert.doesNotMatch(file, /dangerouslySetInnerHTML|innerHTML\s*=/);
    for (const forbidden of ["file.name", "fileName", "file_name", "storage_key", "checksum",
      "bucket", "signedUrl", "signed_url", "upload.url", "national_id", "date_of_birth"]) {
      assert.equal(file.includes(forbidden), false, forbidden);
    }
  }
  assert.doesNotMatch(live, RAW_LOGGING);
  // Trong dialog chi hien kich thuoc va MIME, khong hien ten tep.
  assert.match(manager, /Đã chọn tệp · \{formatSize\(slot\.sizeBytes\)\} · \{slot\.mimeType \|\| "không rõ loại"\}/);
  for (const file of [status, runner, transport, projection]) {
    assert.doesNotMatch(file, RAW_LOGGING);
  }
  // Signed URL chi duoc truyen thang vao fetch PUT, khong duoc luu hay tra ra ngoai.
  assert.match(transport, /url: body\.upload\.url/);
  assert.doesNotMatch(transport, /return \{ ok: true, url/);
  assert.match(transport, /return response\.ok \? \{ ok: true \} : \{ ok: false/);
  // Projection strict: field la (checksum/storage_key/bucket) lam ca response bi tu choi.
  assert.match(projection, /Object\.keys\(document\)\.some\(\(key\) => !DOCUMENT_KEYS\.has\(key\)\)\) return null/);
  assert.match(projection, /"created_at", "updated_at",/);
  const allowList = projection.slice(projection.indexOf("const DOCUMENT_KEYS"),
    projection.indexOf("]);"));
  for (const forbidden of ["checksum", "storage_key", "bucket", "signed"]) {
    assert.equal(allowList.includes(forbidden), false, forbidden);
  }
});

test("dung lai boundary hien huu: route reserve/finalize va resolveIntentKey", () => {
  assert.match(transport, /\/documents"/);
  assert.match(transport, /\/finalize"/);
  assert.match(transport, /"Idempotency-Key": key/);
  assert.match(runner, /resolveIntentKey\(state\[fingerprint\] \?\? EMPTY_INTENT_KEY, fingerprint, generate\)/);
  assert.match(runner, /cccdIntentFingerprint\(\{/);
  assert.match(runner, /entryVersion: version,/);
  assert.match(runner, /idempotencyKey: tail\(item\.idempotencyKey\)/);
  // PUT song song, reserve/finalize tuan tu.
  assert.match(runner, /await Promise\.all\(reserved\.map\(async \(item\) => \{/);
  assert.match(runner, /for \(const documentType of plan\.order\) \{/);
  assert.match(runner, /for \(const item of reserved\) \{/);
});
