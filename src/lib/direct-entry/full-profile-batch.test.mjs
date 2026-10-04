import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FULL_PROFILE_BATCH_ENDPOINT,
  buildFullProfileRequestBody,
  buildFullProfileRow,
  classifyFullProfileResponse,
  fullProfileErrorMessage,
  fullProfileIntentDigest,
  fullProfileRequiredCapabilities,
  fullProfileSubmitBlockers,
  postFullProfileBatch,
  projectFullProfileSuccess,
} from "./full-profile-batch.ts";
import {
  buildWorkerProfilePreview,
  createPasteCatalogResolver,
} from "./worker-profile-preview.ts";

// Du lieu GIA (synthetic) - khong phai du lieu that cua Owner.
const REFERENCE_DATE = "2026-10-16";
const PROJECT = { id: "11111111-1111-4111-8111-111111111111", label: "Dự án Giả Bắc" };
const PROJECT_2 = { id: "11111111-1111-4111-8111-111111111112", label: "Dự án Giả Nam" };
const RECRUITER = { id: "22222222-2222-4222-8222-222222222222", label: "Tuyển Dụng Giả 1" };
const BANK = { id: "33333333-3333-4333-8333-333333333333", label: "Ngân hàng Giả" };
const NAME = "Nguyễn Văn Giả A";
const NID = "012345678901";
const PHONE = "0900000001";
const ACCOUNT = "000123456789";
const HOLDER = "NGUYEN VAN GIA A";
const SUBMISSION = "44444444-4444-4444-8444-444444444444";
const ENTRY_A = "a1000000-0000-4000-8000-000000000001";
const ENTRY_B = "a1000000-0000-4000-8000-000000000002";

/** Header la HOP cua moi cot xuat hien o bat ky dong nao (thu tu lan xuat hien dau). */
function tsv(rows) {
  const header = [];
  for (const pairs of rows) {
    for (const [name] of pairs) if (!header.includes(name)) header.push(name);
  }
  const lines = rows.map((pairs) => {
    const map = new Map(pairs);
    return header.map((name) => (map.has(name) ? map.get(name) : "")).join("\t");
  });
  return [header.join("\t"), ...lines].join("\n");
}

function row(code, date = "2026-10-15", overrides = {}) {
  const base = [["Mã NLĐ", code], ["Dự án", PROJECT.label],
    ["Ngày bắt đầu làm việc", date], ["Họ và tên", NAME],
    ["Tên NV Tuyển dụng", RECRUITER.label], ["Loại hình LĐ", "Thời vụ"]];
  const pairs = base.map(([header, value]) => [header, overrides[header] ?? value]);
  for (const [header, value] of Object.entries(overrides)) {
    if (!base.some(([existing]) => existing === header)) pairs.push([header, value]);
  }
  return pairs;
}

function preview(text, options = {}) {
  const banks = options.banks ?? [BANK];
  const projects = options.projects ?? [PROJECT, PROJECT_2];
  const recruiters = options.recruiters ?? [RECRUITER];
  const source = { projects, recruiters, banks };
  const resolver = createPasteCatalogResolver(() => source);
  return buildWorkerProfilePreview({ text, referenceDate: REFERENCE_DATE, resolver,
    existing: options.existing });
}

const ALL_CAPS = ["entry_create", "submission_create", "payment_view", "payment_edit",
  "employment_status.apply"];

function blockersFor(p, capabilities = ALL_CAPS) {
  return fullProfileSubmitBlockers({ preview: p, capabilities, submitting: false });
}

