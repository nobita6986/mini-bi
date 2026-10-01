#!/usr/bin/env node
/**
 * Kiểm tra contract `daily-recruitment-count/0.1` trên Supabase DEV.
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

import {
  DAILY_RECRUITMENT_RPC_NAME,
  validateDailyRecruitmentCountPayload,
} from "../src/lib/contracts/daily-recruitment-count.ts";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";

const FIXTURES_DIR = path.join(process.cwd(), "docs", "contracts", "fixtures", "daily-recruitment-count");
const FIXTURE_PREFIX = "P0FIXTURE_";
const DRIVE_FILE_A = "P0FIXTURE_DRIVE_FILE_A";
const DRIVE_FILE_B = "P0FIXTURE_DRIVE_FILE_B";

const results = [];
let failureCount = 0;

function check(caseId, label, ok, detail) {
  results.push({ caseId, label, ok: Boolean(ok), detail: detail === undefined ? "" : String(detail) });
  if (!ok) failureCount += 1;
}

function describeCounts(rows) {
  return rows.map((row) => row.business_date + "=" + row.recruited_count).join(", ") || "(rỗng)";
}

const readFixture = async (name) => JSON.parse(await readFile(path.join(FIXTURES_DIR, name), "utf8"));

async function main() {
  const config = await loadSupabaseConfig();
  const admin = createClient(config.url, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("Supabase project:", config.projectRef.slice(0, 4) + "***");
  console.log("Fixture dir:", path.relative(process.cwd(), FIXTURES_DIR));
  console.log("");

  // ---------------------------------------------------------------- reset
  {
    const { error } = await admin.from("data_sources").delete().like("drive_file_id", FIXTURE_PREFIX + "%");
    check("RESET", "dọn source fixture P0FIXTURE_* không lỗi", !error, error && error.message);
  }

  const getSource = async (driveFileId) => {
    const { data, error } = await admin
      .from("data_sources")
      .select("id, drive_file_id, file_name, sheet_name, last_seen_at, last_successful_sync_at")
      .eq("drive_file_id", driveFileId)
      .maybeSingle();
    if (error) throw new Error("đọc data_sources lỗi: " + error.message);
    return data;
  };

  const getCounts = async (sourceId) => {
    const { data, error } = await admin
      .from("daily_recruitment_counts")
      .select("business_date, recruited_count")
      .eq("source_id", sourceId)
      .order("business_date", { ascending: true });
    if (error) throw new Error("đọc daily_recruitment_counts lỗi: " + error.message);
    return data ?? [];
  };

  const getRun = async (runId) => {
    const { data, error } = await admin
      .from("sync_runs")
      .select("run_id, status, rows_read, rows_valid, rows_rejected, error_code, finished_at")
      .eq("run_id", runId)
      .maybeSingle();
    if (error) throw new Error("đọc sync_runs lỗi: " + error.message);
    return data;
  };

  const getErrors = async (runId) => {
    const { data, error } = await admin
      .from("sync_errors")
      .select("error_code, sanitized_reason")
      .eq("run_id", runId);
    if (error) throw new Error("đọc sync_errors lỗi: " + error.message);
    return data ?? [];
  };

  /** Gửi payload qua REST RPC và trả {outcome, error}. */
  const callRpc = async (payload, client = admin) => {
    const { data, error } = await client.rpc(DAILY_RECRUITMENT_RPC_NAME, { p_payload: payload });
    if (error) return { outcome: null, error };
    return { outcome: data, error: null };
  };

  // -------------------------------------------------------- A: snapshot đầu
  const fixtureA = await readFixture("a-initial.json");
  {
    const tsResult = validateDailyRecruitmentCountPayload(fixtureA);
    check("A", "fixture A hợp lệ theo TS contract", tsResult.ok, tsResult.ok ? "" : tsResult.message);

    const { outcome, error } = await callRpc(fixtureA);
    check("A", "RPC trả về không lỗi", !error, error && error.message);
    check("A", "outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    check("A", "run_status = succeeded", outcome && outcome.run_status === "succeeded", outcome && outcome.run_status);

    const source = await getSource(DRIVE_FILE_A);
    check("A", "source A được tạo với drive_file_id", Boolean(source), source && source.id);
    const counts = await getCounts(source.id);
    check(
      "A",
      "2026-10-01=4, 2026-10-02=7",
      describeCounts(counts) === "2026-10-01=4, 2026-10-02=7",
      describeCounts(counts)
    );
    check("A", "tổng = 11", outcome && outcome.recruited_count_total === 11, outcome && outcome.recruited_count_total);

    const run = await getRun(fixtureA.sync_run_id);
    check("A", "sync_runs: succeeded 11/11/0", run && run.status === "succeeded" && run.rows_read === 11 && run.rows_valid === 11 && run.rows_rejected === 0, run && JSON.stringify(run));
    check("A", "last_successful_sync_at đã được đặt", Boolean(source.last_successful_sync_at), source.last_successful_sync_at);
  }

  // ------------------------------------------------------------ B: replay
  const fixtureB = await readFixture("b-replay.json");
  {
    const { outcome, error } = await callRpc(fixtureB);
    check("B", "RPC trả về không lỗi", !error, error && error.message);
    check("B", "outcome = unchanged", outcome && outcome.outcome === "unchanged", outcome && outcome.outcome);
    check("B", "daily_rows_removed = 0", outcome && outcome.daily_rows_removed === 0, outcome && outcome.daily_rows_removed);

    const source = await getSource(DRIVE_FILE_A);
    const counts = await getCounts(source.id);
    check("B", "vẫn đúng 2 dòng, không duplicate", counts.length === 2, describeCounts(counts));
    check("B", "tổng vẫn = 11", outcome && outcome.recruited_count_total === 11, outcome && outcome.recruited_count_total);
    const run = await getRun(fixtureB.sync_run_id);
    check("B", "run replay vẫn được ghi (succeeded)", run && run.status === "succeeded", run && JSON.stringify(run));
  }

  // -------------------------------------------------------- C: correction
  const fixtureC = await readFixture("c-correction.json");
  {
    const { outcome, error } = await callRpc(fixtureC);
    check("C", "RPC trả về không lỗi", !error, error && error.message);
    check("C", "outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    const source = await getSource(DRIVE_FILE_A);
    const counts = await getCounts(source.id);
    check(
      "C",
      "2026-10-01=3, 2026-10-02=7 (không tạo dòng thứ ba)",
      describeCounts(counts) === "2026-10-01=3, 2026-10-02=7",
      describeCounts(counts)
    );
    check("C", "tổng = 10", outcome && outcome.recruited_count_total === 10, outcome && outcome.recruited_count_total);
  }

  // ------------------------------------------------------ D: date removed
  const fixtureD = await readFixture("d-date-removed.json");
  {
    const { outcome, error } = await callRpc(fixtureD);
    check("D", "RPC trả về không lỗi", !error, error && error.message);
    check("D", "outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    const source = await getSource(DRIVE_FILE_A);
    const counts = await getCounts(source.id);
    check("D", "chỉ còn 2026-10-01=3", describeCounts(counts) === "2026-10-01=3", describeCounts(counts));
    check("D", "daily_rows_removed = 1", outcome && outcome.daily_rows_removed === 1, outcome && outcome.daily_rows_removed);
  }

  // ------------------------------------------- F: payload sai (khi A có 1 dòng)
  const invalidFixtures = [
    ["f-unsupported-contract-version.json", "UNSUPPORTED_CONTRACT_VERSION"],
    ["f-unknown-field.json", "UNKNOWN_FIELD"],
    ["f-invalid-date.json", "INVALID_DATE"],
    ["f-invalid-value.json", "INVALID_VALUE"],
    ["f-rows-count-mismatch.json", "ROWS_COUNT_MISMATCH"],
    ["f-count-mismatch.json", "COUNT_MISMATCH"],
    ["f-duplicate-business-date.json", "DUPLICATE_BUSINESS_DATE"],
  ];
  for (const [file, expectedCode] of invalidFixtures) {
    const payload = await readFixture(file);
    const tsResult = validateDailyRecruitmentCountPayload(payload);
    check("F", file + ": TS contract cũng từ chối với " + expectedCode, !tsResult.ok && tsResult.errorCode === expectedCode, tsResult.ok ? "TS chấp nhận" : tsResult.errorCode);

    const { outcome, error } = await callRpc(payload);
    check("F", file + ": RPC không lỗi transport", !error, error && error.message);
    check("F", file + ": outcome = rejected", outcome && outcome.outcome === "rejected", outcome && outcome.outcome);
    check("F", file + ": error_code = " + expectedCode, outcome && outcome.error_code === expectedCode, outcome && outcome.error_code);

    const run = await getRun(payload.sync_run_id);
    check("F", file + ": sync_runs ghi failed + error_code", run && run.status === "failed" && run.error_code === expectedCode, run && JSON.stringify(run));
    const errs = await getErrors(payload.sync_run_id);
    check("F", file + ": có sync_errors", errs.length >= 1 && errs[0].error_code === expectedCode, JSON.stringify(errs));
  }
  {
    const source = await getSource(DRIVE_FILE_A);
    const counts = await getCounts(source.id);
    check("F", "snapshot của A không đổi sau 7 payload sai", describeCounts(counts) === "2026-10-01=3", describeCounts(counts));
  }

  // -------------------------------------------------- E: snapshot rỗng hợp lệ
  const fixtureE = await readFixture("e-empty.json");
  {
    const { outcome, error } = await callRpc(fixtureE);
    check("E", "RPC trả về không lỗi", !error, error && error.message);
    check("E", "outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);
    check("E", "run_status = succeeded", outcome && outcome.run_status === "succeeded", outcome && outcome.run_status);
    const source = await getSource(DRIVE_FILE_A);
    const counts = await getCounts(source.id);
    check("E", "0 dòng daily counts", counts.length === 0, describeCounts(counts));
    check("E", "tổng = 0", outcome && outcome.recruited_count_total === 0, outcome && outcome.recruited_count_total);
    check("E", "source vẫn active và có last_successful_sync_at", Boolean(source.last_successful_sync_at), source.last_successful_sync_at);
  }

  // ------------------------------------------------------------ G: hai source
  const fixtureG = await readFixture("g-source-b.json");
  {
    const { outcome, error } = await callRpc(fixtureG);
    check("G", "source B: RPC không lỗi", !error, error && error.message);
    check("G", "source B: outcome = applied", outcome && outcome.outcome === "applied", outcome && outcome.outcome);

    const sourceB = await getSource(DRIVE_FILE_B);
    const countsB = await getCounts(sourceB.id);
    check("G", "source B có 2026-10-03=5", describeCounts(countsB) === "2026-10-03=5", describeCounts(countsB));

    const sourceA = await getSource(DRIVE_FILE_A);
    const countsA = await getCounts(sourceA.id);
    check("G", "source A không bị ảnh hưởng (vẫn rỗng)", countsA.length === 0, describeCounts(countsA));

    const { outcome: outcomeA2 } = await callRpc(fixtureA);
    check("G", "source A ghi lại: applied", outcomeA2 && outcomeA2.outcome === "applied", outcomeA2 && outcomeA2.outcome);
    const countsA2 = await getCounts(sourceA.id);
    const countsB2 = await getCounts(sourceB.id);
    check("G", "source A có 2 dòng trở lại", countsA2.length === 2, describeCounts(countsA2));
    check("G", "source B vẫn nguyên 1 dòng", describeCounts(countsB2) === "2026-10-03=5", describeCounts(countsB2));
  }

  // ------------------------------------------------- truy cập ẩn danh
  {
    const { outcome, error } = await callRpc(fixtureA, anon);
    check("SEC", "anon không gọi được ingestion RPC", Boolean(error) || !outcome, error ? error.code + " " + error.message : "anon gọi thành công (!)" );

    const { data, error: readError } = await anon
      .from("daily_recruitment_counts")
      .select("business_date, recruited_count")
      .limit(5);
    check("SEC", "anon không đọc được daily_recruitment_counts", Boolean(readError) || (Array.isArray(data) && data.length === 0), readError ? readError.message : JSON.stringify(data));

    const { error: writeError } = await anon
      .from("data_sources")
      .insert({ drive_file_id: "P0FIXTURE_ANON_WRITE", file_name: "x", sheet_name: "y" });
    check("SEC", "anon không ghi được data_sources", Boolean(writeError), writeError ? writeError.message : "anon ghi thành công (!)");
  }

  // -------------------------------------------------------------- báo cáo
  console.log("");
  console.log("CASE  OK    KIỂM TRA");
  console.log("----  ----  --------");
  for (const row of results) {
    console.log(
      String(row.caseId).padEnd(5) + " " + (row.ok ? "PASS" : "FAIL") + "  " + row.label + (row.ok ? "" : "  -> " + row.detail)
    );
  }
  console.log("");
  console.log("Tổng: " + results.length + " kiểm tra, " + (results.length - failureCount) + " pass, " + failureCount + " fail.");
  if (failureCount > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("FIXTURE CHECK THẤT BẠI:", error.message);
  process.exitCode = 1;
});
