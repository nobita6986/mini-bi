import "server-only";

/**
 * P1.5-W04 — Nguồn packet cho AI gateway: đọc reporting read-model rồi dựng packet bằng W03.
 *
 * - Tái dùng đúng logic W03 (`buildPacketFromSource`) và W02 (membership catalog) — KHÔNG nhân bản công thức.
 * - Identity catalog: P1.6 chưa có schema production ⇒ truyền catalog RỖNG (không bịa identity).
 *   Hệ quả có chủ đích: team_mapping = unavailable, breakdown recruiter rỗng — đúng trạng thái dữ liệu.
 * - Không đọc PII ứng viên (bảng breakdown không có cột PII).
 */

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { computeReporting } from "@/lib/reporting/p1-reporting";
import { buildPacketFromSource } from "../../packet-builder.mjs";
import { canonicalHash } from "../../engine-shared.mjs";
import { accessScopeHashFor } from "./config.mjs";

const FACT_COLUMNS =
  "source_id, business_date, project_key, project_display, recruiter_key, recruiter_display, provider_type_key, provider_type_display, employment_type_key, employment_type_display, recruited_count";

/** Catalog rỗng: P1.6 sẽ thay bằng schema identity thật. */
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

function addDays(date, days) {
  const parts = date.split("-").map(Number);
  const ms = Date.UTC(parts[0], parts[1] - 1, parts[2]) + days * 86400000;
  const d = new Date(ms);
  return [String(d.getUTCFullYear()).padStart(4, "0"), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0")].join("-");
}

/** Lookback đủ cho baseline W03 (weekly/monthly/quarterly + day_of_week 52 tuần). */
const LOOKBACK_DAYS = 400;

/**
 * Dựng packet từ DB. Trả { ok:true, packet, plan } hoặc { ok:false, code, message }.
 * `periodPlan` lấy từ W03 buildPeriodPlan thông qua packet-builder (đã tính window).
 */
export async function loadFrozenPacket({ period, scope, actor_ref }) {
  const client = createServiceSupabaseClient();

  const periodStart = periodPlanStart(period);
  if (!periodStart) return { ok: false, code: "AI_INPUT_INVALID", message: "period không hợp lệ" };
  const from = addDays(periodStart, -LOOKBACK_DAYS);
  const to = periodPlanEnd(period) ?? periodStart;

  const sourcesRes = await client
    .from("data_sources")
    .select("id, drive_file_id, file_name, active, is_test, last_seen_at, last_successful_sync_at")
    .eq("active", true)
    .eq("is_test", false);
  if (sourcesRes.error) return { ok: false, code: "AI_INTERNAL", message: "không đọc được source scope" };
  const sources = sourcesRes.data ?? [];
  if (sources.length === 0) return { ok: false, code: "AI_INPUT_INVALID", message: "không có source trong scope" };

  const sourceIds = sources.map((source) => source.id);
  const presenceRes = await client.from("reporting_sources_with_current_facts_v01").select("source_id").in("source_id", sourceIds);
  if (presenceRes.error) return { ok: false, code: "AI_INTERNAL", message: "không đọc được presence" };
  const sourcesWithFacts = new Set((presenceRes.data ?? []).map((row) => row.source_id));

  const runsRes = await client.from("reporting_latest_sync_runs_v01").select("source_id, status").in("source_id", sourceIds);
  if (runsRes.error) return { ok: false, code: "AI_INTERNAL", message: "không đọc được latest run" };
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

  const factsRes = await client
    .from("daily_recruitment_breakdown")
    .select(FACT_COLUMNS)
    .in("source_id", sourceIds)
    .gte("business_date", from)
    .lte("business_date", to)
    .order("business_date", { ascending: true })
    .limit(20000);
  if (factsRes.error) return { ok: false, code: "AI_INTERNAL", message: "không đọc được facts" };

  const facts = (factsRes.data ?? []).map((row) => ({
    business_date: row.business_date,
    project_key: row.project_key,
    recruiter_key: row.recruiter_key,
    provider_type_key: row.provider_type_key,
    employment_type_key: row.employment_type_key,
    recruited_count: row.recruited_count,
    source_key: row.source_id,
  }));

  const lineageRef = canonicalHash({
    sources: sourceHealth.map((source) => ({ source_ref: source.source_key, status: source.status, quality: source.quality })),
    facts: facts.length,
    window: { from, to },
  });

  const built = buildPacketFromSource({
    request: { period, scope },
    facts,
    source_health: sourceHealth,
    catalog: EMPTY_MEMBERSHIP_CATALOG,
    metadata: {
      generated_at: new Date().toISOString(),
      generated_from: "reporting-read-model",
      lineage_ref: lineageRef,
      access_scope_hash: accessScopeHashFor(actor_ref),
    },
  });
  if (!built.ok) return { ok: false, code: built.code ?? "AI_INPUT_INVALID", message: built.message ?? "không dựng được packet" };
  return { ok: true, packet: built.packet, source_count: sourceHealth.length, fact_count: facts.length };
}

// --- period helpers (khớp định nghĩa W03; chỉ để tính khoảng đọc dữ liệu) -----

function toUtcMs(date) {
  const parts = date.split("-").map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function fromUtcMs(ms) {
  const d = new Date(ms);
  return [String(d.getUTCFullYear()).padStart(4, "0"), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0")].join("-");
}

function isoWeekStartOf(date) {
  const ms = toUtcMs(date);
  const dow = new Date(ms).getUTCDay() || 7;
  return fromUtcMs(ms - (dow - 1) * 86400000);
}

export function periodPlanStart(period) {
  if (period?.type === "week") return isoWeekStartOf(period.as_of_date);
  if (period?.type === "month") return period.as_of_date.slice(0, 8) + "01";
  if (period?.type === "quarter") {
    const year = Number(period.as_of_date.slice(0, 4));
    const month = Number(period.as_of_date.slice(5, 7));
    const startMonth = Math.floor((month - 1) / 3) * 3 + 1;
    return year + "-" + String(startMonth).padStart(2, "0") + "-01";
  }
  if (period?.type === "custom") return period.custom_from ?? null;
  return null;
}

export function periodPlanEnd(period) {
  if (period?.type === "week") return fromUtcMs(toUtcMs(isoWeekStartOf(period.as_of_date)) + 6 * 86400000);
  if (period?.type === "month") {
    const year = Number(period.as_of_date.slice(0, 4));
    const month = Number(period.as_of_date.slice(5, 7));
    return fromUtcMs(Date.UTC(year, month, 0));
  }
  if (period?.type === "quarter") {
    const year = Number(period.as_of_date.slice(0, 4));
    const month = Number(period.as_of_date.slice(5, 7));
    const endMonth = Math.floor((month - 1) / 3) * 3 + 3;
    return fromUtcMs(Date.UTC(year, endMonth, 0));
  }
  if (period?.type === "custom") return period.custom_to ?? null;
  return null;
}
