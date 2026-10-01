#!/usr/bin/env node
/**
 * Kiểm tra contract `daily-recruitment-breakdown/0.2` trên Supabase DEV.
 *
 * Chạy: pnpm fixtures:check
 *
 * Script tự dọn các source có drive_file_id bắt đầu bằng P0FIXTURE_ trước khi chạy
 * để kết quả tất định. Không dùng cho PROD.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  DAILY_RECRUITMENT_BREAKDOWN_RPC_NAME,
  UNKNOWN_DIMENSION_DISPLAY,
  UNKNOWN_DIMENSION_KEY,
  validateDailyRecruitmentBreakdownPayload,
} from "../src/lib/contracts/daily-recruitment-breakdown.ts";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const FIXTURES_DIR = path.join(process.cwd(), "docs", "contracts", "fixtures", "daily-recruitment-breakdown");
const FIXTURE_PREFIX = "P0FIXTURE_";
const DRIVE_FILE_A = "P0FIXTURE_DRIVE_FILE_A";
const DRIVE_FILE_B = "P0FIXTURE_DRIVE_FILE_B";
const BREAKDOWN_TABLE = "daily_recruitment_breakdown";

const EXPECTED_BREAKDOWN_COLUMNS = [
  "business_date",
  "created_at",
  "employment_type_display",
  "employment_type_key",
  "project_display",
  "project_key",
  "provider_type_display",
  "provider_type_key",
  "recruited_count",
  "recruiter_display",
  "recruiter_key",
  "snapshot_at",
  "source_id",
  "sync_run_id",
  "updated_at",
];

/** Tên cột bị cấm: dữ liệu cá nhân ứng viên không bao giờ được lưu. */
const FORBIDDEN_COLUMN_NAMES = [
  "ho_ten", "full_name", "candidate_name", "ung_vien", "candidate",
  "ngay_sinh", "birth_date", "date_of_birth", "dob",
  "cccd", "cmnd", "passport", "so_cccd",
  "dia_chi", "address", "sdt", "phone", "dien_thoai", "email",
  "ghi_chu", "note", "raw_row", "raw_data", "raw_payload",
];

const INVALID_FIXTURES = [
  ["j-unsupported-contract-version.json", "UNSUPPORTED_CONTRACT_VERSION"],
  ["j-unknown-field.json", "UNKNOWN_FIELD"],
  ["j-unknown-breakdown-field.json", "UNKNOWN_FIELD"],
  ["j-invalid-date.json", "INVALID_DATE"],
  ["j-invalid-value.json", "INVALID_VALUE"],
  ["j-invalid-dimension.json", "INVALID_DIMENSION"],
  ["j-rows-count-mismatch.json", "ROWS_COUNT_MISMATCH"],
  ["j-count-mismatch.json", "COUNT_MISMATCH"],
  ["j-duplicate-grain-key.json", "DUPLICATE_GRAIN_KEY"],
];

const results = [];
let failureCount = 0;

function check(caseId, label, ok, detail) {
  results.push({ caseId, label, ok: Boolean(ok), detail: detail === undefined ? "" : String(detail) });
  if (!ok) failureCount += 1;
}

const readFixture = async (name) => JSON.parse(await readFile(path.join(FIXTURES_DIR, name), "utf8"));
/** So sánh sâu, không phụ thuộc thứ tự key của object. */
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const eq = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const sumBy = (rows, field) => {
  const out = {};
  for (const row of rows) out[row[field]] = (out[row[field]] ?? 0) + row.recruited_count;
  return out;
};
const totalOf = (rows) => rows.reduce((sum, row) => sum + row.recruited_count, 0);

