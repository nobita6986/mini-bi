import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  accountMetadataValues,
  buildAccountMetadata,
  buildFullProfileRequestBody,
  buildFullProfileRow,
  fullProfileIntentDigest,
  fullProfileRequiredCapabilities,
  fullProfileSubmitBlockers,
  hasAnyAccountMetadata,
  isAccountMetadataValid,
} from "./full-profile-batch.ts";
import {
  buildWorkerProfilePreview,
  createPasteCatalogResolver,
} from "./worker-profile-preview.ts";
import {
  WORKER_PROFILE_TEMPLATE_HEADERS,
  workerProfileField,
} from "./worker-profile-import-contract.ts";

// P1.6-I04C3-R4-S02 - Toan bo du lieu trong file nay la GIA (synthetic).

const REFERENCE_DATE = "2026-10-16";
const PROJECT = { id: "11111111-1111-4111-8111-111111111111", label: "Dự án Giả Bắc" };
const RECRUITER = { id: "22222222-2222-4222-8222-222222222222", label: "Tuyển Dụng Giả 1" };
const NAME = "Nguyễn Văn Giả A";
const ACCOUNT = "000123456789";
const BANK_NAME = "Ngân hàng Giả Đông Á";
const HOLDER = "NGUYỄN VĂN GIẢ A";
const CAPS = ["entry_create", "submission_create", "payment_view", "payment_edit"];

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

function row(code, overrides = {}) {
  const base = [["Mã NLĐ", code], ["Dự án", PROJECT.label],
    ["Ngày bắt đầu làm việc", "2026-10-15"], ["Họ và tên", NAME],
    ["Tên NV Tuyển dụng", RECRUITER.label], ["Loại hình LĐ", "Thời vụ"]];
  const pairs = base.map(([header, value]) => [header, overrides[header] ?? value]);
  for (const [header, value] of Object.entries(overrides)) {
    if (!base.some(([existing]) => existing === header)) pairs.push([header, value]);
  }
  return pairs;
}

/** Catalog KHONG co banks: chung minh banks=0 khong con anh huong. */
function preview(text, options = {}) {
  const source = {
    projects: options.projects ?? [PROJECT],
    recruiters: options.recruiters ?? [RECRUITER],
  };
  const resolver = createPasteCatalogResolver(() => source);
  return buildWorkerProfilePreview({ text, referenceDate: REFERENCE_DATE, resolver,
    existing: options.existing });
}

function paymentOf(p) {
  const body = buildFullProfileRequestBody(p.rows);
  assert.ok(body, "request body phai build duoc");
  return body.rows[0].payment;
}

function blockersOf(p) {
  return fullProfileSubmitBlockers({ preview: p, capabilities: CAPS, submitting: false });
}

test("1-2. khong co ba header tai khoan / co du ba header", () => {
  const none = preview(tsv([row("hrp-2026-000101")]));
  assert.equal(none.errorCount, 0);
  assert.equal(paymentOf(none), null);

  const all = preview(tsv([row("hrp-2026-000102",
    { STK: ACCOUNT, "Tên ngân hàng": BANK_NAME, "Tên chủ tài khoản": HOLDER })]));
  assert.equal(all.errorCount, 0);
  assert.equal(all.rows[0].row.payment.account_number.state, "provided");
  assert.equal(all.rows[0].row.payment.bank_name.state, "provided");
  assert.equal(all.rows[0].row.payment.account_holder_name.state, "provided");
});

test("3-6. mot truong, hai truong bat ky: deu hop le va chi gui truong da nhap", () => {
  const cases = [
    [{ STK: ACCOUNT }, ["account_number"]],
    [{ "Tên ngân hàng": BANK_NAME }, ["bank_name"]],
    [{ "Tên chủ tài khoản": HOLDER }, ["account_holder_name"]],
    [{ STK: ACCOUNT, "Tên ngân hàng": BANK_NAME }, ["account_number", "bank_name"]],
    [{ STK: ACCOUNT, "Tên chủ tài khoản": HOLDER }, ["account_number", "account_holder_name"]],
    [{ "Tên ngân hàng": BANK_NAME, "Tên chủ tài khoản": HOLDER },
      ["bank_name", "account_holder_name"]],
    [{ STK: ACCOUNT, "Tên ngân hàng": BANK_NAME, "Tên chủ tài khoản": HOLDER },
      ["account_number", "bank_name", "account_holder_name"]],
  ];
  for (const [overrides, expectedKeys] of cases) {
    const p = preview(tsv([row("hrp-2026-000201", overrides)]));
    assert.equal(blockersOf(p).length, 0, JSON.stringify(overrides));
    const payment = paymentOf(p);
    assert.equal(payment.state, "provided");
    assert.deepEqual(Object.keys(payment).filter((key) => key !== "state").sort(),
      [...expectedKeys].sort());
    assert.equal("bank_id" in payment, false);
  }
});

