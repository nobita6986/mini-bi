/**
 * P1.5-W04-R3 — Concurrency authority + audit exactness + mix grounding.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { buildPacketFromSource } from "../packet-builder.mjs";
import { buildProviderPayload } from "./payload.mjs";
import { getPromptManifest, PROMPT_MANIFEST_V1 } from "./prompt-registry.mjs";
import { createScriptedAdapter } from "./provider.mjs";
import { createMemoryAudit, createMemoryQueue } from "./testing/memory-queue.mjs";
import { createMemoryProviderConfig } from "./testing/fake-provider-config.mjs";
import { createAiReportService } from "./service-core.mjs";
import { DEFAULT_POLICY, MAX_CONCURRENT_JOBS } from "./limits.mjs";
import { evaluatePolicy } from "./policy.mjs";

const PROMPT = getPromptManifest(PROMPT_MANIFEST_V1.prompt_version);
const IDENT_DIR = new URL("../../../../docs/contracts/fixtures/p1.5-identity/", import.meta.url);
const MIGRATIONS_DIR = new URL("../../../../supabase/migrations/", import.meta.url);
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, IDENT_DIR), "utf8"));
const baseCatalog = readJson("catalog.json");

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
const SH = () => [{ source_key: "src-a", status: "covered", quality: "ok", has_current_facts: true }];
const WEEK41 = { type: "week", as_of_date: "2026-10-11" };
const DIMS = { dimensions: ["project", "provider", "employment"] };

const factsA = [
  F("2026-09-28", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 4),
  F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5),
  F("2026-10-07", "proj-beta", "rec-bravo", "vendor", "chính thức", 3),
];
const factsB = [
  F("2026-09-28", "proj-gamma", "rec-charlie", "hrp", "chính thức", 2),
  F("2026-10-06", "proj-gamma", "rec-charlie", "hrp", "chính thức", 6),
  F("2026-10-07", "proj-delta", "rec-echo", "vendor", "thời vụ", 1),
];

function packetFor(facts) {
  const built = buildPacketFromSource({
    request: { period: WEEK41, scope: DIMS },
    facts,
    source_health: SH(),
    catalog: baseCatalog,
    metadata: META,
  });
  assert.ok(built.ok, "W03 packet: " + (built.ok ? "" : built.code));
  return built.packet;
}

function makeService({ queue, packet, policy = DEFAULT_POLICY, adapterFactory, audit = createMemoryAudit(), provider = { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "valid" } } }) {
  let nowMs = 0;
  const clock = { nowMs: () => nowMs, advance: (ms) => { nowMs += ms; } };
  const service = createAiReportService({ providerConfig: createMemoryProviderConfig(),
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

const enqueueArgs = (period = WEEK41, filters = null) => ({
  input: { period, scope: filters ? { dimensions: DIMS.dimensions, filters } : DIMS },
  actor_ref: "pilot-admin",
  access_scope_hash: "h",
  provider_key: "scripted",
  model_key: "scripted-deterministic-v1",
  adapter_version: "scripted-adapter/1.0",
  now_ms: 0,
});

function barrierAdapter() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const state = { inflight: 0, max_inflight: 0, calls: 0 };
  const inner = createScriptedAdapter({ scenario: "valid" });
  return {
    state,
    release,
    adapter: {
      provider_key: inner.provider_key,
      adapter_version: inner.adapter_version,
      async generateStructured(request) {
        state.calls += 1;
        state.inflight += 1;
        state.max_inflight = Math.max(state.max_inflight, state.inflight);
        try {
          await gate;
          return await inner.generateStructured(request);
        } finally {
          state.inflight -= 1;
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// A. Concurrency authority
// ---------------------------------------------------------------------------

test("R3-A: policy không còn chặn theo job đang chạy — chỉ còn trần HÀNG ĐỢI", async () => {
  const packet = packetFor(factsA);
  const queue = createMemoryQueue();
  const { service } = makeService({ queue, packet });

  // 2 identity khác nhau vào queue ⇒ KHÔNG bị chặn (max_concurrent_jobs = 2)
  const first = await service.enqueueReport(enqueueArgs());
  const second = await service.enqueueReport(enqueueArgs(WEEK41, { project_keys: ["proj-alpha"] }));
  assert.ok(first.ok && second.ok, "enqueue 2 identity khác nhau phải thành công");
  assert.equal(queue.store.jobs.size, 2);

  const context = await queue.policyContext({ actor_ref: "pilot-admin", window_seconds: 60 });
  assert.equal(context.value.queued_jobs, 2, "queued_jobs đếm job chờ");
  assert.equal(context.value.inflight_jobs, 0, "chưa có job nào giữ slot provider");
  assert.equal(
    evaluatePolicy({ config: { ...DEFAULT_POLICY }, context: { now_ms: 0, actor_ref: "a", access_scope_hash: "h", recent_requests: [], queued_jobs: 2, attempts: 0, tokens_used_today: 0 } }).ok,
    true,
    "2 job queued không được chặn bởi concurrency"
  );

  // Worker chạy được cả hai job (không livelock), mỗi job đúng một lần gọi provider.
  const run1 = await service.runWorker({ worker_ref: "w1", limit: 1, now_ms: 0 });
  assert.equal(run1.results[0].kind, "completed");
  const run2 = await service.runWorker({ worker_ref: "w1", limit: 1, now_ms: 0 });
  assert.equal(run2.results[0].kind, "completed");
  const run3 = await service.runWorker({ worker_ref: "w1", limit: 1, now_ms: 0 });
  assert.equal(run3.results[0].kind, "idle");
  assert.equal(queue.store.revisions.size, 2, "cả hai job phải hoàn tất");
});

test("R3-A2: claim enforce trần concurrency atomic — job thứ ba không gọi provider khi 2 slot đang giữ", async () => {
  const packetA = packetFor(factsA);
  const packetB = packetFor(factsB);
  const queue = createMemoryQueue();
  const packets = { a: packetA, b: packetB };
  let current = "a";
  const service = createAiReportService({ providerConfig: createMemoryProviderConfig(),
    queue,
    audit: createMemoryAudit(),
    packetLoader: async () => ({ ok: true, packet: current === "a" ? packets.a : packets.b }),
    identityCatalog: { available: false, catalog: null },
    manifest: PROMPT,
    policy: { config: DEFAULT_POLICY },
    provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "valid" } },
    providerGate: { ok: true },
    timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
    clock: { nowMs: () => 0 },
  });

  // 3 identity khác nhau (đổi scope filter ⇒ identity khác)
  await service.enqueueReport(enqueueArgs());
  current = "b";
  await service.enqueueReport(enqueueArgs(WEEK41, { project_keys: ["proj-alpha"] }));
  await service.enqueueReport(enqueueArgs(WEEK41, { project_keys: ["proj-beta"] }));
  assert.equal(queue.store.jobs.size, 3);

  const barrier = barrierAdapter();
  const withBarrier = createAiReportService({ providerConfig: createMemoryProviderConfig(),
    queue,
    audit: createMemoryAudit(),
    packetLoader: async () => ({ ok: true, packet: packets.a }),
    identityCatalog: { available: false, catalog: null },
    manifest: PROMPT,
    policy: { config: { ...DEFAULT_POLICY, max_concurrent_jobs: 2 } },
    provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "valid" } },
    providerGate: { ok: true },
    adapterFactory: () => ({ ok: true, adapter: barrier.adapter }),
    timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
    clock: { nowMs: () => 0 },
  });

  const flush = async (times = 20) => {
    for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const workerA = withBarrier.runWorker({ worker_ref: "wa", limit: 1, now_ms: 0 });
  await flush();
  const workerB = withBarrier.runWorker({ worker_ref: "wb", limit: 1, now_ms: 0 });
  await flush();

  let workerC = null;
  try {
    assert.equal(barrier.state.max_inflight, MAX_CONCURRENT_JOBS, "hai slot đang thực sự được giữ");
    workerC = await withBarrier.runWorker({ worker_ref: "wc", limit: 1, now_ms: 0 });
    assert.equal(workerC.results[0].kind, "deferred");
    assert.equal(workerC.results[0].error_code, "AI_CONCURRENCY_LIMITED");
    assert.ok(barrier.state.calls <= MAX_CONCURRENT_JOBS, "không vượt trần provider call: " + barrier.state.calls);
  } finally {
    // Luôn giải phóng barrier để không treo tiến trình test khi assertion ở trên fail.
    barrier.release();
  }

  const [doneA, doneB] = await Promise.all([workerA, workerB]);
  assert.equal(barrier.state.max_inflight, MAX_CONCURRENT_JOBS);
  assert.ok(doneA.results[0].kind === "completed" && doneB.results[0].kind === "completed");
  assert.equal(barrier.state.calls, 2, "đúng 2 provider call cho 2 slot");

  const after = await withBarrier.runWorker({ worker_ref: "wd", limit: 1, now_ms: 0 });
  assert.equal(after.results[0].kind, "completed", "job thứ ba chạy sau khi slot được giải phóng");
  assert.equal(barrier.state.calls, 3);
});

test("R3-A3: lease lost / stale recovery không làm vượt trần và không giữ slot", async () => {
  const packet = packetFor(factsA);
  const queue = createMemoryQueue();
  const first = await queue.enqueueOrReuse({
    identity_hash: "c".repeat(16),
    identity_components: {},
    request: { actor_ref: "pilot-admin", max_attempts: 3, packet, provider_key: "scripted", model_key: "m", adapter_version: "scripted-adapter/1.0", prompt_version: PROMPT.prompt_version },
    now_ms: 0,
  });
  const second = await queue.enqueueOrReuse({
    identity_hash: "d".repeat(16),
    identity_components: {},
    request: { actor_ref: "pilot-admin", max_attempts: 3, packet, provider_key: "scripted", model_key: "m", adapter_version: "scripted-adapter/1.0", prompt_version: PROMPT.prompt_version },
    now_ms: 0,
  });

  // Giữ 1 slot bằng lease còn hiệu lực
  const held = await queue.claim({ worker_ref: "w1", lease_seconds: 60, now_ms: 0, max_concurrent_jobs: 1 });
  assert.equal(held.job.job_id, first.job_id);
  const blocked = await queue.claim({ worker_ref: "w2", lease_seconds: 60, now_ms: 0, max_concurrent_jobs: 1 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "AI_CONCURRENCY_LIMITED");

  // Lease hết hạn ⇒ recovery trả slot, job khác claim được (không giữ slot vô hạn)
  const later = await queue.claim({ worker_ref: "w3", lease_seconds: 60, now_ms: 120000, max_concurrent_jobs: 1 });
  assert.ok(later && later.job, "sau recovery phải claim được job");
  assert.ok([first.job_id, second.job_id].includes(later.job.job_id));
  const context = await queue.policyContext({ actor_ref: "pilot-admin", window_seconds: 60 });
  assert.ok(context.value.inflight_jobs <= 1, "sau recovery chỉ còn tối đa 1 slot đang giữ");
});

test("R3-A4: trần hàng đợi vẫn fail-closed khi queue thực sự đầy", async () => {
  const packet = packetFor(factsA);
  const queue = createMemoryQueue();
  const { service } = makeService({ queue, packet, policy: { ...DEFAULT_POLICY, max_queue_depth: 1 } });
  const first = await service.enqueueReport(enqueueArgs());
  assert.ok(first.ok);
  const second = await service.enqueueReport(enqueueArgs({ type: "month", as_of_date: "2026-10-11" }));
  assert.equal(second.ok, false);
  assert.equal(second.code, "AI_CONCURRENCY_LIMITED");
});

// ---------------------------------------------------------------------------
// B. Audit exactly-once + fail truthfulness
// ---------------------------------------------------------------------------

/** Đếm event theo ĐÚNG authority: DB (queue trail) và application (audit sink) là hai nguồn tách biệt. */
function auditCounts(queue, eventType, jobId, sink) {
  const inQueue = queue.store.audit.filter(
    (event) => event.event_type === eventType && (jobId === undefined || event.job_id === jobId)
  ).length;
  const inSink = (sink?.events ?? []).filter(
    (event) => event.event_type === eventType && (jobId === undefined || event.job_id === jobId)
  ).length;
  return inQueue + inSink;
}

