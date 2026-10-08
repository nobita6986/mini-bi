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
  assert.match(source, /workersQuery\(\{[\s\S]{0,80}scope, \.\.\.workerFilters, cursor/);
  assert.match(source, /submissionsQuery\(cursor\)/);
  assert.match(source, /requestsQuery\(cursor\)/);
});

test("W06-R2: phan trang that - cursor, Tai them, append dedupe, reset khi doi tab/filter", () => {
  assert.match(source, /applyPage\(/);
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

test("W06-R3: quan he khong ton tai hien 0; loi that cuc bo va co mau do", () => {
  // Khong con nhanh return <AccessDenied /> trong component (chi con o page boundary).
  assert.equal(/return <AccessDenied \/>/.test(source), false);
  assert.equal(/return <TemporaryUnavailable \/>/.test(source), false);
  assert.match(source, /relationDenialIsEmpty\(scope, response\.status\)/);
  assert.match(source, /items: \[\], next_cursor: null, has_more: false/);
  assert.match(source, /0 người lao động trong quan hệ này\./);
  assert.match(source, /text-red-700/);
  // P2.5-HF-R3: trang thai "khong co du lieu" la THONG TIN (mau rieng), khong dung xanh la
  // (de khong bi doc thanh "thanh cong") va khong dung do (danh rieng cho loi).
  assert.match(source, /const infoClass =/);
  assert.match(source, /text-sky-800/);
  assert.match(source, /<p role="status" className=\{infoClass\}>/);
  assert.equal(/border-emerald-500\/30 bg-emerald-500\/10/.test(source), false,
    "empty state khong con dung nen xanh la");
  // Moi tab giu page state rieng.
  assert.match(source, /workerPages\[scope as WorkerScopeTab\]/);
  assert.match(source, /submissionPage\.state/);
});

test("P2.5-HF-R3: hang doi Yeu cau thay doi nam TRUOC danh sach NLD", () => {
  const requests = source.indexOf("<DirectEntryChangeRequestList");
  const panel = source.indexOf("role=\"tabpanel\"");
  assert.ok(requests !== -1 && panel !== -1);
  assert.ok(requests < panel, "change-request queue phai render truoc danh sach NLD");
  // Khong gia lap hang doi yeu cau thay doi DU AN: chi mot danh sach duy nhat.
  assert.equal((source.match(/<DirectEntryChangeRequestList/g) ?? []).length, 1);
});

test("P2.5-HF-R3: khong con cau hua ve quyen pham vi toan bo", () => {
  const model = readFileSync(
    new URL("../../lib/direct-entry/worker-operations-model.ts", import.meta.url), "utf8");
  assert.equal(model.includes("chỉ admin và BoD/Kế toán có quyền phạm vi toàn bộ"), false);
  assert.equal(/có quyền phạm vi toàn bộ/.test(model), false);
  assert.match(model, /all: "Toàn bộ người lao động đã gửi\."/);
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

test("W06 hotfix: modal opaque, correctly layered, scroll body only, theme tokens are real", () => {
  assert.match(source, /Dialog\.Overlay className="fixed inset-0 z-40 bg-black\/50"/);
  assert.match(source, /z-50 flex max-h-\[calc\(100dvh-2rem\)\]/);
  assert.match(source, /overflow-hidden rounded-2xl border border-border bg-surface/);
  assert.match(source, /min-h-0 flex-1 space-y-4 overflow-y-auto/);
  assert.match(source, /<footer className="flex shrink-0/);
  for (const invalidToken of [
    "bg-card", "border-input", "text-primary-foreground", "text-muted-foreground",
    "text-destructive", "bg-destructive",
  ]) {
    assert.equal(source.includes(invalidToken), false, "unsupported theme token: " + invalidToken);
  }
});

test("W06 hotfix: status choices use loaded baseline and a bounded native date input", () => {
  assert.match(source, /allowedWorkStatusTargets\(baseline\?\.status \?\? null\)/);
  assert.match(source, /projectWorkerDetailsForProposal\(row\.worker_details\)/);
  assert.match(source, /expectedVersion: baseline\.version/);
  assert.match(source, /id="worker-effective-date" type="date"/);
  assert.match(source, /min=\{baseline\?\.effectiveDate/);
  assert.match(source, /max=\{today\}/);
  assert.match(source, /setEffectiveDate\(hcmTodayDate\(\)\)/);
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
  assert.match(page, /case "ALLOW":[\s\S]{0,800}<WorkerOperations/);
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

test("W06-R2: approve/reject reloads the authoritative review queue", () => {
  assert.match(source, /const reloadRequestPage = useCallback\(async \(\): Promise<void> =>/);
  assert.match(source, /onDecided=\{\(message\) => \{[\s\S]*?void reloadRequestPage\(\);[\s\S]*?\}\}/);
  assert.doesNotMatch(
    source,
    /onDecided=\{[\s\S]*?items:\s*requestPage\.items[\s\S]*?\}\}/,
    "decision callback must not re-apply the stale pre-decision page",
  );
});

test("W06-R2: selecting the active tab does not reset it without triggering a fetch", () => {
  assert.match(source, /function selectTab\([\s\S]*?if \(next === tab\) \{[\s\S]*?return;[\s\S]*?\}/);
});

test("W06-R1: proposal drawer reuses ENTRY_FIELD, PAYMENT and WORK_STATUS builders", () => {
  assert.match(source, /buildEntryFieldProposal/);
  assert.match(source, /buildPaymentProposal/);
  assert.match(source, /buildWorkStatusProposal/);
  assert.match(source, /buildChangeRequestItem/);
  assert.match(source, /WORKER_PROPOSE_TARGETS\.map/);
  // Khong tu viet lai validation song song.
  assert.equal(/validateWorkerDetails\(/.test(source), false, "dung builder, khong lap validator");
  assert.match(source, /workerEntryFormFromBaseline/);
  assert.match(source, /worker-employee-code/);
  assert.match(source, /worker-project/);
  assert.match(source, /worker-first-work-date/);
  assert.match(source, /worker-recruiter/);
  assert.match(source, /worker-labor-type/);
  // Khong co DOCUMENT/CCCD.
  assert.equal(/DOCUMENT|CCCD/.test(source), false);
});

test("HF-R4: proposal preloads and exposes each ENTRY_FIELD value", () => {
  assert.match(source, /Dữ liệu hiện tại được nạp sẵn/);
  assert.match(source, /Hồ sơ hiện tại/);
  assert.match(source, /WORKER_FORM_FIELDS\.map/);
  assert.match(source, /field === "gender"/);
  for (const label of [
    "Mã người lao động", "Dự án", "Ngày bắt đầu làm việc", "Người tuyển / Vendor",
    "Loại hình lao động", "Trạng thái làm việc",
  ]) {
    assert.ok(source.includes(label), "missing current-profile label: " + label);
  }
  assert.match(source, /id="worker-display-name"[\s\S]{0,180}value=\{entryForm\.workerDetails\.display_name\}/);
  assert.match(source, /<select id="bank-id"/);
  assert.match(source, /catalog\?\.banks/);
  assert.match(source, /useState<WorkerProposeTarget>\("WORKER"\)/);
});

test("HF-R4: direct correction UI is gated by the server capability projection", () => {
  assert.match(source, /canPrivilegedEditWorkers\?: boolean/);
  assert.match(source, /canPrivilegedEdit=\{canPrivilegedEditWorkers\}/);
  assert.match(source, /canPrivilegedEdit \? \(/);
  assert.match(source, /\/privileged-edit/);
  assert.match(page, /canPrivilegedEditWorkers=\{canPrivilegedEditWorkers\}/);
});

test("W06: reviewer UI dung authority backend (can_decide), khong suy tu role client", () => {
  assert.match(reviewer, /can_decide/);
  for (const forbidden of ["role ===", "is_reviewer", "email"]) {
    assert.equal(reviewer.includes(forbidden), false, "reviewer khong duoc suy quyen tu " + forbidden);
  }
});

test("HF-R5A: loi tai them phai duoc bao cho nguoi dung, khong duoc im lang", () => {
  // Truoc R5A: httpFailure tra message null cho 5xx/network nen failLoad giu state "ready"
  // voi message null => khong co gi hien ra sau khi bam "Tai them".
  assert.equal(/state: "unavailable", message: null/.test(source), false);
  assert.equal(source.includes("message: null"), false, "khong con nhanh nao bo trong message");
  assert.match(source, /message: WORKER_LOAD_FAILED_MESSAGE/);
  assert.match(source, /activePage.state === "ready" && activePage.message !== null/);
  assert.match(source, /requestPage.state === "ready" && requestPage.message !== null/);
  assert.match(source, /role="alert" className={errorClass}>{activePage.message}/);
});

test("HF-R5A: catalog bi tu choi (403) la gioi han quyen, khong phai loi he thong", () => {
  assert.match(source, /const CATALOG_DENIED = "CATALOG_DENIED"/);
  assert.match(source, /const CATALOG_UNAVAILABLE = "CATALOG_UNAVAILABLE"/);
  assert.match(source, /result.status === 403\) throw new Error\(CATALOG_DENIED\)/);
  assert.match(source, /filterCatalogState === "denied" \? \(/);
  assert.match(source, /filterCatalogState === "unavailable" \? \(/);
  // Denied dung mau thong tin (sky) + role=status; unavailable dung loi do (role=alert).
  assert.match(source, /role="status" className=\{infoClass\}>[\s\S]{0,220}không có quyền đọc danh mục/);
  assert.match(source, /role="alert" className=\{errorClass\}>[\s\S]{0,120}Không tải được danh mục/);
  // Drawer nhan cung mot su that: fail-closed tren gia tri hien tai, khong tu suy quyen.
  assert.match(source, /catalogDenied={filterCatalogState === "denied"}/);
  assert.match(source, /catalogDenied: boolean/);
  assert.match(source, /entryCatalog === undefined && catalogDenied/);
  assert.match(source, /disabled=\{loading \|\| entryCatalog === undefined\}/);
});

test("HF-R5A: dong drawer phai tra focus ve dung nut da mo", () => {
  // Radix Dialog chi tu tra focus khi co Dialog.Trigger; drawer nay mo bang state nen
  // phai tu ghi nho nut mo (cung cach reviewer dang dung).
  assert.match(source, /const drawerOpenerRef = useRef<HTMLElement \| null>\(null\)/);
  assert.match(source, /onClick=\{\(event\) => onPropose\(row, event\.currentTarget\)\}/);
  assert.match(source, /onClick=\{\(event\) => onCorrect\(row, event\.currentTarget\)\}/);
  assert.match(source, /openerRef: \{ current: HTMLElement \| null \}/);
  assert.match(source, /onCloseAutoFocus=\{\(event\) => \{[\s\S]{0,220}opener\.isConnected[\s\S]{0,120}opener\.focus\(\)/);
  assert.match(source, /openerRef=\{drawerOpenerRef\}/);
});
