import assert from "node:assert/strict";
import test from "node:test";

import {
  BANK_ACCOUNT_SECTION_LABEL,
  DIRECT_EDIT_DOCUMENT_MAX_BYTES,
  DIRECT_EDIT_DOCUMENT_TYPES,
  WORKER_OPERATIONS_TABS,
  WORKER_OPERATIONS_TAB_LABELS,
  WORKER_PROPOSE_TARGETS,
  WORKER_PROPOSE_TARGET_LABELS,
  appendUnique,
  applyPage,
  bankAccountSummary,
  beginLoad,
  canReviewChangeRequests,
  canViewGlobalChangeRequestHistory,
  checkDirectEditDocumentFile,
  directEditDocumentErrorMessage,
  emptyTabPage,
  failLoad,
  initialWorkerTab,
  isWorkerOperationsTab,
  parseChangeRequestPageResponse,
  requestRowKey,
  requestsQuery,
  resetTabPage,
  runDirectEditDocumentUploads,
  submissionRowKey,
  submissionsQuery,
  uploadDirectEditDocument,
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
  VIETQR_BANK_CATALOG,
  buildDirectEditEntryFieldProposal,
  buildDirectEditPaymentPatch,
  buildDirectEditWorkerDetailsProposal,
  directEditWorkerFormFromBaseline,
  formatBankReferenceDisplay,
  initialDirectEditBankQueryText,
  mergeVietQrBankCatalog,
  resolveBankCatalogOption,
  toDirectEditDateInputValue,
} from "./worker-operations-model.ts";

const AUTH = "2026-10-08";
const ENTRY = "11111111-1111-4111-8111-111111111111";
const RECRUITER = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";

function actions(overrides = {}) {
  return { view: true, view_pii: true, view_payment: true,
    propose_change: false, propose_change_code: "NOT_PROJECT_MANAGER", direct_edit: false, ...overrides };
}
function row(overrides = {}) {
  return {
    entry_id: ENTRY, entry_version: 3, submission_state: "SUBMITTED",
    employee_code: "hrp-2026-300001", display_name: "Nguyen Van A",
    project_id: "proj_1", project_display: "Du an 1", first_work_date: "2026-10-01",
    labor_type: "TEMPORARY", labor_type_display: "Thời vụ",
    employment_status: "ON", recruiter_id: RECRUITER,
    recruiter_display: "Tran Thi B", payment: null, pending_request: null,
    last_decision: null, is_project_manager: false, allowed_actions: actions(),
    ...overrides,
  };
}
function page(items) {
  return { ok: true, items, scope: "recruited", page_size: 25, has_more: false,
    next_cursor: null, authorization_date: AUTH,
    summary: { total_workers: items.length, project_count: 1, recruiter_count: 1 } };
}

test("W06-R1: bon view khong tron quan he; scope=all chi khi server cho phep", () => {
  assert.deepEqual([...WORKER_OPERATIONS_TABS], ["uploader", "recruited", "managed", "team", "all"]);
  assert.equal(WORKER_OPERATIONS_TAB_LABELS.uploader, "Tôi đã nhập");
  assert.equal(WORKER_OPERATIONS_TAB_LABELS.recruited, "Người tôi tuyển");
  assert.equal(WORKER_OPERATIONS_TAB_LABELS.managed, "Dự án tôi quản lý");
  assert.equal(WORKER_OPERATIONS_TAB_LABELS.team, "Team tôi quản lý");
  assert.equal(WORKER_OPERATIONS_TAB_LABELS.all, "Toàn bộ NLĐ");
  assert.equal(tabScope("uploader"), null);
  assert.equal(tabScope("recruited"), "recruited");
  assert.equal(tabScope("managed"), "managed");
  assert.equal(tabScope("team"), "team");
  assert.equal(tabScope("all"), "all");
  assert.equal(isWorkerOperationsTab("recruited"), true);
  // "all" chi duoc OFFER khi server projection xac nhan.
  assert.deepEqual([...visibleWorkerTabs(false)], ["uploader", "recruited", "managed"]);
  assert.deepEqual([...visibleWorkerTabs(true)], ["uploader", "recruited", "managed", "all"]);
  assert.deepEqual([...visibleWorkerTabs(false, true)], ["uploader", "recruited", "managed", "team"]);
  assert.deepEqual([...visibleWorkerTabs(true, true)], ["uploader", "recruited", "managed", "team", "all"]);
});

