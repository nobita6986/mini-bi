/**
 * P1.5-W04-R1 — Tải fact an toàn (KHÔNG silent truncation) + lineage theo nội dung.
 *
 * - Dùng lại `paginateAll` của reporting (page ≤ 1000, exact count, order đúng grain PK).
 * - Mọi lỗi page/count/ceiling ⇒ fail toàn request; không bao giờ trả dữ liệu một phần.
 * - lineage_ref phủ canonical grain keys + recruited_count + source health + window.
 */

import { paginateAll, REPORTING_FACT_ORDER, REPORTING_PAGE_SIZE } from "../../reporting/p1-reporting-pagination.ts";
import { canonicalHash } from "../engine-shared.mjs";

export const DEFAULT_MAX_FACT_ROWS = 50_000;

export const FACT_ORDER = REPORTING_FACT_ORDER;
export const FACT_PAGE_SIZE = REPORTING_PAGE_SIZE;

/** Cột fact tối thiểu mà packet loader thực sự dùng (KHÔNG display/tên người tuyển). */
export const FACT_COLUMNS = [
  "source_id",
  "business_date",
  "project_key",
  "recruiter_key",
  "provider_type_key",
  "employment_type_key",
  "recruited_count",
].join(", ");

/**
 * Đọc toàn bộ fact qua page. `load` nhận [from,to] và trả { rows, count, error }.
 * @returns {{ ok:true, rows:object[], count:number } | { ok:false, code:string, message:string }}
 */
export async function loadAllFacts(load, options = {}) {
  const pageSize = Number.isInteger(options.page_size) && options.page_size > 0 ? Math.min(options.page_size, FACT_PAGE_SIZE) : FACT_PAGE_SIZE;
  const maxRows = Number.isInteger(options.max_rows) && options.max_rows > 0 ? options.max_rows : DEFAULT_MAX_FACT_ROWS;
  const result = await paginateAll(load, { pageSize, maxRows });
  if (result.ok) return { ok: true, rows: result.rows, count: result.count };
  if (result.code === "REPORTING_RESULT_TOO_LARGE") {
    return { ok: false, code: "AI_RESULT_TOO_LARGE", message: "số dòng fact vượt trần policy (" + maxRows + ")" };
  }
  return {
    ok: false,
    code: "AI_FACT_LOAD_FAILED",
    message: "không đọc đủ dữ liệu sự kiện (page/count không nhất quán); không dựng packet từ dữ liệu một phần",
  };
}

/** Canonical grain key của một fact (đúng khóa PK của daily_recruitment_breakdown). */
export function factGrainKey(row) {
  return [
    row.source_key ?? row.source_id,
    row.business_date,
    row.project_key,
    row.recruiter_key,
    row.provider_type_key,
    row.employment_type_key,
  ].join("|");
}

/**
 * lineage_ref thay đổi khi NỘI DUNG fact/source snapshot thay đổi (kể cả số dòng không đổi).
 * Chỉ hash; không chứa raw identifier dạng đọc được.
 */
export function computeLineageRef({ window, sourceHealth, rows }) {
  const sortedHealth = [...(sourceHealth ?? [])]
    .map((source) => ({
      source_ref: source.source_key,
      status: source.status,
      quality: source.quality,
      has_current_facts: source.has_current_facts === true,
    }))
    .sort((a, b) => (a.source_ref < b.source_ref ? -1 : a.source_ref > b.source_ref ? 1 : 0));
  const grainDigest = canonicalHash(
    [...(rows ?? [])]
      .map((row) => ({ grain: factGrainKey(row), recruited_count: row.recruited_count }))
      .sort((a, b) => (a.grain < b.grain ? -1 : a.grain > b.grain ? 1 : 0))
  );
  return canonicalHash({
    schema: "ai-fact-lineage/1.0",
    window: { from: window?.from ?? null, to: window?.to ?? null },
    source_health: sortedHealth,
    row_count: (rows ?? []).length,
    grain_digest: grainDigest,
  });
}