test("7. ba truong deu trong hoac chi khoang trang => payment null", () => {
  const p = preview(tsv([row("hrp-2026-000301",
    { STK: "   ", "Tên ngân hàng": "", "Tên chủ tài khoản": "\t" })]));
  assert.equal(p.errorCount, 0);
  assert.equal(paymentOf(p), null);
});

test("8. STK giu so 0 dau (string, khong Number())", () => {
  const p = preview(tsv([row("hrp-2026-000401", { STK: "000123456789" })]));
  const payment = paymentOf(p);
  assert.equal(payment.account_number, "000123456789");
  assert.equal(typeof payment.account_number, "string");
  const source = readFileSync(new URL("./worker-profile-paste.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Number\(accountNumberRaw\)|parseInt\(accountNumberRaw/);
});

test("9-10. ten ngan hang giu Unicode/dau tieng Viet; trim dau/cuoi", () => {
  const p = preview(tsv([row("hrp-2026-000501",
    { "Tên ngân hàng": "   Ngân hàng TMCP Đông Á — Chi nhánh Hà Nội   " })]));
  assert.equal(paymentOf(p).bank_name, "Ngân hàng TMCP Đông Á — Chi nhánh Hà Nội");

  const values = accountMetadataValues({
    account_number: { state: "provided", value: "  0001  " },
    bank_name: { state: "provided", value: "  Ngân hàng  " },
    account_holder_name: { state: "omitted" },
  });
  assert.equal(values.account_number, "0001");
  assert.equal(values.bank_name, "Ngân hàng");
  assert.equal(values.account_holder_name, null);
});

test("11-12. do dai toi da theo contract; vuot/ky tu dieu khien fail closed", () => {
  const ok = preview(tsv([row("hrp-2026-000601",
    { STK: "9".repeat(64), "Tên ngân hàng": "b".repeat(256),
      "Tên chủ tài khoản": "h".repeat(256) })]));
  assert.equal(ok.errorCount, 0, JSON.stringify(ok.issues));
  assert.equal(blockersOf(ok).length, 0);
  assert.equal(paymentOf(ok).account_number.length, 64);

  const headers = { account_number: "STK", bank_name: "Tên ngân hàng",
    account_holder_name: "Tên chủ tài khoản" };
  const maxLengths = { account_number: 64, bank_name: 256, account_holder_name: 256 };
  for (const key of Object.keys(maxLengths)) {
    const tooLong = preview(tsv([row("hrp-2026-000602",
      { [headers[key]]: "x".repeat(maxLengths[key] + 1) })]));
    assert.equal(tooLong.canProceed, false, key + " too long");
    assert.equal(blockersOf(tooLong).includes("PROFILE_PREVIEW_INVALID"), true, key);
  }

  assert.equal(isAccountMetadataValid({
    account_number: { state: "provided", value: "a".repeat(65) },
    bank_name: { state: "omitted" }, account_holder_name: { state: "omitted" },
  }), false);
  assert.equal(buildAccountMetadata({
    account_number: { state: "provided", value: "a\u0001b" },
    bank_name: { state: "omitted" }, account_holder_name: { state: "omitted" },
  }), null);
});

test("13-15. thu tu cot tuy y; duplicate header; unknown header", () => {
  const shuffled = tsv([[
    ["Tên chủ tài khoản", HOLDER], ["Tên ngân hàng", BANK_NAME], ["STK", ACCOUNT],
    ["Loại hình LĐ", "Thời vụ"], ["Mã NLĐ", "hrp-2026-000701"],
    ["Ngày bắt đầu làm việc", "15/10/2026"], ["Dự án", PROJECT.label],
    ["Họ và tên", NAME], ["Tên NV Tuyển dụng", RECRUITER.label],
  ]]);
  const p = preview(shuffled);
  assert.equal(p.errorCount, 0);
  assert.deepEqual(paymentOf(p), { state: "provided", account_number: ACCOUNT,
    bank_name: BANK_NAME, account_holder_name: HOLDER });

  const duplicate = preview([
    ["Mã NLĐ", "Dự án", "Ngày bắt đầu làm việc", "Họ và tên", "Tên NV Tuyển dụng",
      "Loại hình LĐ", "STK", "Số tài khoản"].join("\t"),
    ["hrp-2026-000702", PROJECT.label, "2026-10-15", NAME, RECRUITER.label, "Thời vụ",
      ACCOUNT, ACCOUNT].join("\t"),
  ].join("\n"));
  assert.equal(duplicate.canProceed, false);
  assert.equal(blockersOf(duplicate).includes("PROFILE_PREVIEW_INVALID"), true);

  const unknown = preview([
    ["Mã NLĐ", "Dự án", "Ngày bắt đầu làm việc", "Họ và tên", "Tên NV Tuyển dụng",
      "Loại hình LĐ", "Số dư cuối kỳ"].join("\t"),
    ["hrp-2026-000703", PROJECT.label, "2026-10-15", NAME, RECRUITER.label, "Thời vụ", "x"]
      .join("\t"),
  ].join("\n"));
  assert.equal(unknown.canProceed, false);
});

test("16-17. khong sinh bank_id va khong can bank catalog", () => {
  const p = preview(tsv([row("hrp-2026-000801",
    { STK: ACCOUNT, "Tên ngân hàng": "Ngân hàng Không Có Trong Danh Mục" })]));
  const payment = paymentOf(p);
  assert.equal("bank_id" in payment, false);
  assert.equal(payment.bank_name, "Ngân hàng Không Có Trong Danh Mục");
  assert.equal(blockersOf(p).length, 0);
  assert.equal(JSON.stringify(buildFullProfileRequestBody(p.rows)).includes("bank_id"), false);

  const collision = preview(tsv([row("hrp-2026-000802", { "Tên ngân hàng": PROJECT.label })]));
  assert.equal(paymentOf(collision).bank_name, PROJECT.label);
});

test("18-19. request projection chinh xac; khong truong authority", () => {
  const p = preview(tsv([row("hrp-2026-000901",
    { STK: ACCOUNT, "Tên ngân hàng": BANK_NAME, "Tên chủ tài khoản": HOLDER })]));
  const body = buildFullProfileRequestBody(p.rows);
  assert.deepEqual(Object.keys(body).sort(), ["contract_version", "rows"]);
  assert.deepEqual(Object.keys(body.rows[0]).sort(), ["display_name", "employee_code",
    "employment", "first_work_date", "general_note", "labor_type", "payment", "project_id",
    "recruiter_id", "worker"]);
  assert.deepEqual(Object.keys(body.rows[0].payment).sort(),
    ["account_holder_name", "account_number", "bank_name", "state"]);

  const keys = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) { keys.add(key); walk(child); }
    }
  };
  walk(body);
  for (const forbidden of ["actor", "actor_id", "app_user_id", "auth_subject", "capability",
    "scope", "scope_kind", "entry_id", "submission_id", "provider_type", "team", "team_id",
    "payment_state", "bank_label", "bank_id", "row_index"]) {
    assert.equal(keys.has(forbidden), false, forbidden);
  }
});