test("ho so toi thieu: request row dung key set, khong label/derived/authority", () => {
  const p = preview(tsv([row("hrp-2026-000123")]));
  assert.equal(p.canProceed, true);
  const body = buildFullProfileRequestBody(p.rows);
  assert.equal(body.contract_version, "worker-profile/1.0");
  assert.equal(body.rows.length, 1);
  const requestRow = body.rows[0];
  assert.deepEqual(Object.keys(requestRow).sort(), ["display_name", "employee_code", "employment",
    "first_work_date", "general_note", "labor_type", "payment", "project_id", "recruiter_id",
    "worker"]);
  assert.equal(requestRow.project_id, PROJECT.id);
  assert.equal(requestRow.recruiter_id, RECRUITER.id);
  assert.equal(requestRow.display_name, NAME);
  assert.equal(requestRow.labor_type, "TEMPORARY");
  assert.deepEqual(Object.keys(requestRow.worker).sort(), ["address", "date_of_birth", "gender",
    "national_id", "national_id_issued_at", "national_id_issued_place", "phone"]);
  // Truong tuy chon vang mat => omitted; payment/employment rong => null.
  assert.deepEqual(requestRow.worker.national_id, { state: "omitted" });
  assert.deepEqual(requestRow.general_note, { state: "omitted" });
  assert.equal(requestRow.payment, null);
  assert.equal(requestRow.employment, null);
  // Khong co label/derived/authority trong request (kiem tra theo KEY, khong theo gia tri).
  const keys = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) { keys.add(key); walk(child); }
    }
  };
  walk(body);
  for (const forbidden of ["project_label", "recruiter_label", "bank_label", "derived",
    "team_hint", "provider_hint", "row_index", "effective_month", "age_years", "sourceRow",
    "actor", "actor_id", "capability", "scope", "scope_kind", "entry_id", "submission_id",
    "payment_state", "provider_type", "team", "team_id"]) {
    assert.equal(keys.has(forbidden), false, forbidden);
  }
  const serialized = JSON.stringify(body);
  for (const forbidden of [PROJECT.label, RECRUITER.label]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("ho so day du: map worker/payment/employment dung contract", () => {
  const p = preview(tsv([row("hrp-2026-000123", "2026-10-15", {
    "Giới tính": "Nữ", DOB: "20/05/1990", "CMT/CCCD": NID, "Ngày cấp": "2020-06-01",
    "Nơi cấp": "Cục Cảnh sát Giả", "Địa chỉ hiện tại": "Số 1 Đường Giả",
    "Số điện thoại": PHONE, "Ghi chú": "Ghi chú giả",
    "Tình trạng làm việc hiện tại": "Đã nghỉ", "Ngày nghỉ thực tế": "2026-10-20",
    "Ghi chú về nghỉ việc": "Hết hạn hợp đồng giả",
    STK: ACCOUNT, "Tên ngân hàng": BANK.label, "Tên chủ tài khoản": HOLDER,
  })]));
  assert.equal(p.errorCount, 0, JSON.stringify(p.issues));
  const requestRow = buildFullProfileRequestBody(p.rows).rows[0];
  assert.deepEqual(requestRow.worker.gender, { state: "provided", value: "FEMALE" });
  assert.deepEqual(requestRow.worker.date_of_birth, { state: "provided", value: "1990-05-20" });
  assert.deepEqual(requestRow.worker.national_id, { state: "provided", value: NID });
  assert.deepEqual(requestRow.worker.national_id_issued_at,
    { state: "provided", value: "2020-06-01" });
  assert.deepEqual(requestRow.general_note, { state: "provided", value: "Ghi chú giả" });
  assert.deepEqual(requestRow.payment, { state: "provided", account_number: ACCOUNT,
    bank_id: BANK.id, account_holder_name: HOLDER });
  assert.deepEqual(requestRow.employment, { initial_status: "OFF", leave_date: "2026-10-20",
    leave_reason_text: "Hết hạn hợp đồng giả" });
  // Non-OFF khong duoc gui leave_date/leave_reason_text.
  const on = preview(tsv([row("hrp-2026-000123", "2026-10-15",
    { "Tình trạng làm việc hiện tại": "Đang làm" })]));
  const onRow = buildFullProfileRequestBody(on.rows).rows[0];
  assert.deepEqual(onRow.employment, { initial_status: "ON" });
  assert.equal("leave_date" in onRow.employment, false);
});

test("thu tu cot tuy y va cot tuy chon vang mat deu cho cung request", () => {
  const shuffled = tsv([[["Tên NV Tuyển dụng", RECRUITER.label], ["Họ và tên", NAME],
    ["Loại hình LĐ", "Thời vụ"], ["Mã NLĐ", "hrp-2026-000123"],
    ["Dự án", PROJECT.id], ["Ngày bắt đầu làm việc", "15/10/2026"]]]);
  const minimal = tsv([row("hrp-2026-000123")]);
  const a = buildFullProfileRequestBody(preview(shuffled).rows).rows[0];
  const b = buildFullProfileRequestBody(preview(minimal).rows).rows[0];
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(a.worker.phone, { state: "omitted" });
});

test("alias 'Ma so ung vien' -> employee_code; UI canonical van la 'Ma NLĐ'", () => {
  const aliasText = tsv([[
    ["Mã số ứng viên", "hrp-2026-000123"], ["Dự án", PROJECT.label],
    ["Ngày bắt đầu làm việc", "2026-10-15"], ["Họ và tên", NAME],
    ["Tên NV Tuyển dụng", RECRUITER.label], ["Loại hình LĐ", "Thời vụ"],
  ]]);
  const p = preview(aliasText);
  assert.equal(p.canProceed, true);
  assert.equal(buildFullProfileRequestBody(p.rows).rows[0].employee_code, "hrp-2026-000123");
  const source = readFileSync(new URL(
    "../../components/direct-entry/direct-entry-worker-profile-paste-dialog.tsx",
    import.meta.url), "utf8");
  assert.equal(source.includes("Mã số ứng viên"), false);
  assert.match(source, /WORKER_PROFILE_TEMPLATE_HEADERS/);
});

test("duplicate/unknown header => fail closed, khong gui duoc", () => {
  const duplicateHeader = ["Mã NLĐ", "Mã số ứng viên", "Dự án", "Ngày bắt đầu làm việc",
    "Họ và tên", "Tên NV Tuyển dụng", "Loại hình LĐ"];
  const duplicate = preview([duplicateHeader.join("\t"),
    ["hrp-2026-000123", "hrp-2026-000123", PROJECT.label, "2026-10-15", NAME, RECRUITER.label,
      "Thời vụ"].join("\t")].join("\n"));
  assert.equal(duplicate.canProceed, false);
  assert.equal(blockersFor(duplicate).includes("PROFILE_PREVIEW_INVALID"), true);

  const unknownHeader = ["Mã NLĐ", "Dự án", "Ngày bắt đầu làm việc", "Họ và tên",
    "Tên NV Tuyển dụng", "Loại hình LĐ", "Cột lạ"];
  const unknown = preview([unknownHeader.join("\t"),
    ["hrp-2026-000123", PROJECT.label, "2026-10-15", NAME, RECRUITER.label, "Thời vụ", "x"]
      .join("\t")].join("\n"));
  assert.equal(unknown.canProceed, false);
  assert.equal(blockersFor(unknown).includes("PROFILE_PREVIEW_INVALID"), true);
});

test("CMT/CCCD 9 va 12 chu so giu so 0 dau; gia tri sai bi chan", () => {
  for (const good of ["012345678", "012345678901"]) {
    const p = preview(tsv([row("hrp-2026-000123", "2026-10-15", { "CMT/CCCD": good })]));
    assert.deepEqual(buildFullProfileRequestBody(p.rows).rows[0].worker.national_id,
      { state: "provided", value: good });
  }
  for (const bad of ["01234567", "0123456789012", "01234567890a"]) {
    const p = preview(tsv([row("hrp-2026-000123", "2026-10-15", { "CMT/CCCD": bad })]));
    assert.equal(p.canProceed, false, bad);
    assert.equal(blockersFor(p).includes("PROFILE_PREVIEW_INVALID"), true, bad);
  }
});

test("gender vocabulary D11; gia tri la bi chan", () => {
  for (const [input, expected] of [["Nam", "MALE"], ["Nữ", "FEMALE"], ["Khác", "OTHER"]]) {
    const p = preview(tsv([row("hrp-2026-000123", "2026-10-15", { "Giới tính": input })]));
    assert.deepEqual(buildFullProfileRequestBody(p.rows).rows[0].worker.gender,
      { state: "provided", value: expected });
  }
  const bad = preview(tsv([row("hrp-2026-000123", "2026-10-15", { "Giới tính": "Không rõ" })]));
  assert.equal(bad.canProceed, false);
});

test("ngay khong hop le va ghi chu vuot gioi han deu chan submit", () => {
  const badDate = preview(tsv([row("hrp-2026-000123", "31/02/2026")]));
  assert.equal(badDate.canProceed, false);
  const futureDob = preview(tsv([row("hrp-2026-000123", "2026-10-15", { DOB: "2027-01-01" })]));
  assert.equal(futureDob.canProceed, false);

  const noteOk = preview(tsv([row("hrp-2026-000123", "2026-10-15", { "Ghi chú": "x".repeat(4000) })]));
  assert.equal(noteOk.canProceed, true);
  const noteTooLong = preview(tsv([row("hrp-2026-000123", "2026-10-15",
    { "Ghi chú": "x".repeat(4001) })]));
  assert.equal(noteTooLong.canProceed, false);
  assert.equal(blockersFor(noteTooLong).includes("PROFILE_PREVIEW_INVALID"), true);
});

test("catalog: exact ID/label resolve; thieu hoac ambiguous deu chan", () => {
  const byId = preview(tsv([row("hrp-2026-000123", "2026-10-15",
    { "Dự án": PROJECT.id, "Tên NV Tuyển dụng": RECRUITER.id })]));
  const requestRow = buildFullProfileRequestBody(byId.rows).rows[0];
  assert.equal(requestRow.project_id, PROJECT.id);
  assert.equal(requestRow.recruiter_id, RECRUITER.id);

  const missing = preview(tsv([row("hrp-2026-000123", "2026-10-15",
    { "Dự án": "Dự án Không Có" })]));
  assert.equal(blockersFor(missing).includes("PROFILE_PREVIEW_INVALID"), true);
  assert.equal(blockersFor(missing).includes("PROFILE_CATALOG_UNRESOLVED"), true);
  assert.equal(buildFullProfileRow(missing.rows[0]), null);

  const ambiguous = preview(tsv([row("hrp-2026-000123")]), {
    projects: [PROJECT, { id: PROJECT_2.id, label: PROJECT.label }],
  });
  assert.equal(blockersFor(ambiguous).includes("PROFILE_CATALOG_UNRESOLVED"), true);

  // Team/provider la validation-only: KHONG bao gio nam trong request (server tu resolve - D6).
  const withHints = preview(tsv([row("hrp-2026-000123", "2026-10-15",
    { "Chi nhánh/Team": "Team Giả", "Người tuyển dụng (HRP/Vendor)": "HRP" })]));
  assert.equal(withHints.canProceed, true);
  const hintRow = buildFullProfileRequestBody(withHints.rows).rows[0];
  const hintKeys = new Set();
  const walkHints = (value) => {
    if (Array.isArray(value)) { value.forEach(walkHints); return; }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) { hintKeys.add(key); walkHints(child); }
    }
  };
  walkHints(hintRow);
  for (const forbidden of ["team", "team_id", "provider", "provider_type", "team_hint",
    "provider_hint"]) {
    assert.equal(hintKeys.has(forbidden), false, forbidden);
  }
  assert.equal(JSON.stringify(hintRow).includes("Team Giả"), false);
});

