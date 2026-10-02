/**
 * P1.5-W04-R5 — STRICT RPC PROJECTION CLOSURE.
 *
 * Khép các lỗ hổng projection còn lại của R4: claim (undefined/idle/attempt invariants),
 * enqueue (boolean bắt buộc, loại trừ lẫn nhau, revision khi cache hit, status hợp lệ),
 * complete (already_completed boolean thật), recoverStale (recovered integer >= 0).
 *
 * Nguyên tắc: KHÔNG nới schema, KHÔNG fallback để test pass — malformed ⇒ fail-closed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { buildPacketFromSource } from "../packet-builder.mjs";
import { getPromptManifest, PROMPT_MANIFEST_V1 } from "./prompt-registry.mjs";
import { createScriptedAdapter } from "./provider.mjs";
import { createMemoryAudit, createMemoryQueue } from "./testing/memory-queue.mjs";
import { createMemoryProviderConfig } from "./testing/fake-provider-config.mjs";
import { createAiReportService } from "./service-core.mjs";
import { DEFAULT_POLICY } from "./limits.mjs";
import {
  ENQUEUE_STATUSES,
  projectClaim,
  projectComplete,
  projectEnqueue,
  projectRecoverStale,
} from "./rpc-projection.mjs";

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

function makeService({ queue, packet, policy = DEFAULT_POLICY, adapterFactory, provider = { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "valid" } } }) {
  let nowMs = 0;
  const clock = { nowMs: () => nowMs, advance: (ms) => { nowMs += ms; } };
  const service = createAiReportService({ providerConfig: createMemoryProviderConfig(),
    queue,
    audit: createMemoryAudit(),
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

const enqueueArgs = () => ({
  input: { period: WEEK41, scope: DIMS },
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

/** Tạo job trực tiếp trong queue (không qua policy admission). */
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

const LEASE = "22222222-2222-4222-8222-222222222222";
const baseJob = () => ({
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
});

// ---------------------------------------------------------------------------
// A. Claim projection
// ---------------------------------------------------------------------------

test("R5-A1: claim CHỈ idle với null hoặc {ok:false, code:'AI_IDLE'}; undefined/rỗng/malformed ⇒ AI_INTERNAL", () => {
  assert.equal(projectClaim(null), null);
  assert.equal(projectClaim({ ok: false, code: "AI_IDLE" }), null);

  for (const raw of [undefined, {}, [], "idle", 0, true, { ok: true }, { ok: "true" }, { ok: false }, { ok: false, code: "" }]) {
    const result = projectClaim(raw);
    assert.ok(result !== null, "KHÔNG được coi là idle: " + JSON.stringify(raw));
    assert.equal(result.ok, false);
    assert.equal(result.code, "AI_INTERNAL", "phải là AI_INTERNAL: " + JSON.stringify(raw));
  }

  // Lỗi tường minh (không phải idle) vẫn giữ nguyên code để caller xử lý deferred/fail.
  assert.equal(projectClaim({ ok: false, code: "AI_CONCURRENCY_LIMITED" }).code, "AI_CONCURRENCY_LIMITED");
});

test("R5-A2: claim attempt invariants — integer >= 1, bằng job.attempts, không vượt max_attempts", () => {
  assert.equal(projectClaim({ ok: true, job: baseJob(), lease_token: LEASE, attempt: 1 }).attempt, 1);
  // attempts = max_attempts = 3 vẫn hợp lệ (lần thử cuối).
  const lastTry = projectClaim({ ok: true, job: { ...baseJob(), attempts: 3 }, lease_token: LEASE, attempt: 3 });
  assert.equal(lastTry.ok, undefined);
  assert.equal(lastTry.attempt, 3);

  const malformed = [
    ["job.attempts = 0", { ok: true, job: { ...baseJob(), attempts: 0 }, lease_token: LEASE, attempt: 0 }],
    ["attempt = 0", { ok: true, job: baseJob(), lease_token: LEASE, attempt: 0 }],
    ["attempt lệch job.attempts", { ok: true, job: { ...baseJob(), attempts: 2 }, lease_token: LEASE, attempt: 1 }],
    ["attempt vượt max_attempts", { ok: true, job: { ...baseJob(), attempts: 4, max_attempts: 3 }, lease_token: LEASE, attempt: 4 }],
    ["attempt không phải integer", { ok: true, job: baseJob(), lease_token: LEASE, attempt: 1.5 }],
  ];
  for (const [label, raw] of malformed) {
    const result = projectClaim(raw);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "AI_INTERNAL", label);
  }
});

