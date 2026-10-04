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
const CLIENT_AUTHORITY = /(?:actor_id|auth_subject|app_user_id|capability|capabilities|scope|owner_user_id|created_by_user_id|provider_type|team_id)\s*:/;

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
  // CTA: khong dung chu "Luu", dung trang thai cho server va luon disabled.
  assert.match(dialog, /export const WORKER_PROFILE_SERVER_PENDING_LABEL = "Chờ máy chủ hỗ trợ hồ sơ đầy đủ"/);
  assert.match(dialog, /data-testid="profile-submit"[\s\S]{0,120}disabled/);
  assert.equal(dialog.includes("Lưu hồ sơ"), false);
  assert.equal(/\bLưu\b/.test(dialogCode), false);
});

test("dialog: khong POST, khong fallback payload 6 cot, khong goi API nao", () => {
  for (const forbidden of ["fetch(", "XMLHttpRequest", "postPasteBatch", "/api/direct-entry",
    "pasteBatchSignature", "beginPasteGroup", "settlePasteGroup", "buildPasteBatchPayload",
    "idempotency", "Idempotency-Key"]) {
    assert.equal(dialogCode.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(dialogCode, /method:\s*"POST"/);
  // Khong dung lai payload 6 cot cua duong toi thieu.
  for (const legacy of ["createPayload", "rows: [", "labor_type:", "recruiter_id:"]) {
    assert.equal(dialogCode.includes(legacy), false, legacy);
  }
  assert.match(dialogCode, /buildWorkerProfilePreview\(/);
});

test("dialog: Escape + focus tra ve nut mo qua Radix, khong tu quan ly focus", () => {
  assert.match(dialog, /<Dialog\.Trigger asChild>\{trigger\}<\/Dialog\.Trigger>/);
  assert.match(dialog, /<Dialog\.Close asChild>/);
  assert.match(dialog, /const handleOpenChange = useCallback/);
  assert.doesNotMatch(dialogCode, /addEventListener\(\s*["']key(down|up)["']/);
  assert.doesNotMatch(dialogCode, /focus-trap|createFocusTrap|aria-modal="true"|\.focus\(\)/);
  // Ref chi duoc ghi trong effect (lint react-hooks/refs cung kiem tra dieu nay).
  const refWrites = dialogCode.split("\n").filter((line) => /\.current\s*=(?!=)/.test(line));
  assert.equal(refWrites.length, 2, JSON.stringify(refWrites));
  assert.equal(refWrites.every((line) => line.includes("notified.current")), true);
  // Khong ghi ref trong than render: moi lan ghi nam trong effect hoac handler.
  assert.match(dialogCode, /useEffect\(\(\) => \{\s*if \(!preview \|\| !preview\.canProceed/);
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
  assert.doesNotMatch(dialogCode, CLIENT_AUTHORITY);
  // Error detail chi la message tinh tu code.
  assert.match(dialogCode, /workerProfileIssueMessage\(entry\.code\)/);
});

test("dialog: section theo nhom va ghi chu CCCD/team/provider", () => {
  for (const heading of ["Công việc", "Hồ sơ cá nhân", "Tình trạng làm việc", "Thanh toán",
    "Validation-only"]) {
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
