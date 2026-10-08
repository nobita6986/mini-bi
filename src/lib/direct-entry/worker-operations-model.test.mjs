import assert from "node:assert/strict";
import test from "node:test";

import {
  BANK_ACCOUNT_SECTION_LABEL,
  WORKER_OPERATIONS_TABS,
  WORKER_OPERATIONS_TAB_LABELS,
  WORKER_PROPOSE_TARGETS,
  WORKER_PROPOSE_TARGET_LABELS,
  appendUnique,
  applyPage,
  bankAccountSummary,
  beginLoad,
  canDirectlyCorrectWorkers,
  canReviewChangeRequests,
  emptyTabPage,
  failLoad,
  initialWorkerTab,
  isWorkerOperationsTab,
  parseChangeRequestPageResponse,
  requestRowKey,
  requestsQuery,
  resetTabPage,
  submissionRowKey,
  submissionsQuery,
  workerRowKey,
  workersQuery,
  lastDecisionLabel,
  parseSubmissionPageResponse,
  parseWorkerPageResponse,
  pendingRequestLabel,
  proposeCta,
  relationDenialIsEmpty,
  tabScope,
  visibleWorkerTabs,
  workerDenialMessage,
  workerListErrorMessage,
  workerStatusLabel,
  WORKER_LOAD_FAILED_MESSAGE,
  updateWorkerDirectoryFilter,
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

test("HF-R4: direct correction visibility uses only privileged capability plus all scope", () => {
  assert.equal(canDirectlyCorrectWorkers({ capabilities: ["entry_admin"], scopes: [{ kind: "all" }] }), true);
  assert.equal(canDirectlyCorrectWorkers({
    capabilities: ["entry_privileged_edit"], scopes: [{ kind: "all" }],
  }), true);
  assert.equal(canDirectlyCorrectWorkers({
    capabilities: ["entry_privileged_edit"], scopes: [{ kind: "team" }],
  }), false);
  assert.equal(canDirectlyCorrectWorkers({
    capabilities: ["change_review"], scopes: [{ kind: "all" }], role: "admin",
  }), false);
  assert.equal(canDirectlyCorrectWorkers(null), false);
});

test("W06-R2: helper phan trang ton tai (0e2cbba khong co -> test that bai that su)", () => {
  // Cac ham nay duoc them o R2; o 0e2cbba khong ton tai nen assertion se fail.
  for (const fn of [initialWorkerTab, applyPage, beginLoad, failLoad, resetTabPage, emptyTabPage,
    appendUnique, workersQuery, submissionsQuery, requestsQuery, workerRowKey, submissionRowKey,
    requestRowKey, parseChangeRequestPageResponse]) {
    assert.equal(typeof fn, "function");
  }
});

test("W06-R2: initial tab tu actor projection — reviewer vao thang scope=all", () => {
  const all = [{ kind: "all" }];
  // Reviewer bundle toi thieu + all => "all" (khong roi vao uploader).
  assert.equal(initialWorkerTab({ capabilities: ["change_review", "pii_view", "payment_view"], scopes: all }, true), "all");
  assert.equal(initialWorkerTab({ capabilities: ["entry_admin"], scopes: all }, true), "all");
  // PM-only (change_request_create, khong phai entry actor) => "managed".
  assert.equal(initialWorkerTab({ capabilities: ["change_request_create"], scopes: [{ kind: "own" }] }, false), "managed");
  // entry_* thong thuong => "uploader".
  assert.equal(initialWorkerTab({ capabilities: ["entry_own"], scopes: [{ kind: "own" }] }, false), "uploader");
  assert.equal(initialWorkerTab({ capabilities: ["entry_team"], scopes: [{ kind: "team" }] }, false), "uploader");
  // Reviewer nhung server KHONG cho scope=all => khong duoc vao "all".
  assert.equal(initialWorkerTab({ capabilities: ["change_review"], scopes: all }, false), "uploader");
  assert.equal(initialWorkerTab(null, true), "uploader");
});

test("W06-R2: append page dedupe theo stable id, khong trung/khong sot", () => {
  const page1 = { items: [row(), row({ entry_id: "22222222-2222-4222-8222-222222222222" })],
    next_cursor: "20261008120000000000:11111111-1111-4111-8111-111111111111", has_more: true };
  const after1 = applyPage(emptyTabPage(), page1, workerRowKey, false);
  assert.equal(after1.items.length, 2);
  assert.equal(after1.hasMore, true);
  assert.equal(after1.cursor, page1.next_cursor);
  assert.equal(after1.state, "ready");
  // Page 2 lap lai row dau + them row moi => khong trung, khong sot.
  const page2 = { items: [row(), row({ entry_id: "33333333-3333-4333-8333-333333333333" })],
    next_cursor: null, has_more: false };
  const after2 = applyPage(after1, page2, workerRowKey, true);
  assert.equal(after2.items.length, 3);
  assert.deepEqual(after2.items.map(workerRowKey), [
    row().entry_id, "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333"]);
  assert.equal(after2.hasMore, false);
  assert.equal(after2.cursor, null);
  // Khong append => thay the hoan toan.
  const replaced = applyPage(after2, page2, workerRowKey, false);
  assert.equal(replaced.items.length, 2);
});

test("W06-R2: doi tab/filter reset cursor; beginLoad(append) giu items", () => {
  const loaded = applyPage(emptyTabPage(), { items: [row()],
    next_cursor: "20261008120000000000:11111111-1111-4111-8111-111111111111", has_more: true },
    workerRowKey, false);
  const reset = resetTabPage();
  assert.deepEqual(reset.items, []);
  assert.equal(reset.cursor, null);
  assert.equal(reset.hasMore, false);
  assert.equal(reset.state, "loading");
  assert.equal(beginLoad(loaded, true).items.length, 1, "tai them giu items");
  assert.equal(beginLoad(loaded, true).cursor, loaded.cursor);
  assert.equal(beginLoad(loaded, false).items.length, 0, "tai lai xoa items");
  assert.equal(beginLoad(loaded, false).cursor, null);
});

test("W06-R2: loi khi tai KHONG xoa page da tai thanh cong", () => {
  const loaded = applyPage(emptyTabPage(), { items: [row()], next_cursor: null, has_more: false },
    workerRowKey, false);
  const failed = failLoad(loaded, "error", "loi tam thoi");
  assert.equal(failed.items.length, 1, "giu du lieu da tai");
  assert.equal(failed.state, "ready");
  assert.equal(failed.message, "loi tam thoi");
  // Page rong thi giu trang thai loi.
  const emptyFailed = failLoad(emptyTabPage(), "denied", "khong co quyen");
  assert.equal(emptyFailed.state, "denied");
  assert.equal(emptyFailed.items.length, 0);
});

test("W06-R2: query builder chi gui cursor khi co (khong mang cursor scope cu)", () => {
  assert.equal(workersQuery({ scope: "recruited", status: "", cursor: null }),
    "?scope=recruited&page_size=25");
  assert.equal(workersQuery({ scope: "all", status: "ON", cursor: "c1" }),
    "?scope=all&page_size=25&employment_status=ON&cursor=c1");
  assert.equal(submissionsQuery(null), "?page_size=25");
  assert.equal(submissionsQuery("c2"), "?page_size=25&cursor=c2");
  assert.equal(requestsQuery(null), "?page_size=20");
  assert.equal(requestsQuery("c3"), "?page_size=20&cursor=c3");
  assert.equal(workersQuery({ scope: "managed", status: "", cursor: null }).includes("cursor"), false);
});

test("HF-R4: project and recruiter filters stay server-side and reset the page cursor", () => {
  const loaded = applyPage(emptyTabPage(), {
    items: [row()], next_cursor: "20261008120000000000:11111111-1111-4111-8111-111111111111",
    has_more: true,
  }, workerRowKey, false);
  const changed = updateWorkerDirectoryFilter({
    page: loaded,
    filters: { status: "ON", projectId: "old-project", recruiterId: RECRUITER },
    field: "projectId",
    value: "new-project",
  });
  assert.deepEqual(changed.filters, {
    status: "ON", projectId: "new-project", recruiterId: RECRUITER,
  });
  assert.deepEqual(changed.page, {
    items: [], cursor: null, hasMore: false, state: "loading", message: null,
  });
  assert.equal(workersQuery({ scope: "managed", ...changed.filters,
    cursor: "next:cursor" }),
  "?scope=managed&page_size=25&employment_status=ON&project_id=new-project&recruiter_id=" +
    RECRUITER + "&cursor=next%3Acursor");
});

test("W06-R2: review payload phai qua projectChangeRequestListPage, fail-closed", () => {
  const valid = { ok: true, requests: [{
    request_id: REQUEST, state: "PENDING", version: 2,
    created_at: "2026-10-01T00:00:00.000000Z", item_count: 1, entry_ids: [ENTRY],
    can_withdraw: false, can_decide: true }],
    page_size: 20, has_more: false, next_cursor: null };
  const parsed = parseChangeRequestPageResponse(valid, { page_size: 20 });
  assert.equal(parsed.requests.length, 1);
  assert.equal(parsed.requests[0].can_decide, true);
  // Malformed envelope / item / cursor => null (khong cast raw).
  assert.equal(parseChangeRequestPageResponse({ ok: false }, { page_size: 20 }), null);
  assert.equal(parseChangeRequestPageResponse({ ok: true, requests: [{}], page_size: 20,
    has_more: false, next_cursor: null }, { page_size: 20 }), null);
  assert.equal(parseChangeRequestPageResponse({ ok: true, requests: [], page_size: 20,
    has_more: true, next_cursor: null }, { page_size: 20 }), null, "has_more phai co cursor");
  assert.equal(parseChangeRequestPageResponse({ ok: true, requests: [], page_size: 20,
    has_more: false, next_cursor: "raw" }, { page_size: 20 }), null, "cursor sai dinh dang");
  assert.equal(parseChangeRequestPageResponse({ ok: true, requests: [], page_size: 20,
    has_more: false }, { page_size: 20 }), null, "thieu next_cursor");
});

test("W06-R2: malformed worker/submission envelope fail-closed", () => {
  assert.equal(parseWorkerPageResponse({ ok: true, items: [], scope: "all", page_size: 25,
    has_more: true, next_cursor: null, authorization_date: AUTH },
    { scope: "all", page_size: 25 }), null, "has_more phai co cursor");
  assert.equal(parseWorkerPageResponse({ ok: true, items: [], scope: "all", page_size: 25,
    has_more: false, next_cursor: null }, { scope: "all", page_size: 25 }), null,
    "thieu authorization_date");
  assert.equal(parseSubmissionPageResponse({ ok: true, items: [], page_size: 25,
    has_more: true, next_cursor: null }, { page_size: 25 }), null);
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

test("HF-R5A: moi loi tai du lieu deu co copy sanitized, khong bao gio im lang", () => {
  // Truoc R5A: 5xx/network tra message null => "Tai them" that bai khong hien gi.
  for (const status of [500, 502, 503, 504]) {
    assert.equal(workerListErrorMessage(status), WORKER_LOAD_FAILED_MESSAGE);
  }
  assert.ok(WORKER_LOAD_FAILED_MESSAGE.length > 0);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/i.test(WORKER_LOAD_FAILED_MESSAGE), false);
  // Tai them that bai: GIU rows da tai (state ready) nhung VAN phai co message cho UI bao.
  const loaded = applyPage(emptyTabPage(), {
    items: [{ id: "a" }], next_cursor: "n", has_more: true,
  }, (item) => item.id, false);
  assert.equal(loaded.state, "ready");
  const failed = failLoad(loaded, "unavailable", WORKER_LOAD_FAILED_MESSAGE);
  assert.equal(failed.state, "ready");
  assert.deepEqual(failed.items, [{ id: "a" }]);
  assert.equal(failed.message, WORKER_LOAD_FAILED_MESSAGE);
  // Trang dau that bai: khong co du lieu thi giu nguyen state loi, van co message.
  const emptyFailure = failLoad(emptyTabPage(), "unavailable", WORKER_LOAD_FAILED_MESSAGE);
  assert.equal(emptyFailure.state, "unavailable");
  assert.equal(emptyFailure.message, WORKER_LOAD_FAILED_MESSAGE);
});

test("W06-R3: audience ca nhan khong ton tai hien 0, scope all van fail-closed", () => {
  assert.equal(relationDenialIsEmpty("recruited", 403), true);
  assert.equal(relationDenialIsEmpty("managed", 403), true);
  assert.equal(relationDenialIsEmpty("all", 403), false);
  assert.equal(relationDenialIsEmpty("managed", 500), false);
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
