/**
 * P1.5-W04-R4 — Policy stage separation + failure truthfulness + durable audit.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { buildPacketFromSource } from "../packet-builder.mjs";
import { getPromptManifest, PROMPT_MANIFEST_V1 } from "./prompt-registry.mjs";
import { createScriptedAdapter } from "./provider.mjs";
import { createMemoryAudit, createMemoryQueue } from "./testing/memory-queue.mjs";
import { createAiReportService } from "./service-core.mjs";
import { DEFAULT_POLICY, MAX_CONCURRENT_JOBS } from "./limits.mjs";
import { evaluateAdmissionPolicy, evaluateAttemptPolicy } from "./policy.mjs";
import { projectClaim, projectComplete, projectEnqueue, projectPolicyContext } from "./rpc-projection.mjs";

const PROMPT = getPromptManifest(PROMPT_MANIFEST_V1.prompt_version);
const IDENT_DIR = new URL("../../../../docs/contracts/fixtures/p1.5-identity/", import.meta.url);
const baseCatalog = JSON.parse(readFileSync(new URL("catalog.json", IDENT_DIR), "utf8"));

const META = {
  generated_at: "2026-10-12T00:00:00Z",
  generated_from: "reporting-read-model",
  lineage_ref: "1".repeat(64),
  access_scope_hash: "2".repeat(64),
};
const F = (date, project, recruiter, provider, employment, count) => ({
  business_date: date,
  project_key: project,
  recruiter_key: recruiter,
  provider_type_key: provider,
  employment_type_key: employment,
  recruited_count: count,
  source_key: "src-a",
});
const WEEK41 = { type: "week", as_of_date: "2026-10-11" };
const DIMS = { dimensions: ["project", "provider", "employment"] };
const facts = [
  F("2026-09-28", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 4),
  F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5),
  F("2026-10-07", "proj-beta", "rec-bravo", "vendor", "chính thức", 3),
];

function packetFor() {
  const built = buildPacketFromSource({
    request: { period: WEEK41, scope: DIMS },
    facts,
    source_health: [{ source_key: "src-a", status: "covered", quality: "ok", has_current_facts: true }],
    catalog: baseCatalog,
    metadata: META,
  });
  assert.ok(built.ok, "W03 packet: " + (built.ok ? "" : built.code));
  return built.packet;
}

function makeService({ queue, packet, policy = DEFAULT_POLICY, adapterFactory, audit = createMemoryAudit(), provider = { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "valid" } } }) {
  let nowMs = 0;
  const clock = { nowMs: () => nowMs, advance: (ms) => { nowMs += ms; } };
  const service = createAiReportService({
    queue,
    audit,
    packetLoader: async () => ({ ok: true, packet }),
    identityCatalog: { available: false, catalog: null },
    manifest: PROMPT,
    policy: { config: policy },
    provider,
    providerGate: { ok: true },
    adapterFactory,
    timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
    clock,
  });
  return { service, clock };
}

const enqueueArgs = (filters = null) => ({
  input: { period: WEEK41, scope: filters ? { ...DIMS, filters } : DIMS },
  actor_ref: "pilot-admin",
  access_scope_hash: "h",
  provider_key: "scripted",
  model_key: "scripted-deterministic-v1",
  adapter_version: "scripted-adapter/1.0",
  now_ms: 0,
});

function countingAdapter(counter) {
  const inner = createScriptedAdapter({ scenario: "valid" });
  return {
    provider_key: inner.provider_key,
    adapter_version: inner.adapter_version,
    async generateStructured(request) {
      counter.calls += 1;
      return inner.generateStructured(request);
    },
  };
}

/** Tạo job trực tiếp trong queue (mô phỏng DB đã có sẵn job vượt trần admission). */
async function seedJob(queue, packet, index) {
  return queue.enqueueOrReuse({
    identity_hash: String(index).repeat(16) + "seed",
    identity_components: {},
    request: {
      actor_ref: "pilot-admin",
      max_attempts: 3,
      packet,
      provider_key: "scripted",
      model_key: "scripted-deterministic-v1",
      adapter_version: "scripted-adapter/1.0",
      prompt_version: PROMPT.prompt_version,
    },
    now_ms: 0,
  });
}

// ---------------------------------------------------------------------------
// A. Policy stage separation
// ---------------------------------------------------------------------------