test("banks=0: non-payment van gui duoc, payment-bearing bi chan (fail closed)", () => {
  const noBanks = { banks: [] };
  const nonPayment = preview(tsv([row("hrp-2026-000123")]), noBanks);
  assert.equal(blockersFor(nonPayment).length, 0, JSON.stringify(blockersFor(nonPayment)));
  const body = buildFullProfileRequestBody(nonPayment.rows);
  assert.equal(body.rows[0].payment, null);

  const paymentBearing = preview(tsv([row("hrp-2026-000123", "2026-10-15", {
    STK: ACCOUNT, "Tên ngân hàng": BANK.label, "Tên chủ tài khoản": HOLDER,
  })]), noBanks);
  const blockers = blockersFor(paymentBearing);
  assert.equal(blockers.includes("PROFILE_PAYMENT_BANK_REQUIRED"), true);
  assert.equal(blockers.includes("PROFILE_CATALOG_UNRESOLVED"), true);
  assert.equal(buildFullProfileRow(paymentBearing.rows[0]), null);

  // Trang thai payment khong can bank (omitted) van duoc phep.
  const omittedPayment = preview(tsv([row("hrp-2026-000123")]), noBanks);
  assert.equal(blockersFor(omittedPayment).length, 0);
});

test("mixed batch: mot dong payment-bearing khong hop le => chan ca nhom", () => {
  const mixed = preview(tsv([
    row("hrp-2026-000001"),
    row("hrp-2026-000002", "2026-10-15", { STK: ACCOUNT, "Tên ngân hàng": BANK.label,
      "Tên chủ tài khoản": HOLDER }),
  ]), { banks: [] });
  const blockers = blockersFor(mixed);
  assert.equal(blockers.includes("PROFILE_PAYMENT_BANK_REQUIRED"), true);
  assert.equal(buildFullProfileRequestBody(mixed.rows), null);
});