test("W06-R1: review queue chi khi change_review + all scope", () => {
  assert.equal(canReviewChangeRequests(null), false);
  assert.equal(canReviewChangeRequests({ capabilities: [], scopes: [{ kind: "all" }] }), false,
    "all scope thieu capability => khong mo");
  assert.equal(canReviewChangeRequests({ capabilities: ["change_review"], scopes: [{ kind: "team" }] }), false);
  assert.equal(canReviewChangeRequests({ capabilities: ["change_review"], scopes: [{ kind: "all" }] }), true);
});

test("PRE-W2 global change history is limited to global reviewers and admins", () => {
  assert.equal(canViewGlobalChangeRequestHistory(null), false);
  assert.equal(canViewGlobalChangeRequestHistory(["change_review"], [{ kind: "team" }]), false);
  assert.equal(canViewGlobalChangeRequestHistory(["team_manager_assign"], [{ kind: "all" }]), false);
  assert.equal(canViewGlobalChangeRequestHistory(["change_review"], [{ kind: "all" }]), true);
  assert.equal(canViewGlobalChangeRequestHistory(["entry_admin"], [{ kind: "all" }]), true);
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
  assert.equal(initialWorkerTab({ capabilities: ["change_review"], scopes: all }, true), "all");
  assert.equal(initialWorkerTab({ capabilities: ["entry_admin"], scopes: all }, true), "all");
  // PM-only (change_request_create, khong phai entry actor) => "managed".
  assert.equal(initialWorkerTab({ capabilities: ["change_request_create"], scopes: [{ kind: "own" }] }, false), "managed");
  assert.equal(initialWorkerTab({ capabilities: ["team_manager_assign"], scopes: [{ kind: "team" }] }, false, true), "team");
  assert.equal(initialWorkerTab({ capabilities: ["team_manager_assign"], scopes: [{ kind: "team" }] }, false), "uploader",
    "client-side capabilities/scope alone do not enable the team audience tab");
  // entry_* thong thuong => "uploader".
  assert.equal(initialWorkerTab({ capabilities: ["entry_own"], scopes: [{ kind: "own" }] }, false), "uploader");
  assert.equal(initialWorkerTab({ capabilities: ["entry_team"], scopes: [{ kind: "team" }] }, false), "uploader");
  // Reviewer nhung server KHONG cho scope=all => khong duoc vao "all".
  assert.equal(initialWorkerTab({ capabilities: ["change_review"], scopes: all }, false), "uploader");
  assert.equal(initialWorkerTab(null, true), "uploader");
});

test("W06-R2: append page dedupe theo stable id, khong trung/khong sot", () => {
  const page1 = { items: [row(), row({ entry_id: "22222222-2222-4222-8222-222222222222" })],
    next_cursor: "2026-10-08T12:00:00.000000Z|11111111-1111-4111-8111-111111111111", has_more: true };
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
    next_cursor: "2026-10-08T12:00:00.000000Z|11111111-1111-4111-8111-111111111111", has_more: true },
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
  assert.equal(workersQuery({ scope: "managed", search: "  Nguyễn  ", status: "ON",
    projectId: "proj_a", recruiterId: RECRUITER, cursor: null }),
  "?scope=managed&page_size=25&employment_status=ON&search=Nguy%E1%BB%85n&project_id=proj_a&recruiter_id=" +
    RECRUITER);
  assert.equal(submissionsQuery(null), "?page_size=25");
  assert.equal(submissionsQuery("c2"), "?page_size=25&cursor=c2");
  assert.equal(requestsQuery(null), "?page_size=20&state=PENDING");
  assert.equal(requestsQuery("c3"), "?page_size=20&state=PENDING&cursor=c3");
  assert.equal(requestsQuery(null, "RESOLVED"), "?page_size=20&state=RESOLVED");
  assert.equal(workersQuery({ scope: "managed", status: "", cursor: null }).includes("cursor"), false);
});