test("R4-A: admission policy (rate/queue/token) tách khỏi attempt policy (attempts/token/payload)", () => {
  const context = { now_ms: 0, actor_ref: "a", access_scope_hash: "h", recent_requests: [], queued_jobs: 0, attempts: 1, tokens_used_today: 0 };

  // Admission KHÔNG kiểm attempts/payload
  assert.equal(evaluateAdmissionPolicy({ config: DEFAULT_POLICY, context: { ...context, attempts: 99 } }).ok, true);
  assert.equal(evaluateAdmissionPolicy({ config: DEFAULT_POLICY, context, payload_bytes: DEFAULT_POLICY.max_payload_bytes + 1 }).ok, true);
  // Admission kiểm rate + queue depth + token
  assert.equal(evaluateAdmissionPolicy({ config: DEFAULT_POLICY, context: { ...context, recent_requests: [0, 0, 0, 0, 0, 0] } }).code, "AI_RATE_LIMITED");
  assert.equal(evaluateAdmissionPolicy({ config: DEFAULT_POLICY, context: { ...context, queued_jobs: DEFAULT_POLICY.max_queue_depth } }).code, "AI_CONCURRENCY_LIMITED");
  assert.equal(evaluateAdmissionPolicy({ config: DEFAULT_POLICY, context: { ...context, tokens_used_today: DEFAULT_POLICY.daily_token_ceiling } }).code, "AI_BUDGET_LIMITED");

  // Attempt KHÔNG kiểm queue-depth/rate
  assert.equal(evaluateAttemptPolicy({ config: DEFAULT_POLICY, context: { ...context, queued_jobs: 9999 } }).ok, true);
  assert.equal(evaluateAttemptPolicy({ config: DEFAULT_POLICY, context: { ...context, recent_requests: [0, 0, 0, 0, 0, 0] } }).ok, true);
  // Attempt kiểm attempts + payload + token
  assert.equal(evaluateAttemptPolicy({ config: DEFAULT_POLICY, context: { ...context, attempts: DEFAULT_POLICY.max_attempts + 1 } }).code, "AI_BUDGET_LIMITED");
  assert.equal(evaluateAttemptPolicy({ config: DEFAULT_POLICY, context, payload_bytes: DEFAULT_POLICY.max_payload_bytes + 1 }).code, "AI_BUDGET_LIMITED");
  assert.equal(evaluateAttemptPolicy({ config: DEFAULT_POLICY, context: { ...context, tokens_used_today: DEFAULT_POLICY.daily_token_ceiling } }).code, "AI_BUDGET_LIMITED");
});

test("R4-A2: queue vượt trần (admission đồng thời / ops hạ trần) vẫn DRAIN được", async () => {
  const packet = packetFor();
  const queue = createMemoryQueue();
  const counter = { calls: 0 };
  const { service } = makeService({ queue, packet, adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }) });

  // 4 job vào queue trực tiếp (bỏ qua admission) trong khi trần hàng đợi = 1
  for (let i = 1; i <= 4; i++) await seedJob(queue, packet, i);
  const status = await queue.policyContext({ actor_ref: "pilot-admin", window_seconds: 60 });
  assert.equal(status.value.queued_jobs, 4);
  assert.ok(status.value.queued_jobs > 1, "queue vượt trần hàng đợi (soft)");

  // ops hạ trần xuống dưới độ sâu hiện tại
  const tightPolicy = { ...DEFAULT_POLICY, max_queue_depth: 1 };
  const { service: tightService } = makeService({ queue, packet, policy: tightPolicy, adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }) });
  const blockedAdmission = await tightService.enqueueReport(enqueueArgs({ project_keys: ["proj-alpha"] }));
  assert.equal(blockedAdmission.code, "AI_CONCURRENCY_LIMITED", "admission chặn job mới (soft ceiling)");

  // Worker vẫn drain toàn bộ queue dù vượt trần
  for (let i = 0; i < 6; i++) {
    const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: i * 1000 });
    if (run.results[0].kind === "idle") break;
  }
  assert.equal(queue.store.revisions.size, 4, "tất cả job trong queue đều hoàn tất");
  const after = await queue.policyContext({ actor_ref: "pilot-admin", window_seconds: 60 });
  assert.equal(after.value.queued_jobs, 0);
});

test("R4-A3: worker không requeue chỉ vì queue còn đầy; inflight vẫn ≤ max_concurrent_jobs", async () => {
  const packet = packetFor();
  const queue = createMemoryQueue();
  const counter = { calls: 0 };
  const { service } = makeService({
    queue,
    packet,
    policy: { ...DEFAULT_POLICY, max_queue_depth: 1, max_concurrent_jobs: 2 },
    adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }),
  });
  for (let i = 1; i <= 3; i++) await seedJob(queue, packet, i);

  const first = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(first.results[0].kind, "completed", "queue đầy KHÔNG làm worker requeue");
  const context = await queue.policyContext({ actor_ref: "pilot-admin", window_seconds: 60 });
  assert.ok(context.value.inflight_jobs <= MAX_CONCURRENT_JOBS, "inflight không vượt trần");
  assert.equal(counter.calls, 1);
});

