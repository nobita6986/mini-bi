/**
 * P1.5-W04A-R2 — Regression cho ba finding G4A (strict read projection · audit truthfulness) bằng
 * test TÍCH HỢP thật: gọi store-core (với RPC giả), settings-service và gateway/service thật.
 *
 * A. Envelope success chỉ hợp lệ khi `ok === true` tường minh · không consumer nào fallback.
 * B. `config` phải tường minh: null = chưa cấu hình; thiếu/undefined/malformed/row thiếu field ⇒ AI_INTERNAL.
 * C. Audit rejection phải trả đúng kết quả RPC: audit lỗi ⇒ AI_INTERNAL, KHÔNG conflict/success giả.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { buildPacketFromSource } from "../ai/packet-builder.mjs";
import { createAiReportService } from "../ai/gateway/service-core.mjs";
import { createMemoryQueue } from "../ai/gateway/testing/memory-queue.mjs";
import { DEFAULT_POLICY } from "../ai/gateway/limits.mjs";
import { getPromptManifest, PROMPT_MANIFEST_V1 } from "../ai/gateway/prompt-registry.mjs";
import { createScriptedAdapter } from "../ai/gateway/provider.mjs";
import { createConfigCommand } from "./config-contract.ts";
import { keyringFromEnvironment } from "./crypto-envelope.ts";
import {
  activateProviderConfig,
  disableProviderConfig,
  readSettingsStatus,
  rotateProviderKey,
  saveProviderConfig,
  testProviderConnection,
} from "./settings-service.ts";
import { createProviderConfigStoreCore } from "./store-core.ts";
import { createMemoryConfigStore } from "./testing/memory-config-store.mjs";

const SECRET = "sk-r2-synthetic-0001";
const KEYRING = keyringFromEnvironment({
  AI_CONFIG_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  AI_CONFIG_ACTIVE_KEY_ID: "k1",
});
const POLICY = { environment: "production", nodeEnv: "production", allowedHosts: ["api.example.com"], allowedPorts: [443] };
const BODY = {
  provider_profile: "openai-compatible",
  api_url: "https://api.example.com/v1",
  model: "gpt-test-model",
  api_key: SECRET,
  expected_version: null,
};
const CONFIG_ID = "pilot-provider";

function validConfig(version = 1) {
  return createConfigCommand({
    config_id: CONFIG_ID,
    provider_profile: "openai-compatible",
    api_base_url: "https://api.example.com/v1",
    model: "gpt-test-model",
    secret: SECRET,
    keyring: KEYRING,
    url_policy: POLICY,
    version,
  });
}

/** Row jsonb như Postgres trả (envelope nằm ở cột `envelope`). */
function validRow(overrides = {}) {
  const config = validConfig();
  const row = {
    config_id: config.config_id,
    version: config.version,
    pilot_scope: "pilot",
    provider_profile: config.provider_profile,
    api_base_url: config.api_base_url,
    sanitized_host: config.sanitized_host,
    model: config.model,
    envelope: config.encrypted_secret,
    key_fingerprint: config.key_fingerprint,
    status: "verified",
    verified_at: "2026-10-02T00:00:00.000Z",
    last_tested_at: "2026-10-02T00:00:00.000Z",
    optimistic_version: 2,
    created_at: "2026-10-02T00:00:00.000Z",
    updated_at: "2026-10-02T00:00:00.000Z",
  };
  return { ...row, ...overrides };
}

function storeWith(handler) {
  const calls = [];
  const rpc = async (name, params) => {
    calls.push({ name, params });
    return handler(name, params);
  };
  const store = createProviderConfigStoreCore({ rpc, keyring: () => ({ ok: true, keyring: KEYRING }), config_id: CONFIG_ID });
  return { store, calls };
}

