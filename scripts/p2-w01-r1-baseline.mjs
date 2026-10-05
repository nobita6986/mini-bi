#!/usr/bin/env node
/**
 * P2-W01-R1 — Production read-only baseline (one-shot).
 * Output path: P2_W01_R1_OUT (atomic rename từ .tmp).
 *
 * Mục tiêu:
 *   Thay số liệu giả định trong P2-W01 bằng evidence thật từ Production.
 *   Chỉ SELECT; mọi query chạy trong transaction READ ONLY + statement_timeout.
 *   Không in connection string, PII, hoặc tên NLĐ/CCCD/payment/document.
 *   Chỉ xuất aggregate counts, date ranges, fingerprint.
 *
 * Safety:
 *   - BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout;
 *   - ROLLBACK (no commit needed; read-only);
 *   - Không viết DB client mới; dùng loadSupabaseConfig + buildSslOptions + pg.Client.
 *   - Date fields dùng `to_char(..., 'YYYY-MM-DD')` để tránh mơ hồ session timezone
 *     (server Production đang ở UTC, pg-driver JS parse date object → có thể lệch ±1).
 */
import pg from "pg";
import { createHash } from "node:crypto";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";
import { writeFile, rename } from "node:fs/promises";
import process from "node:process";

const STATEMENT_TIMEOUT_MS = "15s";
const OUT_PATH = process.env.P2_W01_R1_OUT || "C:\\tmp\\p2-w01-r1-baseline.json";
const OUT_TMP = OUT_PATH + ".tmp";

