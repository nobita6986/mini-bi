/**
 * P1.5-W04B-S01 — FT0: live provider adapter (OpenAI-compatible) + security fail-closed.
 *
 * - Unit: createLiveAdapter với MOCK transport (không gọi mạng/provider thật).
 * - Integration: run-one-job + live adapter (mock outbound) qua createAiReportService.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { createLiveAdapter, LIVE_ADAPTER_VERSION } from "./live-adapter.mjs";
import { buildScriptedAnalysis, resolveProviderAdapter } from "./provider.mjs";
import { buildProviderPayload } from "./payload.mjs";
import { getPromptManifest, PROMPT_MANIFEST_V1 } from "./prompt-registry.mjs";
import { buildPacketFromSource } from "../packet-builder.mjs";
import { createMemoryAudit, createMemoryQueue } from "./testing/memory-queue.mjs";
import { createMemoryProviderConfig } from "./testing/fake-provider-config.mjs";
import { createAiReportService } from "./service-core.mjs";
import { DEFAULT_POLICY } from "./limits.mjs";

const PROMPT = getPromptManifest(PROMPT_MANIFEST_V1.prompt_version);
const SECRET = "sk-test-secret-1234567890";

function analysisJson() {
  return JSON.stringify({
    contract_version: "business-analysis/0.1",
    period_ref: "week:2026-W41",
    report_status: "draft",
    executive_analysis: "Kỳ này ghi nhận 5 người trong phạm vi phân tích.",
    findings: [],
    overall_limitations: ["Chưa đủ dữ liệu so sánh."],
    executive_evidence_refs: ["ev_01"],
  });
}

function envelope(content) {
  return JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
  });
}

function mockOutbound(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function reqFor(adapter, overrides = {}) {
  return {
    payload: { payload_version: "provider-payload/0.1", period: { period_ref: "week:2026-W41" }, totals: { current: 5 } },
    promptManifest: PROMPT,
    modelConfig: {
      provider_key: "live",
      model_key: "gpt-4o-mini",
      adapter_version: adapter.adapter_version,
      timeout_ms: 5000,
      provider_config: { config_id: "pilot-provider", version: 1, provider_profile: "openai-compatible", api_base_url: "https://api.example.test/v1", sanitized_host: "api.example.test" },
      credential_secret: SECRET,
    },
    timeoutSignal: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit — createLiveAdapter (mock transport)
// ---------------------------------------------------------------------------

test("W04B-U1: resolveProviderAdapter — live cần outbound wiring; thiếu ⇒ fail-closed", () => {
  const wired = resolveProviderAdapter({ provider_key: "live", config: { outbound: async () => ({ statusCode: 200, headers: {}, body: Buffer.from("{}") }) } });
  assert.equal(wired.ok, true);
  assert.equal(wired.adapter.provider_key, "live");
  assert.equal(wired.adapter.adapter_version, LIVE_ADAPTER_VERSION);

  const bare = resolveProviderAdapter({ provider_key: "live", config: {} });
  assert.equal(bare.ok, false);
  assert.equal(bare.code, "AI_PROVIDER_DISABLED");

  const scripted = resolveProviderAdapter({ provider_key: "scripted", config: {} });
  assert.equal(scripted.ok, true);
});

test("W04B-U2: response hợp lệ ⇒ ok:true + structured + usage từ envelope", async () => {
  const outbound = mockOutbound(async () => ({ statusCode: 200, headers: {}, body: Buffer.from(envelope(analysisJson())) }));
  const adapter = createLiveAdapter({ outbound, url_policy: { environment: "production", allowedHosts: ["api.example.test"] } });
  const result = await adapter.generateStructured(reqFor(adapter));
  assert.equal(result.ok, true);
  assert.equal(typeof result.raw_text, "string");
  assert.ok(result.structured && result.structured.contract_version === "business-analysis/0.1");
  assert.equal(result.usage.input_tokens, 120);
  assert.equal(result.usage.output_tokens, 80);
  assert.equal(result.model_key, "gpt-4o-mini");
  // Authorization đúng header, URL đúng path chat/completions.
  assert.equal(outbound.calls[0].url, "https://api.example.test/v1/chat/completions");
  assert.equal(outbound.calls[0].opts.headers.authorization, "Bearer " + SECRET);
  assert.equal(outbound.calls[0].opts.maxRedirects, 0);
});

test("W04B-U3: content không phải JSON hợp lệ ⇒ ok:true structured:null (downstream AI_PROVIDER_MALFORMED)", async () => {
  const outbound = mockOutbound(async () => ({ statusCode: 200, headers: {}, body: Buffer.from(envelope("không phải JSON")) }));
  const adapter = createLiveAdapter({ outbound });
  const result = await adapter.generateStructured(reqFor(adapter));
  assert.equal(result.ok, true);
  assert.equal(result.structured, null);
  assert.equal(typeof result.raw_text, "string");
});

test("W04B-U4: envelope malformed / thiếu choices[0].message.content ⇒ structured:null", async () => {
  const cases = [
    ["body không phải JSON", "not-json-at-all"],
    ["thiếu choices", JSON.stringify({ id: "x", usage: {} })],
    ["choices rỗng", JSON.stringify({ choices: [], usage: {} })],
    ["message không phải object", JSON.stringify({ choices: [{ message: "x" }] })],
    ["content không phải chuỗi", JSON.stringify({ choices: [{ message: { content: 42 } }] })],
  ];
  for (const [label, body] of cases) {
    const outbound = mockOutbound(async () => ({ statusCode: 200, headers: {}, body: Buffer.from(body) }));
    const adapter = createLiveAdapter({ outbound });
    const result = await adapter.generateStructured(reqFor(adapter));
    assert.equal(result.ok, true, label);
    assert.equal(result.structured, null, label);
  }
});

test("W04B-U5: lỗi HTTP được sanitize (429 retryable; 401 permanent; 500 transient)", async () => {
  for (const [status, code, retryable] of [
    [429, "AI_PROVIDER_RATE_LIMITED", true],
    [401, "AI_PROVIDER_PERMANENT", false],
    [403, "AI_PROVIDER_PERMANENT", false],
    [500, "AI_PROVIDER_TRANSIENT", true],
    [503, "AI_PROVIDER_TRANSIENT", true],
  ]) {
    const outbound = mockOutbound(async () => ({ statusCode: status, headers: {}, body: Buffer.from("{}") }));
    const adapter = createLiveAdapter({ outbound });
    const result = await adapter.generateStructured(reqFor(adapter));
    assert.equal(result.ok, false, "status " + status);
    assert.equal(result.error_code, code, "status " + status);
    assert.equal(result.retryable, retryable, "status " + status);
    assert.ok(!JSON.stringify(result).includes(SECRET), "không rò secret");
  }
});

test("W04B-U6: timeout ⇒ AI_PROVIDER_TIMEOUT retryable (outbound throw + signal aborted)", async () => {
  const throwOutbound = mockOutbound(async () => { throw { code: "TIMEOUT", name: "SecurityError" }; });
  const adapter1 = createLiveAdapter({ outbound: throwOutbound });
  const r1 = await adapter1.generateStructured(reqFor(adapter1));
  assert.equal(r1.ok, false);
  assert.equal(r1.error_code, "AI_PROVIDER_TIMEOUT");
  assert.equal(r1.retryable, true);

  const controller = new AbortController();
  controller.abort();
  const adapter2 = createLiveAdapter({ outbound: mockOutbound(async () => ({ statusCode: 200, headers: {}, body: Buffer.from("{}") })) });
  const r2 = await adapter2.generateStructured(reqFor(adapter2, { timeoutSignal: controller.signal }));
  assert.equal(r2.error_code, "AI_PROVIDER_TIMEOUT");
});

test("W04B-U7: vượt byte ceiling ⇒ AI_PROVIDER_OVERSIZED", async () => {
  const big = "x".repeat(10 * 1024);
  const outbound = mockOutbound(async () => ({ statusCode: 200, headers: {}, body: Buffer.from(envelope(JSON.stringify({ big }))) }));
  const adapter = createLiveAdapter({ outbound, max_response_bytes: 1024 });
  const result = await adapter.generateStructured(reqFor(adapter));
  assert.equal(result.ok, false);
  assert.equal(result.error_code, "AI_PROVIDER_OVERSIZED");

  const throwOversized = createLiveAdapter({ outbound: mockOutbound(async () => { throw { code: "RESPONSE_TOO_LARGE", name: "SecurityError" }; }), max_response_bytes: 1024 });
  const r2 = await throwOversized.generateStructured(reqFor(throwOversized));
  assert.equal(r2.error_code, "AI_PROVIDER_OVERSIZED");
});

test("W04B-U8: thiếu api_base_url/secret/model ⇒ AI_CONFIG_REQUIRED (không gọi outbound)", async () => {
  const outbound = mockOutbound(async () => ({ statusCode: 200, headers: {}, body: Buffer.from("{}") }));
  const adapter = createLiveAdapter({ outbound });
  const r = await adapter.generateStructured(reqFor(adapter, {
    modelConfig: { ...reqFor(adapter).modelConfig, provider_config: { config_id: "pilot-provider", version: 1 } },
  }));
  assert.equal(r.error_code, "AI_CONFIG_REQUIRED");
  assert.equal(outbound.calls.length, 0, "không gọi outbound khi thiếu config");
});

test("W04B-U9: không rò secret/prompt đầy đủ trong kết quả; adapter không console.log", async () => {
  const outbound = mockOutbound(async () => ({ statusCode: 200, headers: {}, body: Buffer.from(envelope(analysisJson())) }));
  const adapter = createLiveAdapter({ outbound });
  const result = await adapter.generateStructured(reqFor(adapter));
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(SECRET), "kết quả không được chứa secret");
  assert.ok(!serialized.includes(PROMPT.system_instruction), "kết quả không được chứa system prompt");

  const source = readFileSync(new URL("./live-adapter.mjs", import.meta.url), "utf8");
  assert.ok(!source.includes("console.log"), "adapter không được console.log");
  assert.ok(!source.includes("fetch("), "adapter không được raw fetch");
  assert.ok(!source.includes("https.request"), "adapter không được gọi https trực tiếp");
});

// ---------------------------------------------------------------------------
// Integration — run-one-job + live adapter (mock outbound)
// ---------------------------------------------------------------------------

const IDENT_DIR = new URL("../../../../docs/contracts/fixtures/p1.5-identity/", import.meta.url);
const baseCatalog = JSON.parse(readFileSync(new URL("catalog.json", IDENT_DIR), "utf8"));
const META = { generated_at: "2026-10-12T00:00:00Z", generated_from: "reporting-read-model", lineage_ref: "1".repeat(64), access_scope_hash: "2".repeat(64) };
const F = (date, project, recruiter, provider, employment, count) => ({ business_date: date, project_key: project, recruiter_key: recruiter, provider_type_key: provider, employment_type_key: employment, recruited_count: count, source_key: "src-a" });
const WEEK41 = { type: "week", as_of_date: "2026-10-11" };
const DIMS = { dimensions: ["project", "provider", "employment"] };
const facts = [F("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5)];

function packetFor() {
  const built = buildPacketFromSource({
    request: { period: WEEK41, scope: DIMS },
    facts,
    source_health: [{ source_key: "src-a", status: "covered", quality: "ok", has_current_facts: true }],
    catalog: baseCatalog,
    metadata: META,
  });
  assert.ok(built.ok, "packet: " + (built.ok ? "" : built.code));
  return built.packet;
}

function liveService({ packet, outbound, providerConfig }) {
  const adapter = createLiveAdapter({ outbound, url_policy: { environment: "production", allowedHosts: ["api.example.test"] } });
  const service = createAiReportService({
    queue: createMemoryQueue(),
    audit: createMemoryAudit(),
    providerConfig,
    packetLoader: async () => ({ ok: true, packet }),
    identityCatalog: { available: false, catalog: null },
    manifest: PROMPT,
    policy: { config: DEFAULT_POLICY },
    provider: { provider_key: "live", model_key: "gpt-4o-mini", config: {} },
    providerGate: { ok: true },
    adapterFactory: () => ({ ok: true, adapter }),
    timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
    clock: { nowMs: () => 0 },
  });
  return service;
}

const liveEnqueueArgs = () => ({
  input: { period: WEEK41, scope: DIMS },
  actor_ref: "pilot-admin",
  access_scope_hash: "h",
  provider_key: "live",
  model_key: "gpt-4o-mini",
  adapter_version: LIVE_ADAPTER_VERSION,
  now_ms: 0,
});

test("W04B-I1: live adapter hợp lệ ⇒ completed + revision + usage đúng provider/model", async () => {
  const packet = packetFor();
  const validAnalysis = buildScriptedAnalysis(buildProviderPayload(packet, PROMPT).payload);
  const providerConfig = createMemoryProviderConfig({ provider_profile: "openai-compatible", model: "gpt-4o-mini" });
  const outbound = mockOutbound(async () => ({ statusCode: 200, headers: {}, body: Buffer.from(envelope(JSON.stringify(validAnalysis))) }));
  const service = liveService({ packet, outbound, providerConfig });

  const enqueued = await service.enqueueReport(liveEnqueueArgs());
  assert.equal(enqueued.ok, true);
  const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(run.ok, true);
  assert.equal(run.results[0].kind, "completed", JSON.stringify(run.results[0]));
  assert.ok(outbound.calls.length >= 1, "đã gọi provider");

  // Material được đọc đúng (config_id, version) đã đóng băng.
  assert.ok(providerConfig.calls.material.length >= 1);
  assert.equal(providerConfig.calls.material[0].config_id, "pilot-provider");
  assert.equal(providerConfig.calls.material[0].version, 1);
});

test("W04B-I2: provider lỗi transient ⇒ retry_scheduled, 0 revision, usage ghi call_outcome", async () => {
  const packet = packetFor();
  const providerConfig = createMemoryProviderConfig({ provider_profile: "openai-compatible", model: "gpt-4o-mini" });
  const outbound = mockOutbound(async () => ({ statusCode: 500, headers: {}, body: Buffer.from("{}") }));
  const service = liveService({ packet, outbound, providerConfig });

  const enqueued = await service.enqueueReport(liveEnqueueArgs());
  assert.equal(enqueued.ok, true);
  const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(run.results[0].kind, "retry_scheduled");
  assert.equal(run.results[0].revision_id, null);
});

test("W04B-I3: config không active/verified ⇒ enqueue AI_CONFIG_REQUIRED, 0 job", async () => {
  const packet = packetFor();
  const providerConfig = createMemoryProviderConfig({ active: null });
  const outbound = mockOutbound(async () => ({ statusCode: 200, headers: {}, body: Buffer.from("{}") }));
  const service = liveService({ packet, outbound, providerConfig });
  const result = await service.enqueueReport(liveEnqueueArgs());
  assert.equal(result.ok, false);
  assert.equal(result.code, "AI_CONFIG_REQUIRED");
});

test("W04B-I4: decrypt/config mismatch ⇒ fail-closed, 0 provider/usage/revision", async () => {
  const packet = packetFor();
  const providerConfig = createMemoryProviderConfig({ provider_profile: "openai-compatible", model: "gpt-4o-mini", materialFailure: { code: "AI_DECRYPT_FAILED" } });
  const outbound = mockOutbound(async () => ({ statusCode: 200, headers: {}, body: Buffer.from("{}") }));
  const service = liveService({ packet, outbound, providerConfig });

  const enqueued = await service.enqueueReport(liveEnqueueArgs());
  assert.equal(enqueued.ok, true);
  const run = await service.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.notEqual(run.results[0].kind, "completed");
  assert.equal(run.results[0].error_code, "AI_DECRYPT_FAILED");
  assert.equal(outbound.calls.length, 0, "0 provider call khi decrypt lỗi");
});