test("R5-A3: integration — queue.claim() trả undefined ⇒ worker error, 0 provider, 0 usage, 0 revision", async () => {
  const packet = packetFor();
  const counter = { calls: 0 };
  const queue = createMemoryQueue({ hooks: { claimRaw: undefined } });
  const { service } = makeService({ queue, packet, adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }) });

  const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(run.ok, false, "claim undefined KHÔNG được coi là idle/khỏe mạnh");
  assert.equal(run.code, "AI_INTERNAL");
  assert.equal(counter.calls, 0, "0 provider call");
  assert.equal(queue.store.usage.size, 0, "0 usage");
  assert.equal(queue.store.revisions.size, 0, "0 revision");
});

test("R5-A4: integration — claim malformed (attempts=0 · attempt lệch · vượt trần) ⇒ error, 0 provider/usage/revision", async () => {
  const packet = packetFor();
  const variants = [
    ["attempts = 0", { ok: true, job: { ...baseJob(), attempts: 0 }, lease_token: LEASE, attempt: 0 }],
    ["attempt lệch job.attempts", { ok: true, job: { ...baseJob(), attempts: 2 }, lease_token: LEASE, attempt: 1 }],
    ["attempt vượt max_attempts", { ok: true, job: { ...baseJob(), attempts: 4 }, lease_token: LEASE, attempt: 4 }],
    ["object rỗng", {}],
  ];
  for (const [label, claimRaw] of variants) {
    const counter = { calls: 0 };
    const queue = createMemoryQueue({ hooks: { claimRaw } });
    const { service } = makeService({ queue, packet, adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }) });
    const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
    assert.equal(run.ok, false, label);
    assert.equal(run.code, "AI_INTERNAL", label);
    assert.equal(counter.calls, 0, label + ": 0 provider call");
    assert.equal(queue.store.usage.size, 0, label + ": 0 usage");
    assert.equal(queue.store.revisions.size, 0, label + ": 0 revision");
  }
});

// ---------------------------------------------------------------------------
// B. Enqueue projection
// ---------------------------------------------------------------------------

test("R5-B1: enqueue booleans bắt buộc, loại trừ lẫn nhau, cache_hit cần revision_id, status phải hợp lệ", () => {
  const good = { job_id: "j1", status: "queued", reused: false, cache_hit: false, revision_id: null };
  assert.equal(projectEnqueue(good).ok, true);
  assert.equal(projectEnqueue({ ...good, status: "draft", cache_hit: true, revision_id: "rev-1" }).cache_hit, true);
  assert.equal(projectEnqueue({ ...good, reused: true, revision_id: "rev-1" }).reused, true);

  const malformed = [
    ["thiếu reused", { job_id: "j1", status: "queued", cache_hit: false }],
    ["reused sai kiểu", { ...good, reused: "false" }],
    ["thiếu cache_hit", { job_id: "j1", status: "queued", reused: false }],
    ["cache_hit sai kiểu", { ...good, cache_hit: 0 }],
    ["reused và cache_hit cùng true", { ...good, reused: true, cache_hit: true, revision_id: "rev-1" }],
    ["cache_hit thiếu revision_id", { ...good, status: "draft", cache_hit: true }],
    ["cache_hit revision_id rỗng", { ...good, status: "draft", cache_hit: true, revision_id: "  " }],
    ["revision_id sai kiểu", { ...good, revision_id: 7 }],
    ["status lạ", { ...good, status: "failed_provider_transient" }],
    ["status không phải string", { ...good, status: 3 }],
    ["thiếu job_id", { status: "queued", reused: false, cache_hit: false }],
    ["response rỗng", {}],
  ];
  for (const [label, raw] of malformed) {
    const result = projectEnqueue(raw);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "AI_INTERNAL", label);
  }

  // Tập trạng thái hợp lệ phải khớp những gì RPC enqueue thực sự trả được.
  assert.deepEqual([...ENQUEUE_STATUSES], ["requested", "queued", "computing", "ai_generating", "validating", "draft"]);
});

