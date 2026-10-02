/**
 * P1.5-W04A-R3 — Đóng hai finding cuối ở tầng đọc:
 *   A. projectActiveConfig FAIL-CLOSED theo từng field (adversarial từng field + tích hợp gateway).
 *   B. Config đọc từ store bị malformed ⇒ AI_INTERNAL (KHÔNG success, KHÔNG AI_CONFIG_REQUIRED).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { buildPacketFromSource } from "../ai/packet-builder.mjs";
import { createAiReportService } from "../ai/gateway/service-core.mjs";
import { createMemoryQueue } from "../ai/gateway/testing/memory-queue.mjs";
import { DEFAULT_POLICY } from "../ai/gateway/limits.mjs";
import { getPromptManifest, PROMPT_MANIFEST_V1 } from "../ai/gateway/prompt-registry.mjs";
import { createConfigCommand } from "./config-contract.ts";
import { keyringFromEnvironment } from "./crypto-envelope.ts";
import { projectActiveConfig } from "./read-result.ts";
import {
  activateProviderConfig,
  disableProviderConfig,
  readSettingsStatus,
  rotateProviderKey,
  saveProviderConfig,
  testProviderConnection,
} from "./settings-service.ts";
import { createProviderConfigStoreCore } from "./store-core.ts";

const SECRET = "sk-r3-synthetic-0001";
const KEYRING = keyringFromEnvironment({
  AI_CONFIG_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  AI_CONFIG_ACTIVE_KEY_ID: "k1",
});
const POLICY = { environment: "production", nodeEnv: "production", allowedHosts: ["api.example.com"], allowedPorts: [443] };

const VALID_ACTIVE = {
  ok: true,
  config_id: "pilot-provider",
  version: 2,
  provider_profile: "openai-compatible",
  model: "gpt-test-model",
  sanitized_host: "api.example.com",
  verified_at: "2026-10-02T00:00:00.000Z",
};

function activeStoreWith(payload) {
  const rpc = async (name) => (name === "ai_provider_config_active" ? { data: payload } : { data: { ok: true, config: null } });
  return createProviderConfigStoreCore({ rpc, keyring: () => ({ ok: true, keyring: KEYRING }), config_id: "pilot-provider" });
}

// ---------------------------------------------------------------------------
// A. Active projection fail-closed theo từng field
// ---------------------------------------------------------------------------

test("W04A-R3-A1: projectActiveConfig chấp nhận payload hợp lệ và host:port hợp lệ", () => {
  const ok = projectActiveConfig({ ...VALID_ACTIVE });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.version, 2);
  assert.equal(ok.config.sanitized_host, "api.example.com");
  assert.equal(ok.config.verified_at, "2026-10-02T00:00:00.000Z");

  const withPort = projectActiveConfig({ ...VALID_ACTIVE, sanitized_host: "api.example.com:8443" });
  assert.equal(withPort.ok, true, "host:port hợp lệ phải được chấp nhận");
});

test("W04A-R3-A2: adversarial TỪNG field — thiếu/sai kiểu/sai định dạng ⇒ AI_INTERNAL, không BAO GIỜ AI_CONFIG_REQUIRED", async () => {
  const cases = [
    ["thiếu config_id", { ...VALID_ACTIVE, config_id: undefined }],
    ["config_id rỗng", { ...VALID_ACTIVE, config_id: "" }],
    ["config_id sai định dạng", { ...VALID_ACTIVE, config_id: "bad id!" }],
    ["thiếu provider_profile", { ...VALID_ACTIVE, provider_profile: undefined }],
    ["provider_profile rỗng", { ...VALID_ACTIVE, provider_profile: "" }],
    ["thiếu model", { ...VALID_ACTIVE, model: undefined }],
    ["model rỗng", { ...VALID_ACTIVE, model: "" }],
    ["model chỉ khoảng trắng", { ...VALID_ACTIVE, model: "   " }],
    ["model có ký tự điều khiển", { ...VALID_ACTIVE, model: "gpt\u0000x" }],
    ["model quá dài", { ...VALID_ACTIVE, model: "m".repeat(257) }],
    ["thiếu version", { ...VALID_ACTIVE, version: undefined }],
    ["version = 0", { ...VALID_ACTIVE, version: 0 }],
    ["version = '2'", { ...VALID_ACTIVE, version: "2" }],
    ["version không nguyên", { ...VALID_ACTIVE, version: 2.5 }],
    ["THIẾU sanitized_host", { ...VALID_ACTIVE, sanitized_host: undefined }],
    ["sanitized_host = ''", { ...VALID_ACTIVE, sanitized_host: "" }],
    ["sanitized_host có path", { ...VALID_ACTIVE, sanitized_host: "api.example.com/v1" }],
    ["sanitized_host có credential", { ...VALID_ACTIVE, sanitized_host: "user:pass@api.example.com" }],
    ["sanitized_host có query", { ...VALID_ACTIVE, sanitized_host: "api.example.com?x=1" }],
    ["sanitized_host có scheme", { ...VALID_ACTIVE, sanitized_host: "https://api.example.com" }],
    ["sanitized_host sai kiểu", { ...VALID_ACTIVE, sanitized_host: 42 }],
    ["THIẾU verified_at", { ...VALID_ACTIVE, verified_at: undefined }],
    ["verified_at = null", { ...VALID_ACTIVE, verified_at: null }],
    ["verified_at sai timestamp", { ...VALID_ACTIVE, verified_at: "hôm qua" }],
    ["verified_at rỗng", { ...VALID_ACTIVE, verified_at: "" }],
  ];

  for (const [label, payload] of cases) {
    const direct = projectActiveConfig(payload);
    assert.equal(direct.ok, false, label);
    assert.equal(direct.code, "AI_INTERNAL", label);
    assert.notEqual(direct.code, "AI_CONFIG_REQUIRED", label + ": malformed KHÔNG được coi là thiếu cấu hình");

    const store = activeStoreWith(payload);
    const viaStore = await store.readActiveProjection();
    assert.equal(viaStore.ok, false, label + " (qua store)");
    assert.equal(viaStore.code, "AI_INTERNAL", label + " (qua store)");
    assert.notEqual(viaStore.code, "AI_CONFIG_REQUIRED", label + " (qua store)");
  }
});

test("W04A-R3-A3: active payload malformed ⇒ enqueue fail-closed: 0 job", async () => {
  const packet = r3Packet();
  const prompt = getPromptManifest(PROMPT_MANIFEST_V1.prompt_version);
  const enqueueArgs = () => ({
    input: { period: { type: "week", as_of_date: "2026-10-11" }, scope: { dimensions: ["project", "provider", "employment"] } },
    actor_ref: "pilot-admin",
    access_scope_hash: "h",
    provider_key: "scripted",
    model_key: "scripted-deterministic-v1",
    adapter_version: "scripted-adapter/1.0",
    now_ms: 0,
  });

  const variants = [
    ["thiếu sanitized_host", { ...VALID_ACTIVE, sanitized_host: undefined }],
    ["sanitized_host có path", { ...VALID_ACTIVE, sanitized_host: "api.example.com/v1" }],
    ["verified_at null", { ...VALID_ACTIVE, verified_at: null }],
    ["verified_at sai timestamp", { ...VALID_ACTIVE, verified_at: "not-a-date" }],
  ];

  for (const [label, payload] of variants) {
    const queue = createMemoryQueue();
    const store = activeStoreWith(payload);
    const service = createAiReportService({
      queue,
      audit: { events: [], async append() { return { ok: true }; } },
      providerConfig: {
        async active() {
          const result = await store.readActiveProjection();
          if (!result.ok) return { ok: false, code: result.code, message: result.message };
          if (!result.config) return { ok: false, code: "AI_CONFIG_REQUIRED", message: "chưa có cấu hình" };
          return { ok: true, config: result.config };
        },
        material: (configId, version) => store.material(configId, version),
      },
      packetLoader: async () => ({ ok: true, packet }),
      identityCatalog: { available: false, catalog: null },
      manifest: prompt,
      policy: { config: DEFAULT_POLICY },
      provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "valid" } },
      providerGate: { ok: true },
      adapterFactory: () => {
        throw new Error("KHÔNG được resolve adapter khi provider config malformed");
      },
      timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
      clock: { nowMs: () => 0 },
    });

    const result = await service.enqueueReport(enqueueArgs());
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "AI_INTERNAL", label);
    assert.notEqual(result.code, "AI_CONFIG_REQUIRED", label);
    assert.equal(queue.store.jobs.size, 0, label + ": 0 job");
    assert.equal(queue.store.usage.size, 0, label + ": 0 usage");
    assert.equal(queue.store.revisions.size, 0, label + ": 0 revision");
  }
});

// ---------------------------------------------------------------------------
// B. Malformed domain config ⇒ AI_INTERNAL
// ---------------------------------------------------------------------------

/** Config hợp lệ về crypto nhưng MALFORMED theo domain (projectConfig/assertValidConfig sẽ throw). */
function malformedConfig(patch = {}) {
  const config = createConfigCommand({
    config_id: "pilot-provider",
    provider_profile: "openai-compatible",
    api_base_url: "https://api.example.com/v1",
    model: "gpt-test-model",
    secret: SECRET,
    keyring: KEYRING,
    url_policy: POLICY,
    version: 1,
  });
  return {
    ...config,
    status: "verified",
    verified_at: "2026-10-02T00:00:00.000Z",
    optimistic_version: 0, // < version ⇒ vi phạm bất biến domain
    sanitized_host: "api.example.com/v1", // có path ⇒ không phải host hợp lệ
    ...patch,
  };
}

