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

test("legacy paste dialog remains reviewable but is not wired into the live toolbar", () => {
  const start = live.indexOf("<header className={styles.header}>");
  const end = live.indexOf("</header>", start);
  const actions = live.slice(start, end);
  assert.match(actions, /Tải file Excel mẫu/);
  assert.match(actions, /Nhập file Excel/);
  assert.match(actions, /Thêm nhanh NLĐ/);
  assert.equal((actions.match(/<button\b/g) ?? []).length, 3);
  assert.doesNotMatch(actions, /Thêm dòng|Lưu các dòng hợp lệ/);
  assert.match(live, /data-testid="add-rows-batch"/);
  assert.match(live, /data-testid="spreadsheet-save"/);
  assert.doesNotMatch(live, /Dán từ Excel|Dán hồ sơ từ Excel|Ctrl\+V/);
  assert.doesNotMatch(live, /DirectEntryExcelPasteDialog|DirectEntryWorkerProfilePasteDialog/);
  assert.match(dialog, /<Dialog\.Trigger asChild>\{trigger\}<\/Dialog\.Trigger>/);
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

test("retained legacy dialog has no request side effects; live save uses the atomic full-profile batch", () => {
  assert.equal((dialog.match(/fetch\(/g) ?? []).length, 0, "preview khong goi API");
  assert.equal(dialog.includes("/api/direct-entry"), false);
  assert.doesNotMatch(live, /postPasteBatch\(|submitPasteGroup|buildPasteBatchPayload/);
  assert.match(live, /buildServerGeneratedFullProfileRequestBody\(preview\.rows\)/);
  assert.match(live, /postFullProfileBatch\(\{/);
  assert.match(live, /body: JSON\.stringify\(\{ rows: \[createPayload\(rowWithFields\(current, pending\.fields\)\)\] \}\)/);
});

test("legacy parser/dialog source remains available without live toolbar triggers", () => {
  assert.match(dialog, /buildPastePreview\(/);
  assert.match(importModule, /export function buildPastePreview/);
  assert.doesNotMatch(live, /pasteOpen|submitPasteGroup|profilePasteOpen/);
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
  assert.match(importModule, /existingEmployeeCodes\?: readonly string\[\]/);
  assert.match(importModule, /validateEmployeeCode\(row\.employeeCode, row\.firstWorkDate, existingCodes\)/);
  assert.doesNotMatch(live, /unsavedEmployeeCodes|existingEmployeeCodes=/);
});

test("moi effective date chi resolve catalog mot lan trong preview", () => {
  assert.match(dialog, /const dates = useMemo\(\(\) => requiredCatalogDates\(text\), \[text\]\)/);
  assert.match(dialog, /void ensureCatalog\(date\)\.catch\(\(\) => \{\}\)/);
  assert.match(dialog, /const dateKey = dates\.join\(","\)/);
});