async function main() {
  const config = await loadSupabaseConfig();
  const admin = createClient(config.url, config.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(config.url, config.publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });

  console.log("Supabase project:", config.projectRef.slice(0, 4) + "***");
  console.log("Contract: daily-recruitment-breakdown/0.2");
  console.log("");

  const { error: resetError } = await admin.from("data_sources").delete().like("drive_file_id", FIXTURE_PREFIX + "%");
  check("RESET", "dọn source fixture P0FIXTURE_* không lỗi", !resetError, resetError && resetError.message);

  const getSource = async (driveFileId) => {
    const { data, error } = await admin
      .from("data_sources")
      .select("id, drive_file_id, last_seen_at, last_successful_sync_at")
      .eq("drive_file_id", driveFileId)
      .maybeSingle();
    if (error) throw new Error("đọc data_sources lỗi: " + error.message);
    return data;
  };

  const getRows = async (sourceId) => {
    const { data, error } = await admin
      .from(BREAKDOWN_TABLE)
      .select(
        "business_date, project_key, project_display, recruiter_key, recruiter_display, provider_type_key, provider_type_display, employment_type_key, employment_type_display, recruited_count"
      )
      .eq("source_id", sourceId)
      .order("business_date", { ascending: true })
      .order("project_key", { ascending: true })
      .order("recruiter_key", { ascending: true });
    if (error) throw new Error("đọc " + BREAKDOWN_TABLE + " lỗi: " + error.message);
    return data ?? [];
  };

  const getRun = async (runId) => {
    const { data, error } = await admin
      .from("sync_runs")
      .select("run_id, status, rows_read, rows_valid, rows_rejected, error_code")
      .eq("run_id", runId)
      .maybeSingle();
    if (error) throw new Error("đọc sync_runs lỗi: " + error.message);
    return data;
  };

  const countErrors = async (runId) => {
    const { data, error } = await admin.from("sync_errors").select("error_code").eq("run_id", runId);
    if (error) throw new Error("đọc sync_errors lỗi: " + error.message);
    return data ?? [];
  };

  const callRpc = async (payload, client = admin) => {
    const { data, error } = await client.rpc(DAILY_RECRUITMENT_BREAKDOWN_RPC_NAME, { p_payload: payload });
    return error ? { outcome: null, error } : { outcome: data, error: null };
  };

  // ======================================================= A — snapshot đầu
  const fixtureA = await readFixture("a-initial.json");
  {
    const ts = validateDailyRecruitmentBreakdownPayload(fixtureA);
    check("A", "fixture A hợp lệ theo TS contract", ts.ok, ts.ok ? "" : ts.message);

    const { outcome, error } = await callRpc(fixtureA);
    check("A", "RPC không lỗi transport", !error, error && error.message);
    check("A", "outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    check("A", "run_status = succeeded", outcome && outcome.run_status === "succeeded", outcome && outcome.run_status);

    const source = await getSource(DRIVE_FILE_A);
    const rows = await getRows(source.id);
    check("A", "5 dòng grain", rows.length === 5, rows.length);
    check("A", "tổng = 15", totalOf(rows) === 15, totalOf(rows));

    // Tổng theo ngày
    check("A", "tổng theo ngày: 10-01=10, 10-02=5", eq(sumBy(rows, "business_date"), { "2026-10-01": 10, "2026-10-02": 5 }), JSON.stringify(sumBy(rows, "business_date")));
    // Breakdown theo dự án (nhiều dự án trong cùng ngày)
    check("A", "breakdown dự án: A=6, B=9", eq(sumBy(rows, "project_display"), { "Dự án A": 6, "Dự án B": 9 }), JSON.stringify(sumBy(rows, "project_display")));
    // Breakdown theo người tuyển (nhiều người tuyển)
    check("A", "breakdown người tuyển: NVA=9, TTB=6", eq(sumBy(rows, "recruiter_display"), { "Nguyễn Văn A": 9, "Trần Thị B": 6 }), JSON.stringify(sumBy(rows, "recruiter_display")));
    // Breakdown theo HRP/Vendor
    check("A", "breakdown HRP/Vendor: HRP=9, Vendor=6", eq(sumBy(rows, "provider_type_display"), { HRP: 9, Vendor: 6 }), JSON.stringify(sumBy(rows, "provider_type_display")));
    // Breakdown theo loại hình làm việc
    check("A", "breakdown loại hình: Thời vụ=5, Chính thức=10", eq(sumBy(rows, "employment_type_display"), { "Thời vụ": 5, "Chính thức": 10 }), JSON.stringify(sumBy(rows, "employment_type_display")));
    // Kết hợp nhiều bộ lọc
    const combined = rows.filter(
      (r) => r.business_date === "2026-10-01" && r.project_display === "Dự án A" && r.provider_type_display === "HRP" && r.employment_type_display === "Thời vụ"
    );
    check("A", "kết hợp filter ngày+dự án+HRP+Thời vụ = 3", totalOf(combined) === 3, totalOf(combined));

    const run = await getRun(fixtureA.sync_run_id);
    check("A", "sync_runs succeeded 15/15/0", run && run.status === "succeeded" && run.rows_read === 15 && run.rows_valid === 15 && run.rows_rejected === 0, run && JSON.stringify(run));
  }

  // ============================================================ B — replay
  const fixtureB = await readFixture("b-replay.json");
  {
    const { outcome, error } = await callRpc(fixtureB);
    check("B", "RPC không lỗi transport", !error, error && error.message);
    check("B", "outcome = unchanged", outcome && outcome.outcome === "unchanged", outcome && outcome.outcome);
    check("B", "breakdown_rows_removed = 0", outcome && outcome.breakdown_rows_removed === 0, outcome && outcome.breakdown_rows_removed);
    const source = await getSource(DRIVE_FILE_A);
    const rows = await getRows(source.id);
    check("B", "vẫn 5 dòng, không duplicate", rows.length === 5, rows.length);
    check("B", "tổng vẫn 15", totalOf(rows) === 15, totalOf(rows));
    const run = await getRun(fixtureB.sync_run_id);
    check("B", "run replay vẫn được ghi", run && run.status === "succeeded", run && JSON.stringify(run));
  }

  // ======================================================== C — correction
  const fixtureC = await readFixture("c-correction.json");
  {
    const { outcome } = await callRpc(fixtureC);
    check("C", "outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    const source = await getSource(DRIVE_FILE_A);
    const rows = await getRows(source.id);
    const target = rows.find((r) => r.business_date === "2026-10-01" && r.project_display === "Dự án A" && r.employment_type_display === "Thời vụ");
    check("C", "sửa 3 -> 2 trên đúng một dòng", target && target.recruited_count === 2, target && target.recruited_count);
    check("C", "vẫn 5 dòng", rows.length === 5, rows.length);
    check("C", "tổng = 14", totalOf(rows) === 14, totalOf(rows));
  }

  // ==================================================== D — xóa một tổ hợp
  const fixtureD = await readFixture("d-row-removed.json");
  {
    const { outcome } = await callRpc(fixtureD);
    check("D", "outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    check("D", "breakdown_rows_removed = 1", outcome && outcome.breakdown_rows_removed === 1, outcome && outcome.breakdown_rows_removed);
    const source = await getSource(DRIVE_FILE_A);
    const rows = await getRows(source.id);
    check("D", "còn 4 dòng", rows.length === 4, rows.length);
    const removedGrain = (r) =>
      r.project_key === "dự án b" && r.recruiter_key === "trần thị b" &&
      r.provider_type_key === "vendor" && r.employment_type_key === "chính thức";
    check("D", "tổ hợp bị xóa (Dự án B/Trần Thị B/Vendor/Chính thức) không còn", !rows.some(removedGrain), JSON.stringify(rows.map((r) => [r.project_display, r.recruiter_display, r.provider_type_display, r.employment_type_display].join("/"))));
    check("D", "tổ hợp khác cùng dự án B/Chính thức vẫn còn", rows.some((r) => r.project_display === "Dự án B" && r.employment_type_display === "Chính thức"), JSON.stringify(rows.map((r) => r.project_display + "/" + r.employment_type_display)));
    check("D", "tổng = 10", totalOf(rows) === 10, totalOf(rows));
  }

  // ================================================ E — chuẩn hóa chuỗi bẩn
  const fixtureE = await readFixture("e-normalization-messy.json");
  {
    const { outcome } = await callRpc(fixtureE);
    check("E", "outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    const source = await getSource(DRIVE_FILE_A);
    const rows = await getRows(source.id);
    check("E", "1 dòng", rows.length === 1, rows.length);
    const row = rows[0] ?? {};
    check("E", "project_key trim+gộp space+lower = 'dự án a'", row.project_key === "dự án a", row.project_key);
    check("E", "project_display giữ chữ hoa/thường = 'Dự án A'", row.project_display === "Dự án A", row.project_display);
    check("E", "recruiter_key = 'nguyễn văn a' (lower tiếng Việt)", row.recruiter_key === "nguyễn văn a", row.recruiter_key);
    check("E", "recruiter_display = 'NGUYỄN VĂN A'", row.recruiter_display === "NGUYỄN VĂN A", row.recruiter_display);
    check("E", "provider_type_key = 'hrp'", row.provider_type_key === "hrp", row.provider_type_key);
    check("E", "provider_type_display = 'hrp'", row.provider_type_display === "hrp", row.provider_type_display);
    check("E", "employment_type_key = 'thời vụ'", row.employment_type_key === "thời vụ", row.employment_type_key);
    check("E", "employment_type_display = 'Thời vụ'", row.employment_type_display === "Thời vụ", row.employment_type_display);
  }

  // ============================== F — cùng grain sau chuẩn hóa (khác display)
  const fixtureF = await readFixture("f-normalization-match.json");
  {
    const { outcome } = await callRpc(fixtureF);
    check("F", "outcome = applied (display đổi)", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    const source = await getSource(DRIVE_FILE_A);
    const rows = await getRows(source.id);
    check("F", "VẪN 1 dòng: không tạo grain trùng do khác hoa/thường", rows.length === 1, rows.length);
    check("F", "display cập nhật theo payload mới", rows[0] && rows[0].recruiter_display === "Nguyễn Văn A" && rows[0].provider_type_display === "HRP", JSON.stringify(rows[0]));
    check("F", "tổng = 4", totalOf(rows) === 4, totalOf(rows));
  }

  // ======================================== G — trường phân loại bị trống
  const fixtureG = await readFixture("g-missing-dimensions.json");
  {
    const { outcome } = await callRpc(fixtureG);
    check("G", "outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    const source = await getSource(DRIVE_FILE_A);
    const rows = await getRows(source.id);
    check("G", "2 dòng", rows.length === 2, rows.length);
    const unknownRow = rows.find((r) => r.project_key === UNKNOWN_DIMENSION_KEY);
    check("G", "có dòng quy ước 'Không xác định'", Boolean(unknownRow), JSON.stringify(rows));
    if (unknownRow) {
      check("G", "cả 4 chiều = key __unknown__", [unknownRow.recruiter_key, unknownRow.provider_type_key, unknownRow.employment_type_key].every((k) => k === UNKNOWN_DIMENSION_KEY), JSON.stringify(unknownRow));
      check("G", "cả 4 chiều display = 'Không xác định'", [unknownRow.project_display, unknownRow.recruiter_display, unknownRow.provider_type_display, unknownRow.employment_type_display].every((d) => d === UNKNOWN_DIMENSION_DISPLAY), JSON.stringify(unknownRow));
      check("G", "count của nhóm không xác định = 2", unknownRow.recruited_count === 2, unknownRow.recruited_count);
    }
    check("G", "breakdown HRP/Vendor có cả 'Không xác định' và Vendor", eq(sumBy(rows, "provider_type_display"), { [UNKNOWN_DIMENSION_DISPLAY]: 2, Vendor: 1 }), JSON.stringify(sumBy(rows, "provider_type_display")));
  }

  // ================================================== H — hai source độc lập
  const fixtureH = await readFixture("h-source-b.json");
  {
    const { outcome } = await callRpc(fixtureH);
    check("H", "source B: outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    const sourceB = await getSource(DRIVE_FILE_B);
    const rowsB = await getRows(sourceB.id);
    check("H", "source B: 1 dòng, tổng 7", rowsB.length === 1 && totalOf(rowsB) === 7, rowsB.length + "/" + totalOf(rowsB));
    const sourceA = await getSource(DRIVE_FILE_A);
    const rowsA = await getRows(sourceA.id);
    check("H", "source A không đổi (2 dòng, tổng 3)", rowsA.length === 2 && totalOf(rowsA) === 3, rowsA.length + "/" + totalOf(rowsA));

    await callRpc(fixtureG);
    const rowsA2 = await getRows(sourceA.id);
    const rowsB2 = await getRows(sourceB.id);
    check("H", "ghi lại A không ảnh hưởng B", rowsA2.length === 2 && rowsB2.length === 1 && totalOf(rowsB2) === 7, rowsA2.length + "/" + rowsB2.length);
  }

  // ========================================== J — payload sai giữ nguyên snapshot
  const beforeInvalid = await getRows((await getSource(DRIVE_FILE_A)).id);
  for (const [file, expectedCode] of INVALID_FIXTURES) {
    const payload = await readFixture(file);
    const ts = validateDailyRecruitmentBreakdownPayload(payload);
    check("J", file + ": TS contract từ chối với " + expectedCode, !ts.ok && ts.errorCode === expectedCode, ts.ok ? "TS chấp nhận" : ts.errorCode);

    const { outcome, error } = await callRpc(payload);
    check("J", file + ": RPC không lỗi transport", !error, error && error.message);
    check("J", file + ": outcome = rejected", outcome && outcome.outcome === "rejected", outcome && outcome.outcome);
    check("J", file + ": error_code = " + expectedCode, outcome && outcome.error_code === expectedCode, outcome && outcome.error_code);

    const run = await getRun(payload.sync_run_id);
    check("J", file + ": sync_runs failed + error_code", run && run.status === "failed" && run.error_code === expectedCode, run && JSON.stringify(run));
    const errs = await countErrors(payload.sync_run_id);
    check("J", file + ": có sync_errors", errs.length >= 1 && errs[0].error_code === expectedCode, JSON.stringify(errs));
  }
  {
    const rows = await getRows((await getSource(DRIVE_FILE_A)).id);
    check("J", "snapshot của A KHÔNG đổi sau " + INVALID_FIXTURES.length + " payload sai", eq(rows, beforeInvalid), JSON.stringify(rows.map((r) => r.business_date + "/" + r.project_key + "=" + r.recruited_count)));
  }

  // ================================================== bảo vệ dữ liệu cá nhân
  {
    const client = new pg.Client({ connectionString: config.databaseUrl, ssl: buildSslOptions() });
    await client.connect();
    const { rows: cols } = await client.query(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name = any($1) order by table_name, column_name",
      [["data_sources", "sync_runs", BREAKDOWN_TABLE, "sync_errors"]]
    );
    await client.end();

    const breakdownCols = cols.filter((c) => c.table_name === BREAKDOWN_TABLE).map((c) => c.column_name);
    check("PII", "bảng aggregate có đúng tập cột mong đợi (không thêm cột ngoài ý muốn)", eq(breakdownCols, EXPECTED_BREAKDOWN_COLUMNS), JSON.stringify(breakdownCols));

    const offenders = cols.filter((c) => FORBIDDEN_COLUMN_NAMES.includes(c.column_name.toLowerCase()));
    check("PII", "không có cột dữ liệu cá nhân ứng viên ở bất kỳ bảng nào", offenders.length === 0, JSON.stringify(offenders));
  }

  // ============================================================ ẩn danh
  {
    const { outcome, error } = await callRpc(fixtureA, anon);
    check("SEC", "anon không gọi được ingestion RPC", Boolean(error) || !outcome, error ? error.code + " " + error.message : "anon gọi thành công (!)");

    const { data, error: readError } = await anon.from(BREAKDOWN_TABLE).select("business_date, recruited_count").limit(5);
    check("SEC", "anon không đọc được bảng aggregate", Boolean(readError) || (Array.isArray(data) && data.length === 0), readError ? readError.message : JSON.stringify(data));

    const { error: writeError } = await anon.from("data_sources").insert({ drive_file_id: "P0FIXTURE_ANON", file_name: "x", sheet_name: "y" });
    check("SEC", "anon không ghi được data_sources", Boolean(writeError), writeError ? writeError.message : "anon ghi thành công (!)");
  }

  // ============================================================= báo cáo
  console.log("");
  console.log("CASE  OK    KIỂM TRA");
  console.log("----  ----  --------");
  for (const row of results) {
    console.log(String(row.caseId).padEnd(5) + " " + (row.ok ? "PASS" : "FAIL") + "  " + row.label + (row.ok ? "" : "  -> " + row.detail));
  }
  console.log("");
  console.log("Tổng: " + results.length + " kiểm tra, " + (results.length - failureCount) + " pass, " + failureCount + " fail.");
  if (failureCount > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("FIXTURE CHECK THẤT BẠI:", error.message);
  process.exitCode = 1;
});
