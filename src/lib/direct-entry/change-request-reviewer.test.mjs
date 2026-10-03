import assert from "node:assert/strict";
import test from "node:test";

import {
  PAYMENT_MASKED_MESSAGE,
  buildDecisionRequest,
  buildReviewerEntryRows,
  buildReviewerViewModel,
  catalogProjectLabel,
  catalogRecruiterLabel,
  decisionIntentSignature,
  isSupportedEntryFieldProposal,
  LABOR_TYPE_LABELS,
  reviewerErrorMessage,
  reviewDecisionMessage,
  reviewDecisionState,
  STALE_REVIEW_MESSAGE,
  UNSUPPORTED_REVIEW_MESSAGE,
  unsupportedReviewerViewModel,
} from "./change-request-reviewer.ts";
import { projectProposerEntry } from "./change-request-proposer.ts";
import {
  DOCUMENT_STAGING_MESSAGE,
  LEAVE_REASON_HIDDEN_MESSAGE,
  PRESENCE_ONLY_MESSAGE,
} from "./change-request-read-projection.ts";

const REQUEST_ID = "d1000000-0000-4000-8000-00000000000a";
const ENTRY_A = "c1000000-0000-4000-8000-00000000000a";
const ENTRY_B = "c1000000-0000-4000-8000-00000000000b";
const PROJECT_TEN = "s02c_project";
const PROJECT_MOI = "s02c_project_moi";
const RECRUITER_CU = "93000000-0000-4000-8000-0000000000c1";
const RECRUITER_MOI = "93000000-0000-4000-8000-0000000000c2";
const STAMP = "2026-03-10T03:00:00.000000Z";

function detailItem(overrides = {}) {
  return {
    entry_id: ENTRY_A,
    target_kind: "ENTRY_FIELD",
    expected_version: 2,
    proposal: { employee_code: "hrp-2026-600009" },
    ...overrides,
  };
}

function detail(overrides = {}) {
  return {
    request_id: REQUEST_ID,
    state: "PENDING",
    version: 1,
    created_at: STAMP,
    items: [detailItem()],
    can_withdraw: false,
    can_decide: true,
    ...overrides,
  };
}

function entryProjection(entryId, overrides = {}) {
  return projectProposerEntry({
    entry_id: entryId,
    version: 2,
    project_id: PROJECT_TEN,
    first_work_date: "2026-10-15",
    employee_code: "hrp-2026-600001",
    recruiter_id: RECRUITER_CU,
    labor_type: "TEMPORARY",
    ...overrides,
  });
}

function catalog(overrides = {}) {
  return {
    effective_date: "2026-10-15",
    projects: [
      { project_id: PROJECT_TEN, display_name: "Dự án Synthetic" },
      { project_id: PROJECT_MOI, display_name: "Dự án Mới" },
    ],
    recruiters: [
      { recruiter_id: RECRUITER_CU, display_name: "Synthetic recruiter", provider_type: "hrp",
        team_id: "94000000-0000-4000-8000-0000000000d1", team_display_name: "Team A" },
      { recruiter_id: RECRUITER_MOI, display_name: "Recruiter Mới", provider_type: "vendor",
        team_id: "94000000-0000-4000-8000-0000000000d2", team_display_name: "Team B" },
    ],
    banks: [],
    ...overrides,
  };
}

function formatWith(catalogByDate) {
  return (entry, field, value) => {
    const current = catalogByDate[entry.first_work_date];
    if (field === "project_id") return catalogProjectLabel(current, value);
    if (field === "recruiter_id") return catalogRecruiterLabel(current, value);
    if (field === "labor_type") return LABOR_TYPE_LABELS[value] ?? null;
    return value;
  };
}

function entriesOf(...entries) {
  return new Map(entries.filter(Boolean).map((entry) => [entry.entry_id, entry]));
}

function workerDetails(overrides = {}) {
  return {
    display_name: "Nguyen Van Synthetic",
    date_of_birth: { state: "unknown" },
    national_id: { state: "unknown" },
    address: { state: "unknown" },
    phone: { state: "unknown" },
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    workerDetails: null,
    workerPresenceOnly: false,
    payment: null,
    employmentStatus: { status: "UNCONFIRMED", effective_date: "2026-10-01" },
    ...overrides,
  };
}

