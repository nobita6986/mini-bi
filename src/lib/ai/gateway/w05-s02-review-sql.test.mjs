/**
 * P1.5-W05-S02 — Local SQL tests (PGlite) cho review lifecycle + history RPC.
 */

import assert from "node:assert/strict";
import { before, test } from "node:test";
import { readFileSync } from "node:fs";

import { PGlite } from "@electric-sql/pglite";

const MIG = (name) => readFileSync(new URL("../../../../supabase/migrations/" + name, import.meta.url), "utf8");

const MIGRATIONS = [
  "20261001160000_p1_5_ai_report_gateway.sql",
  "20261001160100_p1_5_ai_report_audit_append_only_grants.sql",
  "20261001160200_p1_5_ai_report_claim_concurrency.sql",
  "20261001160300_p1_5_ai_report_enqueue_audit_authority.sql",
  "20261001170000_p1_5_ai_provider_config.sql",
  "20261001170100_p1_5_ai_provider_config_helper_grants.sql",
  "20261001180000_p1_5_ai_report_review_history.sql",
];

let db;

async function seedJob(actor, created_at, overrides = {}) {
  const jobId = overrides.job_id ?? crypto.randomUUID();
  const revisionId = overrides.revision_id ?? crypto.randomUUID();
  await db.query(
    "insert into public.ai_report_jobs " +
      "(job_id, identity_hash, identity_components, request, actor_ref, access_scope_hash, snapshot_hash, lineage_ref, " +
      "packet, packet_hash, packet_contract_version, output_contract_version, prompt_version, provider_key, model_key, " +
      "adapter_version, status, attempts, max_attempts, revision_id, created_at) " +
      "values ($1, $2, '{}'::jsonb, $3::jsonb, $4, 'scope', 'snap', 'lineage', '{\"contract_version\":\"analysis-packet/0.1\"}'::jsonb, " +
      "'ph', 'analysis-packet/0.1', 'business-analysis/0.1', 'business-analysis-prompt/1.0', 'scripted', 'scripted-deterministic-v1', " +
      "'scripted-adapter/1.0', $5, 1, 3, $6, $7)",
    [
      jobId,
      ("id-" + jobId).slice(0, 64),
      JSON.stringify({ period: { type: "week", as_of_date: "2026-10-11" }, scope: { dimensions: ["project", "provider"] }, focus: null }),
      actor,
      overrides.status ?? "draft",
      revisionId,
      created_at,
    ]
  );
  await db.query(
    "insert into public.ai_report_revisions " +
      "(revision_id, job_id, revision_number, analysis, packet_hash, snapshot_hash, lineage_ref, prompt_version, " +
      "provider_key, model_key, contract_version, lifecycle_status, created_by_ref, created_at) " +
      "values ($1, $2, $3, $4::jsonb, 'ph', 'snap', 'lineage', 'business-analysis-prompt/1.0', 'scripted', " +
      "'scripted-deterministic-v1', 'business-analysis/0.1', 'draft', $5, $6)",
    [
      revisionId,
      jobId,
      overrides.revision_number ?? 1,
      JSON.stringify({
        contract_version: "business-analysis/0.1",
        period_ref: "week:2026-W41",
        executive_analysis: "Tuyển dụng tuần này tăng nhẹ, chủ yếu ở dự án A.",
        executive_evidence_refs: ["ev_01"],
        findings: [],
        overall_limitations: ["Dữ liệu chưa đầy đủ ở một nguồn"],
      }),
      actor,
      created_at,
    ]
  );
  return { jobId, revisionId };
}

test("S02-S1: approve draft thành công", async () => {
  const { jobId, revisionId } = await seedJob("pilot-admin", "2026-10-01T00:00:00Z");
  const res = await db.query("select public.ai_report_approve_revision($1, 1, 'pilot-admin') as r", [jobId]);
  const r = res.rows[0].r;
  assert.equal(r.ok, true);
  assert.equal(r.lifecycle_status, "approved");
  assert.equal(r.idempotent, false);
  assert.equal(r.revision_id, revisionId);
  const rev = await db.query("select lifecycle_status, approved_by_ref, approved_at from public.ai_report_revisions where revision_id = $1", [revisionId]);
  assert.equal(rev.rows[0].lifecycle_status, "approved");
  assert.equal(rev.rows[0].approved_by_ref, "pilot-admin");
  assert.ok(rev.rows[0].approved_at !== null);
  const audit = await db.query("select event_type, actor_ref from public.ai_report_audit_events where job_id = $1 and event_type = 'revision_approved'", [jobId]);
  assert.equal(audit.rows.length, 1);
});

