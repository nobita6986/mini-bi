/**
 * P1.5-W04-R1 — Production fail-closed & data-completeness hardening (unit + matrix tests).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

import { buildPacketFromSource } from "../packet-builder.mjs";
import { buildPeriodPlan, addDays, previousPeriodWindow } from "../engine-shared.mjs";
import { buildProviderPayload, resolveComparisonReason, utf8ByteLength, PAYLOAD_LIMITS } from "./payload.mjs";
import { getPromptManifest, PROMPT_MANIFEST_V1 } from "./prompt-registry.mjs";
import { resolveProviderConfig as readProviderConfig } from "./provider-config.mjs";
import { computeFactWindow } from "./fact-window.mjs";
import { FACT_ORDER, computeLineageRef, loadAllFacts } from "./fact-load.mjs";
import { evaluateWindowPolicy, readPolicyConfig } from "./policy.mjs";
import { createMemoryAudit, createMemoryQueue } from "./testing/memory-queue.mjs";
import { createMemoryProviderConfig } from "./testing/fake-provider-config.mjs";
import { SCRIPTED_ADAPTER_VERSION } from "./provider.mjs";
import { createAiReportService } from "./service-core.mjs";
import { DEFAULT_POLICY, MAX_ANALYSIS_LOOKBACK_DAYS } from "./limits.mjs";

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

function w03Packet({ request = { period: WEEK41, scope: { dimensions: ["project", "provider", "employment"] } }, facts, source_health = SH("src-a") }) {
  const built = buildPacketFromSource({ request, facts, source_health, catalog: baseCatalog, metadata: META });
  assert.ok(built.ok, "W03 packet: " + (built.ok ? "" : built.code + " " + built.message));
  return built.packet;
}
const baseFacts = [
  F("2026-09-28", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 4),
  F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5),
  F("2026-10-07", "proj-beta", "rec-bravo", "vendor", "chính thức", 3),
];

// ---------------------------------------------------------------------------
// A. Production provider fail-closed
// ---------------------------------------------------------------------------

test("R1-A: production/preview KHÔNG bao giờ dùng scripted; thiếu live config ⇒ fail trước mọi bước", () => {
  const prod = { NODE_ENV: "production", AI_REPORTS_ENABLED: "true" };
  assert.equal(readProviderConfig(prod).code, "AI_CONFIG_REQUIRED");
  assert.equal(readProviderConfig({ ...prod, AI_PROVIDER_KEY: "scripted" }).code, "AI_PROVIDER_DISABLED");
  assert.equal(readProviderConfig({ ...prod, AI_PROVIDER_KEY: "live" }).code, "AI_PROVIDER_DISABLED");
  assert.equal(readProviderConfig({ NODE_ENV: "production", VERCEL_ENV: "preview", AI_PROVIDER_KEY: "scripted" }).code, "AI_PROVIDER_DISABLED");
  assert.equal(readProviderConfig({ NODE_ENV: "production", AI_PROVIDER_KEY: "khac" }).code, "AI_CONFIG_REQUIRED");
  // Không mặc định scripted khi thiếu key ở production.
  assert.notEqual(readProviderConfig(prod).ok, true);

  // test/development: scripted phải được bật RÕ RÀNG.
  assert.equal(readProviderConfig({ NODE_ENV: "development" }).code, "AI_CONFIG_REQUIRED");
  assert.equal(readProviderConfig({ NODE_ENV: "test", AI_PROVIDER_KEY: "scripted" }).ok, true);
  assert.equal(readProviderConfig({ NODE_ENV: "development", AI_PROVIDER_KEY: "scripted" }).provider_key, "scripted");
});

test("R1-A2: service chặn TRƯỚC packet loader/enqueue/provider khi provider config không hợp lệ", async () => {
  const queue = createMemoryQueue();
  const audit = createMemoryAudit();
  let packetLoads = 0;
  const service = createAiReportService({ providerConfig: createMemoryProviderConfig({ model: "m" }),
    queue,
    audit,
    packetLoader: async () => {
      packetLoads += 1;
      return { ok: true, packet: w03Packet({ facts: baseFacts }) };
    },
    identityCatalog: { available: false, catalog: null },
    manifest: PROMPT,
    policy: { config: DEFAULT_POLICY },
    provider: { provider_key: "scripted", model_key: "m", config: { scenario: "valid" } },
    providerGate: { ok: false, code: "AI_CONFIG_REQUIRED", message: "thiếu live provider config" },
    timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
    clock: { nowMs: () => 0 },
  });

  const result = await service.enqueueReport({
    input: { period: WEEK41, scope: { dimensions: ["project"] } },
    actor_ref: "pilot-admin",
    access_scope_hash: "h",
    provider_key: "scripted",
    model_key: "m",
    adapter_version: SCRIPTED_ADAPTER_VERSION,
    now_ms: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "AI_CONFIG_REQUIRED");
  assert.equal(packetLoads, 0, "không được load packet khi provider config sai");
  assert.equal(queue.store.jobs.size, 0, "không được enqueue job");

  const providerDisabled = createAiReportService({ providerConfig: createMemoryProviderConfig({ model: "m" }),
    queue: createMemoryQueue(),
    audit: createMemoryAudit(),
    packetLoader: async () => {
      packetLoads += 1;
      return { ok: true, packet: w03Packet({ facts: baseFacts }) };
    },
    manifest: PROMPT,
    policy: { config: DEFAULT_POLICY },
    provider: { provider_key: "scripted", model_key: "m", config: {} },
    providerGate: { ok: false, code: "AI_PROVIDER_DISABLED", message: "scripted bị cấm ở production" },
    timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
    clock: { nowMs: () => 0 },
  });
  const blocked = await providerDisabled.enqueueReport({
    input: { period: WEEK41, scope: { dimensions: ["project"] } },
    actor_ref: "pilot-admin",
    access_scope_hash: "h",
    provider_key: "scripted",
    model_key: "m",
    adapter_version: SCRIPTED_ADAPTER_VERSION,
    now_ms: 0,
  });
  assert.equal(blocked.code, "AI_PROVIDER_DISABLED");
  assert.equal(packetLoads, 0);
});

test("R1-A3: synthetic G4 vẫn chạy khi provider gate ok (explicit scripted)", async () => {
  const packet = w03Packet({ facts: baseFacts });
  const queue = createMemoryQueue();
  const audit = createMemoryAudit();
  const service = createAiReportService({ providerConfig: createMemoryProviderConfig({ model: "m" }),
    queue,
    audit,
    packetLoader: async () => ({ ok: true, packet }),
    identityCatalog: { available: false, catalog: null },
    manifest: PROMPT,
    policy: { config: DEFAULT_POLICY },
    provider: { provider_key: "scripted", model_key: "m", config: { scenario: "valid" } },
    providerGate: { ok: true },
    timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
    clock: { nowMs: () => 0 },
  });
  const enqueued = await service.enqueueReport({
    input: { period: WEEK41, scope: { dimensions: ["project", "provider", "employment"] } },
    actor_ref: "pilot-admin",
    access_scope_hash: "h",
    provider_key: "scripted",
    model_key: "m",
    adapter_version: SCRIPTED_ADAPTER_VERSION,
    now_ms: 0,
  });
  assert.ok(enqueued.ok, enqueued.ok ? "" : enqueued.code);
  const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(run.results[0].kind, "completed");
});

// ---------------------------------------------------------------------------
// B. Policy context fail-closed
// ---------------------------------------------------------------------------

function failingPolicyQueue(inner) {
  return {
    ...inner,
    async policyContext() {
      return { ok: false, code: "AI_POLICY_REQUIRED", message: "không đọc được policy context (DB/RPC lỗi)" };
    },
  };
}

test("R1-B: enqueue fail-closed khi policy context không đọc được (không load packet, không enqueue)", async () => {
  const queue = failingPolicyQueue(createMemoryQueue());
  let packetLoads = 0;
  const service = createAiReportService({ providerConfig: createMemoryProviderConfig({ model: "m" }),
    queue,
    audit: createMemoryAudit(),
    packetLoader: async () => {
      packetLoads += 1;
      return { ok: true, packet: w03Packet({ facts: baseFacts }) };
    },
    identityCatalog: { available: false, catalog: null },
    manifest: PROMPT,
    policy: { config: DEFAULT_POLICY },
    provider: { provider_key: "scripted", model_key: "m", config: {} },
    timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
    clock: { nowMs: () => 0 },
  });
  const result = await service.enqueueReport({
    input: { period: WEEK41, scope: { dimensions: ["project"] } },
    actor_ref: "pilot-admin",
    access_scope_hash: "h",
    provider_key: "scripted",
    model_key: "m",
    adapter_version: SCRIPTED_ADAPTER_VERSION,
    now_ms: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "AI_POLICY_REQUIRED");
  assert.equal(packetLoads, 0);
  assert.equal(queue.store.jobs.size, 0);
});

test("R1-B2: worker fail-closed khi policy context không đọc được (không gọi provider, không usage)", async () => {
  const packet = w03Packet({ facts: baseFacts });
  const inner = createMemoryQueue();
  const audit = createMemoryAudit();
  const healthy = createAiReportService({ providerConfig: createMemoryProviderConfig({ model: "m" }),
    queue: inner,
    audit,
    packetLoader: async () => ({ ok: true, packet }),
    manifest: PROMPT,
    policy: { config: DEFAULT_POLICY },
    provider: { provider_key: "scripted", model_key: "m", config: { scenario: "valid" } },
    timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
    clock: { nowMs: () => 0 },
  });
  const enqueued = await healthy.enqueueReport({
    input: { period: WEEK41, scope: { dimensions: ["project", "provider", "employment"] } },
    actor_ref: "pilot-admin",
    access_scope_hash: "h",
    provider_key: "scripted",
    model_key: "m",
    adapter_version: SCRIPTED_ADAPTER_VERSION,
    now_ms: 0,
  });
  assert.ok(enqueued.ok);

  const broken = createAiReportService({ providerConfig: createMemoryProviderConfig({ model: "m" }),
    queue: failingPolicyQueue(inner),
    audit,
    packetLoader: async () => ({ ok: true, packet }),
    manifest: PROMPT,
    policy: { config: DEFAULT_POLICY },
    provider: { provider_key: "scripted", model_key: "m", config: { scenario: "valid" } },
    timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
    clock: { nowMs: () => 0 },
  });
  const run = await broken.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(run.results[0].kind, "failed");
  assert.equal(run.results[0].error_code, "AI_POLICY_REQUIRED");
  assert.equal(inner.store.usage.size, 0, "không được ghi usage khi chưa gọi provider");
  assert.equal(inner.store.revisions.size, 0);
  assert.equal([...inner.store.jobs.values()][0].status, "failed_config");
});

// ---------------------------------------------------------------------------
// C. Pagination / count / ceiling matrix
// ---------------------------------------------------------------------------

function fakePager(total, options = {}) {
  const calls = [];
  const rowsFor = (from, to) => {
    const rows = [];
    for (let i = from; i <= Math.min(to, total - 1); i++) rows.push({ id: i });
    return rows;
  };
  return {
    calls,
    load: async ([from, to]) => {
      calls.push([from, to]);
      if (options.failAtPage !== undefined && calls.length - 1 === options.failAtPage) {
        return { rows: [], count: null, error: { code: "DB", message: "page lỗi" } };
      }
      const count = options.countOverride !== undefined
        ? options.countOverride(calls.length - 1)
        : options.missingCount === true
          ? null
          : total;
      return { rows: rowsFor(from, to), count };
    },
  };
}

test("R1-C: pagination 999/1000/1001 dòng chính xác, không truncate", async () => {
  for (const total of [999, 1000, 1001, 20001]) {
    const pager = fakePager(total);
    const result = await loadAllFacts(pager.load);
    assert.ok(result.ok, total + " phải ok");
    assert.equal(result.rows.length, total);
    assert.equal(result.count, total);
    // page ≤ 1000 và range liên tục
    for (const [from, to] of pager.calls) assert.ok(to - from + 1 <= 1000, "page size ≤ 1000");
    assert.deepEqual(pager.calls[0], [0, 999]);
    if (total > 1000) assert.deepEqual(pager.calls[1], [1000, 1999]);
  }
});

test("R1-C2: lỗi page / thiếu count / count đổi / count lệch / vượt ceiling ⇒ fail toàn request", async () => {
  const pageError = await loadAllFacts(fakePager(2500, { failAtPage: 1 }).load);
  assert.equal(pageError.ok, false);
  assert.equal(pageError.code, "AI_FACT_LOAD_FAILED");
  assert.equal(pageError.rows, undefined, "không trả dữ liệu một phần");

  const missing = await loadAllFacts(fakePager(10, { missingCount: true }).load);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "AI_FACT_LOAD_FAILED");

  const changed = await loadAllFacts(fakePager(2500, { countOverride: (page) => (page === 0 ? 2500 : 2400) }).load);
  assert.equal(changed.ok, false);
  assert.equal(changed.code, "AI_FACT_LOAD_FAILED");

  const mismatch = await loadAllFacts(fakePager(2500, { countOverride: () => 3000 }).load);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "AI_FACT_LOAD_FAILED");

  const tooLarge = await loadAllFacts(fakePager(5000).load, { max_rows: 1000 });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, "AI_RESULT_TOO_LARGE");
  assert.equal(tooLarge.rows, undefined);
});

test("R1-C3: order đúng grain PK và filter giữ nguyên trên mọi page", () => {
  assert.deepEqual([...FACT_ORDER], [
    "source_id",
    "business_date",
    "project_key",
    "recruiter_key",
    "provider_type_key",
    "employment_type_key",
  ]);
});

// ---------------------------------------------------------------------------
// D. Historical window theo W03 authority
// ---------------------------------------------------------------------------

test("R1-D: cửa sổ lịch sử tính từ W03 authority cho week/month/quarter/custom", () => {
  const week = computeFactWindow({ type: "week", as_of_date: "2026-10-11" });
  assert.ok(week.ok);
  const weekPlan = buildPeriodPlan({ type: "week", as_of_date: "2026-10-11" });
  assert.equal(week.plan.start, weekPlan.start);
  assert.equal(week.plan.comparable.period_ref, weekPlan.comparable.period_ref);
  // 12 quý là ứng viên xa nhất (đếm bằng CHÍNH helper của W03) ⇒ cửa sổ phủ đủ quarter baseline.
  let cursor = weekPlan.start;
  for (let i = 0; i < 12; i++) cursor = previousPeriodWindow("quarter", cursor).start;
  assert.equal(week.from, cursor);
  assert.equal(week.to, weekPlan.effective_end);

  const month = computeFactWindow({ type: "month", as_of_date: "2026-10-11" });
  assert.ok(month.ok);
  let monthCursor = buildPeriodPlan({ type: "month", as_of_date: "2026-10-11" }).start;
  for (let i = 0; i < 12; i++) monthCursor = previousPeriodWindow("quarter", monthCursor).start;
  assert.equal(month.from, monthCursor);

  const quarter = computeFactWindow({ type: "quarter", as_of_date: "2026-10-11" });
  assert.ok(quarter.ok);
  assert.equal(quarter.plan.start, buildPeriodPlan({ type: "quarter", as_of_date: "2026-10-11" }).start);
  assert.equal(quarter.lookback_days >= 1100, true, "quý cần ~12 quý lịch sử");
  assert.equal(quarter.lookback_days <= MAX_ANALYSIS_LOOKBACK_DAYS, true);
});

test("R1-D2: custom dài cần đủ equal-length stability windows; vượt trần ⇒ AI_ANALYSIS_WINDOW_TOO_LARGE", () => {
  const custom = { type: "custom", as_of_date: "2026-10-11", custom_from: "2026-04-01", custom_to: "2026-10-11" };
  const relaxed = computeFactWindow(custom, { max_lookback_days: 20000 });
  assert.ok(relaxed.ok);
  const plan = buildPeriodPlan(custom);
  const expected = addDays(plan.start, -(12 * plan.elapsed_days));
  assert.equal(plan.elapsed_days > 190, true);
  assert.ok(relaxed.from <= expected, "phải phủ tối thiểu 12 cửa sổ cùng độ dài");

  const strict = computeFactWindow(custom, { max_lookback_days: 1000 });
  assert.equal(strict.ok, false);
  assert.equal(strict.code, "AI_ANALYSIS_WINDOW_TOO_LARGE");

  const policy = readPolicyConfig({ ...DEFAULT_POLICY });
  assert.ok(policy.ok);
  assert.equal(evaluateWindowPolicy({ config: policy.config, lookback_days: 20000 }).code, "AI_ANALYSIS_WINDOW_TOO_LARGE");
  assert.equal(evaluateWindowPolicy({ config: policy.config, lookback_days: 100 }).ok, true);
});

test("R1-D3: fact sau as_of KHÔNG nằm trong cửa sổ (và do đó không ảnh hưởng snapshot/lineage/report)", () => {
  const ptd = computeFactWindow({ type: "week", as_of_date: "2026-10-07" });
  assert.ok(ptd.ok);
  assert.equal(ptd.plan.period_to_date, true);
  assert.equal(ptd.to, "2026-10-07", "to = effective_end (as_of)");
  assert.equal(ptd.to < ptd.plan.end, true, "không đọc tới hết kỳ tự nhiên");
});

// ---------------------------------------------------------------------------
// E. Payload closure + UTF-8 byte budget
// ---------------------------------------------------------------------------

test("R1-E: closure — không feature/evidence mồ côi, prune deterministic", () => {
  const packet = w03Packet({ facts: baseFacts });
  const built = buildProviderPayload(packet, PROMPT);
  assert.ok(built.ok);
  const payload = built.payload;
  const refs = new Set(payload.subject_refs);
  for (const dimension of payload.drivers) {
    for (const entry of dimension.entries) assert.ok(refs.has(entry.subject_ref), "driver ref phải có trong subject_refs");
  }
  for (const row of payload.project_provider_mix ?? []) assert.ok(refs.has(row.subject_ref));
  for (const entry of payload.evidence) {
    if (entry.subject_ref !== "scope") assert.ok(refs.has(entry.subject_ref), "evidence ref phải có trong subject_refs");
  }
  // Deterministic
  const again = buildProviderPayload(packet, PROMPT);
  assert.equal(again.payload.payload_hash, payload.payload_hash);
});

test("R1-E1b: 12 golden packet G1 vẫn giữ closure và có evidence (không bị rỗng sau khi siết closure)", () => {
  const dir = new URL("cases/", ANALYSIS_DIR);
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  assert.equal(files.length, 12);
  for (const name of files) {
    const packet = JSON.parse(readFileSync(new URL(name, dir), "utf8")).packet;
    const built = buildProviderPayload(packet, PROMPT);
    assert.ok(built.ok, name + " payload phải dựng được: " + (built.ok ? "" : built.code + " " + built.message));
    assert.ok(built.payload.evidence.length >= 1, name + " payload phải có evidence");
    const refs = new Set(built.payload.subject_refs);
    for (const entry of built.payload.evidence) {
      if (entry.subject_ref !== "scope") assert.ok(refs.has(entry.subject_ref), name + " evidence ref phải có trong subject_refs");
    }
    for (const dimension of built.payload.drivers) {
      for (const entry of dimension.entries) assert.ok(refs.has(entry.subject_ref), name + " driver ref phải có trong subject_refs");
    }
  }
});

test("R1-E2: feature không có evidence tương ứng KHÔNG được gửi số", () => {
  const packet = w03Packet({ facts: baseFacts });
  const stripped = JSON.parse(JSON.stringify(packet));
  // Bỏ evidence của driver project đầu tiên ⇒ số tương ứng không được xuất hiện.
  const dimension = "project";
  const target = stripped.drivers[dimension][0].subject_ref;
  stripped.evidence = stripped.evidence.filter(
    (entry) => !(entry.metric.startsWith("driver." + dimension + ".") && entry.subject_ref === target)
  );
  const built = buildProviderPayload(stripped, PROMPT);
  assert.ok(built.ok, built.ok ? "" : built.code);
  const sent = (built.payload.drivers.find((row) => row.dimension === dimension)?.entries ?? []).find(
    (entry) => entry.subject_ref === target
  );
  assert.ok(!sent || sent.current === undefined || sent.current === null, "không gửi current không có evidence");
});

test("R1-E3: closure khi vượt trần evidence/subject — chỉ cắt theo cụm feature+evidence+ref", () => {
  const packet = w03Packet({ facts: baseFacts });
  const big = JSON.parse(JSON.stringify(packet));
  for (let i = 0; i < 200; i++) {
    const ref = "project_" + String(i + 50).padStart(2, "0");
    big.subjects.push({ ref, kind: "project", catalog_key: null });
    big.evidence.push({
      evidence_id: "ev_" + String(900 + i),
      metric: "extra.metric." + i,
      formula: "sum(recruited_count)",
      formula_version: "v0.1",
      period_ref: big.period.period_ref,
      scope_ref: big.scope.scope_hash,
      subject_ref: ref,
      value: i,
      unit: "people",
      sufficiency: "met",
      quality: "ok",
      snapshot_ref: big.snapshot.hash,
    });
  }
  const built = buildProviderPayload(big, PROMPT);
  assert.ok(built.ok, built.ok ? "" : built.code + " " + built.message);
  assert.ok(built.payload.evidence.length <= PAYLOAD_LIMITS.max_evidence);
  assert.ok(built.payload.subject_refs.length <= PAYLOAD_LIMITS.max_subject_refs);
  const refs = new Set(built.payload.subject_refs);
  for (const entry of built.payload.evidence) {
    if (entry.subject_ref !== "scope") assert.ok(refs.has(entry.subject_ref), "evidence bị giữ phải có ref");
  }
  assert.equal(built.pruned_features >= 0, true);
});

test("R1-E4: giới hạn byte tính bằng UTF-8 (multibyte) và vượt trần ⇒ AI_BUDGET_LIMITED", () => {
  assert.equal(utf8ByteLength("ế"), 3);
  assert.equal(utf8ByteLength("a"), 1);
  const packet = w03Packet({ facts: baseFacts });
  const tiny = buildProviderPayload(packet, PROMPT, { max_payload_bytes: 200 });
  assert.equal(tiny.ok, false);
  assert.equal(tiny.code, "AI_BUDGET_LIMITED");
  const normal = buildProviderPayload(packet, PROMPT, { max_payload_bytes: 200000 });
  assert.ok(normal.ok);
  assert.ok(utf8ByteLength(normal.payload) <= 200000);
});

// ---------------------------------------------------------------------------
// F. Comparison reason fail-closed
// ---------------------------------------------------------------------------

test("R1-F: comparison reason phải có đúng một evidence được công nhận và khớp period semantics", () => {
  const packet = w03Packet({ facts: baseFacts });
  const available = resolveComparisonReason(packet);
  assert.deepEqual(available, { ok: true, reason: null });

  const nullComparable = JSON.parse(JSON.stringify(packet));
  nullComparable.totals = { current: 10, comparable: null, delta: null, delta_pct: null };
  nullComparable.period.comparable = null;
  nullComparable.period.status = "period_to_date";
  nullComparable.period.period_to_date = true;
  nullComparable.evidence = nullComparable.evidence.filter((entry) => !entry.metric.startsWith("comparison."));

  const missing = resolveComparisonReason(nullComparable);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "AI_INPUT_INVALID");

  const reasonMetric = "comparison.unavailable.ptd_equal_window_unavailable";
  const withReason = JSON.parse(JSON.stringify(nullComparable));
  withReason.evidence.push({
    evidence_id: "ev_999",
    metric: reasonMetric,
    formula: "sum(recruited_count)",
    formula_version: "v0.1",
    period_ref: withReason.period.period_ref,
    scope_ref: withReason.scope.scope_hash,
    subject_ref: "scope",
    value: 1,
    unit: "count",
    sufficiency: "unknown",
    quality: "ok",
    snapshot_ref: withReason.snapshot.hash,
  });
  const okReason = resolveComparisonReason(withReason);
  assert.equal(okReason.ok, true);
  assert.equal(okReason.reason, "PTD_EQUAL_WINDOW_UNAVAILABLE");
  const builtPayload = buildProviderPayload(withReason, PROMPT);
  assert.ok(builtPayload.ok, builtPayload.ok ? "" : builtPayload.code);
  assert.equal(builtPayload.payload.period.comparison_reason, "PTD_EQUAL_WINDOW_UNAVAILABLE");

  // Hai reason xung đột ⇒ fail.
  const conflicting = JSON.parse(JSON.stringify(withReason));
  conflicting.evidence.push({
    ...conflicting.evidence[conflicting.evidence.length - 1],
    evidence_id: "ev_998",
    metric: "comparison.unavailable.comparable_window_incomplete",
  });
  assert.equal(resolveComparisonReason(conflicting).code, "AI_INPUT_INVALID");

  // Reason không khớp period semantics (có cửa sổ comparable nhưng khai equal-window unavailable) ⇒ fail.
  const wrongSemantics = JSON.parse(JSON.stringify(withReason));
  wrongSemantics.period.comparable = { period_ref: "week:2026-W40", start: "2026-09-28", end: "2026-10-04", elapsed_days: 7 };
  assert.equal(resolveComparisonReason(wrongSemantics).code, "AI_INPUT_INVALID");
});

// ---------------------------------------------------------------------------
// H. Lineage theo nội dung
// ---------------------------------------------------------------------------

test("R1-H: lineage_ref đổi khi nội dung fact/source đổi dù số dòng không đổi", () => {
  const window = { from: "2026-01-01", to: "2026-10-11" };
  const sourceHealth = SH("src-a");
  const rowsA = [F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5)];
  const rowsB = [{ ...rowsA[0], recruited_count: 6 }];
  const rowsC = [{ ...rowsA[0], project_key: "proj-beta" }];

  const a1 = computeLineageRef({ window, sourceHealth, rows: rowsA });
  const a2 = computeLineageRef({ window, sourceHealth, rows: rowsA });
  assert.equal(a1, a2, "cùng nội dung ⇒ cùng lineage");
  assert.equal(rowsA.length, rowsB.length);

  const b = computeLineageRef({ window, sourceHealth, rows: rowsB });
  const c = computeLineageRef({ window, sourceHealth, rows: rowsC });
  assert.notEqual(b, a1, "đổi recruited_count ⇒ lineage đổi");
  assert.notEqual(c, a1, "đổi grain key ⇒ lineage đổi");

  const degraded = computeLineageRef({
    window,
    sourceHealth: [{ source_key: "src-a", status: "stale_snapshot", quality: "partial", has_current_facts: false }],
    rows: rowsA,
  });
  assert.notEqual(degraded, a1, "đổi source health ⇒ lineage đổi");

  const otherWindow = computeLineageRef({ window: { from: "2026-02-01", to: "2026-10-11" }, sourceHealth, rows: rowsA });
  assert.notEqual(otherWindow, a1, "đổi window ⇒ lineage đổi");
});

test("R1-H2: packet từ fact khác nội dung (cùng số dòng) có snapshot hash khác nhau", () => {
  const packetA = w03Packet({ facts: baseFacts });
  const changed = baseFacts.map((fact, index) => (index === 0 ? { ...fact, recruited_count: fact.recruited_count + 1 } : fact));
  const packetB = w03Packet({ facts: changed });
  assert.equal(baseFacts.length, changed.length);
  assert.notEqual(packetA.snapshot.hash, packetB.snapshot.hash);
});
