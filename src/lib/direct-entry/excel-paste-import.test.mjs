import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildPasteBatchPayload,
  buildPastePreview,
  matchCatalogReference,
  normalizeCatalogMatchText,
  requiredCatalogDates,
} from "./excel-paste-import.ts";

const PROJECT_BAC = { id: "11111111-1111-4111-8111-111111111111", label: "Dự án Bắc" };
const PROJECT_NAM = { id: "11111111-1111-4111-8111-111111111112", label: "Dự án Nam" };
const RECRUITER_HRP = { id: "22222222-2222-4222-8222-222222222222", label: "CongHr1" };
const RECRUITER_VENDOR = { id: "22222222-2222-4222-8222-222222222223", label: "ChungVendor" };
const DATE = "2026-10-15";
const CATALOG = {
  projects: [PROJECT_BAC, PROJECT_NAM],
  recruiters: [RECRUITER_HRP, RECRUITER_VENDOR],
};
const CATALOGS = { [DATE]: CATALOG, "2026-01-05": CATALOG };
const HEADER = "Mã NLĐ\tNgày bắt đầu làm việc\tHọ tên\tDự án\tNgười tuyển\tLoại hình lao động";

function row(code, date, name, project, recruiter, labor) {
  return [code, date, name, project, recruiter, labor].join("\t");
}

function preview(text, options = {}) {
  return buildPastePreview({ text, catalogs: CATALOGS, ...options });
}

test("3 dong hop le: header tuy chon, TSV + CRLF, trailing blank, leading zero giu nguyen", () => {
  const text = [
    HEADER,
    row("hrp-2026-000123", "2026-10-15", "Nguyen Van A", PROJECT_BAC.id, RECRUITER_HRP.id, "Thời vụ"),
    row("hrp-2026-000124", "2026-10-15", "Nguyen Van B", PROJECT_BAC.label, RECRUITER_HRP.label, "Toàn thời gian"),
    row("hrp-2026-000007", "2026-10-15", "Nguyen Van C", PROJECT_NAM.label, RECRUITER_VENDOR.label, "TEMPORARY"),
    "",
    "",
  ].join("\r\n");
  const result = preview(text);
  assert.equal(result.validCount, 3);
  assert.equal(result.errorCount, 0);
  assert.equal(result.canSubmit, true);

  const payload = buildPasteBatchPayload(result.rows);
  assert.deepEqual(payload.map((item) => item.employee_code),
    ["hrp-2026-000123", "hrp-2026-000124", "hrp-2026-000007"]);
  assert.equal(payload[0].project_id, PROJECT_BAC.id);
  assert.equal(payload[1].project_id, PROJECT_BAC.id, "match theo display label");
  assert.equal(payload[1].recruiter_id, RECRUITER_HRP.id);
  assert.equal(payload[2].recruiter_id, RECRUITER_VENDOR.id);
  assert.equal(payload[2].labor_type, "TEMPORARY");
  assert.equal(payload[0].worker.display_name, "Nguyen Van A");
  assert.deepEqual(payload[0].worker.date_of_birth, { state: "omitted" });
  assert.deepEqual(Object.keys(payload[0]).sort(),
    ["employee_code", "first_work_date", "labor_type", "project_id", "recruiter_id", "worker"]);
  assert.deepEqual(Object.keys(payload[0].worker).sort(),
    ["address", "date_of_birth", "display_name", "national_id", "phone"]);
});

test("khong header van nhan; LF va TSV; hai dinh dang ngay", () => {
  const noHeader = preview([
    row("hrp-2026-000123", "2026-10-15", "A", PROJECT_BAC.id, RECRUITER_HRP.id, "Thời vụ"),
    row("hrp-2026-000124", "15/10/2026", "B", PROJECT_BAC.id, RECRUITER_HRP.id, "PERMANENT"),
  ].join("\n"));
  assert.equal(noHeader.canSubmit, true);
  assert.deepEqual(noHeader.rows.map((item) => item.firstWorkDate), ["2026-10-15", "2026-10-15"]);
  assert.deepEqual(noHeader.rows.map((item) => item.laborType), ["TEMPORARY", "PERMANENT"]);

  const singleDigit = preview(row("hrp-2026-000123", "5/1/2026", "A", PROJECT_BAC.id,
    RECRUITER_HRP.id, "Thời vụ"));
  assert.equal(singleDigit.canSubmit, true);
  assert.equal(singleDigit.rows[0].firstWorkDate, "2026-01-05");
});