const DB_EVENTS = ["job_enqueued", "job_claimed", "job_stage", "job_completed", "job_failed", "job_regenerated"];
const APP_EVENTS = ["job_reused", "job_cache_hit"];

test("R3-B: mỗi lifecycle có đúng số audit event (DB authority + application authority)", async () => {
  const packet = packetFor(factsA);
  const queue = createMemoryQueue();
  const audit = createMemoryAudit();
  const { service } = makeService({ queue, packet, audit });
  const count = (eventType, jobId) => auditCounts(queue, eventType, jobId, audit);

  const enqueued = await service.enqueueReport(enqueueArgs());
  assert.ok(enqueued.ok);
  assert.equal(count("job_enqueued"), 1, "job_enqueued đúng một lần");
  assert.equal(queue.store.audit.filter((event) => event.event_type === "job_enqueued").length, 1, "DB là authority của job_enqueued");
  assert.equal(audit.events.length, 0, "application KHÔNG ghi trùng job_enqueued");

  await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(count("job_claimed"), 1);
  assert.equal(count("job_stage"), 1, "một stage ai_generating");
  assert.equal(count("job_completed"), 1);
  assert.equal(count("job_failed"), 0);
  for (const event of ["job_claimed", "job_stage", "job_completed"]) {
    assert.equal(audit.events.filter((row) => row.event_type === event).length, 0, "application không ghi " + event);
  }

  // Identity THỨ HAI (khác filter) ⇒ job mới đang hoạt động; enqueue lại chính là REUSE.
  const secondIdentity = enqueueArgs(WEEK41, { project_keys: ["proj-alpha"] });
  const second = await service.enqueueReport(secondIdentity);
  assert.ok(second.ok);
  assert.equal(second.reused, false);
  const reusedAgain = await service.enqueueReport(secondIdentity);
  assert.ok(reusedAgain.ok);
  assert.equal(reusedAgain.reused, true);
  assert.equal(reusedAgain.job_id, second.job_id);
  // R4: job_reused do DB ghi (cùng transaction với quyết định) — application KHÔNG ghi nữa.
  assert.equal(auditCounts(queue, "job_reused", undefined, audit), 1, "job_reused đúng một lần");
  assert.equal(queue.store.audit.filter((event) => event.event_type === "job_reused").length, 1, "DB là authority của job_reused");
  assert.equal(audit.events.filter((row) => row.event_type === "job_reused").length, 0, "application không ghi job_reused");
  assert.equal(count("job_enqueued", second.job_id), 1, "không ghi thêm job_enqueued khi reuse");

  // Hoàn tất job thứ hai rồi enqueue lại ⇒ CACHE HIT đúng một lần
  await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  const cached = await service.enqueueReport(secondIdentity);
  assert.equal(cached.cache_hit, true);
  assert.equal(queue.store.audit.filter((row) => row.event_type === "job_cache_hit").length, 1, "DB ghi job_cache_hit đúng một lần");
  assert.equal(audit.events.filter((row) => row.event_type === "job_cache_hit").length, 0, "application không ghi job_cache_hit");
  assert.equal(count("job_completed"), 2, "mỗi revision đúng một job_completed");
  assert.equal(queue.store.revisions.size, 2, "không duplicate revision");

  // Không event nào bị ghi bởi cả hai nguồn
  for (const event of DB_EVENTS) {
    assert.equal(audit.events.filter((row) => row.event_type === event).length, 0, "application không được ghi " + event);
  }
  // R4: application KHÔNG còn event nào thuộc DB (kể cả reused/cache_hit).
  for (const event of APP_EVENTS) {
    assert.equal(audit.events.filter((row) => row.event_type === event).length, 0, "application không được ghi " + event);
  }
});