function contextsOf(entryId, value) {
  return new Map([[entryId, value]]);
}

const CATALOGS = { "2026-10-15": catalog() };

function build(overrides = {}) {
  return buildReviewerViewModel({
    detail: detail(overrides.detail),
    entries: overrides.entries ?? entriesOf(entryProjection(ENTRY_A)),
    format: overrides.format ?? formatWith(overrides.catalogs ?? CATALOGS),
    contexts: overrides.contexts ?? new Map(),
    bankLabel: overrides.bankLabel ??
      ((bankId) => (bankId === "s02c_bank" ? "Ngân hàng Synthetic" : null)),
  });
}

test("chi PENDING + can_decide=true + can_withdraw=false moi duoc quyet dinh", () => {
  const reviewable = build();
  assert.equal(reviewable.kind, "reviewable");
  assert.equal(reviewable.items.length, 1);
  assert.equal(reviewable.items[0].rows.length, 1);
  assert.deepEqual(reviewable.items[0].rows[0], {
    field: "employee_code",
    label: "Mã người lao động",
    before: "hrp-2026-600001",
    after: "hrp-2026-600009",
  });

  for (const overrides of [
    { can_decide: false },
    { can_withdraw: true, can_decide: false },
    { can_decide: false, version: 4 },
  ]) {
    const model = build({ detail: overrides });
    assert.equal(model.kind, "unsupported");
    assert.equal(model.reason, "NOT_DECIDABLE");
  }
});

test("trang thai terminal khong co quyet dinh", () => {
  for (const state of ["APPROVED", "REJECTED", "WITHDRAWN"]) {
    const model = build({ detail: { state, can_decide: false } });
    assert.equal(model.kind, "terminal");
    assert.equal(model.state, state);
  }
});

test("de xuat chi gom 5 field non-PII, chi hien field thuc su thay doi", () => {
  const model = build({
    detail: {
      items: [detailItem({
        proposal: {
          employee_code: "hrp-2026-600009",
          project_id: PROJECT_MOI,
          recruiter_id: RECRUITER_MOI,
          labor_type: "PERMANENT",
          first_work_date: "2026-10-15",
        },
      })],
    },
  });
  assert.equal(model.kind, "reviewable");
  assert.deepEqual(model.items[0].rows.map((row) => row.field),
    ["employee_code", "project_id", "recruiter_id", "labor_type"]);
  assert.equal(model.items[0].rows.some((row) => row.field === "first_work_date"), false,
    "first_work_date khong doi nen khong hien");
  for (const row of model.items[0].rows) {
    assert.equal(typeof row.label, "string");
    assert.equal(typeof row.before, "string");
    assert.equal(typeof row.after, "string");
    assert.notEqual(row.before, row.after);
  }
});

test("catalog doi ID thanh nhan hien thi, khong hien UUID lam noi dung chinh", () => {
  const model = build({
    detail: { items: [detailItem({ proposal: { project_id: PROJECT_MOI,
      recruiter_id: RECRUITER_MOI } })] },
  });
  assert.equal(model.kind, "reviewable");
  const rows = model.items[0].rows;
  assert.deepEqual(rows.map((row) => [row.field, row.before, row.after]), [
    ["project_id", "Dự án Synthetic", "Dự án Mới"],
    ["recruiter_id", "Synthetic recruiter", "Recruiter Mới"],
  ]);
  assert.equal(JSON.stringify(rows).includes(PROJECT_MOI), false);
  assert.equal(JSON.stringify(rows).includes(RECRUITER_MOI), false);
});

test("catalog khong giai duoc thi fail-closed, khong co quyet dinh", () => {
  const model = build({
    detail: { items: [detailItem({ proposal: { project_id: "s02c_project_khong_co" } })] },
  });
  assert.equal(model.kind, "unsupported");
  assert.equal(model.reason, "CATALOG");
  const missing = build({
    catalogs: {},
    detail: { items: [detailItem({ proposal: { project_id: PROJECT_MOI } })] },
  });
  assert.equal(missing.kind, "unsupported");
  assert.equal(missing.reason, "CATALOG");
});