test("HF-R4: project and recruiter filters stay server-side and reset the page cursor", () => {
  const loaded = applyPage(emptyTabPage(), {
    items: [row()], next_cursor: "2026-10-08T12:00:00.000000Z|11111111-1111-4111-8111-111111111111",
    has_more: true,
  }, workerRowKey, false);
  const changed = updateWorkerDirectoryFilter({
    page: loaded,
    filters: { search: "000021", status: "ON", projectId: "old-project", recruiterId: RECRUITER },
    field: "projectId",
    value: "new-project",
  });
  assert.deepEqual(changed.filters, {
    search: "000021", status: "ON", projectId: "new-project", recruiterId: RECRUITER,
  });
  assert.deepEqual(changed.page, {
    items: [], cursor: null, hasMore: false, state: "loading", message: null,
  });
  assert.equal(workersQuery({ scope: "managed", ...changed.filters,
    cursor: "next:cursor" }),
  "?scope=managed&page_size=25&employment_status=ON&search=000021&project_id=new-project&recruiter_id=" +
    RECRUITER + "&cursor=next%3Acursor");

  const searchChanged = updateWorkerDirectoryFilter({
    page: loaded,
    filters: changed.filters,
    field: "search",
    value: "Nguyễn",
  });
  assert.equal(searchChanged.filters.search, "Nguyễn");
  assert.equal(searchChanged.page.cursor, null, "search change resets the pagination cursor");
  assert.deepEqual(searchChanged.page.items, []);
});

test("W06-R2: review payload phai qua projectChangeRequestListPage, fail-closed", () => {
  const valid = { ok: true, requests: [{
    request_id: REQUEST, state: "PENDING", version: 2,
    created_at: "2026-10-01T00:00:00.000000Z", item_count: 1, entry_ids: [ENTRY],
    can_withdraw: false, can_decide: true,
    proposer_display_name: "Admin", summary: "Trạng thái làm việc" }],
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
    has_more: true, next_cursor: null, authorization_date: AUTH,
    summary: { total_workers: 0, project_count: 0, recruiter_count: 0 } },
    { scope: "all", page_size: 25 }), null, "has_more phai co cursor");
  assert.equal(parseWorkerPageResponse({ ok: true, items: [], scope: "all", page_size: 25,
    has_more: false, next_cursor: null, summary: { total_workers: 0, project_count: 0,
      recruiter_count: 0 } }, { scope: "all", page_size: 25 }), null,
    "thieu authorization_date");
  assert.equal(parseWorkerPageResponse({ ok: true, items: [], scope: "all", page_size: 25,
    has_more: false, next_cursor: null, authorization_date: AUTH },
  { scope: "all", page_size: 25 }), null, "missing summary fails closed");
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
  assert.equal(workerStatusLabel("UNCONFIRMED"), "Đang chờ việc");
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
    submitted_at: null, allowed_transitions: ["SUBMITTED"],
    project_scoped: false };
  const parsed = parseSubmissionPageResponse({ ok: true, items: [item], page_size: 25,
    has_more: false, next_cursor: null }, { page_size: 25 });
  assert.equal(parsed.items.length, 1);
  assert.equal(parseSubmissionPageResponse({ ok: true, items: [{}], page_size: 25,
    has_more: false, next_cursor: null }, { page_size: 25 }), null);
});