test("R3-B2/R4: DB là authority DUY NHẤT cho mọi lifecycle event; application không append event nào", () => {
  const migrationSql = [
    "20261001160000_p1_5_ai_report_gateway.sql",
    "20261001160200_p1_5_ai_report_claim_concurrency.sql",
    "20261001160300_p1_5_ai_report_enqueue_audit_authority.sql",
  ]
    .map((name) => readFileSync(new URL(name, MIGRATIONS_DIR), "utf8"))
    .join("\n");
  const dbEvents = new Set(
    [...migrationSql.matchAll(/'job_(?:enqueued|reused|cache_hit|claimed|stage|completed|failed|regenerated)'/g)].map((match) =>
      match[0].replace(/'/g, "")
    )
  );
  assert.deepEqual([...dbEvents].sort(), [
    "job_cache_hit",
    "job_claimed",
    "job_completed",
    "job_enqueued",
    "job_failed",
    "job_regenerated",
    "job_reused",
    "job_stage",
  ]);

  const serviceCore = readFileSync(new URL("./service-core.mjs", import.meta.url), "utf8");
  const runOneJob = readFileSync(new URL("./run-one-job.mjs", import.meta.url), "utf8");
  for (const event of dbEvents) {
    assert.ok(!serviceCore.includes('"' + event + '"'), "service-core không được ghi " + event);
    assert.ok(!runOneJob.includes('event_type: "' + event + '"'), "run-one-job không được ghi " + event);
  }
  assert.ok(!runOneJob.includes("deps.audit.append"), "application không còn append lifecycle event");
});

test("R3-B3: queue.fail() không cập nhật được ⇒ worker báo lease_lost/infrastructure, không báo retry giả", async () => {
  const packet = packetFor(factsA);

  const leaseQueue = createMemoryQueue({ hooks: { failLeaseLost: true } });
  const leaseService = makeService({ queue: leaseQueue, packet, provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "timeout" } } });
  const enqueuedLease = await leaseService.service.enqueueReport(enqueueArgs());
  assert.ok(enqueuedLease.ok);
  const leaseRun = await leaseService.service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(leaseRun.results[0].kind, "lease_lost");
  const jobLease = leaseQueue.store.jobs.get(enqueuedLease.job_id);
  assert.equal(jobLease.status, "ai_generating", "state DB không đổi ⇒ worker KHÔNG được báo failed/retry");

  const errorQueue = createMemoryQueue({ hooks: { failError: true } });
  const errorService = makeService({ queue: errorQueue, packet, provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "transient_5xx" } } });
  const enqueuedError = await errorService.service.enqueueReport(enqueueArgs());
  assert.ok(enqueuedError.ok);
  const errorRun = await errorService.service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(errorRun.ok, false, "lỗi ghi trạng thái thất bại là lỗi hạ tầng");
  assert.equal(errorRun.code, "AI_INTERNAL");
});