test("20. intent digest doi khi metadata doi nhung khong lo raw PII", async () => {
  const base = buildFullProfileRequestBody(preview(tsv([row("hrp-2026-001001",
    { STK: ACCOUNT, "Tên ngân hàng": BANK_NAME, "Tên chủ tài khoản": HOLDER })])).rows);
  const changed = buildFullProfileRequestBody(preview(tsv([row("hrp-2026-001001",
    { STK: ACCOUNT, "Tên ngân hàng": BANK_NAME + " X", "Tên chủ tài khoản": HOLDER })])).rows);
  const digestBase = await fullProfileIntentDigest(base);
  const digestChanged = await fullProfileIntentDigest(changed);
  assert.match(digestBase, /^[a-f0-9]{64}$/);
  assert.notEqual(digestBase, digestChanged);
  for (const pii of [ACCOUNT, BANK_NAME, HOLDER, NAME, "hrp-2026-001001"]) {
    assert.equal(digestBase.includes(pii), false, pii);
  }
});

test("capability: metadata tai khoan van dung payment_view/payment_edit theo server", () => {
  const withMetadata = buildFullProfileRequestBody(preview(tsv([row("hrp-2026-001101",
    { "Tên ngân hàng": BANK_NAME })])).rows);
  assert.deepEqual(fullProfileRequiredCapabilities(withMetadata.rows),
    ["entry_create", "submission_create", "payment_view", "payment_edit"]);
  const without = buildFullProfileRequestBody(preview(tsv([row("hrp-2026-001102")])).rows);
  assert.deepEqual(fullProfileRequiredCapabilities(without.rows),
    ["entry_create", "submission_create"]);
  const p = preview(tsv([row("hrp-2026-001201")]));
  assert.equal(hasAnyAccountMetadata(p.rows[0].row.payment), false);
  assert.equal(fullProfileSubmitBlockers({ preview: p,
    capabilities: ["entry_create", "submission_create"], submitting: false }).length, 0);
  assert.equal(buildFullProfileRow(p.rows[0]) !== null, true);
});