test("S02-S2: reject draft thành công + reason", async () => {
  const { jobId } = await seedJob("pilot-admin", "2026-10-01T00:00:00Z");
  const res = await db.query("select public.ai_report_reject_revision($1, 1, 'pilot-admin', 'Thiếu dữ liệu so sánh') as r", [jobId]);
  assert.equal(res.rows[0].r.ok, true);
  assert.equal(res.rows[0].r.lifecycle_status, "rejected");
  const audit = await db.query("select reason from public.ai_report_audit_events where job_id = $1 and event_type = 'revision_rejected'", [jobId]);
  assert.equal(audit.rows[0].reason, "Thiếu dữ liệu so sánh");
});

test("S02-S3: reject thiếu/sai reason bị AI_INPUT_INVALID", async () => {
  const { jobId } = await seedJob("pilot-admin", "2026-10-01T00:00:00Z");
  for (const reason of [null, "", "x", "y".repeat(301)]) {
    const res = await db.query("select public.ai_report_reject_revision($1, 1, 'pilot-admin', $2) as r", [jobId, reason]);
    assert.equal(res.rows[0].r.ok, false, "reason=" + String(reason));
    assert.equal(res.rows[0].r.code, "AI_INPUT_INVALID");
  }
});

test("S02-S4: OCC stale/missing expected", async () => {
  const { jobId } = await seedJob("pilot-admin", "2026-10-01T00:00:00Z");
  const stale = await db.query("select public.ai_report_approve_revision($1, 99, 'pilot-admin') as r", [jobId]);
  assert.equal(stale.rows[0].r.code, "AI_VERSION_CONFLICT");
  const missing = await db.query("select public.ai_report_approve_revision($1, null, 'pilot-admin') as r", [jobId]);
  assert.equal(missing.rows[0].r.code, "AI_INPUT_INVALID");
});

test("S02-S5: terminal — approve sau reject và reject sau approve deny", async () => {
  const a = await seedJob("pilot-admin", "2026-10-01T00:00:00Z");
  await db.query("select public.ai_report_reject_revision($1, 1, 'pilot-admin', 'Lý do hợp lệ') as r", [a.jobId]);
  const ar = await db.query("select public.ai_report_approve_revision($1, 1, 'pilot-admin') as r", [a.jobId]);
  assert.equal(ar.rows[0].r.code, "AI_REVIEW_CONFLICT");

  const b = await seedJob("pilot-admin", "2026-10-01T00:00:00Z");
  await db.query("select public.ai_report_approve_revision($1, 1, 'pilot-admin') as r", [b.jobId]);
  const ra = await db.query("select public.ai_report_reject_revision($1, 1, 'pilot-admin', 'Lý do hợp lệ') as r", [b.jobId]);
  assert.equal(ra.rows[0].r.code, "AI_REVIEW_CONFLICT");
});

test("S02-S6: idempotency replay", async () => {
  const { jobId } = await seedJob("pilot-admin", "2026-10-01T00:00:00Z");
  await db.query("select public.ai_report_approve_revision($1, 1, 'pilot-admin') as r", [jobId]);
  const replay = await db.query("select public.ai_report_approve_revision($1, 1, 'pilot-admin') as r", [jobId]);
  assert.equal(replay.rows[0].r.ok, true);
  assert.equal(replay.rows[0].r.idempotent, true);

  const c = await seedJob("pilot-admin", "2026-10-01T00:00:00Z");
  await db.query("select public.ai_report_reject_revision($1, 1, 'pilot-admin', 'Lý do hợp lệ') as r", [c.jobId]);
  const rr = await db.query("select public.ai_report_reject_revision($1, 1, 'pilot-admin', 'Lý do hợp lệ') as r", [c.jobId]);
  assert.equal(rr.rows[0].r.idempotent, true);
  const diff = await db.query("select public.ai_report_reject_revision($1, 1, 'pilot-admin', 'Lý do khác') as r", [c.jobId]);
  assert.equal(diff.rows[0].r.code, "AI_REVIEW_CONFLICT");
});