test("HF Worker Profile: checkDirectEditDocumentFile validates MIME and size per document type", () => {
  assert.deepEqual(DIRECT_EDIT_DOCUMENT_TYPES, [
    "WORKER_PORTRAIT",
    "CCCD_FRONT",
    "CCCD_BACK",
    "EMPLOYMENT_CONTRACT",
  ]);
  assert.deepEqual(checkDirectEditDocumentFile("WORKER_PORTRAIT", null), {
    ok: false,
    code: "DOCUMENT_FILE_REQUIRED",
  });
  assert.deepEqual(
    checkDirectEditDocumentFile("WORKER_PORTRAIT", { size: 0, type: "image/jpeg" }),
    { ok: false, code: "DOCUMENT_SIZE_INVALID" },
  );
  assert.deepEqual(
    checkDirectEditDocumentFile("WORKER_PORTRAIT", {
      size: DIRECT_EDIT_DOCUMENT_MAX_BYTES + 1,
      type: "image/jpeg",
    }),
    { ok: false, code: "DOCUMENT_SIZE_INVALID" },
  );
  assert.deepEqual(
    checkDirectEditDocumentFile("WORKER_PORTRAIT", { size: 1024, type: "application/pdf" }),
    { ok: false, code: "DOCUMENT_MIME_INVALID" },
  );
  assert.deepEqual(
    checkDirectEditDocumentFile("WORKER_PORTRAIT", { size: 1024, type: "image/png" }),
    { ok: true, mimeType: "image/png", sizeBytes: 1024 },
  );
  assert.deepEqual(
    checkDirectEditDocumentFile("CCCD_FRONT", { size: 2048, type: "application/pdf" }),
    { ok: true, mimeType: "application/pdf", sizeBytes: 2048 },
  );
  assert.deepEqual(
    checkDirectEditDocumentFile("EMPLOYMENT_CONTRACT", {
      size: DIRECT_EDIT_DOCUMENT_MAX_BYTES,
      type: "application/pdf",
    }),
    {
      ok: true,
      mimeType: "application/pdf",
      sizeBytes: DIRECT_EDIT_DOCUMENT_MAX_BYTES,
    },
  );
  assert.match(
    directEditDocumentErrorMessage("CCCD_BACK", "DOCUMENT_MIME_INVALID"),
    /CCCD mặt sau/,
  );
});