test("R3-B4: complete idempotent (mất response) không sinh job_completed thừa", async () => {
  const packet = packetFor(factsA);
  const queue = createMemoryQueue({ hooks: { completeAfterCommit: true } });
  const { service } = makeService({ queue, packet });
  const enqueued = await service.enqueueReport(enqueueArgs());
  assert.ok(enqueued.ok);
  await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  await service.runWorker({ worker_ref: "w2", limit: 1, now_ms: 0 });
  assert.equal(auditCounts(queue, "job_completed"), 1, "đúng một job_completed dù complete bị gọi lại");
  assert.equal(queue.store.revisions.size, 1);
  assert.equal(queue.store.usage.size, 1);
});

// ---------------------------------------------------------------------------
// C. Mix grounding
// ---------------------------------------------------------------------------

function sameNumber(a, b) {
  return typeof a === "number" && typeof b === "number" && a === b;
}

test("R3-C: mọi numeric field trong project_provider_mix gửi đi đều có evidence khớp metric+subject+value+unit", () => {
  const packet = packetFor(factsA);
  const built = buildProviderPayload(packet, PROMPT);
  assert.ok(built.ok, built.ok ? "" : built.code);
  const payload = built.payload;
  assert.ok(payload.project_provider_mix.length > 0);

  const fields = [
    ["project_mix.total", "project_total", "people"],
    ["project_mix.hrp_count", "hrp_count", "people"],
    ["project_mix.vendor_count", "vendor_count", "people"],
    ["project_mix.unknown_count", "unknown_count", "people"],
    ["project_mix.invalid_count", "invalid_count", "people"],
    ["project_mix.known_total", "known_total", "people"],
    ["project_mix.hrp_share", "hrp_share", "ratio"],
    ["project_mix.vendor_share", "vendor_share", "ratio"],
    ["project_mix.known_coverage", "known_coverage", "ratio"],
  ];
  for (const row of payload.project_provider_mix) {
    for (const [metric, field, unit] of fields) {
      const value = row[field];
      if (value === null) continue;
      const evidence = payload.evidence.find((entry) => entry.metric === metric && entry.subject_ref === row.subject_ref);
      assert.ok(evidence, metric + " phải có evidence cho " + row.subject_ref);
      assert.ok(sameNumber(evidence.value, value), metric + " value phải khớp");
      assert.equal(evidence.unit, unit, metric + " unit phải khớp");
    }
    // Row gửi đi luôn tự nhất quán
    assert.equal(row.project_total, row.hrp_count + row.vendor_count + row.unknown_count + row.invalid_count);
    assert.equal(row.known_total, row.hrp_count + row.vendor_count);
  }
});