test("gioi han: 1..100 dong; body limit duoc kiem tra truoc khi gui", async () => {
  const zero = preview("");
  assert.equal(blockersFor(zero).includes("PROFILE_PREVIEW_EMPTY"), true);

  const hundred = Array.from({ length: 100 }, (item, index) =>
    row("hrp-2026-" + String(index + 1).padStart(6, "0")));
  const many = preview(tsv(hundred));
  assert.equal(blockersFor(many).length, 0, JSON.stringify(blockersFor(many)));
  const body = buildFullProfileRequestBody(many.rows);
  assert.equal(body.rows.length, 100);

  const calls = [];
  const tooMany = await postFullProfileBatch({ rows: Array.from({ length: 101 }, () => body.rows[0]),
    idempotencyKey: SUBMISSION, fetchImpl: async () => { calls.push(1); throw new Error("x"); } });
  assert.equal(tooMany.kind, "rejected");
  assert.equal(tooMany.code, "BATCH_SIZE_INVALID");
  assert.equal(calls.length, 0);

  // Unicode vuot 4 MiB UTF-8 nhung van nho hon 4 MiB theo JS string.length.
  const unicodeBody = body.rows.map((item) => ({ ...item,
    general_note: { state: "provided", value: "😀".repeat(11000) } }));
  const unicodeJson = JSON.stringify({ contract_version: "worker-profile/1.0", rows: unicodeBody });
  assert.equal(unicodeJson.length < 4 * 1024 * 1024, true);
  assert.equal(new TextEncoder().encode(unicodeJson).byteLength > 4 * 1024 * 1024, true);
  const bigBody = await postFullProfileBatch({ rows: unicodeBody, idempotencyKey: SUBMISSION,
    fetchImpl: async () => { calls.push(1); throw new Error("x"); } });
  assert.deepEqual(bigBody, { kind: "rejected", code: "BODY_TOO_LARGE" });
  assert.equal(calls.length, 0);
});

