#!/usr/bin/env node
/**
 * Kiểm tra contract `daily-recruitment-breakdown/0.2` (R1) trên Supabase DEV.
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
  INVALID_DIMENSION_DISPLAY,
  INVALID_DIMENSION_KEY,
  RECRUITMENT_SOURCE_FAILURE_RPC_NAME,
  UNKNOWN_DIMENSION_DISPLAY,
  UNKNOWN_DIMENSION_KEY,
  validateDailyRecruitmentBreakdownPayload,
  validateRecruitmentSourceFailurePayload,
} from "../src/lib/contracts/daily-recruitment-breakdown.ts";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const FIXTURES_DIR = path.join(process.cwd(), "docs", "contracts", "fixtures", "daily-recruitment-breakdown");
const FIXTURE_PREFIX = "P0FIXTURE_";
const DRIVE_FILE_A = "P0FIXTURE_DRIVE_FILE_A";
const DRIVE_FILE_B = "P0FIXTURE_DRIVE_FILE_B";
const BREAKDOWN_TABLE = "daily_recruitment_breakdown";
const RUNS_TABLE = "sync_runs";
const ERRORS_TABLE = "sync_errors";
const SOURCES_TABLE = "data_sources";

const EXPECTED_BREAKDOWN_COLUMNS = [
  "business_date", "created_at", "employment_type_display", "employment_type_key",
  "project_display", "project_key", "provider_type_display", "provider_type_key",
  "recruited_count", "recruiter_display", "recruiter_key", "snapshot_at",
  "source_id", "sync_run_id", "updated_at",
];

/** Tên cột bị cấm: dữ liệu cá nhân ứng viên không bao giờ được lưu. */
const FORBIDDEN_COLUMN_NAMES = [
  "ho_ten", "full_name", "candidate_name", "ung_vien", "candidate",
  "ngay_sinh", "birth_date", "date_of_birth", "dob",
  "cccd", "cmnd", "passport", "so_cccd",
  "dia_chi", "address", "sdt", "phone", "dien_thoai", "email",
  "ghi_chu", "note", "raw_row", "raw_data", "raw_payload",
];

const INVALID_PAYLOADS = [
  ["x-unsupported-contract-version.json", "UNSUPPORTED_CONTRACT_VERSION"],
  ["x-unknown-field.json", "UNKNOWN_FIELD"],
  ["x-unknown-breakdown-field.json", "UNKNOWN_FIELD"],
  ["x-pii-in-row-issue.json", "UNKNOWN_FIELD"],
  ["x-invalid-date.json", "INVALID_DATE"],
  ["x-invalid-value.json", "INVALID_VALUE"],
  ["x-invalid-dimension.json", "INVALID_DIMENSION"],
  ["x-invalid-uuid-version.json", "INVALID_SYNC_RUN_ID"],
  ["x-rows-count-mismatch.json", "ROWS_COUNT_MISMATCH"],
  ["x-count-mismatch.json", "COUNT_MISMATCH"],
  ["x-warning-count-mismatch.json", "WARNING_COUNT_MISMATCH"],
  ["x-invalid-warning-counts.json", "INVALID_WARNING_COUNTS"],
  ["x-rejected-count-mismatch.json", "REJECTED_COUNT_MISMATCH"],
  ["x-mixed-row-issue-level.json", "MIXED_ROW_ISSUE_LEVEL"],
  ["x-issue-linkage-mismatch.json", "ISSUE_LINKAGE_MISMATCH"],
  ["x-duplicate-grain-key.json", "DUPLICATE_GRAIN_KEY"],
];

/**
 * Payload có sync_run_id không phải UUID v4 thì RPC không thể ghi sync_runs
 * (không có định danh hợp lệ để tham chiếu) — đây là giới hạn có chủ đích.
 */
const PAYLOADS_WITHOUT_RUN_LOG = new Set(["x-invalid-uuid-version.json"]);

const results = [];
let failureCount = 0;

function check(caseId, label, ok, detail) {
  results.push({ caseId, label, ok: Boolean(ok), detail: detail === undefined ? "" : String(detail) });
  if (!ok) failureCount += 1;
}

