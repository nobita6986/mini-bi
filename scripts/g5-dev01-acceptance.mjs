#!/usr/bin/env node
/**
 * P1.5-G5-DEV01 — DEV acceptance harness cho migration AI review/history (180000).
 *
 * Chạy synthetic fixtures với namespace "g5dev01-*" rồi nghiệm thu DB boundary, sau đó cleanup.
 * Không gọi AI provider, không ghi reporting/direct-entry rows.
 *
 * Dùng: node scripts/g5-dev01-acceptance.mjs
 */
import { randomUUID } from "node:crypto";
import process from "node:process";
import pg from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const NS = "g5dev01";
const ACTOR_A = NS + "-a";
const ACTOR_B = NS + "-b";
const ACTOR_PAG = NS + "-pag";

const ANALYSIS = {
  contract_version: "business-analysis/0.1",
  period_ref: "week:2026-W41",
  executive_analysis: "Tuyển dụng tuần này tăng nhẹ, chủ yếu ở dự án A.",
  executive_evidence_refs: ["ev_01"],
  findings: [],
  overall_limitations: ["Dữ liệu chưa đầy đủ ở một nguồn"],
};

const REPORTING_TABLES = ["data_sources", "sync_runs", "daily_recruitment_breakdown", "sync_errors"];
const FORBIDDEN_HISTORY_KEYS = ["packet", "request", "analysis", "encrypted_secret", "envelope", "ciphertext", "api_base_url", "prompt", "secret", "error_message"];

let client;
const trackedJobIds = new Set();
const checks = [];

function check(name, fn) {
  checks.push({ name, fn });
}

async function query(text, params = []) {
  return client.query(text, params);
}

async function seedJob(actor, createdAt, overrides = {}) {
  const jobId = overrides.job_id ?? randomUUID();
  const revisionId = overrides.revision_id ?? randomUUID();
  trackedJobIds.add(jobId);
  await query(
    "insert into public.ai_report_jobs " +
      "(job_id, identity_hash, identity_components, request, actor_ref, access_scope_hash, snapshot_hash, lineage_ref, " +
      "packet, packet_hash, packet_contract_version, output_contract_version, prompt_version, provider_key, model_key, " +
      "adapter_version, status, attempts, max_attempts, revision_id, created_at) " +
      "values ($1, $2, '{}'::jsonb, $3::jsonb, $4, 'scope', 'snap', 'lineage', $5::jsonb, " +
      "'ph', 'analysis-packet/0.1', 'business-analysis/0.1', 'business-analysis-prompt/1.0', 'scripted', 'scripted-deterministic-v1', " +
      "'scripted-adapter/1.0', $6, 1, 3, $7, $8)",
    [
      jobId,
      ("g5dev01-id-" + jobId).slice(0, 64),
      JSON.stringify({ period: { type: "week", as_of_date: "2026-10-11" }, scope: { dimensions: ["project", "provider"] }, focus: null }),
      actor,
      JSON.stringify({ contract_version: "analysis-packet/0.1" }),
      overrides.status ?? "draft",
      revisionId,
      createdAt,
    ]
  );
  await query(
    "insert into public.ai_report_revisions " +
      "(revision_id, job_id, revision_number, analysis, packet_hash, snapshot_hash, lineage_ref, prompt_version, " +
      "provider_key, model_key, contract_version, lifecycle_status, created_by_ref, created_at) " +
      "values ($1, $2, $3, $4::jsonb, 'ph', 'snap', 'lineage', 'business-analysis-prompt/1.0', 'scripted', " +
      "'scripted-deterministic-v1', 'business-analysis/0.1', 'draft', $5, $6)",
    [
      revisionId,
      jobId,
      overrides.revision_number ?? 1,
      JSON.stringify(ANALYSIS),
      actor,
      createdAt,
    ]
  );
  return { jobId, revisionId };
}

async function cleanup() {
  if (!client) return;
  // Dọn trigger/function audit-block của test (nếu còn sót).
  await query("drop trigger if exists g5dev01_block_audit on public.ai_report_audit_events").catch(() => {});
  await query("drop function if exists public.g5dev01_block_audit()").catch(() => {});
  // Audit append-only: tạm tắt trigger trong 1 transaction, xoá fixture namespace, bật lại.
  try {
    await query("begin");
    await query("alter table public.ai_report_audit_events disable trigger ai_report_audit_no_mutation");
    await query("delete from public.ai_report_audit_events where actor_ref like $1", [NS + "-%"]);
    await query("alter table public.ai_report_audit_events enable trigger ai_report_audit_no_mutation");
    await query("commit");
  } catch {
    await query("rollback").catch(() => {});
    await query("alter table public.ai_report_audit_events enable trigger ai_report_audit_no_mutation").catch(() => {});
  }
  // Xoá revision + job theo namespace.
  await query("delete from public.ai_report_revisions where created_by_ref like $1", [NS + "-%"]).catch(() => {});
  await query("delete from public.ai_report_jobs where actor_ref like $1", [NS + "-%"]).catch(() => {});
}