// ---------------------------------------------------------------------------
// B. Failure truthfulness trên mọi nhánh
// ---------------------------------------------------------------------------

const failureBranches = [
  {
    label: "policy (payload vượt trần attempt)",
    scenario: "valid",
    policy: { ...DEFAULT_POLICY, max_payload_bytes: 200 },
    expected_code: "AI_BUDGET_LIMITED",
    provider_called: false,
  },
  {
    label: "provider (timeout)",
    scenario: "timeout",
    policy: DEFAULT_POLICY,
    expected_code: "AI_PROVIDER_TIMEOUT",
    provider_called: true,
  },
  {
    label: "validation (bịa evidence)",
    scenario: "fabricated_evidence",
    policy: DEFAULT_POLICY,
    expected_code: "AI_VALIDATION_FAILED",
    provider_called: true,
  },
];

test("R4-B: fail() lỗi DB ⇒ infrastructure error (mọi nhánh: policy/provider/validation)", async () => {
  const packet = packetFor();
  for (const branch of failureBranches) {
    const queue = createMemoryQueue({ hooks: { failError: true } });
    const { service } = makeService({
      queue,
      packet,
      policy: branch.policy,
      provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: branch.scenario } },
    });
    const enqueued = await service.enqueueReport(enqueueArgs());
    assert.ok(enqueued.ok, branch.label);
    const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
    assert.equal(run.ok, false, branch.label + ": lỗi ghi DB phải nổi lên");
    assert.equal(run.code, "AI_INTERNAL", branch.label);
    const job = queue.store.jobs.get(enqueued.job_id);
    assert.ok(["computing", "ai_generating"].includes(job.status), branch.label + ": state DB không đổi");
  }
});

test("R4-B2: fail() mất lease ⇒ lease_lost (mọi nhánh), không báo retry/failed giả", async () => {
  const packet = packetFor();
  for (const branch of failureBranches) {
    const queue = createMemoryQueue({ hooks: { failLeaseLost: true } });
    const { service } = makeService({
      queue,
      packet,
      policy: branch.policy,
      provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: branch.scenario } },
    });
    const enqueued = await service.enqueueReport(enqueueArgs());
    assert.ok(enqueued.ok, branch.label);
    const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
    assert.equal(run.results[0].kind, "lease_lost", branch.label + ": kind=" + run.results[0].kind);
    assert.equal(run.results[0].error_code, null, branch.label + ": không gán mã lỗi giả");
    assert.equal(queue.store.revisions.size, 0);
    assert.equal(
      queue.store.usage.size,
      branch.provider_called ? 1 : 0,
      branch.label + ": usage chỉ được ghi khi provider đã thực sự được gọi"
    );
  }
});

test("R4-B3: nhánh thành công của fail() vẫn trả retry_scheduled/failed đúng (chỉ khi DB đã cập nhật)", async () => {
  const packet = packetFor();
  const queue = createMemoryQueue();
  const { service } = makeService({
    queue,
    packet,
    provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "timeout" } },
  });
  const enqueued = await service.enqueueReport(enqueueArgs());
  assert.ok(enqueued.ok);
  const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(run.results[0].kind, "retry_scheduled");
  assert.equal(run.results[0].status, "queued");
  assert.equal(queue.store.jobs.get(enqueued.job_id).status, "queued", "DB đã cập nhật");
});

// ---------------------------------------------------------------------------
// C. Policy-context strict projection
// ---------------------------------------------------------------------------

test("R4-C: projection policy context fail-closed khi RPC success nhưng thiếu/sai kiểu", () => {
  const valid = { recent_requests: [1, 2], queued_jobs: 3, inflight_jobs: 1, active_jobs: 4, tokens_used_today: 10 };
  const ok = projectPolicyContext(valid);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { recent_requests: [1, 2], queued_jobs: 3, inflight_jobs: 1, active_jobs: 4, tokens_used_today: 10 });

  const malformed = [
    null,
    {},
    { ...valid, recent_requests: undefined },
    { ...valid, recent_requests: "x" },
    { ...valid, recent_requests: [1, "2"] },
    { ...valid, recent_requests: [1, Number.NaN] },
    { ...valid, queued_jobs: undefined },
    { ...valid, queued_jobs: -1 },
    { ...valid, queued_jobs: 1.5 },
    { ...valid, inflight_jobs: undefined },
    { ...valid, inflight_jobs: "0" },
    { ...valid, tokens_used_today: undefined },
    { ...valid, tokens_used_today: -5 },
  ];
  for (const raw of malformed) {
    const result = projectPolicyContext(raw);
    assert.equal(result.ok, false, "phải fail-closed: " + JSON.stringify(raw));
    assert.equal(result.code, "AI_POLICY_REQUIRED");
  }
});

