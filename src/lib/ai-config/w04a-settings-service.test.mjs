/**
 * P1.5-W04A — Settings service: vòng đời cấu hình provider (save · test · rotate · activate · disable),
 * AAD binding, NFC model, audit và bất biến "job cũ không đổi config".
 *
 * Port + mở rộng từ spike `spike/p1.5-w04a-security` (commit 0043920). KHÔNG gọi mạng/provider thật.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  containsSecret,
  projectConfig,
} from "./config-contract.ts";
import {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
  keyringFromEnvironment,
  normalizeModel,
} from "./crypto-envelope.ts";
import {
  activateProviderConfig,
  disableProviderConfig,
  PILOT_CONFIG_ID,
  readSettingsStatus,
  rotateProviderKey,
  saveProviderConfig,
  testProviderConnection,
  validateSaveInput,
} from "./settings-service.ts";
import { isKnownProviderProfile, PROVIDER_PROFILES, joinProviderPath } from "./provider-profiles.ts";

const SECRET = "sk-test-synthetic-0001";
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

/** Store kép: mirror semantics RPC (OCC + audit cùng mutation + một active). */
function createMemoryConfigStore() {
  const versions = new Map();
  const audit = [];
  const state = { current: null };

  function projectionOf(config) {
    return projectConfig(config);
  }

  return {
    versions,
    audit,
    get current() {
      return state.current;
    },
    async readCurrent() {
      return state.current;
    },
    async readVersion(_configId, version) {
      return versions.get(version) ?? null;
    },
    async readActiveProjection() {
      const active = [...versions.values()].find((row) => row.status === "active");
      return active ? projectionOf(active) : null;
    },
    async saveVersion({ expected_version, config, actor, action }) {
      const maxVersion = versions.size === 0 ? null : Math.max(...versions.keys());
      if (maxVersion !== expected_version) {
        audit.push({ event_type: "config_mutation_rejected", outcome: "failure", reason_code: "version_conflict", actor_ref: actor, version: maxVersion ?? 0 });
        return { ok: false, code: "VERSION_CONFLICT", message: "cấu hình đã thay đổi" };
      }
      versions.set(config.version, config);
      state.current = config;
      audit.push({
        event_type: action,
        outcome: "success",
        reason_code: "ok",
        actor_ref: actor,
        version: config.version,
        provider_profile: config.provider_profile,
        sanitized_host: config.sanitized_host,
        model: config.model,
        key_fingerprint: config.key_fingerprint,
      });
      return { ok: true, config };
    },
    async recordTest({ config_id, version, success, actor, reason_code }) {
      const target = versions.get(version);
      if (!target) return { ok: false, code: "NOT_FOUND", message: "không tìm thấy version" };
      const next = {
        ...target,
        status: target.status === "active" ? "active" : success ? "verified" : "test_failed",
        verified_at: target.status === "active" ? target.verified_at : success ? "2026-10-02T00:00:00.000Z" : null,
        updated_at: "2026-10-02T00:00:00.000Z",
      };
      versions.set(version, next);
      state.current = next;
      audit.push({ event_type: "connection_tested", outcome: success ? "success" : "failure", reason_code, actor_ref: actor, version, config_id });
      return { ok: true, config: next };
    },
    async activate({ config_id, version, actor }) {
      const target = versions.get(version);
      if (!target) return { ok: false, code: "NOT_FOUND", message: "không tìm thấy version" };
      if (target.status !== "verified" || !target.verified_at) {
        audit.push({ event_type: "config_mutation_rejected", outcome: "failure", reason_code: "not_verified", actor_ref: actor, version });
        return { ok: false, code: "NOT_VERIFIED", message: "chưa verified" };
      }
      for (const [otherVersion, other] of versions) {
        if (other.status === "active" && otherVersion !== version) {
          versions.set(otherVersion, { ...other, status: "disabled" });
          audit.push({ event_type: "config_disabled", outcome: "success", reason_code: "superseded", actor_ref: actor, version: otherVersion, config_id });
        }
      }
      const next = { ...target, status: "active" };
      versions.set(version, next);
      state.current = next;
      audit.push({ event_type: "config_activated", outcome: "success", reason_code: "ok", actor_ref: actor, version, config_id });
      return { ok: true, config: next };
    },
    async disable({ config_id, version, actor }) {
      const target = versions.get(version);
      if (!target) return { ok: false, code: "NOT_FOUND", message: "không tìm thấy version" };
      const next = { ...target, status: "disabled" };
      versions.set(version, next);
      state.current = next;
      audit.push({ event_type: "config_disabled", outcome: "success", reason_code: "owner_disabled", actor_ref: actor, version, config_id });
      return { ok: true, config: next };
    },
    async recordRejected({ config_id, version, actor, reason_code }) {
      audit.push({ event_type: "config_mutation_rejected", outcome: "failure", reason_code, actor_ref: actor, version, config_id });
    },
  };
}