test("header canonical: STK / Tên ngân hàng / Tên chủ tài khoản, khong doi template", () => {
  for (const header of ["STK", "Tên ngân hàng", "Tên chủ tài khoản"]) {
    assert.equal(WORKER_PROFILE_TEMPLATE_HEADERS.includes(header), true, header);
  }
  assert.equal(workerProfileField("bank_name").canonicalHeader, "Tên ngân hàng");
  assert.equal(workerProfileField("bank_name").requirement, "optional");
  assert.equal(workerProfileField("account_number").requirement, "optional");
  assert.equal(workerProfileField("account_holder_name").requirement, "optional");
  assert.equal(workerProfileField("bank_id"), undefined);
});

test("source guards: khong con blocker/duong dan catalog ngan hang", () => {
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const previewSource = strip(readFileSync(
    new URL("./worker-profile-preview.ts", import.meta.url), "utf8"));
  for (const forbidden of ["PASTE_BANK_CATALOG_EMPTY", "source.banks", "catalogBlocker",
    "bankLabel", "bank_id"]) {
    assert.equal(previewSource.includes(forbidden), false, forbidden);
  }
  const batchSource = strip(readFileSync(new URL("./full-profile-batch.ts", import.meta.url),
    "utf8"));
  assert.equal(batchSource.includes("PROFILE_PAYMENT_BANK_REQUIRED"), false);
  assert.equal(batchSource.includes("bank_id"), false);
  assert.equal(batchSource.includes("bankLabel"), false);
  assert.equal(batchSource.includes("localStorage"), false);
  assert.equal(batchSource.includes("console."), false);

  const dialogSource = strip(readFileSync(new URL(
    "../../components/direct-entry/direct-entry-worker-profile-paste-dialog.tsx",
    import.meta.url), "utf8"));
  assert.equal(dialogSource.includes("bank_id"), false);
  assert.equal(dialogSource.includes("PASTE_BANK_CATALOG_EMPTY"), false);
  assert.equal(dialogSource.includes("catalogBlocker"), false);
  assert.equal((dialogSource.match(/postFullProfileBatch\(/g) ?? []).length, 1);
});

test("canonical labels va wording trung tinh cho metadata tai khoan", () => {
  const dialogSource = readFileSync(new URL(
    "../../components/direct-entry/direct-entry-worker-profile-paste-dialog.tsx",
    import.meta.url), "utf8");
  assert.match(dialogSource, /Thông tin tài khoản để đối chiếu/);
  assert.match(dialogSource, /\["STK", payment\.account_number/);
  assert.match(dialogSource, /\["Tên ngân hàng", optionalText\(payment\.bank_name\)\]/);
  assert.match(dialogSource,
    /\["Tên chủ tài khoản", optionalText\(payment\.account_holder_name\)\]/);
  for (const forbidden of ["lệnh chi trả", "sẵn sàng thanh toán", "bank catalog required"]) {
    assert.equal(dialogSource.includes(forbidden), false, forbidden);
  }
});