test("HF Worker Profile: runDirectEditDocumentUploads chains entry_version and isolates per-file errors", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
    if (String(url).endsWith("/documents") && init?.method === "POST") {
      const parsed = JSON.parse(String(init.body));
      if (parsed.document_type === "WORKER_PORTRAIT") {
        assert.equal(parsed.expected_entry_version, 4);
        return new Response(
          JSON.stringify({
            ok: true,
            document_id: "doc-portrait-1",
            version: 1,
            entry_version: 5,
            upload: {
              method: "PUT",
              url: "https://storage.example.test/put/portrait",
              headers: { "Content-Type": "image/jpeg" },
            },
          }),
          { status: 200 },
        );
      }
      if (parsed.document_type === "CCCD_FRONT") {
        // Must receive entry_version 5 from the succeeded portrait upload!
        assert.equal(parsed.expected_entry_version, 5);
        return new Response(
          JSON.stringify({
            ok: true,
            document_id: "doc-cccd-1",
            version: 2,
            entry_version: 6,
            upload: {
              method: "PUT",
              url: "https://storage.example.test/put/cccd-fail",
              headers: { "Content-Type": "image/png" },
            },
          }),
          { status: 200 },
        );
      }
      if (parsed.document_type === "EMPLOYMENT_CONTRACT") {
        // Even after CCCD_FRONT PUT failed, entry_version had advanced to 6 on reserve!
        assert.equal(parsed.expected_entry_version, 6);
        return new Response(
          JSON.stringify({
            ok: true,
            document_id: "doc-contract-1",
            version: 1,
            entry_version: 7,
            upload: {
              method: "PUT",
              url: "https://storage.example.test/put/contract",
              headers: { "Content-Type": "application/pdf" },
            },
          }),
          { status: 200 },
        );
      }
    }
    if (init?.method === "PUT") {
      if (String(url).includes("cccd-fail")) {
        return new Response("Storage error", { status: 503 });
      }
      return new Response("", { status: 200 });
    }
    if (String(url).endsWith("/finalize")) {
      const parsed = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          ok: true,
          entry_version: parsed.expected_entry_version,
        }),
        { status: 200 },
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const portraitFile = new File([new Uint8Array([1, 2, 3])], "portrait.jpg", { type: "image/jpeg" });
  const cccdFile = new File([new Uint8Array([4, 5, 6])], "cccd.png", { type: "image/png" });
  const contractFile = new File([new Uint8Array([7, 8, 9])], "contract.pdf", { type: "application/pdf" });

  const result = await runDirectEditDocumentUploads({
    entryId: ENTRY,
    initialEntryVersion: 4,
    items: [
      { docType: "WORKER_PORTRAIT", file: portraitFile },
      { docType: "CCCD_FRONT", file: cccdFile },
      { docType: "EMPLOYMENT_CONTRACT", file: contractFile },
    ],
    reason: "Bo sung ho so",
    fetchImpl: fakeFetch,
  });

  assert.equal(result.entryVersion, 7);
  assert.equal(result.allSucceeded, false);
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0]?.ok, true);
  assert.equal(result.results[1]?.ok, false);
  assert.equal(result.results[1]?.code, "DOCUMENT_STORAGE_UNAVAILABLE");
  assert.equal(result.results[2]?.ok, true);

  // Retrying only the failed CCCD_FRONT file starts from result.entryVersion (7)
  const retryOutcome = await uploadDirectEditDocument({
    entryId: ENTRY,
    expectedEntryVersion: result.entryVersion,
    docType: "CCCD_FRONT",
    file: cccdFile,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/documents") && init?.method === "POST") {
        const parsed = JSON.parse(String(init.body));
        assert.equal(parsed.expected_entry_version, 7);
        return new Response(
          JSON.stringify({
            ok: true,
            document_id: "doc-cccd-2",
            version: 3,
            entry_version: 8,
            upload: {
              method: "PUT",
              url: "https://storage.example.test/put/cccd-ok",
              headers: { "Content-Type": "image/png" },
            },
          }),
          { status: 200 },
        );
      }
      if (init?.method === "PUT") return new Response("", { status: 200 });
      if (String(url).endsWith("/finalize")) {
        return new Response(JSON.stringify({ ok: true, entry_version: 8 }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  assert.equal(retryOutcome.ok, true);
  assert.equal(retryOutcome.entryVersion, 8);
  assert.equal(retryOutcome.documentVersion, 3);
});

test("HF Edit Values: personal fields preserve untouched empty state and transition cleared provided values to intentionally_blank", () => {
  const baselineDetails = {
    display_name: "Nguyễn Văn A",
    gender: { state: "omitted" },
    date_of_birth: { state: "unknown" },
    national_id: { state: "provided", value: "079095000123" },
    national_id_issued_at: { state: "provided", value: "15/06/2021" },
    // national_id_issued_place is undefined on baselineDetails
    address: { state: "intentionally_blank" },
    phone: { state: "provided", value: "0901234567" },
  };
  const baselineEntry = {
    project_id: "proj-1",
    first_work_date: "2026-03-01",
    employee_code: "hrp-2026-000001",
    recruiter_id: RECRUITER,
    labor_type: "TEMPORARY",
    worker_details: baselineDetails,
  };

  const entryForm = directEditWorkerFormFromBaseline(baselineEntry);
  const form = entryForm.workerDetails;
  assert.equal(form.display_name, "Nguyễn Văn A");
  assert.equal(form.gender.text, "");
  assert.equal(form.date_of_birth.text, "");
  assert.equal(form.national_id.text, "079095000123");
  assert.equal(
    form.national_id_issued_at.text,
    "2021-06-15",
    "DD/MM/YYYY baseline date is normalized to YYYY-MM-DD for native <input type='date'>",
  );
  assert.equal(form.national_id_issued_place.text, "");
  assert.equal(form.address.text, "");
  assert.equal(form.phone.text, "0901234567");
  assert.equal(toDirectEditDateInputValue("2021-06-15"), "2021-06-15");
  assert.equal(toDirectEditDateInputValue("15/06/2021"), "2021-06-15");

  // 1. Untouched form produces WORKER_UNCHANGED and preserves exact baseline states (including DD/MM/YYYY raw value and undefined national_id_issued_place)
  const unchangedBuilt = buildDirectEditWorkerDetailsProposal(baselineDetails, form);
  assert.deepEqual(unchangedBuilt, { ok: false, code: "WORKER_UNCHANGED" });

  // 2. Updating only display_name keeps omitted/unknown/intentionally_blank/undefined fields in their exact baseline states
  const renamedBuilt = buildDirectEditWorkerDetailsProposal(baselineDetails, {
    ...form,
    display_name: "Nguyễn Văn A Mới",
  });
  assert.equal(renamedBuilt.ok, true);
  if (renamedBuilt.ok) {
    assert.deepEqual(renamedBuilt.proposal, {
      worker_details: {
        display_name: "Nguyễn Văn A Mới",
        gender: { state: "omitted" },
        date_of_birth: { state: "unknown" },
        national_id: { state: "provided", value: "079095000123" },
        national_id_issued_at: { state: "provided", value: "15/06/2021" },
        address: { state: "intentionally_blank" },
        phone: { state: "provided", value: "0901234567" },
      },
    });
    assert.equal("national_id_issued_place" in renamedBuilt.proposal.worker_details, false);
  }

  // 3. Clearing existing provided fields (including gender, national_id, national_id_issued_at, phone) transitions them to intentionally_blank
  const baselineWithGender = {
    ...baselineDetails,
    gender: { state: "provided", value: "MALE" },
  };
  const entryFormWithGender = directEditWorkerFormFromBaseline({
    ...baselineEntry,
    worker_details: baselineWithGender,
  });
  assert.equal(entryFormWithGender.workerDetails.gender.text, "MALE");

  const clearedBuilt = buildDirectEditEntryFieldProposal({
    baseline: {
      ...baselineEntry,
      worker_details: baselineWithGender,
    },
    form: {
      ...entryFormWithGender,
      workerDetails: {
        ...entryFormWithGender.workerDetails,
        gender: { state: "provided", text: "" },
        national_id: { state: "provided", text: "   " },
        national_id_issued_at: { state: "provided", text: "" },
        phone: { state: "provided", text: "" },
        date_of_birth: { state: "provided", text: "1995-08-20" },
        address: { state: "provided", text: "Quận 7, TP.HCM" },
      },
    },
  });
  assert.equal(clearedBuilt.ok, true);
  if (clearedBuilt.ok) {
    assert.deepEqual(clearedBuilt.proposal, {
      worker_details: {
        display_name: "Nguyễn Văn A",
        gender: { state: "intentionally_blank" },
        date_of_birth: { state: "provided", value: "1995-08-20" },
        national_id: { state: "intentionally_blank" },
        national_id_issued_at: { state: "intentionally_blank" },
        address: { state: "provided", value: "Quận 7, TP.HCM" },
        phone: { state: "intentionally_blank" },
      },
    });
  }
});

test("HF Edit Values: VietQR bank catalog merges existing bank_ids and resolves code/short_name/bank_name to a single bank", () => {
  assert.ok(VIETQR_BANK_CATALOG.length >= 60, "VietQR catalog includes full list of Vietnamese banks");

  const existingCatalog = [
    { bank_id: "VCB", display_name: "Vietcombank" },
    { bank_id: "BANK_CUSTOM_TCB", display_name: "Techcombank" },
  ];
  const merged = mergeVietQrBankCatalog(existingCatalog);

  // Existing bank_id is preserved when short_name/code matches
  const byCode = resolveBankCatalogOption(merged, "TCB");
  const byShortName = resolveBankCatalogOption(merged, "Techcombank");
  const byOfficialName = resolveBankCatalogOption(
    merged,
    "Ngân hàng TMCP Kỹ thương Việt Nam",
  );
  assert.ok(byCode);
  assert.equal(byCode.bank_id, "BANK_CUSTOM_TCB");
  assert.equal(byShortName?.bank_id, byCode.bank_id);
  assert.equal(byOfficialName?.bank_id, byCode.bank_id);

  // Only one entry exists for Techcombank in merged list
  const tcbMatches = merged.filter((item) => item.bank_code === "TCB");
  assert.equal(tcbMatches.length, 1);

  // Standard VietQR banks not in existingCatalog get stable canonical bank_id
  const mbByCode = resolveBankCatalogOption(merged, "MB");
  const mbByShort = resolveBankCatalogOption(merged, "MBBank");
  const mbByOfficial = resolveBankCatalogOption(merged, "Ngân hàng TMCP Quân đội");
  assert.ok(mbByCode);
  assert.equal(mbByCode.bank_id, "MB");
  assert.equal(mbByShort?.bank_id, "MB");
  assert.equal(mbByOfficial?.bank_id, "MB");

  assert.equal(
    formatBankReferenceDisplay("TCB", null, existingCatalog),
    "Techcombank",
  );
  assert.equal(
    formatBankReferenceDisplay(null, "Ngân hàng Hợp tác xã XYZ", existingCatalog),
    "Ngân hàng Hợp tác xã XYZ",
  );
});

test("HF Edit Values: buildDirectEditPaymentPatch preserves untouched empty state, clears provided to intentionally_blank, and supports custom reference bank_name", () => {
  const catalogBanks = [{ bank_id: "VCB", display_name: "Vietcombank" }];

  // 1. Untouched empty states (null, omitted, unknown, intentionally_blank) remain unchanged
  for (const emptyBaseline of [
    null,
    { state: "omitted", account_number: null, bank_id: null, bank_name: null, account_holder_name: null },
    { state: "unknown", account_number: null, bank_id: null, bank_name: null, account_holder_name: null },
    { state: "intentionally_blank", account_number: null, bank_id: null, bank_name: null, account_holder_name: null },
  ]) {
    assert.deepEqual(
      buildDirectEditPaymentPatch({
        baseline: emptyBaseline,
        accountNumber: "",
        bankId: "",
        bankQueryText: "",
        accountHolderName: "",
        catalogBanks,
      }),
      { kind: "unchanged" },
    );
  }

  // 2. Clearing an existing provided bank record transitions to intentionally_blank
  const providedBaseline = {
    state: "provided",
    account_number: "19038889990001",
    bank_id: "TCB",
    bank_name: "Techcombank",
    account_holder_name: "NGUYEN VAN A",
  };
  assert.equal(initialDirectEditBankQueryText(providedBaseline, catalogBanks), "Techcombank");
  assert.deepEqual(
    buildDirectEditPaymentPatch({
      baseline: providedBaseline,
      accountNumber: "  ",
      bankId: "",
      bankQueryText: "  ",
      accountHolderName: "",
      catalogBanks,
    }),
    {
      kind: "changed",
      proposal: {
        state: "intentionally_blank",
        account_number: null,
        bank_id: null,
        bank_name: null,
        account_holder_name: null,
      },
    },
  );

  // 3. Searching "TCB" or "Techcombank" resolves to the same bank_id ("TCB")
  const byCodePatch = buildDirectEditPaymentPatch({
    baseline: null,
    accountNumber: "19038889990001",
    bankId: "",
    bankQueryText: "TCB",
    accountHolderName: "NGUYEN VAN A",
    catalogBanks,
  });
  const byNamePatch = buildDirectEditPaymentPatch({
    baseline: null,
    accountNumber: "19038889990001",
    bankId: "",
    bankQueryText: "Techcombank",
    accountHolderName: "NGUYEN VAN A",
    catalogBanks,
  });
  assert.deepEqual(byCodePatch, {
    kind: "changed",
    proposal: {
      state: "provided",
      account_number: "19038889990001",
      bank_id: "TCB",
      bank_name: "Techcombank",
      account_holder_name: "NGUYEN VAN A",
    },
  });
  assert.deepEqual(byNamePatch, byCodePatch);

  // 4. Typing an unknown bank name not in catalog saves bank_id: null and bank_name as reference text
  const customBankPatch = buildDirectEditPaymentPatch({
    baseline: null,
    accountNumber: "123456789",
    bankId: "",
    bankQueryText: "Ngân hàng Nông thôn Xã A",
    accountHolderName: "NGUYEN VAN A",
    catalogBanks,
  });
  assert.deepEqual(customBankPatch, {
    kind: "changed",
    proposal: {
      state: "provided",
      account_number: "123456789",
      bank_id: null,
      bank_name: "Ngân hàng Nông thôn Xã A",
      account_holder_name: "NGUYEN VAN A",
    },
  });

  // 5. Account number + account holder without bank is valid (bank is for reference only)
  const noBankPatch = buildDirectEditPaymentPatch({
    baseline: null,
    accountNumber: "123456789",
    bankId: "",
    bankQueryText: "",
    accountHolderName: "NGUYEN VAN A",
    catalogBanks,
  });
  assert.deepEqual(noBankPatch, {
    kind: "changed",
    proposal: {
      state: "provided",
      account_number: "123456789",
      bank_id: null,
      bank_name: null,
      account_holder_name: "NGUYEN VAN A",
    },
  });
});