const okTransport = (counter = { calls: 0 }) => ({
  resolve: async () => ["93.184.216.34"],
  request: async () => {
    counter.calls += 1;
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{\"ok\":true}") };
  },
});

async function saved(store, body = BODY) {
  return saveProviderConfig({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body });
}

test("W04A-S1: save tạo version 1 (draft) + audit; projection KHÔNG có secret/envelope", async () => {
  const store = createMemoryConfigStore();
  const result = await saved(store);
  assert.equal(result.ok, true);
  assert.equal(result.config.version, 1);
  assert.equal(result.config.status, "draft");
  assert.equal(result.config.sanitized_host, "api.example.com");
  assert.equal(result.config.key_fingerprint, fingerprintSecret(SECRET, KEYRING));

  const serialized = JSON.stringify(result.config);
  for (const forbidden of [SECRET, "ciphertext", "authentication_tag", "encrypted_secret", "api_base_url", "envelope"]) {
    assert.equal(serialized.includes(forbidden), false, "projection không được chứa " + forbidden);
  }
  assert.equal(store.audit.length, 1);
  assert.equal(store.audit[0].event_type, "config_created");
  assert.equal(store.audit[0].outcome, "success");
  assert.equal(containsSecret(store.audit, SECRET), false, "audit không được chứa secret");
  assert.equal(containsSecret(JSON.stringify(store.audit.map((row) => Object.keys(row))), SECRET), false);
});

test("W04A-S2: optimistic version — save sai version ⇒ VERSION_CONFLICT + audit rejected, KHÔNG tạo version", async () => {
  const store = createMemoryConfigStore();
  await saved(store);
  const stale = await saved(store, { ...BODY, expected_version: 5 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "VERSION_CONFLICT");
  assert.equal(store.versions.size, 1, "không tạo version mới khi conflict");
  assert.equal(store.audit.at(-1).event_type, "config_mutation_rejected");
  assert.equal(store.audit.at(-1).reason_code, "version_conflict");

  const fresh = await saved(store, { ...BODY, expected_version: 1, model: "gpt-test-model-2" });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.config.version, 2);
  assert.equal(store.audit.at(-1).event_type, "config_created");
});

