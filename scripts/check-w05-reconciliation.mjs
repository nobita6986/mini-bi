#!/usr/bin/env node
/**
 * P1-T1-W05 — Đối soát read-only (sanitized):
 *   Supabase DEV (scope active && !is_test) → read-model computeReporting → dashboard.
 *
 * KHÔNG ghi, KHÔNG in tên project/recruiter/source thật, KHÔNG đọc cột PII.
 * Chạy: node scripts/check-w05-reconciliation.mjs
 */
import pg from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";
import { computeReporting } from "../src/lib/reporting/p1-reporting.ts";

const config = await loadSupabaseConfig();
const c = new pg.Client({ connectionString: config.databaseUrl, ssl: buildSslOptions() });
await c.connect();

// 1. Sources (scope = active && !is_test). Không in file_name/drive_file_id.
const src = await c.query("select id, active, is_test, last_seen_at, last_successful_sync_at from public.data_sources order by id");
const scope = src.rows.filter((r) => r.active && !r.is_test);
const fixtures = src.rows.filter((r) => r.is_test);
const scopeIds = scope.map((r) => r.id);
const label = (id) => { const i = scope.findIndex((s) => s.id === id); return "Source " + String.fromCharCode(65 + i); };

// 2. Latest run mỗi source (T2 refresh evidence).
const runs = await c.query(
  "select distinct on (source_id) source_id, run_id, status, started_at, rows_read, rows_valid, rows_rejected, rows_warned, warning_issues " +
  "from public.sync_runs where source_id = any($1::uuid[]) order by source_id, started_at desc, run_id desc",
  [scopeIds]
);
const runBySource = Object.fromEntries(runs.rows.map((r) => [r.source_id, r]));

// 3. Facts hiện hành.
const facts = await c.query(
  "select source_id, business_date::text as business_date, project_key, recruiter_key, provider_type_key, employment_type_key, recruited_count " +
  "from public.daily_recruitment_breakdown where source_id = any($1::uuid[])",
  [scopeIds]
);
const factRows = facts.rows;

// 4. Presence (view DISTINCT source_id).
const presence = await c.query("select source_id from public.reporting_sources_with_current_facts_v01 where source_id = any($1::uuid[])", [scopeIds]);
const sourcesWithFacts = new Set(presence.rows.map((r) => r.source_id));

await c.end();

// 5. read-model (computeReporting) trên cùng dữ liệu.
const reportingSources = scope.map((s) => ({
  id: s.id, drive_file_id: "", file_name: "", active: s.active, is_test: s.is_test,
  latest_run_status: (runBySource[s.id] && runBySource[s.id].status) || null,
  last_successful_sync_at: s.last_successful_sync_at ? new Date(s.last_successful_sync_at).toISOString() : null,
  last_seen_at: s.last_seen_at ? new Date(s.last_seen_at).toISOString() : null,
}));
const reportingFacts = factRows.map((r) => ({ ...r, project_display: "", recruiter_display: "", provider_type_display: "", employment_type_display: "" }));
// (display không ảnh hưởng metric; chỉ cần key + count để đối soát tổng/breakdown.)
const rm = computeReporting(reportingSources, reportingFacts, {}, sourcesWithFacts);

// 6. Direct DB aggregation (để đối soát với read-model).
const total = factRows.reduce((a, r) => a + r.recruited_count, 0);
const sum = (key) => { const m = {}; for (const r of factRows) m[r[key]] = (m[r[key]] || 0) + r.recruited_count; return m; };
const byDate = sum("business_date");
const byProvider = sum("provider_type_key");
const byEmployment = sum("employment_type_key");
const bySource = sum("source_id");
const projects = {}; for (const r of factRows) projects[r.project_key] = (projects[r.project_key] || 0) + r.recruited_count;
const recruiters = {}; for (const r of factRows) recruiters[r.recruiter_key] = (recruiters[r.recruiter_key] || 0) + r.recruited_count;

