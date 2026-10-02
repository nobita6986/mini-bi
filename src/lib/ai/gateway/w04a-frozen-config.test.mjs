/**
 * P1.5-W04A (6) — Tích hợp W04: đóng băng provider config vào job, claim trả 2 field,
 * worker đối chiếu đúng (config_id, version) trước provider call; thiếu/mismatch/decrypt lỗi ⇒ fail-closed.
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
import { projectClaim } from "./rpc-projection.mjs";

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

function makeService({ queue, packet, providerConfig, policy = DEFAULT_POLICY, adapterFactory }) {
  const service = createAiReportService({
    queue,
    audit: createMemoryAudit(),
    providerConfig,
    packetLoader: async () => ({ ok: true, packet }),
    identityCatalog: { available: false, catalog: null },
    manifest: PROMPT,
    policy: { config: policy },
    provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "valid" } },
    providerGate: { ok: true },
    adapterFactory,
    timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
    clock: { nowMs: () => 0 },
  });
  return { service };
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

test("W04A-F1: enqueue gate — chưa có config active+verified ⇒ AI_CONFIG_REQUIRED, không tạo job", async () => {
  const packet = packetFor();
  const queue = createMemoryQueue();
  const { service } = makeService({ queue, packet, providerConfig: createMemoryProviderConfig({ active: null }) });
  const result = await service.enqueueReport(enqueueArgs());
  assert.equal(result.ok, false);
  assert.equal(result.code, "AI_CONFIG_REQUIRED");
  assert.equal(queue.store.jobs.size, 0, "không được tạo job khi thiếu cấu hình");
});

test("W04A-F2: thiếu wiring providerConfig ⇒ fail-closed (cả enqueue và worker)", async () => {
  const packet = packetFor();
  const queue = createMemoryQueue();
  const service = createAiReportService({
    queue,
    audit: createMemoryAudit(),
    packetLoader: async () => ({ ok: true, packet }),
    identityCatalog: { available: false, catalog: null },
    manifest: PROMPT,
    policy: { config: DEFAULT_POLICY },
    provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "valid" } },
    providerGate: { ok: true },
    timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
    clock: { nowMs: () => 0 },
  });
  const result = await service.enqueueReport(enqueueArgs());
  assert.equal(result.ok, false);
  assert.equal(result.code, "AI_CONFIG_REQUIRED");
  assert.equal(queue.store.jobs.size, 0);
});

test("W04A-F3: job đóng băng (config_id, version); claim + projection trả đủ hai field", async () => {
  const packet = packetFor();
  const queue = createMemoryQueue();
  const providerConfig = createMemoryProviderConfig();
  const { service } = makeService({ queue, packet, providerConfig });

  const enqueued = await service.enqueueReport(enqueueArgs());
  assert.equal(enqueued.ok, true);
  const job = queue.store.jobs.get(enqueued.job_id);
  assert.equal(job.provider_config_id, "pilot-provider");
  assert.equal(job.provider_config_version, 1);

  const claim = await queue.claim({ worker_ref: "w", lease_seconds: 120, now_ms: 0 });
  assert.equal(claim.job.provider_config_id, "pilot-provider");
  assert.equal(claim.job.provider_config_version, 1);
  const projected = projectClaim(claim);
  assert.equal(projected.job.provider_config_id, "pilot-provider");
  assert.equal(projected.job.provider_config_version, 1);
});

test("W04A-F4: không giải mã được credential ⇒ fail-closed, provider call = 0, usage = 0, revision = 0", async () => {
  const packet = packetFor();
  const queue = createMemoryQueue();
  const counter = { calls: 0 };
  const providerConfig = createMemoryProviderConfig({ materialFailure: { code: "AI_DECRYPT_FAILED" } });
  const { service } = makeService({ queue, packet, providerConfig, adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }) });

  const enqueued = await service.enqueueReport(enqueueArgs());
  assert.equal(enqueued.ok, true);
  const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(run.ok, true);
  assert.notEqual(run.results[0].kind, "completed");
  assert.equal(run.results[0].error_code, "AI_DECRYPT_FAILED");
  assert.equal(counter.calls, 0, "0 provider call");
  assert.equal(queue.store.usage.size, 0, "0 usage");
  assert.equal(queue.store.revisions.size, 0, "0 revision");
});

test("W04A-F5: config bị tắt hoặc sai model/profile ⇒ fail-closed trước provider call", async () => {
  const packet = packetFor();

  const disabledQueue = createMemoryQueue();
  const disabledCounter = { calls: 0 };
  const disabledConfig = createMemoryProviderConfig();
  const disabledService = makeService({ queue: disabledQueue, packet, providerConfig: disabledConfig, adapterFactory: () => ({ ok: true, adapter: countingAdapter(disabledCounter) }) }).service;
  await disabledService.enqueueReport(enqueueArgs());
  disabledConfig.setVersion(1, { status: "disabled" });
  const disabledRun = await disabledService.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(disabledCounter.calls, 0);
  assert.equal(disabledRun.results[0].error_code, "AI_CONFIG_REQUIRED");
  assert.equal(disabledQueue.store.usage.size, 0);

  const mismatchQueue = createMemoryQueue();
  const mismatchCounter = { calls: 0 };
  const mismatchConfig = createMemoryProviderConfig();
  const mismatchService = makeService({ queue: mismatchQueue, packet, providerConfig: mismatchConfig, adapterFactory: () => ({ ok: true, adapter: countingAdapter(mismatchCounter) }) }).service;
  await mismatchService.enqueueReport(enqueueArgs());
  mismatchConfig.setVersion(1, { model: "model-khac" });
  const mismatchRun = await mismatchService.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(mismatchCounter.calls, 0);
  assert.equal(mismatchRun.results[0].error_code, "AI_CONFIG_REQUIRED");
  assert.equal(mismatchQueue.store.revisions.size, 0);
});

test("W04A-F6: rotate/activate version mới KHÔNG làm job cũ đổi config; retry giữ nguyên version", async () => {
  const packet = packetFor();
  const queue = createMemoryQueue();
  const counter = { calls: 0 };
  const providerConfig = createMemoryProviderConfig();
  const { service } = makeService({ queue, packet, providerConfig, adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }) });

  const first = await service.enqueueReport(enqueueArgs());
  assert.equal(first.ok, true);

  // Owner xoay key + kích hoạt version 2.
  providerConfig.setVersion(2, { model: "scripted-deterministic-v1" });
  providerConfig.setActiveVersion(2);

  const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(run.results[0].kind, "completed");
  const requested = providerConfig.calls.material.map((row) => row.version);
  assert.deepEqual(requested, [1], "job cũ CHỈ được đọc đúng version đã đóng băng (1)");
  assert.equal(queue.store.jobs.get(first.job_id).provider_config_version, 1, "version đóng băng không đổi");

  // Job MỚI (queue mới, không cache) sau khi activate ⇒ đóng băng version 2.
  const freshQueue = createMemoryQueue();
  const freshService = makeService({ queue: freshQueue, packet, providerConfig }).service;
  const second = await freshService.enqueueReport(enqueueArgs());
  assert.equal(second.ok, true);
  assert.equal(freshQueue.store.jobs.get(second.job_id).provider_config_version, 2);
  assert.equal(counter.calls >= 1, true);
});

test("W04A-F6b: retry không đổi provider config đã đóng băng (lỗi transient)", async () => {
  const packet = packetFor();
  const queue = createMemoryQueue();
  const providerConfig = createMemoryProviderConfig();
  const transient = createScriptedAdapter({ scenario: "transient_5xx" });
  const { service } = makeService({
    queue,
    packet,
    providerConfig,
    adapterFactory: () => ({ ok: true, adapter: transient }),
  });

  const enqueued = await service.enqueueReport(enqueueArgs());
  assert.equal(enqueued.ok, true);
  const before = queue.store.jobs.get(enqueued.job_id);
  const frozen = { id: before.provider_config_id, version: before.provider_config_version };

  const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(run.results[0].kind, "retry_scheduled");
  const after = queue.store.jobs.get(enqueued.job_id);
  assert.equal(after.provider_config_id, frozen.id, "retry không đổi config id");
  assert.equal(after.provider_config_version, frozen.version, "retry không đổi config version");
  assert.equal(providerConfig.calls.material.every((row) => row.version === frozen.version), true);
  assert.equal(queue.store.revisions.size, 0, "retry không tạo revision");
});

test("W04A-F7: job không có provider config đóng băng (legacy) ⇒ worker fail-closed, provider call = 0", async () => {
  const packet = packetFor();
  const queue = createMemoryQueue({ request_defaults: {} });
  const counter = { calls: 0 };
  const { service } = makeService({ queue, packet, providerConfig: createMemoryProviderConfig(), adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }) });

  await queue.enqueueOrReuse({
    identity_hash: "f".repeat(16) + "legacy",
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

  const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(run.results[0].error_code, "AI_CONFIG_REQUIRED");
  assert.equal(counter.calls, 0, "0 provider call");
  assert.equal(queue.store.usage.size, 0);
  assert.equal(queue.store.revisions.size, 0);
});

test("W04A-F8: projectClaim từ chối provider config không đầy đủ/không hợp lệ", () => {
  const base = {
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

  const ok = projectClaim({ ok: true, job: { ...base, provider_config_id: "pilot-provider", provider_config_version: 2 }, lease_token: lease, attempt: 1 });
  assert.equal(ok.job.provider_config_version, 2);

  const legacy = projectClaim({ ok: true, job: base, lease_token: lease, attempt: 1 });
  assert.equal(legacy.job.provider_config_id, null, "job cũ không có config vẫn project được (worker fail-closed)");

  const malformed = [
    { ...base, provider_config_id: "pilot-provider" },
    { ...base, provider_config_version: 1 },
    { ...base, provider_config_id: "", provider_config_version: 1 },
    { ...base, provider_config_id: "pilot-provider", provider_config_version: 0 },
    { ...base, provider_config_id: "pilot-provider", provider_config_version: "1" },
  ];
  for (const job of malformed) {
    const result = projectClaim({ ok: true, job, lease_token: lease, attempt: 1 });
    assert.equal(result.ok, false, "phải từ chối: " + JSON.stringify(job.provider_config_version));
    assert.equal(result.code, "AI_INTERNAL");
  }
});