test("formula chi duoc coi la text: khong evaluate, khong sinh so", () => {
  const result = preview(row("=SUM(A1:A3)", "2026-10-15", "A", PROJECT_BAC.id,
    RECRUITER_HRP.id, "Thời vụ"));
  assert.equal(result.rows[0].employeeCode, "=SUM(A1:A3)");
  assert.equal(result.canSubmit, false);
  assert.ok(result.issues.some((issue) => issue.column === 1));
  const payload = buildPasteBatchPayload(result.rows);
  assert.equal(payload[0].employee_code, "=SUM(A1:A3)");
  const source = readFileSync(new URL("./excel-paste-import.ts", import.meta.url), "utf8")
    + readFileSync(new URL("./excel-paste.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /eval\(|new Function\(|setTimeout\(["'`]/);
});

test("thieu/thua cot: loi theo dong, khong dong nao duoc gui, khong mutation", () => {
  const short = preview("hrp-2026-000123\t2026-10-15\tA\t" + PROJECT_BAC.id + "\t" + RECRUITER_HRP.id);
  assert.equal(short.canSubmit, false);
  assert.equal(short.validCount, 0);
  assert.equal(short.errorCount, 1);
  assert.equal(short.issues[0].column, null);
  assert.match(short.issues[0].message, /6 cột/);

  const long = preview(row("hrp-2026-000123", "2026-10-15", "A", PROJECT_BAC.id,
    RECRUITER_HRP.id, "Thời vụ") + "\tTHUA");
  assert.equal(long.canSubmit, false);
  assert.match(long.issues[0].message, /6 cột/);

  const empty = preview("");
  assert.equal(empty.canSubmit, false);
  assert.equal(empty.rows.length, 0);
  assert.match(empty.issues[0].message, /Chưa có dòng dữ liệu/);
});

test("duplicate trong khoi paste va duplicate voi dong chua luu tren trang", () => {
  const inPaste = preview([
    row("hrp-2026-000123", "2026-10-15", "A", PROJECT_BAC.id, RECRUITER_HRP.id, "Thời vụ"),
    row("hrp-2026-000123", "2026-10-15", "B", PROJECT_BAC.id, RECRUITER_HRP.id, "Thời vụ"),
  ].join("\n"));
  assert.equal(inPaste.canSubmit, false);
  assert.ok(inPaste.issues.some((issue) => issue.column === 1 && /trùng với dòng 1/.test(issue.message)));

  const withUnsaved = preview(
    row("hrp-2026-000124", "2026-10-15", "A", PROJECT_BAC.id, RECRUITER_HRP.id, "Thời vụ"),
    { existingEmployeeCodes: ["hrp-2026-000124"] },
  );
  assert.equal(withUnsaved.canSubmit, false);
  assert.ok(withUnsaved.issues.some((issue) =>
    issue.column === 1 && /trùng với một dòng chưa lưu/.test(issue.message)));

  const independent = preview(
    row("hrp-2026-000124", "2026-10-15", "A", PROJECT_BAC.id, RECRUITER_HRP.id, "Thời vụ"),
    { existingEmployeeCodes: ["hrp-2026-000999"] },
  );
  assert.equal(independent.canSubmit, true);
});

test("catalog: exact ID, exact label, trim + chuan hoa case; khong fuzzy", () => {
  assert.equal(normalizeCatalogMatchText("  CongHr1 "), "conghr1");
  assert.deepEqual(matchCatalogReference(PROJECT_BAC.id, CATALOG.projects), { ok: true, id: PROJECT_BAC.id });
  assert.deepEqual(matchCatalogReference("  " + PROJECT_BAC.label + " ", CATALOG.projects),
    { ok: true, id: PROJECT_BAC.id });
  assert.deepEqual(matchCatalogReference("dự án bắc", CATALOG.projects),
    { ok: true, id: PROJECT_BAC.id });
  // Khong fuzzy: thieu mot tu / viet tat deu la MISSING.
  assert.deepEqual(matchCatalogReference("Dự án", CATALOG.projects), { ok: false, reason: "MISSING" });
  assert.deepEqual(matchCatalogReference("Bắc", CATALOG.projects), { ok: false, reason: "MISSING" });
  assert.deepEqual(matchCatalogReference("", CATALOG.projects), { ok: false, reason: "EMPTY" });
});

test("catalog: missing / ambiguous bao loi ro tai dung dong va dung cot", () => {
  const ambiguous = {
    [DATE]: {
      projects: [PROJECT_BAC, { id: PROJECT_NAM.id, label: PROJECT_BAC.label }],
      recruiters: CATALOG.recruiters,
    },
  };
  const result = buildPastePreview({
    text: row("hrp-2026-000123", "2026-10-15", "A", PROJECT_BAC.label, RECRUITER_HRP.id, "Thời vụ"),
    catalogs: ambiguous,
  });
  assert.equal(result.canSubmit, false);
  assert.ok(result.issues.some((issue) => issue.column === 4 && /nhiều mục/.test(issue.message)));

  const missing = buildPastePreview({
    text: row("hrp-2026-000123", "2026-10-15", "A", "Dự án lạ", "Người lạ", "Thời vụ"),
    catalogs: CATALOGS,
  });
  assert.equal(missing.canSubmit, false);
  assert.ok(missing.issues.some((issue) => issue.column === 4 && /không có trong danh mục/.test(issue.message)));
  assert.ok(missing.issues.some((issue) => issue.column === 5 && /không có trong danh mục/.test(issue.message)));

  const noCatalog = buildPastePreview({
    text: row("hrp-2026-000123", "2026-10-15", "A", PROJECT_BAC.id, RECRUITER_HRP.id, "Thời vụ"),
    catalogs: {},
  });
  assert.equal(noCatalog.canSubmit, false);
  assert.ok(noCatalog.issues.some((issue) => issue.column === null && /Chưa tải được danh mục/.test(issue.message)));

  const wrongYear = preview(row("hrp-2025-000123", "2026-10-15", "A", PROJECT_BAC.id,
    RECRUITER_HRP.id, "Thời vụ"));
  assert.equal(wrongYear.canSubmit, false);
  assert.ok(wrongYear.issues.some((issue) => issue.column === 1 && /năm/.test(issue.message)));
});

test("requiredCatalogDates: moi effective date mot lan, da sap xep", () => {
  const text = [
    row("hrp-2026-000123", "2026-10-16", "A", PROJECT_BAC.id, RECRUITER_HRP.id, "Thời vụ"),
    row("hrp-2026-000124", "2026-10-15", "B", PROJECT_BAC.id, RECRUITER_HRP.id, "Thời vụ"),
    row("hrp-2026-000125", "2026-10-16", "C", PROJECT_BAC.id, RECRUITER_HRP.id, "Thời vụ"),
  ].join("\n");
  assert.deepEqual(requiredCatalogDates(text), ["2026-10-15", "2026-10-16"]);
});

test("preview khong mutation server: module thuan, khong fetch/localStorage/authority", () => {
  const source = readFileSync(new URL("./excel-paste-import.ts", import.meta.url), "utf8");
  for (const forbidden of ["fetch(", "XMLHttpRequest", "localStorage", "sessionStorage",
    "actor_id", "auth_subject", "app_user_id", "capability", "provider_type", "team_id",
    "storage_key", "signed", "checksum"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  // Khong co truong authority nao duoc dung trong payload gui len.
  assert.doesNotMatch(source, /auth_subject\s*[:,]|app_user_id\s*[:,]|scope_kind\s*:/);
  // Preview tra ve object thuan, khong mang theo File/Blob/URL.
  const result = preview(row("hrp-2026-000123", "2026-10-15", "A", PROJECT_BAC.id,
    RECRUITER_HRP.id, "Thời vụ"));
  assert.deepEqual(Object.keys(result.rows[0]).sort(),
    ["employeeCode", "firstWorkDate", "issues", "laborType", "line", "projectId",
      "projectText", "recruiterId", "recruiterText", "workerName"]);
});
