/**
 * PRE-W2-HF-UI-LABELS - hoi quy: UI hien nhan tieng Viet, request/luu giu enum canonical.
 *
 * Chot ba bat bien:
 *   1. Moi be mat UI doc nhan tu `display-labels` (mot nguon duy nhat), khong tu che bang rieng
 *      va khong render ma enum (ON/OFF/UNCONFIRMED/MALE/FEMALE/OTHER) nhu chu hien thi.
 *   2. Nhan thong nhat: ON -> "Đang làm", OFF -> "Đã nghỉ", UNCONFIRMED -> "Đang chờ việc";
 *      MALE -> "Nam", FEMALE -> "Nữ", OTHER -> "Khác".
 *   3. Luong nhap/luu van giu enum canonical; chi doi presentation.
 *
 * Toan bo gia tri trong file nay la GIA (synthetic).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseWorkerProfilePaste } from "./worker-profile-paste.ts";
import {
  GENDER_UI_LABELS,
  WORK_STATUS_UI_LABELS,
  genderUiLabel,
  workStatusUiLabel,
} from "./display-labels.ts";
import { WORKER_STATUS_LABELS, workerStatusLabel } from "./worker-operations-model.ts";
import {
  WORK_STATUS_LABELS,
  workerDetailsRows,
} from "./change-request-read-projection.ts";
import { employmentStatusLabel } from "./duplicate-cccd-report-contract.ts";
import { EMPLOYMENT_STATUS_LABELS } from "./submission-duplicate-cccd-contract.ts";

const REFERENCE_DATE = "2026-10-16";
const PROJECT = "Dự án Giả Bắc";
const RECRUITER = "Tuyển Dụng Giả 1";
const NAME = "Nguyễn Văn Giả A";

function singleRowTsv(pairs) {
  const header = pairs.map((pair) => pair[0]).join("\t");
  const body = pairs.map((pair) => pair[1]).join("\t");
  return header + "\n" + body;
}

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("nhan trang thai lam viec duoc thong nhat tren moi be mat", () => {
  assert.deepEqual(WORK_STATUS_UI_LABELS, {
    ON: "Đang làm",
    OFF: "Đã nghỉ",
    UNCONFIRMED: "Đang chờ việc",
    PENDING: "Đang chờ việc",
  });
  // Cac helper hien co deu tro ve cung mot bang nhan, khong con bang trung lap.
  assert.equal(WORK_STATUS_LABELS.UNCONFIRMED, "Đang chờ việc");
  assert.equal(WORKER_STATUS_LABELS.UNCONFIRMED, "Đang chờ việc");
  assert.equal(workerStatusLabel("UNCONFIRMED"), "Đang chờ việc");
  assert.equal(employmentStatusLabel("ON"), "Đang làm");
  assert.deepEqual(EMPLOYMENT_STATUS_LABELS, {
    ON: "Đang làm",
    UNCONFIRMED: "Đang chờ việc",
  });
  // Gia tri khong hop le -> fallback tieng Viet, khong bao gio tra ma/tieng Anh.
  assert.equal(workStatusUiLabel("khong_hop_le"), "Chưa có trạng thái");
  assert.equal(workStatusUiLabel("PENDING"), "Đang chờ việc");
});

test("nhan gioi tinh la tieng Viet va khong bao gio tra ma enum", () => {
  assert.deepEqual(GENDER_UI_LABELS, { MALE: "Nam", FEMALE: "Nữ", OTHER: "Khác" });
  assert.equal(genderUiLabel("MALE"), "Nam");
  assert.equal(genderUiLabel("FEMALE"), "Nữ");
  assert.equal(genderUiLabel("OTHER"), "Khác");
  // O trong giu rong; gia tri khong nhan dien -> "—" (khong hien ma tieng Anh).
  assert.equal(genderUiLabel(""), "");
  assert.equal(genderUiLabel(null), "");
  assert.equal(genderUiLabel("KHONG_CO"), "—");
  for (const code of ["MALE", "FEMALE", "OTHER"]) assert.notEqual(genderUiLabel(code), code);
  for (const code of ["ON", "OFF", "UNCONFIRMED", "PENDING"]) {
    assert.notEqual(workStatusUiLabel(code), code);
  }
});

test("luong de xuat/duyet sua NLĐ hien gioi tinh tieng Viet, khong hien MALE/FEMALE", () => {
  const worker = (gender) => ({
    display_name: NAME,
    gender: { state: "provided", value: gender },
    date_of_birth: { state: "omitted" },
    national_id: { state: "omitted" },
    address: { state: "omitted" },
    phone: { state: "omitted" },
  });
  assert.deepEqual(workerDetailsRows(worker("MALE"), worker("FEMALE")), [
    { field: "gender", label: "Giới tính", before: "Nam", after: "Nữ" },
  ]);
  assert.deepEqual(workerDetailsRows(worker("OTHER"), worker("OTHER")), []);
});

test("paste doc nhan tieng Viet nhung write model giu enum canonical", () => {
  const parsed = parseWorkerProfilePaste({
    text: singleRowTsv([
      ["Mã NLĐ", "hrp-2026-000123"],
      ["Dự án", PROJECT],
      ["Ngày bắt đầu làm việc", "2026-10-15"],
      ["Họ và tên", NAME],
      ["Tên NV Tuyển dụng", RECRUITER],
      ["Loại hình LĐ", "Thời vụ"],
      ["Giới tính", "Nam"],
      ["Tình trạng làm việc hiện tại", "Đang chờ việc"],
    ]),
    referenceDate: REFERENCE_DATE,
  });
  assert.equal(parsed.errorCount, 0);
  const row = parsed.rows[0];
  // Du lieu luu/request van la enum canonical...
  assert.deepEqual(row.worker.gender, { state: "provided", value: "MALE" });
  assert.deepEqual(row.employment.initial_status, { state: "provided", value: "UNCONFIRMED" });
  // ...trong khi UI doc chinh du lieu do va hien nhan tieng Viet.
  assert.equal(genderUiLabel(row.worker.gender.value), "Nam");
  assert.equal(workStatusUiLabel(row.employment.initial_status.value), "Đang chờ việc");
});

test("ID PENDING trong ô nhập được chuẩn hoá về enum lưu trữ UNCONFIRMED", () => {
  const parsed = parseWorkerProfilePaste({
    text: singleRowTsv([
      ["Mã NLĐ", "hrp-2026-000123"],
      ["Dự án", PROJECT],
      ["Ngày bắt đầu làm việc", "2026-10-15"],
      ["Họ và tên", NAME],
      ["Tên NV Tuyển dụng", "Tuyển dụng giả"],
      ["Loại hình LĐ", "Thời vụ"],
      ["Tình trạng làm việc hiện tại", "PENDING"],
    ]),
    referenceDate: REFERENCE_DATE,
  });
  assert.equal(parsed.errorCount, 0);
  assert.deepEqual(parsed.rows[0].employment.initial_status,
    { state: "provided", value: "UNCONFIRMED" });
});

test("lưới nhập liệu và hộp xem trước dùng helper nhan, không nối '· hiệu lực'", () => {
  const liveSource = source("../../components/direct-entry/direct-entry-live.tsx");
  assert.equal(liveSource.includes("· hiệu lực"), false,
    "o trang thai tren luoi khong con hau to ngay hieu luc");
  assert.match(liveSource, /workStatusUiLabel/);
  assert.match(liveSource, /genderUiLabel/);
  const previewSource = source(
    "../../components/direct-entry/direct-entry-worker-profile-paste-dialog.tsx");
  assert.match(previewSource, /workStatusUiLabel/);
  assert.match(previewSource, /genderUiLabel/);
  const gridSource = source(
    "../../components/direct-entry/direct-entry-spreadsheet-grid.tsx");
  assert.match(gridSource, /import \{ workStatusUiLabel \} from "@\/lib\/direct-entry\/display-labels"/);
  assert.match(gridSource, /column\.key === "initial_status"[\s\S]*?workStatusUiLabel\(status\)/);
  assert.match(gridSource, /option === "" \? "Đang làm việc \(mặc định\)"[\s\S]*?workStatusUiLabel\(option\)/);
});
