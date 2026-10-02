/**
 * P1.5-W04-R2 — Semantic retention + frozen job + worker fencing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

import { buildPacketFromSource } from "../packet-builder.mjs";
import { buildProviderPayload, classifyEvidenceVocabulary, utf8ByteLength, PAYLOAD_LIMITS, LEGACY_METRIC_KEYS } from "./payload.mjs";
import { getPromptManifest, PROMPT_MANIFEST_V1 } from "./prompt-registry.mjs";
import { createScriptedAdapter } from "./provider.mjs";
import { createMemoryAudit, createMemoryQueue } from "./testing/memory-queue.mjs";
import { createAiReportService } from "./service-core.mjs";
import { DEFAULT_POLICY } from "./limits.mjs";

const PROMPT = getPromptManifest(PROMPT_MANIFEST_V1.prompt_version);
const ANALYSIS_DIR = new URL("../../../../docs/contracts/fixtures/p1.5-analysis/", import.meta.url);
const IDENT_DIR = new URL("../../../../docs/contracts/fixtures/p1.5-identity/", import.meta.url);
const readJson = (base, rel) => JSON.parse(readFileSync(new URL(rel, base), "utf8"));
const baseCatalog = readJson(IDENT_DIR, "catalog.json");

const META = {
  generated_at: "2026-10-12T00:00:00Z",
  generated_from: "reporting-read-model",
  lineage_ref: "1".repeat(64),
  access_scope_hash: "2".repeat(64),
};
const F = (date, project, recruiter, provider, employment, count, sourceKey = "src-a") => ({
  business_date: date,
  project_key: project,
  recruiter_key: recruiter,
  provider_type_key: provider,
  employment_type_key: employment,
  recruited_count: count,
  source_key: sourceKey,
});
const SH = (...keys) => keys.map((key) => ({ source_key: key, status: "covered", quality: "ok", has_current_facts: true }));
const WEEK41 = { type: "week", as_of_date: "2026-10-11" };
const DIMS = { dimensions: ["project", "provider", "employment"] };

const richFacts = [
  F("2026-09-28", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 4),
  F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5),
  F("2026-10-07", "proj-beta", "rec-bravo", "vendor", "chính thức", 3),
  F("2026-10-07", "proj-gamma", "rec-charlie", "hrp", "chính thức", 2),
];

function w03Packet({ request = { period: WEEK41, scope: DIMS }, facts = richFacts, source_health = SH("src-a"), catalog = baseCatalog } = {}) {
  const built = buildPacketFromSource({ request, facts, source_health, catalog, metadata: META });
  assert.ok(built.ok, "W03 packet: " + (built.ok ? "" : built.code + " " + built.message));
  return built.packet;
}

function makeService({ queue, packet, scenario = "valid", policy = DEFAULT_POLICY, adapterFactory, provider = { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario } }, clockMs = 0 }) {
  let nowMs = clockMs;
  const clock = { nowMs: () => nowMs, advance: (ms) => { nowMs += ms; } };
  const service = createAiReportService({
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

const enqueueArgs = (overrides = {}) => ({
  input: { period: WEEK41, scope: DIMS, ...(overrides.input ?? {}) },
  actor_ref: "pilot-admin",
  access_scope_hash: "h",
  provider_key: overrides.provider_key ?? "scripted",
  model_key: overrides.model_key ?? "scripted-deterministic-v1",
  adapter_version: overrides.adapter_version ?? "scripted-adapter/1.0",
  now_ms: overrides.now_ms ?? 0,
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

// ---------------------------------------------------------------------------
// A. Semantic retention
// ---------------------------------------------------------------------------

test("R2-A: payload giữ NGUYÊN semantics của packet W03 (drivers, mix, concentration 5 dimension)", () => {
  // Packet đủ 5 dimension (identity catalog fixture) ⇒ kiểm tra retention trên toàn bộ dimension.
  const packet = w03Packet({ request: { period: WEEK41 } });
  const built = buildProviderPayload(packet, PROMPT);
  assert.ok(built.ok, built.ok ? "" : built.code + " " + built.message);
  const payload = built.payload;

  // drivers: cùng subject và cùng giá trị với packet
  for (const dimension of ["project", "recruiter", "team", "provider", "employment"]) {
    const packetEntries = packet.drivers[dimension] ?? [];
    const sent = payload.drivers.find((row) => row.dimension === dimension);
    assert.ok(sent, dimension + " phải có driver trong payload");
    assert.equal(sent.entries.length, packetEntries.length, dimension + " số subject");
    for (const packetEntry of packetEntries) {
      const entry = sent.entries.find((row) => row.subject_ref === packetEntry.subject_ref);
      assert.ok(entry, dimension + " giữ subject " + packetEntry.subject_ref);
      assert.equal(entry.current, packetEntry.current);
      assert.equal(entry.comparable, packetEntry.comparable);
      assert.equal(entry.delta, packetEntry.delta);
      assert.equal(entry.delta_contribution_share, packetEntry.delta_contribution_share);
      assert.equal(entry.share_of_current, packetEntry.share_of_current);
    }
  }

  // mix: giữ khi provider filter KHÔNG active, và khớp packet
  assert.equal(payload.provider_composition_allowed, true);
  assert.equal(payload.project_provider_mix.length, packet.project_provider_mix.length);
  for (const row of packet.project_provider_mix) {
    const sent = payload.project_provider_mix.find((entry) => entry.subject_ref === row.subject_ref);
    assert.ok(sent, "mix giữ subject " + row.subject_ref);
    assert.equal(sent.project_total, row.project_total);
    assert.equal(sent.hrp_count, row.hrp_count);
    assert.equal(sent.vendor_count, row.vendor_count);
    assert.equal(sent.hrp_share, row.hrp_share);
    assert.equal(sent.vendor_share, row.vendor_share);
  }

  // concentration: top1_ref/top1_share/top3_share của 5 dimension khớp packet
  for (const dimension of ["project", "recruiter", "team", "provider", "employment"]) {
    const expected = packet.concentration[dimension];
    const sent = payload.concentration[dimension];
    assert.equal(sent.top1_ref, expected.top1_ref, dimension + " top1_ref");
    assert.equal(sent.top1_share, expected.top1_share, dimension + " top1_share");
    assert.equal(sent.top3_share, expected.top3_share, dimension + " top3_share");
    assert.equal(sent.distinct_subjects, expected.distinct_subjects, dimension + " distinct_subjects");
    if (sent.top1_ref !== null) {
      assert.ok(payload.subject_refs.includes(sent.top1_ref), dimension + " top1_ref phải nằm trong subject_refs");
    }
  }
});

test("R2-A2: provider filter active ⇒ mix bị loại nhưng concentration/driver vẫn còn", () => {
  const facts = [
    F("2026-09-28", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 2),
    F("2026-10-06", "proj-beta", "rec-bravo", "vendor", "chính thức", 3),
  ];
  const packet = w03Packet({ request: { period: WEEK41, scope: { dimensions: ["project", "provider"], filters: { provider_type_keys: ["vendor"] } } }, facts });
  const built = buildProviderPayload(packet, PROMPT);
  assert.ok(built.ok, built.ok ? "" : built.code);
  assert.equal(built.payload.filter_context.provider_active, 1);
  assert.equal(built.payload.project_provider_mix, null);
  assert.equal(built.payload.provider_composition_allowed, false);
  assert.ok(built.payload.drivers.length > 0, "driver vẫn được giữ");
  assert.equal(built.payload.concentration.provider.top1_ref !== undefined, true);
  // Dimension NGOÀI scope: subject không nằm trong feature set ⇒ top1_ref/top1_share null (đúng quy tắc R2),
  // nhưng top3_share (scope-level, có evidence) vẫn được giữ như packet.
  assert.equal(built.payload.concentration.recruiter.top1_ref, null);
  assert.equal(built.payload.concentration.recruiter.top1_share, null);
  assert.equal(built.payload.concentration.recruiter.top3_share, packet.concentration.recruiter.top3_share);
});

test("R2-A3: prune loại NGUYÊN cụm feature+evidence+ref, không làm sai feature còn lại", () => {
  const packet = w03Packet();
  const full = buildProviderPayload(packet, PROMPT, { max_payload_bytes: 10_000_000 });
  assert.ok(full.ok);
  const tight = buildProviderPayload(packet, PROMPT, { max_payload_bytes: Math.floor(utf8ByteLength(full.payload) * 0.75) });
  assert.ok(tight.ok, tight.ok ? "" : tight.code + " " + tight.message);
  assert.ok(tight.pruned_features > 0, "phải prune ít nhất một feature");
  assert.ok(utf8ByteLength(tight.payload) < utf8ByteLength(full.payload));

  const refs = new Set(tight.payload.subject_refs);
  const keptDriverSubjects = new Set();
  for (const dimension of tight.payload.drivers) for (const entry of dimension.entries) keptDriverSubjects.add(entry.subject_ref);

  const prunedSubjects = [];
  for (const dimension of full.payload.drivers) {
    for (const entry of dimension.entries) if (!keptDriverSubjects.has(entry.subject_ref)) prunedSubjects.push(entry.subject_ref);
  }
  const mixDropped = (tight.payload.project_provider_mix ?? []).length < (full.payload.project_provider_mix ?? []).length;
  assert.ok(prunedSubjects.length > 0 || mixDropped, "phải có feature bị prune (driver hoặc mix)");
  for (const ref of prunedSubjects) {
    assert.ok(!refs.has(ref), "subject bị prune không được còn trong subject_refs: " + ref);
    for (const entry of tight.payload.evidence) {
      assert.notEqual(entry.subject_ref, ref, "evidence của subject bị prune không được còn lại: " + ref);
    }
    assert.ok(!(tight.payload.project_provider_mix ?? []).some((row) => row.subject_ref === ref));
    for (const dimension of ["project", "recruiter", "team", "provider", "employment"]) {
      assert.notEqual(tight.payload.concentration[dimension].top1_ref, ref, "top1_ref không được trỏ subject bị prune");
    }
  }
  if (mixDropped) {
    // Mix bị prune ⇒ không còn row lẫn evidence mix rơi rớt, và subject của row bị bỏ không còn trong refs.
    const droppedRows = (full.payload.project_provider_mix ?? []).filter(
      (row) => !(tight.payload.project_provider_mix ?? []).some((kept) => kept.subject_ref === row.subject_ref)
    );
    for (const row of droppedRows) {
      assert.ok(
        !tight.payload.evidence.some((evidence) => evidence.metric.startsWith("project_mix.") && evidence.subject_ref === row.subject_ref),
        "evidence mix của row bị prune không được còn lại"
      );
      const keptElsewhere = tight.payload.drivers.some((dimension) => dimension.entries.some((entry) => entry.subject_ref === row.subject_ref));
      if (!keptElsewhere) assert.ok(!refs.has(row.subject_ref), "ref của row mix bị prune không được còn trong subject_refs");
    }
  }

  // Feature còn lại vẫn khớp packet (không bị "sai" do prune).
  for (const dimension of tight.payload.drivers) {
    for (const entry of dimension.entries) {
      const packetEntry = packet.drivers[dimension.dimension].find((row) => row.subject_ref === entry.subject_ref);
      assert.equal(entry.current, packetEntry.current, "feature còn lại phải giữ nguyên giá trị");
    }
  }
});

test("R2-A4: 12 golden fixture — vocabulary legacy được khai báo rõ, không bịa numeric feature", () => {
  const dir = new URL("cases/", ANALYSIS_DIR);
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  const legacyFixtures = [];
  for (const name of files) {
    const packet = JSON.parse(readFileSync(new URL(name, dir), "utf8")).packet;
    const vocabulary = classifyEvidenceVocabulary(packet);
    if (vocabulary.legacy.length > 0) legacyFixtures.push(name.replace(".json", ""));
    const built = buildProviderPayload(packet, PROMPT);
    assert.ok(built.ok, name + " payload phải dựng được: " + (built.ok ? "" : built.code));

    // Không khẳng định "feature được giữ" chỉ vì evidence > 0: mọi driver được gửi PHẢI có evidence khớp.
    for (const dimension of built.payload.drivers) {
      for (const entry of dimension.entries) {
        const metric = "driver." + dimension.dimension + ".current";
        const hasEvidence = built.payload.evidence.some(
          (evidence) => evidence.subject_ref === entry.subject_ref && (evidence.metric === metric || LEGACY_METRIC_KEYS.includes(evidence.metric))
        );
        assert.ok(hasEvidence, name + " driver " + entry.subject_ref + " phải có evidence backing");
      }
    }
    // Evidence legacy (nếu có) phải tới provider hoặc được mapping rõ ràng.
    for (const metric of vocabulary.legacy) {
      const packetHas = packet.evidence.some((entry) => entry.metric === metric);
      const payloadHas = built.payload.evidence.some((entry) => entry.metric === metric);
      const mapped = built.payload.evidence.some(
        (entry) => entry.metric.startsWith("project_mix.") || entry.metric.startsWith("driver.") || entry.metric === "recruited_total_comparable"
      );
      assert.ok(packetHas && (payloadHas || mapped), name + " legacy metric " + metric + " phải tới provider hoặc được mapping");
    }
  }
  // Ghi rõ fixture nào dùng vocabulary legacy (tài liệu hoá, không đoán).
  // Danh sách THỰC TẾ (đo bằng classifyEvidenceVocabulary, không đoán):
  // c01/c09/c10/c12 dùng project_total(+project_vendor_share); c01 còn team_delta/team_delta_share;
  // c02/c03/c05/c07/c08 dùng recruited_total_previous.
  assert.deepEqual(legacyFixtures.sort(), ["c01", "c02", "c03", "c05", "c07", "c08", "c09", "c10", "c11", "c12"]);
});

// ---------------------------------------------------------------------------
// B. UTF-8 byte ceiling trên payload CUỐI
// ---------------------------------------------------------------------------

test("R2-B: trần byte áp trên payload cuối (gồm payload_hash), đo bằng UTF-8", () => {
  assert.equal(utf8ByteLength("ế"), 3);
  assert.ok(utf8ByteLength("thời vụ") > "thời vụ".length);

  const packet = w03Packet();
  const exact = buildProviderPayload(packet, PROMPT, { max_payload_bytes: 10_000_000 });
  assert.ok(exact.ok);
  const size = utf8ByteLength(exact.payload);
  assert.equal(size, exact.payload_bytes);

  const atCeiling = buildProviderPayload(packet, PROMPT, { max_payload_bytes: size });
  assert.ok(atCeiling.ok, "đúng trần phải pass");

  const coreSize = utf8ByteLength(Object.fromEntries(Object.entries(exact.payload).filter(([key]) => key !== "payload_hash")));
  assert.ok(size > coreSize, "payload_hash phải nằm TRONG ngân sách byte đã đo");
  // Trần = kích thước core-only (chưa có hash): builder phải prune để payload CUỐI (gồm hash) vẫn ≤ trần.
  const atCore = buildProviderPayload(packet, PROMPT, { max_payload_bytes: coreSize });
  assert.ok(!atCore.ok || utf8ByteLength(atCore.payload) <= coreSize, "payload cuối không được vượt trần");
  // Trần không đủ cho cả core tối thiểu ⇒ fail rõ ràng, không cắt âm thầm.
  const impossible = buildProviderPayload(packet, PROMPT, { max_payload_bytes: 200 });
  assert.equal(impossible.ok, false);
  assert.equal(impossible.code, "AI_BUDGET_LIMITED");
});

test("R2-B2: đường generation dùng UTF-8 byte count của payload cuối (không dùng string.length)", async () => {
  const packet = w03Packet();
  const probe = buildProviderPayload(packet, PROMPT, { max_payload_bytes: 10_000_000 });
  assert.ok(probe.ok);
  const size = utf8ByteLength(probe.payload);
  assert.equal(probe.payload_bytes, size, "payload_bytes phải là UTF-8 byte count của payload CUỐI");
  const coreSize = utf8ByteLength(Object.fromEntries(Object.entries(probe.payload).filter(([key]) => key !== "payload_hash")));
  assert.ok(size > coreSize, "byte count phải bao gồm payload_hash");

  const counter = { calls: 0 };
  const queue = createMemoryQueue();
  const service = makeService({
    queue,
    packet,
    policy: { ...DEFAULT_POLICY, max_payload_bytes: 200 },
    adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }),
  });
  const enqueued = await service.service.enqueueReport(enqueueArgs());
  assert.ok(enqueued.ok);
  const run = await service.service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(run.results[0].error_code, "AI_BUDGET_LIMITED", "payload vượt trần byte phải bị chặn trong generation path");
  assert.equal(counter.calls, 0, "không gọi provider khi vượt trần byte");
  assert.equal(queue.store.usage.size, 0);
});

// ---------------------------------------------------------------------------
// C. Regenerate không lách policy
// ---------------------------------------------------------------------------

function regenerateQueue(inner, spy) {
  return {
    ...inner,
    async regenerate(args) {
      spy.regenerateCalls += 1;
      return inner.regenerate(args);
    },
  };
}

test("R2-C: regenerate chạy SAU policy — DB error/rate/budget đều không tạo job regenerate", async () => {
  const packet = w03Packet();

  // (1) policy context lỗi
  const brokenInner = createMemoryQueue();
  const brokenSpy = { regenerateCalls: 0 };
  const brokenQueue = regenerateQueue(
    { ...brokenInner, async policyContext() { return { ok: false, code: "AI_POLICY_REQUIRED", message: "DB lỗi" }; } },
    brokenSpy
  );
  const brokenService = makeService({ queue: brokenQueue, packet });
  const broken = await brokenService.service.enqueueReport(enqueueArgs({ input: { regenerate_of: "00000000-0000-4000-8000-000000000001", reason: "Dữ liệu cập nhật" } }));
  assert.equal(broken.ok, false);
  assert.equal(broken.code, "AI_POLICY_REQUIRED");
  assert.equal(brokenSpy.regenerateCalls, 0);
  assert.equal(brokenInner.store.jobs.size, 0);

  // (2) rate limited
  const rateInner = createMemoryQueue({ clock: { nowMs: () => 0 } });
  const rateSpy = { regenerateCalls: 0 };
  const rateService = makeService({
    queue: regenerateQueue(rateInner, rateSpy),
    packet,
    policy: { ...DEFAULT_POLICY, max_requests_per_window: 1 },
  });
  await rateInner.enqueueOrReuse({
    identity_hash: "a".repeat(16),
    identity_components: {},
    request: { actor_ref: "pilot-admin", max_attempts: 3, packet },
    now_ms: 0,
  });
  const rateBlocked = await rateService.service.enqueueReport(enqueueArgs({ input: { regenerate_of: "00000000-0000-4000-8000-000000000001", reason: "Dữ liệu cập nhật" } }));
  assert.equal(rateBlocked.ok, false);
  assert.equal(rateBlocked.code, "AI_RATE_LIMITED");
  assert.equal(rateSpy.regenerateCalls, 0);

  // (3) budget limited
  const budgetInner = createMemoryQueue();
  const budgetSpy = { regenerateCalls: 0 };
  budgetInner.store.usage.set("logical-1", { job_id: "x", input_tokens: 10, output_tokens: 10 });
  const budgetService = makeService({
    queue: regenerateQueue(budgetInner, budgetSpy),
    packet,
    policy: { ...DEFAULT_POLICY, daily_token_ceiling: 5 },
  });
  const budgetBlocked = await budgetService.service.enqueueReport(enqueueArgs({ input: { regenerate_of: "00000000-0000-4000-8000-000000000001", reason: "Dữ liệu cập nhật" } }));
  assert.equal(budgetBlocked.ok, false);
  assert.equal(budgetBlocked.code, "AI_BUDGET_LIMITED");
  assert.equal(budgetSpy.regenerateCalls, 0);

  // (4) hợp lệ ⇒ đúng một job regenerate, KHÔNG reload packet
  const queue = createMemoryQueue();
  const spy = { regenerateCalls: 0, packetLoads: 0 };
  let nowMs = 0;
  const service = createAiReportService({
    queue: regenerateQueue(queue, spy),
    audit: createMemoryAudit(),
    packetLoader: async () => {
      spy.packetLoads += 1;
      return { ok: true, packet };
    },
    identityCatalog: { available: false, catalog: null },
    manifest: PROMPT,
    policy: { config: DEFAULT_POLICY },
    provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "valid" } },
    providerGate: { ok: true },
    timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
    clock: { nowMs: () => nowMs },
  });
  const first = await service.enqueueReport(enqueueArgs());
  assert.ok(first.ok);
  await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  const regenerated = await service.enqueueReport(enqueueArgs({ input: { regenerate_of: first.job_id, reason: "Dữ liệu nguồn cập nhật" } }));
  assert.ok(regenerated.ok, regenerated.ok ? "" : regenerated.code);
  assert.equal(spy.regenerateCalls, 1);
  assert.equal(queue.store.jobs.size, 2);
  assert.equal(spy.packetLoads, 1, "regenerate KHÔNG reload packet (dùng frozen packet)");

  // (5) double-click regenerate khi đã có job regenerate đang hoạt động ⇒ không tạo thêm
  const again = await service.enqueueReport(enqueueArgs({ input: { regenerate_of: first.job_id, reason: "Dữ liệu nguồn cập nhật" } }));
  assert.equal(again.ok, false);
  assert.equal(queue.store.jobs.size, 2, "không tạo job regenerate thứ hai khi identity đang hoạt động");
});

// ---------------------------------------------------------------------------
// D. Frozen provider/model/adapter
// ---------------------------------------------------------------------------

test("R2-D: worker đối chiếu provider/model/adapter/prompt đã đóng băng trước khi gọi provider", async () => {
  const packet = w03Packet();
  const counter = { calls: 0 };

  // model khác job-pinned ⇒ 0 provider call
  const queueA = createMemoryQueue();
  const serviceA = makeService({
    queue: queueA,
    packet,
    adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }),
    provider: { provider_key: "scripted", model_key: "model-khac", config: { scenario: "valid" } },
  });
  const enqueuedA = await serviceA.service.enqueueReport(enqueueArgs());
  assert.ok(enqueuedA.ok);
  const runA = await serviceA.service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(runA.results[0].error_code, "AI_CONFIG_REQUIRED");
  assert.equal(counter.calls, 0, "không được gọi provider khi model lệch");
  assert.equal(queueA.store.usage.size, 0);
  assert.equal(queueA.store.revisions.size, 0);

  // adapter version khác ⇒ 0 provider call
  const queueB = createMemoryQueue();
  const serviceB = makeService({
    queue: queueB,
    packet,
    adapterFactory: () => ({
      ok: true,
      adapter: { provider_key: "scripted", adapter_version: "scripted-adapter/9.9", async generateStructured() { counter.calls += 1; throw new Error("không được gọi"); } },
    }),
  });
  const enqueuedB = await serviceB.service.enqueueReport(enqueueArgs());
  assert.ok(enqueuedB.ok);
  const runB = await serviceB.service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(runB.results[0].error_code, "AI_PROVIDER_DISABLED");
  assert.equal(counter.calls, 0, "không được gọi provider khi adapter version lệch");

  // prompt version khác ⇒ 0 provider call
  const queueC = createMemoryQueue();
  const serviceC = makeService({ queue: queueC, packet, adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }) });
  const enqueuedC = await serviceC.service.enqueueReport(enqueueArgs());
  assert.ok(enqueuedC.ok);
  queueC.store.jobs.get(enqueuedC.job_id).prompt_version = "business-analysis-prompt/9.9";
  const runC = await serviceC.service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(runC.results[0].error_code, "AI_CONFIG_REQUIRED");
  assert.equal(counter.calls, 0, "không được gọi provider khi prompt version lệch");

  // khớp hoàn toàn ⇒ chạy bình thường + usage ghi đúng provider/model của job
  const queueD = createMemoryQueue();
  const serviceD = makeService({ queue: queueD, packet, adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }) });
  const enqueuedD = await serviceD.service.enqueueReport(enqueueArgs());
  assert.ok(enqueuedD.ok);
  const runD = await serviceD.service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(runD.results[0].kind, "completed");
  assert.equal(counter.calls, 1);
  const usage = [...queueD.store.usage.values()][0];
  assert.equal(usage.provider_key, "scripted");
  assert.equal(usage.model_key, "scripted-deterministic-v1");
  assert.equal(usage.retry_count, 0);
});

// ---------------------------------------------------------------------------
// E/F. Claim / recover / markStage failure + fencing
// ---------------------------------------------------------------------------

test("R2-E: claim lỗi và recoverStale lỗi KHÔNG được giả thành idle", async () => {
  const packet = w03Packet();

  const idleQueue = createMemoryQueue();
  const idleService = makeService({ queue: idleQueue, packet });
  const idle = await idleService.service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(idle.ok, true);
  assert.equal(idle.results[0].kind, "idle");

  const claimErrorQueue = createMemoryQueue({ hooks: { claimError: true } });
  const claimErrorService = makeService({ queue: claimErrorQueue, packet });
  const claimError = await claimErrorService.service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(claimError.ok, false, "claim lỗi phải nổi lên thành worker error");
  assert.equal(claimError.code, "AI_INTERNAL");
  assert.equal(claimErrorQueue.store.usage.size, 0);

  const staleQueue = createMemoryQueue({ hooks: { recoverStaleError: true } });
  const staleService = makeService({ queue: staleQueue, packet });
  const stale = await staleService.service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "AI_INTERNAL");
  assert.equal(staleQueue.store.usage.size, 0);
});

test("R2-F: fencing tại markStage — mất lease hoặc lỗi DB thì KHÔNG gọi provider", async () => {
  const packet = w03Packet();

  const leaseLostCounter = { calls: 0 };
  const leaseQueue = createMemoryQueue({ hooks: { markStageLeaseLost: true } });
  const leaseService = makeService({
    queue: leaseQueue,
    packet,
    adapterFactory: () => ({ ok: true, adapter: countingAdapter(leaseLostCounter) }),
  });
  const enqueuedLease = await leaseService.service.enqueueReport(enqueueArgs());
  assert.ok(enqueuedLease.ok);
  const leaseRun = await leaseService.service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(leaseRun.results[0].kind, "lease_lost");
  assert.equal(leaseLostCounter.calls, 0, "mất lease ⇒ không gọi provider");
  assert.equal(leaseQueue.store.usage.size, 0, "mất lease ⇒ không ghi logical usage/cost");
  assert.equal(leaseQueue.store.revisions.size, 0);

  const dbErrorCounter = { calls: 0 };
  const dbQueue = createMemoryQueue({ hooks: { markStageError: true } });
  const dbService = makeService({
    queue: dbQueue,
    packet,
    adapterFactory: () => ({ ok: true, adapter: countingAdapter(dbErrorCounter) }),
  });
  const enqueuedDb = await dbService.service.enqueueReport(enqueueArgs());
  assert.ok(enqueuedDb.ok);
  const dbRun = await dbService.service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(dbRun.results[0].kind, "retry_scheduled", "lỗi DB ⇒ job quay lại queue để retry");
  assert.equal(dbErrorCounter.calls, 0, "lỗi DB ở markStage ⇒ không gọi provider");
  assert.equal(dbQueue.store.usage.size, 0);
});

// ---------------------------------------------------------------------------
// G. Policy dependency bắt buộc
// ---------------------------------------------------------------------------

test("R2-G: thiếu policyContext wiring ⇒ AI_POLICY_REQUIRED (không fail-open)", async () => {
  const packet = w03Packet();
  const inner = createMemoryQueue();
  const without = { ...inner };
  delete without.policyContext;
  let packetLoads = 0;
  const service = createAiReportService({
    queue: without,
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
  const enqueued = await service.enqueueReport(enqueueArgs());
  assert.equal(enqueued.ok, false);
  assert.equal(enqueued.code, "AI_POLICY_REQUIRED");
  assert.equal(packetLoads, 0);

  // Worker: cần một job trong queue (tạo trực tiếp, không qua enqueue) để quan sát fail-closed.
  const seeded = await inner.enqueueOrReuse({
    identity_hash: "b".repeat(16),
    identity_components: {},
    request: { actor_ref: "pilot-admin", max_attempts: 3, packet, provider_key: "scripted", model_key: "scripted-deterministic-v1", adapter_version: "scripted-adapter/1.0", prompt_version: PROMPT.prompt_version },
    now_ms: 0,
  });
  const worker = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(worker.results[0].error_code, "AI_POLICY_REQUIRED");
  assert.equal(inner.store.jobs.get(seeded.job_id).status, "failed_config");
  assert.equal(inner.store.usage.size, 0, "không gọi provider khi thiếu policy wiring");
});

test("R2-A5: golden fixture vocabulary legacy — danh sách khai báo khớp LEGACY_METRIC_KEYS", () => {
  assert.deepEqual([...LEGACY_METRIC_KEYS].sort(), [
    "project_total",
    "project_vendor_share",
    "recruited_total_previous",
    "team_delta",
    "team_delta_share",
  ]);
  assert.ok(PAYLOAD_LIMITS.max_evidence >= 1);
});