function malformedStore(config) {
  return {
    async readCurrent() { return { ok: true, config }; },
    async readVersion() { return { ok: true, config }; },
    async readActiveProjection() {
      return {
        ok: true,
        config: {
          config_id: config.config_id,
          provider_profile: config.provider_profile,
          model: config.model,
          version: config.version,
          status: "active",
          verified_at: config.verified_at,
          sanitized_host: "api.example.com",
        },
      };
    },
    async saveVersion() { return { ok: true, config }; },
    async recordTest() { return { ok: true, config }; },
    async activate() { return { ok: true, config }; },
    async disable() { return { ok: true, config }; },
    async recordRejected() { return { ok: true }; },
    async material() { return { ok: false, code: "AI_CONFIG_REQUIRED", message: "không có material" }; },
  };
}

test("W04A-R3-B1: config malformed từ store ⇒ mọi service trả AI_INTERNAL (không success, không AI_CONFIG_REQUIRED)", async () => {
  const config = malformedConfig();
  const store = malformedStore(config);
  const outbound = {
    resolve: async () => ["93.184.216.34"],
    request: async () => ({ statusCode: 200, headers: {}, body: Buffer.from("{}") }),
  };

  const status = await readSettingsStatus({ store, config_id: "pilot-provider" });
  assert.equal(status.ok, false, "status");
  assert.equal(status.code, "AI_INTERNAL");

  const save = await saveProviderConfig({
    store,
    keyring: KEYRING,
    url_policy: POLICY,
    actor: "pilot-admin",
    body: { provider_profile: "openai-compatible", api_url: "https://api.example.com/v1", model: "gpt-test-model", api_key: SECRET, expected_version: 1 },
  });
  assert.equal(save.ok, false, "save");
  assert.equal(save.code, "AI_INTERNAL");

  const rotate = await rotateProviderKey({ store, keyring: KEYRING, actor: "pilot-admin", body: { api_key: "sk-new", expected_version: 1 } });
  assert.equal(rotate.ok, false, "rotate");
  assert.equal(rotate.code, "AI_INTERNAL");

  const tested = await testProviderConnection({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: {}, outbound });
  assert.equal(tested.ok, false, "test");
  assert.equal(tested.code, "AI_INTERNAL");

  const activated = await activateProviderConfig({ store, actor: "pilot-admin", body: { version: 1 } });
  assert.equal(activated.ok, false, "activate");
  assert.equal(activated.code, "AI_INTERNAL");

  const disabled = await disableProviderConfig({ store, actor: "pilot-admin", body: { version: 1 } });
  assert.equal(disabled.ok, false, "disable");
  assert.equal(disabled.code, "AI_INTERNAL");

  for (const [label, result] of [["status", status], ["save", save], ["rotate", rotate], ["test", tested], ["activate", activated], ["disable", disabled]]) {
    assert.notEqual(result.code, "AI_CONFIG_REQUIRED", label + " không được map thành thiếu cấu hình");
    assert.equal(result.ok, false, label);
  }
});