const line = "─".repeat(58);
console.log(line);
console.log("W05 RECONCILIATION — sanitized (không in tên project/recruiter/source thật)");
console.log(line);
console.log("Scope sources (active && !is_test): " + scope.length);
console.log("Fixture sources (is_test=true, bị loại): " + fixtures.length);
console.log("");
console.log("--- T2 refresh evidence (latest run mỗi source) ---");
for (const r of runs.rows) {
  console.log(label(r.source_id) + ": run=" + String(r.run_id).slice(0, 8) + " status=" + r.status + " read=" + r.rows_read + " valid=" + r.rows_valid + " rejected=" + r.rows_rejected + " warned=" + r.rows_warned + " started=" + (r.started_at ? new Date(r.started_at).toISOString() : "—"));
}
console.log("");
console.log("--- Totals ---");
console.log("recruited_total (DB direct) = " + total);
console.log("recruited_total (read-model)  = " + rm.recruitedTotal);
console.log("match = " + (total === rm.recruitedTotal));
console.log("");
console.log("--- byDate (count=" + Object.keys(byDate).length + ") ---");
for (const d of Object.keys(byDate).sort()) console.log("  " + d + " = " + byDate[d]);
console.log("");
console.log("--- byProvider (catalog) ---");
for (const k of ["hrp", "vendor", "__unknown__", "__invalid__"]) console.log("  " + k + " = " + (byProvider[k] || 0));
console.log("");
console.log("--- byEmployment (catalog) ---");
for (const k of ["thời vụ", "chính thức", "__unknown__", "__invalid__"]) console.log("  " + k + " = " + (byEmployment[k] || 0));
console.log("");
console.log("--- byProject ---");
console.log("  distinct projects = " + Object.keys(projects).length + ", sum = " + Object.values(projects).reduce((a, b) => a + b, 0));
console.log("--- byRecruiter ---");
console.log("  distinct recruiters = " + Object.keys(recruiters).length + ", sum = " + Object.values(recruiters).reduce((a, b) => a + b, 0));
console.log("");
console.log("--- bySource ---");
for (const [id, v] of Object.entries(bySource)) console.log("  " + label(id) + " = " + v);
console.log("");
// Row count (grain rows) per source so với rows_valid của T2.
const rowCount = {};
for (const r of factRows) rowCount[r.source_id] = (rowCount[r.source_id] || 0) + 1;
console.log("--- rows_valid (T2) vs row count (DB) ---");
let rowsMatch = true;
for (const r of runs.rows) {
  const dbRows = rowCount[r.source_id] || 0;
  const ok = dbRows === r.rows_valid;
  rowsMatch = rowsMatch && ok;
  console.log("  " + label(r.source_id) + ": rows_valid=" + r.rows_valid + " db_rows=" + dbRows + " match=" + ok);
}
console.log("");
console.log("--- unknown/invalid có mặt? ---");
console.log("  provider __unknown__ = " + (byProvider.__unknown__ || 0) + ", __invalid__ = " + (byProvider.__invalid__ || 0));
console.log("  employment __unknown__ = " + (byEmployment.__unknown__ || 0) + ", __invalid__ = " + (byEmployment.__invalid__ || 0));
console.log("");
console.log("--- Coverage (read-model) ---");
console.log("  expected=" + rm.coverage.expected + " succeeded=" + rm.coverage.succeeded + " partial=" + rm.coverage.partial + " failed=" + rm.coverage.failed + " neverSucceeded=" + rm.coverage.neverSucceeded + " ratio=" + rm.coverage.coverageRatio);
console.log("--- Source status (read-model) ---");
for (const s of rm.sources) console.log("  " + label(s.id) + " = " + s.status + " (contributes=" + s.contributes + ", everSucceeded=" + s.everSucceeded + ", hasCurrentFacts=" + s.hasCurrentFacts + ")");
console.log("");
// Invariants
const bucketSum = (o) => Object.values(o).reduce((a, b) => a + b.recruitedCount, 0);
const checks = {
  byDate: Object.values(rm.byDate).reduce((a, b) => a + b, 0) === rm.recruitedTotal,
  byProject: bucketSum(rm.byProject) === rm.recruitedTotal,
  byRecruiter: bucketSum(rm.byRecruiter) === rm.recruitedTotal,
  byProvider: bucketSum(rm.byProvider) === rm.recruitedTotal,
  byEmployment: bucketSum(rm.byEmployment) === rm.recruitedTotal,
  fixture_excluded: rm.sources.every((s) => fixtures.every((f) => f.id !== s.id)),
  rows_valid_matches_db: rowsMatch,
};
console.log("--- Invariants (tổng mỗi breakdown = recruitedTotal) ---");
for (const [k, v] of Object.entries(checks)) console.log("  " + k + " = " + v);
const pass = Object.values(checks).every(Boolean) && total === rm.recruitedTotal;
console.log(line);
console.log(pass ? "RESULT: READ-MODEL MATCHES DB (sanitized)" : "RESULT: MISMATCH — cần điều tra");
console.log(line);
if (!pass) process.exitCode = 1;
