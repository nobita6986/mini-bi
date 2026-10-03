import assert from "node:assert/strict";
import test from "node:test";

import {
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

const CATALOGS = { "2026-10-15": catalog() };

function build(overrides = {}) {
  return buildReviewerViewModel({
    detail: detail(overrides.detail),
    entries: overrides.entries ?? entriesOf(entryProjection(ENTRY_A)),
    format: overrides.format ?? formatWith(overrides.catalogs ?? CATALOGS),
  });
}

test("chi PENDING + can_decide=true + can_withdraw=false moi duoc quyet dinh", () => {
  const reviewable = build();
  assert.equal(reviewable.kind, "reviewable");
  assert.equal(reviewable.entries.length, 1);
  assert.equal(reviewable.entries[0].rows.length, 1);
  assert.deepEqual(reviewable.entries[0].rows[0], {
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
  assert.deepEqual(model.entries[0].rows.map((row) => row.field),
    ["employee_code", "project_id", "recruiter_id", "labor_type"]);
  assert.equal(model.entries[0].rows.some((row) => row.field === "first_work_date"), false,
    "first_work_date khong doi nen khong hien");
  for (const row of model.entries[0].rows) {
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
  const rows = model.entries[0].rows;
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
  assert.equal(model.entries.length, 1);
  assert.equal(model.entries[0].rows.length, 1);
  assert.match(STALE_REVIEW_MESSAGE, /Dữ liệu đã thay đổi/);
  const noDiff = build({
    detail: { items: [detailItem({ proposal: { employee_code: "hrp-2026-600001" } })] },
  });
  assert.equal(noDiff.kind, "stale");
  assert.deepEqual(noDiff.entries[0].rows, []);
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
  assert.equal(good.entries.length, 2);

  const mixed = build({
    detail: { items: [detailItem(), detailItem({ entry_id: ENTRY_B, target_kind: "PAYMENT",
      proposal: { state: "ACTIVE" } })] },
    entries: entriesOf(safe, second),
  });
  assert.equal(mixed.kind, "unsupported");
  assert.equal(mixed.reason, "TARGET_KIND");
  assert.equal("entries" in mixed, false, "khong xu ly mot phan request nhieu entry");

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