test("R4-C2: claim projection kiểm job/attempt/lease_token/provider-model-adapter-prompt", () => {
  const baseJob = {
    job_id: "11111111-1111-4111-8111-111111111111",
    identity_hash: "a".repeat(64),
    status: "computing",
    attempts: 1,
    max_attempts: 3,
    provider_key: "scripted",
    model_key: "scripted-deterministic-v1",
    adapter_version: "scripted-adapter/1.0",
    prompt_version: PROMPT.prompt_version,
    packet: { contract_version: "analysis-packet/0.1" },
  };
  const lease = "22222222-2222-4222-8222-222222222222";

  assert.equal(projectClaim(null), null, "null = idle");
  assert.equal(projectClaim({ ok: false, code: "AI_IDLE" }), null, "AI_IDLE = idle");
  assert.equal(projectClaim({ ok: false, code: "AI_CONCURRENCY_LIMITED" }).code, "AI_CONCURRENCY_LIMITED");

  // R5: success PHẢI có ok:true tường minh (parity với RPC SQL) — thiếu ⇒ malformed.
  const ok = projectClaim({ ok: true, job: baseJob, lease_token: lease, attempt: 1 });
  assert.equal(ok.ok, undefined);
  assert.equal(ok.job.job_id, baseJob.job_id);
  assert.equal(ok.lease_token, lease);

  const malformed = [
    { job: baseJob, lease_token: lease, attempt: 1 },
    { lease_token: lease, attempt: 1 },
    { job: {}, lease_token: lease, attempt: 1 },
    { job: { ...baseJob, attempts: undefined }, lease_token: lease, attempt: 1 },
    { job: { ...baseJob, max_attempts: 0 }, lease_token: lease, attempt: 1 },
    { job: baseJob, lease_token: "khong-phai-uuid", attempt: 1 },
    { job: baseJob, lease_token: lease, attempt: 0 },
    { job: { ...baseJob, provider_key: "" }, lease_token: lease, attempt: 1 },
    { job: { ...baseJob, model_key: undefined }, lease_token: lease, attempt: 1 },
    { job: { ...baseJob, adapter_version: null }, lease_token: lease, attempt: 1 },
    { job: { ...baseJob, prompt_version: "  " }, lease_token: lease, attempt: 1 },
    { job: { ...baseJob, packet: null }, lease_token: lease, attempt: 1 },
  ];
  for (const raw of malformed) {
    const result = projectClaim(raw);
    assert.equal(result.ok, false, "claim malformed phải fail: " + JSON.stringify(raw));
    assert.equal(result.code, "AI_INTERNAL");
  }

  assert.equal(projectEnqueue({}).code, "AI_INTERNAL");
  assert.equal(projectEnqueue({ job_id: "j", status: "queued", reused: false, cache_hit: false }).ok, true);
  assert.equal(projectComplete({}).code, "AI_INTERNAL");
  assert.equal(projectComplete({ revision_id: "r", already_completed: true }).already_completed, true);
});

