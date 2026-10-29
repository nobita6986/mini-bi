import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dialog = readFileSync(new URL("./worker-detail-dialog.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("./worker-portrait-panel.tsx", import.meta.url), "utf8");
const stageSlot = readFileSync(new URL("./worker-portrait-stage-slot.tsx", import.meta.url), "utf8");
const legacyPasteDialog = readFileSync(
  new URL("./direct-entry-worker-profile-paste-dialog.tsx", import.meta.url), "utf8");
const projection = readFileSync(new URL("../../lib/direct-entry/worker-detail-projection.ts", import.meta.url), "utf8");
const stageClient = readFileSync(new URL("../../lib/direct-entry/worker-portrait-stage-client.ts", import.meta.url), "utf8");
const operations = readFileSync(new URL("./worker-operations.tsx", import.meta.url), "utf8");
const workersPage = readFileSync(
  new URL("../../app/direct-entry/workers/page.tsx", import.meta.url), "utf8");

/** Bo comment de kiem tra CHUOI NGUOI DUNG NHIN THAY (khong tinh comment giai thich noi bo). */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("W2S1: danh sách NLĐ mở chi tiết qua dialog dùng chung, không tạo route thứ hai", () => {
  assert.match(operations, /import \{ WorkerDetailDialog \} from "@\/components\/direct-entry\/worker-detail-dialog"/);
  assert.match(operations, /<WorkerDetailDialog/);
  assert.match(operations, /onViewDetail=\{\(row, opener\) => \{/);
  assert.match(operations, /Xem chi tiết/);
  assert.match(operations, /onClick=\{\(event\) => onViewDetail\(row, event\.currentTarget\)\}/);
  assert.match(operations, /data-testid="worker-detail-dialog"|row=\{detailRow\}/);
  // Khong co trang chi tiet thu hai: route workers chi render WorkerOperations.
  assert.match(workersPage, /<WorkerOperations/);
  assert.doesNotMatch(workersPage, /WorkerDetailDialog/);
});

test("W2S1: dialog dùng Radix, layout mobile toàn chiều rộng và trả focus về nút mở", () => {
  assert.match(dialog, /import \{ Dialog \} from "radix-ui"/);
  assert.match(dialog, /<Dialog\.Root open=\{open\}/);
  assert.match(dialog, /<Dialog\.Title/);
  assert.match(dialog, /<Dialog\.Description/);
  assert.match(dialog, /className=\{styles\.documentsDialog\}/);
  assert.match(dialog, /data-testid="worker-detail-dialog"/);
  assert.match(dialog, /aria-describedby="worker-detail-description"/);
  assert.match(dialog, /onCloseAutoFocus=\{\(event\) => \{/);
  assert.match(dialog, /openerRef\.current\.focus\(\)/);
});

test("W2S1: dialog đủ các nhóm dữ liệu đã chốt và trạng thái tải/lỗi/thử lại", () => {
  for (const heading of [
    "Thông tin người lao động",
    "Công việc và dự án",
    "Thanh toán",
    "Thay đổi gần nhất",
    "Tình trạng từng loại hồ sơ",
  ]) {
    assert.ok(dialog.includes(heading), `thiếu nhóm: ${heading}`);
  }
  assert.match(dialog, /Đang tải chi tiết người lao động…/);
  assert.match(dialog, /Không tải được chi tiết người lao động\./);
  assert.match(dialog, /onClick=\{\(\) => \{ setState\("loading"\); setReloadKey\(\(value\) => value \+ 1\); \}\}/);
  assert.match(dialog, /<dt>CCCD<\/dt>/);
});

test("W2S1: quyền chỉ đến từ capability server-resolved, không suy từ tab/role; Xem chi tiết chỉ đọc", () => {
  assert.match(operations, /actor\?\.capabilities\.includes\("document_upload"\) === true/);
  const proposeDrawerCall = operations.match(/<ProposeDrawer[\s\S]*?\n      \/>/)?.[0] ?? "";
  const detailDialogCall = operations.match(/<WorkerDetailDialog[\s\S]*?\n      \/>/)?.[0] ?? "";
  assert.match(proposeDrawerCall, /canUploadDocuments=\{canUploadDocuments\}/);
  assert.doesNotMatch(detailDialogCall, /canUploadDocuments/);
  assert.doesNotMatch(dialog, /canUploadDocuments/);
  assert.match(dialog, /canUpload=\{false\}/);
  assert.doesNotMatch(dialog, /type="file"|privileged-edit|change-requests/);
  assert.doesNotMatch(dialog, /\.role\b/);
  assert.doesNotMatch(dialog, /allowed_actions\.view_pii/);
});

test("W2S1: dialog dùng đúng projection server, không gọi API/RPC trực tiếp hay gọi nhiều nguồn", () => {
  assert.match(dialog, /fetchWorkerDetail\(row\.entry_id, fetch\)/);
  assert.doesNotMatch(dialog, /fetch\("\/api/);
  assert.doesNotMatch(dialog, /\.rpc\(/);
  assert.doesNotMatch(dialog, /storage_key|X-Amz|signedUrl|signed_url/);
  assert.doesNotMatch(dialog, /from "next\/image"/);
  assert.doesNotMatch(dialog, /redacted|presenceOnly|view_pii|view_payment/);
  assert.match(dialog, /detail\.worker\.national_id/);
  assert.match(dialog, /detail\.worker\.date_of_birth/);
  assert.match(dialog, /Thời gian nhập liệu/);
  assert.match(dialog, /formatHcmDateTime\(detail\.createdAt\)/);
  assert.match(dialog, /Người nhập liệu/);
  assert.match(dialog, /detail\.createdBy\.displayName/);
});

test("W2S1: CCCD preview dùng route riêng; KHÔNG dùng portrait preview cho CCCD", () => {
  assert.match(dialog, /WORKER_DETAIL_PREVIEW_PENDING_NOTE/);
  assert.match(dialog, /workerCccdPreviewUrl\(entryId, documentId\)/);
  assert.match(dialog, /workerCccdPreviewable\(document\)/);
  assert.match(dialog, /data-testid=\{`cccd-preview-\$\{documentId\}`\}/);
  // URL do projection module quyet dinh, khong hardcode trong dialog; khong dung portrait preview.
  assert.doesNotMatch(dialog, /workerPortraitPreviewUrl/);
  assert.doesNotMatch(dialog, /fetch\("\/api\/direct-entry/);
  assert.match(dialog, /workerDocumentReady\(document\)/);
  assert.match(dialog, /type === "EMPLOYMENT_CONTRACT"/);
  assert.match(dialog, /\/documents\/\$\{encodeURIComponent\(document\.document_id\)\}\/download/);
  assert.match(dialog, /luồng tài liệu được bảo vệ hiện có/);
});

test("W2S1: panel ảnh NLĐ chỉ render preview trong panel và ẩn khi thiếu document_view", () => {
  assert.match(panel, /portrait === null/);
  assert.match(panel, /\{PORTRAIT_HIDDEN_MESSAGE\}/);
  assert.match(panel, /data-testid="worker-portrait-panel"/);
  assert.match(panel, /src=\{workerPortraitPreviewUrl\(entryId, current\.document_id\)\}/);
  assert.match(panel, /alt="Ảnh NLĐ"/);
  assert.match(panel, />Ảnh NLĐ<\/h3>/);
  assert.doesNotMatch(panel, /from "next\/image"/);
});

test("W2S1: upload ảnh NLĐ theo đúng pipeline reserve -> PUT -> finalize, không hỏi lý do", () => {
  assert.match(panel, /document_type: "WORKER_PORTRAIT"/);
  assert.match(panel, /expected_entry_version: pending\.expectedEntryVersion/);
  assert.match(panel, /size_bytes: file\.size/);
  assert.match(panel, /mime_type: check\.mimeType/);
  assert.match(panel, /reason: WORKER_PORTRAIT_AUDIT_REASON/);
  assert.match(panel, /const WORKER_PORTRAIT_AUDIT_REASON = "Tải ảnh NLĐ"/);
  assert.doesNotMatch(panel, /Lý do tải ảnh|requireReason|textarea/);
  assert.match(dialog, /canUpload=\{false\}/);
  assert.doesNotMatch(dialog, /requireReason/);
  assert.match(panel, /"Idempotency-Key": key/);
  assert.match(panel, /`\$\{pending\.key\}:finalize`/);
  assert.match(panel, /workerPortraitUploadUrl\(entryId, documentId\)/);
  assert.match(panel, /method: "PUT", headers, body: file/);
  assert.match(panel, /const uploadInfo = reserved\.payload\.upload/);
});

test("W2S1: nhãn ảnh trong các bề mặt UI dùng thống nhất từ ngữ Ảnh NLĐ", () => {
  const visibleCopy = stripComments([panel, stageSlot, legacyPasteDialog, projection, stageClient].join("\n"));
  assert.match(visibleCopy, /Ảnh NLĐ/);
  assert.doesNotMatch(visibleCopy, /Ảnh hồ sơ/);
});

test("W2S1: không báo thành công giả — chỉ chốt sau khi finalize trả ok", () => {
  const finalizeGate = panel.indexOf("DOCUMENT_FINALIZE_UNAVAILABLE");
  const saved = panel.indexOf('setState("saved")');
  assert.ok(finalizeGate > -1 && saved > finalizeGate, "trạng thái đã lưu phải nằm sau kiểm tra finalize");
  assert.match(panel, /finalized\.response\.status === 409/);
  assert.match(panel, /setState\("conflict"\)/);
  assert.match(panel, /pendingKey\.current = null;[\s\S]*setState\("saved"\)/);
  assert.match(panel, /onEntryVersionChange\(nextVersion\)/);
  assert.match(panel, /onPortraitChanged\(\)/);
});

test("W2S1: panel xử lý retry/conflict và chỉ nhận JPEG/PNG", () => {
  assert.match(panel, /checkWorkerPortraitFile/);
  assert.match(panel, /accept="image\/jpeg,image\/png"/);
  assert.match(panel, /DOCUMENT_VERSION_CONFLICT/);
  assert.match(panel, /Tải lại trạng thái/);
  assert.match(panel, /state === "error" \? "Thử lại" : "Tải ảnh NLĐ"/);
  assert.doesNotMatch(panel, /storage_key|X-Amz|signedUrl|signed_url/);
  assert.doesNotMatch(panel, /\.rpc\(/);
});

test("W2S1: ảnh thay thế không thành current — chỉ gửi ảnh đầu tiên, khoá khi đã có current", () => {
  assert.match(panel, /const current = portrait\?\.current \?\? null;/);
  assert.match(panel, /const policy = workerPortraitUploadPolicy\(portrait\);/);
  assert.match(panel, /const uploadAllowed = canUpload && policy\.allow;/);
  assert.match(panel, /const uploadLockedMessage = policy\.allow \? null : workerPortraitUploadPolicyMessage\(policy\.reason\);/);
  assert.match(panel, /data-testid="worker-portrait-upload-locked"/);
  assert.match(panel, /\{uploadLockedMessage\}/);
  // Khong co duong ghi `current` cuc bo: current khong phai state, chi doc tu projection server.
  assert.doesNotMatch(panel, /setCurrent/);
  assert.doesNotMatch(panel, /const \[current/);
});

test("W2S1: tệp rỗng/sai MIME/vượt dung lượng bị xoá khỏi state và không thể gửi", () => {
  assert.match(panel, /const selectedFileCheck = checkWorkerPortraitFile\(file\);/);
  assert.match(panel, /disabled=\{busy \|\| !selectedFileCheck\.ok \|\| state === "conflict"\}/);
  // selectFile: tep khong hop le bi xoa khoi state (khong giu lai de gui).
  assert.match(panel,
    /const check = checkWorkerPortraitFile\(nextFile\);[\s\S]*?setFile\(null\);[\s\S]*?return;[\s\S]*?\n    \}/);
  // upload: validate lai ngay trong ham upload truoc khi reserve.
  assert.match(panel,
    /const check = checkWorkerPortraitFile\(file\);[\s\S]*?setFile\(null\);[\s\S]*?setMessage\(friendlyError\(check\.code\)\);[\s\S]*?return;/);
  assert.match(panel, /mime_type: check\.mimeType/);
  assert.doesNotMatch(panel, /mime_type: file\.type/);
});

test("W2S1: nội dung người dùng nhìn thấy không dùng thuật ngữ PII", () => {
  assert.doesNotMatch(dialog, /ẩn theo quyền truy cập PII/);
  assert.doesNotMatch(stripComments(dialog), /PII/);
  assert.doesNotMatch(stripComments(panel), /PII/);
});