test("phien ban entry lech expected_version thi chi hien du lieu da thay doi", () => {
  const model = build({ entries: entriesOf(entryProjection(ENTRY_A, { version: 5 })) });
  assert.equal(model.kind, "stale");
  assert.equal(model.items.length, 1);
  assert.equal(model.items[0].rows.length, 1);
  assert.match(STALE_REVIEW_MESSAGE, /Dữ liệu đã thay đổi/);
  const noDiff = build({
    detail: { items: [detailItem({ proposal: { employee_code: "hrp-2026-600001" } })] },
  });
  assert.equal(noDiff.kind, "stale");
  assert.deepEqual(noDiff.items[0].rows, []);
});

test("request nhieu entry la all-or-nothing: mot item khong dat thi toan bo la generic", () => {
  const safe = entryProjection(ENTRY_A);
  const second = entryProjection(ENTRY_B);
  const good = build({
    detail: { items: [detailItem(), detailItem({ entry_id: ENTRY_B,
      proposal: { project_id: PROJECT_MOI } })] },
    entries: entriesOf(safe, second),
  });
  assert.equal(good.kind, "reviewable");
  assert.equal(good.items.length, 2);

  const mixed = build({
    detail: { items: [detailItem(), detailItem({ entry_id: ENTRY_B, target_kind: "PAYMENT",
      proposal: { state: "ACTIVE" } })] },
    entries: entriesOf(safe, second),
  });
  assert.equal(mixed.kind, "unsupported");
  assert.equal(mixed.reason, "PAYMENT");
  assert.equal("items" in mixed, false, "khong xu ly mot phan request nhieu entry");

  const unknownField = build({
    detail: { items: [detailItem({ proposal: { employee_code: "hrp-2026-600009",
      ghi_chu_noi_bo: "x" } })] },
  });
  assert.equal(unknownField.kind, "unsupported");
  assert.equal(unknownField.reason, "PROPOSAL");

  const missingEntry = build({ entries: entriesOf(entryProjection(ENTRY_B)) });
  assert.equal(missingEntry.kind, "unsupported");
  assert.equal(missingEntry.reason, "ENTRY");
});

test("de xuat khong ho tro khong bao gio lo noi dung", () => {
  assert.equal(isSupportedEntryFieldProposal({ employee_code: "x" }), true);
  assert.equal(isSupportedEntryFieldProposal({}, false), false);
  assert.equal(isSupportedEntryFieldProposal({ worker_details: { display_name: "x" } }), false);
  assert.equal(isSupportedEntryFieldProposal({ account_number: "123" }), false);
  assert.equal(isSupportedEntryFieldProposal({ employee_code: "x", checksum_sha256: "a" }), false);
  assert.equal(isSupportedEntryFieldProposal(null), false);
  const model = unsupportedReviewerViewModel(REQUEST_ID, "PROPOSAL");
  assert.equal(model.kind, "unsupported");
  assert.equal(JSON.stringify(model).includes("account_number"), false);
  assert.equal(UNSUPPORTED_REVIEW_MESSAGE,
    "Yêu cầu này cần phiên bản giao diện hoặc quyền xem khác.");
});

test("buildReviewerEntryRows tra null khi thieu du lieu de doi chieu", () => {
  const entry = entryProjection(ENTRY_A);
  const rows = buildReviewerEntryRows({
    item: detailItem({ proposal: { labor_type: "PERMANENT" } }),
    entry,
    format: formatWith(CATALOGS),
  });
  assert.deepEqual(rows, [{ field: "labor_type", label: "Loại hình lao động",
    before: "Thời vụ", after: "Toàn thời gian" }]);
  assert.equal(buildReviewerEntryRows({
    item: detailItem({ proposal: { project_id: "khong-co" } }),
    entry,
    format: formatWith(CATALOGS),
  }), null);
});