test("request: dung mot POST, dung endpoint/header/body, khong truong authority", async () => {
  const p = preview(tsv([row("hrp-2026-000001"), row("hrp-2026-000002")]));
  const body = buildFullProfileRequestBody(p.rows);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 201, json: async () => ({
      ok: true, submission_id: SUBMISSION, state: "DRAFT", version: 1,
      entry_ids: [ENTRY_A, ENTRY_B] }) };
  };
  const result = await postFullProfileBatch({ rows: body.rows,
    idempotencyKey: "55555555-5555-4555-8555-555555555555", fetchImpl });
  assert.equal(calls.length, 1, "dung mot request cho ca batch");
  assert.equal(calls[0].url, FULL_PROFILE_BATCH_ENDPOINT);
  assert.equal(calls[0].url, "/api/direct-entry/batches/full-profile");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.deepEqual(calls[0].init.headers, {
    "Content-Type": "application/json",
    "Idempotency-Key": "55555555-5555-4555-8555-555555555555",
  });
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(sent).sort(), ["contract_version", "rows"]);
  assert.equal(sent.contract_version, "worker-profile/1.0");
  assert.equal(sent.rows.length, 2);
  assert.equal(result.kind, "saved");
  assert.deepEqual(result.entryIds, [ENTRY_A, ENTRY_B]);
  assert.equal(result.submissionId, SUBMISSION);
  assert.equal(result.version, 1);

  const keys = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) { keys.add(key); walk(child); }
    }
  };
  walk(sent);
  // "state" la khoa HOP LE cua OptionalValue; cam o day chi la cac khoa authority/derived.
  for (const forbidden of ["actor", "actor_id", "app_user_id", "auth_subject", "capability",
    "scope", "scope_kind", "entry_id", "submission_id", "provider_type", "team",
    "team_id", "payment_state", "bank_label", "row_index"]) {
    assert.equal(keys.has(forbidden), false, forbidden);
  }
  assert.deepEqual(Object.keys(sent.rows[0]).sort(), ["display_name", "employee_code",
    "employment", "first_work_date", "general_note", "labor_type", "payment", "project_id",
    "recruiter_id", "worker"]);
});

