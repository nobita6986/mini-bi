import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const dialog = source("./direct-entry-excel-paste-dialog.tsx");
const live = source("./direct-entry-live.tsx");
const importModule = source("../../lib/direct-entry/excel-paste-import.ts");

const RAW_LOGGING = /console\.(?:log|error|warn|info)\(/;
const CLIENT_AUTHORITY = /(?:actor_id|auth_subject|app_user_id|capability|capabilities|scope|owner_user_id|created_by_user_id|team_id)\s*:/;

test("nut 'Dan tu Excel' nam canh 'Them dong' va mo bang Radix Dialog co Trigger asChild", () => {
  const actions = live.slice(live.indexOf("liveHeaderActions"), live.indexOf("<p\n        className={styles.lifecycleStatus}"));
  assert.match(actions, /Dán từ Excel/);
  assert.match(actions, /Thêm dòng/);
  assert.equal(actions.indexOf("Dán từ Excel") < actions.indexOf("Thêm dòng"), true,
    "nut dan dung truoc nut them dong");
  assert.match(actions, /<DirectEntryExcelPasteDialog/);
  assert.match(actions, /data-testid="paste-excel-open"/);
  // Focus tra ve nut mo: Radix Trigger asChild + Close, khong tu quan ly focus.
  assert.match(dialog, /<Dialog\.Trigger asChild>\{trigger\}<\/Dialog\.Trigger>/);
  assert.match(dialog, /<Dialog\.Close asChild>/);
  assert.match(dialog, /onOpenChange/);
  assert.doesNotMatch(dialog, /addEventListener\(\s*["']key(down|up)["']/);
  assert.doesNotMatch(dialog, /createFocusTrap|focus-trap|aria-modal="true"/);
});

test("hop thoai co textarea, huong dan 6 cot, preview dang bang, tong dong va loi tung dong/cot", () => {
  assert.match(dialog, /<textarea/);
  assert.match(dialog, /aria-label="Dữ liệu dán từ Excel"/);
  assert.match(dialog, /PASTE_COLUMN_HEADINGS\.map/);
  assert.match(dialog, /<ol className={styles\.pasteColumns}>/);
  assert.match(dialog, /data-testid="paste-preview"/);
  assert.match(dialog, /<table className={styles\.pastePreview}/);
  assert.match(dialog, /data-testid="paste-totals"/);
  assert.match(dialog, /\{preview\.validCount\} dòng hợp lệ · \{preview\.errorCount\} lỗi/);
  assert.match(dialog, /describeIssue\(issue\.column, issue\.message\)/);
  assert.match(dialog, /data-testid="paste-line-errors"/);
  assert.match(dialog, /EXCEL_PASTE_MAX_ROWS/);
  assert.match(dialog, /buildPastePreview\(/);
  assert.match(dialog, /requiredCatalogDates\(/);
  assert.match(dialog, /toPasteCatalog\(/);
});

test("nut them chi bat khi toan bo dong hop le", () => {
  assert.match(dialog, /disabled=\{!preview\.canSubmit \|\| submitState === "saving"\}/);
  assert.match(dialog, /data-testid="paste-submit"/);
  assert.match(dialog, /\{submitState === "saving" \? "Đang thêm…" : "Thêm " \+ preview\.validCount \+ " dòng"\}/);
  assert.match(importModule, /canSubmit: rows\.length > 0 && issues\.length === 0/);
});

test("paste/preview khong mutation: hop thoai khong goi fetch, live chi co MOT request cho ca nhom", () => {
  assert.equal((dialog.match(/fetch\(/g) ?? []).length, 0, "preview khong goi API");
  assert.equal(dialog.includes("/api/direct-entry"), false);
  assert.equal((live.match(/postPasteBatch\(/g) ?? []).length, 1, "dung mot request cho ca nhom");
  assert.match(live, /buildPasteBatchPayload\(previewRows\)/);
  assert.match(live, /beginPasteGroup\(/);
  assert.match(live, /settlePasteGroup\(/);
  assert.match(live, /assignPasteEntryIds\(/);
  assert.match(live, /idempotencyKey: group\.pending\.key/);
  // Nhom dan khong tu goi fetch thu cong; chi di qua boundary postPasteBatch.
  const pasteSubmit = live.slice(live.indexOf("const submitPasteGroup"),
    live.indexOf("const setCccdStatus"));
  assert.equal((pasteSubmit.match(/fetch\(/g) ?? []).length, 0);
  assert.equal(pasteSubmit.includes("/api/direct-entry/batches"), false);
  assert.match(live, /newDraftRow\(assignment\.entryId, preview\.firstWorkDate\)/);
  // Regression: luong luu thu cong mot dong van gui batch 1 dong nhu truoc.
  assert.match(live, /body: JSON\.stringify\(\{ rows: \[createPayload\(rowWithFields\(current, pending\.fields\)\)\] \}\)/);
  assert.match(live, /const saveDirtyRows = useCallback/);
});

test("khong optimistic-save: nhom chi duoc them vao bang trong nhanh saved", () => {
  const submit = live.slice(live.indexOf("const submitPasteGroup"), live.indexOf("const setCccdStatus"));
  const savedBranch = submit.indexOf('settled.outcome.status === "saved"');
  const setRows = submit.indexOf("setRows((current) => {");
  assert.equal(savedBranch > 0 && setRows > savedBranch, true,
    "setRows chi nam trong nhanh da duoc may chu xac nhan");
  assert.match(submit, /if \(!assignments\) \{/);
  assert.match(submit, /reloadRequired: settled\.outcome\.reloadRequired/);
  assert.match(submit, /pasteBatchErrorMessage\(settled\.outcome\.code\)/);
  assert.doesNotMatch(submit, /retry|setTimeout\(\(\) => void postPasteBatch/);
});

test("khong khai authority o client, khong logging, khong storage", () => {
  for (const file of [dialog, live]) {
    assert.doesNotMatch(file, RAW_LOGGING);
    assert.doesNotMatch(file, CLIENT_AUTHORITY);
    assert.equal(file.includes("localStorage"), false);
    assert.equal(file.includes("sessionStorage"), false);
    assert.doesNotMatch(file, /dangerouslySetInnerHTML/);
  }
  assert.doesNotMatch(importModule, /dangerouslySetInnerHTML|innerHTML\s*=/);
  const payloadBuilder = importModule.slice(importModule.indexOf("export function buildPasteBatchPayload"));
  assert.deepEqual([...payloadBuilder.matchAll(/^\s{4}([a-z_]+):/gm)].map((match) => match[1]),
    ["project_id", "first_work_date", "employee_code", "worker", "recruiter_id", "labor_type"]);
});

test("duplicate duoc doi chieu voi cac dong CHUA LUU dang co tren trang", () => {
  assert.match(live, /unsavedEmployeeCodes/);
  assert.match(live, /row\.entryId === null \|\| isUnsavedRowState\(row\.state\)/);
  assert.match(live, /existingEmployeeCodes={unsavedEmployeeCodes}/);
  assert.match(importModule, /existingEmployeeCodes\?: readonly string\[\]/);
  assert.match(importModule, /validateEmployeeCode\(row\.employeeCode, row\.firstWorkDate, existingCodes\)/);
});

test("moi effective date chi resolve catalog mot lan trong preview", () => {
  assert.match(dialog, /const dates = useMemo\(\(\) => requiredCatalogDates\(text\), \[text\]\)/);
  assert.match(dialog, /void ensureCatalog\(date\)\.catch\(\(\) => \{\}\)/);
  assert.match(dialog, /const dateKey = dates\.join\(","\)/);
});