test("R5-B2: integration — enqueue malformed KHÔNG được thành ok:true/reused:false/cache_hit:false", async () => {
  const packet = packetFor();
  const variants = [
    ["thiếu booleans", { ok: true, job_id: "00000000-0000-4000-8000-000000000009", status: "queued" }],
    ["reused+cache_hit cùng true", { ok: true, job_id: "j", status: "queued", reused: true, cache_hit: true, revision_id: "rev" }],
    ["cache_hit thiếu revision", { ok: true, job_id: "j", status: "draft", reused: false, cache_hit: true }],
    ["status ngoài tập", { ok: true, job_id: "j", status: "failed_internal", reused: false, cache_hit: false }],
  ];
  for (const [label, enqueueRaw] of variants) {
    const queue = createMemoryQueue({ hooks: { enqueueRaw } });
    const { service } = makeService({ queue, packet });
    const result = await service.enqueueReport(enqueueArgs());
    assert.equal(result.ok, false, label + ": malformed enqueue không được trả success");
    assert.equal(result.code, "AI_INTERNAL", label);
    assert.equal(queue.store.jobs.size, 0, label + ": không tạo job");
  }
});

// ---------------------------------------------------------------------------
// C. Complete projection
// ---------------------------------------------------------------------------

test("R5-C1: complete — already_completed phải là boolean thật và revision_id bắt buộc", () => {
  assert.equal(projectComplete({ revision_id: "rev-1", already_completed: false }).already_completed, false);
  assert.equal(projectComplete({ revision_id: "rev-1", already_completed: true }).already_completed, true);

  const malformed = [
    ["thiếu already_completed", { revision_id: "rev-1" }],
    ["already_completed = 'true'", { revision_id: "rev-1", already_completed: "true" }],
    ["already_completed = 1", { revision_id: "rev-1", already_completed: 1 }],
    ["already_completed = null", { revision_id: "rev-1", already_completed: null }],
    ["thiếu revision_id", { already_completed: false }],
    ["revision_id rỗng", { revision_id: " ", already_completed: true }],
    ["response rỗng", {}],
    ["response undefined", undefined],
  ];
  for (const [label, raw] of malformed) {
    const result = projectComplete(raw);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "AI_INTERNAL", label);
  }
});

test("R5-C2: integration — complete malformed ⇒ KHÔNG bao giờ 'completed' và 0 revision", async () => {
  const packet = packetFor();
  const counter = { calls: 0 };
  const queue = createMemoryQueue({ hooks: { completeRaw: { ok: true, revision_id: "rev-1" } } });
  await seedJob(queue, packet, 5);
  const { service } = makeService({ queue, packet, adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }) });

  const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(counter.calls, 1, "provider chỉ được gọi đúng một lần");
  if (run.ok === true) {
    assert.notEqual(run.results[0].kind, "completed", "complete malformed KHÔNG được coi là completed");
    assert.equal(run.results[0].revision_id, null, "không được trả revision_id bịa");
  } else {
    assert.equal(run.code, "AI_INTERNAL");
  }
  assert.equal(queue.store.revisions.size, 0, "0 revision được ghi nhận");
});

// ---------------------------------------------------------------------------
// D. Recover-stale projection
// ---------------------------------------------------------------------------

test("R5-D1: recoverStale — recovered bắt buộc integer >= 0, KHÔNG fallback 0", () => {
  assert.equal(projectRecoverStale({ ok: true, recovered: 0 }).recovered, 0);
  assert.equal(projectRecoverStale({ ok: true, recovered: 3 }).recovered, 3);
  assert.equal(projectRecoverStale({ ok: false, code: "AI_INTERNAL", message: "lỗi" }).code, "AI_INTERNAL");
  assert.equal(projectRecoverStale({ ok: false }).code, "AI_INTERNAL");

  const malformed = [undefined, null, {}, [], { ok: true }, { ok: true, recovered: undefined }, { ok: true, recovered: "3" }, { ok: true, recovered: -1 }, { ok: true, recovered: 1.5 }, { ok: "true", recovered: 0 }];
  for (const raw of malformed) {
    const result = projectRecoverStale(raw);
    assert.equal(result.ok, false, "malformed: " + JSON.stringify(raw));
    assert.equal(result.code, "AI_INTERNAL", "malformed: " + JSON.stringify(raw));
  }
});