const ALL_CONSUMERS = [
  ["readCurrent", (store) => store.readCurrent(CONFIG_ID)],
  ["readVersion", (store) => store.readVersion(CONFIG_ID, 1)],
  ["readActiveProjection", (store) => store.readActiveProjection()],
  ["saveVersion", (store) => store.saveVersion({ expected_version: null, config: validConfig(), actor: "pilot-admin", action: "config_created" })],
  ["recordTest", (store) => store.recordTest({ config_id: CONFIG_ID, version: 1, success: true, actor: "pilot-admin", reason_code: "provider_ok" })],
  ["activate", (store) => store.activate({ config_id: CONFIG_ID, version: 1, actor: "pilot-admin" })],
  ["disable", (store) => store.disable({ config_id: CONFIG_ID, version: 1, actor: "pilot-admin" })],
  ["recordRejected", (store) => store.recordRejected({ config_id: CONFIG_ID, version: 1, actor: "pilot-admin", reason_code: "version_conflict" })],
  ["material", (store) => store.material(CONFIG_ID, 1)],
];

// ---------------------------------------------------------------------------
// A. Strict RPC success envelope
// ---------------------------------------------------------------------------

test("W04A-R2-A1: envelope success chỉ hợp lệ khi ok === true; ok sai kiểu/thiếu ⇒ AI_INTERNAL", async () => {
  const internal = [
    ["data = {}", { data: {} }],
    ["ok = 'true'", { data: { ok: "true", config: null } }],
    ["ok = 1", { data: { ok: 1, config: null } }],
    ["ok = null", { data: { ok: null, config: null } }],
    ["data = array", { data: [] }],
    ["data = 'x'", { data: "x" }],
    ["response = {}", {}],
    ["response = undefined", undefined],
    ["ok=false thiếu code", { data: { ok: false } }],
    ["ok=false code rỗng", { data: { ok: false, code: "" } }],
    ["ok=false code khoảng trắng", { data: { ok: false, code: "   " } }],
  ];
  for (const [label, response] of internal) {
    const { store } = storeWith(() => response);
    const result = await store.readCurrent(CONFIG_ID);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "AI_INTERNAL", label);
  }

  // ok=true với config:null tường minh là success hợp lệ.
  const { store: okStore } = storeWith(() => ({ data: { ok: true, config: null } }));
  assert.deepEqual(await okStore.readCurrent(CONFIG_ID), { ok: true, config: null });

  // Refusal hợp lệ giữ nguyên code DB.
  const { store: refusalStore } = storeWith(() => ({ data: { ok: false, code: "AI_VERSION_CONFLICT", message: "cấu hình đã thay đổi" } }));
  const refusal = await refusalStore.saveVersion({ expected_version: 1, config: validConfig(2), actor: "pilot-admin", action: "config_created" });
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "AI_VERSION_CONFLICT");
});

test("W04A-R2-A2: KHÔNG consumer nào fallback khi envelope malformed (9 consumer × 10 payload)", async () => {
  const malformed = [
    { data: {} },
    { data: { ok: "true", config: null } },
    { data: { ok: 1, config: null } },
    { data: { ok: null } },
    { data: [] },
    {},
    { data: undefined },
    { data: { ok: false } },
    { data: { ok: false, code: "" } },
    { error: { message: "relation \"ai_provider_configs\" does not exist" } },
  ];
  for (const response of malformed) {
    const label = JSON.stringify(response);
    for (const [name, call] of ALL_CONSUMERS) {
      const { store } = storeWith(() => response);
      const result = await call(store);
      assert.equal(result.ok, false, name + " phải fail-closed với " + label);
      assert.equal(result.code, "AI_INTERNAL", name + " với " + label);
      if (result.message) {
        assert.equal(result.message.includes("does not exist"), false, name + " không được lộ raw error");
        assert.equal(result.message.includes("relation"), false, name + " không được lộ raw error");
      }
    }
  }
});

