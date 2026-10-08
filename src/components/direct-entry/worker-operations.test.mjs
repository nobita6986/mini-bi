/**
 * P2.5-W06 - Source/structure test cho Worker Operations UI.
 * (tsx khong import duoc bang node:test => kiem tra o muc source + test logic thuan trong
 *  src/lib/direct-entry/worker-operations-model.test.mjs)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./worker-operations.tsx", import.meta.url), "utf8");
const page = readFileSync(
  new URL("../../app/direct-entry/workers/page.tsx", import.meta.url), "utf8");
const reviewer = readFileSync(
  new URL("./direct-entry-change-request-reviewer.tsx", import.meta.url), "utf8");
const registry = readFileSync(
  new URL("../../lib/navigation/registry.ts", import.meta.url), "utf8");

test("W06: la client component, khong import server-only hay ai-*", () => {
  assert.ok(source.includes('"use client"'));
  assert.equal(source.includes("server-only"), false);
  assert.equal(/from\s+["']@\/lib\/ai\//.test(source), false);
});

test("W06: ba tab khong tron quan he + tablist keyboard arrow/Home/End", () => {
  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /role="tabpanel"/);
  assert.match(source, /visibleWorkerTabs\(canSeeAllWorkers\)/);
  assert.match(source, /tabs\.map\(/);
  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
    assert.ok(source.includes(key), "thieu keyboard " + key);
  }
  assert.match(source, /aria-selected/);
  assert.match(source, /tabIndex=\{tab === value \? 0 : -1\}/);
});

test("W06: CTA de xuat chi render khi server propose_change; khong disable", () => {
  assert.match(source, /proposeCta\(row\)/);
  assert.match(source, /cta\.show \?/);
  // Khong co nut de xuat nao bi disable/aria-disabled.
  assert.equal(/disabled=\{!cta|aria-disabled/.test(source), false);
  // Khong suy quyen tu role/email/created_by/recruiter_id trong CODE (comment khong tinh).
  const code = source.split("\n").filter((line) => !/^\s*(\*|\/\/)/.test(line)).join("\n");
  for (const forbidden of ["role ===", "email", "created_by", "is_admin", "auth_subject", "app_user_id"]) {
    assert.equal(code.includes(forbidden), false, "khong duoc suy quyen tu " + forbidden);
  }
});

test("W06-R2: uploader/submission vs recruited|managed|all/directory dung projector that", () => {
  assert.match(source, /tabScope\(tab\)/);
  assert.match(source, /parseSubmissionPageResponse/);
  assert.match(source, /parseWorkerPageResponse/);
  assert.match(source, /workersQuery\(\{ scope, status, cursor \}\)/);
  assert.match(source, /submissionsQuery\(cursor\)/);
  assert.match(source, /requestsQuery\(cursor\)/);
});

test("W06-R2: phan trang that - cursor, Tai them, append dedupe, reset khi doi tab/filter", () => {
  assert.match(source, /applyPage\(/);
  assert.match(source, /beginLoad/);
  assert.match(source, /failLoad\(/);
  assert.match(source, /resetTabPage\(\)/);
  assert.match(source, /hasMore=\{/);
  assert.match(source, /Tải thêm/);
  assert.match(source, /loadMore\(/);
  assert.match(source, /workerRowKey|submissionRowKey|requestRowKey/);
  // Doi tab/filter reset page cua scope tuong ung.
  assert.match(source, /setWorkerPages\(\(pages\) => \(\{ \.\.\.pages, \[next as WorkerScopeTab\]: resetTabPage\(\) \}\)\)/);
  assert.match(source, /setSubmissionPage\(resetTabPage\(\)\)/);
});

test("W06-R2: review payload di qua projectChangeRequestListPage, khong cast raw", () => {
  assert.match(source, /parseChangeRequestPageResponse/);
  assert.match(source, /parsed\.requests/);
  assert.equal(/as ChangeRequestListItem\[\]/.test(source), false, "khong cast raw payload");
});

test("W06-R2: 403 chi la loi CUC BO trong tab, khong thao ca trang", () => {
  // Khong con nhanh return <AccessDenied /> trong component (chi con o page boundary).
  assert.equal(/return <AccessDenied \/>/.test(source), false);
  assert.equal(/return <TemporaryUnavailable \/>/.test(source), false);
  assert.match(source, /state: "denied", message: workerListErrorMessage\(403\)/);
  // Moi tab giu page state rieng.
  assert.match(source, /workerPages\[scope as WorkerScopeTab\]/);
  assert.match(source, /submissionPage\.state/);
});

test("W06-R2: initial tab tu actor projection server-side", () => {
  assert.match(source, /initialWorkerTab\(actor, canSeeAllWorkers\)/);
  assert.match(source, /actor\?: WorkerOperationsActor \| null/);
  assert.equal(/app_user_id|auth_subject/.test(source.split("\n")
    .filter((line) => !/^\s*(\*|\/\/)/.test(line)).join("\n")), false,
  "khong nhan auth_subject/app_user_id tu client");
});

test("W06: pending/last decision + conflict/reload tu server version", () => {
  assert.match(source, /pendingRequestLabel\(row\)/);
  assert.match(source, /lastDecisionLabel\(row\)/);
  assert.match(source, /setConflict\(WORKER_CONFLICT_MESSAGE\)/);
  assert.match(source, /response\.status === 409/);
  assert.match(source, /Tải lại dữ liệu/);
});

test("W06: khong hien UUID tho trong UI", () => {
  // entry_id chi duoc dung lam React key, khong bao gio render thanh noi dung.
  assert.equal(/>\{row\.entry_id\}</.test(source), false, "khong render entry_id");
  assert.equal(/>\{row\.recruiter_id\}</.test(source), false, "khong render recruiter_id");
  assert.equal(/row\.recruiter_id/.test(source), false, "khong dung recruiter_id de hien thi");
  // UUID chi xuat hien trong key={...} (khong phai text) hoac duong dan API.
  const rendered = source.match(/>\{[^}]*\.(entry_id|recruiter_id|request_id|submission_id)[^}]*\}</g) ?? [];
  assert.deepEqual(rendered, [], "khong render UUID tho");
  assert.match(source, /row\.recruiter_display/);
  assert.match(source, /row\.display_name/);
});

test("W06: copy nghiep vu dung 'Thong tin tai khoan ngan hang'", () => {
  assert.match(source, /BANK_ACCOUNT_SECTION_LABEL/);
  assert.equal(/Thông tin thanh toán/.test(source), false, "khong goi la thanh toan");
  assert.equal(/chi tiền|giao dịch/i.test(source), false);
});

test("W06: a11y - filter co label, dialog focus/escape khong mutation", () => {
  assert.match(source, /<label htmlFor=\{filterId\}/);
  assert.match(source, /<Dialog\.Root/);
  assert.match(source, /<Dialog\.Title/);
  assert.match(source, /<Dialog\.Description/);
  assert.match(source, /onSubmit=\{/);
  assert.match(source, /required aria-required="true"/);
  assert.match(source, /if \(!open && !busy\) onOpenChange\(false\)/);
});

test("W06: mobile - bang cuon ngang, min-width, khong hover-only action", () => {
  assert.match(source, /overflow-x-auto/);
  assert.match(source, /min-w-\[/);
  assert.equal(/group-hover:|hover:opacity|opacity-0/.test(source), false);
});

test("W06: page boundary cung flag + actor resolver nhu /direct-entry", () => {
  assert.match(page, /isDirectEntryUiEnabled\(process\.env\.DIRECT_ENTRY_UI_ENABLED\)/);
  assert.match(page, /decideWorkerOperationsPageAccess/);
  assert.match(page, /workerOperationsAllScopePredicate/);
  assert.match(page, /workerOperationsReviewPredicate/);
  assert.match(page, /canSeeAllWorkers=\{canSeeAllWorkers\}/);
  assert.match(page, /canReview=\{canReview\}/);
  assert.match(page, /case "NOT_FOUND":[\s\S]{0,40}notFound\(\)/);
  assert.match(page, /redirect\("\/login\?next=\/direct-entry\/workers"\)/);
  assert.match(page, /case "ALLOW":[\s\S]{0,600}<WorkerOperations/);
});

test("W06: nav entry 'worker-operations' duoc dang ky trong registry hien co", () => {
  assert.match(registry, /id: "worker-operations"/);
  assert.match(registry, /path: "\/direct-entry\/workers"/);
  assert.match(registry, /label: "Người lao động"/);
});

test("W06-R1: review queue tai su dung list/reviewer hien co, chi khi canReview", () => {
  assert.match(source, /DirectEntryChangeRequestList/);
  assert.match(source, /DirectEntryChangeRequestReviewer/);
  assert.match(source, /\{canReview \? \(/);
  assert.match(source, /onReview=\{/);
  // Khong nhung editor Direct Entry.
  assert.equal(/DirectEntryLive|DirectEntryShell|DirectEntrySpreadsheetGrid/.test(source), false);
});

test("W06-R1: propose drawer gom WORKER + PAYMENT + WORK_STATUS bang builder hien co", () => {
  assert.match(source, /buildWorkerDetailsProposal/);
  assert.match(source, /buildPaymentProposal/);
  assert.match(source, /buildWorkStatusProposal/);
  assert.match(source, /buildChangeRequestItem/);
  assert.match(source, /WORKER_PROPOSE_TARGETS\.map/);
  // Khong tu viet lai validation song song.
  assert.equal(/validateWorkerDetails\(/.test(source), false, "dung builder, khong lap validator");
  // Protected fields read-only + display_name giu nguyen.
  assert.match(source, /trường được bảo vệ/);
  assert.match(source, /giữ nguyên/);
  // Khong co DOCUMENT/CCCD.
  assert.equal(/DOCUMENT|CCCD/.test(source), false);
});

test("W06-R1: reviewer khong co CTA sua truc tiep hay lap proposal", () => {
  // CTA chi xuat hien trong WorkerTable theo cta.show; reviewer khong co nhanh rieng.
  const buttons = source.match(/>\s*Đề xuất thay đổi\s*<\/button>/g) ?? [];
  assert.equal(buttons.length, 1, "chi mot CTA de xuat, dieu khien boi allowed_actions");
  assert.equal(/Sửa trực tiếp|direct edit|privileged/i.test(source), false);
});

test("W06: reviewer UI dung authority backend (can_decide), khong suy tu role client", () => {
  assert.match(reviewer, /can_decide/);
  for (const forbidden of ["role ===", "is_reviewer", "email"]) {
    assert.equal(reviewer.includes(forbidden), false, "reviewer khong duoc suy quyen tu " + forbidden);
  }
});