test("S02-S7: audit insert lỗi ⇒ rollback", async () => {
  const { jobId, revisionId } = await seedJob("pilot-admin", "2026-10-01T00:00:00Z");
  await db.exec("create function public._block_audit() returns trigger language plpgsql as $$ begin raise exception 'audit insert blocked'; end $$");
  await db.exec("create trigger _block_audit before insert on public.ai_report_audit_events for each row execute function public._block_audit()");
  let threw = false;
  try {
    await db.query("select public.ai_report_approve_revision($1, 1, 'pilot-admin') as r", [jobId]);
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
  const rev = await db.query("select lifecycle_status from public.ai_report_revisions where revision_id = $1", [revisionId]);
  assert.equal(rev.rows[0].lifecycle_status, "draft");
  await db.exec("drop trigger _block_audit on public.ai_report_audit_events");
  await db.exec("drop function public._block_audit()");
});

test("S02-S8: grants/RLS/search_path/append-only", async () => {
  const funcs = await db.query(
    "select p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','),'') as sp " +
      "from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
      "where n.nspname = 'public' and p.proname in ('ai_report_approve_revision','ai_report_reject_revision','ai_report_history','ai_report_review_capability')"
  );
  for (const f of funcs.rows) {
    assert.equal(f.prosecdef, true, f.proname);
    // R1: search_path phải RỖNG (không public, không pg_temp). PostgreSQL lưu giá trị rỗng dạng search_path="".
    const sp = String(f.sp).trim();
    assert.ok(sp.startsWith("search_path="), f.proname + " thiếu search_path: " + sp);
    assert.ok(!sp.includes("public"), f.proname + " search_path còn public: " + sp);
    assert.ok(!sp.includes("pg_temp"), f.proname + " search_path còn pg_temp: " + sp);
    const value = sp.slice("search_path=".length);
    assert.ok(value === "" || value === '""', f.proname + " search_path không rỗng: " + sp);
  }
  for (const [fn, sig] of [
    ["ai_report_approve_revision", "uuid, integer, text"],
    ["ai_report_reject_revision", "uuid, integer, text, text"],
    ["ai_report_history", "text, text, integer"],
    ["ai_report_review_capability", ""],
  ]) {
    const sigText = "public." + fn + "(" + sig + ")";
    const q = await db.query(
      "select has_function_privilege('service_role'::text, $1::text, 'EXECUTE') as svc, " +
        "has_function_privilege('public'::text, $1::text, 'EXECUTE') as pub, " +
        "has_function_privilege('anon'::text, $1::text, 'EXECUTE') as anon, " +
        "has_function_privilege('authenticated'::text, $1::text, 'EXECUTE') as auth",
      [sigText]
    );
    const row = q.rows[0];
    assert.equal(row.svc, true, fn);
    assert.equal(row.pub, false, fn);
    assert.equal(row.anon, false, fn);
    assert.equal(row.auth, false, fn);
  }
  const rls = await db.query(
    "select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace " +
      "where n.nspname='public' and c.relname in ('ai_report_jobs','ai_report_revisions','ai_report_usage','ai_report_audit_events')"
  );
  for (const row of rls.rows) assert.equal(row.relrowsecurity, true, row.relname);
  let auditImmutable = false;
  try {
    await db.query("update public.ai_report_audit_events set reason = 'x' where event_id = 1");
  } catch (e) {
    auditImmutable = String(e.message).includes("append-only");
  }
  assert.equal(auditImmutable, true);
  const revUpd = await db.query("select has_table_privilege('service_role', 'public.ai_report_revisions', 'UPDATE') as u");
  assert.equal(revUpd.rows[0].u, false);
});

test("S02-S9: history order/scope/projection/pagination", async () => {
  const a1 = await seedJob("actor-a", "2026-10-01T00:00:00Z");
  const a2 = await seedJob("actor-a", "2026-10-02T00:00:00Z");
  const a3 = await seedJob("actor-a", "2026-10-03T00:00:00Z");
  await seedJob("actor-b", "2026-10-04T00:00:00Z");

  const page1 = await db.query("select public.ai_report_history('actor-a', null, 2) as r", []);
  const r1 = page1.rows[0].r;
  assert.equal(r1.ok, true);
  assert.equal(r1.items.length, 2);
  assert.equal(r1.has_more, true);
  assert.equal(r1.items[0].job_id, a3.jobId);
  assert.equal(r1.items[1].job_id, a2.jobId);
  const first = r1.items[0];
  for (const forbidden of ["packet", "request", "analysis", "encrypted_secret", "envelope", "ciphertext", "api_base_url"]) {
    assert.equal(forbidden in first, false, forbidden);
  }
  assert.equal(first.status, "draft");
  assert.equal(first.provider_key, "scripted");
  assert.equal(first.lifecycle_status, "draft");
  assert.equal(first.revision_number, 1);
  assert.ok(Array.isArray(first.dimensions));
  assert.ok(typeof first.period === "object");

  const page2 = await db.query("select public.ai_report_history('actor-a', $1, 2) as r", [r1.next_cursor]);
  const r2 = page2.rows[0].r;
  assert.equal(r2.items.length, 1);
  assert.equal(r2.items[0].job_id, a1.jobId);
  assert.equal(r2.has_more, false);

  const big = await db.query("select public.ai_report_history('actor-a', null, 999) as r", []);
  assert.equal(big.rows[0].r.items.length, 3);
});

test("S02-S10: history cursor sai/không tồn tại fail-closed", async () => {
  const bad = await db.query("select public.ai_report_history('actor-a', 'not-a-cursor', 20) as r", []);
  assert.equal(bad.rows[0].r.code, "AI_INPUT_INVALID");
  const ghost = await db.query("select public.ai_report_history('actor-a', '00000000-0000-0000-0000-000000000000', 20) as r", []);
  assert.equal(ghost.rows[0].r.code, "AI_INPUT_INVALID");
});

test("S02-S11: approve revision malformed bị từ chối", async () => {
  const { jobId } = await seedJob("pilot-admin", "2026-10-01T00:00:00Z");
  await db.query("update public.ai_report_revisions set analysis = '\"not-an-object\"'::jsonb where job_id = $1", [jobId]);
  const res = await db.query("select public.ai_report_approve_revision($1, 1, 'pilot-admin') as r", [jobId]);
  assert.equal(res.rows[0].r.code, "AI_REVIEW_NOT_READY");
});

test("S02-S12: capability RPC", async () => {
  const res = await db.query("select public.ai_report_review_capability() as r", []);
  assert.deepEqual(res.rows[0].r, { ok: true, approve: true, reject: true, regenerate: true });
});

test("S02-S13: actor isolation — actor B biết UUID job A nhưng không approve/reject được, DB state không đổi", async () => {
  const a = await seedJob("actor-a", "2026-10-01T00:00:00Z");
  const ap = await db.query("select public.ai_report_approve_revision($1, 1, 'actor-b') as r", [a.jobId]);
  assert.equal(ap.rows[0].r.ok, false);
  assert.equal(ap.rows[0].r.code, "AI_JOB_NOT_FOUND");
  const rj = await db.query("select public.ai_report_reject_revision($1, 1, 'actor-b', 'Lý do hợp lệ') as r", [a.jobId]);
  assert.equal(rj.rows[0].r.ok, false);
  assert.equal(rj.rows[0].r.code, "AI_JOB_NOT_FOUND");

  const rev = await db.query("select lifecycle_status, approved_by_ref, rejected_by_ref from public.ai_report_revisions where revision_id = $1", [a.revisionId]);
  assert.equal(rev.rows[0].lifecycle_status, "draft");
  assert.equal(rev.rows[0].approved_by_ref, null);
  assert.equal(rev.rows[0].rejected_by_ref, null);
  const audit = await db.query("select count(*)::int as n from public.ai_report_audit_events where job_id = $1 and event_type in ('revision_approved','revision_rejected')", [a.jobId]);
  assert.equal(audit.rows[0].n, 0);
});

test("S02-S14: actor isolation — job không tồn tại và job actor khác trả cùng AI_JOB_NOT_FOUND", async () => {
  const a = await seedJob("actor-a", "2026-10-01T00:00:00Z");
  const otherActor = await db.query("select public.ai_report_approve_revision($1, 1, 'actor-b') as r", [a.jobId]);
  const ghost = await db.query("select public.ai_report_approve_revision('00000000-0000-0000-0000-000000000000', 1, 'actor-b') as r", []);
  assert.equal(otherActor.rows[0].r.code, "AI_JOB_NOT_FOUND");
  assert.equal(ghost.rows[0].r.code, "AI_JOB_NOT_FOUND");
  assert.equal(otherActor.rows[0].r.message, ghost.rows[0].r.message, "không tiết lộ khác biệt existence/owner");
});

test("S02-S15: cursor isolation — cursor actor khác / không tồn tại trả cùng AI_INPUT_INVALID, không lộ item actor khác", async () => {
  await seedJob("actor-a", "2026-10-01T00:00:00Z");
  await seedJob("actor-a", "2026-10-02T00:00:00Z");
  const b = await seedJob("actor-b", "2026-10-03T00:00:00Z");

  const cross = await db.query("select public.ai_report_history('actor-a', $1, 20) as r", [b.jobId]);
  assert.equal(cross.rows[0].r.code, "AI_INPUT_INVALID");
  const ghost = await db.query("select public.ai_report_history('actor-a', '00000000-0000-0000-0000-000000000000', 20) as r", []);
  assert.equal(ghost.rows[0].r.code, "AI_INPUT_INVALID");
  assert.equal(cross.rows[0].r.message, ghost.rows[0].r.message, "cursor actor khác / không tồn tại phải giống nhau");

  const page = await db.query("select public.ai_report_history('actor-a', null, 50) as r", []);
  for (const item of page.rows[0].r.items) {
    assert.notEqual(item.job_id, b.jobId, "không được lộ job actor khác");
  }
});

test("S02-S16: equal created_at — phân trang keyset deterministic theo (created_at, job_id)", async () => {
  const ids = [
    "aaaaaaaa-0000-4000-8000-000000000001",
    "aaaaaaaa-0000-4000-8000-000000000002",
    "aaaaaaaa-0000-4000-8000-000000000003",
  ];
  for (const id of ids) {
    await seedJob("actor-eq", "2026-10-01T00:00:00Z", { job_id: id });
  }
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 5; i++) {
    const page = await db.query("select public.ai_report_history('actor-eq', $1, 1) as r", [cursor]);
    const r = page.rows[0].r;
    assert.equal(r.ok, true);
    if (r.items.length === 0) break;
    seen.push(r.items[0].job_id);
    if (!r.has_more) break;
    cursor = r.next_cursor;
  }
  assert.deepEqual(seen, ["aaaaaaaa-0000-4000-8000-000000000003", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000001"]);
});

test("S02-S17: source — không còn catch fallback regenerate=true / global cursor subquery / search_path public,pg_temp", () => {
  const capRoute = readFileSync(new URL("../../../app/api/ai/reports/capability/route.ts", import.meta.url), "utf8");
  const analysisRoute = readFileSync(new URL("../../../app/api/ai/reports/[jobId]/analysis/route.ts", import.meta.url), "utf8");
  const reviewSvc = readFileSync(new URL("server/review.mjs", import.meta.url), "utf8");
  const mig = MIG("20261001180000_p1_5_ai_report_review_history.sql");

  assert.ok(!capRoute.includes("regenerate: true"), "capability route không được fallback regenerate=true");
  assert.ok(!reviewSvc.includes("regenerate: true"), "review service không được fallback regenerate=true");
  assert.ok(!analysisRoute.includes("regenerate: true"), "analysis route không được quảng cáo regenerate=true tĩnh");
  assert.ok(!analysisRoute.includes("review_rpc_pending"), "analysis route không còn reason pending tĩnh");
  assert.ok(!mig.includes("set search_path = public, pg_temp"), "migration review không được search_path public,pg_temp");
  assert.ok(!mig.includes("(select created_at from public.ai_report_jobs where job_id = v_cursor)"), "history không được subquery global lấy created_at");
});

before(async () => {
  db = new PGlite();
  await db.exec("create role service_role; create role anon; create role authenticated;");
  for (const name of MIGRATIONS) {
    await db.exec(MIG(name));
  }
});