test("R4-C3: worker nhận claim malformed ⇒ error, 0 provider call; policy context malformed ⇒ AI_POLICY_REQUIRED, 0 packet load", async () => {
  const packet = packetFor();
  const counter = { calls: 0 };

  const brokenClaimQueue = createMemoryQueue();
  const brokenClaim = {
    ...brokenClaimQueue,
    async claim() {
      return { job: { job_id: "x" }, lease_token: "khong-phai-uuid", attempt: 1 };
    },
  };
  brokenClaim.policyContext = brokenClaimQueue.policyContext.bind(brokenClaimQueue);
  await seedJob(brokenClaimQueue, packet, 7);
  const { service: claimService } = makeService({ queue: brokenClaim, packet, adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }) });
  const claimRun = await claimService.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(claimRun.ok, false);
  assert.equal(claimRun.code, "AI_INTERNAL");
  assert.equal(counter.calls, 0, "claim malformed ⇒ không gọi provider");

  let packetLoads = 0;
  const policyBrokenQueue = createMemoryQueue();
  const policyBroken = {
    ...policyBrokenQueue,
    async policyContext() {
      return { ok: true, value: { recent_requests: [], queued_jobs: "0", inflight_jobs: 0, tokens_used_today: 0 } };
    },
  };
  const serviceWithBrokenContext = createAiReportService({
    queue: policyBroken,
    audit: createMemoryAudit(),
    packetLoader: async () => {
      packetLoads += 1;
      return { ok: true, packet };
    },
    identityCatalog: { available: false, catalog: null },
    manifest: PROMPT,
    policy: { config: DEFAULT_POLICY },
    provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "valid" } },
    providerGate: { ok: true },
    timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
    clock: { nowMs: () => 0 },
  });
  const blocked = await serviceWithBrokenContext.enqueueReport(enqueueArgs());
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "AI_POLICY_REQUIRED");
  assert.equal(packetLoads, 0, "policy context malformed ⇒ không load packet");
});

// ---------------------------------------------------------------------------
// D. Durable audit
// ---------------------------------------------------------------------------

test("R4-D: exact-once cho new/reuse/cache-hit/fail/complete (DB là authority duy nhất)", async () => {
  const packet = packetFor();
  const queue = createMemoryQueue();
  const audit = createMemoryAudit();
  const { service } = makeService({ queue, packet, audit, provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "timeout" } } });
  const dbCount = (event, jobId) =>
    queue.store.audit.filter((row) => row.event_type === event && (jobId === undefined || row.job_id === jobId)).length;

  const first = await service.enqueueReport(enqueueArgs());
  assert.equal(dbCount("job_enqueued", first.job_id), 1);
  assert.equal(dbCount("job_reused"), 0);

  // reuse (job đang hoạt động)
  await service.enqueueReport(enqueueArgs());
  assert.equal(dbCount("job_reused"), 1, "reuse ghi đúng một event");
  assert.equal(dbCount("job_enqueued"), 1, "reuse không ghi thêm job_enqueued");

  // fail (provider timeout) ⇒ job_failed đúng một lần cho attempt đó
  await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(dbCount("job_failed", first.job_id), 1);
  assert.equal(dbCount("job_completed", first.job_id), 0);

  // attempt 2 thành công ⇒ job_completed đúng một lần + job_claimed 2 lần cho 2 attempt
  const healthy = makeService({ queue, packet, audit });
  await healthy.service.runWorker({ worker_ref: "w", limit: 1, now_ms: 120000 });
  assert.equal(dbCount("job_completed", first.job_id), 1);
  assert.equal(dbCount("job_claimed", first.job_id), 2, "mỗi attempt một job_claimed");

  // cache hit
  const cached = await service.enqueueReport(enqueueArgs());
  assert.equal(cached.cache_hit, true);
  assert.equal(dbCount("job_cache_hit"), 1, "cache hit ghi đúng một event");

  // application KHÔNG ghi lifecycle event nào
  assert.equal(audit.events.length, 0, "application không append lifecycle event");
});

test("R4-D2: audit insert lỗi ⇒ rollback TOÀN BỘ enqueue (không tạo job, không trả success)", async () => {
  const packet = packetFor();
  const queue = createMemoryQueue({ hooks: { auditInsertError: true } });
  const { service } = makeService({ queue, packet });
  const result = await service.enqueueReport(enqueueArgs());
  assert.equal(result.ok, false);
  assert.equal(result.code, "AI_INTERNAL");
  assert.equal(queue.store.jobs.size, 0, "không job nào được tạo khi audit insert lỗi");
  assert.equal(queue.store.audit.length, 0);
});

test("R4-D3: migration 160300 ghi audit reuse/cache-hit TRONG RPC enqueue (cùng transaction)", () => {
  const sql = readFileSync(
    new URL("../../../../supabase/migrations/20261001160300_p1_5_ai_report_enqueue_audit_authority.sql", import.meta.url),
    "utf8"
  );
  assert.ok(sql.includes("create or replace function public.ai_report_enqueue"));
  assert.ok(sql.includes("'job_reused'"));
  assert.ok(sql.includes("'job_cache_hit'"));
  assert.ok(sql.includes("'job_enqueued'"));
  assert.ok(sql.includes("security definer"));
  assert.ok(sql.includes("set search_path = public, pg_temp"));
  assert.ok(!/create\s+table/i.test(sql), "không tạo bảng mới");
  assert.ok(sql.includes("ROLLBACK"));
});