test("R3-C2: value feature lệch evidence (giữ evidence cũ) ⇒ field/row bị loại, không gửi số vô căn cứ", () => {
  const packet = packetFor(factsA);

  // (1) Sửa vendor_count nhưng GIỮ evidence cũ ⇒ row mix bị loại (vì count không còn grounding).
  const tampered = JSON.parse(JSON.stringify(packet));
  tampered.project_provider_mix[0].vendor_count = tampered.project_provider_mix[0].vendor_count + 7;
  const tamperedPayload = buildProviderPayload(tampered, PROMPT);
  assert.ok(tamperedPayload.ok, tamperedPayload.ok ? "" : tamperedPayload.code);
  const droppedSubject = packet.project_provider_mix[0].subject_ref;
  const stillSent = (tamperedPayload.payload.project_provider_mix ?? []).some((row) => row.subject_ref === droppedSubject);
  assert.equal(stillSent, false, "row có count không grounding phải bị loại");

  // (2) Sửa driver.current nhưng giữ evidence cũ ⇒ field current = null (không gửi số sai).
  const tamperedDriver = JSON.parse(JSON.stringify(packet));
  const dimension = "project";
  const target = tamperedDriver.drivers[dimension][0];
  target.current = target.current + 100;
  const driverPayload = buildProviderPayload(tamperedDriver, PROMPT);
  assert.ok(driverPayload.ok, driverPayload.ok ? "" : driverPayload.code);
  const sent = (driverPayload.payload.drivers.find((row) => row.dimension === dimension)?.entries ?? []).find(
    (entry) => entry.subject_ref === target.subject_ref
  );
  assert.ok(!sent || sent.current === undefined || sent.current === null, "current lệch evidence phải không được gửi");

  // (3) Unit lệch (evidence people nhưng field ratio) ⇒ không gửi.
  const unitTampered = JSON.parse(JSON.stringify(packet));
  const shareSubject = unitTampered.project_provider_mix[0].subject_ref;
  unitTampered.evidence = unitTampered.evidence.map((entry) =>
    entry.metric === "project_mix.hrp_share" && entry.subject_ref === shareSubject ? { ...entry, unit: "people" } : entry
  );
  const unitPayload = buildProviderPayload(unitTampered, PROMPT);
  assert.ok(unitPayload.ok, unitPayload.ok ? "" : unitPayload.code);
  const unitRow = (unitPayload.payload.project_provider_mix ?? []).find((row) => row.subject_ref === shareSubject);
  if (unitRow) assert.equal(unitRow.hrp_share, null, "unit lệch ⇒ share không được gửi");
});

test("R3-C3: provider filter active ⇒ loại TOÀN BỘ project_provider_mix (regression R2)", () => {
  const built = buildPacketFromSource({
    request: { period: WEEK41, scope: { dimensions: ["project", "provider"], filters: { provider_type_keys: ["vendor"] } } },
    facts: factsA,
    source_health: SH(),
    catalog: baseCatalog,
    metadata: META,
  });
  assert.ok(built.ok);
  const payload = buildProviderPayload(built.packet, PROMPT);
  assert.ok(payload.ok, payload.ok ? "" : payload.code);
  assert.equal(payload.payload.project_provider_mix, null);
  assert.equal(payload.payload.provider_composition_allowed, false);
});