const readFixture = async (name) => JSON.parse(await readFile(path.join(FIXTURES_DIR, name), "utf8"));
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
  console.log("Contract: daily-recruitment-breakdown/0.2 (R1)");
  console.log("");

  const { error: resetError } = await admin.from(SOURCES_TABLE).delete().like("drive_file_id", FIXTURE_PREFIX + "%");
  check("RESET", "dọn source fixture P0FIXTURE_* không lỗi", !resetError, resetError && resetError.message);

  const getSource = async (driveFileId) => {
    const { data, error } = await admin
      .from(SOURCES_TABLE)
      .select("id, drive_file_id, last_seen_at, last_successful_sync_at")
      .eq("drive_file_id", driveFileId)
      .maybeSingle();
    if (error) throw new Error("đọc data_sources lỗi: " + error.message);
    return data;
  };
  const getRows = async (sourceId) => {
    const { data, error } = await admin
      .from(BREAKDOWN_TABLE)
      .select("business_date, project_key, project_display, recruiter_key, recruiter_display, provider_type_key, provider_type_display, employment_type_key, employment_type_display, recruited_count")
      .eq("source_id", sourceId)
      .order("business_date", { ascending: true })
      .order("project_key", { ascending: true })
      .order("recruiter_key", { ascending: true });
    if (error) throw new Error("đọc " + BREAKDOWN_TABLE + " lỗi: " + error.message);
    return data ?? [];
  };
  const getRun = async (runId) => {
    const { data, error } = await admin
      .from(RUNS_TABLE)
      .select("run_id, status, rows_read, rows_valid, rows_rejected, rows_warned, warning_issues, error_code")
      .eq("run_id", runId)
      .maybeSingle();
    if (error) throw new Error("đọc sync_runs lỗi: " + error.message);
    return data;
  };
  const getIssues = async (runId) => {
    const { data, error } = await admin
      .from(ERRORS_TABLE)
      .select("source_row_number, issue_level, error_code")
      .eq("run_id", runId)
      .order("error_code", { ascending: true });
    if (error) throw new Error("đọc sync_errors lỗi: " + error.message);
    return data ?? [];
  };
  const callRpc = async (payload, client = admin) => {
    const { data, error } = await client.rpc(DAILY_RECRUITMENT_BREAKDOWN_RPC_NAME, { p_payload: payload });
    return error ? { outcome: null, error } : { outcome: data, error: null };
  };
  const callFailureRpc = async (payload, client = admin) => {
    const { data, error } = await client.rpc(RECRUITMENT_SOURCE_FAILURE_RPC_NAME, { p_payload: payload });
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
    check("A", "tổng theo ngày: 10-01=10, 10-02=5", eq(sumBy(rows, "business_date"), { "2026-10-01": 10, "2026-10-02": 5 }), JSON.stringify(sumBy(rows, "business_date")));
    check("A", "breakdown dự án: A=6, B=9", eq(sumBy(rows, "project_display"), { "Dự án A": 6, "Dự án B": 9 }), JSON.stringify(sumBy(rows, "project_display")));
    check("A", "breakdown người tuyển: NVA=9, TTB=6", eq(sumBy(rows, "recruiter_display"), { "Nguyễn Văn A": 9, "Trần Thị B": 6 }), JSON.stringify(sumBy(rows, "recruiter_display")));
    check("A", "breakdown HRP/Vendor: HRP=9, Vendor=6", eq(sumBy(rows, "provider_type_display"), { HRP: 9, Vendor: 6 }), JSON.stringify(sumBy(rows, "provider_type_display")));
    check("A", "breakdown loại hình: Thời vụ=5, Chính thức=10", eq(sumBy(rows, "employment_type_display"), { "Thời vụ": 5, "Chính thức": 10 }), JSON.stringify(sumBy(rows, "employment_type_display")));
    const combined = rows.filter((r) => r.business_date === "2026-10-01" && r.project_display === "Dự án A" && r.provider_type_display === "HRP" && r.employment_type_display === "Thời vụ");
    check("A", "kết hợp filter ngày+dự án+HRP+Thời vụ = 3", totalOf(combined) === 3, totalOf(combined));
    const run = await getRun(fixtureA.sync_run_id);
    check("A", "sync_runs succeeded 15/15/0 warned 0", run && run.status === "succeeded" && run.rows_read === 15 && run.rows_valid === 15 && run.rows_rejected === 0 && run.rows_warned === 0 && run.warning_issues === 0, run && JSON.stringify(run));
    check("A", "last_successful_sync_at đã được đặt", Boolean(source.last_successful_sync_at), source.last_successful_sync_at);
  }

  // ============================================================ B — replay
  const fixtureB = await readFixture("b-replay.json");
  {
    const { outcome } = await callRpc(fixtureB);
    check("B", "outcome = unchanged", outcome && outcome.outcome === "unchanged", outcome && outcome.outcome);
    check("B", "breakdown_rows_removed = 0", outcome && outcome.breakdown_rows_removed === 0, outcome && outcome.breakdown_rows_removed);
    const rows = await getRows((await getSource(DRIVE_FILE_A)).id);
    check("B", "vẫn 5 dòng, tổng 15", rows.length === 5 && totalOf(rows) === 15, rows.length + "/" + totalOf(rows));
  }

  // ======================================================== C — correction
  {
    const fixtureC = await readFixture("c-correction.json");
    const { outcome } = await callRpc(fixtureC);
    check("C", "outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    const rows = await getRows((await getSource(DRIVE_FILE_A)).id);
    const target = rows.find((r) => r.business_date === "2026-10-01" && r.project_display === "Dự án A" && r.employment_type_display === "Thời vụ");
    check("C", "sửa 3 -> 2 trên đúng một dòng", target && target.recruited_count === 2, target && target.recruited_count);
    check("C", "tổng = 14", totalOf(rows) === 14, totalOf(rows));
  }

  // ==================================================== D — xóa một tổ hợp
  {
    const fixtureD = await readFixture("d-row-removed.json");
    const { outcome } = await callRpc(fixtureD);
    check("D", "outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    check("D", "breakdown_rows_removed = 1", outcome && outcome.breakdown_rows_removed === 1, outcome && outcome.breakdown_rows_removed);
    const rows = await getRows((await getSource(DRIVE_FILE_A)).id);
    const removedGrain = (r) => r.project_key === "dự án b" && r.recruiter_key === "trần thị b" && r.provider_type_key === "vendor" && r.employment_type_key === "chính thức";
    check("D", "tổ hợp bị xóa không còn", !rows.some(removedGrain), JSON.stringify(rows.length));
    check("D", "còn 4 dòng, tổng 10", rows.length === 4 && totalOf(rows) === 10, rows.length + "/" + totalOf(rows));
  }

  // ================================================ E — chuẩn hóa chuỗi bẩn
  {
    const fixtureE = await readFixture("e-normalization-messy.json");
    const { outcome } = await callRpc(fixtureE);
    check("E", "outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    const rows = await getRows((await getSource(DRIVE_FILE_A)).id);
    const row = rows[0] ?? {};
    check("E", "1 dòng", rows.length === 1, rows.length);
    check("E", "project_key = 'dự án a'", row.project_key === "dự án a", row.project_key);
    check("E", "project_display = 'Dự án A'", row.project_display === "Dự án A", row.project_display);
    check("E", "recruiter_key = 'nguyễn văn a'", row.recruiter_key === "nguyễn văn a", row.recruiter_key);
    check("E", "recruiter_display = 'NGUYỄN VĂN A'", row.recruiter_display === "NGUYỄN VĂN A", row.recruiter_display);
    check("E", "provider key 'hrp' + display canonical 'HRP'", row.provider_type_key === "hrp" && row.provider_type_display === "HRP", row.provider_type_key + "/" + row.provider_type_display);
    check("E", "employment key 'thời vụ' + display canonical 'Thời vụ'", row.employment_type_key === "thời vụ" && row.employment_type_display === "Thời vụ", row.employment_type_key + "/" + row.employment_type_display);
  }

  // ============================== F — cùng grain sau chuẩn hóa (khác display)
  {
    const fixtureF = await readFixture("f-normalization-match.json");
    const { outcome } = await callRpc(fixtureF);
    check("F", "outcome = applied (display đổi)", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    const rows = await getRows((await getSource(DRIVE_FILE_A)).id);
    check("F", "VẪN 1 dòng", rows.length === 1, rows.length);
    check("F", "display cập nhật", rows[0] && rows[0].recruiter_display === "Nguyễn Văn A", JSON.stringify(rows[0]));
  }

  // ======================================== G — trường phân loại bị trống
  {
    const fixtureG = await readFixture("g-missing-dimensions.json");
    const { outcome } = await callRpc(fixtureG);
    check("G", "outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    check("G", "run_status = succeeded (không warning)", outcome && outcome.run_status === "succeeded", outcome && outcome.run_status);
    const rows = await getRows((await getSource(DRIVE_FILE_A)).id);
    const unknownRow = rows.find((r) => r.project_key === UNKNOWN_DIMENSION_KEY);
    check("G", "có dòng quy ước 'Không xác định'", Boolean(unknownRow), JSON.stringify(rows));
    if (unknownRow) {
      check("G", "cả 4 chiều = key __unknown__", [unknownRow.recruiter_key, unknownRow.provider_type_key, unknownRow.employment_type_key].every((k) => k === UNKNOWN_DIMENSION_KEY), JSON.stringify(unknownRow));
      check("G", "cả 4 chiều display = 'Không xác định'", [unknownRow.project_display, unknownRow.recruiter_display, unknownRow.provider_type_display, unknownRow.employment_type_display].every((d) => d === UNKNOWN_DIMENSION_DISPLAY), JSON.stringify(unknownRow));
    }
    const run = await getRun(fixtureG.sync_run_id);
    check("G", "sync_runs rows_warned = 0", run && run.rows_warned === 0 && run.warning_issues === 0, run && JSON.stringify(run));
  }

  // ================================================== H — hai source độc lập
  {
    const fixtureH = await readFixture("h-source-b.json");
    const { outcome } = await callRpc(fixtureH);
    check("H", "source B: outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    const sourceB = await getSource(DRIVE_FILE_B);
    const rowsB = await getRows(sourceB.id);
    check("H", "source B: 1 dòng, tổng 7", rowsB.length === 1 && totalOf(rowsB) === 7, rowsB.length + "/" + totalOf(rowsB));
    const rowsA = await getRows((await getSource(DRIVE_FILE_A)).id);
    check("H", "source A không đổi (2 dòng, tổng 3)", rowsA.length === 2 && totalOf(rowsA) === 3, rowsA.length + "/" + totalOf(rowsA));
  }

  // ==================================== K — canonical hóa sentinel và danh mục
  {
    const fixtureK = await readFixture("k-sentinel-canonicalization.json");
    const { outcome } = await callRpc(fixtureK);
    check("K", "outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    const rows = await getRows((await getSource(DRIVE_FILE_A)).id);
    const hrpRow = rows.find((r) => r.provider_type_key === "hrp");
    const unknownRow = rows.find((r) => r.provider_type_key === UNKNOWN_DIMENSION_KEY);
    check("K", "provider ' hrp ' -> key 'hrp' + display 'HRP'", Boolean(hrpRow) && hrpRow.provider_type_display === "HRP", JSON.stringify(hrpRow));
    check("K", "employment 'chính   thức' -> key 'chính thức' + display 'Chính thức'", Boolean(hrpRow) && hrpRow.employment_type_key === "chính thức" && hrpRow.employment_type_display === "Chính thức", JSON.stringify(hrpRow));
    check("K", "dòng null -> key __unknown__ + display 'Không xác định'", Boolean(unknownRow) && unknownRow.provider_type_display === UNKNOWN_DIMENSION_DISPLAY && unknownRow.employment_type_display === UNKNOWN_DIMENSION_DISPLAY, JSON.stringify(unknownRow));
    const run = await getRun(fixtureK.sync_run_id);
    check("K", "run succeeded, không warning", run && run.status === "succeeded" && run.rows_warned === 0, run && JSON.stringify(run));
  }

  // ===================== I — PARTIAL do có hàng bị loại (vẫn publish aggregate)
  const sourceA = await getSource(DRIVE_FILE_A);
  const lsaAfterK = sourceA.last_successful_sync_at;
  {
    const fixtureI = await readFixture("i-partial-errors.json");
    const ts = validateDailyRecruitmentBreakdownPayload(fixtureI);
    check("I", "fixture hợp lệ theo TS contract", ts.ok, ts.ok ? "" : ts.message);
    const { outcome, error } = await callRpc(fixtureI);
    check("I", "RPC không lỗi transport", !error, error && error.message);
    check("I", "outcome = applied (PARTIAL vẫn publish)", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    check("I", "run_status = partial", outcome && outcome.run_status === "partial", outcome && outcome.run_status);

    const rows = await getRows(sourceA.id);
    check("I", "aggregate ĐÃ bị thay bằng snapshot partial (2 dòng, tổng 5)", rows.length === 2 && totalOf(rows) === 5, rows.length + "/" + totalOf(rows));
    check("I", "không còn dữ liệu của 2026-10-09", !rows.some((r) => r.business_date === "2026-10-09"), JSON.stringify(rows.map((r) => r.business_date)));

    const run = await getRun(fixtureI.sync_run_id);
    check("I", "sync_runs partial 7/5/2 warned 0", run && run.status === "partial" && run.rows_read === 7 && run.rows_valid === 5 && run.rows_rejected === 2 && run.rows_warned === 0, run && JSON.stringify(run));
    const issues = await getIssues(fixtureI.sync_run_id);
    check("I", "sync_errors 2 dòng issue_level=error", issues.length === 2 && issues.every((i) => i.issue_level === "error"), JSON.stringify(issues));
    check("I", "có MISSING_DATE và INVALID_DATE", eq(issues.map((i) => i.error_code).sort(), ["INVALID_DATE", "MISSING_DATE"]), JSON.stringify(issues.map((i) => i.error_code)));

    const after = await getSource(DRIVE_FILE_A);
    check("I", "last_successful_sync_at KHÔNG đổi khi partial", after.last_successful_sync_at === lsaAfterK, String(after.last_successful_sync_at) + " vs " + String(lsaAfterK));
  }

  // ============ J — PARTIAL do cảnh báo: __invalid__ + một hàng hai warning
  {
    const fixtureJ = await readFixture("j-partial-warnings.json");
    const ts = validateDailyRecruitmentBreakdownPayload(fixtureJ);
    check("J", "fixture hợp lệ theo TS contract", ts.ok, ts.ok ? "" : ts.message);
    const { outcome, error } = await callRpc(fixtureJ);
    check("J", "RPC không lỗi transport", !error, error && error.message);
    check("J", "outcome = applied (PARTIAL vẫn publish)", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    check("J", "run_status = partial", outcome && outcome.run_status === "partial", outcome && outcome.run_status);
    check("J", "response rows_warned=3, warning_issues=4", outcome && outcome.rows_warned === 3 && outcome.warning_issues === 4, outcome && outcome.rows_warned + "/" + outcome.warning_issues);

    const rows = await getRows(sourceA.id);
    check("J", "aggregate đã thay (3 dòng, tổng 7)", rows.length === 3 && totalOf(rows) === 7, rows.length + "/" + totalOf(rows));
    check("J", "HRP/Vendor sai -> 'Không hợp lệ' = 6, Vendor = 1", eq(sumBy(rows, "provider_type_display"), { [INVALID_DIMENSION_DISPLAY]: 6, Vendor: 1 }), JSON.stringify(sumBy(rows, "provider_type_display")));
    check("J", "loại hình sai -> 'Không hợp lệ' = 5, Thời vụ = 2", eq(sumBy(rows, "employment_type_display"), { [INVALID_DIMENSION_DISPLAY]: 5, "Thời vụ": 2 }), JSON.stringify(sumBy(rows, "employment_type_display")));
    check("J", "có dòng key __invalid__ cho cả hai chiều", rows.some((r) => r.provider_type_key === INVALID_DIMENSION_KEY) && rows.some((r) => r.employment_type_key === INVALID_DIMENSION_KEY), JSON.stringify(rows.map((r) => r.provider_type_key + "/" + r.employment_type_key)));

    const run = await getRun(fixtureJ.sync_run_id);
    check("J", "sync_runs partial 7/7/0 warned 3 warning_issues 4", run && run.status === "partial" && run.rows_read === 7 && run.rows_valid === 7 && run.rows_rejected === 0 && run.rows_warned === 3 && run.warning_issues === 4, run && JSON.stringify(run));
    const issues = await getIssues(fixtureJ.sync_run_id);
    check("J", "sync_errors 4 dòng issue_level=warning", issues.length === 4 && issues.every((i) => i.issue_level === "warning"), JSON.stringify(issues));
    check("J", "hàng 22 có 2 warning", issues.filter((i) => i.source_row_number === 22).length === 2, JSON.stringify(issues));

    const after = await getSource(DRIVE_FILE_A);
    check("J", "last_successful_sync_at vẫn không đổi", after.last_successful_sync_at === lsaAfterK, String(after.last_successful_sync_at));
  }

  const snapshotAfterJ = await getRows(sourceA.id);

  // ================= L/M — lỗi đọc nguồn: KHÔNG thay snapshot, KHÔNG đổi last success
  {
    const fixtureL = await readFixture("l-source-failure.json");
    const ts = validateRecruitmentSourceFailurePayload(fixtureL);
    check("L", "fixture hợp lệ theo TS contract", ts.ok, ts.ok ? "" : ts.message);
    const { outcome, error } = await callFailureRpc(fixtureL);
    check("L", "RPC lỗi nguồn không lỗi transport", !error, error && error.message);
    check("L", "outcome = recorded", outcome && outcome.outcome === "recorded", outcome && outcome.outcome);
    check("L", "snapshot_unchanged = true", outcome && outcome.snapshot_unchanged === true, outcome && JSON.stringify(outcome));
    check("L", "response báo đúng số dòng hiện hành", outcome && outcome.breakdown_rows_current === 3 && outcome.recruited_count_total === 7, outcome && outcome.breakdown_rows_current + "/" + outcome.recruited_count_total);

    const run = await getRun(fixtureL.sync_run_id);
    check("L", "sync_runs status = failed", run && run.status === "failed", run && JSON.stringify(run));
    const issues = await getIssues(fixtureL.sync_run_id);
    check("L", "sync_errors có SOURCE_READ_FAILED", issues.some((i) => i.error_code === "SOURCE_READ_FAILED" && i.issue_level === "error"), JSON.stringify(issues));

    const rows = await getRows(sourceA.id);
    check("L", "aggregate GIỮ NGUYÊN sau lỗi đọc nguồn", eq(rows, snapshotAfterJ), JSON.stringify(rows.map((r) => r.business_date + "=" + r.recruited_count)));
    const after = await getSource(DRIVE_FILE_A);
    check("L", "last_successful_sync_at KHÔNG đổi", after.last_successful_sync_at === lsaAfterK, String(after.last_successful_sync_at));

    const fixtureM = await readFixture("m-source-failure-not-native.json");
    const snapshotB = await getRows((await getSource(DRIVE_FILE_B)).id);
    const lsaB = (await getSource(DRIVE_FILE_B)).last_successful_sync_at;
    const resM = await callFailureRpc(fixtureM);
    check("M", "FILE_NOT_NATIVE_SHEET: outcome = recorded", resM.outcome && resM.outcome.outcome === "recorded", resM.outcome && resM.outcome.outcome);
    const runM = await getRun(fixtureM.sync_run_id);
    check("M", "sync_runs failed + error_code", runM && runM.status === "failed" && runM.error_code === "FILE_NOT_NATIVE_SHEET", runM && JSON.stringify(runM));
    const rowsB = await getRows((await getSource(DRIVE_FILE_B)).id);
    check("M", "aggregate source B giữ nguyên", eq(rowsB, snapshotB), JSON.stringify(rowsB.length));
    const afterB = await getSource(DRIVE_FILE_B);
    check("M", "last_successful_sync_at của B không đổi", afterB.last_successful_sync_at === lsaB, String(afterB.last_successful_sync_at));
  }

  // ========================================== X — payload sai giữ nguyên snapshot
  for (const [file, expectedCode] of INVALID_PAYLOADS) {
    const payload = await readFixture(file);
    const ts = validateDailyRecruitmentBreakdownPayload(payload);
    check("X", file + ": TS contract từ chối với " + expectedCode, !ts.ok && ts.errorCode === expectedCode, ts.ok ? "TS chấp nhận" : ts.errorCode);

    const { outcome, error } = await callRpc(payload);
    check("X", file + ": RPC không lỗi transport", !error, error && error.message);
    check("X", file + ": outcome = rejected", outcome && outcome.outcome === "rejected", outcome && outcome.outcome);
    check("X", file + ": error_code = " + expectedCode, outcome && outcome.error_code === expectedCode, outcome && outcome.error_code);

    if (PAYLOADS_WITHOUT_RUN_LOG.has(file)) {
      const run = await getRun(payload.sync_run_id);
      check("X", file + ": không ghi sync_runs vì sync_run_id không hợp lệ (có chủ đích)", run === null, JSON.stringify(run));
      check("X", file + ": response báo run_logged = false", outcome && outcome.run_logged === false, outcome && JSON.stringify(outcome.run_logged));
    } else {
      const run = await getRun(payload.sync_run_id);
      check("X", file + ": sync_runs failed + error_code", run && run.status === "failed" && run.error_code === expectedCode, run && JSON.stringify(run));
      const issues = await getIssues(payload.sync_run_id);
      check("X", file + ": có sync_errors", issues.length >= 1 && issues[0].error_code === expectedCode, JSON.stringify(issues));
      check("X", file + ": response báo run_logged = true", outcome && outcome.run_logged === true, outcome && JSON.stringify(outcome.run_logged));
    }
  }
  {
    const rows = await getRows(sourceA.id);
    check("X", "snapshot của A KHÔNG đổi sau " + INVALID_PAYLOADS.length + " payload sai", eq(rows, snapshotAfterJ), JSON.stringify(rows.map((r) => r.business_date + "=" + r.recruited_count)));
  }

  // ======================================== Y — payload lỗi nguồn không hợp lệ
  {
    const payload = await readFixture("y-unsupported-error-code.json");
    const ts = validateRecruitmentSourceFailurePayload(payload);
    check("Y", "TS contract từ chối error_code ngoài danh mục", !ts.ok, ts.ok ? "TS chấp nhận" : ts.errorCode);
    const { outcome } = await callFailureRpc(payload);
    check("Y", "outcome = rejected", outcome && outcome.outcome === "rejected", outcome && outcome.outcome);
    check("Y", "error_code = UNSUPPORTED_SOURCE_ERROR_CODE", outcome && outcome.error_code === "UNSUPPORTED_SOURCE_ERROR_CODE", outcome && outcome.error_code);
    const rows = await getRows(sourceA.id);
    check("Y", "snapshot không đổi", eq(rows, snapshotAfterJ), JSON.stringify(rows.length));
  }

  // ================================================== bảo vệ dữ liệu cá nhân
  {
    const client = new pg.Client({ connectionString: config.databaseUrl, ssl: buildSslOptions() });
    await client.connect();
    const { rows: cols } = await client.query(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name = any($1) order by table_name, column_name",
      [[SOURCES_TABLE, RUNS_TABLE, BREAKDOWN_TABLE, ERRORS_TABLE]]
    );
    await client.end();
    const breakdownCols = cols.filter((c) => c.table_name === BREAKDOWN_TABLE).map((c) => c.column_name);
    check("PII", "bảng aggregate có đúng tập cột mong đợi", eq(breakdownCols, EXPECTED_BREAKDOWN_COLUMNS), JSON.stringify(breakdownCols));
    const offenders = cols.filter((c) => FORBIDDEN_COLUMN_NAMES.includes(c.column_name.toLowerCase()));
    check("PII", "không có cột dữ liệu cá nhân ứng viên ở bất kỳ bảng nào", offenders.length === 0, JSON.stringify(offenders));
  }

  // ============================================================ ẩn danh
  {
    const snapshot = await callRpc(fixtureA, anon);
    check("SEC", "anon không gọi được RPC snapshot", Boolean(snapshot.error) || !snapshot.outcome, snapshot.error ? snapshot.error.code + " " + snapshot.error.message : "anon gọi thành công (!)");
    const failure = await callFailureRpc(await readFixture("l-source-failure.json"), anon);
    check("SEC", "anon không gọi được RPC lỗi nguồn", Boolean(failure.error) || !failure.outcome, failure.error ? failure.error.code + " " + failure.error.message : "anon gọi thành công (!)");
    const { data, error: readError } = await anon.from(BREAKDOWN_TABLE).select("business_date, recruited_count").limit(5);
    check("SEC", "anon không đọc được bảng aggregate", Boolean(readError) || (Array.isArray(data) && data.length === 0), readError ? readError.message : JSON.stringify(data));
    const { error: writeError } = await anon.from(SOURCES_TABLE).insert({ drive_file_id: "P0FIXTURE_ANON", file_name: "x", sheet_name: "y" });
    check("SEC", "anon không ghi được data_sources", Boolean(writeError), writeError ? writeError.message : "anon ghi thành công (!)");

    // View reporting (latest-run + presence): service-role-only. anon/authenticated không đọc được.
    const viewSelect = await anon.from("reporting_latest_sync_runs_v01").select("source_id").limit(1);
    check("SEC", "anon không đọc được view reporting_latest_sync_runs_v01", Boolean(viewSelect.error) || (Array.isArray(viewSelect.data) && viewSelect.data.length === 0), viewSelect.error ? viewSelect.error.code + " " + viewSelect.error.message : JSON.stringify(viewSelect.data));
    const presenceSelect = await anon.from("reporting_sources_with_current_facts_v01").select("source_id").limit(1);
    check("SEC", "anon không đọc được view reporting_sources_with_current_facts_v01", Boolean(presenceSelect.error) || (Array.isArray(presenceSelect.data) && presenceSelect.data.length === 0), presenceSelect.error ? presenceSelect.error.code + " " + presenceSelect.error.message : JSON.stringify(presenceSelect.data));
    const optionsSelect = await anon.from("reporting_dimension_options_v01").select("dimension").limit(1);
    check("SEC", "anon không đọc được view reporting_dimension_options_v01", Boolean(optionsSelect.error) || (Array.isArray(optionsSelect.data) && optionsSelect.data.length === 0), optionsSelect.error ? optionsSelect.error.code + " " + optionsSelect.error.message : JSON.stringify(optionsSelect.data));

    const vc = new pg.Client({ connectionString: config.databaseUrl, ssl: buildSslOptions() });
    await vc.connect();
    const { rows: grantRows } = await vc.query(
      "select g.grantee, " +
      " has_table_privilege(g.grantee, 'public.reporting_latest_sync_runs_v01', 'SELECT') as latest_can_select, " +
      " has_table_privilege(g.grantee, 'public.reporting_sources_with_current_facts_v01', 'SELECT') as presence_can_select, " +
      " has_table_privilege(g.grantee, 'public.reporting_dimension_options_v01', 'SELECT') as options_can_select " +
      " from (values ('anon'),('authenticated'),('public'),('service_role')) as g(grantee)"
    );
    await vc.end();
    const priv = Object.fromEntries(grantRows.map((g) => [g.grantee, g]));
    const deny = (r) => r.latest_can_select === false && r.presence_can_select === false && r.options_can_select === false;
    check("SEC", "view latest-run + presence + options: anon/authenticated/public KHÔNG có SELECT", deny(priv.anon) && deny(priv.authenticated) && deny(priv.public), JSON.stringify(priv));
    check("SEC", "view latest-run + presence + options: service_role có SELECT", priv.service_role.latest_can_select === true && priv.service_role.presence_can_select === true && priv.service_role.options_can_select === true, JSON.stringify(priv));
  }

  // ========================== SCOPE: cô lập fixture khỏi reporting scope =====
  {
    // Chỉ đánh dấu CHÍNH XÁC hai fixture ID đã khóa là is_test=true (không dùng pattern rộng).
    const { error: markErr } = await admin
      .from("data_sources")
      .update({ is_test: true })
      .in("drive_file_id", [DRIVE_FILE_A, DRIVE_FILE_B]);
    check("SCOPE", "đánh dấu is_test=true cho 2 fixture", !markErr, markErr && markErr.message);

    const { data: allSources, error: listErr } = await admin
      .from("data_sources")
      .select("drive_file_id, is_test");
    check("SCOPE", "đọc data_sources không lỗi", !listErr, listErr && listErr.message);

    const rows = allSources ?? [];
    const fixtureA = rows.find((r) => r.drive_file_id === DRIVE_FILE_A);
    const fixtureB = rows.find((r) => r.drive_file_id === DRIVE_FILE_B);
    check("SCOPE", "fixture A có is_test=true", Boolean(fixtureA) && fixtureA.is_test === true, JSON.stringify(fixtureA));
    check("SCOPE", "fixture B có is_test=true", Boolean(fixtureB) && fixtureB.is_test === true, JSON.stringify(fixtureB));

    // Nguồn thật / nguồn khác không được đánh dấu test.
    const wronglyTest = rows.filter((r) => r.is_test === true && r.drive_file_id !== DRIVE_FILE_A && r.drive_file_id !== DRIVE_FILE_B);
    check("SCOPE", "không source nào khác bị đánh dấu is_test=true", wronglyTest.length === 0, JSON.stringify(wronglyTest.map((r) => r.drive_file_id)));
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
