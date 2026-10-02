import "server-only";

/**
 * P1.5-W04-R1 — Nguồn packet cho AI gateway: đọc reporting read-model rồi dựng packet bằng W03.
 *
 * R1 hardening:
 * - Cửa sổ đọc dữ liệu tính theo W03 authority (`computeFactWindow`) — KHÔNG tự viết lại period math,
 *   KHÔNG hard-code lookback, KHÔNG lấy fact sau as_of.
 * - Pagination an toàn (`loadAllFacts`: page ≤ 1000, exact count, order đúng grain PK) — không silent truncation.
 * - Chỉ request cột thật sự cần (không display/tên người tuyển).
 * - lineage_ref theo NỘI DUNG snapshot (`computeLineageRef`).
 * - Identity catalog do caller truyền; runtime chưa có catalog ⇒ service đã chặn trước đó (AI_IDENTITY_CATALOG_REQUIRED).
 */

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { computeReporting } from "@/lib/reporting/p1-reporting";
import { buildPacketFromSource } from "../../packet-builder.mjs";
import { computeFactWindow } from "../fact-window.mjs";
import { FACT_COLUMNS, FACT_ORDER, FACT_PAGE_SIZE, computeLineageRef, loadAllFacts } from "../fact-load.mjs";
import { accessScopeHashFor } from "./config.mjs";

/** Catalog rỗng chỉ dùng khi caller KHÔNG yêu cầu dimension recruiter/team (P1.6 sẽ cấp catalog thật). */
export const EMPTY_MEMBERSHIP_CATALOG = Object.freeze({
  recruiters: [],
  aliases: [],
  teams: [],
  provider_memberships: [],
  team_memberships: [],
  audit: [],
});

const QUALITY_BY_STATUS = {
  covered: "ok",
  incomplete: "partial",
  stale_snapshot: "partial",
  running: "unknown",
  never_succeeded: "failed",
  no_run: "unknown",
};

/**
 * Dựng packet từ DB.
 * @returns {{ ok:true, packet:object, window:object, source_count:number, fact_count:number } | { ok:false, code:string, message:string }}
 */
export async function loadFrozenPacket({ period, scope, actor_ref, limits, catalog }) {
  const window = computeFactWindow(period, { max_lookback_days: limits?.max_lookback_days });
  if (!window.ok) return window;

  const client = createServiceSupabaseClient();

  const sourcesRes = await client
    .from("data_sources")
    .select("id, active, is_test, last_seen_at, last_successful_sync_at")
    .eq("active", true)
    .eq("is_test", false);
  if (sourcesRes.error) return { ok: false, code: "AI_FACT_LOAD_FAILED", message: "không đọc được source scope" };
  const sources = sourcesRes.data ?? [];
  if (sources.length === 0) return { ok: false, code: "AI_INPUT_INVALID", message: "không có source trong scope" };

  const sourceIds = sources.map((source) => source.id);
  const presenceRes = await client.from("reporting_sources_with_current_facts_v01").select("source_id").in("source_id", sourceIds);
  if (presenceRes.error) return { ok: false, code: "AI_FACT_LOAD_FAILED", message: "không đọc được presence" };
  const sourcesWithFacts = new Set((presenceRes.data ?? []).map((row) => row.source_id));

  const runsRes = await client.from("reporting_latest_sync_runs_v01").select("source_id, status").in("source_id", sourceIds);
  if (runsRes.error) return { ok: false, code: "AI_FACT_LOAD_FAILED", message: "không đọc được latest run" };
  const latestBySource = new Map((runsRes.data ?? []).map((row) => [row.source_id, row.status]));

  // Tái dùng mapping trạng thái nguồn của P1 (một nguồn sự thật duy nhất).
  const reportingSources = sources.map((source) => ({ ...source, latest_run_status: latestBySource.get(source.id) ?? null }));
  const statusRows = computeReporting(reportingSources, [], {}, sourcesWithFacts).sources;
  const sourceHealth = statusRows.map((row) => ({
    source_key: row.id,
    status: row.status,
    quality: QUALITY_BY_STATUS[row.status] ?? "unknown",
    has_current_facts: row.hasCurrentFacts === true,
  }));

  // Fact query: filter + order áp MỘT lần; pagination chỉ đổi range ⇒ order/filter giữ trên mọi page.
  const baseQuery = client
    .from("daily_recruitment_breakdown")
    .select(FACT_COLUMNS, { count: "exact" })
    .in("source_id", sourceIds)
    .gte("business_date", window.from)
    .lte("business_date", window.to);
  let orderedQuery = baseQuery;
  for (const column of FACT_ORDER) orderedQuery = orderedQuery.order(column);

  const loaded = await loadAllFacts(
    async ([from, to]) => {
      const res = await orderedQuery.range(from, to);
      if (res.error) return { rows: [], count: null, error: { code: res.error.code, message: "fact page lỗi" } };
      return { rows: res.data ?? [], count: res.count ?? null };
    },
    { page_size: FACT_PAGE_SIZE, max_rows: limits?.max_fact_rows }
  );
  if (!loaded.ok) return loaded;

  const facts = loaded.rows.map((row) => ({
    business_date: row.business_date,
    project_key: row.project_key,
    recruiter_key: row.recruiter_key,
    provider_type_key: row.provider_type_key,
    employment_type_key: row.employment_type_key,
    recruited_count: row.recruited_count,
    source_key: row.source_id,
  }));

  const lineageRef = computeLineageRef({ window: { from: window.from, to: window.to }, sourceHealth, rows: facts });

  const built = buildPacketFromSource({
    request: { period, scope },
    facts,
    source_health: sourceHealth,
    catalog: catalog ?? EMPTY_MEMBERSHIP_CATALOG,
    metadata: {
      generated_at: new Date().toISOString(),
      generated_from: "reporting-read-model",
      lineage_ref: lineageRef,
      access_scope_hash: accessScopeHashFor(actor_ref),
    },
  });
  if (!built.ok) return { ok: false, code: built.code ?? "AI_INPUT_INVALID", message: built.message ?? "không dựng được packet" };
  return {
    ok: true,
    packet: built.packet,
    window: { from: window.from, to: window.to, lookback_days: window.lookback_days },
    source_count: sourceHealth.length,
    fact_count: facts.length,
  };
}