test("intent fingerprint: chi la hash, khong chua PII", async () => {
  const p = preview(tsv([row("hrp-2026-000123", "2026-10-15", { "CMT/CCCD": NID,
    "Số điện thoại": PHONE, STK: ACCOUNT, "Tên ngân hàng": BANK.label,
    "Tên chủ tài khoản": HOLDER, "Ghi chú": "Ghi chú giả",
    "Địa chỉ hiện tại": "Số 1 Đường Giả" })]));
  const body = buildFullProfileRequestBody(p.rows);
  const digest = await fullProfileIntentDigest(body.rows);
  assert.match(digest, /^[a-f0-9]{64}$/);
  for (const pii of [NAME, NID, PHONE, ACCOUNT, HOLDER, "Ghi chú giả", "Số 1 Đường Giả",
    "hrp-2026-000123"]) {
    assert.equal(digest.includes(pii), false, pii);
  }
  // Cung payload => cung digest; doi mot cell => digest moi.
  assert.equal(await fullProfileIntentDigest(body.rows), digest);
  const edited = [{ ...body.rows[0], display_name: NAME + " B" }];
  assert.notEqual(await fullProfileIntentDigest(edited), digest);
  assert.match(await fullProfileIntentDigest(edited), /^[a-f0-9]{64}$/);
});

test("ket qua: 2xx projection hop le moi la thanh cong; malformed thi fail closed", () => {
  const good = { ok: true, submission_id: SUBMISSION, state: "DRAFT", version: 1,
    entry_ids: [ENTRY_A, ENTRY_B] };
  assert.equal(projectFullProfileSuccess(good, 2).kind, "saved");
  assert.equal(classifyFullProfileResponse(201, good, 2).kind, "saved");
  assert.equal(classifyFullProfileResponse(200, good, 2).kind, "saved");

  for (const bad of [
    { ok: true, submission_id: SUBMISSION, state: "DRAFT", version: 1, entry_ids: [ENTRY_A] },
    { ok: true, submission_id: SUBMISSION, state: "SUBMITTED", version: 1,
      entry_ids: [ENTRY_A, ENTRY_B] },
    { ok: true, submission_id: "not-a-uuid", state: "DRAFT", version: 1,
      entry_ids: [ENTRY_A, ENTRY_B] },
    { ok: true, submission_id: SUBMISSION, state: "DRAFT", version: 1,
      entry_ids: [ENTRY_A, ENTRY_A] },
    { ok: true, submission_id: SUBMISSION, state: "DRAFT", version: 1 },
    { ok: true, submission_id: SUBMISSION, state: "DRAFT", version: 1, entry_ids: [ENTRY_A,
      ENTRY_B], extra: 1 },
    { ok: false, code: "BATCH_INVALID" },
  ]) {
    assert.equal(projectFullProfileSuccess(bad, 2), null, JSON.stringify(bad));
    const classified = classifyFullProfileResponse(201, bad, 2);
    assert.equal(classified.kind, "retry", JSON.stringify(bad));
    assert.equal(classified.code, "FULL_PROFILE_PROJECTION_INVALID");
  }

  assert.equal(classifyFullProfileResponse(409, { ok: false, code: "IDEMPOTENCY_CONFLICT" }, 2).kind,
    "conflict");
  assert.equal(classifyFullProfileResponse(503, { ok: false, code: "BATCH_UNAVAILABLE" }, 2).kind,
    "retry");
  for (const status of [400, 401, 403, 404, 413]) {
    assert.equal(classifyFullProfileResponse(status, { ok: false, code: "X" }, 2).kind,
      "rejected", String(status));
  }
});