test("W04A-R2-A3: malformed envelope KHÔNG gây mutation (mọi RPC ghi đều bị chặn trước khi trả success)", async () => {
  const mutated = [];
  const { store } = storeWith((name, params) => {
    mutated.push({ name, params });
    return { data: {} };
  });

  const results = await Promise.all([
    store.saveVersion({ expected_version: null, config: validConfig(), actor: "pilot-admin", action: "config_created" }),
    store.recordTest({ config_id: CONFIG_ID, version: 1, success: true, actor: "pilot-admin", reason_code: "provider_ok" }),
    store.activate({ config_id: CONFIG_ID, version: 1, actor: "pilot-admin" }),
    store.disable({ config_id: CONFIG_ID, version: 1, actor: "pilot-admin" }),
    store.recordRejected({ config_id: CONFIG_ID, version: 1, actor: "pilot-admin", reason_code: "version_conflict" }),
  ]);
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.equal(result.code, "AI_INTERNAL");
  }
  assert.equal(mutated.length, 5, "RPC vẫn được gọi (không nuốt lỗi) nhưng KHÔNG trả success");
});

// ---------------------------------------------------------------------------
// B. explicit null vs missing config
// ---------------------------------------------------------------------------

test("W04A-R2-B1: `config:null` TƯỜNG MINH là not-configured hợp lệ; thiếu/undefined/sai kiểu ⇒ AI_INTERNAL", async () => {
  const explicit = storeWith(() => ({ data: { ok: true, config: null } }));
  assert.deepEqual(await explicit.store.readCurrent(CONFIG_ID), { ok: true, config: null });
  assert.deepEqual(await explicit.store.readVersion(CONFIG_ID, 1), { ok: true, config: null });

  const malformed = [
    ["thiếu property config", { data: { ok: true } }],
    ["config undefined", { data: { ok: true, config: undefined } }],
    ["config array", { data: { ok: true, config: [] } }],
    ["config string", { data: { ok: true, config: "row" } }],
    ["config number", { data: { ok: true, config: 1 } }],
    ["config object rỗng", { data: { ok: true, config: {} } }],
  ];
  for (const [label, response] of malformed) {
    const { store } = storeWith(() => response);
    const current = await store.readCurrent(CONFIG_ID);
    assert.equal(current.ok, false, label);
    assert.equal(current.code, "AI_INTERNAL", label);
    assert.notEqual(current.config, null, label);
    const version = await store.readVersion(CONFIG_ID, 1);
    assert.equal(version.ok, false, label + " (readVersion)");
  }
});

test("W04A-R2-B2: row non-null phải validate đủ nhóm field; thiếu bất kỳ nhóm nào ⇒ AI_INTERNAL", async () => {
  const ok = storeWith(() => ({ data: { ok: true, config: validRow() } }));
  const okResult = await ok.store.readCurrent(CONFIG_ID);
  assert.equal(okResult.ok, true);
  assert.equal(okResult.config.version, 1);
  assert.equal(okResult.config.model, "gpt-test-model");

  const drops = [
    "config_id",
    "provider_profile",
    "model",
    "version",
    "status",
    "optimistic_version",
    "api_base_url",
    "sanitized_host",
    "updated_at",
    "key_fingerprint",
    "envelope",
  ];
  for (const field of drops) {
    const row = validRow();
    delete row[field];
    const { store } = storeWith(() => ({ data: { ok: true, config: row } }));
    const result = await store.readCurrent(CONFIG_ID);
    assert.equal(result.ok, false, "thiếu " + field);
    assert.equal(result.code, "AI_INTERNAL", "thiếu " + field);
  }

  const tampered = [
    ["status lạ", { status: "activated" }],
    ["version 0", { version: 0, optimistic_version: 0 }],
    ["optimistic_version nhỏ hơn version", { version: 3, optimistic_version: 1 }],
    ["fingerprint sai định dạng", { key_fingerprint: "XYZ" }],
    ["updated_at không phải timestamp", { updated_at: "hôm qua" }],
    ["sanitized_host chứa đường dẫn", { sanitized_host: "api.example.com/v1" }],
    ["model có ký tự điều khiển", { model: "gpt\u0000x" }],
    ["api_base_url là http", { api_base_url: "http://api.example.com/v1" }],
  ];
  for (const [label, patch] of tampered) {
    const { store } = storeWith(() => ({ data: { ok: true, config: validRow(patch) } }));
    const result = await store.readCurrent(CONFIG_ID);
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "AI_INTERNAL", label);
  }

  // Envelope/AAD binding: sửa binding trong envelope ⇒ row không hợp lệ.
  const envelopeTamper = validRow();
  envelopeTamper.envelope = { ...envelopeTamper.envelope, model: "model-khac" };
  const { store: tamperStore } = storeWith(() => ({ data: { ok: true, config: envelopeTamper } }));
  const tamperResult = await tamperStore.readCurrent(CONFIG_ID);
  assert.equal(tamperResult.ok, false);
  assert.equal(tamperResult.code, "AI_INTERNAL");

  const missingEnvelopeKey = validRow();
  const { ciphertext, ...withoutCiphertext } = missingEnvelopeKey.envelope;
  missingEnvelopeKey.envelope = withoutCiphertext;
  const { store: missingStore } = storeWith(() => ({ data: { ok: true, config: missingEnvelopeKey } }));
  assert.equal((await missingStore.readCurrent(CONFIG_ID)).code, "AI_INTERNAL");
  assert.ok(ciphertext);
});

