import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

/** Bo comment truoc khi quet tu khoa bi cam. */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const dialog = source("./direct-entry-worker-profile-paste-dialog.tsx");
const dialogCode = codeOnly(dialog);
const live = source("./direct-entry-live.tsx");
const liveCode = codeOnly(live);
const css = source("./direct-entry-shell.module.css");
const cccdManager = source("./direct-entry-cccd-manager.tsx");

const RAW_LOGGING = /console\.(?:log|error|warn|info)\(/;
/**
 * Truong authority dang REQUEST (khong phai prop `capabilities` dung de gate CTA).
 * Request that su duoc kiem tra o full-profile-batch.test.mjs theo key set.
 */
const REQUEST_AUTHORITY = /(?:actor_id|auth_subject|app_user_id|scope_kind|owner_user_id|created_by_user_id|provider_type|team_id|payment_state|bank_label)\s*:/;

test("dialog: tieu de, huong dan header, textarea, danh sach cot ho tro, summary va CTA cho cho server", () => {
  assert.match(dialog, /Dán hồ sơ từ Excel/);
  assert.match(dialog, /Bắt buộc có dòng header/);
  assert.match(dialog, /Cột bắt buộc: \{WORKER_PROFILE_REQUIRED_HEADERS\.join\(", "\)\}/);
  assert.match(dialog, /data-testid="profile-columns-toggle"/);
  assert.match(dialog, /Danh sách cột hỗ trợ/);
  assert.match(dialog, /data-testid="profile-columns-help"/);
  assert.match(dialog, /WORKER_PROFILE_TEMPLATE_HEADERS\.map/);
  assert.match(dialog, /data-testid="profile-paste-textarea"/);
  assert.match(dialog, /data-testid="profile-summary"/);
  assert.match(dialog, /role=\{errorCount > 0 \? "alert" : "status"\}/);
  // R3B: CTA la that, nhung chi bat khi khong con blocker nao.
  assert.match(dialog, /data-testid="profile-submit"/);
  assert.match(dialog, /disabled=\{submitBlockers\.length > 0\}/);
  assert.match(dialog, /data-testid="profile-blockers"/);
  assert.match(dialog, /data-testid="profile-atomicity"/);
  assert.match(dialog, /data-testid="profile-submit-message"/);
  assert.match(dialog, /data-testid="profile-saved"/);
  assert.match(dialog, /aria-busy=\{submitting\}/);
  assert.match(dialog, /Đang lưu…/);
  // Thong bao atomicity bat buoc hien cho nguoi dung.
  assert.match(dialog, /nếu một dòng không hợp lệ thì không dòng nào\s*\n?\s*được lưu/);
});

test("dialog: chi goi DUNG endpoint full-profile, mot request, khong fallback 6 cot", () => {
  assert.match(dialogCode, /FULL_PROFILE_BATCH_ENDPOINT|postFullProfileBatch\(/);
  assert.equal(dialogCode.includes("postPasteBatch"), false, "khong dung batch toi thieu");
  assert.equal(dialogCode.includes("buildPasteBatchPayload"), false);
  assert.equal(dialogCode.includes("beginPasteGroup"), false);
  assert.equal(dialogCode.includes("settlePasteGroup"), false);
  assert.equal(dialogCode.includes('"/api/direct-entry/batches"'), false,
    "khong goi endpoint batch toi thieu");
  assert.equal(dialogCode.includes('method: "PATCH"'), false, "khong luu tung dong");
  assert.equal(dialogCode.includes("XMLHttpRequest"), false);
  // Khong tu dung lai payload 6 cot.
  for (const legacy of ["createPayload", "labor_type:", "recruiter_id:"]) {
    assert.equal(dialogCode.includes(legacy), false, legacy);
  }
  assert.match(dialogCode, /buildWorkerProfilePreview\(/);
  assert.match(dialogCode, /buildFullProfileRequestBody\(/);
  assert.match(dialogCode, /fullProfileIntentDigest\(/);
  assert.match(dialogCode, /resolveIntentKey\(/);
  assert.match(dialogCode, /clearIntentKey\(/);
  // Chi mot lan goi transport trong toan bo component.
  assert.equal((dialogCode.match(/postFullProfileBatch\(/g) ?? []).length, 1);
});

test("dialog: Escape + focus tra ve nut mo qua Radix, khong tu quan ly focus", () => {
  assert.match(dialog, /<Dialog\.Trigger asChild>\{trigger\}<\/Dialog\.Trigger>/);
  assert.match(dialog, /<Dialog\.Close asChild>/);
  assert.match(dialog, /const handleOpenChange = useCallback/);
  assert.doesNotMatch(dialogCode, /addEventListener\(\s*["']key(down|up)["']/);
  assert.doesNotMatch(dialogCode, /focus-trap|createFocusTrap|aria-modal="true"|\.focus\(\)/);
  // Ref chi duoc ghi trong effect (lint react-hooks/refs cung kiem tra dieu nay).
  const refWrites = dialogCode.split("\n").filter((line) => /\.current\s*=(?!=)/.test(line));
  assert.equal(refWrites.length, 8, JSON.stringify(refWrites));
  assert.equal(refWrites.every((line) =>
    line.includes("intentKey.current") || line.includes("inFlight.current")), true);
  // Khong ghi ref trong than render: moi lan ghi nam trong handler/effect.
  assert.match(dialogCode, /const submitBlockers = useMemo\(/);
});

test("dialog: masked CCCD/STK, khong raw JSON, khong console, khong storage", () => {
  assert.match(dialog, /maskNationalId\(worker\.national_id\.value\)/);
  assert.match(dialog, /maskAccountNumber\(payment\.account_number\.value\)/);
  for (const forbidden of ["<pre", "JSON.stringify", "dangerouslySetInnerHTML",
    "localStorage.", "sessionStorage.", "indexedDB.", "document.cookie", "file.name",
    "storage_key", "checksum", "bucket", "signed"]) {
    assert.equal(dialogCode.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(dialog, RAW_LOGGING);
  assert.doesNotMatch(dialogCode, REQUEST_AUTHORITY);
  // Error detail chi la message tinh tu code.
  assert.match(dialogCode, /workerProfileIssueMessage\(entry\.code\)/);
});

test("dialog: section theo nhom va ghi chu CCCD/team/provider", () => {
  for (const heading of ["Công việc", "Hồ sơ cá nhân", "Tình trạng làm việc",
    "Thông tin tài khoản để đối chiếu", "Validation-only"]) {
    assert.equal(dialog.includes(">" + heading + "<"), true, heading);
  }
  assert.match(dialog, /WORKER_PROFILE_CCCD_NOTE/);
  assert.match(dialog, /Ảnh CCCD mặt trước\/sau được tải riêng sau khi hồ sơ được lưu\./);
  assert.match(dialog, /Hệ thống sẽ xác nhận chi nhánh\/team và HRP\/Vendor từ danh mục/);
  assert.match(dialog, /data-testid=\{"profile-detail-toggle-" \+ row\.sourceRow\}/);
  assert.match(dialog, /aria-expanded=\{expanded\}/);
});

test("live: nut 'Dan ho so tu Excel' canh nut dan toi thieu; khong fallback tu dong", () => {
  const headerActions = live.slice(live.indexOf("liveHeaderActions"),
    live.indexOf("Thêm dòng"));
  assert.match(headerActions, /Dán hồ sơ từ Excel/);
  assert.match(headerActions, /data-testid="profile-paste-open"/);
  assert.match(headerActions, /<DirectEntryWorkerProfilePasteDialog/);
  assert.match(headerActions, /referenceDate=\{today\}/);
  assert.match(headerActions, /catalogFor=\{catalogFor\}/);
  assert.match(headerActions, /existing=\{existingProfileIdentities\}/);
  // Duong toi thieu (6 cot) van con nguyen: khong phai fallback cua duong ho so day du.
  assert.match(live, /data-testid="paste-excel-open"/);
  assert.match(live, /postPasteBatch\(/);
  // Khong truyen callback noi bo ra server.
  assert.equal(liveCode.includes("onValidatedRows="), false);
});

test("CSS: dialog ho so responsive, mobile khong tran, touch target >= 44px", () => {
  assert.match(css, /\.profilePasteDialog \{/);
  assert.match(css, /max-width: 100vw/);
  assert.match(css, /@media \(max-width: 767px\) \{\s*\.profilePasteDialog \{/);
  assert.match(css, /\.profileRowCard button \{\s*min-height: 44px;/);
  assert.match(css, /\.profileFieldList \{\s*grid-template-columns: 1fr;/);
  assert.match(css, /\.pastePreview \{[\s\S]{0,120}min-width: 640px;/);
});

test("khong cham vao CCCD: transport/helper/manager khong bi sua trong R3A", () => {
  // Dialog ho so khong import CCCD va khong dinh nghia lai hai slot.
  assert.equal(dialogCode.includes("CCCD_FRONT"), false);
  assert.equal(dialogCode.includes("cccd-upload-runner"), false);
  assert.equal(dialogCode.includes("createCccdTransport"), false);
  assert.equal(dialogCode.includes("sha256"), false);
  // Manager CCCD van giu nguyen API hai slot.
  assert.match(cccdManager, /CCCD_DOCUMENT_TYPES\.map/);
  assert.match(cccdManager, /runCccdUpload\(/);
  assert.match(cccdManager, /createCccdTransport\(/);
});