test("retry/network: giu key; loi nghiep vu ket thuc intent", async () => {
  const p = preview(tsv([row("hrp-2026-000123")]));
  const body = buildFullProfileRequestBody(p.rows);
  const key = "66666666-6666-4666-8666-666666666666";

  const network = await postFullProfileBatch({ rows: body.rows, idempotencyKey: key,
    fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(network.kind, "retry");
  assert.equal(network.code, "FULL_PROFILE_NETWORK");

  const serverError = await postFullProfileBatch({ rows: body.rows, idempotencyKey: key,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ ok: false,
      code: "BATCH_UNAVAILABLE" }) }) });
  assert.equal(serverError.kind, "retry");

  const rejected = await postFullProfileBatch({ rows: body.rows, idempotencyKey: key,
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ ok: false,
      code: "NATIONAL_ID_INVALID" }) }) });
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.code, "NATIONAL_ID_INVALID");

  // Key phai la UUID theo contract server.
  const badKey = await postFullProfileBatch({ rows: body.rows, idempotencyKey: "not-a-uuid",
    fetchImpl: async () => { throw new Error("x"); } });
  assert.equal(badKey.code, "IDEMPOTENCY_KEY_INVALID");
});

test("capability gate theo RPC: entry_create + submission_create + payment/status khi can", () => {
  const nonPayment = preview(tsv([row("hrp-2026-000123")]));
  let rows = buildFullProfileRequestBody(nonPayment.rows).rows;
  assert.deepEqual(fullProfileRequiredCapabilities(rows), ["entry_create", "submission_create"]);
  assert.equal(fullProfileSubmitBlockers({ preview: nonPayment,
    capabilities: ["entry_create", "submission_create"], submitting: false }).length, 0);
  assert.equal(fullProfileSubmitBlockers({ preview: nonPayment,
    capabilities: ["entry_create"], submitting: false })
    .includes("PROFILE_CAPABILITY_MISSING"), true);

  const withPayment = preview(tsv([row("hrp-2026-000123", "2026-10-15", { STK: ACCOUNT,
    "Tên ngân hàng": BANK.label, "Tên chủ tài khoản": HOLDER })]));
  rows = buildFullProfileRequestBody(withPayment.rows).rows;
  assert.deepEqual(fullProfileRequiredCapabilities(rows), ["entry_create", "submission_create",
    "payment_view", "payment_edit"]);
  assert.equal(fullProfileSubmitBlockers({ preview: withPayment,
    capabilities: ["entry_create", "submission_create", "payment_view"], submitting: false })
    .includes("PROFILE_CAPABILITY_MISSING"), true);

  const withStatus = preview(tsv([row("hrp-2026-000123", "2026-10-15",
    { "Tình trạng làm việc hiện tại": "Đang làm" })]));
  rows = buildFullProfileRequestBody(withStatus.rows).rows;
  assert.deepEqual(fullProfileRequiredCapabilities(rows), ["entry_create", "submission_create",
    "employment_status.apply"]);
});

test("busy chan double submit va thong bao loi duoc lam sach", () => {
  const p = preview(tsv([row("hrp-2026-000123")]));
  const blockers = fullProfileSubmitBlockers({ preview: p, capabilities: ALL_CAPS,
    submitting: true });
  assert.equal(blockers.includes("PROFILE_SUBMITTING"), true);

  for (const code of ["FULL_PROFILE_NETWORK", "FULL_PROFILE_PROJECTION_INVALID",
    "BATCH_UNAVAILABLE", "IDEMPOTENCY_CONFLICT", "BATCH_INVALID", "UNAUTHENTICATED",
    "ACTOR_DENIED", "NOT_FOUND", "BANK_NOT_ACTIVE", "PAYMENT_DETAILS_INVALID"]) {
    const message = fullProfileErrorMessage(code);
    assert.equal(message.includes(code), false, code);
    assert.ok(message.length > 0, code);
  }
  assert.match(fullProfileErrorMessage("SOME_UNKNOWN_CODE"), /Không lưu được nhóm dòng/);

  const source = readFileSync(new URL("./full-profile-batch.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["localStorage", "sessionStorage", "console.", "document.cookie"]) {
    assert.equal(code.includes(forbidden), false, forbidden);
  }
});
