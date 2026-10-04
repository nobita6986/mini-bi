import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildWorkerProfilePreview,
  createPasteCatalogResolver,
  maskAccountNumber,
  maskNationalId,
} from "./worker-profile-preview.ts";

// Gia tri GIA (synthetic); khong dung du lieu that cua Owner.
const REFERENCE_DATE = "2026-10-16";
const NAME = "Nguyễn Văn Giả A";
const NID = "012345678901";
const PHONE = "0900000001";

const CATALOGS = {
  "2026-10-15": {
    projects: [{ id: "11111111-1111-4111-8111-111111111111", label: "Dự án Giả Bắc" }],
    recruiters: [{ id: "22222222-2222-4222-8222-222222222222", label: "Tuyển Dụng Giả 1" }],
    banks: [{ id: "33333333-3333-4333-8333-333333333333", label: "Ngân hàng Giả" }],
  },
  "2026-11-01": {
    projects: [{ id: "11111111-1111-4111-8111-111111111112", label: "Dự án Giả Nam" }],
    recruiters: [{ id: "22222222-2222-4222-8222-222222222223", label: "Tuyển Dụng Giả 2" }],
    banks: [],
  },
};

function toTsv(rows) {
  const header = rows[0].map((pair) => pair[0]).join("\t");
  const body = rows.map((row) => row.map((pair) => pair[1]).join("\t")).join("\n");
  return header + "\n" + body;
}

/** Mot dong day du; `overrides` thay gia tri cua cot da co hoac them cot tuy chon moi. */
function row(code, date = "2026-10-15", overrides = {}) {
  const base = [["Mã NLĐ", code], ["Dự án", "Dự án Giả Bắc"],
    ["Ngày bắt đầu làm việc", date], ["Họ và tên", NAME],
    ["Tên NV Tuyển dụng", "Tuyển Dụng Giả 1"], ["Loại hình LĐ", "Thời vụ"]];
  const pairs = base.map(([header, value]) => [header, overrides[header] ?? value]);
  for (const [header, value] of Object.entries(overrides)) {
    if (!base.some(([existing]) => existing === header)) pairs.push([header, value]);
  }
  return pairs;
}

function loadCountTracking() {
  const counts = new Map();
  const loader = (date) => {
    counts.set(date, (counts.get(date) ?? 0) + 1);
    const source = CATALOGS[date];
    return source === undefined ? null
      : { projects: source.projects, recruiters: source.recruiters, banks: source.banks };
  };
  return { loader, counts };
}

function preview(text, options = {}) {
  const { loader } = loadCountTracking();
  return buildWorkerProfilePreview({ text, referenceDate: REFERENCE_DATE,
    resolver: createPasteCatalogResolver(loader), ...options });
}

test("resolver: moi effective date chi tai mot lan sau khi thanh cong; null thi thu lai", () => {
  let calls = 0;
  let ready = false;
  const resolver = createPasteCatalogResolver((date) => {
    calls += 1;
    if (!ready) return null;
    return CATALOGS[date];
  });
  assert.equal(resolver.resolve("2026-10-15"), null);
  assert.equal(resolver.loadCount("2026-10-15"), 1);
  ready = true;
  assert.equal(resolver.resolve("2026-10-15").projects.length, 1);
  assert.equal(resolver.resolve("2026-10-15").projects.length, 1);
  assert.equal(resolver.loadCount("2026-10-15"), 2, "1 lan that bai + 1 lan thanh cong");
  assert.equal(calls, 2);
  resolver.resolve("2026-11-01");
  assert.equal(resolver.loadCount("2026-11-01"), 1);
  assert.deepEqual(resolver.resolvedDates(), ["2026-10-15", "2026-11-01"]);
});