test("W04A-R2-B3: row malformed ⇒ service trả AI_INTERNAL (không config:null), không mutation, không provider call", async () => {
  const { store } = storeWith(() => ({ data: { ok: true, config: {} } }));

  const status = await readSettingsStatus({ store, config_id: CONFIG_ID });
  assert.equal(status.ok, false);
  assert.equal(status.code, "AI_INTERNAL");
  assert.notEqual(status.config, null);

  const calls = [
    ["save", () => saveProviderConfig({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: BODY })],
    ["rotate", () => rotateProviderKey({ store, keyring: KEYRING, actor: "pilot-admin", body: { api_key: SECRET, expected_version: 1 } })],
    ["test", () => testProviderConnection({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: {} })],
    ["activate", () => activateProviderConfig({ store, actor: "pilot-admin", body: { version: 1 } })],
    ["disable", () => disableProviderConfig({ store, actor: "pilot-admin", body: { version: 1 } })],
  ];
  for (const [label, call] of calls) {
    const result = await call();
    assert.equal(result.ok, false, label);
    assert.equal(result.code, "AI_INTERNAL", label);
  }
});

test("W04A-R2-B4: tích hợp thật — store-core + gateway: malformed ⇒ 0 job, 0 provider call, 0 usage, 0 revision", async () => {
  const packet = corePacket();
  const prompt = getPromptManifest(PROMPT_MANIFEST_V1.prompt_version);
  const counter = { calls: 0 };

  // Port gateway dựng TRÊN store-core thật (không phải double tự chế).
  const portFor = (handler) => {
    const { store } = storeWith(handler);
    return {
      async active() {
        const result = await store.readActiveProjection();
        if (!result.ok) return { ok: false, code: result.code, message: result.message };
        if (!result.config) return { ok: false, code: "AI_CONFIG_REQUIRED", message: "chưa có cấu hình active" };
        return { ok: true, config: result.config };
      },
      material: (configId, version) => store.material(configId, version),
    };
  };

  const makeService = (queue, port) =>
    createAiReportService({
      queue,
      audit: { events: [], async append() { return { ok: true }; } },
      providerConfig: port,
      packetLoader: async () => ({ ok: true, packet }),
      identityCatalog: { available: false, catalog: null },
      manifest: prompt,
      policy: { config: DEFAULT_POLICY },
      provider: { provider_key: "scripted", model_key: "scripted-deterministic-v1", config: { scenario: "valid" } },
      providerGate: { ok: true },
      adapterFactory: () => ({ ok: true, adapter: countingAdapter(counter) }),
      timeout: { create: () => ({ signal: undefined, cancel: () => {} }) },
      clock: { nowMs: () => 0 },
    });

  const enqueueArgs = () => ({
    input: { period: { type: "week", as_of_date: "2026-10-11" }, scope: { dimensions: ["project", "provider", "employment"] } },
    actor_ref: "pilot-admin",
    access_scope_hash: "h",
    provider_key: "scripted",
    model_key: "scripted-deterministic-v1",
    adapter_version: "scripted-adapter/1.0",
    now_ms: 0,
  });

  // (1) active projection malformed (thiếu field) ⇒ enqueue AI_INTERNAL, KHÔNG tạo job.
  const malformedQueue = createMemoryQueue();
  const malformedService = makeService(malformedQueue, portFor(() => ({ data: { ok: true, config: null, config_id: "", version: 0 } })));
  const blocked = await malformedService.enqueueReport(enqueueArgs());
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "AI_INTERNAL");
  assert.equal(malformedQueue.store.jobs.size, 0, "0 job khi provider config malformed");

  // (2) enqueue OK với active hợp lệ, nhưng row material malformed ⇒ worker fail-closed 0/0/0.
  const workerQueue = createMemoryQueue();
  const activeRow = validRow();
  const workerService = makeService(
    workerQueue,
    portFor((name) => {
      if (name === "ai_provider_config_active") {
        return {
          data: {
            ok: true,
            config_id: activeRow.config_id,
            version: 1,
            provider_profile: activeRow.provider_profile,
            model: activeRow.model,
            sanitized_host: activeRow.sanitized_host,
            verified_at: activeRow.verified_at,
          },
        };
      }
      if (name === "ai_provider_config_version") return { data: { ok: true, config: { ...activeRow, envelope: {} } } };
      return { data: { ok: true, config: activeRow } };
    })
  );
  const enqueued = await workerService.enqueueReport(enqueueArgs());
  assert.equal(enqueued.ok, true);
  const run = await workerService.runWorker({ worker_ref: "w", limit: 1, now_ms: 0 });
  assert.equal(run.ok, true);
  assert.notEqual(run.results[0].kind, "completed");
  assert.equal(counter.calls, 0, "0 provider call");
  assert.equal(workerQueue.store.usage.size, 0, "0 usage");
  assert.equal(workerQueue.store.revisions.size, 0, "0 revision");
});