test("R5-D2: integration — recoverStale malformed ⇒ worker fail-closed, không chạy job", async () => {
  const packet = packetFor();
  const variants = [undefined, {}, { ok: true }, { ok: true, recovered: "2" }];
  for (const recoverStaleRaw of variants) {
    const counter = { calls: 0 };
    const queue = createMemoryQueue({ hooks: { recoverStaleRaw } });
    await seedJob(queue, packet, 6);
    const { service } = makeService({ queue, packet, adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }) });
    const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
    assert.equal(run.ok, false, "recoverStale malformed: " + JSON.stringify(recoverStaleRaw));
    assert.equal(run.code, "AI_INTERNAL");
    assert.equal(counter.calls, 0, "0 provider call");
    assert.equal(queue.store.usage.size, 0, "0 usage");
    assert.equal(queue.store.revisions.size, 0, "0 revision");
  }
});

// ---------------------------------------------------------------------------
// E. Parity + không fallback trong source
// ---------------------------------------------------------------------------

test("R5-E: parity — memory queue mirror shape RPC SQL (claim/enqueue/complete/recoverStale)", async () => {
  const packet = packetFor();
  const queue = createMemoryQueue();
  await seedJob(queue, packet, 8);

  const claim = await queue.claim({ worker_ref: "w", lease_seconds: 120, now_ms: 0 });
  assert.equal(claim.ok, true, "claim success phải có ok:true tường minh");
  assert.equal(claim.attempt, claim.job.attempts, "attempt phải bằng job.attempts");
  const projected = projectClaim(claim);
  assert.equal(projected.ok, undefined, "claim hợp lệ đi qua projection");

  const recovered = projectRecoverStale(await queue.recoverStale({ lease_seconds: 0, now_ms: 0 }));
  assert.equal(recovered.ok, true);
  assert.ok(Number.isInteger(recovered.recovered) && recovered.recovered >= 0);

  const enqueueRaw = await queue.enqueueOrReuse({ identity_hash: "b".repeat(16) + "x", identity_components: {}, request: {}, now_ms: 0 });
  assert.equal(projectEnqueue(enqueueRaw).ok, true);
});

test("R5-F: guard nguồn — không fallback cho các projection mới", () => {
  const projection = readFileSync(new URL("./rpc-projection.mjs", import.meta.url), "utf8");
  const repository = readFileSync(new URL("./server/repository.mjs", import.meta.url), "utf8");

  const runOneJob = readFileSync(new URL("./run-one-job.mjs", import.meta.url), "utf8");

  for (const forbidden of ["?? 0", "?? []", "?? null", "|| false", "|| true"]) {
    assert.ok(!projection.includes(forbidden), "projection không được fallback: " + forbidden);
  }
  assert.ok(!repository.includes("recovered ?? 0"), "repository không được fallback recovered=0");
  // Projection phải chạy tại CONSUMER (parity giữa Supabase thật và test double), không chỉ ở repository.
  assert.ok(runOneJob.includes("projectClaim("), "claim phải project ở consumer");
  assert.ok(runOneJob.includes("projectEnqueue("), "enqueue phải project ở consumer");
  assert.ok(runOneJob.includes("projectComplete("), "complete phải project ở consumer");
  assert.ok(!runOneJob.includes("enqueued.reused === true"), "không được ép reused bằng === true (fallback cũ)");
  assert.ok(!repository.includes("projectRecoverStale"), "projection recoverStale không thuộc repository (parity với test double)");
  assert.ok(projection.includes("export function projectRecoverStale"), "phải có projector recoverStale");
  assert.ok(projection.includes("export function projectClaim"), "phải có projector claim");
});