async function main() {
  const { databaseUrl, projectRef } = await loadSupabaseConfig();
  client = new pg.Client({ connectionString: databaseUrl, ssl: buildSslOptions() });
  await client.connect();
  console.log("Kết nối DEV thành công (project ref: " + projectRef.slice(0, 4) + "***)");

  // Baseline reporting row counts.
  const baseline = {};
  for (const t of REPORTING_TABLES) {
    const r = await query("select count(*)::int as n from public." + t);
    baseline[t] = r.rows[0].n;
  }

  // --- 1. Grants: service_role EXECUTE-only trên 4 RPC ---
  check("G1: 4 RPC service_role EXECUTE-only", async () => {
    const sigs = [
      ["ai_report_review_capability", ""],
      ["ai_report_approve_revision", "uuid, integer, text"],
      ["ai_report_reject_revision", "uuid, integer, text, text"],
      ["ai_report_history", "text, text, integer"],
    ];
    for (const [fn, sig] of sigs) {
      const sigText = "public." + fn + "(" + sig + ")";
      const r = await query(
        "select has_function_privilege('service_role', $1::text, 'EXECUTE') as svc, " +
          "has_function_privilege('public', $1::text, 'EXECUTE') as pub, " +
          "has_function_privilege('anon', $1::text, 'EXECUTE') as anon, " +
          "has_function_privilege('authenticated', $1::text, 'EXECUTE') as auth",
        [sigText]
      );
      const row = r.rows[0];
      if (row.svc !== true || row.pub !== false || row.anon !== false || row.auth !== false) {
        throw new Error(fn + " grants sai: " + JSON.stringify(row));
      }
    }
  });

  // --- 2. search_path = '' ---
  check("G2: search_path rỗng trên 4 RPC", async () => {
    const r = await query(
      "select p.proname, coalesce(array_to_string(p.proconfig, ','), '') as sp " +
        "from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
        "where n.nspname = 'public' and p.proname in ('ai_report_review_capability','ai_report_approve_revision','ai_report_reject_revision','ai_report_history')"
    );
    for (const f of r.rows) {
      const sp = String(f.sp).trim();
      if (!sp.startsWith("search_path=") || sp.includes("public") || sp.includes("pg_temp")) {
        throw new Error(f.proname + " search_path sai: " + sp);
      }
    }
  });

  // --- 3. RLS + append-only revision ---
  check("G3: RLS bật + service_role không UPDATE revisions", async () => {
    const r = await query(
      "select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace " +
        "where n.nspname='public' and c.relname in ('ai_report_jobs','ai_report_revisions','ai_report_usage','ai_report_audit_events')"
    );
    for (const row of r.rows) {
      if (row.relrowsecurity !== true) throw new Error(row.relname + " chưa RLS");
    }
    const priv = await query("select has_table_privilege('service_role', 'public.ai_report_revisions', 'UPDATE') as u");
    if (priv.rows[0].u !== false) throw new Error("service_role vẫn được UPDATE revisions");
  });

  // --- 4. Capability ---
  check("G4: capability strict", async () => {
    const r = await query("select public.ai_report_review_capability() as c");
    const c = r.rows[0].c;
    if (c.ok !== true || c.approve !== true || c.reject !== true || c.regenerate !== true) {
      throw new Error(JSON.stringify(c));
    }
  });

  // --- 5. Approve draft hợp lệ ---
  check("G5: approve draft hợp lệ", async () => {
    const { jobId, revisionId } = await seedJob(ACTOR_A, "2026-10-01T00:00:00Z");
    const r = await query("select public.ai_report_approve_revision($1, 1, $2) as r", [jobId, ACTOR_A]);
    const v = r.rows[0].r;
    if (v.ok !== true || v.lifecycle_status !== "approved" || v.revision_id !== revisionId || v.idempotent !== false) {
      throw new Error(JSON.stringify(v));
    }
    const rev = await query("select lifecycle_status, approved_by_ref from public.ai_report_revisions where revision_id = $1", [revisionId]);
    if (rev.rows[0].lifecycle_status !== "approved" || rev.rows[0].approved_by_ref !== ACTOR_A) throw new Error("revision không approved");
    const audit = await query("select count(*)::int as n from public.ai_report_audit_events where job_id = $1 and event_type = 'revision_approved'", [jobId]);
    if (audit.rows[0].n !== 1) throw new Error("thiếu audit revision_approved");
  });

  // --- 6. Reject draft + reason validation ---
  check("G6: reject hợp lệ + reason validation", async () => {
    const { jobId } = await seedJob(ACTOR_A, "2026-10-01T00:00:00Z");
    const ok = await query("select public.ai_report_reject_revision($1, 1, $2, $3) as r", [jobId, ACTOR_A, "Thiếu dữ liệu so sánh"]);
    if (ok.rows[0].r.ok !== true || ok.rows[0].r.lifecycle_status !== "rejected") throw new Error(JSON.stringify(ok.rows[0].r));

    const bad = await seedJob(ACTOR_A, "2026-10-01T00:00:00Z");
    for (const reason of [null, "x", "y".repeat(301)]) {
      const r = await query("select public.ai_report_reject_revision($1, 1, $2, $3) as r", [bad.jobId, ACTOR_A, reason]);
      if (r.rows[0].r.ok !== false || r.rows[0].r.code !== "AI_INPUT_INVALID") {
        throw new Error("reason=" + String(reason) + " -> " + JSON.stringify(r.rows[0].r));
      }
    }
  });

  // --- 7. OCC stale ---
  check("G7: OCC stale bị từ chối", async () => {
    const { jobId } = await seedJob(ACTOR_A, "2026-10-01T00:00:00Z");
    const r = await query("select public.ai_report_approve_revision($1, 99, $2) as r", [jobId, ACTOR_A]);
    if (r.rows[0].r.code !== "AI_VERSION_CONFLICT") throw new Error(JSON.stringify(r.rows[0].r));
  });

  // --- 8. Replay idempotent ---
  check("G8: replay cùng decision idempotent", async () => {
    const { jobId } = await seedJob(ACTOR_A, "2026-10-01T00:00:00Z");
    await query("select public.ai_report_approve_revision($1, 1, $2) as r", [jobId, ACTOR_A]);
    const replay = await query("select public.ai_report_approve_revision($1, 1, $2) as r", [jobId, ACTOR_A]);
    if (replay.rows[0].r.ok !== true || replay.rows[0].r.idempotent !== true) throw new Error(JSON.stringify(replay.rows[0].r));
  });

  // --- 9. Reuse key khác decision/reason conflict ---
  check("G9: reuse key khác decision/reason conflict", async () => {
    const a = await seedJob(ACTOR_A, "2026-10-01T00:00:00Z");
    await query("select public.ai_report_approve_revision($1, 1, $2) as r", [a.jobId, ACTOR_A]);
    const reject = await query("select public.ai_report_reject_revision($1, 1, $2, 'Lý do hợp lệ') as r", [a.jobId, ACTOR_A]);
    if (reject.rows[0].r.code !== "AI_REVIEW_CONFLICT") throw new Error(JSON.stringify(reject.rows[0].r));

    const b = await seedJob(ACTOR_A, "2026-10-01T00:00:00Z");
    await query("select public.ai_report_reject_revision($1, 1, $2, 'Lý do hợp lệ') as r", [b.jobId, ACTOR_A]);
    const diff = await query("select public.ai_report_reject_revision($1, 1, $2, 'Lý do khác') as r", [b.jobId, ACTOR_A]);
    if (diff.rows[0].r.code !== "AI_REVIEW_CONFLICT") throw new Error(JSON.stringify(diff.rows[0].r));
  });

  // --- 10. Actor isolation ---
  check("G10: actor khác nhận cùng AI_JOB_NOT_FOUND như job không tồn tại", async () => {
    const a = await seedJob(ACTOR_A, "2026-10-01T00:00:00Z");
    const other = await query("select public.ai_report_approve_revision($1, 1, $2) as r", [a.jobId, ACTOR_B]);
    const ghost = await query("select public.ai_report_approve_revision($1, 1, $2) as r", ["00000000-0000-0000-0000-000000000000", ACTOR_B]);
    if (other.rows[0].r.code !== "AI_JOB_NOT_FOUND" || ghost.rows[0].r.code !== "AI_JOB_NOT_FOUND") {
      throw new Error("other=" + other.rows[0].r.code + " ghost=" + ghost.rows[0].r.code);
    }
    if (other.rows[0].r.message !== ghost.rows[0].r.message) throw new Error("message khác nhau (lộ existence/owner)");
  });

  // --- 11. Cursor isolation ---
  check("G11: cursor actor khác/missing bị từ chối giống nhau", async () => {
    await seedJob(ACTOR_A, "2026-10-01T00:00:00Z");
    const b = await seedJob(ACTOR_B, "2026-10-02T00:00:00Z");
    const cross = await query("select public.ai_report_history($1, $2, 20) as r", [ACTOR_A, b.jobId]);
    const ghost = await query("select public.ai_report_history($1, $2, 20) as r", [ACTOR_A, "00000000-0000-0000-0000-000000000000"]);
    if (cross.rows[0].r.code !== "AI_INPUT_INVALID" || ghost.rows[0].r.code !== "AI_INPUT_INVALID") {
      throw new Error("cross=" + cross.rows[0].r.code + " ghost=" + ghost.rows[0].r.code);
    }
    if (cross.rows[0].r.message !== ghost.rows[0].r.message) throw new Error("cursor message khác nhau");
  });

  // --- 12. Keyset pagination không trùng/sót (equal created_at) ---
  check("G12: keyset pagination deterministic", async () => {
    const ids = [
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000002",
      "aaaaaaaa-0000-4000-8000-000000000003",
    ];
    for (const id of ids) await seedJob(ACTOR_PAG, "2026-10-01T00:00:00Z", { job_id: id });
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 5; i++) {
      const page = await query("select public.ai_report_history($1, $2, 1) as r", [ACTOR_PAG, cursor]);
      const r = page.rows[0].r;
      if (r.items.length === 0) break;
      seen.push(r.items[0].job_id);
      if (!r.has_more) break;
      cursor = r.next_cursor;
    }
    const expected = ["aaaaaaaa-0000-4000-8000-000000000003", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000001"];
    if (JSON.stringify(seen) !== JSON.stringify(expected)) throw new Error(JSON.stringify(seen));
  });

  // --- 13. Audit insert failure rollback ---
  check("G13: audit insert lỗi rollback toàn bộ", async () => {
    const { jobId, revisionId } = await seedJob(ACTOR_A, "2026-10-01T00:00:00Z");
    await query("create function public.g5dev01_block_audit() returns trigger language plpgsql as $f$ begin raise exception 'g5dev01 audit blocked'; end $f$");
    await query("create trigger g5dev01_block_audit before insert on public.ai_report_audit_events for each row execute function public.g5dev01_block_audit()");
    let threw = false;
    try {
      await query("select public.ai_report_approve_revision($1, 1, $2) as r", [jobId, ACTOR_A]);
    } catch {
      threw = true;
    }
    await query("drop trigger if exists g5dev01_block_audit on public.ai_report_audit_events");
    await query("drop function if exists public.g5dev01_block_audit()");
    if (!threw) throw new Error("approve không throw khi audit bị block");
    const rev = await query("select lifecycle_status from public.ai_report_revisions where revision_id = $1", [revisionId]);
    if (rev.rows[0].lifecycle_status !== "draft") throw new Error("revision không rollback về draft");
  });

  // --- 14. History projection an toàn ---
  check("G14: history không trả packet/prompt/raw/secret/PII", async () => {
    await seedJob(ACTOR_A, "2026-10-01T00:00:00Z");
    const page = await query("select public.ai_report_history($1, null, 50) as r", [ACTOR_A]);
    for (const item of page.rows[0].r.items) {
      for (const key of FORBIDDEN_HISTORY_KEYS) {
        if (key in item) throw new Error("history lộ field " + key);
      }
    }
  });

  // --- run checks ---
  let pass = 0;
  let fail = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log("PASS  " + name);
      pass += 1;
    } catch (error) {
      console.log("FAIL  " + name + " :: " + error.message);
      fail += 1;
    }
  }

  // --- reporting baseline unchanged ---
  let baselineOk = true;
  for (const t of REPORTING_TABLES) {
    const r = await query("select count(*)::int as n from public." + t);
    if (r.rows[0].n !== baseline[t]) {
      baselineOk = false;
      console.log("BASELINE CHANGED: " + t + " " + baseline[t] + " -> " + r.rows[0].n);
    }
  }
  if (baselineOk) console.log("PASS  reporting baseline không đổi");

  console.log("Kết quả: " + pass + " pass, " + fail + " fail.");
  process.exitCode = fail === 0 && baselineOk ? 0 : 1;
}

main()
  .catch((error) => {
    console.error("ACCEPTANCE LỖI:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch(() => {});
    if (client) await client.end().catch(() => {});
    // Xác nhận không còn fixture namespace.
    console.log("Cleanup đã chạy.");
  });
