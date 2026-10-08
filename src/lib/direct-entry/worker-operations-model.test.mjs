import assert from "node:assert/strict";
import test from "node:test";

import {
  BANK_ACCOUNT_SECTION_LABEL,
  WORKER_OPERATIONS_TABS,
  WORKER_OPERATIONS_TAB_LABELS,
  WORKER_PROPOSE_TARGETS,
  WORKER_PROPOSE_TARGET_LABELS,
  bankAccountSummary,
  canReviewChangeRequests,
  isWorkerOperationsTab,
  lastDecisionLabel,
  parseSubmissionPageResponse,
  parseWorkerPageResponse,
  pendingRequestLabel,
  proposeCta,
  tabScope,
  visibleWorkerTabs,
  workerDenialMessage,
  workerListErrorMessage,
  workerStatusLabel,
} from "./worker-operations-model.ts";

const AUTH = "2026-10-08";
const ENTRY = "11111111-1111-4111-8111-111111111111";
const RECRUITER = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";

function actions(overrides = {}) {
  return { view: true, view_pii: false, view_payment: false,
    propose_change: false, propose_change_code: "NOT_PROJECT_MANAGER", ...overrides };
}
function row(overrides = {}) {
  return {
    entry_id: ENTRY, entry_version: 3, submission_state: "SUBMITTED",
    employee_code: "hrp-2026-300001", display_name: "Nguyen Van A",
    project_id: "proj_1", project_display: "Du an 1", first_work_date: "2026-10-01",
    labor_type: "TEMPORARY", employment_status: "ON", recruiter_id: RECRUITER,
    recruiter_display: "Tran Thi B", payment: null, pending_request: null,
    last_decision: null, is_project_manager: false, allowed_actions: actions(),
    ...overrides,
  };
}
function page(items) {
  return { ok: true, items, scope: "recruited", page_size: 25, has_more: false,
    next_cursor: null, authorization_date: AUTH };
}

test("W06-R1: bon view khong tron quan he; scope=all chi khi server cho phep", () => {
  assert.deepEqual([...WORKER_OPERATIONS_TABS], ["uploader", "recruited", "managed", "all"]);
  assert.equal(WORKER_OPERATIONS_TAB_LABELS.uploader, "Tôi đã nhập");
  assert.equal(WORKER_OPERATIONS_TAB_LABELS.recruited, "Người tôi tuyển");
  assert.equal(WORKER_OPERATIONS_TAB_LABELS.managed, "Dự án tôi quản lý");
  assert.equal(WORKER_OPERATIONS_TAB_LABELS.all, "Toàn bộ NLĐ");
  assert.equal(tabScope("uploader"), null);
  assert.equal(tabScope("recruited"), "recruited");
  assert.equal(tabScope("managed"), "managed");
  assert.equal(tabScope("all"), "all");
  assert.equal(isWorkerOperationsTab("recruited"), true);
  // "all" chi duoc OFFER khi server projection xac nhan.
  assert.deepEqual([...visibleWorkerTabs(false)], ["uploader", "recruited", "managed"]);
  assert.deepEqual([...visibleWorkerTabs(true)], ["uploader", "recruited", "managed", "all"]);
});

test("W06-R1: review queue chi khi change_review + all scope", () => {
  assert.equal(canReviewChangeRequests(null), false);
  assert.equal(canReviewChangeRequests({ capabilities: [], scopes: [{ kind: "all" }] }), false,
    "all scope thieu capability => khong mo");
  assert.equal(canReviewChangeRequests({ capabilities: ["change_review"], scopes: [{ kind: "team" }] }), false);
  assert.equal(canReviewChangeRequests({ capabilities: ["change_review"], scopes: [{ kind: "all" }] }), true);
});

test("W06-R1: propose targets chi gom WORKER/PAYMENT/WORK_STATUS (khong DOCUMENT/CCCD)", () => {
  assert.deepEqual([...WORKER_PROPOSE_TARGETS], ["WORKER", "PAYMENT", "WORK_STATUS"]);
  for (const target of WORKER_PROPOSE_TARGETS) {
    const label = WORKER_PROPOSE_TARGET_LABELS[target];
    assert.ok(label.length > 0);
    assert.equal(/thanh toán|chi tiền|giao dịch|CCCD|tài liệu/i.test(label), false, label);
  }
  assert.equal(WORKER_PROPOSE_TARGET_LABELS.PAYMENT, "Thông tin tài khoản ngân hàng");
});