test("W04A-R3-B2: message lỗi config malformed là CỐ ĐỊNH, không raw error/URL/envelope/secret", async () => {
  const config = malformedConfig();
  const store = malformedStore(config);
  const result = await readSettingsStatus({ store, config_id: "pilot-provider" });
  assert.equal(result.code, "AI_INTERNAL");
  assert.equal(result.message, "cấu hình provider đọc được không hợp lệ");

  const serialized = JSON.stringify(result);
  for (const forbidden of [SECRET, "ciphertext", "authentication_tag", "envelope", "https://api.example.com", "SecurityError", "assertValidConfig"]) {
    assert.equal(serialized.includes(forbidden), false, "response không được chứa " + forbidden);
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IDENT_DIR = new URL("../../../docs/contracts/fixtures/p1.5-identity/", import.meta.url);
const baseCatalog = JSON.parse(readFileSync(new URL("catalog.json", IDENT_DIR), "utf8"));

function r3Packet() {
  const fact = (date, project, recruiter, provider, employment, count) => ({
    business_date: date,
    project_key: project,
    recruiter_key: recruiter,
    provider_type_key: provider,
    employment_type_key: employment,
    recruited_count: count,
    source_key: "src-a",
  });
  const built = buildPacketFromSource({
    request: { period: { type: "week", as_of_date: "2026-10-11" }, scope: { dimensions: ["project", "provider", "employment"] } },
    facts: [
      fact("2026-09-28", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 4),
      fact("2026-10-06", "proj-alpha", "rec-alpha", "hrp", "thời vụ", 5),
      fact("2026-10-07", "proj-beta", "rec-bravo", "vendor", "chính thức", 3),
    ],
    source_health: [{ source_key: "src-a", status: "covered", quality: "ok", has_current_facts: true }],
    catalog: baseCatalog,
    metadata: {
      generated_at: "2026-10-12T00:00:00Z",
      generated_from: "reporting-read-model",
      lineage_ref: "1".repeat(64),
      access_scope_hash: "2".repeat(64),
    },
  });
  assert.ok(built.ok, "W03 packet: " + (built.ok ? "" : built.code));
  return built.packet;
}