test("W04A-S3: test thất bại ⇒ test_failed (không tự active); activate ⇒ AI_CONFIG_NOT_VERIFIED", async () => {
  const store = createMemoryConfigStore();
  await saved(store);
  const failed = await testProviderConnection({
    store,
    keyring: KEYRING,
    url_policy: POLICY,
    actor: "pilot-admin",
    body: {},
    outbound: { resolve: async () => ["93.184.216.34"], request: async () => ({ statusCode: 500, headers: {}, body: Buffer.from("boom") }) },
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.verified, false);
  assert.equal(failed.config.status, "test_failed");
  assert.equal(store.audit.at(-1).event_type, "connection_tested");
  assert.equal(store.audit.at(-1).outcome, "failure");

  const activated = await activateProviderConfig({ store, actor: "pilot-admin", body: { version: 1 } });
  assert.equal(activated.ok, false);
  assert.equal(activated.code, "NOT_VERIFIED");
});

test("W04A-S4: test thành công ⇒ verified; activate ⇒ active và version active cũ bị disable (audit)", async () => {
  const store = createMemoryConfigStore();
  await saved(store);
  const counter = { calls: 0 };
  const tested = await testProviderConnection({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: {}, outbound: okTransport(counter) });
  assert.equal(tested.verified, true);
  assert.equal(counter.calls, 1, "test connection gọi đúng một lần transport");
  assert.equal(tested.config.status, "verified");
  assert.equal(tested.config.verified_at !== null, true);

  const activated = await activateProviderConfig({ store, actor: "pilot-admin", body: { version: 1 } });
  assert.equal(activated.ok, true);
  assert.equal(activated.config.status, "active");

  // version 2 verified ⇒ activate ⇒ version 1 bị disable (không xoá), audit đủ hai event.
  await saved(store, { ...BODY, expected_version: 1, model: "gpt-test-model-2" });
  await testProviderConnection({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: { version: 2 }, outbound: okTransport() });
  const second = await activateProviderConfig({ store, actor: "pilot-admin", body: { version: 2 } });
  assert.equal(second.ok, true);
  assert.equal(store.versions.get(1).status, "disabled");
  const types = store.audit.map((row) => row.event_type);
  assert.equal(types.includes("config_activated"), true);
  assert.equal(types.includes("config_disabled"), true);
});

test("W04A-S5: rotate tạo version/nonce/AAD mới, KHÔNG giải mã key cũ; ciphertext khác nhau", async () => {
  const store = createMemoryConfigStore();
  await saved(store);
  const v1 = store.versions.get(1);
  const rotated = await rotateProviderKey({
    store,
    keyring: KEYRING,
    actor: "pilot-admin",
    body: { api_key: "sk-test-synthetic-0002", expected_version: 1 },
  });
  assert.equal(rotated.ok, true);
  assert.equal(rotated.config.version, 2);
  assert.equal(rotated.config.status, "draft", "version xoay bắt đầu ở draft (chưa active)");
  const v2 = store.versions.get(2);
  assert.notEqual(v2.encrypted_secret.ciphertext, v1.encrypted_secret.ciphertext);
  assert.notEqual(v2.encrypted_secret.iv, v1.encrypted_secret.iv);
  assert.notEqual(v2.key_fingerprint, v1.key_fingerprint);
  assert.equal(store.audit.at(-1).event_type, "credential_rotated");
  // Envelope v1 vẫn giải mã được bằng key CŨ của nó (job cũ giữ nguyên config).
  assert.equal(
    decryptSecret(v1.encrypted_secret, {
      config_id: v1.config_id,
      provider_profile: v1.provider_profile,
      config_version: 1,
      api_base_url: v1.api_base_url,
      model: v1.model,
    }, KEYRING),
    SECRET
  );
  assert.equal(store.versions.get(1).status, v1.status, "version cũ không bị đổi bởi rotate");
});

test("W04A-S6: AAD tamper từng binding đều decrypt fail", () => {
  const context = {
    config_id: "pilot-provider",
    provider_profile: "openai-compatible",
    config_version: 1,
    api_base_url: "https://api.example.com/v1",
    model: "gpt-test-model",
  };
  const envelope = encryptSecret(SECRET, context, KEYRING);
  const tamper = [
    ["config_id", { ...context, config_id: "pilot-provider-x" }],
    ["provider_profile", { ...context, provider_profile: "other-profile" }],
    ["config_version", { ...context, config_version: 2 }],
    ["api_base_url", { ...context, api_base_url: "https://api.example.com/v2" }],
    ["model", { ...context, model: "gpt-test-model-x" }],
  ];
  for (const [label, wrong] of tamper) {
    assert.throws(
      () => decryptSecret(envelope, wrong, KEYRING),
      (error) => error.code === "DECRYPT_FAILED",
      "tamper " + label + " phải fail"
    );
  }
  // Tamper ciphertext/tag cũng fail (không có plaintext fallback).
  assert.throws(() => decryptSecret({ ...envelope, ciphertext: Buffer.from("x").toString("base64") }, context, KEYRING), (error) => error.code === "DECRYPT_FAILED" || error.code === "ENVELOPE_INVALID");
  assert.equal(decryptSecret(envelope, context, KEYRING), SECRET);
});

test("W04A-S7: model chuẩn hoá NFC — bind AAD theo giá trị đã chuẩn hoá", async () => {
  const decomposed = "gpt-test-mode\u0301l";
  assert.equal(normalizeModel(decomposed), decomposed.normalize("NFC"));
  const store = createMemoryConfigStore();
  const result = await saved(store, { ...BODY, model: "  gpt-test-model  " });
  assert.equal(result.ok, true);
  assert.equal(result.config.model, "gpt-test-model");
  const envelope = store.versions.get(1).encrypted_secret;
  assert.equal(envelope.model, "gpt-test-model");
  // AAD bind model: truyền model chưa chuẩn hoá ⇒ fail.
  assert.throws(
    () => decryptSecret(envelope, { config_id: envelope.config_id, provider_profile: envelope.provider_profile, config_version: 1, api_base_url: envelope.api_base_url, model: " gpt-test-model " }, KEYRING),
    (error) => error.code === "DECRYPT_FAILED"
  );
});

test("W04A-S8: validate input đóng — không nhận header/secret rỗng/profile lạ/URL trong model", () => {
  assert.equal(validateSaveInput(BODY).ok, true);
  const bad = [
    { ...BODY, api_key: "" },
    { ...BODY, api_key: "a".repeat(20_000) },
    { ...BODY, provider_profile: "profile-tu-do" },
    { ...BODY, model: "x".repeat(300) },
    { ...BODY, api_url: "" },
    { ...BODY, expected_version: 0 },
    { ...BODY, expected_version: -3 },
    ["not-an-object"],
    { ...BODY, model: "gpt\u0000evil" },
  ];
  for (const value of bad) {
    const parsed = validateSaveInput(value);
    assert.equal(parsed.ok, false, "phải từ chối: " + JSON.stringify(value).slice(0, 80));
  }
  assert.equal(isKnownProviderProfile("openai-compatible"), true);
  assert.equal(isKnownProviderProfile("khac"), false);
  assert.equal(PROVIDER_PROFILES.length >= 1, true);
  // Base URL có path sẵn (/v1) phải giữ nguyên khi nối endpoint.
  assert.equal(joinProviderPath("https://api.example.com/v1", "chat/completions"), "https://api.example.com/v1/chat/completions");
});

test("W04A-S9: SSRF qua save — host ngoài allowlist, metadata, private, credential-in-URL đều bị từ chối", async () => {
  const cases = [
    ["host ngoài allowlist", "https://evil.example.net/v1"],
    ["metadata", "https://169.254.169.254/v1"],
    ["private", "https://10.0.0.5/v1"],
    ["credential trong URL", "https://user:pass@api.example.com/v1"],
    ["query", "https://api.example.com/v1?key=abc"],
    ["http (non-TLS)", "http://api.example.com/v1"],
  ];
  for (const [label, url] of cases) {
    const store = createMemoryConfigStore();
    const result = await saved(store, { ...BODY, api_url: url });
    assert.equal(result.ok, false, label + " phải bị từ chối");
    assert.equal(store.versions.size, 0, label + ": không được lưu cấu hình");
  }
});

test("W04A-S10: test connection đi qua outbound guard — redirect cross-origin và request quá trần đều chặn", async () => {
  const store = createMemoryConfigStore();
  await saved(store);

  // Redirect khác origin ⇒ REDIRECT_REJECTED, KHÔNG gọi transport lần hai.
  let transportCalls = 0;
  const redirected = await testProviderConnection({
    store,
    keyring: KEYRING,
    url_policy: POLICY,
    actor: "pilot-admin",
    body: {},
    outbound: {
      resolve: async () => ["93.184.216.34"],
      request: async () => {
        transportCalls += 1;
        return { statusCode: 302, headers: { location: "https://evil.example.net/v1/chat/completions" }, body: Buffer.alloc(0) };
      },
    },
  });
  assert.equal(redirected.ok, true);
  assert.equal(redirected.verified, false);
  assert.equal(redirected.reason_code, "redirect_rejected");
  assert.equal(transportCalls, 1, "redirect cross-origin KHÔNG được gọi transport lần hai");
  assert.equal(store.versions.get(1).status, "test_failed");

  // Response vượt trần ⇒ không verified.
  const oversized = await testProviderConnection({
    store,
    keyring: KEYRING,
    url_policy: POLICY,
    actor: "pilot-admin",
    body: {},
    outbound: {
      resolve: async () => ["93.184.216.34"],
      request: async () => ({ statusCode: 200, headers: {}, body: Buffer.alloc(200 * 1024, 1) }),
    },
  });
  assert.equal(oversized.verified, false);
  assert.equal(oversized.reason_code, "response_too_large");
});

test("W04A-S11: chưa có cấu hình ⇒ status null; rotate/activate/disable/test đều báo không tìm thấy", async () => {
  const store = createMemoryConfigStore();
  const status = await readSettingsStatus({ store, config_id: PILOT_CONFIG_ID });
  assert.equal(status.ok, true);
  assert.equal(status.config, null);
  assert.equal(status.active, null);

  for (const call of [
    () => rotateProviderKey({ store, keyring: KEYRING, actor: "pilot-admin", body: { api_key: SECRET } }),
    () => activateProviderConfig({ store, actor: "pilot-admin", body: { version: 1 } }),
    () => disableProviderConfig({ store, actor: "pilot-admin", body: { version: 1 } }),
    () => testProviderConnection({ store, keyring: KEYRING, url_policy: POLICY, actor: "pilot-admin", body: {} }),
  ]) {
    const result = await call();
    assert.equal(result.ok, false);
    assert.equal(result.code, "NOT_FOUND");
  }
});
