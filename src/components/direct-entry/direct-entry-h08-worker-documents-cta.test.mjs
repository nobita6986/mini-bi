/**
 * P1.7-H08 — Fix "Hồ sơ NLĐ" không bấm được trên Production.
 *
 * Regression tests cho contextual action bar (desktop) khi user chọn row
 * persisted: nút Hồ sơ NLĐ phải bấm được nếu user có `document_view`
 * (xem được hồ sơ), hoặc hiển thị lý do inline nếu thiếu quyền.
 * Staged row: hiển thị text "Lưu NLĐ để thêm hồ sơ" (không có nút
 * disabled vô nghĩa). Capability projection chấp nhận `entry_admin`
 * thay cho `entry_own` cho edit path.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const live = readFileSync(
  new URL("./direct-entry-live.tsx", import.meta.url), "utf8");
const css = readFileSync(
  new URL("./direct-entry-shell.module.css", import.meta.url), "utf8");
const documents = readFileSync(
  new URL("./direct-entry-worker-documents.tsx", import.meta.url), "utf8");

/* ----- 1. Persisted + document_view → nut enabled, dialog mo theo entry_id ----- */
test("H08-1 persisted + document_view: nut Hồ sơ NLĐ enabled, mở theo entry_id", () => {
  // canOpenWorkerDocuments = canViewDocs && selectedHasEntryId.
  assert.match(live, /const canOpenWorkerDocuments = canViewDocs && selectedHasEntryId/);
  // Nut Hồ sơ NLĐ chi render khi selectedIsPersisted && canOpenWorkerDocuments.
  const persistedDocsBranch = live.match(
    /selectedIsPersisted && canOpenWorkerDocuments \? \([\s\S]{0,2000}<\/button>/);
  assert.ok(persistedDocsBranch, "phai co nhanh render nut Hồ sơ NLĐ cho persisted + canViewDocs");
  // disabled=false (H08: nut luon enabled khi co quyen xem).
  assert.match(persistedDocsBranch[0], /disabled=\{false\}/);
  // onClick goi setDocumentsRowId(persisted.rowId) - mo theo rowId, khong
  // theo row index/ho ten/CCCD.
  assert.match(persistedDocsBranch[0], /setDocumentsRowId\(persisted\.rowId\)/);
  // Click handler cung guard !canViewDocs (defense-in-depth).
  assert.match(persistedDocsBranch[0], /if \(!canViewDocs\) return;/);
});

/* ----- 2. View-only (chỉ document_view) → dialog mở, upload disabled ----- */
test("H08-2 view-only: dialog mở (canEdit=false trong worker-documents dialog)", () => {
  // canEditDocsFromCta can co hoac khong; neu co document_upload + entry_own/entry_admin
  // thi canEdit=true; neu khong thi canEdit=false (view-only).
  assert.match(live, /const canEditDocsFromCta = canViewDocs/);
  assert.match(live, /entry_own[\s\S]{0,200}\|\|[\s\S]{0,200}entry_admin/);
  // Prop canEditDocuments cua DirectEntryWorkerDocuments cung chap nhan
  // entry_own HOAC entry_admin.
  const workerDocProp = live.match(
    /canEditDocuments=\{documentsRow !== null[\s\S]{0,400}\}/);
  assert.ok(workerDocProp, "phai co canEditDocuments prop tren DirectEntryWorkerDocuments");
  assert.match(workerDocProp[0],
    /entry_own[\s\S]{0,200}\|\|[\s\S]{0,200}entry_admin/);
  // DirectEntryWorkerDocuments chap nhan canViewDocuments rieng (xem duoc CCCD/document).
  assert.match(documents, /canViewDocuments/);
});

/* ----- 3. document_upload + entry_own → upload controls enabled ----- */
test("H08-3 document_upload + entry_own: canEditDocsFromCta = true, nut enabled", () => {
  // Title hien thi 2 trang thai: "Mở hồ sơ NLĐ (sửa được)" khi co edit
  // quyen, "Mở hồ sơ NLĐ (chỉ xem)" khi view-only.
  const titleMatch = live.match(/title=\{canEditDocsFromCta[\s\S]{0,400}\}/);
  assert.ok(titleMatch, "phai co title expression theo canEditDocsFromCta");
  assert.match(titleMatch[0], /"Mở hồ sơ NLĐ \(sửa được\)"/);
  assert.match(titleMatch[0], /"Mở hồ sơ NLĐ \(chỉ xem\)"/);
});

/* ----- 4. document_upload + entry_admin (không entry_own) → upload enabled ----- */
test("H08-4 entry_admin thay the entry_own cho edit path", () => {
  // canEditDocsFromCta chap nhan entry_own HOAC entry_admin.
  const editProp = live.match(/canEditDocsFromCta = canViewDocs[\s\S]{0,500};/);
  assert.ok(editProp, "phai co khoi tao canEditDocsFromCta");
  assert.match(editProp[0], /entry_own[\s\S]{0,200}\|\|[\s\S]{0,200}entry_admin/);
  // canEditDocuments prop cung vay.
  const workerDocProp = live.match(
    /canEditDocuments=\{documentsRow !== null[\s\S]{0,400}\}/);
  assert.ok(workerDocProp);
  assert.match(workerDocProp[0], /entry_own[\s\S]{0,200}\|\|[\s\S]{0,200}entry_admin/);
});

/* ----- 5. Persisted + thiếu document_view → inline reason, không có nút dead ----- */
test("H08-5 persisted khong co document_view: hien thi ly do inline, khong nut dead", () => {
  // Nhanh render: "Bạn không có quyền xem hồ sơ" (data-testid="contextual-no-permission-hint").
  assert.match(live, /data-testid="contextual-no-permission-hint"/);
  assert.match(live, /Bạn không có quyền xem hồ sơ\./);
  // Khong render nut Ho so NLD trong nhanh nay (chi render inline hint).
  const noPermBranch = live.match(
    /selectedIsPersisted && !canViewDocs \?\s*\([\s\S]{0,500}\)\s*:\s*null/);
  assert.ok(noPermBranch, "phai co nhanh render inline hint khi khong co document_view");
  assert.equal(/data-testid="contextual-documents"/.test(noPermBranch[0]), false,
    "nhanh thieu quyen khong duoc render nut Ho so NLD");
});

/* ----- 6. Staged row → "Lưu NLĐ để thêm hồ sơ", không có nút Hồ sơ NLĐ ----- */
test("H08-6 staged row: inline hint 'Luu NLĐ', khong render nut Ho so NLD", () => {
  // Nhanh render cho staged row (selectedIsStaged).
  assert.match(live, /data-testid="contextual-staged-hint"/);
  assert.match(live, /Lưu NLĐ để thêm hồ sơ\./);
  // Trong nhanh staged chi render hint, khong render nut Ho so NLD.
  const stagedBranch = live.match(
    /selectedIsStaged \?\s*\([\s\S]{0,500}\)\s*:/);
  assert.ok(stagedBranch, "phai co nhanh render cho staged row");
  assert.equal(/data-testid="contextual-documents"/.test(stagedBranch[0]), false,
    "nhanh staged khong duoc render nut Ho so NLD");
});

/* ----- 7. Stale selectedClientRowId → cleanup an toan ----- */
test("H08-7 stale selection: effect/render-time clear an toan", () => {
  // Render-time cleanup (sau selectionAfterSaveEntryId block) dam bao
  // selectedClientRowId khong giu mot id khong ton tai trong spreadsheetRows.
  assert.match(live,
    /selectedClientRowId !== null && selectionAfterSaveEntryId === null[\s\S]{0,400}setSelectedClientRowId\(null\)/);
  // Guard: chi clear khi khong dang trong qua trinh save.
  assert.match(live, /selectionAfterSaveEntryId === null/);
});

/* ----- 8. Post-save resolve sang persisted row, nut Hồ sơ hoạt động ----- */
test("H08-8 post-save: selectionAfterSaveEntryId resolve sang persisted row", () => {
  // Logic resolve tu H06 giu nguyen: rows.find(row => row.entryId === selectionAfterSaveEntryId)
  // set selected = match.rowId, set savedCtaClientRowId.
  assert.match(live,
    /if \(selectionAfterSaveEntryId !== null\) \{[\s\S]{0,800}setSelectedClientRowId\(match\.rowId\)/);
  // Khi row resolve, selected.persisted se la true (vi entryId !== null),
  // contextual bar render nhanh "selectedIsPersisted && canOpenWorkerDocuments"
  // → nut Hồ sơ NLĊ enabled.
  // Dam bao projection su dung entryId !== null lam proxy cho persisted.
  assert.match(live, /persisted: row\.entryId !== null/);
});

/* ----- 9. CSS class contextualActionHint: inline hint hien thi canh button group ----- */
test("H08-9 CSS inline hint: co class contextualActionHint voi min-height canh button", () => {
  // Class phai co min-height 44px de canh voi button (44px) theo design system.
  assert.match(css, /\.contextualActionHint\s*\{[\s\S]{0,400}min-height:\s*44px/);
  // Phai co color muted va italic de phan biet action chinh.
  assert.match(css, /\.contextualActionHint\s*\{[\s\S]{0,400}color:\s*var\(--muted/);
});

/* ----- 10. Không tạo document/R2 object trước khi NLĐ được lưu ----- */
test("H08-10 khong tao document/R2 object truoc khi NLD duoc luu", () => {
  // staged row KHONG render nut Ho so NLD (H08-6).
  // Khi staged row, khong the click Ho so NLD de mo dialog → khong the
  // upload, khong the tao R2 object.
  const stagedBranch = live.match(
    /selectedIsStaged \?\s*\([\s\S]{0,500}\)\s*:/);
  assert.ok(stagedBranch);
  assert.equal(/data-testid="contextual-documents"/.test(stagedBranch[0]), false);
  // DirectEntryWorkerDocuments dialog chi mo khi row.entryId !== null.
  // Day la guard hien huu (khong thay doi trong H08).
  assert.match(documents,
    /const open = row !== null && row\.entryId !== null/);
});

/* ----- 11. Không regress H06 document flow ----- */
test("H08-11 khong regress H06 document flow", () => {
  // H06-10: setDocumentsRowId(persisted.rowId) - van con trong H08.
  assert.match(live, /setDocumentsRowId\(persisted\.rowId\)/);
  // H06-11: khong dung row index/name/CCCD.
  const docsBranch = live.match(
    /selectedIsPersisted && canOpenWorkerDocuments \? \([\s\S]{0,2000}<\/button>/);
  assert.ok(docsBranch);
  assert.equal(/national_id|nationalId/.test(docsBranch[0]), false,
    "khong su dung national_id de mo ho so");
  assert.equal(/row_index/.test(docsBranch[0]), false,
    "khong su dung row index");
  // H06-12: reuse DirectEntryCccdManager + DirectEntryDocumentEditor.
  assert.match(documents, /\bDirectEntryCccdManager\b/);
  assert.match(documents, /\bDirectEntryDocumentEditor\b/);
  // H06-13: khong N+1 fetch trong live.
  const liveDocsRegion = live.slice(live.indexOf("<DirectEntryWorkerDocuments"),
    live.indexOf("<Dialog.Root", live.indexOf("<DirectEntryWorkerDocuments")));
  assert.equal(/fetchEntryDetail|\/api\/direct-entry\/entries\//.test(liveDocsRegion), false,
    "live khong goi entry detail");
  assert.equal((liveDocsRegion.match(/\bfetch\s*\(/g) ?? []).length, 0,
    "live khong goi fetch truc tiep");
  // H06-14: khong log PII.
  const RAW_LOGGING = /console\.(?:log|error|warn|info)\(/;
  for (const file of [live, documents]) {
    assert.doesNotMatch(file, RAW_LOGGING);
  }
});

/* ----- 12. Khong regress H07 row selection ----- */
test("H08-12 khong regress H07 row selection", () => {
  const grid = readFileSync(
    new URL("./direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");
  // H07 E1: chon row qua click cell va keyboard (trong grid).
  assert.match(grid, /onCellClick/);
  assert.match(grid, /onCellKeyDown/);
  // H07 E2: rowClass highlight (trong grid).
  assert.match(grid, /rowClass/);
  // H07 E4: contextual bar hien thi "Đang chọn dòng STT {n}" (trong live).
  assert.match(live, /Đang chọn dòng STT/);
  // H07 E5: staged row nut Xoa goi onStagedDelete (trong live).
  assert.match(live, /onStagedDelete\(selected\.clientRowId\)/);
  // H07 E6: persisted row nut Ho so NLD mo dialog voi entry_id.
  assert.match(live, /setDocumentsRowId\(persisted\.rowId\)/);
  // H07 B: project dropdown selectable before first_work_date (trong live).
  assert.match(live, /fallbackCatalog/);
  // H07 C: staged validation deferral (trong live).
  assert.match(live, /stagedValidationForDisplay/);
  // H07 D: cellsTextEditor (khong con renderTextEditor mac dinh) (trong grid).
  assert.match(grid, /cellsTextEditor/);
  // Khong import renderTextEditor tu react-data-grid (chi con trong comment).
  assert.equal(/from\s+["']react-data-grid["'][\s\S]{0,200}renderTextEditor/.test(grid), false,
    "khong import renderTextEditor tu react-data-grid");
});

/* ----- 13. Capability projection accept ca entry_own lan entry_admin ----- */
test("H08-13 capability projection accept ca entry_own lan entry_admin", () => {
  // Ca canEditDocsFromCta (contextual bar) va canEditDocuments prop
  // (DirectEntryWorkerDocuments) deu chap nhan entry_own HOAC entry_admin.
  // (Truoc day chi nhan entry_own; entry_admin bi loai, gay disabled button
  // cho admin-scope user.)
  const occurrences = (live.match(/entry_own[\s\S]{0,200}\|\|[\s\S]{0,200}entry_admin/g) ?? []).length;
  assert.ok(occurrences >= 2,
    "phai co it nhat 2 cho accept entry_own || entry_admin (canEditDocsFromCta + canEditDocuments prop)");
});

/* ----- 14. DirectEntryWorkerDocuments giu dialog mo theo entry_id (H06 contract) ----- */
test("H08-14 documents dialog mount theo entry_id, khong auto-reload", () => {
  // H06 contract: dialog chi mo khi row co entry_id, khong phu thuoc vao
  // index/ten/CCCD. H08 giu nguyen contract.
  assert.match(documents, /const open = row !== null && row\.entryId !== null/);
  // CCCD manager va Document editor mount theo entryId.
  assert.match(documents, /<DirectEntryCccdManager[\s\S]{0,400}row=\{row\}/);
  assert.match(documents, /entryId=\{row\.entryId\}/);
});

/* ----- 15. Mobile persisted card (existing H06) van mo documents dialog ----- */
test("H08-15 mobile card 'Hồ sơ' van mo cung documents dialog", () => {
  // H06 contract: mobile card co data-testid="mobile-open-documents-..."
  // H08 khong sua mobile flow.
  assert.match(live, /data-testid=\{`mobile-open-documents-\$\{row\.rowId\}`\}/);
  assert.match(live, /onClick=\{\(\) => setDocumentsRowId\(row\.rowId\)\}/);
});

/* ----- 16. Stale selection: render-time guard khong clear khi dang save ----- */
test("H08-16 stale selection cleanup bo qua khi dang save (tranh race)", () => {
  // Cleanup chi chay khi selectionAfterSaveEntryId === null (khong dang
  // trong qua trinh save). Tranh race voi H06 selectionAfterSaveEntryId
  // block.
  const cleanupBlock = live.match(
    /if \(selectedClientRowId !== null && selectionAfterSaveEntryId === null\)/);
  assert.ok(cleanupBlock, "phai co render-time guard cho stale selection cleanup");
  // Khi dang save (selectionAfterSaveEntryId !== null), cleanup KHONG chay.
  // Dam bao khoi clear ngay khi vua save xong (truoc khi reload xong).
  assert.match(live, /selectionAfterSaveEntryId === null/);
});

/* ----- 17. Cap nhat capability projection: chi View (document_view) → dialog mo ----- */
test("H08-17 chi co document_view (khong entry_own/admin, khong document_upload)", () => {
  // canOpenWorkerDocuments = canViewDocs && selectedHasEntryId → true.
  // canEditDocsFromCta = false (thieu entry_own/admin + document_upload).
  // → nut Ho so NLD render, disabled=false, title="(chỉ xem)".
  // DirectEntryWorkerDocuments dialog mo (vi canViewDocuments=true), CCCD
  // manager va document editor co canEdit=false (read-only).
  assert.match(live, /const canOpenWorkerDocuments = canViewDocs && selectedHasEntryId/);
  // canViewDocuments prop truyen vao dialog.
  assert.match(live, /canViewDocuments=\{capabilities\.includes\("document_view"\)\}/);
});