test("catalog: exact ID hoac exact label, khong fuzzy; missing/ambiguous la loi theo dong", () => {
  const byId = preview(toTsv([row("hrp-2026-000123", "2026-10-15", {
    "Dự án": "11111111-1111-4111-8111-111111111111",
    "Tên NV Tuyển dụng": "22222222-2222-4222-8222-222222222222",
  })]));
  assert.equal(byId.errorCount, 0);
  assert.equal(byId.rows[0].resolved.project_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(byId.rows[0].resolved.recruiter_id, "22222222-2222-4222-8222-222222222222");

  const byLabel = preview(toTsv([row("hrp-2026-000123", "2026-10-15", {
    "Dự án": "  dự án giả bắc  ", "Tên NV Tuyển dụng": "TUYỂN DỤNG GIẢ 1",
  })]));
  assert.equal(byLabel.errorCount, 0);
  assert.equal(byLabel.rows[0].resolved.project_id, "11111111-1111-4111-8111-111111111111");

  const fuzzy = preview(toTsv([row("hrp-2026-000123", "2026-10-15", {
    "Dự án": "Dự án Giả", "Tên NV Tuyển dụng": "Tuyển Dụng",
  })]));
  assert.equal(fuzzy.issues.some((item) =>
    item.code === "PASTE_CATALOG_MISSING" && item.field === "project_id"), true);
  assert.equal(fuzzy.rows[0].resolved.project_id, null);
  assert.equal(fuzzy.canProceed, false);

  const ambiguousResolver = createPasteCatalogResolver(() => ({
    projects: [{ id: "p-a", label: "Dự án Giả Bắc" }, { id: "p-b", label: "Dự án Giả Bắc" }],
    recruiters: CATALOGS["2026-10-15"].recruiters,
    banks: CATALOGS["2026-10-15"].banks,
  }));
  const ambiguous = buildWorkerProfilePreview({ text: toTsv([row("hrp-2026-000123")]),
    referenceDate: REFERENCE_DATE, resolver: ambiguousResolver });
  assert.equal(ambiguous.issues.some((item) =>
    item.code === "PASTE_CATALOG_AMBIGUOUS" && item.field === "project_id"), true);
});

test("catalog theo ngay hieu luc: hai ngay khac nhau dung hai danh muc", () => {
  const text = toTsv([
    row("hrp-2026-000001", "2026-10-15"),
    [["Mã NLĐ", "hrp-2026-000002"], ["Dự án", "Dự án Giả Nam"],
      ["Ngày bắt đầu làm việc", "2026-11-01"], ["Họ và tên", NAME],
      ["Tên NV Tuyển dụng", "Tuyển Dụng Giả 2"], ["Loại hình LĐ", "Thời vụ"]],
  ]);
  const result = preview(text);
  assert.equal(result.errorCount, 0);
  assert.deepEqual([...result.catalogDates], ["2026-10-15", "2026-11-01"]);
  assert.equal(result.rows[0].resolved.project_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(result.rows[1].resolved.project_id, "11111111-1111-4111-8111-111111111112");
});

test("catalog chua tai duoc => blocker ro o muc dong", () => {
  const resolver = createPasteCatalogResolver(() => null);
  const result = buildWorkerProfilePreview({ text: toTsv([row("hrp-2026-000123")]),
    referenceDate: REFERENCE_DATE, resolver });
  assert.equal(result.issues.some((item) => item.code === "PASTE_CATALOG_UNAVAILABLE"), true);
  assert.equal(result.canProceed, false);
  assert.equal(result.rows[0].resolved.project_id, null);
});

test("danh muc ngan hang rong: blocker ro, khong tu chuyen ten thanh ID", () => {
  const text = toTsv([row("hrp-2026-000001", "2026-11-01", {
    "Dự án": "Dự án Giả Nam", "Tên NV Tuyển dụng": "Tuyển Dụng Giả 2",
    "STK": "000123456789", "Tên ngân hàng": "Ngân hàng Giả",
    "Tên chủ tài khoản": "NGUYEN VAN GIA A",
  })]);
  const result = preview(text);
  assert.equal(result.catalogBlocker, true);
  assert.equal(result.issues.some((item) => item.code === "PASTE_BANK_CATALOG_EMPTY"), true);
  assert.equal(result.rows[0].resolved.bank_id, null);
  assert.equal(result.rows[0].labels.bank, "Ngân hàng Giả");
  assert.equal(result.canProceed, false);

  const withBank = preview(toTsv([row("hrp-2026-000123", "2026-10-15", {
    "STK": "000123456789", "Tên ngân hàng": "ngân hàng giả",
    "Tên chủ tài khoản": "NGUYEN VAN GIA A",
  })]));
  assert.equal(withBank.catalogBlocker, false);
  assert.equal(withBank.rows[0].resolved.bank_id, "33333333-3333-4333-8333-333333333333");
});

test("duplicate trong khoi paste: ma NLĐ va CCCD la loi, SDT la canh bao", () => {
  const duplicateCode = preview(toTsv([
    row("hrp-2026-000123"),
    row("hrp-2026-000123"),
  ]));
  assert.equal(duplicateCode.issues.some((item) =>
    item.code === "PASTE_DUPLICATE_EMPLOYEE_CODE" && item.severity === "error"), true);

  const duplicateNid = preview(toTsv([
    row("hrp-2026-000001", "2026-10-15", { "CMT/CCCD": NID }),
    row("hrp-2026-000002", "2026-10-15", { "CMT/CCCD": NID }),
  ]));
  assert.equal(duplicateNid.issues.some((item) =>
    item.code === "PASTE_DUPLICATE_NATIONAL_ID" && item.severity === "error"), true);

  const duplicatePhone = preview(toTsv([
    row("hrp-2026-000001", "2026-10-15", { "Số điện thoại": PHONE }),
    row("hrp-2026-000002", "2026-10-15", { "Số điện thoại": PHONE }),
  ]));
  assert.equal(duplicatePhone.issues.some((item) =>
    item.code === "PASTE_DUPLICATE_PHONE" && item.severity === "warning"), true);
  assert.equal(duplicatePhone.errorCount, 0);
});

test("duplicate voi dong chua luu do caller cung cap; khong doc React/storage", () => {
  const result = preview(toTsv([row("hrp-2026-000123")]), {
    existing: [{ employeeCode: "hrp-2026-000123" },
      { employeeCode: "hrp-2026-000999", nationalId: NID, phone: PHONE }],
  });
  assert.equal(result.issues.some((item) =>
    item.code === "PASTE_EXISTING_EMPLOYEE_CODE" && item.severity === "error"), true);

  const identity = preview(toTsv([row("hrp-2026-000123", "2026-10-15",
    { "CMT/CCCD": NID, "Số điện thoại": PHONE })]), {
    existing: [{ nationalId: NID, phone: PHONE }],
  });
  assert.equal(identity.issues.some((item) => item.code === "PASTE_EXISTING_NATIONAL_ID"), true);
  assert.equal(identity.issues.some((item) => item.code === "PASTE_EXISTING_PHONE"), true);

  const source = readFileSync(new URL("./worker-profile-preview.ts", import.meta.url), "utf8");
  for (const forbidden of ["fetch(", "localStorage.", "sessionStorage.", "indexedDB.",
    "document.cookie", "console.", "React", "window."]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(source.includes("useState"), false);
});

test("preview: thong ke, canProceed va khong chua truong authority/server DTO", () => {
  const result = preview(toTsv([
    row("hrp-2026-000001"),
    row("hrp-2026-000002", "2026-10-15", { "Dự án": "Dự án không tồn tại" }),
  ]));
  assert.equal(result.totalRows, 2);
  assert.equal(result.validRows, 1);
  assert.equal(result.errorCount >= 1, true);
  assert.equal(result.canProceed, false);
  assert.equal(result.rows[0].canProceed, true);
  assert.equal(result.rows[1].canProceed, false);
  assert.equal(result.contractVersion, "worker-profile/1.0");

  const serialized = JSON.stringify(result);
  for (const forbidden of ["actor", "capability", "scope", "storage_key", "checksum", "bucket",
    "signed", "submission_id", "entry_ids", "document_id"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("mask CCCD/STK: chi giu 4 ky tu cuoi, khong lo gia tri day du", () => {
  assert.equal(maskNationalId("012345678901"), "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u20228901");
  assert.equal(maskAccountNumber("000123456789"),
    "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u20226789");
  assert.equal(maskNationalId("012345678"), "\u2022\u2022\u2022\u2022\u20225678");
  assert.equal(maskNationalId("12"), "\u2022\u2022");
  assert.equal(maskNationalId("012345678901").includes("012345678901"), false);
});