// ---------------------------------------------------------------------------
// C. Audit rejection truthfulness
// ---------------------------------------------------------------------------

test("W04A-R2-C1: stale save + audit THÀNH CÔNG ⇒ VERSION_CONFLICT, đúng một audit, không version mới", async () => {
  const store = createMemoryConfigStore();
  await saveProviderConfig({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: BODY });
  const auditBefore = store.audit.length;

  const stale = await saveProviderConfig({
    store,
    keyring: KEYRING,
    url_policy: POLICY,
    actor: "pilot-admin",
    body: { ...BODY, expected_version: 99 },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "VERSION_CONFLICT");
  assert.equal(store.versions.size, 1, "không tạo version mới");
  const rejections = store.audit.slice(auditBefore).filter((row) => row.event_type === "config_mutation_rejected");
  assert.equal(rejections.length, 1, "đúng MỘT audit từ chối");
  assert.equal(rejections[0].reason_code, "version_conflict");
});

test("W04A-R2-C2: stale rotate + audit THÀNH CÔNG ⇒ VERSION_CONFLICT, đúng một audit, không version mới", async () => {
  const store = createMemoryConfigStore();
  await saveProviderConfig({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: BODY });
  const auditBefore = store.audit.length;

  const stale = await rotateProviderKey({ store, keyring: KEYRING, actor: "pilot-admin", body: { api_key: "sk-stale", expected_version: 7 } });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "VERSION_CONFLICT");
  assert.equal(store.versions.size, 1);
  const rejections = store.audit.slice(auditBefore).filter((row) => row.event_type === "config_mutation_rejected");
  assert.equal(rejections.length, 1);
});