function rowOf(res) {
  return res.rows[0] || {};
}

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** Trả YYYY-MM-DD từ chuỗi YYYY-MM-DD hoặc ISO; null/undefined → null. */
function toDateStr(v) {
  if (v == null) return null;
  const s = String(v);
  // Nếu là ISO đầy đủ, lấy phần 10 ký tự đầu.
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

/** cộng ngày (YYYY-MM-DD). Trả về YYYY-MM-DD. */
function addDays(yyyymmdd, days) {
  if (!yyyymmdd) return null;
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function maxDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

async function runQuery(client, label, sql, params) {
  process.stderr.write(`[query] ${label}…\n`);
  const t0 = Date.now();
  const res = await client.query(sql, params);
  process.stderr.write(`[query] ${label} ok (${Date.now() - t0}ms, rows=${res.rowCount ?? res.rows?.length ?? 0})\n`);
  return res;
}

async function main() {
  const cfg = await loadSupabaseConfig();
  const client = new pg.Client({ connectionString: cfg.databaseUrl, ssl: buildSslOptions() });
  await client.connect();

  await client.query("BEGIN");
  await client.query("SET TRANSACTION READ ONLY");
  await client.query("SET LOCAL statement_timeout = '15s'");
  process.stderr.write("[tx] READ ONLY + statement_timeout=15s set\n");

  const result = { meta: { projectRef: cfg.projectRef, usesPooler: cfg.usesPooler } };

  // 1. Legacy aggregate
  {
    const agg = rowOf(await runQuery(client, "aggregate.metrics", `
      select
          count(*)::bigint as rows,
          coalesce(sum(recruited_count),0)::bigint as recruited_total,
          to_char(min(business_date), 'YYYY-MM-DD') as min_business_date,
          to_char(max(business_date), 'YYYY-MM-DD') as max_business_date,
          count(distinct source_id)::bigint as distinct_sources
        from public.daily_recruitment_breakdown
    `));
    const fpRes = await runQuery(client, "aggregate.fingerprint", `
      select source_id::text as sid,
             to_char(business_date, 'YYYY-MM-DD') as bd,
             coalesce(sum(recruited_count),0)::bigint as total_count,
             count(*)::bigint as grain_rows
        from public.daily_recruitment_breakdown
       group by 1,2
       order by 1,2
    `);
    const fpString = fpRes.rows
      .map((r) => `${r.sid}|${r.bd}|${r.total_count}|${r.grain_rows}`)
      .join("\n");
    agg.aggregate_fingerprint_sha256 = sha256Hex(fpString);
    agg.by_source_date_count = Number(fpRes.rows.length);
    result.aggregate = {
      rows: Number(agg.rows),
      recruited_total: Number(agg.recruited_total),
      min_business_date: agg.min_business_date,
      max_business_date: agg.max_business_date,
      distinct_sources: Number(agg.distinct_sources),
      aggregate_fingerprint_sha256: agg.aggregate_fingerprint_sha256,
      by_source_date_count: agg.by_source_date_count,
    };
  }

  // 2. Direct Entry canonical
  {
    const all = rowOf(await runQuery(client, "de.total_entries", `select count(*)::bigint as total from public.direct_entries`));
    const eligible = rowOf(await runQuery(client, "de.eligible", `
      select count(*)::bigint as eligible,
             to_char(min(first_work_date), 'YYYY-MM-DD') as min_first_work_date,
             to_char(max(first_work_date), 'YYYY-MM-DD') as max_first_work_date
        from public.direct_entries e
        join public.direct_entry_submissions s on s.submission_id = e.submission_id
       where s.state = 'SUBMITTED' and e.deleted_at is null
    `));
    const byState = await runQuery(client, "de.submissions_by_state", `
      select s.state, count(*)::bigint as submissions
        from public.direct_entry_submissions s
       group by 1
       order by 1
    `);
    const submissions_total = rowOf(await runQuery(client, "de.submissions_total", `select count(*)::bigint as total from public.direct_entry_submissions`));
    const candidates_total = rowOf(await runQuery(client, "de.candidates_total", `select count(*)::bigint as total from public.direct_entry_candidates`));
    result.direct_entry = {
      total_entries: Number(all.total),
      eligible_entries: Number(eligible.eligible),
      min_first_work_date: eligible.min_first_work_date,
      max_first_work_date: eligible.max_first_work_date,
      submissions_total: Number(submissions_total.total),
      submissions_by_state: byState.rows.map((r) => ({ state: r.state, count: Number(r.submissions) })),
      candidates_total: Number(candidates_total.total),
    };
  }

  // 3. Overlap aggregate counts (aggregate side dimension counts)
  {
    const dims = rowOf(await runQuery(client, "overlap.aggregate_dims", `
      select
        count(distinct business_date)::bigint as distinct_dates,
        count(distinct project_key)::bigint as distinct_projects,
        count(distinct recruiter_key)::bigint as distinct_recruiters,
        count(distinct provider_type_key)::bigint as distinct_providers,
        count(distinct employment_type_key)::bigint as distinct_employments
      from public.daily_recruitment_breakdown
    `));
    const deDims = rowOf(await runQuery(client, "overlap.de_dims", `
      select
        count(distinct first_work_date)::bigint as distinct_dates,
        count(distinct project_id)::bigint as distinct_projects,
        count(distinct recruiter_id)::bigint as distinct_recruiters,
        count(distinct team_id)::bigint as distinct_teams,
        count(distinct provider_type)::bigint as distinct_providers,
        count(distinct labor_type)::bigint as distinct_employments
      from public.direct_entries e
      join public.direct_entry_submissions s on s.submission_id = e.submission_id
      where s.state = 'SUBMITTED' and e.deleted_at is null
    `));
    const overlapFp = rowOf(await runQuery(client, "overlap.fingerprint", `
      select to_char(min(business_date), 'YYYY-MM-DD') as min_d,
             to_char(max(business_date), 'YYYY-MM-DD') as max_d,
             count(distinct source_id)::bigint as distinct_sources
        from public.daily_recruitment_breakdown
    `));
    const overlapFpString = `${overlapFp.min_d}|${overlapFp.max_d}|${overlapFp.distinct_sources}`;
    result.overlap = {
      aggregate_dim_counts: {
        distinct_dates: Number(dims.distinct_dates),
        distinct_projects: Number(dims.distinct_projects),
        distinct_recruiters: Number(dims.distinct_recruiters),
        distinct_providers: Number(dims.distinct_providers),
        distinct_employments: Number(dims.distinct_employments),
      },
      direct_entry_dim_counts: {
        distinct_dates: Number(deDims.distinct_dates),
        distinct_projects: Number(deDims.distinct_projects),
        distinct_recruiters: Number(deDims.distinct_recruiters),
        distinct_teams: Number(deDims.distinct_teams),
        distinct_providers: Number(deDims.distinct_providers),
        distinct_employments: Number(deDims.distinct_employments),
      },
      aggregate_date_fingerprint_sha256: sha256Hex(overlapFpString),
    };
  }

  // 4. Source registry
  {
    const byActive = rowOf(await runQuery(client, "sources.by_active", `
      select
        count(*) filter (where active = true)::bigint as active_true,
        count(*) filter (where active = false)::bigint as active_false
      from public.data_sources
    `));
    const byTest = rowOf(await runQuery(client, "sources.by_test", `
      select
        count(*) filter (where coalesce(is_test,false) = true)::bigint as is_test_true,
        count(*) filter (where coalesce(is_test,false) = false)::bigint as is_test_false
      from public.data_sources
    `));
    const totalDataSources = rowOf(await runQuery(client, "sources.total", `select count(*)::bigint as total from public.data_sources`));
    const byLatestStatus = await runQuery(client, "sources.by_latest_status", `
      select status, count(*)::bigint as c
        from public.reporting_latest_sync_runs_v01
       group by 1 order by 1
    `);
    const everSucceeded = rowOf(await runQuery(client, "sources.ever_succeeded", `
      select count(*)::bigint as ever_succeeded
        from public.data_sources where last_successful_sync_at is not null
    `));
    // external_retained_authority check:
    //   Hiện schema data_sources có cột `external_authority` (NULL/true/false) — xem migration.
    //   Đếm các source được giữ làm external authority còn active.
    //   Có thể schema không có cột này; dùng information_schema + pg_attribute để detect.
    let externalAuthorityActive = null;
    let externalAuthorityColumnPresent = false;
    try {
      const colProbe = await runQuery(client, "sources.probe_external_col", `
        select 1
          from information_schema.columns
         where table_schema = 'public'
           and table_name = 'data_sources'
           and column_name in ('external_authority', 'is_external', 'is_authority')
         limit 1
      `);
      externalAuthorityColumnPresent = colProbe.rows.length > 0;
      if (externalAuthorityColumnPresent) {
        // Lấy tên cột thực tế
        const colName = await runQuery(client, "sources.get_external_colname", `
          select column_name
            from information_schema.columns
           where table_schema = 'public'
             and table_name = 'data_sources'
             and column_name in ('external_authority', 'is_external', 'is_authority')
           limit 1
        `);
        const cn = colName.rows[0].column_name;
        const cnt = rowOf(await runQuery(client, "sources.external_authority_active", `
          select count(*)::bigint as c
            from public.data_sources
           where (${cn} = true) and active = true
        `));
        externalAuthorityActive = Number(cnt.c);
      }
    } catch (err) {
      externalAuthorityActive = null;
    }
    result.source_registry = {
      total: Number(totalDataSources.total),
      active_true: Number(byActive.active_true),
      active_false: Number(byActive.active_false),
      is_test_true: Number(byTest.is_test_true),
      is_test_false: Number(byTest.is_test_false),
      external_authority_column_present: externalAuthorityColumnPresent,
      external_authority_active: externalAuthorityActive,
      by_latest_run_status: byLatestStatus.rows.map((r) => ({ status: r.status, count: Number(r.c) })),
      ever_succeeded: Number(everSucceeded.ever_succeeded),
    };
  }

  // 5. Tính candidate cutoff theo rule (Production tại thời điểm chạy).
  {
    const todayRes = rowOf(await client.query(`
      select to_char((now() at time zone 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD') as hcm_today
    `));
    const hcmToday = todayRes.hcm_today;
    const aggMax = toDateStr(result.aggregate.max_business_date);
    const aggMin = toDateStr(result.aggregate.min_business_date);
    const deMin = toDateStr(result.direct_entry.min_first_work_date);
    const deMax = toDateStr(result.direct_entry.max_first_work_date);
    let cutoffRule;
    let cutoffDate;
    if (result.direct_entry.eligible_entries === 0) {
      cutoffRule = "DE_ELIGIBLE_ZERO_AFTER_LEGACY";
      const afterLegacy = addDays(aggMax, 1);
      cutoffDate = maxDate(afterLegacy, hcmToday);
    } else {
      cutoffRule = "DE_ELIGIBLE_NONZERO_FIRST_WORK_DATE";
      cutoffDate = deMin; // exclusive lower-bound
    }
    result.cutoff = {
      rule: cutoffRule,
      legacy_min_date: aggMin,
      legacy_max_date: aggMax,
      de_eligible_min_first_work_date: deMin,
      de_eligible_max_first_work_date: deMax,
      hcm_today: hcmToday,
      candidate_cutoff_date: cutoffDate,
      legacy_mask: "< cutoff_date",
      de_mask: ">= cutoff_date",
      no_double_count: "ENFORCED_VIA_DISJOINT_MASKS",
    };
  }

  // 6. T0 LOCKED decisions (theo task).
  result.t0_locked_decisions = {
    retain_legacy_history: "YES",
    external_retained_sources: "NONE",
    team_extension: "NO",
    status_summary_ui: "NO",
    alerts: "dry-run only",
    totals_coverage_source: "actual Production results from this run",
  };

  // Ghi file atomic.
  await writeFile(OUT_TMP, JSON.stringify(result, null, 2), "utf8");
  await rename(OUT_TMP, OUT_PATH);

  // In summary ra stderr để dễ grep trong CI log; không lẫn với evidence chính ở file.
  process.stderr.write(`OK. Evidence ghi tại ${OUT_PATH}\n`);
  process.stderr.write(`Legacy rows=${result.aggregate.rows} recruited_total=${result.aggregate.recruited_total} ` +
    `date=[${result.cutoff.legacy_min_date}..${result.cutoff.legacy_max_date}] fingerprint=${result.aggregate.aggregate_fingerprint_sha256}\n`);
  process.stderr.write(`DE total=${result.direct_entry.total_entries} eligible=${result.direct_entry.eligible_entries} ` +
    `date=[${result.cutoff.de_eligible_min_first_work_date}..${result.cutoff.de_eligible_max_first_work_date}]\n`);
  process.stderr.write(`Submissions by state: ${JSON.stringify(result.direct_entry.submissions_by_state)}\n`);
  process.stderr.write(`Sources total=${result.source_registry.total} ` +
    `is_test=[true:${result.source_registry.is_test_true},false:${result.source_registry.is_test_false}] ` +
    `active=[true:${result.source_registry.active_true},false:${result.source_registry.active_false}] ` +
    `external_authority_active=${result.source_registry.external_authority_active} (col_present=${result.source_registry.external_authority_column_present}) ` +
    `by_latest_status=${JSON.stringify(result.source_registry.by_latest_run_status)}\n`);
  process.stderr.write(`Cutoff rule=${result.cutoff.rule} candidate=${result.cutoff.candidate_cutoff_date} hcm_today=${result.cutoff.hcm_today}\n`);

  // ROLLBACK để chắc chắn không ghi dù transaction đã READ ONLY.
  await client.query("ROLLBACK");
  await client.end();
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e && e.message ? e.message : e}\n`);
  if (e && e.code) process.stderr.write(`code=${e.code}\n`);
  if (e && e.position) process.stderr.write(`position=${e.position}\n`);
  if (e && e.severity) process.stderr.write(`severity=${e.severity}\n`);
  if (e && e.hint) process.stderr.write(`hint=${e.hint}\n`);
  if (e && e.detail) process.stderr.write(`detail=${e.detail}\n`);
  if (e && e.where) process.stderr.write(`where=${e.where}\n`);
  if (e && e.routine) process.stderr.write(`routine=${e.routine}\n`);
  process.exit(1);
});