test("W06: CTA chi hien khi server tra propose_change=true; nguoc lai VANG MAT", () => {
  const pm = proposeCta(row({ is_project_manager: true,
    allowed_actions: actions({ propose_change: true, propose_change_code: null }) }));
  assert.equal(pm.show, true);
  assert.equal(pm.code, null);
  assert.equal(pm.message, null);

  const viewer = proposeCta(row());
  assert.equal(viewer.show, false, "khong co quyen => khong render CTA");
  assert.equal(viewer.code, "NOT_PROJECT_MANAGER");
  assert.match(viewer.message, /chỉ có thể xem/i);
  assert.equal(viewer.message.includes(REQUEST), false);
  assert.equal(viewer.message.includes(ENTRY), false);
});

test("W06: uploader/recruiter khong phai PM khong co CTA du co recruiter_id", () => {
  const uploader = row({ is_project_manager: false });
  assert.equal(proposeCta(uploader).show, false);
  const recruiter = row({ is_project_manager: false,
    allowed_actions: actions({ propose_change: false, propose_change_code: "NOT_PROJECT_MANAGER" }) });
  assert.equal(proposeCta(recruiter).show, false);
});

test("W06: copy tu choi sanitized, khong lo UUID/raw DB", () => {
  for (const code of ["NOT_PROJECT_MANAGER", "NOT_SUBMITTED", null, "SOMETHING_RAW"]) {
    const message = workerDenialMessage(code);
    assert.ok(message.length > 0);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/i.test(message), false, "khong lo UUID");
    assert.equal(/42501|P0002|SQLSTATE|postgres/i.test(message), false, "khong lo raw DB");
  }
  for (const status of [400, 401, 403, 500]) {
    const message = workerListErrorMessage(status);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/i.test(message), false);
  }
});

test("W06: pending/last decision doc tu server data", () => {
  assert.equal(pendingRequestLabel(row()), null);
  assert.match(pendingRequestLabel(row({ pending_request: { request_id: REQUEST, state: "PENDING", version: 2 } })),
    /chờ duyệt/i);
  assert.equal(lastDecisionLabel(row()), null);
  assert.match(lastDecisionLabel(row({ last_decision: { state: "APPROVED", decided_at: "2026-10-05T01:02:03.000000Z" } })),
    /Đã duyệt ngày 2026-10-05/);
  assert.match(lastDecisionLabel(row({ last_decision: { state: "REJECTED", decided_at: "2026-10-06T01:02:03.000000Z" } })),
    /Đã từ chối ngày 2026-10-06/);
});

test("W06: bank account copy dung nghiep vu, chi STK/ngan hang/chu tai khoan", () => {
  assert.equal(BANK_ACCOUNT_SECTION_LABEL, "Thông tin tài khoản ngân hàng");
  assert.equal(/thanh toán|chi tiền|giao dịch/i.test(BANK_ACCOUNT_SECTION_LABEL), false);
  assert.equal(bankAccountSummary(null), null);
  const summary = bankAccountSummary({ state: "provided", account_number: "****1234",
    bank_id: "VCB", account_holder_name: "NGUYEN VAN A", version: 2 });
  assert.deepEqual(summary, { state: "provided", accountNumber: "****1234",
    bankId: "VCB", accountHolder: "NGUYEN VAN A" });
  assert.equal(Object.keys(summary).includes("version"), false, "khong lo version ra UI");
});

test("W06: trang thai lam viec co nhan tieng Viet", () => {
  assert.equal(workerStatusLabel("ON"), "Đang làm");
  assert.equal(workerStatusLabel("OFF"), "Đã nghỉ");
  assert.equal(workerStatusLabel("UNCONFIRMED"), "Chưa xác nhận");
  assert.equal(workerStatusLabel(null), "Chưa có trạng thái");
});

test("W06: parse worker page fail-closed, khong nhan shape sai", () => {
  const parsed = parseWorkerPageResponse(page([row()]), { scope: "recruited", page_size: 25 });
  assert.equal(parsed.items.length, 1);
  assert.equal(parseWorkerPageResponse({ ok: false }, { scope: "recruited", page_size: 25 }), null);
  assert.equal(parseWorkerPageResponse(page([]), { scope: "managed", page_size: 25 }), null,
    "scope lech => null");
  assert.equal(parseWorkerPageResponse(page([{}]), { scope: "recruited", page_size: 25 }), null);
});

test("W06: parse submission page fail-closed", () => {
  const item = { submission_id: REQUEST, state: "DRAFT", version: 2, entry_count: 1,
    created_at: "2026-10-01T00:00:00.000000Z", updated_at: "2026-10-02T00:00:00.000000Z",
    submitted_at: null, allowed_transitions: ["REVIEW"],
    project_scoped: false };
  const parsed = parseSubmissionPageResponse({ ok: true, items: [item], page_size: 25,
    has_more: false, next_cursor: null }, { page_size: 25 });
  assert.equal(parsed.items.length, 1);
  assert.equal(parseSubmissionPageResponse({ ok: true, items: [{}], page_size: 25,
    has_more: false, next_cursor: null }, { page_size: 25 }), null);
});