test("body quyet dinh dung 4 truong contract va ly do duoc kiem chat", () => {
  const approve = buildDecisionRequest({
    decision: "approve",
    expectedVersion: 1,
    reason: " Đã kiểm tra thông tin ",
    idempotencyKey: "key-1",
  });
  assert.deepEqual(Object.keys(approve).sort(),
    ["decision", "expected_version", "idempotency_key", "reason"]);
  assert.equal(approve.reason, " Đã kiểm tra thông tin ");
  const reject = buildDecisionRequest({
    decision: "reject",
    expectedVersion: 3,
    reason: "Thiếu căn cứ",
    idempotencyKey: "key-2",
  });
  assert.equal(reject.decision, "reject");
  assert.equal(reject.expected_version, 3);
  assert.equal(buildDecisionRequest({
    decision: "approve", expectedVersion: 1, reason: "   ", idempotencyKey: "key-3" }), null);
  assert.equal(buildDecisionRequest({
    decision: "approve", expectedVersion: 1, reason: "ok", idempotencyKey: " " }), null);
  assert.equal(buildDecisionRequest({
    decision: "approve", expectedVersion: 0, reason: "ok", idempotencyKey: "key-4" }), null);
  // Truong authority/la tren input KHONG BAO GIO duoc chuyen vao body gui di.
  const injected = buildDecisionRequest({
    decision: "approve", expectedVersion: 1, reason: "ok", idempotencyKey: "key-5",
    actor_id: "x" });
  assert.deepEqual(Object.keys(injected).sort(),
    ["decision", "expected_version", "idempotency_key", "reason"]);
  for (const key of ["actor", "role", "capability", "scope", "reviewer", "state", "actor_id"]) {
    const payload = buildDecisionRequest({
      decision: "approve", expectedVersion: 1, reason: "ok", idempotencyKey: "key-6",
      [key]: "x" });
    assert.equal(key in payload, false, key);
    assert.deepEqual(Object.keys(payload).sort(),
      ["decision", "expected_version", "idempotency_key", "reason"], key);
  }
});

test("cung quyet dinh + cung ly do dung lai key, doi quyet dinh hoac ly do thi key moi", () => {
  const base = decisionIntentSignature(REQUEST_ID, "approve", "Đã kiểm tra thông tin");
  assert.equal(decisionIntentSignature(REQUEST_ID, "approve", "Đã kiểm tra thông tin"), base);
  assert.notEqual(decisionIntentSignature(REQUEST_ID, "approve", "Đã kiểm tra lại"), base);
  assert.notEqual(decisionIntentSignature(REQUEST_ID, "reject", "Đã kiểm tra thông tin"), base);
  assert.notEqual(decisionIntentSignature(ENTRY_B, "approve", "Đã kiểm tra thông tin"), base);
  assert.match(base, /^change_request_decision:/);
});

test("trang thai ket qua va thong bao deu bam theo intent, khong lo ma ky thuat", () => {
  assert.equal(reviewDecisionState("approve"), "APPROVED");
  assert.equal(reviewDecisionState("reject"), "REJECTED");
  assert.match(reviewDecisionMessage("approve", "d1000000"), /Đã duyệt yêu cầu thay đổi/);
  assert.match(reviewDecisionMessage("reject", "d1000000"), /Đã từ chối yêu cầu thay đổi/);
  assert.match(reviewerErrorMessage(403), /quyền quyết định/);
  assert.match(reviewerErrorMessage(409), /Phiên bản đã thay đổi/);
  assert.match(reviewerErrorMessage(400), /không hợp lệ/);
  const generic = reviewerErrorMessage(0);
  assert.equal(/CHANGE_REQUEST_|RPC|SQL|pg_/.test(generic), false, generic);
  assert.equal(/CHANGE_REQUEST_/.test(reviewerErrorMessage(409)), false);
});

test("worker_details FULL hien before/after theo nhan field, khong lo raw JSON", () => {
  const model = build({
    detail: { items: [detailItem({ proposal: { worker_details: workerDetails({
      phone: { state: "provided", value: "0900000000" } }) } })] },
    contexts: contextsOf(ENTRY_A, context({ workerDetails: workerDetails() })),
  });
  assert.equal(model.kind, "reviewable");
  assert.equal(model.items[0].decidable, true);
  assert.deepEqual(model.items[0].rows.map((row) => row.field), ["phone"]);
  assert.equal(model.items[0].rows[0].after, "0900000000");
  assert.equal(model.items[0].message, null);
});