test("W04A-R2-C3: stale save/rotate + audit THẤT BẠI ⇒ AI_INTERNAL (không conflict giả, không mutation)", async () => {
  const store = createMemoryConfigStore({ rejectFailure: { code: "AI_INTERNAL" } });
  await saveProviderConfig({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: BODY });
  const auditBefore = store.audit.length;

  const staleSave = await saveProviderConfig({
    store,
    keyring: KEYRING,
    url_policy: POLICY,
    actor: "pilot-admin",
    body: { ...BODY, expected_version: 99 },
  });
  assert.equal(staleSave.ok, false);
  assert.equal(staleSave.code, "AI_INTERNAL", "audit lỗi ⇒ AI_INTERNAL, KHÔNG được tuyên bố conflict");
  assert.notEqual(staleSave.code, "VERSION_CONFLICT");

  const staleRotate = await rotateProviderKey({ store, keyring: KEYRING, actor: "pilot-admin", body: { api_key: "sk-stale", expected_version: 7 } });
  assert.equal(staleRotate.ok, false);
  assert.equal(staleRotate.code, "AI_INTERNAL");

  assert.equal(store.versions.size, 1, "audit lỗi ⇒ KHÔNG tạo version mới");
  assert.equal(store.audit.length, auditBefore, "audit lỗi ⇒ không ghi được dòng audit nào");
});

test("W04A-R2-C4: retry không tạo audit trùng — mỗi lần thử đúng một audit từ chối", async () => {
  const store = createMemoryConfigStore();
  await saveProviderConfig({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: BODY });
  const auditBefore = store.audit.length;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const stale = await saveProviderConfig({
      store,
      keyring: KEYRING,
      url_policy: POLICY,
      actor: "pilot-admin",
      body: { ...BODY, expected_version: 99 },
    });
    assert.equal(stale.code, "VERSION_CONFLICT", "lần " + attempt);
    const rejections = store.audit.slice(auditBefore).filter((row) => row.event_type === "config_mutation_rejected");
    assert.equal(rejections.length, attempt, "sau " + attempt + " lần thử phải có đúng " + attempt + " audit");
  }
  assert.equal(store.versions.size, 1);
});

test("W04A-R2-C5: store-core — recordRejected trả ĐÚNG kết quả RPC (không nuốt lỗi audit)", async () => {
  const failing = storeWith(() => ({ error: { message: "insert into ai_provider_config_audit_events failed" } }));
  const rejected = await failing.store.recordRejected({ config_id: CONFIG_ID, version: 3, actor: "pilot-admin", reason_code: "version_conflict" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "AI_INTERNAL");

  const refusing = storeWith(() => ({ data: { ok: false, code: "AI_INPUT_INVALID", message: "reason_code không hợp lệ" } }));
  const refusal = await refusing.store.recordRejected({ config_id: CONFIG_ID, version: 3, actor: "pilot-admin", reason_code: "x" });
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, "AI_INPUT_INVALID");

  const malformed = storeWith(() => ({ data: {} }));
  assert.equal((await malformed.store.recordRejected({ config_id: CONFIG_ID, version: 3, actor: "pilot-admin", reason_code: "version_conflict" })).code, "AI_INTERNAL");

  const okStore = storeWith(() => ({ data: { ok: true } }));
  assert.deepEqual(await okStore.store.recordRejected({ config_id: CONFIG_ID, version: 3, actor: "pilot-admin", reason_code: "version_conflict" }), { ok: true });
});

// ---------------------------------------------------------------------------
// Fixtures cho tích hợp gateway
// ---------------------------------------------------------------------------

const IDENT_DIR = new URL("../../../docs/contracts/fixtures/p1.5-identity/", import.meta.url);
const baseCatalog = JSON.parse(readFileSync(new URL("catalog.json", IDENT_DIR), "utf8"));

function corePacket() {
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