test("worker_details presence-only: mot nhan chung, khong quyet dinh, khong lo gia tri", () => {
  const model = build({
    detail: { items: [detailItem({ proposal: { worker_details: { present: true } } })] },
  });
  assert.equal(model.kind, "readonly");
  assert.equal(model.items[0].decidable, false);
  assert.equal(model.items[0].message, PRESENCE_ONLY_MESSAGE);
  assert.deepEqual(model.items[0].rows, []);
  assert.equal(JSON.stringify(model).includes("display_name"), false);
});

test("PAYMENT full duoc quyet dinh, masked chi read-only, bank phai giai duoc", () => {
  const full = build({
    detail: { items: [detailItem({ target_kind: "PAYMENT", proposal: {
      state: "provided", account_number: "000123", bank_id: "s02c_bank",
      account_holder_name: "NGUYEN VAN SYNTHETIC" } })] },
  });
  assert.equal(full.kind, "reviewable");
  assert.equal(full.items[0].decidable, true);
  assert.equal(full.items[0].rows.some((row) => row.after === "Ngân hàng Synthetic"), true);

  const masked = build({
    detail: { items: [detailItem({ target_kind: "PAYMENT", proposal: {
      state: "provided", account_number: "••••6789" } })] },
  });
  assert.equal(masked.kind, "readonly");
  assert.equal(masked.items[0].decidable, false);
  assert.equal(masked.items[0].message, PAYMENT_MASKED_MESSAGE);
  const text = JSON.stringify(masked.items[0].rows);
  assert.equal(text.includes("000123"), false);

  const unknownBank = build({
    detail: { items: [detailItem({ target_kind: "PAYMENT", proposal: {
      state: "provided", account_number: "000123", bank_id: "bank_khong_co",
      account_holder_name: "NGUYEN VAN SYNTHETIC" } })] },
  });
  assert.equal(unknownBank.kind, "unsupported");
  assert.equal(unknownBank.reason, "CATALOG");
});

test("WORK_STATUS hien nhan trang thai + ngay hieu luc va ghi ro ly do bi an", () => {
  const model = build({
    detail: { items: [detailItem({ target_kind: "WORK_STATUS", proposal: {
      status: "OFF", effective_date: "2026-10-05" } })] },
    contexts: contextsOf(ENTRY_A, context()),
  });
  assert.equal(model.kind, "reviewable");
  assert.deepEqual(model.items[0].rows.map((row) => row.field),
    ["status", "effective_date", "leave_reason"]);
  assert.equal(model.items[0].rows[2].after, LEAVE_REASON_HIDDEN_MESSAGE);
  assert.equal(model.items[0].rows[0].before, "Chưa xác nhận");
  assert.equal(model.items[0].rows[0].after, "Đã nghỉ");

  const stale = build({
    detail: { items: [detailItem({ target_kind: "WORK_STATUS", proposal: {
      status: "ON", effective_date: "2026-10-05" } })] },
    entries: entriesOf(entryProjection(ENTRY_A, { version: 9 })),
    contexts: contextsOf(ENTRY_A, context()),
  });
  assert.equal(stale.kind, "stale");
});

test("DOCUMENT chi read-only, mixed co DOCUMENT thi toan request khong co quyet dinh", () => {
  const document = build({
    detail: { items: [detailItem({ target_kind: "DOCUMENT", proposal: {
      document_type: "EMPLOYMENT_CONTRACT", size_bytes: 2048,
      mime_type: "application/pdf" } })] },
  });
  assert.equal(document.kind, "readonly");
  assert.equal(document.items[0].decidable, false);
  assert.equal(document.items[0].message, DOCUMENT_STAGING_MESSAGE);
  assert.equal(document.items[0].rows[0].after, "Hợp đồng lao động");
  const text = JSON.stringify(document);
  assert.equal(text.includes("checksum"), false);
  assert.equal(text.includes("idempotency"), false);
  assert.equal(text.includes("storage"), false);

  const mixed = build({
    detail: { items: [detailItem(), detailItem({ target_kind: "DOCUMENT", proposal: {
      document_type: "CCCD_FRONT" } })] },
  });
  assert.equal(mixed.kind, "readonly");
  assert.equal(mixed.items.length, 2);
  assert.equal(mixed.items.filter((item) => !item.decidable).length, 1);
  assert.equal("can_decide" in mixed, false);
});
